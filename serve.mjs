#!/usr/bin/env node
/**
 * bd-console — a standalone, project-agnostic viewer + light editor for
 * beads (https://github.com/gastownhall/beads) issues and a project's docs.
 *
 * Run it from (or pointed at) any repo that has beads installed:
 *
 *   bd-console                 # auto-detects the .beads/ workspace from cwd
 *   bd-console --repo /path    # explicit workspace
 *   bd-console --port 4200 --host 127.0.0.1
 *
 * Reads .beads/issues.jsonl for the issue list and shells out to the `bd`
 * CLI for live comments + quick capture. Zero npm dependencies (Node built-ins).
 *
 * Config (optional): a `bd-console.json` at the workspace root may set
 *   { "port": 4180, "host": "127.0.0.1", "docRoots": ["docs", ".planning"],
 *     "token": "secret" }
 * Env overrides: BD_CONSOLE_PORT, BD_CONSOLE_HOST, BD_CONSOLE_TOKEN, BD_CONSOLE_REPO.
 *
 * Writes go through `bd` (execFile with an args array — no shell, no injection).
 * If a token is configured, it is required on write (POST) endpoints.
 */
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'node:fs';
import { join, extname, resolve, relative, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { hostname } from 'node:os';

import { mkdirSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

// --- registry ---------------------------------------------------------------
const REGISTRY_DIR = join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'bd-console');
const REGISTRY_PATH = join(REGISTRY_DIR, 'registry.json');

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { projects: {} };
  try { return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')); }
  catch { return { projects: {} }; }
}
function saveRegistry(data) {
  if (!existsSync(REGISTRY_DIR)) mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
}

function getProjectId(workspacePath) {
  return basename(workspacePath).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const out = { command: null, repo: null, port: null, host: null, forward: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'start' || a === 'stop' || a === 'status' || a === 'add' || a === 'remove' || a === 'list') {
      out.command = a;
    } else if (a === '--repo') {
      out.repo = argv[++i];
      out.forward.push('--repo', argv[i]);
    } else if (a === '--port') {
      out.port = Number(argv[++i]);
      out.forward.push('--port', argv[i]);
    } else if (a === '--host') {
      out.host = argv[++i];
      out.forward.push('--host', argv[i]);
    } else if (/^\d+$/.test(a)) {
      out.port = Number(a);
      out.forward.push(a); // bare port, back-compat
    }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

// --- workspace detection ----------------------------------------------------
function findWorkspace(start) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.beads'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
const REGISTRY = loadRegistry();
let MODE = 'hub';
let WORKSPACE = null;

if (ARGS.repo || process.env.BD_CONSOLE_REPO) {
  MODE = 'single';
  WORKSPACE = resolve(ARGS.repo || process.env.BD_CONSOLE_REPO);
} else if (ARGS.command !== 'start' && findWorkspace(process.cwd())) {
  MODE = 'single';
  WORKSPACE = findWorkspace(process.cwd());
} else if (Object.keys(REGISTRY.projects).length === 0 && findWorkspace(process.cwd())) {
  MODE = 'single';
  WORKSPACE = findWorkspace(process.cwd());
}

if (MODE === 'single' && !existsSync(join(WORKSPACE, '.beads'))) {
  console.error(`bd-console: no .beads/ workspace found at or above ${WORKSPACE}`);
  console.error(`Run inside a beads project, or pass --repo <path>.`);
  process.exit(1);
}
if (MODE === 'hub' && Object.keys(REGISTRY.projects).length === 0 && ARGS.command !== 'add') {
  console.warn('bd-console Hub Mode: No projects registered yet. Use `bd-console add` to register projects.');
}

// --- config -----------------------------------------------------------------
function loadConfig(dir) {
  if (!dir) return {};
  const p = join(dir, 'bd-console.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`bd-console: ignoring invalid bd-console.json in ${dir}`);
    return {};
  }
}
const GLOBAL_CONFIG = loadConfig(REGISTRY_DIR);
const CONFIG = MODE === 'single' ? { ...GLOBAL_CONFIG, ...loadConfig(WORKSPACE) } : GLOBAL_CONFIG;
const PORT = ARGS.port || Number(process.env.BD_CONSOLE_PORT) || CONFIG.port || 4180;
const HOST = ARGS.host || process.env.BD_CONSOLE_HOST || CONFIG.host || '127.0.0.1';
const TOKEN = process.env.BD_CONSOLE_TOKEN || CONFIG.token || null;
// In hub mode, these are resolved per-request. In single mode, they are static.
const ISSUES_EXPORT_PATH = MODE === 'single' ? join(WORKSPACE, '.beads', 'issues.jsonl') : null;
const LAST_TOUCHED_PATH = MODE === 'single' ? join(WORKSPACE, '.beads', 'last-touched') : null;

function hostLabel(host) {
  return host === '0.0.0.0' ? 'localhost' : host;
}

// --- daemon -----------------------------------------------------------------
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

if (ARGS.command === 'add') {
  const ws = resolve(ARGS.repo || findWorkspace(process.cwd()) || process.cwd());
  if (!existsSync(join(ws, '.beads'))) {
    console.error(`bd-console: no .beads/ found at ${ws}`);
    process.exit(1);
  }
  const id = getProjectId(ws);
  const reg = loadRegistry();
  let finalId = id;
  let i = 1;
  while (reg.projects[finalId] && reg.projects[finalId].path !== ws) {
    finalId = `${id}-${i++}`;
  }
  reg.projects[finalId] = { path: ws };
  saveRegistry(reg);
  console.log(`Added project '${finalId}' -> ${ws}`);
  process.exit(0);
} else if (ARGS.command === 'remove') {
  const id = ARGS.forward[0] || ARGS.repo;
  if (!id) { console.error('bd-console: specify project id to remove'); process.exit(1); }
  const reg = loadRegistry();
  if (!reg.projects[id]) { console.error(`bd-console: project '${id}' not found`); process.exit(1); }
  delete reg.projects[id];
  saveRegistry(reg);
  console.log(`Removed project '${id}'`);
  process.exit(0);
} else if (ARGS.command === 'list') {
  const reg = loadRegistry();
  console.log('Registered projects:');
  for (const [id, p] of Object.entries(reg.projects)) {
    console.log(`  ${id}: ${p.path}`);
  }
  process.exit(0);
}

if (ARGS.command) {
  const PID_DIR = MODE === 'single' ? join(WORKSPACE, '.beads') : REGISTRY_DIR;
  const PID_FILE = join(PID_DIR, 'console.pid');
  const LOG_FILE = join(PID_DIR, 'console.log');

  if (ARGS.command === 'start') {
    if (existsSync(PID_FILE)) {
      const pid = Number(readFileSync(PID_FILE, 'utf8'));
      if (isProcessRunning(pid)) {
        console.log(`bd-console is already running (PID: ${pid}).`);
        console.log(`Dashboard: http://${hostLabel(HOST)}:${PORT}`);
        process.exit(0);
      }
    }
    const out = openSync(LOG_FILE, 'a');
    const err = openSync(LOG_FILE, 'a');
    const childArgs = [fileURLToPath(import.meta.url), ...ARGS.forward];
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ['ignore', out, err],
      env: process.env // propagate environment variables
    });
    child.unref();
    writeFileSync(PID_FILE, child.pid.toString());
    console.log(`Started bd-console in background (PID: ${child.pid}).`);
    console.log(`Dashboard: http://${hostLabel(HOST)}:${PORT}`);
    console.log(`Logs:      ${LOG_FILE}`);
    console.log(`Run 'bd-console status' to check it, 'bd-console stop' to stop.`);
    process.exit(0);
  } else if (ARGS.command === 'stop') {
    if (!existsSync(PID_FILE)) {
      console.log(`bd-console is not running (no pid file).`);
      process.exit(0);
    }
    const pid = Number(readFileSync(PID_FILE, 'utf8'));
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped bd-console (PID: ${pid}).`);
    } catch (e) {
      if (e.code === 'ESRCH') {
        console.log(`Process ${pid} is not running.`);
      } else {
        console.error(`Error stopping process: ${e.message}`);
      }
    }
    try { unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  } else if (ARGS.command === 'status') {
    if (!existsSync(PID_FILE)) {
      console.log(`bd-console is not running (no pid file).`);
      process.exit(0);
    }
    const pid = Number(readFileSync(PID_FILE, 'utf8'));
    if (isProcessRunning(pid)) {
      console.log(`bd-console is RUNNING (PID: ${pid}).`);
      console.log(`Dashboard: http://${hostLabel(HOST)}:${PORT}`);
      console.log(`Logs:      ${LOG_FILE}`);
    } else {
      console.log(`bd-console is STOPPED (stale PID: ${pid}).`);
    }
    process.exit(0);
  }
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'vendor',
  'coverage', 'target', '.beads', '.cache', 'db', '.turbo', 'tmp'
]);
// docRoots: explicit (config) or auto-discovered (all dirs holding *.md).
const CONFIG_DOC_ROOTS = Array.isArray(CONFIG.docRoots) ? CONFIG.docRoots : null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'
};
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.\d+)*$/; // bead id: prefix-xxx or prefix-xxx.N
const LABEL_RE = /^[A-Za-z0-9_.:-]+$/;

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// --- bd CLI (no shell; args array) ------------------------------------------
function bd(ctx, args) {
  return new Promise((resolveP) => {
    execFile('bd', args, { cwd: ctx.workspace, maxBuffer: 8 * 1024 * 1024, timeout: 20000 }, (err, stdout, stderr) => {
      resolveP({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}

// --- issues -----------------------------------------------------------------
async function getIssues(ctx) {
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

async function getIssueById(ctx, id) {
  const issues = await getIssues(ctx);
  return issues.find((issue) => issue.id === id) || null;
}

async function mtimeMs(path) {
  try { return (await stat(path)).mtimeMs; } catch { return 0; }
}

async function getExportInfo(ctx) {
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

async function refreshIssuesExport(ctx) {
  const r = await bd(ctx, ['export', '-o', join('.beads', 'issues.jsonl')]);
  if (!r.ok) {
    return { ok: false, error: (r.stderr || 'bd export failed').trim() };
  }
  return { ok: true, ...(await getExportInfo(ctx)) };
}

async function ensureIssuesExportFresh(ctx, options = {}) {
  const force = !!options.force;
  const info = await getExportInfo(ctx);
  if (!force && info.exists && !info.stale) return { ok: true, refreshed: false, ...info };
  const refreshed = await refreshIssuesExport(ctx);
  if (!refreshed.ok) return { ok: false, refreshed: false, ...info, error: refreshed.error };
  return { ok: true, refreshed: true, ...refreshed };
}

async function runIssueEdit(ctx, body) {
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
      result = await bd(args);
    } else if (status === 'open') {
      const args = ['reopen', id];
      if (body.reason) args.push('--reason', String(body.reason));
      result = await bd(args);
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

// --- docs -------------------------------------------------------------------
async function walkMd(ctx, dir, group, out, depth) {
  if (depth > 8) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.planning' && depth > 0) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walkMd(ctx, full, group, out, depth + 1);
    } else if (extname(e.name).toLowerCase() === '.md') {
      const rel = relative(ctx.workspace, full).split(sep).join('/');
      let mtime = 0;
      try { mtime = (await stat(full)).mtimeMs; } catch {}
      out.push({ path: rel, name: e.name, group, mtime });
    }
  }
}

async function getDocs(ctx) {
  const out = [];
  if (ctx.configDocRoots) {
    for (const r of ctx.configDocRoots) {
      const full = join(ctx.workspace, r);
      if (existsSync(full) && (await stat(full)).isDirectory()) await walkMd(ctx, full, r, out, 0);
      else if (existsSync(full)) out.push({ path: r, name: basename(r), group: '(files)', mtime: 0 });
    }
  } else {
    // auto-discover: every top-level dir + the repo root's own *.md
    let entries = [];
    try { entries = await readdir(ctx.workspace, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.planning')) continue;
        await walkMd(ctx, join(ctx.workspace, e.name), e.name, out, 0);
      } else if (extname(e.name).toLowerCase() === '.md') {
        let mtime = 0;
        try { mtime = (await stat(join(ctx.workspace, e.name))).mtimeMs; } catch {}
        out.push({ path: e.name, name: e.name, group: '(top level)', mtime });
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function resolveDocPath(ctx, reqPath) {
  if (!reqPath || reqPath.includes('\0')) return null;
  const full = resolve(ctx.workspace, reqPath);
  const rel = relative(ctx.workspace, full);
  if (rel.startsWith('..') || resolve(ctx.workspace, rel) !== full) return null;
  if (extname(full).toLowerCase() !== '.md') return null;
  const top = rel.split(sep)[0];
  if (SKIP_DIRS.has(top)) return null;
  if (ctx.configDocRoots && !ctx.configDocRoots.some((r) => rel === r || rel.startsWith(r + '/'))) return null;
  return full;
}

// --- static -----------------------------------------------------------------
async function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  if (name.includes('..')) { res.writeHead(403); return res.end('forbidden'); }
  const full = join(PUBLIC_DIR, name);
  if (!existsSync(full)) { res.writeHead(404); return res.end('not found'); }
  const body = await readFile(full);
  res.writeHead(200, {
    'content-type': MIME[extname(full)] || 'application/octet-stream',
    'cache-control': 'no-cache' // dev tool — always revalidate so edits show
  });
  res.end(body);
}

// --- request body -----------------------------------------------------------
function readBody(req) {
  return new Promise((resolveP, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      try { resolveP(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function authed(req, url) {
  if (!TOKEN) return true;
  return req.headers['x-bd-token'] === TOKEN || url.searchParams.get('token') === TOKEN;
}

function isLocalOnlyHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

async function computeHealth(ctx) {
  const warnings = [];
  const errors = [];
  let bdVersion = null;
  const version = await bd(ctx, ['version']);
  if (!version.ok) {
    errors.push((version.stderr || 'bd unavailable').trim());
  } else {
    bdVersion = (version.stdout || '').trim();
    const vMatch = bdVersion.match(/version\s+([0-9.]+)/i);
    if (vMatch) bdVersion = vMatch[1];
    
    const extra = (version.stderr || '').trim();
    if (extra && !extra.includes("multiple 'bd' binaries")) {
      warnings.push(extra.replace(/\s+/g, ' '));
    }
  }

  const exportInfo = await getExportInfo(ctx);
  if (!exportInfo.exists) warnings.push('Issue export is missing; the server will attempt to regenerate it.');
  else if (exportInfo.stale) warnings.push('Issue export is stale; the server will refresh it on demand.');

  if (!TOKEN && !isLocalOnlyHost(HOST)) warnings.push('Writes are open on a non-localhost bind.');

  const status = errors.length ? 'err' : warnings.length ? 'warn' : 'ok';
  return {
    status,
    bdVersion,
    docsMode: ctx.configDocRoots ? `configured (${ctx.configDocRoots.join(', ')})` : 'auto-discovered',
    errors,
    warnings
  };
}

// --- server -----------------------------------------------------------------
function getContext(reqPath) {
  let workspace = null;
  let routedPath = reqPath;
  let projectId = null;
  
  if (MODE === 'single') {
    workspace = WORKSPACE;
  } else if (MODE === 'hub' && reqPath.startsWith('/api/p/')) {
    const parts = reqPath.split('/');
    projectId = parts[3];
    const reg = loadRegistry();
    if (reg.projects[projectId]) {
      workspace = reg.projects[projectId].path;
      routedPath = '/api/' + parts.slice(4).join('/');
    }
  }
  
  if (!workspace) return null;
  
  const c = loadConfig(workspace);
  const configDocRoots = Array.isArray(c.docRoots) ? c.docRoots : null;
  
  return {
    workspace,
    issuesExportPath: join(workspace, '.beads', 'issues.jsonl'),
    lastTouchedPath: join(workspace, '.beads', 'last-touched'),
    configDocRoots,
    routedPath,
    projectId
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const originalPath = url.pathname;

    if (MODE === 'hub' && originalPath === '/api/projects') {
      const reg = loadRegistry();
      return sendJson(res, 200, { projects: reg.projects });
    }

    if (originalPath.startsWith('/api/')) {
      const ctx = getContext(originalPath);
      if (!ctx && MODE === 'hub' && originalPath !== '/api/meta') {
        return sendJson(res, 404, { error: 'project not found' });
      }
      
      const path = ctx ? ctx.routedPath : originalPath;

      if (path === '/api/meta') {
        if (!ctx) {
          // Hub mode root meta
          return sendJson(res, 200, { mode: 'hub', host: HOST, port: PORT, hostname: hostname(), writable: true, tokenRequired: !!TOKEN });
        }
        const exportInfo = await getExportInfo(ctx);
        const health = await computeHealth(ctx);
        return sendJson(res, 200, {
          mode: MODE,
          projectId: ctx.projectId,
          workspace: ctx.workspace,
          name: basename(ctx.workspace),
          host: HOST,
          port: PORT,
          hostname: hostname(),
          writable: true,
          tokenRequired: !!TOKEN,
          export: exportInfo,
          health
        });
      }
      
      if (!ctx) return sendJson(res, 400, { error: 'missing context' });

      if (path === '/api/issues') {
        const exportInfo = await ensureIssuesExportFresh(ctx, { force: url.searchParams.get('refresh') === '1' });
        if (!exportInfo.ok) return sendJson(res, 500, { error: exportInfo.error, export: exportInfo });
        return sendJson(res, 200, { issues: await getIssues(ctx), generatedAt: Date.now(), export: exportInfo });
      }
      if (path === '/api/docs') {
        return sendJson(res, 200, { docs: await getDocs(ctx) });
      }
      if (path === '/api/doc') {
        const full = resolveDocPath(ctx, url.searchParams.get('path'));
        if (!full || !existsSync(full)) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, { path: url.searchParams.get('path'), content: await readFile(full, 'utf8') });
      }
      if (path === '/api/comments') {
        const id = url.searchParams.get('id');
        if (!ID_RE.test(id || '')) return sendJson(res, 400, { error: 'bad id' });
        const r = await bd(ctx, ['comments', id, '--json']);
        let comments = [];
        try { comments = JSON.parse(r.stdout || '[]'); } catch {}
        return sendJson(res, 200, { comments });
      }

      // ---- writes (token-gated when a token is configured) ----
      if (req.method === 'POST') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });

        if (path === '/api/comment') {
          const { id, text } = body;
          if (!ID_RE.test(id || '')) return sendJson(res, 400, { error: 'bad id' });
          if (!text || !String(text).trim()) return sendJson(res, 400, { error: 'empty comment' });
          const r = await bd(ctx, ['comment', id, String(text)]);
          if (!r.ok) return sendJson(res, 500, { error: r.stderr || 'bd comment failed' });
          const cr = await bd(ctx, ['comments', id, '--json']);
          let comments = [];
          try { comments = JSON.parse(cr.stdout || '[]'); } catch {}
          return sendJson(res, 200, { ok: true, comments });
        }

        if (path === '/api/quick') {
          const title = String(body.title || '').trim();
          if (!title) return sendJson(res, 400, { error: 'empty title' });
          const label = String(body.label || 'triage').replace(/[^A-Za-z0-9_.:-]/g, '') || 'triage';
          const priority = String(body.priority ?? '3').replace(/[^0-4]/g, '') || '3';
          const args = ['create', '--silent', '--type=task', '-p', priority, '--labels', label, '--title', title];
          if (body.description) args.push('-d', String(body.description));
          const r = await bd(ctx, args);
          if (!r.ok) return sendJson(res, 500, { error: r.stderr || 'bd create failed' });
          const exportInfo = await ensureIssuesExportFresh(ctx, { force: true });
          if (!exportInfo.ok) return sendJson(res, 500, { error: exportInfo.error, id: (r.stdout || '').trim(), export: exportInfo });
          return sendJson(res, 200, { ok: true, id: (r.stdout || '').trim(), export: exportInfo });
        }

        if (path === '/api/edit') {
          const result = await runIssueEdit(ctx, body);
          return sendJson(res, result.status, result.ok ? result : { error: result.error, export: result.export });
        }

        return sendJson(res, 404, { error: 'unknown endpoint' });
      }
    }

    return serveStatic(res, originalPath);
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message || err) });
  }
});

if (MODE === 'single') {
  ensureIssuesExportFresh({
    workspace: WORKSPACE,
    issuesExportPath: ISSUES_EXPORT_PATH,
    lastTouchedPath: LAST_TOUCHED_PATH
  }, { force: true }).catch((err) => {
    console.warn(`bd-console: initial export refresh failed (${err.message})`);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`bd-console [${MODE} mode] → http://${hostLabel(HOST)}:${PORT}`);
  if (MODE === 'single') {
    console.log(`  workspace: ${WORKSPACE}`);
  } else {
    console.log(`  registry: ${REGISTRY_PATH}`);
  }
  console.log(`  writes: ${TOKEN ? 'token-gated' : 'open'}`);
  if (!isLocalOnlyHost(HOST) && !TOKEN) {
    console.warn('  warning: writes are open on a non-localhost bind; set a token or bind to 127.0.0.1');
  }
});
