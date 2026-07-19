// lib/routes.mjs — the hub HTTP request handler: getContext (registry ->
// per-project workspace), all /api routes, and static serving from public/.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';

import { loadRegistry } from './registry.mjs';
import { loadWorkspaceConfig } from './config.mjs';
import {
  bd, getIssues, getIssueById, getExportInfo, ensureIssuesExportFresh,
  runIssueEdit, ID_RE, LABEL_RE
} from './bd.mjs';

// Types accepted by POST /api/p/<id>/create. `bd create` supports a couple
// more (decision, event, ...) but the create UI only ever offers these five.
const CREATE_TYPES = ['task', 'bug', 'feature', 'epic', 'chore'];
const ASSIGNEE_RE = /^[A-Za-z0-9._@-]+$/;
import { getDocs, resolveDocPath } from './docs.mjs';
import { listSessions, capturePane, SESSION_NAME_RE } from './tmux.mjs';
import { isSchedulerAvailable, createJob, listJobs, cancelJob } from './schedule.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

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

export function createRequestHandler({ host, port, token }) {
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
        return sendJson(res, 200, { projects: reg.projects });
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
            return sendJson(res, 200, { mode: 'hub', host, port, hostname: hostname(), pid: process.pid, writable: true, tokenRequired: !!token });
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
        if (path === '/api/epics') {
          const issues = await getIssues(ctx);
          const epics = issues
            .filter((i) => i.issue_type === 'epic' && i.status !== 'closed')
            .map((i) => ({ id: i.id, title: i.title, status: i.status }));
          return sendJson(res, 200, { epics });
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

          return sendJson(res, 404, { error: 'unknown endpoint' });
        }
      }

      return serveStatic(res, originalPath);
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message || err) });
    }
  };
}
