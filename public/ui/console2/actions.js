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

// ---- issue actions (reuse store.editIssue) --------------------------------
export async function actClaim(id) {
  await editIssue({ id, op: 'claim' }, 'Claimed ' + id);
  flashCli(`bd update ${id} --claim`, 'claim');
}
export async function actStart(id) {
  await editIssue({ id, op: 'set-status', status: 'in_progress' }, 'Started ' + id);
  flashCli(`bd update ${id} --status in_progress`, 'start');
}
export async function actClose(id, reason) {
  await editIssue({ id, op: 'set-status', status: 'closed', reason: reason || '' }, 'Closed ' + id);
  flashCli(reason ? `bd close ${id} --reason ${q(reason)}` : `bd close ${id}`, 'close');
}
export async function actReopen(id, reason) {
  await editIssue({ id, op: 'set-status', status: 'open', reason: reason || '' }, 'Reopened ' + id);
  flashCli(`bd reopen ${id}`, 'reopen');
}
export async function actPriority(id, p) {
  await editIssue({ id, op: 'set-priority', priority: String(p) }, `Set ${id} to P${p}`);
  flashCli(`bd update ${id} -p ${p}`, 'priority');
}
export async function actDefer(id, when) {
  await editIssue({ id, op: 'set-defer', defer: when }, `Deferred ${id}`);
  flashCli(`bd update ${id} --defer ${q(when)}`, 'defer');
}
export async function actAddLabel(id, label) {
  await editIssue({ id, op: 'add-label', label }, `Labeled ${id}`);
  flashCli(`bd label add ${id} ${label}`, 'label');
}
export async function actRemoveLabel(id, label) {
  await editIssue({ id, op: 'remove-label', label }, `Unlabeled ${id}`);
  flashCli(`bd label remove ${id} ${label}`, 'label');
}
export async function actSetParent(id, parent) {
  await editIssue({ id, op: 'set-parent', parent }, parent ? `Reparented ${id}` : `Cleared parent of ${id}`);
  flashCli(`bd update ${id} --parent ${parent || '""'}`, 'parent');
}
export async function actAddBlocker(id, blocker) {
  await editIssue({ id, op: 'add-blocker', blocker }, `Added blocker to ${id}`);
  flashCli(`bd dep add ${id} ${blocker}`, 'blocker');
}
export async function actRemoveBlocker(id, blocker) {
  await editIssue({ id, op: 'remove-blocker', blocker }, `Removed blocker from ${id}`);
  flashCli(`bd dep remove ${id} ${blocker}`, 'blocker');
}

// ---- capture --------------------------------------------------------------
export async function captureTriage(title) {
  const id = await quickCapture({ title });
  flashCli(`bd create --type task -p 3 --labels triage --title ${q(title)}`, 'capture');
  return id;
}
export async function capturePromoted(title, description, path) {
  // Label charset (LABEL_RE) forbids '/', so encode the doc path into a valid
  // provenance label; the human-readable path is preserved in the description.
  const docLabel = 'doc:' + path.replace(/[^A-Za-z0-9_.:-]/g, '_');
  const id = await createIssue({ title, type: 'task', priority: 3, labels: ['triage', docLabel], description });
  flashCli(`bd create --type task -p 3 --labels triage,${docLabel} --title ${q(title)}`, 'promote');
  return id;
}

// ---- doc save (project-scoped, apiPost prefixes correctly) -----------------
export async function saveDoc(path, content) {
  await guarded(() => apiPost('/api/doc', { path, content }));
  flashCli(`bd-console doc save ${path}`, 'doc');
  toast('Saved ' + path);
}

// ---- delegate to a tmux session -------------------------------------------
export async function delegateNow(session, text) {
  await guarded(() => hubPost('/api/tmux/send', { session, text }));
  flashCli(`tmux send-keys -t ${session} ${q(text)} Enter`, 'delegate');
  toast('Sent to ' + session);
}
export async function delegateSchedule(session, text, runAt) {
  await guarded(() => hubPost('/api/schedule', { prompt: text, session, runAt }));
  flashCli(`bd-console schedule --session ${session} --at ${new Date(runAt).toISOString()}`, 'schedule');
  toast('Scheduled for ' + session);
}

export { navigate, selectIssue };
