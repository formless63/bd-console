// lib/routes.mjs — the hub HTTP request handler: getContext (registry ->
// per-project workspace), all /api routes, and static serving from public/.
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';

import { loadRegistry } from './registry.mjs';
import { loadWorkspaceConfig, loadGlobalConfig, resolveSettings, saveGlobalConfig } from './config.mjs';
import { CONFIG_PATH } from './paths.mjs';
import {
  bd, getIssues, getIssueById, getExportInfo, ensureIssuesExportFresh,
  runIssueEdit, ID_RE, LABEL_RE,
  FORMULA_NAME_RE, PROTO_RE, normalizeVars,
  listFormulas, showFormula, previewFormula,
  showMolecule, pourPreview, pourMolecule, burnPreview, burnMolecule,
  FORMULA_CONTENT_MAX_BYTES, formulaFileName,
  listFormulaFiles, readFormulaFile, writeFormulaFile,
  distillPreview, distillEpic,
} from './bd.mjs';

// Types accepted by POST /api/p/<id>/create. `bd create` supports a couple
// more (decision, event, ...) but the create UI only ever offers these five.
const CREATE_TYPES = ['task', 'bug', 'feature', 'epic', 'chore'];
const ASSIGNEE_RE = /^[A-Za-z0-9._@-]+$/;

// Variables for the formula/pour routes arrive as repeated `var.<key>=<value>`
// query params (GET) or a `vars` object (POST). Reads them out of a URL into
// the `{key: value}` shape lib/bd.mjs's normalizeVars() validates.
function varsFromQuery(url) {
  const vars = {};
  for (const [k, v] of url.searchParams) {
    if (k.startsWith('var.')) vars[k.slice(4)] = v;
  }
  return vars;
}
import { getDocs, resolveDocPath } from './docs.mjs';
import { listSessions, capturePane, sendPrompt, SESSION_NAME_RE } from './tmux.mjs';
import {
  isSchedulerAvailable, createJob, listJobs, cancelJob,
  createPrompt, listPrompts, deletePrompt, markPromptUsed
} from './schedule.mjs';
import { getGitInsights } from './git.mjs';
import { getClaudeUsage, getCodexUsage } from './usage.mjs';
import { getUsageHistory } from './usage-history.mjs';
import { getBdVersionInfo } from './bdversion.mjs';

// Create-dialog "intents" that can carry an opt-in default epic (see
// `defaultEpics` in POST/GET /api/settings below). Deliberately excludes
// 'epic' itself — the create dialog hides the epic/parent picker entirely
// for that intent, so it has nothing to default.
const DEFAULT_EPIC_INTENTS = ['bug', 'feature', 'task', 'idea', 'chore'];

// POST /api/p/<id>/doc bodies can be up to ~1.5MB (content capped at 1MB,
// the rest is JSON/path overhead) — every other write route stays capped at
// the default below. See readBody()'s maxBytes param.
const DOC_BODY_MAX_BYTES = 1.5 * 1024 * 1024;
const DOC_CONTENT_MAX_BYTES = 1024 * 1024;

// POST /api/formula-file carries file content too — same reasoning, smaller
// ceiling (a formula is a step list; 256KB of it is already absurd, and
// lib/bd.mjs caps the content itself at FORMULA_CONTENT_MAX_BYTES).
const FORMULA_BODY_MAX_BYTES = 512 * 1024;

// A distill needs an epic that actually HAS children: `bd mol distill` on a
// childless bead succeeds and writes a 0-step formula (verified on v1.1.0),
// which lists fine and pours a lone empty root. Counted from the export rather
// than asked of bd, since the parent-child row is right there.
async function childCount(ctx, id) {
  const issues = await getIssues(ctx);
  return issues.filter((i) => (i.dependencies || []).some(
    (d) => d && d.type === 'parent-child' && d.depends_on_id === id,
  )).length;
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff'
};

function sendJson(res, status, data) {
  // APIs must never be cached by a fronting CDN/proxy either — stale JSON is
  // subtler than a stale UI but just as wrong.
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

// --- asset stamp -------------------------------------------------------------
// A fingerprint of the public/ tree (paths + mtimes + sizes), computed once at
// boot. It is (a) injected into index.html and app.js as they leave the origin
// (replacing __BD_STAMP__) and (b) reported live on /api/meta. A client whose
// baked-in stamp differs from the live one is, by construction, running a
// cached copy — the frontend uses that to surface a "stale cache" banner
// (see verifyAssetFreshness in public/app.js).
function computeAssetStamp(dir) {
  const h = createHash('sha1');
  const walk = (d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try { const s = statSync(full); h.update(`${full}:${Math.round(s.mtimeMs)}:${s.size}\n`); } catch { /* skip */ }
      }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 12);
}
const ASSET_STAMP = computeAssetStamp(PUBLIC_DIR);
const STAMPED_FILES = new Set(['index.html', 'app.js']);

async function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  if (name.includes('..')) { res.writeHead(403); return res.end('forbidden'); }
  const full = join(PUBLIC_DIR, name);
  if (!existsSync(full)) { res.writeHead(404); return res.end('not found'); }
  let body = await readFile(full);
  if (STAMPED_FILES.has(name)) {
    body = body.toString('utf8').replaceAll('__BD_STAMP__', ASSET_STAMP);
  }
  res.writeHead(200, {
    'content-type': MIME[extname(full)] || 'application/octet-stream',
    // no-store, not no-cache: no-cache permits stores that revalidate, and this
    // server has no ETag/Last-Modified support — behind a CDN/reverse proxy
    // (Cloudflare + Pangolin deployments) that combination served a stale UI
    // for hours after an update. Assets are ~2MB total; recaching is cheap.
    'cache-control': 'no-store'
  });
  res.end(body);
}

function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolveP, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      try { resolveP(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function isLocalOnlyHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// getContext: routes /api/p/<projectId>/... to the registered workspace,
// resolving per-workspace docRoots from bd-console.json (docRoots only —
// host/port/token no longer come from here).
function getContext(reqPath) {
  let workspace = null;
  let routedPath = reqPath;
  let projectId = null;

  if (reqPath.startsWith('/api/p/')) {
    const parts = reqPath.split('/');
    projectId = parts[3];
    const reg = loadRegistry();
    if (reg.projects[projectId]) {
      workspace = reg.projects[projectId].path;
      routedPath = '/api/' + parts.slice(4).join('/');
    }
  }

  if (!workspace) return null;

  const c = loadWorkspaceConfig(workspace);
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

export function createRequestHandler({ host, port, token, argsHost = null, argsPort = null }) {
  function authed(req, url) {
    if (!token) return true;
    return req.headers['x-bd-token'] === token || url.searchParams.get('token') === token;
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

    if (!token && !isLocalOnlyHost(host)) warnings.push('Writes are open on a non-localhost bind.');

    const status = errors.length ? 'err' : warnings.length ? 'warn' : 'ok';
    return {
      status,
      bdVersion,
      docsMode: ctx.configDocRoots ? `configured (${ctx.configDocRoots.join(', ')})` : 'auto-discovered',
      errors,
      warnings
    };
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const originalPath = url.pathname;

      if (originalPath === '/api/projects') {
        const reg = loadRegistry();
        if (url.searchParams.get('git') === '1') {
          const entries = await Promise.all(Object.entries(reg.projects).map(async ([id, p]) => {
            const gitInsights = await getGitInsights(p.path);
            return [id, { ...p, git: gitInsights }];
          }));
          return sendJson(res, 200, { projects: Object.fromEntries(entries) });
        }
        return sendJson(res, 200, { projects: reg.projects });
      }

      // ---- settings (hub-level; read is ungated, write is token-gated) ------
      // `defaultEpics` is the WHOLE map (every registered project's entry),
      // not just the requesting project's — the Settings page's "Default
      // epics" card lets a user pick and edit ANY registered project from a
      // single hub-level view, so it needs the full map up front rather than
      // one project scoped at a time. Shape: { <projectId>: { bug|feature|
      // task|idea|chore: <epicId|null> } }.
      if (originalPath === '/api/settings' && req.method === 'GET') {
        const s = resolveSettings({ argsHost, argsPort });
        const tokenSet = !!s.token;
        return sendJson(res, 200, {
          settings: {
            host: { value: s.host, source: s.sources.host },
            port: { value: s.port, source: s.sources.port },
            persist: { value: s.persist, source: s.sources.persist },
            token: {
              set: tokenSet,
              masked: tokenSet ? `${String(s.token).slice(0, 4)}…` : null,
              source: s.sources.token
            }
          },
          defaultEpics: s.globalConfig.defaultEpics || {},
          configPath: CONFIG_PATH,
          note: "host, port, and persist are CLI-only — use 'bd-console settings'. Token changes here take effect after a restart: bd-console start."
        });
      }

      if (originalPath === '/api/settings' && req.method === 'POST') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });

        const ALLOWED_KEYS = ['token', 'defaultEpics'];
        const extraKeys = Object.keys(body).filter((k) => !ALLOWED_KEYS.includes(k));
        if (extraKeys.length) {
          return sendJson(res, 400, {
            error: `only 'token' and 'defaultEpics' can be changed over HTTP (got: ${extraKeys.join(', ')}) — use 'bd-console settings' for host/port/persist`
          });
        }
        if (!('token' in body) && !('defaultEpics' in body)) {
          return sendJson(res, 400, { error: "body must contain 'token' and/or 'defaultEpics'" });
        }

        let restartRequired = false;

        if ('token' in body) {
          if (body.token === null) {
            saveGlobalConfig({}, ['token']);
          } else {
            const t = String(body.token ?? '');
            if (!t) return sendJson(res, 400, { error: 'token must be a non-empty string, or null to clear' });
            saveGlobalConfig({ token: t });
          }
          restartRequired = true;
        }

        if ('defaultEpics' in body) {
          const patch = body.defaultEpics;
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            return sendJson(res, 400, { error: 'defaultEpics must be an object keyed by project id' });
          }
          const current = loadGlobalConfig().defaultEpics || {};
          const merged = { ...current };
          for (const [pid, intents] of Object.entries(patch)) {
            if (!intents || typeof intents !== 'object' || Array.isArray(intents)) {
              return sendJson(res, 400, { error: `defaultEpics.${pid} must be an object` });
            }
            const badIntents = Object.keys(intents).filter((k) => !DEFAULT_EPIC_INTENTS.includes(k));
            if (badIntents.length) {
              return sendJson(res, 400, { error: `defaultEpics.${pid} has unknown intent(s): ${badIntents.join(', ')} (expected: ${DEFAULT_EPIC_INTENTS.join(', ')})` });
            }
            const mergedProject = { ...(merged[pid] || {}) };
            for (const [intentKey, epicId] of Object.entries(intents)) {
              if (epicId === null || epicId === '') { mergedProject[intentKey] = null; continue; }
              const idStr = String(epicId).trim();
              if (!ID_RE.test(idStr)) return sendJson(res, 400, { error: `defaultEpics.${pid}.${intentKey} is not a valid epic id` });
              mergedProject[intentKey] = idStr;
            }
            merged[pid] = mergedProject;
          }
          saveGlobalConfig({ defaultEpics: merged });
        }

        return sendJson(res, 200, { ok: true, restartRequired });
      }

      // ---- saved prompts (hub-level, not project-scoped) ---------------------
      if (originalPath === '/api/prompts' && req.method === 'GET') {
        if (!(await isSchedulerAvailable())) return sendJson(res, 501, { error: 'prompts require Node >= 22' });
        return sendJson(res, 200, { prompts: await listPrompts() });
      }

      if (originalPath === '/api/prompts' && req.method === 'POST') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        if (!(await isSchedulerAvailable())) return sendJson(res, 501, { error: 'prompts require Node >= 22' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });
        const result = await createPrompt(body);
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        return sendJson(res, 200, { ok: true, id: result.id });
      }

      if (originalPath === '/api/prompts/delete' && req.method === 'POST') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        if (!(await isSchedulerAvailable())) return sendJson(res, 501, { error: 'prompts require Node >= 22' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });
        const result = await deletePrompt(body.id);
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        return sendJson(res, 200, { ok: true });
      }

      if (originalPath === '/api/prompts/used' && req.method === 'POST') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        if (!(await isSchedulerAvailable())) return sendJson(res, 501, { error: 'prompts require Node >= 22' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });
        const result = await markPromptUsed(body.id);
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        return sendJson(res, 200, { ok: true });
      }

      // ---- tmux sessions (hub-level, not project-scoped) --------------------
      if (originalPath === '/api/tmux' && req.method === 'GET') {
        return sendJson(res, 200, await listSessions());
      }

      if (originalPath === '/api/tmux/preview' && req.method === 'GET') {
        // Pane contents can hold secrets — gate the same way writes are gated.
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        const session = url.searchParams.get('session') || '';
        if (!SESSION_NAME_RE.test(session)) return sendJson(res, 400, { error: 'bad session name' });
        const linesParam = url.searchParams.get('lines');
        const lines = linesParam ? Number(linesParam) : 120;
        const text = await capturePane(session, Number.isFinite(lines) && lines > 0 ? lines : 120);
        return sendJson(res, 200, { text });
      }

      if (originalPath === '/api/tmux/send' && req.method === 'POST') {
        // Types text + Enter into an EXISTING interactive session right now
        // (the scheduler's immediate cousin). Same gate as all writes.
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });
        const session = String(body.session || '');
        const text = String(body.text || '');
        if (!SESSION_NAME_RE.test(session)) return sendJson(res, 400, { error: 'bad session name' });
        if (!text.trim()) return sendJson(res, 400, { error: 'empty text' });
        const result = await sendPrompt(session, text);
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        return sendJson(res, 200, { ok: true });
      }

      // ---- provider usage (hub-level, not project-scoped) -------------------
      // Account-revealing (plan tier, quota utilization) — gated the same way
      // /api/tmux/preview is: only when a write token is configured.
      if (originalPath === '/api/usage' && req.method === 'GET') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        const [claude, codex] = await Promise.all([getClaudeUsage(), getCodexUsage()]);
        return sendJson(res, 200, { providers: { claude, codex } });
      }

      // Historical token-usage aggregation (transcript/session mining) —
      // same account-revealing gate as /api/usage.
      if (originalPath === '/api/usage/history' && req.method === 'GET') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        // getUsageHistory() does its own default (30) + clamp (1..90); a
        // missing/blank/non-numeric `days` param falls through to its default.
        const history = await getUsageHistory({ days: url.searchParams.get('days') });
        return sendJson(res, 200, history);
      }

      // ---- bd (beads CLI) version check (hub-level, not project-scoped) ----
      // Read-only, but it surfaces filesystem paths (every `bd` binary found
      // on the daemon's PATH) — host-detail-revealing the same way a tmux
      // pane preview or provider usage plan/tier is, so it's gated the same
      // way: authed() only requires a token when one is configured, matching
      // /api/usage and /api/tmux/preview rather than the always-open project
      // data endpoints.
      if (originalPath === '/api/bd-version' && req.method === 'GET') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        const force = url.searchParams.get('refresh') === '1';
        return sendJson(res, 200, await getBdVersionInfo({ force }));
      }

      // ---- prompt scheduler (hub-level, not project-scoped) -----------------
      if (originalPath === '/api/schedule' && req.method === 'GET') {
        if (!(await isSchedulerAvailable())) return sendJson(res, 501, { error: 'scheduler requires Node >= 22' });
        return sendJson(res, 200, { jobs: await listJobs({ includeDone: true }) });
      }

      if (originalPath === '/api/schedule' && req.method === 'POST') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        if (!(await isSchedulerAvailable())) return sendJson(res, 501, { error: 'scheduler requires Node >= 22' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });
        const result = await createJob(body);
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        return sendJson(res, 200, { ok: true, job: result.job });
      }

      if (originalPath === '/api/schedule/cancel' && req.method === 'POST') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        if (!(await isSchedulerAvailable())) return sendJson(res, 501, { error: 'scheduler requires Node >= 22' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });
        const result = await cancelJob(body.id);
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        return sendJson(res, 200, { ok: true, job: result.job });
      }

      if (originalPath.startsWith('/api/')) {
        const ctx = getContext(originalPath);
        if (!ctx && originalPath !== '/api/meta') {
          return sendJson(res, 404, { error: 'project not found' });
        }

        const path = ctx ? ctx.routedPath : originalPath;

        if (path === '/api/meta') {
          if (!ctx) {
            // Hub root meta. `pid` is used by the daemon-lifecycle code
            // (lib/daemon.mjs) to identify and, if needed, take over a
            // process that's holding this port during `bd-console start`.
            return sendJson(res, 200, { mode: 'hub', host, port, hostname: hostname(), pid: process.pid, writable: true, tokenRequired: !!token, assetStamp: ASSET_STAMP });
          }
          const exportInfo = await getExportInfo(ctx);
          const health = await computeHealth(ctx);
          return sendJson(res, 200, {
            mode: 'hub',
            projectId: ctx.projectId,
            workspace: ctx.workspace,
            name: basename(ctx.workspace),
            host,
            port,
            hostname: hostname(),
            writable: true,
            tokenRequired: !!token,
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
        if (path === '/api/doc' && req.method === 'GET') {
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
        if (path === '/api/git') {
          return sendJson(res, 200, { git: await getGitInsights(ctx.workspace) });
        }
        if (path === '/api/epics') {
          const issues = await getIssues(ctx);
          const epics = issues
            .filter((i) => i.issue_type === 'epic' && i.status !== 'closed')
            .map((i) => ({ id: i.id, title: i.title, status: i.status }));
          return sendJson(res, 200, { epics });
        }

        // ---- formulas & molecules (docs/molecules-design.md) ---------------
        //
        // DEVIATION from that doc's §4, deliberate: it proposed the two
        // DRY-RUN previews as ungated POSTs ("POST because the var map can be
        // large, not because it mutates"). They are GETs here instead. The
        // reason is one line below in this file — `if (req.method === 'POST')
        // { if (!authed(...)) 401 }` gates EVERY post uniformly, and carving a
        // documented-safe exception into that block trades a real invariant
        // ("no POST reaches bd without a token") for a query-string length
        // limit that a handful of short `--var` values will never approach.
        // Reads stay ungated GETs, writes stay gated POSTs, no exceptions.
        if (req.method === 'GET') {
          if (path === '/api/formulas') {
            const result = await listFormulas(ctx, url.searchParams.get('type') || null);
            return sendJson(res, result.ok ? 200 : result.status, result.ok ? { formulas: result.formulas } : { error: result.error });
          }

          // ---- formula AUTHORING reads (bd-console-9it) ------------------
          // Flat paths, deliberately NOT nested under /api/formulas/: that
          // segment is matched by the `([^/]+)` formula-name pattern below,
          // and FORMULA_NAME_RE happily accepts words like "files", so a
          // nested spelling would be one careless reorder away from being
          // read as a formula named "files".
          if (path === '/api/formula-files') {
            const { dir, files } = await listFormulaFiles(ctx);
            // Where the files live, said in project-relative terms. An
            // absolute host path is no use to a browser and describes the
            // server's layout — same posture as cleanBdError's scrubbing.
            const rel = relative(ctx.workspace, dir);
            return sendJson(res, 200, {
              dir: rel && !rel.startsWith('..') ? rel : basename(dir),
              files,
            });
          }

          if (path === '/api/formula-file') {
            const result = await readFormulaFile(ctx, url.searchParams.get('name') || '');
            return sendJson(res, result.ok ? 200 : result.status, result.ok
              ? { name: result.name, formula: result.formula, content: result.content, mtime: result.mtime }
              : { error: result.error });
          }

          // The distill dry-run. A read (it writes nothing), so a GET, for
          // exactly the reason spelled out above the formula block: every
          // POST is token-gated without exception, and previews are reads.
          if (path === '/api/formula-distill-preview') {
            const epic = String(url.searchParams.get('epic') || '');
            const name = String(url.searchParams.get('name') || '');
            if (!ID_RE.test(epic)) return sendJson(res, 400, { error: 'bad epic id' });
            // `bd mol distill` does NOT sanitize this argument — `../evil`
            // writes outside the formulas dir. This check is the only thing
            // standing between a URL and that.
            if (!FORMULA_NAME_RE.test(name)) return sendJson(res, 400, { error: 'bad formula name' });
            const norm = normalizeVars(varsFromQuery(url));
            if (!norm.ok) return sendJson(res, 400, { error: norm.error });
            const result = await distillPreview(ctx, epic, name, norm.pairs);
            return sendJson(res, result.ok ? 200 : result.status, result.ok
              ? { ok: true, preview: result.preview, command: result.command, file: formulaFileName(name) }
              : { error: result.error, command: result.command });
          }

          // /api/formulas/<name> and /api/formulas/<name>/preview
          const fm = /^\/api\/formulas\/([^/]+)(\/preview)?$/.exec(path);
          if (fm) {
            let name;
            try { name = decodeURIComponent(fm[1]); } catch { return sendJson(res, 400, { error: 'bad formula name' }); }
            if (!FORMULA_NAME_RE.test(name)) return sendJson(res, 400, { error: 'bad formula name' });
            if (!fm[2]) {
              const result = await showFormula(ctx, name);
              return sendJson(res, result.ok ? 200 : result.status, result.ok ? { formula: result.formula } : { error: result.error });
            }
            const norm = normalizeVars(varsFromQuery(url));
            if (!norm.ok) return sendJson(res, 400, { error: norm.error });
            const result = await previewFormula(ctx, name, norm.pairs);
            return sendJson(res, result.ok ? 200 : result.status, result.ok
              ? { preview: result.preview, mode: result.mode, command: result.command }
              : { error: result.error, command: result.command });
          }

          // Dry runs first: `pour-preview`/`burn-preview` would otherwise be
          // swallowed by the /api/molecules/<id> pattern (ID_RE permits
          // hyphens, so they read as plausible bead ids).
          if (path === '/api/molecules/pour-preview') {
            const proto = String(url.searchParams.get('proto') || '');
            if (!PROTO_RE.test(proto)) return sendJson(res, 400, { error: 'bad proto (formula name or bead id)' });
            const norm = normalizeVars(varsFromQuery(url));
            if (!norm.ok) return sendJson(res, 400, { error: norm.error });
            const result = await pourPreview(ctx, proto, norm.pairs);
            return sendJson(res, result.ok ? 200 : result.status, result.ok
              ? { ok: true, preview: result.preview, command: result.command }
              : { error: result.error, command: result.command });
          }
          if (path === '/api/molecules/burn-preview') {
            const id = String(url.searchParams.get('id') || '');
            if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });
            const result = await burnPreview(ctx, id);
            return sendJson(res, result.ok ? 200 : result.status, result.ok
              ? { ok: true, preview: result.preview, command: result.command }
              : { error: result.error, command: result.command });
          }

          const mm = /^\/api\/molecules\/([^/]+)$/.exec(path);
          if (mm) {
            let id;
            try { id = decodeURIComponent(mm[1]); } catch { return sendJson(res, 400, { error: 'bad id' }); }
            if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });
            const result = await showMolecule(ctx, id, { parallel: url.searchParams.get('parallel') === '1' });
            return sendJson(res, result.ok ? 200 : result.status, result.ok
              ? { molecule: result.molecule, progress: result.progress, parallel: result.parallel }
              : { error: result.error });
          }
        }

        // ---- writes (token-gated when a token is configured) ----
        if (req.method === 'POST') {
          if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
          // /api/doc bodies carry file content, so they get a raised cap
          // (DOC_BODY_MAX_BYTES) — every other write route keeps the default
          // 256KB ceiling.
          const bodyMax = path === '/api/doc' ? DOC_BODY_MAX_BYTES
            : path === '/api/formula-file' ? FORMULA_BODY_MAX_BYTES : undefined;
          const body = await readBody(req, bodyMax).catch(() => null);
          if (!body) return sendJson(res, 400, { error: 'bad body' });

          if (path === '/api/doc') {
            const reqPath = String(body.path || '');
            const full = resolveDocPath(ctx, reqPath);
            if (!full) return sendJson(res, 400, { error: 'invalid doc path' });

            if (typeof body.content !== 'string') return sendJson(res, 400, { error: 'content must be a string' });
            if (Buffer.byteLength(body.content, 'utf8') > DOC_CONTENT_MAX_BYTES) {
              return sendJson(res, 400, { error: 'content exceeds 1MB limit' });
            }

            const parentDir = dirname(full);
            if (!existsSync(parentDir)) return sendJson(res, 400, { error: 'parent directory does not exist' });

            const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
            try {
              await writeFile(tmp, body.content, 'utf8');
              await rename(tmp, full);
            } catch (e) {
              return sendJson(res, 500, { error: `failed to write doc: ${e.message}` });
            }
            const st = await stat(full);
            return sendJson(res, 200, { ok: true, path: reqPath, mtime: st.mtimeMs });
          }

          // ---- formula AUTHORING writes (bd-console-9it) ------------------
          //
          // The whole point of these two routes is that the pour flow's
          // prerequisite could not previously be produced anywhere in the
          // product. Both are ordinary token-gated POSTs; neither creates a
          // single bead — they create one FILE in the project's formulas
          // directory, which the Molecules dialog then lists.
          if (path === '/api/formula-file') {
            const name = String(body.name || '');
            if (typeof body.content !== 'string') return sendJson(res, 400, { error: 'content must be a string' });
            if (Buffer.byteLength(body.content, 'utf8') > FORMULA_CONTENT_MAX_BYTES) {
              return sendJson(res, 400, { error: `content exceeds ${Math.round(FORMULA_CONTENT_MAX_BYTES / 1024)}KB limit` });
            }
            // writeFormulaFile VALIDATES BEFORE IT WRITES (bd cook against a
            // copy in the OS temp dir) — a malformed formula is not written at
            // all, because bd's own `formula list` would silently skip it and
            // the user would be left with a recipe that had simply vanished.
            const result = await writeFormulaFile(ctx, name, body.content, { overwrite: body.overwrite !== false });
            if (!result.ok) return sendJson(res, result.status, { error: result.error });
            return sendJson(res, 200, {
              ok: true, name: result.name, formula: result.formula, steps: result.steps, mtime: result.mtime,
            });
          }

          if (path === '/api/formula-distill') {
            const epic = String(body.epic || '').trim();
            const name = String(body.name || '').trim();
            if (!ID_RE.test(epic)) return sendJson(res, 400, { error: 'bad epic id' });
            if (!FORMULA_NAME_RE.test(name)) return sendJson(res, 400, { error: 'bad formula name' });
            const norm = normalizeVars(body.vars);
            if (!norm.ok) return sendJson(res, 400, { error: norm.error });
            if ((await childCount(ctx, epic)) === 0) {
              return sendJson(res, 400, { error: `${epic} has no children — there is no structure to save as a template yet` });
            }
            // Distill silently OVERWRITES a formula of the same name, so the
            // clobber is opt-in here and the UI has to say what it is
            // replacing before it can set the flag.
            if (body.overwrite !== true) {
              const existing = await readFormulaFile(ctx, formulaFileName(name));
              if (existing.ok) return sendJson(res, 409, { error: `a formula named "${name}" already exists`, file: formulaFileName(name) });
            }
            const result = await distillEpic(ctx, epic, name, norm.pairs);
            if (!result.ok) return sendJson(res, result.status, { error: result.error, command: result.command });
            return sendJson(res, 200, {
              ok: true, formula: result.formula, file: result.file,
              steps: result.steps, variables: result.variables, command: result.command,
            });
          }

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

          if (path === '/api/create') {
            const title = String(body.title || '').trim();
            if (!title) return sendJson(res, 400, { error: 'title is required' });

            const type = body.type === undefined || body.type === null || body.type === ''
              ? 'task' : String(body.type);
            if (!CREATE_TYPES.includes(type)) {
              return sendJson(res, 400, { error: `type must be one of ${CREATE_TYPES.join(', ')}` });
            }

            const priority = body.priority === undefined || body.priority === null || body.priority === ''
              ? 3 : Number(body.priority);
            if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
              return sendJson(res, 400, { error: 'priority must be an integer 0-4' });
            }

            const labels = [];
            if (body.labels !== undefined && body.labels !== null) {
              if (!Array.isArray(body.labels)) return sendJson(res, 400, { error: 'labels must be an array' });
              for (const raw of body.labels) {
                const label = String(raw).trim();
                if (!LABEL_RE.test(label)) return sendJson(res, 400, { error: `bad label: ${label}` });
                labels.push(label);
              }
            }

            let parent = null;
            if (body.parent !== undefined && body.parent !== null && String(body.parent).trim() !== '') {
              parent = String(body.parent).trim();
              if (!ID_RE.test(parent)) return sendJson(res, 400, { error: 'bad parent id' });
            }

            let assignee = null;
            if (body.assignee !== undefined && body.assignee !== null && String(body.assignee).trim() !== '') {
              assignee = String(body.assignee).trim().replace(/[^A-Za-z0-9._@-]/g, '');
              if (!assignee || !ASSIGNEE_RE.test(assignee)) return sendJson(res, 400, { error: 'bad assignee' });
            }

            const args = ['create', '--silent', `--type=${type}`, '-p', String(priority)];
            if (labels.length) args.push('--labels', labels.join(','));
            args.push('--title', title);
            if (body.description) args.push('-d', String(body.description));
            if (body.acceptance) args.push('--acceptance', String(body.acceptance));
            if (body.design) args.push('--design', String(body.design));
            if (body.notes) args.push('--notes', String(body.notes));
            if (parent) args.push('--parent', parent);
            if (assignee) args.push('-a', assignee);

            const r = await bd(ctx, args);
            if (!r.ok) return sendJson(res, 500, { error: r.stderr || 'bd create failed' });
            const id = (r.stdout || '').trim();
            const exportInfo = await ensureIssuesExportFresh(ctx, { force: true });
            if (!exportInfo.ok) return sendJson(res, 500, { error: exportInfo.error, id, export: exportInfo });
            return sendJson(res, 200, { ok: true, id, export: exportInfo, issue: await getIssueById(ctx, id) });
          }

          if (path === '/api/edit') {
            const result = await runIssueEdit(ctx, body);
            return sendJson(res, result.status, result.ok ? result : { error: result.error, export: result.export });
          }

          // The one true write in the molecule feature area, and the only
          // route in this file that can create many beads in one call. Gated
          // by the shared authed() check above like every other POST; the UI
          // additionally requires the user to have seen `mol pour --dry-run`'s
          // itemized preview first (that gate is structural, not enforceable
          // here — a scripted client can obviously POST straight to it, which
          // is fine: it's the same authority `bd mol pour` itself needs).
          if (path === '/api/molecules/pour') {
            const proto = String(body.proto || '').trim();
            if (!PROTO_RE.test(proto)) return sendJson(res, 400, { error: 'bad proto (formula name or bead id)' });
            const norm = normalizeVars(body.vars);
            if (!norm.ok) return sendJson(res, 400, { error: norm.error });
            let assignee = null;
            if (body.assignee !== undefined && body.assignee !== null && String(body.assignee).trim() !== '') {
              assignee = String(body.assignee).trim();
              if (!ASSIGNEE_RE.test(assignee)) return sendJson(res, 400, { error: 'bad assignee' });
            }
            const result = await pourMolecule(ctx, proto, norm.pairs, { assignee });
            if (!result.ok) {
              // A failed pour still reports what (if anything) landed — see
              // pourMolecule()'s header on the partial-failure posture.
              return sendJson(res, result.status, { error: result.error, command: result.command, partial: result.partial });
            }
            return sendJson(res, 200, {
              ok: true,
              created: result.created,
              new_epic_id: result.new_epic_id,
              id_mapping: result.id_mapping,
              phase: result.phase,
              attached: result.attached,
              observedCount: result.observedCount,
              missing: result.missing,
              warning: result.warning,
              command: result.command,
              export: result.export,
            });
          }

          if (path === '/api/molecules/burn') {
            const id = String(body.id || '').trim();
            if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });
            const result = await burnMolecule(ctx, id);
            if (!result.ok) return sendJson(res, result.status, { error: result.error, command: result.command });
            return sendJson(res, 200, {
              ok: true,
              deleted: result.deleted,
              deleted_count: result.deleted_count,
              dependencies_removed: result.dependencies_removed,
              orphaned_issues: result.orphaned_issues,
              command: result.command,
              export: result.export,
            });
          }

          return sendJson(res, 404, { error: 'unknown endpoint' });
        }
      }

      return serveStatic(res, originalPath);
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message || err) });
    }
  };
}
