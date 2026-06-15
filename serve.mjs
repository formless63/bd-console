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
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve, relative, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const out = { repo: null, port: null, host: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (/^\d+$/.test(a)) out.port = Number(a); // bare port, back-compat
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
const WORKSPACE =
  resolve(ARGS.repo || process.env.BD_CONSOLE_REPO || findWorkspace(process.cwd()) || process.cwd());

if (!existsSync(join(WORKSPACE, '.beads'))) {
  console.error(`bd-console: no .beads/ workspace found at or above ${WORKSPACE}`);
  console.error(`Run inside a beads project, or pass --repo <path>.`);
  process.exit(1);
}

// --- config -----------------------------------------------------------------
function loadConfig() {
  const p = join(WORKSPACE, 'bd-console.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`bd-console: ignoring invalid bd-console.json (${e.message})`);
    return {};
  }
}
const CONFIG = loadConfig();
const PORT = ARGS.port || Number(process.env.BD_CONSOLE_PORT) || CONFIG.port || 4180;
const HOST = ARGS.host || process.env.BD_CONSOLE_HOST || CONFIG.host || '127.0.0.1';
const TOKEN = process.env.BD_CONSOLE_TOKEN || CONFIG.token || null;
const ISSUES_EXPORT_PATH = join(WORKSPACE, '.beads', 'issues.jsonl');
const LAST_TOUCHED_PATH = join(WORKSPACE, '.beads', 'last-touched');

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
function bd(args) {
  return new Promise((resolveP) => {
    execFile('bd', args, { cwd: WORKSPACE, maxBuffer: 8 * 1024 * 1024, timeout: 20000 }, (err, stdout, stderr) => {
      resolveP({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}

// --- issues -----------------------------------------------------------------
async function getIssues() {
  if (!existsSync(ISSUES_EXPORT_PATH)) return [];
  const text = await readFile(ISSUES_EXPORT_PATH, 'utf8');
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

async function getIssueById(id) {
  const issues = await getIssues();
  return issues.find((issue) => issue.id === id) || null;
}

async function mtimeMs(path) {
  try { return (await stat(path)).mtimeMs; } catch { return 0; }
}

async function getExportInfo() {
  const exportedAt = await mtimeMs(ISSUES_EXPORT_PATH);
  const lastTouchedAt = await mtimeMs(LAST_TOUCHED_PATH);
  const exists = exportedAt > 0;
  const stale = !!lastTouchedAt && (!exists || exportedAt < lastTouchedAt);
  return {
    exists,
    stale,
    exportedAt: exportedAt || null,
    lastTouchedAt: lastTouchedAt || null
  };
}

async function refreshIssuesExport() {
  const r = await bd(['export', '-o', join('.beads', 'issues.jsonl')]);
  if (!r.ok) {
    return { ok: false, error: (r.stderr || 'bd export failed').trim() };
  }
  return { ok: true, ...(await getExportInfo()) };
}

async function ensureIssuesExportFresh(options = {}) {
  const force = !!options.force;
  const info = await getExportInfo();
  if (!force && info.exists && !info.stale) return { ok: true, refreshed: false, ...info };
  const refreshed = await refreshIssuesExport();
  if (!refreshed.ok) return { ok: false, refreshed: false, ...info, error: refreshed.error };
  return { ok: true, refreshed: true, ...refreshed };
}

async function runIssueEdit(body) {
  const id = String(body.id || '');
  const op = String(body.op || '');
  if (!ID_RE.test(id)) return { ok: false, status: 400, error: 'bad id' };

  let result;
  if (op === 'claim') {
    result = await bd(['update', id, '--claim']);
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
      result = await bd(['update', id, '--status', status]);
    }
  } else if (op === 'set-priority') {
    const priority = String(body.priority ?? '');
    if (!/^[0-4]$/.test(priority)) return { ok: false, status: 400, error: 'bad priority' };
    result = await bd(['update', id, '-p', priority]);
  } else if (op === 'add-label' || op === 'remove-label') {
    const label = String(body.label || '').trim();
    if (!LABEL_RE.test(label)) return { ok: false, status: 400, error: 'bad label' };
    result = await bd(['label', op === 'add-label' ? 'add' : 'remove', id, label]);
  } else if (op === 'set-parent') {
    const parent = String(body.parent || '').trim();
    if (parent && !ID_RE.test(parent)) return { ok: false, status: 400, error: 'bad parent id' };
    result = await bd(['update', id, '--parent', parent]);
  } else if (op === 'add-blocker' || op === 'remove-blocker') {
    const blocker = String(body.blocker || '').trim();
    if (!ID_RE.test(blocker)) return { ok: false, status: 400, error: 'bad blocker id' };
    result = await bd(['dep', op === 'add-blocker' ? 'add' : 'remove', id, blocker]);
  } else if (op === 'set-defer') {
    const defer = String(body.defer ?? '');
    result = await bd(['update', id, '--defer', defer]);
  } else {
    return { ok: false, status: 400, error: 'bad op' };
  }

  if (!result.ok) return { ok: false, status: 500, error: (result.stderr || 'bd command failed').trim() };
  const exportInfo = await ensureIssuesExportFresh({ force: true });
  if (!exportInfo.ok) return { ok: false, status: 500, error: exportInfo.error, export: exportInfo };
  return { ok: true, status: 200, export: exportInfo, issue: await getIssueById(id) };
}

// --- docs -------------------------------------------------------------------
async function walkMd(dir, group, out, depth) {
  if (depth > 8) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.planning' && depth > 0) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walkMd(full, group, out, depth + 1);
    } else if (extname(e.name).toLowerCase() === '.md') {
      const rel = relative(WORKSPACE, full).split(sep).join('/');
      let mtime = 0;
      try { mtime = (await stat(full)).mtimeMs; } catch {}
      out.push({ path: rel, name: e.name, group, mtime });
    }
  }
}

async function getDocs() {
  const out = [];
  if (CONFIG_DOC_ROOTS) {
    for (const r of CONFIG_DOC_ROOTS) {
      const full = join(WORKSPACE, r);
      if (existsSync(full) && (await stat(full)).isDirectory()) await walkMd(full, r, out, 0);
      else if (existsSync(full)) out.push({ path: r, name: basename(r), group: '(files)', mtime: 0 });
    }
  } else {
    // auto-discover: every top-level dir + the repo root's own *.md
    let entries = [];
    try { entries = await readdir(WORKSPACE, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.planning')) continue;
        await walkMd(join(WORKSPACE, e.name), e.name, out, 0);
      } else if (extname(e.name).toLowerCase() === '.md') {
        let mtime = 0;
        try { mtime = (await stat(join(WORKSPACE, e.name))).mtimeMs; } catch {}
        out.push({ path: e.name, name: e.name, group: '(top level)', mtime });
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function resolveDocPath(reqPath) {
  if (!reqPath || reqPath.includes('\0')) return null;
  const full = resolve(WORKSPACE, reqPath);
  const rel = relative(WORKSPACE, full);
  if (rel.startsWith('..') || resolve(WORKSPACE, rel) !== full) return null;
  if (extname(full).toLowerCase() !== '.md') return null;
  const top = rel.split(sep)[0];
  if (SKIP_DIRS.has(top)) return null;
  if (CONFIG_DOC_ROOTS && !CONFIG_DOC_ROOTS.some((r) => rel === r || rel.startsWith(r + '/'))) return null;
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

function hostLabel(host) {
  return host === '0.0.0.0' ? 'localhost' : host;
}

function isLocalOnlyHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

async function computeHealth() {
  const warnings = [];
  const errors = [];
  let bdVersion = null;
  const version = await bd(['version']);
  if (!version.ok) {
    errors.push((version.stderr || 'bd unavailable').trim());
  } else {
    bdVersion = (version.stdout || '').trim();
    const extra = (version.stderr || '').trim();
    if (extra) warnings.push(extra.replace(/\s+/g, ' '));
  }

  const exportInfo = await getExportInfo();
  if (!exportInfo.exists) warnings.push('Issue export is missing; the server will attempt to regenerate it.');
  else if (exportInfo.stale) warnings.push('Issue export is stale; the server will refresh it on demand.');

  if (!TOKEN && !isLocalOnlyHost(HOST)) warnings.push('Writes are open on a non-localhost bind.');

  const status = errors.length ? 'err' : warnings.length ? 'warn' : 'ok';
  return {
    status,
    bdVersion,
    docsMode: CONFIG_DOC_ROOTS ? `configured (${CONFIG_DOC_ROOTS.join(', ')})` : 'auto-discovered',
    errors,
    warnings
  };
}

// --- server -----------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (path === '/api/meta') {
      const exportInfo = await getExportInfo();
      const health = await computeHealth();
      return sendJson(res, 200, {
        workspace: WORKSPACE,
        name: basename(WORKSPACE),
        host: HOST,
        port: PORT,
        writable: true,
        tokenRequired: !!TOKEN,
        export: exportInfo,
        health
      });
    }
    if (path === '/api/issues') {
      const exportInfo = await ensureIssuesExportFresh({ force: url.searchParams.get('refresh') === '1' });
      if (!exportInfo.ok) return sendJson(res, 500, { error: exportInfo.error, export: exportInfo });
      return sendJson(res, 200, { issues: await getIssues(), generatedAt: Date.now(), export: exportInfo });
    }
    if (path === '/api/docs') {
      return sendJson(res, 200, { docs: await getDocs() });
    }
    if (path === '/api/doc') {
      const full = resolveDocPath(url.searchParams.get('path'));
      if (!full || !existsSync(full)) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, { path: url.searchParams.get('path'), content: await readFile(full, 'utf8') });
    }
    if (path === '/api/comments') {
      const id = url.searchParams.get('id');
      if (!ID_RE.test(id || '')) return sendJson(res, 400, { error: 'bad id' });
      const r = await bd(['comments', id, '--json']);
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
        const r = await bd(['comment', id, String(text)]);
        if (!r.ok) return sendJson(res, 500, { error: r.stderr || 'bd comment failed' });
        const cr = await bd(['comments', id, '--json']);
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
        const r = await bd(args);
        if (!r.ok) return sendJson(res, 500, { error: r.stderr || 'bd create failed' });
        const exportInfo = await ensureIssuesExportFresh({ force: true });
        if (!exportInfo.ok) return sendJson(res, 500, { error: exportInfo.error, id: (r.stdout || '').trim(), export: exportInfo });
        return sendJson(res, 200, { ok: true, id: (r.stdout || '').trim(), export: exportInfo });
      }

      if (path === '/api/edit') {
        const result = await runIssueEdit(body);
        return sendJson(res, result.status, result.ok ? result : { error: result.error, export: result.export });
      }

      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    return serveStatic(res, path);
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message || err) });
  }
});

ensureIssuesExportFresh({ force: true }).catch((err) => {
  console.warn(`bd-console: initial export refresh failed (${err.message})`);
});

server.listen(PORT, HOST, () => {
  console.log(`bd-console → http://${hostLabel(HOST)}:${PORT}`);
  console.log(`  workspace: ${WORKSPACE}`);
  console.log(`  writes: ${TOKEN ? 'token-gated' : 'open'} · docs: ${CONFIG_DOC_ROOTS ? CONFIG_DOC_ROOTS.join(', ') : 'auto-discovered'}`);
  if (!isLocalOnlyHost(HOST) && !TOKEN) {
    console.warn('  warning: writes are open on a non-localhost bind; set a token or bind to 127.0.0.1');
  }
});
