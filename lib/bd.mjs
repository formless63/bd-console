// lib/bd.mjs — the `bd` CLI wrapper (no shell; args array) + issue export
// helpers + the issue-edit dispatcher.
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.\d+)*$/; // bead id: prefix-xxx or prefix-xxx.N
export const LABEL_RE = /^[A-Za-z0-9_.:-]+$/;

// The exact `bd dep add --type` enum, verified against `bd dep add --help` on
// bd v1.1.0. User-supplied link types are ALWAYS checked against this
// hardcoded list before reaching execFile — no user text ever becomes a
// `--type` value directly.
//
// Deliberately NOT in this list, even though both appear as stored dependency
// types in the JSONL export:
//   - `duplicates` — produced only by `bd duplicate <id> --of <canonical>`
//     (op: 'mark-duplicate' below). `bd dep add --type duplicates` happens to
//     be accepted by the binary today, but it is not in the documented enum
//     and it skips the auto-close the dedicated command performs.
//   - `depends` / `depends-on` — never written by bd; they exist only in
//     relationships.js's defensive BLOCKING_DEP_TYPES read set.
//
// scripts/smoke.mjs re-parses `bd dep add --help` and fails loudly if a future
// bd upgrade changes the enum, and asserts public/ui/relationships.js's
// browser-side mirror of this list is identical.
export const LINK_TYPES = Object.freeze([
  'blocks',
  'tracks',
  'related',
  'parent-child',
  'discovered-from',
  'until',
  'caused-by',
  'validates',
  'relates-to',
  'supersedes',
]);
const LINK_TYPE_SET = new Set(LINK_TYPES);

// --- bd CLI (no shell; args array) ------------------------------------------
export function bd(ctx, args) {
  return new Promise((resolveP) => {
    execFile('bd', args, { cwd: ctx.workspace, maxBuffer: 8 * 1024 * 1024, timeout: 20000 }, (err, stdout, stderr) => {
      // ENOENT means the daemon's PATH can't see `bd` at all (classic systemd
      // minimal-PATH symptom) — say so instead of a bare "bd <cmd> failed".
      const enoent = err && err.code === 'ENOENT';
      resolveP({
        ok: !err,
        stdout: stdout || '',
        stderr: (stderr || '') || (enoent ? "bd binary not found on the daemon's PATH — restart with 'bd-console start' to refresh the systemd unit's PATH" : ''),
        code: err?.code
      });
    });
  });
}

// --- issues -----------------------------------------------------------------
export async function getIssues(ctx) {
  if (!existsSync(ctx.issuesExportPath)) return [];
  const text = await readFile(ctx.issuesExportPath, 'utf8');
  const issues = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec._type === 'issue') issues.push(rec);
    } catch { /* skip */ }
  }
  return issues;
}

export async function getIssueById(ctx, id) {
  const issues = await getIssues(ctx);
  return issues.find((issue) => issue.id === id) || null;
}

async function mtimeMs(path) {
  try { return (await stat(path)).mtimeMs; } catch { return 0; }
}

export async function getExportInfo(ctx) {
  const exportedAt = await mtimeMs(ctx.issuesExportPath);
  const lastTouchedAt = await mtimeMs(ctx.lastTouchedPath);
  const exists = exportedAt > 0;
  const stale = !!lastTouchedAt && (!exists || exportedAt < lastTouchedAt);
  return {
    exists,
    stale,
    exportedAt: exportedAt || null,
    lastTouchedAt: lastTouchedAt || null
  };
}

export async function refreshIssuesExport(ctx) {
  const r = await bd(ctx, ['export', '-o', join('.beads', 'issues.jsonl')]);
  if (!r.ok) {
    return { ok: false, error: (r.stderr || 'bd export failed').trim() };
  }
  return { ok: true, ...(await getExportInfo(ctx)) };
}

export async function ensureIssuesExportFresh(ctx, options = {}) {
  const force = !!options.force;
  const info = await getExportInfo(ctx);
  if (!force && info.exists && !info.stale) return { ok: true, refreshed: false, ...info };
  const refreshed = await refreshIssuesExport(ctx);
  if (!refreshed.ok) return { ok: false, refreshed: false, ...info, error: refreshed.error };
  return { ok: true, refreshed: true, ...refreshed };
}

// `bd <cmd> --json` prints a single JSON object; be forgiving about leading
// progress chatter so a stray line never turns a successful write into an
// error. Returns null when nothing parseable is present.
function parseJsonOut(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  if (start === -1) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

export async function runIssueEdit(ctx, body) {
  const id = String(body.id || '');
  const op = String(body.op || '');
  if (!ID_RE.test(id)) return { ok: false, status: 400, error: 'bad id' };

  let result;
  // Set by the ops that need to tell the UI something beyond "it worked" —
  // notably supersede/mark-duplicate, which auto-close the subject issue.
  let effect = null;
  if (op === 'claim') {
    result = await bd(ctx, ['update', id, '--claim']);
  } else if (op === 'set-status') {
    const status = String(body.status || '');
    if (!['open', 'in_progress', 'closed'].includes(status)) return { ok: false, status: 400, error: 'bad status' };
    if (status === 'closed') {
      const args = ['close', id];
      if (body.reason) args.push('--reason', String(body.reason));
      result = await bd(ctx, args);
    } else if (status === 'open') {
      const args = ['reopen', id];
      if (body.reason) args.push('--reason', String(body.reason));
      result = await bd(ctx, args);
    } else {
      result = await bd(ctx, ['update', id, '--status', status]);
    }
  } else if (op === 'set-priority') {
    const priority = String(body.priority ?? '');
    if (!/^[0-4]$/.test(priority)) return { ok: false, status: 400, error: 'bad priority' };
    result = await bd(ctx, ['update', id, '-p', priority]);
  } else if (op === 'add-label' || op === 'remove-label') {
    const label = String(body.label || '').trim();
    if (!LABEL_RE.test(label)) return { ok: false, status: 400, error: 'bad label' };
    result = await bd(ctx, ['label', op === 'add-label' ? 'add' : 'remove', id, label]);
  } else if (op === 'set-parent') {
    const parent = String(body.parent || '').trim();
    if (parent && !ID_RE.test(parent)) return { ok: false, status: 400, error: 'bad parent id' };
    result = await bd(ctx, ['update', id, '--parent', parent]);
  } else if (op === 'add-link' || op === 'remove-link' || op === 'add-blocker' || op === 'remove-blocker') {
    // add-blocker/remove-blocker are the back-compat aliases of add-link/
    // remove-link with the type pinned to `blocks` and the target read from
    // body.blocker instead of body.other. One code path, so the id/type
    // validation below can never diverge between the two spellings.
    const legacy = op === 'add-blocker' || op === 'remove-blocker';
    const adding = op === 'add-link' || op === 'add-blocker';
    const other = String((legacy ? body.blocker : body.other) ?? '').trim();
    if (!ID_RE.test(other)) return { ok: false, status: 400, error: legacy ? 'bad blocker id' : 'bad link target id' };
    if (other === id) return { ok: false, status: 400, error: 'an issue cannot link to itself' };
    const type = legacy ? 'blocks' : String(body.type ?? 'blocks').trim();
    if (!LINK_TYPE_SET.has(type)) return { ok: false, status: 400, error: 'bad link type' };
    // `bd dep remove` takes no --type: a given (issue, depends_on) pair can
    // carry at most one row, so the pair alone identifies the edge.
    result = adding
      ? await bd(ctx, ['dep', 'add', id, other, '--type', type])
      : await bd(ctx, ['dep', 'remove', id, other]);
    effect = { kind: adding ? 'add-link' : 'remove-link', id, other, type };
  } else if (op === 'supersede' || op === 'mark-duplicate') {
    // State transitions, not plain links: bd closes `id` as a side effect and
    // records the edge on `id` itself ({issue_id: id, depends_on_id: other,
    // type: 'supersedes'|'duplicates'}). The `effect` returned below is what
    // lets the UI say "…and closed it" instead of silently closing an issue.
    const superseding = op === 'supersede';
    const other = String((superseding ? body.with : body.of) ?? '').trim();
    if (!ID_RE.test(other)) return { ok: false, status: 400, error: superseding ? 'bad replacement id' : 'bad canonical id' };
    if (other === id) return { ok: false, status: 400, error: superseding ? 'an issue cannot supersede itself' : 'an issue cannot duplicate itself' };
    result = superseding
      ? await bd(ctx, ['supersede', id, '--with', other, '--json'])
      : await bd(ctx, ['duplicate', id, '--of', other, '--json']);
    effect = { kind: op, id, other };
  } else if (op === 'set-defer') {
    const defer = String(body.defer ?? '');
    result = await bd(ctx, ['update', id, '--defer', defer]);
  } else {
    return { ok: false, status: 400, error: 'bad op' };
  }

  if (!result.ok) return { ok: false, status: 500, error: (result.stderr || 'bd command failed').trim() };
  const exportInfo = await ensureIssuesExportFresh(ctx, { force: true });
  if (!exportInfo.ok) return { ok: false, status: 500, error: exportInfo.error, export: exportInfo };
  const issue = await getIssueById(ctx, id);

  if (effect && (effect.kind === 'supersede' || effect.kind === 'mark-duplicate')) {
    // `bd supersede --json` -> {superseded, replacement, status}
    // `bd duplicate --json` -> {duplicate, canonical, status}
    const parsed = parseJsonOut(result.stdout);
    const resultStatus = parsed?.status ?? issue?.status ?? null;
    effect.resultStatus = resultStatus;
    effect.autoClosed = resultStatus === 'closed';
    effect.message = effect.kind === 'supersede'
      ? `${id} superseded by ${effect.other}${effect.autoClosed ? ' — ' + id + ' was closed' : ''}`
      : `${id} marked duplicate of ${effect.other}${effect.autoClosed ? ' — ' + id + ' was closed' : ''}`;
  }

  return { ok: true, status: 200, export: exportInfo, issue, ...(effect ? { effect } : {}) };
}
