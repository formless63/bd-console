// lib/usage/gemini.mjs — Gemini (Google's Antigravity CLI — the binary is
// `agy`, NOT `gemini`; see the basename table in lib/tmux.mjs, which classifies
// live panes the same way).
//
// DISK-FIRST like Codex and Kimi, and for the same reasons plus one more: the
// only local socket this CLI opens is its own language-server gRPC/HTTP port,
// which requires the OAuth token this module refuses to read.
//
// THERE IS NO QUOTA GAUGE TO BUILD HERE, and that is a measured finding, not an
// omission. The CLI ships an internal quota manager, but everything it logs is
// control flow — "quotaRefreshLoop: starting reload (force=true)",
// "quotaRefreshLoop: skipped (not logged in)" — with no limit, no utilization,
// and no reset instant, and nothing on disk carries them either. So this
// adapter declares `publishesQuota: false` exactly like Kimi's, `windows` is []
// and the UI must not invent a bar for it.
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
// never reaches the result. It never opens antigravity-cli/
// antigravity-oauth-token (or any other credential file).
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defineProvider, providerRoot } from './harness.mjs';
import { safeReaddir, safeReadJson, readSlice, dirExists, finiteOrNull, toEpochMs, pidAlive } from './read.mjs';

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
// bd-console-a2h: ONE upstream 429 reaches the log up to three times as it
// propagates through the CLI's logger — the singleflight cache wrapper logs it,
// the bare error logs it, and the background-refresh handler logs it again, all
// within the same glog second:
//
//   W0804 14:02:56.652581 log_context.go:117] Cache(loadCodeAssistResponse): Singleflight refresh failed: RESOURCE_EXHAUSTED (code 429)
//   E0804 14:02:56.653012 log.go:398] RESOURCE_EXHAUSTED (code 429)
//   W0804 14:02:56.653202 log_context.go:117] Failed to refresh cache in background: RESOURCE_EXHAUSTED (code 429)
//
// Counting lines reported "3 quota hits" for what was one incident, so
// incidents are keyed by glog second. These markers additionally say WHOSE
// request hit the limit: a background cache refresh, not anything the human
// typed. That distinction matters because the observed case was a poller that
// ran unattended for 17 days — the chip must not imply the user burned quota.
const GEMINI_BACKGROUND_429_RE = /Singleflight refresh failed|Failed to refresh cache in background|Cache\(loadCodeAssistResponse\)|quotaRefreshLoop/;

// Same contract as codexSessionsRoot()/kimiRoot(): one place resolves the root,
// one env override (BD_CONSOLE_GEMINI_DIR) redirects it for tests.
export function geminiRoot() {
  return providerRoot('BD_CONSOLE_GEMINI_DIR', '.gemini');
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
// mtime's year, rolled back one year if that lands in the future. Second
// resolution by construction, which is exactly the granularity the 429 dedupe
// keys on. Returns null for any line that isn't a glog record — malformed input
// is never thrown on.
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
    quotaExhaustedLines: 0,
    quotaBackground: 0,
    quotaExhaustedAt: null,
    quotaExhaustedOrigin: null,
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
  //
  // 429s collapse into incidents keyed by glog second (see
  // GEMINI_BACKGROUND_429_RE above). A line we can't date gets its own key: we
  // can't prove it belongs with anything, and silently merging it would
  // understate as badly as counting lines overstated.
  const incidents = new Map(); // second-key -> { at, background }
  let undated = 0;
  for (const segment of [head, tail]) {
    for (const line of segment.split('\n')) {
      if (line.includes('not logged into Antigravity')) {
        facts.auth = { state: 'signed-out', method: null };
      }
      const applied = /applyAuthResult:.*authMethod=([A-Za-z0-9_.-]{1,32})/.exec(line);
      if (applied) facts.auth = { state: 'signed-in', method: applied[1] };
      if (line.includes('RESOURCE_EXHAUSTED') && line.includes('code 429')) {
        facts.quotaExhaustedLines += 1;
        const at = parseGlogTimestamp(line, log.mtimeMs);
        const key = at != null ? `s${at}` : `u${undated++}`;
        const incident = incidents.get(key) || { at, background: false };
        // One background marker anywhere in the incident settles it: the three
        // lines are the same failure, and only some of them name their origin.
        if (GEMINI_BACKGROUND_429_RE.test(line)) incident.background = true;
        incidents.set(key, incident);
      }
    }
  }

  facts.quotaExhausted = incidents.size;
  for (const incident of incidents.values()) {
    if (incident.background) facts.quotaBackground += 1;
    if (incident.at != null && (facts.quotaExhaustedAt == null || incident.at > facts.quotaExhaustedAt)) {
      facts.quotaExhaustedAt = incident.at;
      facts.quotaExhaustedOrigin = incident.background ? 'background' : 'unknown';
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

  if (!(await dirExists(appDir))) return { provider: 'gemini', status: 'not-installed', windows: [], fetchedAt };

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
    //
    // `exhaustedEvents` counts INCIDENTS, not log lines (bd-console-a2h) —
    // `exhaustedLogLines` is how many lines collapsed into them, kept so the
    // deduplication is auditable rather than invisible. `backgroundEvents` is
    // how many of those incidents the CLI attributed to its own background
    // cache refresh; when they all are, nothing the user did burned the quota
    // and the UI has to say so.
    quota: {
      published: false,
      exhaustedEvents: facts ? facts.quotaExhausted : 0,
      exhaustedLogLines: facts ? facts.quotaExhaustedLines : 0,
      backgroundEvents: facts ? facts.quotaBackground : 0,
      lastExhaustedAt: facts ? facts.quotaExhaustedAt : null,
      lastExhaustedOrigin: facts ? facts.quotaExhaustedOrigin : null,
      scannedBytes: facts ? facts.scannedBytes : 0
    },
    // Empty on purpose, exactly like Kimi's — see the header.
    windows: [],
    asOf: log ? log.mtimeMs : (conversations && conversations.latest ? conversations.latest.updatedAt : null),
    fetchedAt
  };
}

// getGeminiUsage(): see the header. Cached in-memory 60s on success, 15s
// otherwise — the same policy as the Codex and Kimi adapters, since this is
// likewise a local disk read with no upstream to be polite to.
export const getGeminiUsage = defineProvider({
  provider: 'gemini',
  compute: computeGeminiUsage,
  ttl: { ok: GEMINI_OK_TTL_MS, other: GEMINI_ERR_TTL_MS },
  publishesQuota: false
}).get;
