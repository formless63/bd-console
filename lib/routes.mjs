// lib/routes.mjs — the hub HTTP request handler: getContext (registry ->
// per-project workspace), all /api routes, and static serving from public/.
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';

import { loadRegistry, registerProjectPath } from './registry.mjs';
import {
  loadWorkspaceConfig, loadGlobalConfig, resolveSettings, saveGlobalConfig,
  TERMIX_KEYS, normalizeTermixBaseUrl, validateTermixToken, validateTermixHostId,
  resolveTermix, saveTermixConfig,
} from './config.mjs';
import { decorateSessionsWithTermix, fetchTermixHosts, looksLikeTermixApiKey } from './termix.mjs';
import { CONFIG_PATH } from './paths.mjs';
import {
  bd, getIssues, getIssueById, getExportInfo, ensureIssuesExportFresh,
  runIssueEdit, runIssueBatch, BATCH_MAX_OPS, ID_RE, LABEL_RE, ASSIGNEE_RE,
  FORMULA_NAME_RE, PROTO_RE, normalizeVars,
  listFormulas, showFormula, previewFormula,
  showMolecule, pourPreview, pourMolecule, burnPreview, burnMolecule,
  FORMULA_CONTENT_MAX_BYTES, formulaFileName,
  listFormulaFiles, readFormulaFile, writeFormulaFile,
  distillPreview, distillEpic,
  listGates, resolveGate, getIssueHistory, getCachedLintOrphanCounts,
} from './bd.mjs';
import { emit as emitChange, subscribe as subscribeEvents } from './events.mjs';
// The blocker derivation the BROWSER uses, imported rather than re-implemented.
// public/ui/relationships.js is deliberately dependency-free "so it can be
// imported unchanged by the browser AND by Node" (its own header), and
// GET /api/p/<id>/stats has to produce the same blocked/ready numbers the client
// derives from the full issue list — a mirrored copy of that rule in lib/ is
// exactly the drift this project already guards against for LINK_TYPES.
import { blockersOf } from '../public/ui/relationships.js';

// Types accepted by POST /api/p/<id>/create. `bd create` supports a couple
// more (decision, event, ...) but the create UI only ever offers these five.
const CREATE_TYPES = ['task', 'bug', 'feature', 'epic', 'chore'];

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
  isSchedulerAvailable, createJob, listJobs, cancelJob, retryJob,
  createPrompt, listPrompts, deletePrompt, markPromptUsed
} from './schedule.mjs';
import { getGitInsights } from './git.mjs';
import { getClaudeUsage, getCodexUsage, getKimiUsage, getGeminiUsage } from './usage.mjs';
import { getUsageHistory } from './usage-history.mjs';
import { getBdVersionInfo } from './bdversion.mjs';
import { getCliVersions } from './cliversions.mjs';

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

function sendJson(res, status, data, extraHeaders = null) {
  // APIs must never be cached by a fronting CDN/proxy either — stale JSON is
  // subtler than a stale UI but just as wrong.
  //
  // `extraHeaders` exists for exactly one caller: GET /api/p/<id>/issues, which
  // serves an ETag and therefore has to say `no-cache` (revalidate every time)
  // instead of `no-store` (never store, so never revalidate — an ETag on a
  // no-store response is decoration). Every other route keeps no-store; see
  // the issues route for the full reasoning.
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(data));
}

// The issue export's identity as a strong validator: mtime + size, the same
// pair getIssues() memoizes on. Null when there is no export to validate.
function exportEtag(exportInfo) {
  if (!exportInfo || !exportInfo.exists || !exportInfo.exportedAt) return null;
  return `"${Math.round(exportInfo.exportedAt)}-${exportInfo.size ?? 0}"`;
}

// If-None-Match is a comma-separated list, entries may be weak-prefixed, and
// `*` matches anything that exists.
function ifNoneMatchSatisfied(header, etag) {
  if (!header || !etag) return false;
  const tags = String(header).split(',').map((t) => t.trim());
  if (tags.includes('*')) return true;
  return tags.some((t) => t.replace(/^W\//, '') === etag);
}

// Per-project summary for the hub's cards, computed here so a card costs one
// small JSON instead of the whole issue list (bd-console-974.3).
//
// The tallies MIRROR loadProjectStats() in public/ui/store.js — same key names,
// same "open means open-and-unblocked" convention, same blocked derivation via
// an open-blocker scan — so a card fed by this route and a card fed by the
// client-side fallback cannot show different numbers. Two additions the client
// version doesn't have:
//   * `deferred` — `bd update --defer` sets status 'deferred' (plus a
//     defer_until); the client's tally silently dropped that status because it
//     only incremented keys that already existed on the object.
//   * `ready` — the explicit "pickable right now" count: open, no OPEN blocker,
//     and not parked behind a future defer date.
// An issue left at status 'open' with a future defer_until (bd's older shape,
// still handled by glyphStatus() in public/ui/console2/ui.js) counts as
// deferred here too, so the two spellings of "deferred" can't disagree.
function computeStats(issues) {
  const t = {
    open: 0, in_progress: 0, blocked: 0, closed: 0, deferred: 0,
    ready: 0, total: issues.length, openTotal: 0, triage: 0, closed7d: 0, openBugs: 0,
  };
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 86400000;
  const openIds = new Set(issues.filter((i) => i.status !== 'closed').map((i) => i.id));

  for (const i of issues) {
    if (i.status !== 'closed') {
      t.openTotal++;
      if ((i.labels || []).includes('triage')) t.triage++;
      if (i.issue_type === 'bug') t.openBugs++;
    }

    const blocked = i.status === 'open' && blockersOf(i).some((b) => openIds.has(b));
    const deferred = i.status === 'deferred'
      || (i.status === 'open' && !blocked && !!i.defer_until && new Date(i.defer_until).getTime() > now);

    // Blocked outranks deferred, which outranks plain open — the same
    // precedence the Flow lanes use (public/ui/console2/derive.js).
    const eff = i.status === 'closed' ? 'closed'
      : i.status === 'in_progress' ? 'in_progress'
        : blocked ? 'blocked'
          : deferred ? 'deferred'
            : i.status === 'open' ? 'open' : null;
    if (eff && t[eff] != null) t[eff]++;
    if (eff === 'open') t.ready++;

    if (i.status === 'closed') {
      const ts = i.closed_at ? new Date(i.closed_at).getTime()
        : (i.updated_at ? new Date(i.updated_at).getTime() : 0);
      if (ts && ts >= sevenDaysAgo) t.closed7d++;
    }
  }
  return t;
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

// Chunks are collected as BUFFERS and decoded once at the end. Decoding each
// chunk on arrival (`data += c`) stringifies it in isolation, so a multi-byte
// UTF-8 sequence split across a chunk boundary — which is where the socket
// happens to fill, not where characters end — decodes to U+FFFD on both sides.
// Any body over one socket read (an emoji in a long doc, a pasted description)
// could arrive corrupted. The size cap still counts BYTES, before decoding.
function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolveP, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
      try { resolveP(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
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

// `bd version` result, cached PROCESS-WIDE (bd-console-974.3). computeHealth()
// spawned it on every GET /api/p/<id>/meta — one process spawn per project card
// per poll, for a string that changes when someone upgrades the binary.
//
// Process-wide rather than per-project because the answer is a property of the
// `bd` on the daemon's PATH, not of the workspace; ctx only supplies the cwd.
// lib/bdversion.mjs is NOT reused here even though it caches: its cache covers
// the GitHub "latest release" lookup, not the local spawn (it re-runs `bd
// version` on every call and also enumerates every bd on PATH), so it is the
// more expensive answer to a smaller question.
//
// A FAILURE is cached far more briefly than a success: "bd isn't on the PATH"
// is the one health verdict a user actively fixes, and the dashboard should
// notice within seconds of them fixing it, not within five minutes.
const BD_VERSION_TTL_MS = 5 * 60 * 1000;
const BD_VERSION_ERR_TTL_MS = 30 * 1000;
let bdVersionCache = null; // { at, ttl, result }

async function cachedBdVersion(ctx) {
  const now = Date.now();
  if (bdVersionCache && (now - bdVersionCache.at) < bdVersionCache.ttl) return bdVersionCache.result;
  const result = await bd(ctx, ['version']);
  bdVersionCache = { at: now, ttl: result.ok ? BD_VERSION_TTL_MS : BD_VERSION_ERR_TTL_MS, result };
  return result;
}

export function createRequestHandler({ host, port, token, argsHost = null, argsPort = null }) {
  function authed(req, url) {
    if (!token) return true;
    return req.headers['x-bd-token'] === token || url.searchParams.get('token') === token;
  }

  // computeHealth(ctx, exportInfo): `exportInfo` is passed IN because its only
  // caller (GET /api/p/<id>/meta) already has it — this function used to fetch
  // its own, so every meta request stat'ed the same two files twice.
  async function computeHealth(ctx, exportInfo) {
    const warnings = [];
    const errors = [];
    let bdVersion = null;
    const version = await cachedBdVersion(ctx);
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

    if (!exportInfo.exists) warnings.push('Issue export is missing; the server will attempt to regenerate it.');
    else if (exportInfo.stale) warnings.push('Issue export is stale; the server will refresh it on demand.');

    if (!token && !isLocalOnlyHost(host)) warnings.push('Writes are open on a non-localhost bind.');

    // Lint/orphans nudges (bd-console-974.8) — see getCachedLintOrphanCounts's
    // header for the caching contract. NEVER awaited: this call either returns
    // the last-known counts immediately or kicks a background refresh for the
    // NEXT call, so a slow `bd lint`/`bd orphans` can't add latency to /meta.
    // null counts (no background refresh has landed yet, or this bd predates
    // the command) are silently skipped rather than asserted as "0".
    const nudges = getCachedLintOrphanCounts(ctx);
    if (nudges) {
      if (Number.isFinite(nudges.lintCount) && nudges.lintCount > 0) {
        warnings.push(`${nudges.lintCount} open issue${nudges.lintCount === 1 ? '' : 's'} missing recommended sections (bd lint)`);
      }
      if (Number.isFinite(nudges.orphanCount) && nudges.orphanCount > 0) {
        warnings.push(`${nudges.orphanCount} orphaned issue${nudges.orphanCount === 1 ? '' : 's'} — referenced in commits but still open (bd orphans)`);
      }
    }

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

      // ---- the SSE change feed (bd-console-974.3) --------------------------
      // "Something changed" for the whole hub, so no view has to poll to find
      // out. Contract, frozen because the browser is built against it:
      //   event: hello   data {"ts":<ms>}                        (on connect)
      //   event: change  data {"kind":"issues","project":"<id>","ts":<ms>}
      //   event: change  data {"kind":"schedule","ts":<ms>}
      //   : hb                                                    (every 25s)
      // Everything else — the client set, the debounce, the mtime sweeper —
      // lives in lib/events.mjs. Gated exactly like the other read routes
      // (i.e. not at all unless a token is configured): it carries project ids
      // and timestamps, which /api/projects already serves ungated.
      if (originalPath === '/api/events' && req.method === 'GET') {
        return subscribeEvents(req, res);
      }

      if (originalPath === '/api/projects') {
        const reg = loadRegistry();
        // `missing: true` for a registered directory that is no longer there
        // (renamed, unmounted, deleted). Without it the hub renders a card
        // whose every read fails for unexplained reasons; the UI can now say
        // "directory gone" and offer to unregister. One existsSync per entry,
        // on a handful of entries, on a route the hub polls — cheap enough
        // that the honest answer is worth more than the saved syscall.
        const decorate = ([id, p]) => [id, { ...p, missing: !existsSync(p.path) }];
        if (url.searchParams.get('git') === '1') {
          const entries = await Promise.all(Object.entries(reg.projects).map(async ([id, p]) => {
            const gitInsights = await getGitInsights(p.path);
            return decorate([id, { ...p, git: gitInsights }]);
          }));
          return sendJson(res, 200, { projects: Object.fromEntries(entries) });
        }
        return sendJson(res, 200, { projects: Object.fromEntries(Object.entries(reg.projects).map(decorate)) });
      }

      // Register a project from the UI — the browser-side `bd-console add`
      // (bd-console-uwq). The hub's empty state was previously a dead end for
      // anyone who wasn't already at a terminal on the host.
      //
      // Gated by authed(), the same gate /api/usage, /api/schedule and
      // /api/bd-version use — NOT loopback-only. This dashboard is reached
      // remotely through Cloudflare -> auth proxy -> tunnel, so a loopback
      // check would lock the actual user out of the one feature that exists
      // for them. All validation (and the reasoning about what a rejection is
      // allowed to reveal) lives in registerProjectPath(); nothing here shells
      // out with the caller's path.
      if (originalPath === '/api/register' && req.method === 'POST') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });
        const result = registerProjectPath(body.path);
        if (!result.ok) return sendJson(res, result.status, { error: result.error });
        return sendJson(res, 200, { ok: true, id: result.id, path: result.path });
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
        const termix = resolveTermix(s.globalConfig);
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
          // Termix linkage — the stored address, host id and credential. The
          // token follows the write token's treatment exactly:
          // set/masked-prefix/source, never the value; the browser composes
          // nothing from it and never sees it. `apiKeyShaped` reports whether
          // the stored credential matches Termix's API-key format, so Settings
          // can warn about a pasted JWT without dialling anything to find out.
          termix: {
            baseUrl: { value: termix.baseUrl, source: termix.sources.baseUrl },
            hostId: { value: termix.hostId, source: termix.sources.hostId },
            token: {
              set: !!termix.token,
              masked: termix.token ? `${String(termix.token).slice(0, 4)}…` : null,
              source: termix.sources.token,
              apiKeyShaped: termix.token ? looksLikeTermixApiKey(termix.token) : null
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

        const ALLOWED_KEYS = ['token', 'defaultEpics', 'termix'];
        const extraKeys = Object.keys(body).filter((k) => !ALLOWED_KEYS.includes(k));
        if (extraKeys.length) {
          return sendJson(res, 400, {
            error: `only 'token', 'defaultEpics' and 'termix' can be changed over HTTP (got: ${extraKeys.join(', ')}) — use 'bd-console settings' for host/port/persist`
          });
        }
        if (!ALLOWED_KEYS.some((k) => k in body)) {
          return sendJson(res, 400, { error: "body must contain 'token', 'defaultEpics' and/or 'termix'" });
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

        // Termix: address, host id and credential storage. Omitted sub-keys
        // are left alone; an explicit null/'' clears one. Nothing is restarted
        // and — importantly — nothing is contacted: saving a base URL does not
        // check whether a Termix answers there. The only request bd-console
        // ever makes is GET /api/termix/hosts below, on an explicit click.
        if ('termix' in body) {
          const t = body.termix;
          if (!t || typeof t !== 'object' || Array.isArray(t)) {
            return sendJson(res, 400, { error: 'termix must be an object' });
          }
          const badTermixKeys = Object.keys(t).filter((k) => !TERMIX_KEYS.includes(k));
          if (badTermixKeys.length) {
            return sendJson(res, 400, { error: `termix has unknown key(s): ${badTermixKeys.join(', ')} (expected: ${TERMIX_KEYS.join(', ')})` });
          }
          if (!TERMIX_KEYS.some((k) => k in t)) {
            return sendJson(res, 400, { error: `termix must contain at least one of: ${TERMIX_KEYS.join(', ')}` });
          }
          const termixPatch = {};
          const termixUnset = [];
          try {
            for (const key of TERMIX_KEYS) {
              if (!(key in t)) continue;
              if (t[key] === null || t[key] === '') { termixUnset.push(key); continue; }
              if (key === 'baseUrl') termixPatch[key] = normalizeTermixBaseUrl(t[key]);
              else if (key === 'hostId') termixPatch[key] = validateTermixHostId(t[key]);
              else termixPatch[key] = validateTermixToken(t[key]);
            }
          } catch (e) {
            return sendJson(res, 400, { error: e.message });
          }
          saveTermixConfig(termixPatch, termixUnset);
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
      // Each session is decorated with its Termix deep link (bd-console-4w7)
      // when — and only when — Termix is configured. Composing server-side is
      // what keeps the API key out of the browser entirely: the link carries a
      // host id and a session name, never a credential, and all three
      // consumers (hub grid, tmux cards, Console 2.0 rail) render the same
      // object instead of each deriving a URL of its own.
      //
      // The payload also carries process health (bd-console-oic/xo8): each
      // session gets `memory` (resident bytes for its whole process subtree,
      // a level and the sentence explaining it) and `idle` (non-null only for
      // a session nobody has touched in days whose processes are still using
      // CPU), plus a top-level `host.memory` block with the machine's
      // available memory, swap and agent share. All of it is ADDITIVE and all
      // of it is absent — not zero, not an error — on a host where it can't be
      // measured. Deliberately NOT token-gated, like the rest of this route:
      // it exposes byte counts and executable basenames, no argv and no pane
      // contents (those stay behind the gate on /api/tmux/preview).
      if (originalPath === '/api/tmux' && req.method === 'GET') {
        return sendJson(res, 200, decorateSessionsWithTermix(await listSessions(), resolveTermix()));
      }

      // ---- Termix host lookup ------------------------------------------------
      // The ONLY route in bd-console that makes an outbound request to a
      // user-supplied address, and it exists for exactly one reason: the deep
      // link needs Termix's integer id for this machine, and making someone go
      // spelunking for it is how a feature ends up unused. Reached solely by
      // clicking "Look up hosts" in Settings — nothing polls it.
      //
      // Token-gated like every write, even though it reads: it spends the
      // stored credential and returns an inventory of the user's machines
      // (names, IPs, usernames). Failures come back as a 502 + prose from
      // lib/termix.mjs, never a 500, because "your Termix is unreachable" is a
      // normal answer here, not a bug.
      if (originalPath === '/api/termix/hosts' && req.method === 'GET') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        const termix = resolveTermix();
        if (!termix.baseUrl) return sendJson(res, 400, { error: 'Termix base URL is not set — save it first' });
        if (!termix.token) return sendJson(res, 400, { error: 'Termix API token is not set — save it first' });
        const result = await fetchTermixHosts({ baseUrl: termix.baseUrl, token: termix.token });
        if (!result.ok) return sendJson(res, 502, { error: result.error });
        return sendJson(res, 200, { hosts: result.hosts, hostId: termix.hostId });
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
        const result = await sendPrompt(session, text, { force: body.force === true });
        // A server-mode refusal is a DIFFERENT failure from "no such session"
        // or "tmux errored": the request was well-formed and the target
        // exists, it just isn't listening. 409 + the verdict + the name of the
        // override, so the UI can explain it and offer "send anyway" rather
        // than showing a dead-end 400. See sendPrompt()'s refusal policy.
        if (!result.ok && result.refused) {
          return sendJson(res, 409, {
            error: result.error,
            refused: true,
            agent: result.verdict?.agent ?? null,
            mode: result.verdict?.mode ?? null,
            reason: result.verdict?.reason || '',
            override: 'force'
          });
        }
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        return sendJson(res, 200, { ok: true });
      }

      // ---- provider usage (hub-level, not project-scoped) -------------------
      // Account-revealing (plan tier, quota utilization) — gated the same way
      // /api/tmux/preview is: only when a write token is configured.
      if (originalPath === '/api/usage' && req.method === 'GET') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        // ?fresh=1 = "a human pressed ↻". It lets the Claude adapter bypass a
        // warm cache entry; it is NOT a way around the 429 backoff or the
        // minimum interval between fresh calls — see getClaudeUsage().
        const fresh = url.searchParams.get('fresh') === '1';
        // kimi and gemini are stack-info providers, not quota ones (neither
        // Kimi Code nor the Antigravity CLI publishes rate-limit data anywhere)
        // — they ride along here because they answer the same "what is this
        // machine's AI stack doing right now" question the hub's Live-quota
        // card asks, and both degrade to `not-installed` on machines without
        // them, exactly like codex does.
        const [claude, codex, kimi, gemini] = await Promise.all([
          getClaudeUsage({ fresh }), getCodexUsage(), getKimiUsage(), getGeminiUsage()
        ]);
        return sendJson(res, 200, { providers: { claude, codex, kimi, gemini } });
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
      // data endpoints. /api/cli-versions is the same check for the Claude
      // Code and Codex CLIs (lib/cliversions.mjs) and is gated identically,
      // for the identical reason.
      if (originalPath === '/api/bd-version' && req.method === 'GET') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        const force = url.searchParams.get('refresh') === '1';
        return sendJson(res, 200, await getBdVersionInfo({ force }));
      }

      if (originalPath === '/api/cli-versions' && req.method === 'GET') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        const force = url.searchParams.get('refresh') === '1';
        return sendJson(res, 200, await getCliVersions({ force }));
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
        // The schedule kind carries no project: jobs are hub-level. A tick that
        // fires (or fails) a job emits from lib/schedule.mjs itself, so an open
        // Schedule view sees the transition without polling for it.
        emitChange('schedule');
        return sendJson(res, 200, { ok: true, job: result.job });
      }

      if (originalPath === '/api/schedule/cancel' && req.method === 'POST') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        if (!(await isSchedulerAvailable())) return sendJson(res, 501, { error: 'scheduler requires Node >= 22' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });
        const result = await cancelJob(body.id);
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        emitChange('schedule');
        return sendJson(res, 200, { ok: true, job: result.job });
      }

      // Re-arm a failed (or cancelled) job. `runAt` is required on purpose —
      // see retryJob()'s header: a failed job's stored run_at is in the past,
      // so reusing it would fire the prompt into a live session on the very
      // next tick. `session` optionally retargets the job when the original
      // one is gone; `sessionLive` reports whether the target exists right
      // now so the UI can warn without this route ever creating a session.
      if (originalPath === '/api/schedule/retry' && req.method === 'POST') {
        if (!authed(req, url)) return sendJson(res, 401, { error: 'token required' });
        if (!(await isSchedulerAvailable())) return sendJson(res, 501, { error: 'scheduler requires Node >= 22' });
        const body = await readBody(req).catch(() => null);
        if (!body) return sendJson(res, 400, { error: 'bad body' });
        const result = await retryJob(body.id, { runAt: body.runAt, session: body.session });
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        emitChange('schedule');
        return sendJson(res, 200, { ok: true, job: result.job, sessionLive: result.sessionLive });
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
          const health = await computeHealth(ctx, exportInfo);
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
            // The raw docRoots (null when auto-discovering) — the "New doc"
            // folder picker needs to know which folders a write could even
            // land in, and health.docsMode below is a human sentence, not a
            // list. Authority still sits in resolveDocPath(); this is UX.
            docRoots: ctx.configDocRoots,
            export: exportInfo,
            health
          });
        }

        if (!ctx) return sendJson(res, 400, { error: 'missing context' });

        // The one route that revalidates instead of never storing. It is by far
        // the largest payload the dashboard fetches (this project's own export
        // is ~1MB of JSONL), every open tab re-fetches it on every change
        // event, and its content is a pure function of the export file — so a
        // strong validator built from that file's mtime+size turns the common
        // "nothing moved since I last asked" case into a 304 with no body.
        //
        // `no-cache` (store, but always revalidate), NOT the `no-store` every
        // other route sends: no-store forbids the stored copy that a
        // conditional request exists to revalidate, which would make the ETag
        // decorative. The stale-UI incident that put `no-store` on the static
        // assets (see serveStatic) does not apply — a revalidated response is
        // never served stale.
        if (path === '/api/issues') {
          const exportInfo = await ensureIssuesExportFresh(ctx, { force: url.searchParams.get('refresh') === '1' });
          if (!exportInfo.ok) return sendJson(res, 500, { error: exportInfo.error, export: exportInfo });
          const etag = exportEtag(exportInfo);
          if (etag && ifNoneMatchSatisfied(req.headers['if-none-match'], etag)) {
            res.writeHead(304, { etag, 'cache-control': 'no-cache' });
            return res.end();
          }
          return sendJson(res, 200,
            { issues: await getIssues(ctx), generatedAt: Date.now(), export: exportInfo },
            etag ? { etag, 'cache-control': 'no-cache' } : null);
        }

        // Per-project card numbers without the issue list (bd-console-974.3).
        // The hub used to download every issue of every registered project just
        // to render five counts per card; this is the same arithmetic done once,
        // server-side, over the memoized export. Deliberately does NOT force an
        // export refresh — it is a card, polled and change-driven, and
        // `export.stale` tells the caller if it's looking at old numbers.
        if (path === '/api/stats') {
          const exportInfo = await getExportInfo(ctx);
          const stats = computeStats(await getIssues(ctx));
          return sendJson(res, 200, {
            ...stats,
            // The export's mtime, not "now": these numbers are exactly as old
            // as the file they came from, and saying otherwise would let a
            // stale card look fresh.
            generatedAt: exportInfo.exportedAt,
            export: exportInfo,
          });
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

        // ---- gates (bd-console-974.8) — `bd gate list --json`. Ungated read,
        // same posture as /api/comments and /api/epics above: gate reasons and
        // await types are issue content, not host/credential detail. 501 when
        // the installed bd predates `bd gate` (see lib/bd.mjs's listGates).
        if (path === '/api/gates') {
          const result = await listGates(ctx);
          return sendJson(res, result.ok ? 200 : result.status, result.ok ? { gates: result.gates } : { error: result.error });
        }

        // Per-issue history — `bd history <id> --json`. `?issue=<id>` rather
        // than a path segment: keeps this alongside /api/comments's `?id=`
        // convention instead of colliding with the /api/molecules/<id>-style
        // path patterns matched below.
        if (path === '/api/history') {
          const id = String(url.searchParams.get('issue') || '').trim();
          if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });
          const limitParam = url.searchParams.get('limit');
          const limit = limitParam && /^\d+$/.test(limitParam) ? Number(limitParam) : null;
          const result = await getIssueHistory(ctx, id, { limit });
          return sendJson(res, result.ok ? 200 : result.status, result.ok ? { history: result.history } : { error: result.error });
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

            // `create: true` marks the "New doc" flow (bd-console-09n). Same
            // route, same path validation — the flag only forbids landing on
            // an existing file, so a mistyped name in the new-doc dialog can
            // never silently overwrite somebody's document.
            if (body.create === true && existsSync(full)) {
              return sendJson(res, 409, { error: 'a document already exists at that path' });
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

          // Resolve a gate — `bd gate resolve <id> [--reason …]`. Same
          // authed() gate every other write in this block already passed;
          // resolveGate() itself forces the export (a resolved gate's status
          // flips from open->closed, and the issue it was blocking may become
          // ready) and reports it back the same way /api/edit does.
          if (path === '/api/gates/resolve') {
            const id = String(body.id || '').trim();
            if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });
            const result = await resolveGate(ctx, id, body.reason ? String(body.reason) : null);
            if (!result.ok) return sendJson(res, result.status, { error: result.error });
            emitChange('issues', ctx.projectId);
            return sendJson(res, 200, { ok: true, export: result.export });
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
            // Announce AFTER the forced export, never before: the event tells
            // every listener to re-read the export, so firing it while the file
            // still holds the pre-write state would hand them the old data and
            // no second chance. Every write route below follows the same order.
            // (lib/events.mjs's mtime sweeper would catch these within 2s
            // anyway — this is what makes it feel instant, and what lets the
            // sweeper stay coarse.)
            emitChange('issues', ctx.projectId);
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

            // Validate, never sanitize. This used to strip disallowed
            // characters and then test the remains, which meant "alice smith"
            // was silently filed under "alicesmith" — an assignee the user
            // never typed and will never search for. The pour path below and
            // the set-assignee edit op both reject outright; all three now go
            // through the one ASSIGNEE_RE in lib/bd.mjs so the rule cannot
            // drift between "who gets it at creation" and "who gets it after".
            let assignee = null;
            if (body.assignee !== undefined && body.assignee !== null && String(body.assignee).trim() !== '') {
              assignee = String(body.assignee).trim();
              if (!ASSIGNEE_RE.test(assignee)) return sendJson(res, 400, { error: 'bad assignee' });
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
            emitChange('issues', ctx.projectId);
            return sendJson(res, 200, { ok: true, id, export: exportInfo, issue: await getIssueById(ctx, id) });
          }

          if (path === '/api/edit') {
            const result = await runIssueEdit(ctx, body);
            // runIssueEdit forces the export itself before returning ok.
            if (result.ok) emitChange('issues', ctx.projectId);
            return sendJson(res, result.status, result.ok ? result : { error: result.error, export: result.export });
          }

          // Bulk edit (bd-console-974.5) — N ops, the SAME op vocabulary and
          // the same validation as /api/edit above (runIssueBatch and
          // runIssueEdit share one applyIssueEdit; there is no second copy of
          // any rule), one forced export and one change event for the lot.
          //
          // Gating: nothing special. It is a POST under the project router, so
          // it already passed the same authed() check every other write above
          // did — a batch is N edits the caller was individually entitled to
          // make, not a new authority.
          if (path === '/api/batch') {
            const result = await runIssueBatch(ctx, body.ops);
            // Emitted once, AFTER the single forced export, exactly like the
            // single-op routes — and on partial failure too, because the ops
            // that DID land are real changes every listener needs to see.
            if (result.changed) emitChange('issues', ctx.projectId);
            if (!result.ok) {
              return sendJson(res, result.status, {
                error: result.error, export: result.export,
                // Present only when ops actually ran (an export failure) —
                // a validation reject has nothing per-op to report.
                ...(result.results ? { results: result.results, failed: result.failed } : {}),
                max: BATCH_MAX_OPS,
              });
            }
            return sendJson(res, 200, {
              ok: true,
              results: result.results,
              failed: result.failed,
              applied: result.applied,
              export: result.export,
            });
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
              // pourMolecule()'s header on the partial-failure posture. A
              // PARTIAL failure did create beads, so it is still a change.
              if (result.partial) emitChange('issues', ctx.projectId);
              return sendJson(res, result.status, { error: result.error, command: result.command, partial: result.partial });
            }
            emitChange('issues', ctx.projectId);
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
            emitChange('issues', ctx.projectId);
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
      // /api/events writes its headers the moment it is subscribed, so a later
      // throw can no longer be turned into a 500 — writing one would throw
      // again ("headers already sent") and take the whole handler with it.
      if (res.headersSent) { try { res.end(); } catch { /* already gone */ } return; }
      sendJson(res, 500, { error: String(err?.message || err) });
    }
  };
}
