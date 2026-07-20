// console2/actions.js — write actions for Console 2.0. Project-scoped writes
// reuse the shared store actions (which prefix /api/p/<id>/ correctly); hub-level
// writes (tmux send, schedule) can't use the prefixing apiPost, so they post
// raw here. Every action flashes its CLI equivalent so the UI teaches bd.
import { store, editIssue, quickCapture, createIssue, toast, navigate, selectIssue, requireToken } from '../store.js';
import { apiPost, getToken, AuthError } from '../api.js';
import { flashCli } from './state.js';

const q = (s) => JSON.stringify(String(s));

// Raw hub POST (no project prefixing) — for /api/tmux/send and /api/schedule.
export async function hubPost(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (store.meta.value?.tokenRequired) headers['x-bd-token'] = getToken();
  const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) throw new AuthError(data.error || 'token required');
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return data;
}

async function guarded(fn) {
  try { return await fn(); }
  catch (e) { if (e instanceof AuthError) requireToken('A write token is required for that.'); throw e; }
}

// Every write path below follows the same contract: run the write, THEN
// flash the CLI receipt — never the reverse, and never flash on failure.
// store.editIssue/quickCapture/createIssue only toast for AuthError (via
// requireToken) or on success; a plain network/server failure otherwise
// passes through silently, which reads as nothing happened. Wrap the write
// so every caller gets an explicit error toast in that case too, and so
// flashCli is structurally unreachable when the write rejected.
async function withErrorToast(fn, failMessage) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof AuthError)) toast(`${failMessage}: ${e.message}`, 'err');
    throw e;
  }
}

// ---- issue actions (reuse store.editIssue) --------------------------------
export async function actClaim(id) {
  await withErrorToast(() => editIssue({ id, op: 'claim' }, 'Claimed ' + id), `Failed to claim ${id}`);
  flashCli(`bd update ${id} --claim`, 'claim');
}
export async function actStart(id) {
  await withErrorToast(() => editIssue({ id, op: 'set-status', status: 'in_progress' }, 'Started ' + id), `Failed to start ${id}`);
  flashCli(`bd update ${id} --status in_progress`, 'start');
}
export async function actClose(id, reason) {
  await withErrorToast(() => editIssue({ id, op: 'set-status', status: 'closed', reason: reason || '' }, 'Closed ' + id), `Failed to close ${id}`);
  flashCli(reason ? `bd close ${id} --reason ${q(reason)}` : `bd close ${id}`, 'close');
}
export async function actReopen(id, reason) {
  await withErrorToast(() => editIssue({ id, op: 'set-status', status: 'open', reason: reason || '' }, 'Reopened ' + id), `Failed to reopen ${id}`);
  flashCli(`bd reopen ${id}`, 'reopen');
}
export async function actPriority(id, p) {
  await withErrorToast(() => editIssue({ id, op: 'set-priority', priority: String(p) }, `Set ${id} to P${p}`), `Failed to set priority on ${id}`);
  flashCli(`bd update ${id} -p ${p}`, 'priority');
}
export async function actDefer(id, when) {
  await withErrorToast(() => editIssue({ id, op: 'set-defer', defer: when }, `Deferred ${id}`), `Failed to defer ${id}`);
  flashCli(`bd update ${id} --defer ${q(when)}`, 'defer');
}
export async function actAddLabel(id, label) {
  await withErrorToast(() => editIssue({ id, op: 'add-label', label }, `Labeled ${id}`), `Failed to label ${id}`);
  flashCli(`bd label add ${id} ${label}`, 'label');
}
export async function actRemoveLabel(id, label) {
  await withErrorToast(() => editIssue({ id, op: 'remove-label', label }, `Unlabeled ${id}`), `Failed to unlabel ${id}`);
  flashCli(`bd label remove ${id} ${label}`, 'label');
}
export async function actSetParent(id, parent) {
  await withErrorToast(() => editIssue({ id, op: 'set-parent', parent }, parent ? `Reparented ${id}` : `Cleared parent of ${id}`), `Failed to reparent ${id}`);
  flashCli(`bd update ${id} --parent ${parent || '""'}`, 'parent');
}
export async function actAddBlocker(id, blocker) {
  await withErrorToast(() => editIssue({ id, op: 'add-blocker', blocker }, `Added blocker to ${id}`), `Failed to add blocker to ${id}`);
  flashCli(`bd dep add ${id} ${blocker}`, 'blocker');
}
export async function actRemoveBlocker(id, blocker) {
  await withErrorToast(() => editIssue({ id, op: 'remove-blocker', blocker }, `Removed blocker from ${id}`), `Failed to remove blocker from ${id}`);
  flashCli(`bd dep remove ${id} ${blocker}`, 'blocker');
}

// ---- capture --------------------------------------------------------------
export async function captureTriage(title) {
  // quickCapture (store.js) already does the POST, refreshes the issue list,
  // and fires a generic "Captured <id>" toast — but that toast doesn't carry
  // the title, so next to the CLI flash it reads as ambiguous ("was that a
  // command I need to run, or did it just happen?"). Swap it for a receipt
  // that names both the id and the title. quickCapture's own selectIssue()
  // call opens the Detail slide-over briefly; the caller (Omnibar) clears
  // selectedId right after so capture flow stays on the omnibar.
  const id = await withErrorToast(() => quickCapture({ title }), `Failed to capture "${title}"`);
  // Target the exact generic toast by message (id is unique per capture) so
  // this stays correct even if a second capture is in flight concurrently
  // (rapid-fire capture) — an index/diff-based removal could clobber the
  // wrong toast in that case.
  store.toasts.value = store.toasts.value.filter((t) => t.message !== 'Captured ' + id);
  toast(`✓ Captured ${id} · "${title}"`);
  flashCli(`bd create --type task -p 3 --labels triage --title ${q(title)}`, 'capture');
  return id;
}
export async function capturePromoted(title, description, path) {
  // Label charset (LABEL_RE) forbids '/', so encode the doc path into a valid
  // provenance label; the human-readable path is preserved in the description.
  const docLabel = 'doc:' + path.replace(/[^A-Za-z0-9_.:-]/g, '_');
  const id = await withErrorToast(
    () => createIssue({ title, type: 'task', priority: 3, labels: ['triage', docLabel], description }),
    `Failed to promote "${title}"`,
  );
  store.toasts.value = store.toasts.value.filter((t) => t.message !== 'Created ' + id);
  toast(`✓ Captured ${id} · "${title}"`);
  flashCli(`bd create --type task -p 3 --labels triage,${docLabel} --title ${q(title)}`, 'promote');
  return id;
}

// ---- doc save (project-scoped, apiPost prefixes correctly) -----------------
export async function saveDoc(path, content) {
  await withErrorToast(() => guarded(() => apiPost('/api/doc', { path, content })), `Failed to save ${path}`);
  flashCli(`bd-console doc save ${path}`, 'doc');
  toast('Saved ' + path);
}

// ---- delegate to a tmux session -------------------------------------------
export async function delegateNow(session, text) {
  await withErrorToast(() => guarded(() => hubPost('/api/tmux/send', { session, text })), `Failed to send to ${session}`);
  flashCli(`tmux send-keys -t ${session} ${q(text)} Enter`, 'delegate');
  toast('Sent to ' + session);
}
export async function delegateSchedule(session, text, runAt) {
  await withErrorToast(() => guarded(() => hubPost('/api/schedule', { prompt: text, session, runAt })), `Failed to schedule for ${session}`);
  flashCli(`bd-console schedule --session ${session} --at ${new Date(runAt).toISOString()}`, 'schedule');
  toast('Scheduled for ' + session);
}

export { navigate, selectIssue };
