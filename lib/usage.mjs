// lib/usage.mjs — multi-provider AI usage/quota adapters (Claude Code, Codex,
// Kimi Code, Gemini/Antigravity).
//
// getClaudeUsage(), getCodexUsage(), getKimiUsage() and getGeminiUsage() must
// NEVER throw: every failure mode (missing creds, corrupt files, network
// errors, expired tokens) comes back as a `status` field on the result, never a
// rejected promise. No adapter ever writes to disk or refreshes a token —
// read-only, best-effort.
//
// Claude: never logs or echoes accessToken/refreshToken. A token past its
// expiresAt short-circuits before any network call (the OAuth usage endpoint
// would just reject it, and we don't want to depend on that behavior).
//
// Codex: reads the newest ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl file
// (walking date directories newest-first, never scanning the whole tree) and
// takes the last `token_count` event's `rate_limits` snapshot as current.
//
// Kimi Code: reads ~/.kimi-code — the `kimi web` server's heartbeat records,
// its session index, and the newest session's wire logs. It NEVER reads
// ~/.kimi-code/server.token, credentials/ or oauth/, and never talks to the
// local kimi HTTP server (see the section comment below for why disk wins).
//
// Gemini (Antigravity CLI, binary `agy`): reads ~/.gemini — the language
// server's own log header/tail, its conversation metadata cache, and its
// updater/config JSON. It NEVER reads ~/.gemini/antigravity-cli/
// antigravity-oauth-token (or any other credential file), and it never
// surfaces the account email the CLI writes into its own log.
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

// ---------------------------------------------------------------------------
// Kimi Code (`kimi web`)
//
// DISK-FIRST, exactly like the Codex adapter above — nothing here opens a
// socket. Kimi Code does run a local JSON API (base path `/api/v1` on the
// `kimi web` port: /healthz, /meta, /models, /providers, /sessions,
// /workspaces, plus a /api/v1/ws websocket), but it is NOT used, for three
// reasons: (1) it only exists while the server is up, and "is the server up?"
// is one of the questions this adapter answers; (2) its /sessions read model
// returns an all-zeros `usage` block in 0.32.0, so the real token numbers only
// exist on disk anyway; (3) reaching it can require the server token, and this
// module makes a point of never reading ~/.kimi-code/server.token. Everything
// below comes from files:
//
//   server/instances/<ULID>.json  {host, port, pid, started_at, heartbeat_at,
//                                  host_version} — heartbeat_at is epoch-ms and
//                                  is rewritten every 15s while the server runs.
//   session_index.jsonl           one {sessionId, sessionDir, workDir} per line.
//   workspaces.json               workspace id -> {name, root} (display names).
//   sessions/<wd>/<session>/state.json         title/cwd/updatedAt/agents.
//   sessions/<wd>/<session>/agents/*/wire.jsonl `usage.record` events carrying
//                                  {model, usage:{inputOther, output,
//                                  inputCacheRead, inputCacheCreation}}.
//
// Kimi exposes NO quota/rate-limit data anywhere — not on disk, not in its
// local API — so `windows` is always [] here and the UI must not invent a
// gauge for it. What's real is: is the server alive, what version, where it's
// listening, how many sessions/workspaces exist, and what the newest session
// actually spent.
// ---------------------------------------------------------------------------
const KIMI_OK_TTL_MS = 60_000;
const KIMI_ERR_TTL_MS = 15_000;
// The heartbeat is rewritten every 15s (measured against Kimi Code 0.32.0), so
// 90s is six missed beats — long enough to survive a stalled/suspended host or
// a slow filesystem, short enough that a server killed a minute ago stops
// being advertised as running.
const KIMI_HEARTBEAT_STALE_MS = 90_000;
// Bounds on the newest-session token scan. A single session can hold dozens of
// sub-agent wire logs totalling tens of MB; these caps keep one /api/usage call
// bounded no matter how large the session grew (`tokens.truncated` reports it).
const KIMI_MAX_SESSIONS_SCANNED = 500;
const KIMI_MAX_AGENT_FILES = 64;
const KIMI_MAX_WIRE_BYTES = 24 * 1024 * 1024;
const KIMI_TITLE_MAX = 120;

let kimiCache = null; // { at: epochMs, ttl: ms, value }

// Exported for the same reason codexSessionsRoot() is: one place resolves the
// root, one env override (BD_CONSOLE_KIMI_DIR) redirects it for tests.
export function kimiRoot() {
  return process.env.BD_CONSOLE_KIMI_DIR || join(homedir(), '.kimi-code');
}

async function safeReadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// state.json exists in two shapes in the wild: v1 writes ISO strings
// (createdAt/updatedAt) and `workDir`, v2 writes epoch-ms numbers and `cwd`.
// Accept both rather than assuming the newer one.
function toEpochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Liveness is a SECONDARY signal only — pids get reused, and the process may
// belong to another user (EPERM still means "something is alive with that
// pid"). The heartbeat is what decides `state`.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM' ? true : false;
  }
}

// One record per server/instances/*.json file, newest heartbeat first. Stale
// files are kept (a crashed server leaves its record behind, and "there is a
// record but it went quiet" is worth being able to say).
async function readKimiInstances(root) {
  const dir = join(root, 'server', 'instances');
  const entries = await safeReaddir(dir);
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const data = await safeReadJson(join(dir, entry.name));
    if (!data || typeof data !== 'object') continue;
    out.push({
      host: typeof data.host === 'string' ? data.host : null,
      port: finiteOrNull(data.port),
      version: typeof data.host_version === 'string' ? data.host_version : null,
      startedAt: finiteOrNull(data.started_at),
      heartbeatAt: finiteOrNull(data.heartbeat_at),
      pid: Number.isInteger(data.pid) ? data.pid : null
    });
  }
  out.sort((a, b) => (b.heartbeatAt ?? -1) - (a.heartbeatAt ?? -1));
  return out;
}

// Parses session_index.jsonl. Malformed lines are skipped, never thrown on.
// Only the last KIMI_MAX_SESSIONS_SCANNED entries are kept — the file is
// append-ordered, so the tail is the recent end.
function parseKimiSessionIndex(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (!obj || typeof obj.sessionDir !== 'string' || !obj.sessionDir) continue;
    out.push({
      sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
      sessionDir: obj.sessionDir,
      workDir: typeof obj.workDir === 'string' ? obj.workDir : null
    });
  }
  return out.length > KIMI_MAX_SESSIONS_SCANNED ? out.slice(-KIMI_MAX_SESSIONS_SCANNED) : out;
}

// workspaces.json -> { <workspace id>: { name, root } }. Missing/corrupt file
// is not an error: workspace ids (wd_<name>_<hash>) are still usable labels.
async function readKimiWorkspaces(root) {
  const data = await safeReadJson(join(root, 'workspaces.json'));
  const map = new Map();
  const workspaces = data && typeof data === 'object' ? data.workspaces : null;
  if (!workspaces || typeof workspaces !== 'object') return map;
  for (const [id, ws] of Object.entries(workspaces)) {
    if (!ws || typeof ws !== 'object') continue;
    map.set(id, {
      name: typeof ws.name === 'string' ? ws.name : null,
      root: typeof ws.root === 'string' ? ws.root : null
    });
  }
  return map;
}

// Sums every `usage.record` event across one session's agent wire logs (main
// agent first, then sub-agents). Lines are pre-filtered by substring before
// JSON.parse — a busy session's wire log is mostly multi-KB content events, and
// parsing all of them to find the ~1% usage records would be pure waste.
//
// `total` follows this repo's existing house convention (lib/usage-history.mjs):
// input + output + cacheRead + cacheCreation, cache reads included. `turns`
// counts turn.ended events across ALL of the session's agents, so a session
// that fanned out to sub-agents counts their turns too — it's a measure of work
// done in the session, not of how many times the human hit enter.
async function readKimiSessionTokens(sessionDir) {
  const agentsDir = join(sessionDir, 'agents');
  const entries = await safeReaddir(agentsDir);
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    .sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));

  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const byModel = new Map();
  let records = 0;
  let turns = 0;
  let budget = KIMI_MAX_WIRE_BYTES;
  let truncated = names.length > KIMI_MAX_AGENT_FILES;

  for (const name of names.slice(0, KIMI_MAX_AGENT_FILES)) {
    const path = join(agentsDir, name, 'wire.jsonl');
    let size;
    try { size = (await stat(path)).size; } catch { continue; }
    if (size > budget) { truncated = true; continue; }
    budget -= size;

    let text;
    try { text = await readFile(path, 'utf8'); } catch { continue; }

    for (const line of text.split('\n')) {
      if (line.includes('"turn.ended"')) turns += 1;
      if (!line.includes('"usage.record"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!obj || obj.type !== 'usage.record') continue;
      const u = obj.usage && typeof obj.usage === 'object' ? obj.usage : {};
      const input = finiteOrNull(u.inputOther) || 0;
      const output = finiteOrNull(u.output) || 0;
      const cacheRead = finiteOrNull(u.inputCacheRead) || 0;
      const cacheCreation = finiteOrNull(u.inputCacheCreation) || 0;
      totals.input += input;
      totals.output += output;
      totals.cacheRead += cacheRead;
      totals.cacheCreation += cacheCreation;
      records += 1;

      const model = typeof obj.model === 'string' && obj.model ? obj.model : 'unknown';
      const acc = byModel.get(model) || { model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, records: 0 };
      acc.input += input;
      acc.output += output;
      acc.cacheRead += cacheRead;
      acc.cacheCreation += cacheCreation;
      acc.total += input + output + cacheRead + cacheCreation;
      acc.records += 1;
      byModel.set(model, acc);
    }
  }

  const models = [...byModel.values()].sort((a, b) => b.total - a.total);
  return {
    ...totals,
    total: totals.input + totals.output + totals.cacheRead + totals.cacheCreation,
    records,
    turns,
    truncated,
    models
  };
}

async function computeKimiUsage() {
  const fetchedAt = Date.now();
  const root = kimiRoot();

  try {
    const st = await stat(root);
    if (!st.isDirectory()) return { provider: 'kimi', status: 'not-installed', windows: [], fetchedAt };
  } catch {
    return { provider: 'kimi', status: 'not-installed', windows: [], fetchedAt };
  }

  // ---- server heartbeat ----------------------------------------------------
  const instances = await readKimiInstances(root);
  const newestInstance = instances[0] || null;
  let server = null;
  if (newestInstance) {
    const age = newestInstance.heartbeatAt != null ? fetchedAt - newestInstance.heartbeatAt : null;
    const fresh = age != null && age >= -KIMI_HEARTBEAT_STALE_MS && age < KIMI_HEARTBEAT_STALE_MS;
    const alive = pidAlive(newestInstance.pid);
    server = {
      // 'running'  fresh heartbeat (the server is beating right now)
      // 'stale'    heartbeat went quiet but the pid is still around — the
      //            process exists yet isn't beating (hung/suspended)
      // 'stopped'  heartbeat went quiet and nothing answers to that pid
      state: fresh ? 'running' : (alive === true ? 'stale' : 'stopped'),
      host: newestInstance.host,
      port: newestInstance.port,
      version: newestInstance.version,
      startedAt: newestInstance.startedAt,
      heartbeatAt: newestInstance.heartbeatAt,
      heartbeatAgeMs: age,
      staleAfterMs: KIMI_HEARTBEAT_STALE_MS,
      pidAlive: alive,
      instances: instances.length
    };
  }

  // ---- sessions + workspaces ----------------------------------------------
  let indexText = null;
  try { indexText = await readFile(join(root, 'session_index.jsonl'), 'utf8'); } catch { indexText = null; }
  const entries = indexText == null ? [] : parseKimiSessionIndex(indexText);
  const workspaceMeta = await readKimiWorkspaces(root);

  const workspaces = new Map();
  let newest = null; // { entry, at }
  for (const entry of entries) {
    // sessions/<workspace id>/<session id>/ — the parent dir names the workspace.
    const parts = entry.sessionDir.split('/').filter(Boolean);
    const workspaceId = parts.length >= 2 ? parts[parts.length - 2] : null;

    // stat() the session's state.json (not a read) purely for recency — one
    // cheap syscall per session instead of parsing every session's JSON.
    let at = null;
    try { at = (await stat(join(entry.sessionDir, 'state.json'))).mtimeMs; } catch { at = null; }
    if (at != null && (!newest || at > newest.at)) newest = { entry, at };

    const key = workspaceId || entry.workDir || '(unknown)';
    const meta = (workspaceId && workspaceMeta.get(workspaceId)) || null;
    const acc = workspaces.get(key) || {
      id: workspaceId,
      name: (meta && meta.name) || null,
      root: (meta && meta.root) || entry.workDir || null,
      sessions: 0,
      lastActivityAt: null
    };
    acc.sessions += 1;
    if (at != null && (acc.lastActivityAt == null || at > acc.lastActivityAt)) acc.lastActivityAt = at;
    workspaces.set(key, acc);
  }

  const workspaceList = [...workspaces.values()]
    .sort((a, b) => (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1));

  // ---- newest session detail ----------------------------------------------
  let latestSession = null;
  if (newest) {
    const state = await safeReadJson(join(newest.entry.sessionDir, 'state.json')) || {};
    const title = typeof state.title === 'string' ? state.title.slice(0, KIMI_TITLE_MAX) : null;
    const workDir = (typeof state.cwd === 'string' && state.cwd)
      || (typeof state.workDir === 'string' && state.workDir)
      || newest.entry.workDir
      || null;
    const agents = state.agents && typeof state.agents === 'object' ? Object.keys(state.agents).length : null;
    const tokens = await readKimiSessionTokens(newest.entry.sessionDir);
    latestSession = {
      id: (typeof state.id === 'string' && state.id) || newest.entry.sessionId,
      title,
      workDir,
      workspaceName: (workspaceList.find((w) => w.root && w.root === workDir) || {}).name || null,
      updatedAt: toEpochMs(state.updatedAt) ?? newest.at,
      createdAt: toEpochMs(state.createdAt),
      agents,
      archived: state.archived === true,
      model: tokens.models.length ? tokens.models[0].model : null,
      tokens
    };
  }

  const status = (server || entries.length > 0) ? 'ok' : 'no-data';

  return {
    provider: 'kimi',
    status,
    server,
    sessions: { total: entries.length, workspaces: workspaceList },
    latestSession,
    // Kimi publishes no quota/rate-limit data — this stays empty on purpose so
    // the shape still matches the other providers without faking a gauge.
    windows: [],
    asOf: newest ? newest.at : (server ? server.heartbeatAt : null),
    fetchedAt
  };
}

// getKimiUsage(): see the section comment. Cached in-memory 60s on success,
// 15s otherwise — the same cache policy as the Claude and Codex adapters, so
// the hub's 60s poll never re-walks the session tree more than once per window.
export async function getKimiUsage() {
  const now = Date.now();
  if (kimiCache && (now - kimiCache.at) < kimiCache.ttl) return kimiCache.value;
  let value;
  try {
    value = await computeKimiUsage();
  } catch {
    value = { provider: 'kimi', status: 'error', windows: [], fetchedAt: now };
  }
  kimiCache = { at: now, ttl: value.status === 'ok' ? KIMI_OK_TTL_MS : KIMI_ERR_TTL_MS, value };
  return value;
}

// ---------------------------------------------------------------------------
// Gemini (Google's Antigravity CLI — the binary is `agy`, NOT `gemini`; see the
// basename table in lib/tmux.mjs, which classifies live panes the same way).
//
// DISK-FIRST like Codex and Kimi above, and for the same reasons plus one more:
// the only local socket this CLI opens is its own language-server gRPC/HTTP
// port, which requires the OAuth token this module refuses to read.
//
// THERE IS NO QUOTA GAUGE TO BUILD HERE, and that is a measured finding, not an
// omission. The CLI ships an internal quota manager, but everything it logs is
// control flow — "quotaRefreshLoop: starting reload (force=true)",
// "quotaRefreshLoop: skipped (not logged in)" — with no limit, no utilization,
// and no reset instant, and nothing on disk carries them either. So `windows`
// is [] exactly like Kimi's, and the UI must not invent a bar for it.
//
// What IS real and observable, all of it from files the CLI writes itself:
//
//   log/cli-<YYYYMMDD>_<HHMMSS>.log  glog-formatted. The HEADER (first lines)
//                                    carries the pid, "Language server version:
//                                    X.Y.Z" and the ports it bound; the file
//                                    name carries the start instant (glog's own
//                                    timestamps omit the year). The TAIL carries
//                                    recent auth transitions and any
//                                    RESOURCE_EXHAUSTED (HTTP 429) replies from
//                                    daily-cloudcode-pa.googleapis.com — which
//                                    is the one honest quota signal available:
//                                    not "how much is left", but "the provider
//                                    said you were out, at this instant".
//   cache/conversation_metadata.json summaries (title/preview/step count/
//                                    updated-at/workspace) for both the CLI and
//                                    the IDE, keyed by conversation id.
//   updater/update_status.json       last self-update outcome.
//   config/projects/*.json           declared project ids/names.
//   antigravity-cli/settings.json    trustedWorkspaces (counted, not listed).
//   config/config.json               userSettings.remoteControlHostname.
//
// PRIVACY: the CLI logs the signed-in account's email address into its own log
// (`applyAuthResult: email=..., authMethod=consumer, quotaProject=`). Nothing
// here ever extracts it — the log is only ever matched against narrow,
// bounded-character-class regexes for the auth METHOD, and the raw log text
// never reaches the result.
// ---------------------------------------------------------------------------
const GEMINI_OK_TTL_MS = 60_000;
const GEMINI_ERR_TTL_MS = 15_000;
// A live CLI touches its log at least every ~6 minutes (its background
// fetchAvailableModels/loadCodeAssist refresh). 15 minutes is well past two
// missed refreshes — long enough not to call a merely idle CLI dead, short
// enough that a process killed a while ago stops being advertised as running.
const GEMINI_LOG_IDLE_MS = 15 * 60_000;
// Bounds on every scan below. The header facts live in the first few hundred
// bytes and the interesting events at the very end, so a multi-MB log is read
// as two small slices and never whole.
const GEMINI_LOG_HEAD_BYTES = 32 * 1024;
const GEMINI_LOG_TAIL_BYTES = 256 * 1024;
const GEMINI_MAX_LOG_FILES = 64;
const GEMINI_MAX_METADATA_BYTES = 8 * 1024 * 1024;
const GEMINI_MAX_CONVERSATIONS = 500;
const GEMINI_MAX_PROJECTS = 64;
const GEMINI_TITLE_MAX = 120;

let geminiCache = null; // { at: epochMs, ttl: ms, value }

// Same contract as codexSessionsRoot()/kimiRoot(): one place resolves the root,
// one env override (BD_CONSOLE_GEMINI_DIR) redirects it for tests.
export function geminiRoot() {
  return process.env.BD_CONSOLE_GEMINI_DIR || join(homedir(), '.gemini');
}

// Byte-range read used for both log slices. Never loads the whole file when the
// file is larger than the slice budget.
async function readSlice(path, start, length) {
  if (length <= 0) return '';
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

// The CLI names its logs cli-<YYYYMMDD>_<HHMMSS>.log. That filename is the only
// place the START YEAR is recorded — glog's in-line timestamps are MMDD only —
// so it, not the log body, is what dates a session.
function parseGeminiLogName(name) {
  const m = /^cli-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.log$/.exec(name);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(t) ? t : null;
}

// glog line prefix -> epoch ms. glog writes local time and omits the year, so
// the year is inferred from `refMs` (the log file's mtime): the same MMDD in the
// mtime's year, rolled back one year if that lands in the future. Returns null
// for any line that isn't a glog record — malformed input is never thrown on.
function parseGlogTimestamp(line, refMs) {
  const m = /^[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (!m) return null;
  const ref = new Date(refMs);
  if (!Number.isFinite(ref.getTime())) return null;
  const build = (year) => new Date(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  let t = build(ref.getFullYear());
  if (Number.isFinite(t) && t > refMs + 86_400_000) t = build(ref.getFullYear() - 1);
  return Number.isFinite(t) ? t : null;
}

// Newest log file in <root>/antigravity-cli/log by mtime. Only the log
// directory is listed (never the whole tree), and only the first
// GEMINI_MAX_LOG_FILES entries are stat()ed.
async function findNewestGeminiLog(appDir) {
  const dir = join(appDir, 'log');
  const entries = await safeReaddir(dir);
  const names = entries.filter((e) => e.isFile() && e.name.startsWith('cli-') && e.name.endsWith('.log'))
    .map((e) => e.name).sort().reverse().slice(0, GEMINI_MAX_LOG_FILES);
  let best = null;
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try { st = await stat(path); } catch { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { path, name, mtimeMs: st.mtimeMs, size: st.size };
  }
  return best;
}

// Head + tail of the newest log, reduced to facts. Deliberately returns only
// scalars parsed out of whitelisted patterns — the log text itself (which holds
// the account email) never leaves this function.
async function readGeminiLogFacts(log) {
  const head = await readSlice(log.path, 0, Math.min(log.size, GEMINI_LOG_HEAD_BYTES));
  const tailStart = Math.max(GEMINI_LOG_HEAD_BYTES, log.size - GEMINI_LOG_TAIL_BYTES);
  const tail = tailStart < log.size ? await readSlice(log.path, tailStart, log.size - tailStart) : '';

  const facts = {
    version: null,
    pid: null,
    ports: [],
    auth: { state: 'unknown', method: null },
    quotaExhausted: 0,
    quotaExhaustedAt: null,
    scannedBytes: head.length + tail.length
  };

  const headMatch = (re) => { const m = re.exec(head); return m ? m[1] : null; };
  facts.version = headMatch(/Language server version:\s*([0-9][0-9A-Za-z.+-]{0,31})/);
  const pid = headMatch(/Starting language server process with pid (\d{1,10})/);
  facts.pid = pid ? Number(pid) : null;
  for (const m of head.matchAll(/listening on random port at (\d{1,5}) for (HTTPS \(gRPC\)|HTTP)/g)) {
    facts.ports.push({ port: Number(m[1]), protocol: m[2].startsWith('HTTPS') ? 'grpc' : 'http' });
  }

  // Auth and quota-exhaustion events are order-sensitive (the last transition
  // wins), so head and tail are walked in file order as one stream. Only the
  // auth METHOD is ever captured — never the email on the same line.
  for (const segment of [head, tail]) {
    for (const line of segment.split('\n')) {
      if (line.includes('not logged into Antigravity')) {
        facts.auth = { state: 'signed-out', method: null };
      }
      const applied = /applyAuthResult:.*authMethod=([A-Za-z0-9_.-]{1,32})/.exec(line);
      if (applied) facts.auth = { state: 'signed-in', method: applied[1] };
      if (line.includes('RESOURCE_EXHAUSTED') && line.includes('code 429')) {
        facts.quotaExhausted += 1;
        const at = parseGlogTimestamp(line, log.mtimeMs);
        if (at != null && (facts.quotaExhaustedAt == null || at > facts.quotaExhaustedAt)) facts.quotaExhaustedAt = at;
      }
    }
  }
  return facts;
}

function geminiTitle(summary) {
  const raw = (typeof summary.Title === 'string' && summary.Title.trim())
    || (typeof summary.Preview === 'string' && summary.Preview.trim())
    || '';
  return raw ? raw.slice(0, GEMINI_TITLE_MAX) : null;
}

// "file:///home/me/code/thing" -> "/home/me/code/thing"; anything else passes
// through unchanged so a non-file workspace URI is still a usable label.
function geminiWorkspacePath(uris) {
  if (!Array.isArray(uris) || uris.length === 0) return null;
  const first = uris[0];
  if (typeof first !== 'string' || !first) return null;
  return first.startsWith('file://') ? decodeURIComponent(first.slice('file://'.length)) : first;
}

// cache/conversation_metadata.json -> { total, byApp, workspaces, latest }.
// The file is a single JSON object keyed by conversation id, so it is read
// whole — but only under GEMINI_MAX_METADATA_BYTES, and only the newest
// GEMINI_MAX_CONVERSATIONS entries are kept once sorted.
async function readGeminiConversations(appDir) {
  const path = join(appDir, 'cache', 'conversation_metadata.json');
  let size;
  try { size = (await stat(path)).size; } catch { return null; }
  if (size > GEMINI_MAX_METADATA_BYTES) return { total: null, byApp: [], workspaces: [], latest: null, truncated: true };

  const data = await safeReadJson(path);
  const conversations = data && typeof data === 'object' ? data.conversations : null;
  if (!conversations || typeof conversations !== 'object') return null;

  const rows = [];
  for (const [id, entry] of Object.entries(conversations)) {
    if (!entry || typeof entry !== 'object') continue;
    const summary = entry.summary && typeof entry.summary === 'object' ? entry.summary : {};
    if (entry.is_internal === true) continue;
    rows.push({
      id: typeof summary.ID === 'string' && summary.ID ? summary.ID : id,
      title: geminiTitle(summary),
      steps: finiteOrNull(summary.NumSteps),
      updatedAt: toEpochMs(summary.UpdatedAt) ?? toEpochMs(entry.last_modified_time),
      app: typeof summary.AppDataDir === 'string' && summary.AppDataDir ? summary.AppDataDir : null,
      projectId: typeof summary.ProjectID === 'string' && summary.ProjectID ? summary.ProjectID : null,
      workspace: geminiWorkspacePath(summary.WorkspaceURIs)
    });
  }
  rows.sort((a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1));
  const truncated = rows.length > GEMINI_MAX_CONVERSATIONS;
  const kept = truncated ? rows.slice(0, GEMINI_MAX_CONVERSATIONS) : rows;

  const apps = new Map();
  const workspaces = new Map();
  for (const row of kept) {
    const appKey = row.app || '(unknown)';
    apps.set(appKey, (apps.get(appKey) || 0) + 1);
    if (!row.workspace) continue;
    const acc = workspaces.get(row.workspace) || { path: row.workspace, conversations: 0, lastActivityAt: null };
    acc.conversations += 1;
    if (row.updatedAt != null && (acc.lastActivityAt == null || row.updatedAt > acc.lastActivityAt)) acc.lastActivityAt = row.updatedAt;
    workspaces.set(row.workspace, acc);
  }

  return {
    total: rows.length,
    byApp: [...apps.entries()].map(([app, count]) => ({ app, count })).sort((a, b) => b.count - a.count),
    workspaces: [...workspaces.values()].sort((a, b) => (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1)),
    latest: kept[0] || null,
    truncated
  };
}

// config/projects/*.json -> [{ id, name }]. Bounded readdir, one small JSON per
// entry; a corrupt file is skipped, never thrown on.
async function readGeminiProjects(root) {
  const dir = join(root, 'config', 'projects');
  const entries = await safeReaddir(dir);
  const names = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).slice(0, GEMINI_MAX_PROJECTS);
  const out = [];
  for (const name of names) {
    const data = await safeReadJson(join(dir, name));
    if (!data || typeof data !== 'object') continue;
    out.push({
      id: typeof data.id === 'string' ? data.id : name.replace(/\.json$/, ''),
      name: typeof data.name === 'string' ? data.name : null
    });
  }
  return out;
}

async function computeGeminiUsage() {
  const fetchedAt = Date.now();
  const root = geminiRoot();
  const appDir = join(root, 'antigravity-cli');

  try {
    const st = await stat(appDir);
    if (!st.isDirectory()) return { provider: 'gemini', status: 'not-installed', windows: [], fetchedAt };
  } catch {
    return { provider: 'gemini', status: 'not-installed', windows: [], fetchedAt };
  }

  // ---- language server (from its own log) ----------------------------------
  const log = await findNewestGeminiLog(appDir);
  const facts = log ? await readGeminiLogFacts(log) : null;
  let server = null;
  if (log) {
    const idleMs = fetchedAt - log.mtimeMs;
    const fresh = idleMs >= -GEMINI_LOG_IDLE_MS && idleMs < GEMINI_LOG_IDLE_MS;
    // Same secondary-signal caveat as Kimi's: pids get reused and may belong to
    // another user, so log freshness — not the pid — decides `state`.
    const alive = pidAlive(facts && facts.pid);
    server = {
      // 'running'  the CLI wrote to its log within GEMINI_LOG_IDLE_MS
      // 'stale'    log went quiet but the pid is still around (hung/suspended)
      // 'stopped'  log went quiet and nothing answers to that pid
      state: fresh && alive !== false ? 'running' : (alive === true ? 'stale' : 'stopped'),
      version: facts ? facts.version : null,
      pid: facts ? facts.pid : null,
      pidAlive: alive,
      ports: facts ? facts.ports : [],
      startedAt: parseGeminiLogName(log.name),
      lastLogAt: log.mtimeMs,
      logIdleMs: idleMs,
      idleAfterMs: GEMINI_LOG_IDLE_MS
    };
  }

  // ---- everything else -----------------------------------------------------
  const conversations = await readGeminiConversations(appDir);
  const projects = await readGeminiProjects(root);
  const updateStatus = await safeReadJson(join(appDir, 'updater', 'update_status.json'));
  const settings = await safeReadJson(join(appDir, 'settings.json'))
    || await safeReadJson(join(root, 'config', 'settings.json'));
  const config = await safeReadJson(join(root, 'config', 'config.json'));
  const remoteHost = config && config.userSettings && typeof config.userSettings.remoteControlHostname === 'string'
    ? config.userSettings.remoteControlHostname
    : null;

  const update = updateStatus && typeof updateStatus === 'object'
    ? {
      ok: updateStatus.success === true,
      message: typeof updateStatus.message === 'string' ? updateStatus.message.slice(0, GEMINI_TITLE_MAX) : null
    }
    : null;

  const status = (server || (conversations && conversations.total)) ? 'ok' : 'no-data';

  return {
    provider: 'gemini',
    status,
    // The CLI is branded Antigravity and installs as `agy`; naming the variant
    // keeps this honest if a differently-branded `gemini` CLI ever shows up.
    variant: 'antigravity-cli',
    server,
    auth: facts ? facts.auth : { state: 'unknown', method: null },
    conversations: conversations || { total: 0, byApp: [], workspaces: [], latest: null, truncated: false },
    config: {
      projects,
      trustedWorkspaces: settings && Array.isArray(settings.trustedWorkspaces) ? settings.trustedWorkspaces.length : null,
      remoteHost
    },
    update,
    // NOT a gauge. `published: false` is the whole point: the provider exposes
    // no limit/utilization/reset anywhere the CLI writes down, so the only
    // quota fact available is "the API answered 429 RESOURCE_EXHAUSTED", counted
    // over the bytes actually scanned (a long-lived log is read tail-first).
    quota: {
      published: false,
      exhaustedEvents: facts ? facts.quotaExhausted : 0,
      lastExhaustedAt: facts ? facts.quotaExhaustedAt : null,
      scannedBytes: facts ? facts.scannedBytes : 0
    },
    // Empty on purpose, exactly like Kimi's — see the section comment.
    windows: [],
    asOf: log ? log.mtimeMs : (conversations && conversations.latest ? conversations.latest.updatedAt : null),
    fetchedAt
  };
}

// getGeminiUsage(): see the section comment. Cached in-memory 60s on success,
// 15s otherwise — the same policy as the Codex and Kimi adapters, since this is
// likewise a local disk read with no upstream to be polite to.
export async function getGeminiUsage() {
  const now = Date.now();
  if (geminiCache && (now - geminiCache.at) < geminiCache.ttl) return geminiCache.value;
  let value;
  try {
    value = await computeGeminiUsage();
  } catch {
    value = { provider: 'gemini', status: 'error', windows: [], fetchedAt: now };
  }
  geminiCache = { at: now, ttl: value.status === 'ok' ? GEMINI_OK_TTL_MS : GEMINI_ERR_TTL_MS, value };
  return value;
}
