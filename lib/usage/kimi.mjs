// lib/usage/kimi.mjs — Kimi Code (`kimi web`) stack info.
//
// DISK-FIRST, exactly like the Codex adapter — nothing here opens a socket.
// Kimi Code does run a local JSON API (base path `/api/v1` on the `kimi web`
// port: /healthz, /meta, /models, /providers, /sessions, /workspaces, plus a
// /api/v1/ws websocket), but it is NOT used, for three reasons: (1) it only
// exists while the server is up, and "is the server up?" is one of the
// questions this adapter answers; (2) its /sessions read model returns an
// all-zeros `usage` block in 0.32.0, so the real token numbers only exist on
// disk anyway; (3) reaching it can require the server token, and this module
// makes a point of never reading ~/.kimi-code/server.token. It likewise never
// reads credentials/ or oauth/. Everything below comes from files:
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
// local API — so this adapter declares `publishesQuota: false` and the harness
// guarantees `windows: []`. The UI must not invent a gauge for it. What's real
// is: is the server alive, what version, where it's listening, how many
// sessions/workspaces exist, and what the newest session actually spent.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defineProvider, providerRoot } from './harness.mjs';
import { safeReaddir, safeReadJson, dirExists, finiteOrNull, toEpochMs, pidAlive } from './read.mjs';

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

// Exported for the same reason codexSessionsRoot() is: one place resolves the
// root, one env override (BD_CONSOLE_KIMI_DIR) redirects it for tests.
export function kimiRoot() {
  return providerRoot('BD_CONSOLE_KIMI_DIR', '.kimi-code');
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
// parsing all of them to find the ~1% usage records would be pure waste. That
// substring filter is why 8.8MB of wire logs cost ~94ms instead of seconds;
// keep it in front of any JSON.parse added here.
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

  if (!(await dirExists(root))) return { provider: 'kimi', status: 'not-installed', windows: [], fetchedAt };

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

// getKimiUsage(): see the header. Cached in-memory 60s on success, 15s
// otherwise — the same cache policy as the Codex adapter, so the hub's 60s poll
// never re-walks the session tree more than once per window. No `fresh` bypass
// and no backoff: local disk reads have no upstream to be polite to.
export const getKimiUsage = defineProvider({
  provider: 'kimi',
  compute: computeKimiUsage,
  ttl: { ok: KIMI_OK_TTL_MS, other: KIMI_ERR_TTL_MS },
  publishesQuota: false
}).get;
