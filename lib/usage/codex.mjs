// lib/usage/codex.mjs — Codex quota, from the rollout file Codex writes itself.
//
// DISK-FIRST: reads the newest ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl file
// (walking date directories newest-first, never scanning the whole tree) and
// takes the last `token_count` event's `rate_limits` snapshot as current. No
// network call, so no `fresh` bypass and no backoff — see the TTL note on
// getCodexUsage below.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defineProvider, providerRoot } from './harness.mjs';
import { safeReaddir, readSlice } from './read.mjs';

const CODEX_OK_TTL_MS = 60_000;
const CODEX_ERR_TTL_MS = 15_000;
const CODEX_MAX_FULL_READ_BYTES = 25 * 1024 * 1024; // read whole file below this size
const CODEX_TAIL_READ_BYTES = 256 * 1024;            // otherwise, read only the last N bytes

// Exported so lib/usage-history.mjs resolves the exact same root (same env
// override) without duplicating the fallback logic.
export function codexSessionsRoot() {
  return providerRoot('BD_CONSOLE_CODEX_DIR', '.codex', 'sessions');
}

// Descending-sorted directory names (lexical sort works for zero-padded
// YYYY/MM/DD components) restricted to directory entries.
function sortedDirNames(entries) {
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
}

// Walks sessionsRoot/YYYY/MM/DD newest-first and returns the newest .jsonl
// file (by mtime) in the first day-directory that has any — never scans the
// whole tree, never reads file contents here.
async function findNewestCodexSession(root) {
  const years = sortedDirNames(await safeReaddir(root));
  for (const year of years) {
    const yearPath = join(root, year);
    const months = sortedDirNames(await safeReaddir(yearPath));
    for (const month of months) {
      const monthPath = join(yearPath, month);
      const days = sortedDirNames(await safeReaddir(monthPath));
      for (const day of days) {
        const dayPath = join(monthPath, day);
        const entries = await safeReaddir(dayPath);
        const files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
        if (files.length === 0) continue;

        let best = null;
        for (const f of files) {
          const full = join(dayPath, f.name);
          let st;
          try { st = await stat(full); } catch { continue; }
          if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs, size: st.size };
        }
        if (best) return best;
      }
    }
  }
  return null;
}

async function readSessionText(path, size) {
  if (size <= CODEX_MAX_FULL_READ_BYTES) {
    return readFile(path, 'utf8');
  }
  // Large file: read only the tail so we never load a 100s-of-MB rollout
  // into memory. The very first (partial) line, if any, will fail JSON.parse
  // and is simply skipped — every later line is a complete JSON record.
  const start = Math.max(0, size - CODEX_TAIL_READ_BYTES);
  return readSlice(path, start, size - start);
}

// Scans line-by-line for `payload.type === 'token_count'` events and returns
// the LAST one's `payload.rate_limits` (freshest snapshot), or null if none
// were found.
function extractLastRateLimits(text) {
  let last = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const payload = obj && obj.payload;
    if (payload && payload.type === 'token_count' && payload.rate_limits) {
      last = payload.rate_limits;
    }
  }
  return last;
}

function windowLabel(minutes) {
  if (!Number.isFinite(minutes)) return null;
  return minutes === 10080 ? '7d' : `${minutes / 60}h`;
}

function toWindow(id, w) {
  if (!w) return null;
  return {
    id,
    label: windowLabel(w.window_minutes) || id,
    percent: w.used_percent ?? null,
    resetsAt: Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null
  };
}

async function computeCodexUsage() {
  const fetchedAt = Date.now();
  const root = codexSessionsRoot();

  let newest;
  try {
    newest = await findNewestCodexSession(root);
  } catch {
    return { provider: 'codex', status: 'error', windows: [], fetchedAt };
  }
  if (!newest) return { provider: 'codex', status: 'no-data', windows: [], fetchedAt };

  let text;
  try {
    text = await readSessionText(newest.path, newest.size);
  } catch {
    return { provider: 'codex', status: 'error', windows: [], fetchedAt };
  }

  const rl = extractLastRateLimits(text);
  if (!rl) return { provider: 'codex', status: 'no-data', windows: [], fetchedAt };

  const windows = [];
  const primary = toWindow('primary', rl.primary);
  if (primary) windows.push(primary);
  const secondary = toWindow('secondary', rl.secondary);
  if (secondary) windows.push(secondary);

  return {
    provider: 'codex',
    status: windows.length ? 'ok' : 'no-data',
    plan: rl.plan_type ?? null,
    windows,
    asOf: newest.mtimeMs,
    fetchedAt
  };
}

// getCodexUsage(): see the header. Cached in-memory 60s on success, 15s on
// any non-ok status. Deliberately shorter than the Claude TTLs: this is a local
// disk read of a file Codex itself writes — there is no upstream quota to be
// polite to, so it stays fresh and needs no `fresh` bypass (the hub's poll
// cadence, not this TTL, is what bounds its staleness). Codex DOES publish real
// quota windows, so `publishesQuota` is true here and the gauges are honest.
export const getCodexUsage = defineProvider({
  provider: 'codex',
  compute: computeCodexUsage,
  ttl: { ok: CODEX_OK_TTL_MS, other: CODEX_ERR_TTL_MS },
  publishesQuota: true
}).get;
