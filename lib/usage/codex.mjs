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
// the LAST token-count payload (freshest snapshot), or null if none were
// found. Newer Codex builds can put additional buckets beside the historical
// `rate_limits` object, so keep the whole payload instead of flattening it
// here.
function extractLastRateLimits(text) {
  let last = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const payload = obj && obj.payload;
    if (payload && payload.type === 'token_count' && (
      payload.rate_limits || payload.rate_limits_by_limit_id || payload.additional_rate_limits
    )) {
      last = payload;
    }
  }
  return last;
}

function windowLabel(minutes) {
  if (!Number.isFinite(minutes)) return null;
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normaliseWindow(w) {
  const source = record(w);
  if (!source) return null;

  const explicitRemaining = finiteNumber(source.remaining_percent ?? source.remainingPercent);
  const explicitUsed = finiteNumber(source.used_percent ?? source.usedPercent);
  const percent = explicitUsed ?? (explicitRemaining == null ? null : 100 - explicitRemaining);
  const remainingPercent = explicitRemaining ?? (percent == null ? null : 100 - percent);
  const windowMinutes = finiteNumber(source.window_minutes ?? source.windowMinutes)
    ?? (() => {
      const seconds = finiteNumber(source.limit_window_seconds ?? source.limitWindowSeconds);
      return seconds == null ? null : seconds / 60;
    })();
  const resetsAt = finiteNumber(source.resets_at ?? source.reset_at ?? source.resetAt);

  if (percent == null && remainingPercent == null && windowMinutes == null && resetsAt == null) return null;
  return { percent, remainingPercent, windowMinutes, resetsAt };
}

function windowEntries(source) {
  const result = [];
  const known = new Set([
    'primary', 'secondary', 'primary_window', 'secondary_window', 'windows', 'window',
    'rate_limit', 'rateLimits', 'additional_rate_limits', 'additionalRateLimits',
    'rate_limits_by_limit_id', 'rateLimitsByLimitId', 'limits', 'additional_limits'
  ]);

  const add = (kind, value) => {
    const window = normaliseWindow(value);
    if (window) result.push({ kind, window });
  };

  if (!source) return result;
  add('primary', source.primary ?? source.primary_window);
  add('secondary', source.secondary ?? source.secondary_window);
  add('window', source.window);

  if (Array.isArray(source.windows)) {
    source.windows.forEach((value, index) => {
      const item = record(value);
      const nested = item && (item.window || item.rate_limit_window);
      add(String(item?.id ?? item?.name ?? item?.key ?? `window-${index}`), nested || value);
    });
  } else if (record(source.windows)) {
    for (const [kind, value] of Object.entries(source.windows)) add(kind, value);
  }

  // Preserve unknown future dimensions such as a directly keyed `weekly`
  // window. Metadata and known collections are deliberately excluded.
  for (const [kind, value] of Object.entries(source)) {
    if (known.has(kind) || result.some((entry) => entry.kind === kind)) continue;
    if (normaliseWindow(value)) add(kind, value);
  }
  return result;
}

function textValue(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || null;
}

function limitCandidates(payload) {
  const candidates = [];
  const rateLimits = payload.rate_limits;
  if (Array.isArray(rateLimits)) candidates.push(...rateLimits.map((value) => ({ value })));
  else if (record(rateLimits)) candidates.push({ value: rateLimits });

  const collect = (collection, fallbackName = null) => {
    if (Array.isArray(collection)) {
      for (const value of collection) candidates.push({ value, fallbackName });
    } else if (record(collection)) {
      for (const [key, value] of Object.entries(collection)) {
        candidates.push({ value, fallbackId: key, fallbackName: key });
      }
    }
  };

  collect(payload.rate_limits_by_limit_id);
  collect(rateLimits && rateLimits.rate_limits_by_limit_id);
  collect(payload.additional_rate_limits);
  collect(rateLimits && rateLimits.additional_rate_limits);
  collect(payload.additionalRateLimits);
  collect(rateLimits && rateLimits.additionalRateLimits);
  collect(payload.limits);
  collect(rateLimits && rateLimits.limits);
  collect(payload.additional_limits);
  collect(rateLimits && rateLimits.additional_limits);
  return candidates;
}

function limitWindows(payload) {
  const windows = [];
  const seen = new Set();

  for (const { value, fallbackId, fallbackName } of limitCandidates(payload)) {
    const candidate = record(value);
    if (!candidate) continue;
    const nested = record(candidate.rate_limit ?? candidate.rateLimits);
    const source = nested || candidate;
    const limitId = textValue(
      candidate.limit_id,
      candidate.limitId,
      candidate.metered_feature,
      candidate.meteredFeature,
      fallbackId,
      'codex'
    );
    const limitName = textValue(candidate.limit_name, candidate.limitName, fallbackName);
    const named = limitName || (limitId && limitId !== 'codex' ? limitId : null);

    for (const { kind, window } of windowEntries(source)) {
      const identity = `${limitId}:${kind}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const duration = windowLabel(window.windowMinutes);
      const kindLabel = kind === 'primary' || kind === 'secondary' || kind === 'window'
        ? duration || kind
        : `${kind}${duration ? ` (${duration})` : ''}`;
      windows.push({
        id: limitId === 'codex' && !named ? kind : identity,
        label: named ? `${named} · ${kindLabel}` : kindLabel,
        limitId,
        limitName: named,
        window: kind,
        percent: window.percent,
        remainingPercent: window.remainingPercent,
        resetsAt: window.resetsAt == null ? null : window.resetsAt * 1000
      });
    }
  }
  return windows;
}

function planFromPayload(payload) {
  const rateLimits = record(payload.rate_limits);
  const arrayPlan = Array.isArray(payload.rate_limits)
    ? payload.rate_limits.find((value) => record(value)?.plan_type || record(value)?.planType)
    : null;
  return payload.plan_type
    ?? rateLimits?.plan_type
    ?? rateLimits?.planType
    ?? arrayPlan?.plan_type
    ?? arrayPlan?.planType
    ?? null;
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

  const payload = extractLastRateLimits(text);
  if (!payload) return { provider: 'codex', status: 'no-data', windows: [], fetchedAt };

  const windows = limitWindows(payload);

  return {
    provider: 'codex',
    status: windows.length ? 'ok' : 'no-data',
    plan: planFromPayload(payload),
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
