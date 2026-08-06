// lib/usage.mjs — multi-provider AI usage/quota adapters (Claude Code, Codex).
//
// Both getClaudeUsage() and getCodexUsage() must NEVER throw: every failure
// mode (missing creds, corrupt files, network errors, expired tokens) comes
// back as a `status` field on the result, never a rejected promise. Neither
// adapter ever writes to disk or refreshes a token — read-only, best-effort.
//
// Claude: never logs or echoes accessToken/refreshToken. A token past its
// expiresAt short-circuits before any network call (the OAuth usage endpoint
// would just reject it, and we don't want to depend on that behavior).
//
// Codex: reads the newest ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl file
// (walking date directories newest-first, never scanning the whole tree) and
// takes the last `token_count` event's `rate_limits` snapshot as current.
import { readdir, readFile, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
// Cache TTLs are the ONLY thing standing between an open hub tab and the
// OAuth usage endpoint: every viewer of every tab collapses onto this one
// process-wide cache, so the upstream call rate is exactly 1 per TTL no
// matter how many people are watching. A 60s TTL meant a hub left open all
// day made ~1,440 OAuth calls/day and tripped the limit quickly (bd-console-0fg),
// so the steady state is now 5 minutes — quota gauges that move on a 5h/7d
// window do not need minute resolution.
const CLAUDE_OK_TTL_MS = 5 * 60_000;
// Failures (network blip, expired token, malformed creds) retry sooner than a
// success so a transient error doesn't freeze the card for 5 minutes — but
// 15s was needlessly eager for a card nobody reads more than once a minute.
const CLAUDE_ERR_TTL_MS = 60_000;
// A 429 means we've been told to slow down. Now that the steady state is
// already 5 minutes, getting rate-limited at that cadence means the limit is
// strict, so back off hard rather than nibbling at it: 15 minutes, and this
// window is honored even for an explicit human-triggered refresh (see the
// `fresh` handling in getClaudeUsage) — a person hammering ↻ must not be able
// to sustain the rate limit.
const CLAUDE_RATELIMIT_TTL_MS = 15 * 60_000;
// Floor between two upstream calls caused by `fresh` requests. The refresh
// button is the fast path, but "fast" is not "unbounded": repeat clicks
// inside this window are served from cache (flagged `cached: true`) instead
// of becoming upstream calls.
const CLAUDE_FRESH_MIN_MS = 20_000;
const CLAUDE_FETCH_TIMEOUT_MS = 8_000;

let claudeCache = null; // { at: epochMs, ttl: ms, value }
let claudeLastFreshAt = null; // epochMs of the last fresh-triggered upstream call

function claudeCredsPath() {
  const dir = process.env.BD_CONSOLE_CLAUDE_DIR || join(homedir(), '.claude');
  return join(dir, '.credentials.json');
}

async function computeClaudeUsage() {
  const fetchedAt = Date.now();

  let raw;
  try {
    raw = await readFile(claudeCredsPath(), 'utf8');
  } catch {
    return { provider: 'claude', status: 'no-creds', fetchedAt };
  }

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    return { provider: 'claude', status: 'error', fetchedAt };
  }

  const oauth = creds && typeof creds === 'object' ? creds.claudeAiOauth : null;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return { provider: 'claude', status: 'no-creds', fetchedAt };
  }

  const plan = oauth.subscriptionType ?? null;
  const tier = oauth.rateLimitTier ?? null;

  const expiresAt = Number(oauth.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    // Expired — never attempt a network call, never attempt to refresh.
    return {
      provider: 'claude', status: 'token-expired', plan, tier, windows: [], scopedLimits: [], fetchedAt,
      message: 'open Claude Code to refresh'
    };
  }

  let res;
  try {
    res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20'
      },
      signal: AbortSignal.timeout(CLAUDE_FETCH_TIMEOUT_MS)
    });
  } catch {
    return { provider: 'claude', status: 'error', plan, tier, windows: [], fetchedAt };
  }

  if (!res.ok) {
    const status = res.status === 429 ? 'rate-limited' : 'error';
    const extra = status === 'rate-limited' ? { message: 'rate-limited; backing off' } : {};
    return { provider: 'claude', status, plan, tier, windows: [], scopedLimits: [], fetchedAt, ...extra };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { provider: 'claude', status: 'error', plan, tier, windows: [], scopedLimits: [], fetchedAt };
  }

  const windows = [];
  const toMs = (iso) => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  };
  if (data && data.five_hour) {
    windows.push({ id: 'session', label: '5h', percent: data.five_hour.utilization ?? null, resetsAt: toMs(data.five_hour.resets_at) });
  }
  if (data && data.seven_day) {
    windows.push({ id: 'weekly', label: '7d', percent: data.seven_day.utilization ?? null, resetsAt: toMs(data.seven_day.resets_at) });
  }

  const scopedLimits = parseScopedLimits(data && data.limits);

  return { provider: 'claude', status: 'ok', plan, tier, windows, scopedLimits, fetchedAt };
}

// parseScopedLimits(limitsArray): pure mapping from the OAuth usage
// endpoint's `limits[]` to per-model cap entries. Every entry whose
// `scope.model.display_name` is set (e.g. a weekly_scoped cap on a specific
// model) becomes `{ model, percent, severity, resetsAt, active }`; entries
// with `scope: null` (session/weekly_all, not model-specific) are ignored.
// The model set is dynamic — only currently-capped models ever appear here,
// nothing is hardcoded. Exported standalone so it's unit-testable without a
// live network call (see scripts/smoke.mjs).
export function parseScopedLimits(limitsArray) {
  if (!Array.isArray(limitsArray)) return [];
  const toMs = (iso) => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const out = [];
  for (const entry of limitsArray) {
    if (!entry || typeof entry !== 'object') continue;
    const displayName = entry.scope && entry.scope.model && typeof entry.scope.model.display_name === 'string'
      ? entry.scope.model.display_name
      : null;
    if (!displayName) continue;
    out.push({
      model: displayName,
      percent: entry.percent ?? null,
      severity: entry.severity ?? null,
      resetsAt: toMs(entry.resets_at),
      active: entry.is_active === true
    });
  }
  return out;
}

// getClaudeUsage({ fresh }): see module doc. Cached in-memory per the TTLs
// above, so the whole machine makes at most one upstream OAuth call per cache
// window regardless of how many hub tabs are polling.
//
// `fresh: true` is the human-triggered fast path (the hub's ↻ button, via
// GET /api/usage?fresh=1) and may bypass a warm ok/error cache entry — but it
// is deliberately NOT an override of everything:
//   - during a 429 backoff it is ignored entirely (no upstream call), because
//     the whole point of the backoff is that more requests make it worse;
//   - two fresh calls inside CLAUDE_FRESH_MIN_MS collapse into one, so a
//     rapid-click user can't turn the button into a poll loop.
// Whenever the answer comes from cache the result carries `cached: true`, and
// a rate-limited result carries `retryAt` (when the backoff lifts), so the UI
// can say "cached, still backing off" instead of silently pretending the
// refresh worked.
export async function getClaudeUsage({ fresh = false } = {}) {
  const now = Date.now();
  if (claudeCache && (now - claudeCache.at) < claudeCache.ttl) {
    const backingOff = claudeCache.value.status === 'rate-limited';
    const tooSoon = claudeLastFreshAt != null && (now - claudeLastFreshAt) < CLAUDE_FRESH_MIN_MS;
    if (!fresh || backingOff || tooSoon) return { ...claudeCache.value, cached: true };
  }
  if (fresh) claudeLastFreshAt = now;
  let value;
  try {
    value = await computeClaudeUsage();
  } catch {
    value = { provider: 'claude', status: 'error', fetchedAt: now };
  }
  const ttl = value.status === 'ok' ? CLAUDE_OK_TTL_MS
    : value.status === 'rate-limited' ? CLAUDE_RATELIMIT_TTL_MS
    : CLAUDE_ERR_TTL_MS;
  // Stamped on the value (not just the cache entry) so every later cache hit
  // hands the UI the same honest "retry at" instant.
  if (value.status === 'rate-limited') value = { ...value, retryAt: now + ttl };
  claudeCache = { at: now, ttl, value };
  return value;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
const CODEX_OK_TTL_MS = 60_000;
const CODEX_ERR_TTL_MS = 15_000;
const CODEX_MAX_FULL_READ_BYTES = 25 * 1024 * 1024; // read whole file below this size
const CODEX_TAIL_READ_BYTES = 256 * 1024;            // otherwise, read only the last N bytes

let codexCache = null; // { at: epochMs, ttl: ms, value }

// Exported so lib/usage-history.mjs resolves the exact same root (same env
// override) without duplicating the fallback logic.
export function codexSessionsRoot() {
  return process.env.BD_CONSOLE_CODEX_DIR || join(homedir(), '.codex', 'sessions');
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
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
  const fh = await open(path, 'r');
  try {
    const start = Math.max(0, size - CODEX_TAIL_READ_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
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

// getCodexUsage(): see module doc. Cached in-memory 60s on success, 15s on
// any non-ok status. Deliberately shorter than the Claude TTLs above: this is
// a local disk read of a file Codex itself writes — there is no upstream
// quota to be polite to, so it stays fresh and needs no `fresh` bypass (the
// hub's poll cadence, not this TTL, is what bounds its staleness).
export async function getCodexUsage() {
  const now = Date.now();
  if (codexCache && (now - codexCache.at) < codexCache.ttl) return codexCache.value;
  let value;
  try {
    value = await computeCodexUsage();
  } catch {
    value = { provider: 'codex', status: 'error', fetchedAt: now };
  }
  codexCache = { at: now, ttl: value.status === 'ok' ? CODEX_OK_TTL_MS : CODEX_ERR_TTL_MS, value };
  return value;
}
