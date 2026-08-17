// console2/actions.js — write actions for Console 2.0. Project-scoped writes
// reuse the shared store actions (which prefix /api/p/<id>/ correctly); hub-level
// writes (tmux send, schedule) can't use the prefixing apiPost, so they post
// raw here. Every action flashes its CLI equivalent so the UI teaches bd.
import {
  store, editIssue, quickCapture, createIssue, toast, navigate, selectIssue, requireToken,
  batchEdit, offerUndo, byId, parentOf, BATCH_MAX_OPS, loadIssues,
} from '../store.js';
import { apiPost, apiPostRaw, AuthError } from '../api.js';
import { flashCli } from './state.js';
// Nudge retirement (public/ui/learn.js): a hint's whole job is to teach one
// move, so the moment the user makes that move — anywhere, by any route — the
// hint is retired permanently rather than waiting for the next data refresh to
// notice. recordAction() is a no-op for every key no hint listens for, so
// sprinkling it on the write paths costs nothing.
import { learn } from '../learn.js';

const q = (s) => JSON.stringify(String(s));

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

// ---- undo (bd-console-974.5) ----------------------------------------------
//
// This is the ONE place that knows what the opposite of an action is, and it
// lives here rather than in Flow/Detail because actions.js is the layer both
// of them already write through — so Detail.js's buttons get undo without
// being edited at all.
//
// The load-bearing rule: the previous values are read out of the store's
// CURRENT issue data, i.e. BEFORE the write. Every caller therefore computes
// its reverse ops first and only then awaits the mutation. After the write the
// old values are gone (loadIssues has overwritten them), so a reverse derived
// afterwards would be a no-op that looks like it worked.
//
// An op is omitted from the reverse when the mutation is a no-op for that
// issue (closing something already closed, adding a label it already has), so
// "Undo" never fires a write that changes something the user didn't.
//
// Deliberately NOT reversible — no entry here, no Undo offered:
//   reopen (the reverse of close is close, and offering it invites a loop),
//   supersede / mark-duplicate (they auto-close a second issue),
//   molecule pour/burn, create/capture, comment.
export const UNDOABLE = new Set(['close', 'claim', 'start', 'priority', 'add-label', 'remove-label', 'parent', 'defer']);

// kind + ids + params -> the ops to SEND. One vocabulary, used by both the
// single-issue helpers below and bulkAct, so a bulk close and a card close
// cannot drift into meaning different things.
export function opsFor(kind, ids, params = {}) {
  switch (kind) {
    case 'close': return ids.map((id) => ({ id, op: 'set-status', status: 'closed', reason: params.reason || '' }));
    case 'claim': return ids.map((id) => ({ id, op: 'claim' }));
    case 'start': return ids.map((id) => ({ id, op: 'set-status', status: 'in_progress' }));
    case 'priority': return ids.map((id) => ({ id, op: 'set-priority', priority: String(params.priority) }));
    case 'add-label': return ids.map((id) => ({ id, op: 'add-label', label: params.label }));
    case 'remove-label': return ids.map((id) => ({ id, op: 'remove-label', label: params.label }));
    case 'parent': return ids.map((id) => ({ id, op: 'set-parent', parent: params.parent || '' }));
    case 'defer': return ids.map((id) => ({ id, op: 'set-defer', defer: params.defer }));
    default: return [];
  }
}

export function reverseOpsFor(kind, ids, params = {}) {
  if (!UNDOABLE.has(kind)) return [];
  const m = byId.value;
  const out = [];
  for (const id of ids) {
    const cur = m.get(id);
    if (!cur) continue; // not in the loaded list — nothing to restore it to
    switch (kind) {
      case 'close':
        // Back to whatever it was, which is not always 'open': closing
        // something that was in_progress and reopening it to 'open' would
        // silently drop the fact that someone was working on it.
        if (cur.status !== 'closed') out.push({ id, op: 'set-status', status: cur.status });
        break;
      case 'claim':
        // `bd update --claim` writes TWO fields (assignee + status), so the
        // reverse is two ops: restore the previous assignee ('' clears it —
        // see set-assignee in lib/bd.mjs) and the previous status.
        out.push({ id, op: 'set-assignee', assignee: cur.assignee || '' });
        if (cur.status !== 'in_progress') out.push({ id, op: 'set-status', status: cur.status });
        break;
      case 'start':
        if (cur.status !== 'in_progress') out.push({ id, op: 'set-status', status: cur.status });
        break;
      case 'priority':
        if (String(cur.priority ?? '') !== String(params.priority)) {
          out.push({ id, op: 'set-priority', priority: String(cur.priority ?? 3) });
        }
        break;
      case 'add-label':
        if (!(cur.labels || []).includes(params.label)) out.push({ id, op: 'remove-label', label: params.label });
        break;
      case 'remove-label':
        if ((cur.labels || []).includes(params.label)) out.push({ id, op: 'add-label', label: params.label });
        break;
      case 'parent': {
        const prev = parentOf(cur) || '';
        if (prev !== (params.parent || '')) out.push({ id, op: 'set-parent', parent: prev });
        break;
      }
      case 'defer':
        // The reverse of a defer is CLEARING it. An issue that was ALREADY
        // deferred gets no undo entry: bd stores an absolute defer_until, and
        // round-tripping that back through --defer would change the deadline
        // the user actually had. Better no offer than a wrong one.
        if (!cur.defer_until) out.push({ id, op: 'set-defer', defer: '' });
        break;
      default: break;
    }
  }
  return out;
}

// Single-issue write that offers an undo. `kind`/`params` pick the reverse;
// the payload is opsFor()'s single op, so the wire format is identical to the
// bulk path's. editIssue is called WITHOUT a successMessage on purpose — the
// undo toast IS the receipt, and two toasts for one action reads as a bug.
async function undoable(kind, id, params, message, failMessage) {
  const reverse = reverseOpsFor(kind, [id], params); // BEFORE the write
  const [payload] = opsFor(kind, [id], params);
  await withErrorToast(() => editIssue(payload), failMessage);
  offerUndo(message, reverse);
}

// ---- issue actions (reuse store.editIssue) --------------------------------
export async function actClaim(id) {
  await undoable('claim', id, {}, 'Claimed ' + id, `Failed to claim ${id}`);
  flashCli(`bd update ${id} --claim`, 'claim');
}
export async function actStart(id) {
  await undoable('start', id, {}, 'Started ' + id, `Failed to start ${id}`);
  flashCli(`bd update ${id} --status in_progress`, 'start');
}
export async function actClose(id, reason) {
  await undoable('close', id, { reason }, 'Closed ' + id, `Failed to close ${id}`);
  flashCli(reason ? `bd close ${id} --reason ${q(reason)}` : `bd close ${id}`, 'close');
  learn.recordAction('close');
}
export async function actReopen(id, reason) {
  await withErrorToast(() => editIssue({ id, op: 'set-status', status: 'open', reason: reason || '' }, 'Reopened ' + id), `Failed to reopen ${id}`);
  flashCli(`bd reopen ${id}`, 'reopen');
}
export async function actPriority(id, p) {
  await undoable('priority', id, { priority: p }, `Set ${id} to P${p}`, `Failed to set priority on ${id}`);
  flashCli(`bd update ${id} -p ${p}`, 'priority');
}
// Reassign, or unassign with an empty string. The CLI echo shows `--assignee
// ""` for the clear because that is the literal incantation (verified against
// bd v1.1.0: it removes the field, it does not set it to an empty string) —
// the whole point of the flash is that pasting it into a terminal does the
// same thing that just happened here.
export async function actSetAssignee(id, assignee) {
  const who = String(assignee || '').trim();
  await withErrorToast(
    () => editIssue({ id, op: 'set-assignee', assignee: who }, who ? `Assigned ${id} to ${who}` : `Unassigned ${id}`),
    who ? `Failed to assign ${id}` : `Failed to unassign ${id}`,
  );
  flashCli(`bd update ${id} --assignee ${who ? who : '""'}`, 'assignee');
}
export async function actDefer(id, when) {
  await undoable('defer', id, { defer: when }, `Deferred ${id}`, `Failed to defer ${id}`);
  flashCli(`bd update ${id} --defer ${q(when)}`, 'defer');
  learn.recordAction('defer');
}
export async function actAddLabel(id, label) {
  await undoable('add-label', id, { label }, `Labeled ${id}`, `Failed to label ${id}`);
  flashCli(`bd label add ${id} ${label}`, 'label');
}
export async function actRemoveLabel(id, label) {
  await undoable('remove-label', id, { label }, `Unlabeled ${id}`, `Failed to unlabel ${id}`);
  flashCli(`bd label remove ${id} ${label}`, 'label');
}
export async function actSetParent(id, parent) {
  await undoable('parent', id, { parent }, parent ? `Reparented ${id}` : `Cleared parent of ${id}`, `Failed to reparent ${id}`);
  flashCli(`bd update ${id} --parent ${parent || '""'}`, 'parent');
  if (parent) learn.recordAction('parent');
}
export async function actAddBlocker(id, blocker) {
  await withErrorToast(() => editIssue({ id, op: 'add-blocker', blocker }, `Added blocker to ${id}`), `Failed to add blocker to ${id}`);
  flashCli(`bd dep add ${id} ${blocker}`, 'blocker');
  learn.recordAction('link');
}
export async function actRemoveBlocker(id, blocker) {
  await withErrorToast(() => editIssue({ id, op: 'remove-blocker', blocker }, `Removed blocker from ${id}`), `Failed to remove blocker from ${id}`);
  flashCli(`bd dep remove ${id} ${blocker}`, 'blocker');
}

// ---- bulk actions (bd-console-974.5) ---------------------------------------
//
// N issues, ONE POST /api/p/<id>/batch, one server-side export, one
// loadIssues(), one undo offer. Never a loop over actClose() — that is the
// thing this replaces (20 closes = 20 requests, 20 bd spawns and 20 full
// exports of the whole JSONL).
const BULK_VERB = {
  close: 'Closed', claim: 'Claimed', start: 'Started', priority: 'Reprioritized',
  'add-label': 'Labeled', 'remove-label': 'Unlabeled', parent: 'Reparented', defer: 'Deferred',
};

// The CLI a user could paste to do the same thing. `bd` has no batch form, so
// this is honestly a shell loop over the ids — which is exactly the receipt
// that teaches what the button did.
function bulkCli(kind, ids, params) {
  const list = ids.join(' ');
  const per = {
    close: 'bd close "$i"' + (params.reason ? ` --reason ${q(params.reason)}` : ''),
    claim: 'bd update "$i" --claim',
    start: 'bd update "$i" --status in_progress',
    priority: `bd update "$i" -p ${params.priority}`,
    'add-label': `bd label add "$i" ${params.label}`,
    'remove-label': `bd label remove "$i" ${params.label}`,
    parent: `bd update "$i" --parent ${params.parent || '""'}`,
    defer: `bd update "$i" --defer ${q(params.defer)}`,
  }[kind];
  return `for i in ${list}; do ${per}; done`;
}

// Returns the server's per-op report, or null when there was nothing to do.
// Throws only on a whole-request failure (already toasted).
export async function bulkAct(kind, ids, params = {}) {
  const list = [...ids];
  if (list.length === 0) return null;
  if (list.length > BATCH_MAX_OPS) {
    toast(`Too many selected — ${list.length} issues, ${BATCH_MAX_OPS} is the maximum per bulk action.`, 'err', 6000);
    return null;
  }
  const ops = opsFor(kind, list, params);
  if (ops.length === 0) return null;
  // Captured BEFORE the write (see reverseOpsFor's header), then narrowed to
  // the ops that actually landed once the server has reported back — undoing
  // an op that failed would be a second guaranteed failure.
  const reverseAll = reverseOpsFor(kind, list, params);

  const data = await withErrorToast(() => batchEdit(ops), `Bulk ${kind} failed`);
  const failed = data.failed || 0;
  const applied = ops.length - failed;
  const okIds = new Set((data.results || []).filter((r) => r.ok).map((r) => r.id));
  const reverse = reverseAll.filter((r) => okIds.has(r.id));

  const verb = BULK_VERB[kind] || 'Updated';
  const detail = kind === 'priority' ? ` to P${params.priority}`
    : (kind === 'add-label' || kind === 'remove-label') ? ` (${params.label})` : '';
  const message = `${verb} ${applied} ${applied === 1 ? 'issue' : 'issues'}${detail}`
    + (failed ? ` · ${failed} failed` : '');
  // A partial failure still offers undo for what DID land, just in a warning
  // toast so the failure count isn't dressed up as a clean success.
  offerUndo(message, reverse, { kind: failed ? 'warn' : 'ok', ...(failed ? { window: 12000 } : {}) });
  if (applied > 0) flashCli(bulkCli(kind, list, params), kind);
  return data;
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
// apiPostRaw (api.js) — no project prefixing, for the two hub-level routes
// below. This used to be a locally reimplemented `hubPost` doing the exact
// same token-header-plus-401-mapping apiPostRaw already does everywhere
// else; one copy of that logic now, not two (bd-console-974.8).
export async function delegateNow(session, text) {
  await withErrorToast(() => guarded(() => apiPostRaw('/api/tmux/send', { session, text })), `Failed to send to ${session}`);
  flashCli(`tmux send-keys -t ${session} ${q(text)} Enter`, 'delegate');
  toast('Sent to ' + session);
}
export async function delegateSchedule(session, text, runAt) {
  await withErrorToast(() => guarded(() => apiPostRaw('/api/schedule', { prompt: text, session, runAt })), `Failed to schedule for ${session}`);
  flashCli(`bd-console schedule --session ${session} --at ${new Date(runAt).toISOString()}`, 'schedule');
  toast('Scheduled for ' + session);
}

// ---- gates (bd-console-974.8) ---------------------------------------------
// Project-scoped write, so apiPost (api.js) — it prefixes /api/p/<id>/ for
// us, unlike the two hub-level calls above.
export async function actResolveGate(gateId, reason) {
  await withErrorToast(
    () => guarded(() => apiPost('/api/gates/resolve', { id: gateId, ...(reason ? { reason } : {}) })),
    `Failed to resolve gate ${gateId}`,
  );
  flashCli(reason ? `bd gate resolve ${gateId} --reason ${q(reason)}` : `bd gate resolve ${gateId}`, 'gate');
  toast(`Resolved gate ${gateId}`);
  // The gate write doesn't go through editIssue/batchEdit (store.js's usual
  // write paths, which already reload), so the blocked issue's banner needs
  // an explicit refresh to notice the gate closed.
  await loadIssues({ force: true }).catch(() => {});
}

export { navigate, selectIssue };
