// lib/bd.mjs — the `bd` CLI wrapper (no shell; args array) + issue export
// helpers + the issue-edit dispatcher.
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.\d+)*$/; // bead id: prefix-xxx or prefix-xxx.N
export const LABEL_RE = /^[A-Za-z0-9_.:-]+$/;

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

export async function runIssueEdit(ctx, body) {
  const id = String(body.id || '');
  const op = String(body.op || '');
  if (!ID_RE.test(id)) return { ok: false, status: 400, error: 'bad id' };

  let result;
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
  } else if (op === 'add-blocker' || op === 'remove-blocker') {
    const blocker = String(body.blocker || '').trim();
    if (!ID_RE.test(blocker)) return { ok: false, status: 400, error: 'bad blocker id' };
    result = await bd(ctx, ['dep', op === 'add-blocker' ? 'add' : 'remove', id, blocker]);
  } else if (op === 'set-defer') {
    const defer = String(body.defer ?? '');
    result = await bd(ctx, ['update', id, '--defer', defer]);
  } else {
    return { ok: false, status: 400, error: 'bad op' };
  }

  if (!result.ok) return { ok: false, status: 500, error: (result.stderr || 'bd command failed').trim() };
  const exportInfo = await ensureIssuesExportFresh(ctx, { force: true });
  if (!exportInfo.ok) return { ok: false, status: 500, error: exportInfo.error, export: exportInfo };
  return { ok: true, status: 200, export: exportInfo, issue: await getIssueById(ctx, id) };
}
