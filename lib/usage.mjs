// lib/usage.mjs — multi-provider AI usage/quota adapters (Claude Code, Codex,
// Kimi Code).
//
// getClaudeUsage(), getCodexUsage() and getKimiUsage() must NEVER throw: every
// failure mode (missing creds, corrupt files, network errors, expired tokens)
// comes back as a `status` field on the result, never a rejected promise. No
// adapter ever writes to disk or refreshes a token — read-only, best-effort.
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
import { readdir, readFile, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------
const CLAUDE_OK_TTL_MS = 60_000;
const CLAUDE_ERR_TTL_MS = 15_000;
// A 429 means we've been told to slow down — retrying every 15s would only
// sustain the rate limit, so back off much harder on that specific status.
const CLAUDE_RATELIMIT_TTL_MS = 300_000;
const CLAUDE_FETCH_TIMEOUT_MS = 8_000;

let claudeCache = null; // { at: epochMs, ttl: ms, value }

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
    const extra = status === 'rate-limited' ? { message: 'usage endpoint rate-limited; retrying shortly' } : {};
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

// getClaudeUsage(): see module doc. Cached in-memory 60s on success, 15s on
// any non-ok status, so hub polling (every 60s) never triggers more than one
// upstream call per cache window.
export async function getClaudeUsage() {
  const now = Date.now();
  if (claudeCache && (now - claudeCache.at) < claudeCache.ttl) return claudeCache.value;
  let value;
  try {
    value = await computeClaudeUsage();
  } catch {
    value = { provider: 'claude', status: 'error', fetchedAt: now };
  }
  const ttl = value.status === 'ok' ? CLAUDE_OK_TTL_MS
    : value.status === 'rate-limited' ? CLAUDE_RATELIMIT_TTL_MS
    : CLAUDE_ERR_TTL_MS;
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
// any non-ok status — mirrors getClaudeUsage()'s cache policy so hub polling
// stays cheap on both adapters alike.
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
