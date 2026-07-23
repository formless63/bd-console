// lib/usage-history.mjs — historical token-usage aggregation from local AI
// coding-agent transcripts (Claude Code, Codex). Read-only, best-effort, and
// NEVER throws: on any failure the offending provider's slice comes back as
// `{ available: false }` rather than a rejected promise (mirrors lib/usage.mjs).
//
// This module never reads credentials or hits the network — it only walks
// transcript/session files already on disk and counts tokens that already
// happened. Nothing here can reveal an access/refresh token.
import { readdir, readFile, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexSessionsRoot } from './usage.mjs';

const HISTORY_TTL_MS = 120_000;
const MAX_FULL_READ_BYTES = 50 * 1024 * 1024; // read whole file below this size
const TAIL_READ_BYTES = 512 * 1024;            // otherwise, read only the last N bytes
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_WINDOW_DAYS = 7;

// Per-file parse cache, keyed by absolute path. Value: { mtimeMs, size, records }.
// Unchanged files (same mtime+size) are never re-parsed across calls.
const claudeFileCache = new Map();
const codexFileCache = new Map();

let historyCache = null; // { at: epochMs, days, value }

function claudeDir() {
  return process.env.BD_CONSOLE_CLAUDE_DIR || join(homedir(), '.claude');
}
function claudeProjectsDir() {
  return join(claudeDir(), 'projects');
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

// Recursively collects every *.jsonl file under dir (handles nested
// subagents/*.jsonl the same way top-level transcripts are handled).
async function walkJsonlFiles(dir) {
  const out = [];
  async function walk(d) {
    const entries = await safeReaddir(d);
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

// Reads a file's text content, capping memory use: files under the cap are
// read whole; larger files are tail-read (the leading partial line, if any,
// fails JSON.parse and is simply skipped — every later line is complete).
async function readTextCapped(path, size) {
  if (size <= MAX_FULL_READ_BYTES) return readFile(path, 'utf8');
  const fh = await open(path, 'r');
  try {
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Claude Code transcripts
// ---------------------------------------------------------------------------

function claudeTokensOf(usage) {
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
  const tokens = input + output + cacheRead + cacheCreate;
  return { input, output, cacheRead, cacheCreate, tokens };
}

// Parses one transcript file into a flat list of usage records. Every
// assistant record with a `message.usage` block becomes one record:
// { ts (epoch ms), model, project, input, output, cacheRead, cacheCreate, tokens }.
function parseClaudeFile(text, projectId) {
  const records = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const message = obj && obj.message;
    const usage = message && message.usage;
    const model = message && message.model;
    if (!usage || !model) continue;
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : NaN;
    if (!Number.isFinite(ts)) continue;
    const tok = claudeTokensOf(usage);
    if (tok.tokens <= 0) continue;
    records.push({ ts, model, project: projectId, ...tok });
  }
  return records;
}

async function getClaudeFileRecords(path, st, projectId) {
  const cached = claudeFileCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.records;
  let text;
  try { text = await readTextCapped(path, st.size); } catch { return []; }
  const records = parseClaudeFile(text, projectId);
  claudeFileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, records });
  return records;
}

// Best-effort readable project name from Claude's encoded project directory
// id (an absolute path with '/' replaced by '-', e.g.
// '-home-wicaso-code-bd-console'). Strips a leading /home/<user>/code-style
// prefix when recognizable and returns the remaining segment(s) joined back
// with '-'; falls back to the raw id when the pattern doesn't match.
function deriveProjectName(rawId) {
  const parts = String(rawId).split('-').filter(Boolean);
  if (parts.length === 0) return rawId;
  let idx = 0;
  if (parts[idx] === 'home' || parts[idx] === 'Users') {
    idx++;
    if (idx < parts.length) idx++; // username segment — only skip when we matched a home-style root
  }
  if (parts[idx] === 'code' || parts[idx] === 'src' || parts[idx] === 'projects') idx++;
  const rest = parts.slice(idx);
  return rest.length ? rest.join('-') : parts[parts.length - 1];
}

async function claudeProjectsAvailable(dir) {
  const st = await safeStat(dir);
  return !!(st && st.isDirectory());
}

function dateKeyUTC(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function computeClaudeHistory(from, now) {
  const projectsDir = claudeProjectsDir();
  const empty = {
    available: false, totalTokens: 0, messages: 0,
    byModel: [], byProject: [], byProjectModel: [], daily: [],
    periods: {
      current: { tokens: 0, messages: 0, windowDays: PERIOD_WINDOW_DAYS },
      previous: { tokens: 0, messages: 0, windowDays: PERIOD_WINDOW_DAYS }
    }
  };

  if (!(await claudeProjectsAvailable(projectsDir))) return empty;

  const projectEntries = await safeReaddir(projectsDir);
  const mtimeFloor = from - 2 * DAY_MS;

  const allRecords = [];
  for (const pe of projectEntries) {
    if (!pe.isDirectory()) continue;
    const projectId = pe.name;
    const projDir = join(projectsDir, projectId);
    const files = await walkJsonlFiles(projDir);
    for (const file of files) {
      const st = await safeStat(file);
      if (!st) continue;
      if (st.mtimeMs < mtimeFloor) continue; // untouched well before range: skip reading
      const records = await getClaudeFileRecords(file, st, projectId);
      for (const r of records) {
        if (r.ts >= from && r.ts <= now) allRecords.push(r);
      }
    }
  }

  if (allRecords.length === 0) return { ...empty, available: true };

  let totalTokens = 0;
  const byModelMap = new Map(); // model -> { tokens, input, output, cacheRead, cacheCreate, messages }
  const byProjectMap = new Map(); // project -> { tokens, messages }
  const byProjectModelMap = new Map(); // JSON.stringify([project, model]) -> tokens
  const dailyMap = new Map(); // date -> Map(model -> tokens)

  const currentFrom = now - PERIOD_WINDOW_DAYS * DAY_MS;
  const previousFrom = currentFrom - PERIOD_WINDOW_DAYS * DAY_MS;
  let curTokens = 0, curMessages = 0, prevTokens = 0, prevMessages = 0;

  for (const r of allRecords) {
    totalTokens += r.tokens;

    const bm = byModelMap.get(r.model) || { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 };
    bm.tokens += r.tokens; bm.input += r.input; bm.output += r.output;
    bm.cacheRead += r.cacheRead; bm.cacheCreate += r.cacheCreate; bm.messages += 1;
    byModelMap.set(r.model, bm);

    const bp = byProjectMap.get(r.project) || { tokens: 0, messages: 0 };
    bp.tokens += r.tokens; bp.messages += 1;
    byProjectMap.set(r.project, bp);

    const pmKey = JSON.stringify([r.project, r.model]);
    byProjectModelMap.set(pmKey, (byProjectModelMap.get(pmKey) || 0) + r.tokens);

    const dateKey = dateKeyUTC(r.ts);
    const dm = dailyMap.get(dateKey) || new Map();
    dm.set(r.model, (dm.get(r.model) || 0) + r.tokens);
    dailyMap.set(dateKey, dm);

    if (r.ts >= currentFrom && r.ts <= now) { curTokens += r.tokens; curMessages += 1; }
    else if (r.ts >= previousFrom && r.ts < currentFrom) { prevTokens += r.tokens; prevMessages += 1; }
  }

  const byModel = [...byModelMap.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.tokens - a.tokens);

  const byProject = [...byProjectMap.entries()]
    .map(([project, v]) => ({ project, name: deriveProjectName(project), ...v }))
    .sort((a, b) => b.tokens - a.tokens);

  const byProjectModel = [...byProjectModelMap.entries()]
    .map(([key, tokens]) => {
      const [project, model] = JSON.parse(key);
      return { project, model, tokens };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, m]) => ({ date, byModel: Object.fromEntries(m) }));

  return {
    available: true,
    totalTokens,
    messages: allRecords.length,
    byModel,
    byProject,
    byProjectModel,
    daily,
    periods: {
      current: { tokens: curTokens, messages: curMessages, windowDays: PERIOD_WINDOW_DAYS },
      previous: { tokens: prevTokens, messages: prevMessages, windowDays: PERIOD_WINDOW_DAYS }
    }
  };
}

// ---------------------------------------------------------------------------
// Codex sessions
// ---------------------------------------------------------------------------

// Codex's `last_token_usage` is already the per-turn (non-cumulative) delta,
// with a `total_tokens` field that is itself input+output (cached/reasoning
// are breakdowns of those, not additive) — so it's used directly, unlike
// `total_token_usage` which is a running session total.
function codexTokensOf(u) {
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const cacheRead = Number(u.cached_input_tokens) || 0;
  const total = Number.isFinite(u.total_tokens) ? u.total_tokens : input + output;
  if (total <= 0) return null;
  return { input, output, cacheRead, cacheCreate: 0, total };
}

// Parses one rollout file into usage records. Codex doesn't stamp a model on
// every token_count event, so each event picks up the model from the most
// recent preceding `turn_context` event in the same file (falls back to
// 'unknown' if none seen yet). Note: unlike token_count (`type: 'event_msg'`,
// `payload.type: 'token_count'`), turn_context events carry their type at
// the TOP level (`obj.type === 'turn_context'`) — payload itself has no
// `type` field for these.
function parseCodexFile(text) {
  const records = [];
  let currentModel = 'unknown';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const payload = obj && obj.payload;
    if (!payload) continue;

    if (obj.type === 'turn_context' && typeof payload.model === 'string' && payload.model) {
      currentModel = payload.model;
      continue;
    }

    if (payload.type === 'token_count' && payload.info) {
      const tok = codexTokensOf(payload.info.last_token_usage);
      if (!tok) continue;
      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : NaN;
      if (!Number.isFinite(ts)) continue;
      records.push({ ts, model: currentModel, ...tok });
    }
  }
  return records;
}

async function getCodexFileRecords(path, st) {
  const cached = codexFileCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.records;
  let text;
  try { text = await readTextCapped(path, st.size); } catch { return []; }
  const records = parseCodexFile(text);
  codexFileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, records });
  return records;
}

// Walks sessionsRoot/YYYY/MM/DD, skipping day-directories whose date falls
// entirely outside [from, now] — never scans the whole tree for a bounded
// `days` window.
async function computeCodexHistory(from, now) {
  const root = codexSessionsRoot();
  const empty = { available: false, totalTokens: 0, byModel: [], daily: [] };

  const rootSt = await safeStat(root);
  if (!rootSt || !rootSt.isDirectory()) return empty;

  const mtimeFloor = from - 2 * DAY_MS;
  const allRecords = [];

  const years = (await safeReaddir(root)).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const year of years) {
    const yearPath = join(root, year);
    const months = (await safeReaddir(yearPath)).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const month of months) {
      const monthPath = join(yearPath, month);
      const days = (await safeReaddir(monthPath)).filter((e) => e.isDirectory()).map((e) => e.name);
      for (const day of days) {
        const dayDate = new Date(`${year}-${month}-${day}T00:00:00Z`).getTime();
        if (!Number.isFinite(dayDate) || dayDate < mtimeFloor - DAY_MS || dayDate > now) continue;
        const dayPath = join(monthPath, day);
        const files = (await safeReaddir(dayPath))
          .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
          .map((e) => join(dayPath, e.name));
        for (const file of files) {
          const st = await safeStat(file);
          if (!st) continue;
          if (st.mtimeMs < mtimeFloor) continue;
          const records = await getCodexFileRecords(file, st);
          for (const r of records) {
            if (r.ts >= from && r.ts <= now) allRecords.push(r);
          }
        }
      }
    }
  }

  if (allRecords.length === 0) return { ...empty, available: true };

  let totalTokens = 0;
  const byModelMap = new Map();
  const dailyMap = new Map();

  for (const r of allRecords) {
    totalTokens += r.total;
    const bm = byModelMap.get(r.model) || { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 };
    bm.tokens += r.total; bm.input += r.input; bm.output += r.output;
    bm.cacheRead += r.cacheRead; bm.cacheCreate += r.cacheCreate; bm.messages += 1;
    byModelMap.set(r.model, bm);

    const dateKey = dateKeyUTC(r.ts);
    const dm = dailyMap.get(dateKey) || new Map();
    dm.set(r.model, (dm.get(r.model) || 0) + r.total);
    dailyMap.set(dateKey, dm);
  }

  const byModel = [...byModelMap.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.tokens - a.tokens);

  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, m]) => ({ date, byModel: Object.fromEntries(m) }));

  return { available: true, totalTokens, byModel, daily };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// getUsageHistory({ days }): see module doc for the exact return shape. Never
// throws — any unexpected failure degrades to `{ claude: {available:false},
// codex: {available:false} }` rather than a rejected promise. Cached ~120s
// per `days` value (hub polling is cheap; a single stat+parse per changed
// transcript file is the only real per-call cost after warm-up).
export async function getUsageHistory({ days = 30 } = {}) {
  const clampedDays = Math.max(1, Math.min(90, Number(days) || 30));
  const now = Date.now();

  if (historyCache && historyCache.days === clampedDays && (now - historyCache.at) < HISTORY_TTL_MS) {
    return historyCache.value;
  }

  const from = now - clampedDays * DAY_MS;

  let value;
  try {
    const [claude, codex] = await Promise.all([
      computeClaudeHistory(from, now).catch(() => ({ available: false, totalTokens: 0, messages: 0, byModel: [], byProject: [], byProjectModel: [], daily: [], periods: { current: { tokens: 0, messages: 0, windowDays: PERIOD_WINDOW_DAYS }, previous: { tokens: 0, messages: 0, windowDays: PERIOD_WINDOW_DAYS } } })),
      computeCodexHistory(from, now).catch(() => ({ available: false, totalTokens: 0, byModel: [], daily: [] }))
    ]);
    value = { generatedAt: now, range: { from, to: now }, claude, codex };
  } catch {
    value = {
      generatedAt: now,
      range: { from, to: now },
      claude: { available: false, totalTokens: 0, messages: 0, byModel: [], byProject: [], byProjectModel: [], daily: [], periods: { current: { tokens: 0, messages: 0, windowDays: PERIOD_WINDOW_DAYS }, previous: { tokens: 0, messages: 0, windowDays: PERIOD_WINDOW_DAYS } } },
      codex: { available: false, totalTokens: 0, byModel: [], daily: [] }
    };
  }

  historyCache = { at: now, days: clampedDays, value };
  return value;
}
