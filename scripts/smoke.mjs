#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { createServer } from 'node:http';
import { renderServiceUnit } from '../lib/systemd.mjs';
// Pure frontend derivation, importable in Node — see public/ui/relationships.js
import {
  blockersOf, blockedByIssue, dependenciesByType, relatedTo, linkSections,
  supersededBy, duplicateOf, supersedes, duplicatedBy, retiredState,
  LINK_TYPES as UI_LINK_TYPES,
  CONTAINER_TYPES, isContainer, isMolecule, containerGroups,
  moleculeRootOf, moleculeRollup,
} from '../public/ui/relationships.js';
// Pure MapView edge-model derivation (docs/beads-coverage.md Phase 2) — see
// public/ui/console2/graphModel.js's header for why it's signal-free and
// therefore importable here exactly like relationships.js above.
import { buildGraph, mapScopeIssues } from '../public/ui/console2/graphModel.js';
import { docGroup, groupDocs, starterDocs } from '../public/ui/console2/docsModel.js';
// "New doc" derivations (bd-console-09n) — same import-free contract as
// relationships.js above; docCreate.js's own header calls this out by name.
import { newDocName, newDocPath, docFolders, newDocProblem, newDocTemplate } from '../public/ui/docCreate.js';
// Pure formula derivations (docs/molecules-design.md) — same import-free
// contract as relationships.js above.
import {
  formulaVars, pourBeadCount, missingVars, previewMode, previewVars,
  varViolations, previewIssueCount, burnIssueCount,
  stepNeeds, slugifyFormulaName, slugifyVarName, distillCandidates,
  newFormulaTemplate, formulaSaveProblem, formulaStem, formulaFileName,
} from '../public/ui/formulas.js';
// Progressive-discoverability engine (public/ui/learn.js) — same import-free
// contract as relationships.js above, precisely so its lifecycle rules ("shows
// once, dismissal is permanent, doing the thing retires the hint") are
// assertable here rather than only observable by clicking around a browser.
import {
  createLearnStore, learnContext, CONCEPTS, CONCEPT_GROUPS, HINTS, concept,
  conceptHref, isLearnHash, learnAnchorFromHash, LEARN_KEY,
} from '../public/ui/learn.js';
// Hash router (public/ui/routing.js) — pure and import-free for the same
// reason relationships.js is: store.js's parseHash() is signal-bound and can't
// be loaded in Node, but the retired-route redirect it wraps has to be
// asserted somewhere other than a browser.
import { legacyProjectHash, parseRoute } from '../public/ui/routing.js';
import { LINK_TYPES as SERVER_LINK_TYPES } from '../lib/bd.mjs';
import { parseScopedLimits, getClaudeUsage } from '../lib/usage.mjs';
import { parseBdVersionStdout, compareVersions, isBehind } from '../lib/bdversion.mjs';
import { parseCliVersionStdout } from '../lib/cliversions.mjs';
// Pure tmux agent-type/promptability classifier (bd-console-2gs) — importable
// here because every I/O-shaped input (argv, kimi server pids) is gathered by
// its caller, so the rules can be asserted against fixtures with no tmux
// server, no /proc, and no live agents.
import { classifyPane } from '../lib/tmux.mjs';
// Termix deep-link composition (bd-console-4w7). Every export exercised below
// is pure string/shape work — no fetch, no Termix instance, no credential.
// fetchTermixHosts() is the module's one outbound function and is DELIBERATELY
// not called anywhere in this file: the whole point of splitting composition
// from transport is that the part users depend on can be proven offline.
import {
  termixAttachUrl, termixHomeUrl, termixLinkFor, decorateSessionsWithTermix,
  termixHostsUrl, normalizeTermixHosts, describeTermixFailure, looksLikeTermixApiKey,
} from '../lib/termix.mjs';
import { validateTermixHostId } from '../lib/config.mjs';
// Process/host health (bd-console-oic, bd-console-xo8). Same contract as
// classifyPane above: lib/tmux.mjs does the bounded /proc walking, everything
// imported here is pure — /proc TEXT in, verdicts out — so the OOM thresholds
// and the idle rules are pinned by fixtures rather than by whatever this
// machine happens to be doing while the suite runs.
import {
  parseMeminfo, parseStatm, parseProcStat, calibratePageSize,
  rollupProcesses, combineRollups, describeSessionMemory, memoryLevel,
  classifyHostMemory, createCpuTracker, idleVerdict, idleDaysSetting,
  fmtBytes, fmtDays, fmtCpuSeconds,
  SESSION_WARN_FRACTION, SESSION_CRIT_FRACTION,
  IDLE_DAYS_DEFAULT, IDLE_CPU_MIN_WINDOW_MS, IDLE_CPU_MAX_WINDOW_MS,
} from '../lib/health.mjs';

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options
  });
}

function trimLastLine(text) {
  return text.trim().split('\n').pop();
}

function getPort() {
  return new Promise((resolveP, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolveP(port)));
    });
  });
}

async function waitFor(url, tries = 50) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr || new Error(`Timed out waiting for ${url}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const tempRoot = mkdtempSync(join(tmpdir(), 'bd-console-smoke-'));
const repoDir = join(tempRoot, 'repo');
const configDir = join(tempRoot, 'config');
mkdirSync(repoDir, { recursive: true });

// Isolate the hub registry/config from the real ~/.config/bd-console.
// BD_CONSOLE_SCHED_INTERVAL shortens the scheduler's poll tick so the
// scheduler smoke tests below don't have to wait out the 15s production
// default.
const env = { ...process.env, BD_CONSOLE_CONFIG_DIR: configDir, BD_CONSOLE_SCHED_INTERVAL: '200' };

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// SIGTERM shutdown isn't instantaneous — give a stopped process a grace
// window before asserting it's gone.
async function waitForExit(pid, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}

let server;
let daemonPid; // tracked so `finally` can always clean it up, even on assertion failure
let firstRunPid; // ditto, for the non-TTY first-run daemon test

try {
  run('git', ['init'], { cwd: repoDir });
  run('git', ['config', 'user.name', 'bd-console smoke'], { cwd: repoDir });
  run('git', ['config', 'user.email', 'smoke@example.com'], { cwd: repoDir });

  writeFileSync(join(repoDir, 'README.md'), '# Smoke Repo\n\nThis is a smoke test.\n');
  mkdirSync(join(repoDir, 'docs'));
  writeFileSync(join(repoDir, 'docs', 'plan.md'), '# Plan\n\n- item\n');

  // A real commit so lib/git.mjs's getGitInsights() has a lastCommit to report.
  run('git', ['add', '-A'], { cwd: repoDir });
  run('git', ['commit', '-m', 'initial commit'], { cwd: repoDir });

  run('bd', ['init'], { cwd: repoDir });
  const seedId = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--labels', 'triage', '--title', 'Seed issue'], { cwd: repoDir }));
  run('bd', ['export', '-o', '.beads/issues.jsonl'], { cwd: repoDir });

  const initEntry = resolve(join(process.cwd(), 'scripts', 'init.mjs'));
  run(process.execPath, [initEntry, '--repo', repoDir, '--apply-agent-docs', '--create-missing-agent-docs'], { cwd: process.cwd(), env });
  assert(existsSync(join(repoDir, 'bd-console.json')), 'init did not create bd-console.json');
  const perRepoConfig = JSON.parse(readFileSync(join(repoDir, 'bd-console.json'), 'utf8'));
  assert(!('host' in perRepoConfig) && !('port' in perRepoConfig) && !('token' in perRepoConfig),
    'per-repo bd-console.json should be docRoots-only (host/port/token are global settings)');
  assert(!('docRoots' in perRepoConfig) || Array.isArray(perRepoConfig.docRoots),
    'init config docRoots, when present, must be an array');
  assert(readFileSync(join(repoDir, 'AGENTS.md'), 'utf8').includes('BEGIN BD-CONSOLE SETUP'), 'AGENTS.md missing bd-console setup block');
  assert(readFileSync(join(repoDir, 'CLAUDE.md'), 'utf8').includes('BEGIN BD-CONSOLE SETUP'), 'CLAUDE.md missing bd-console setup block');

  // init.mjs registers the repo with the hub via `serve.mjs add`; confirm it landed.
  const registryPath = join(configDir, 'registry.json');
  assert(existsSync(registryPath), 'init did not register the repo with the hub');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const projectId = Object.keys(registry.projects).find((id) => registry.projects[id].path === repoDir);
  assert(projectId, 'registry.json missing the initialized repo');

  const port = await getPort();
  const serverEntry = resolve(join(process.cwd(), 'serve.mjs'));
  server = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitFor(`http://127.0.0.1:${port}/api/meta`);

  const hubMeta = await fetch(`http://127.0.0.1:${port}/api/meta`).then((r) => r.json());
  assert(hubMeta.mode === 'hub', 'root /api/meta should report hub mode');

  const projects = await fetch(`http://127.0.0.1:${port}/api/projects`).then((r) => r.json());
  assert(projects.projects && projects.projects[projectId] && projects.projects[projectId].path === repoDir, '/api/projects missing registered repo');

  const p = (path) => `http://127.0.0.1:${port}/api/p/${projectId}${path}`;

  const meta = await fetch(p('/meta')).then((r) => r.json());
  assert(meta.name === 'repo', 'per-project meta name mismatch');

  const issues0 = await fetch(p('/issues')).then((r) => r.json());
  assert(Array.isArray(issues0.issues) && issues0.issues.some((i) => i.id === seedId), 'seed issue missing from /api/p/<id>/issues');

  const docs = await fetch(p('/docs')).then((r) => r.json());
  assert(docs.docs.some((d) => d.path === 'README.md'), 'top-level README missing from /api/p/<id>/docs');
  assert(docs.docs.some((d) => d.path === 'docs/plan.md'), 'nested doc missing from /api/p/<id>/docs');

  const doc = await fetch(p(`/doc?path=${encodeURIComponent('docs/plan.md')}`)).then((r) => r.json());
  assert(doc.content.includes('Plan'), '/api/p/<id>/doc returned unexpected content');

  const comments0 = await fetch(p(`/comments?id=${encodeURIComponent(seedId)}`)).then((r) => r.json());
  assert(Array.isArray(comments0.comments), '/api/p/<id>/comments did not return an array');

  const commentRes = await fetch(p('/comment'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, text: 'smoke comment' })
  }).then((r) => r.json());
  assert(commentRes.comments.some((c) => c.text === 'smoke comment'), 'comment write path failed');

  await fetch(p('/edit'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, op: 'claim' })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `edit claim failed (${r.status})`);
  });

  await fetch(p('/edit'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, op: 'set-priority', priority: '1' })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `edit priority failed (${r.status})`);
  });

  await fetch(p('/edit'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, op: 'add-label', label: 'smoke' })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `edit label failed (${r.status})`);
  });

  const issuesAfterEdit = await fetch(p('/issues')).then((r) => r.json());
  const edited = issuesAfterEdit.issues.find((i) => i.id === seedId);
  assert(edited && edited.priority === 1, 'priority edit did not persist');
  assert(edited && edited.status === 'in_progress', 'claim action did not persist');
  assert(edited && (edited.labels || []).includes('smoke'), 'label edit did not persist');

  const quickRes = await fetch(p('/quick'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Quick smoke issue', description: 'created by smoke', label: 'triage', priority: '3' })
  }).then((r) => r.json());
  assert(quickRes.id, 'quick capture did not return an issue id');

  const issues1 = await fetch(p('/issues')).then((r) => r.json());
  assert(issues1.issues.some((i) => i.id === quickRes.id), 'quick-captured issue missing after export refresh');

  // A request for an unregistered project should 404, not fall through.
  const unknown = await fetch(`http://127.0.0.1:${port}/api/p/does-not-exist/issues`);
  assert(unknown.status === 404, 'unknown project id should 404');

  // --- rich issue creation + epic targets (Feature 2) ------------------------
  const epicRes = await fetch(p('/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Smoke epic', type: 'epic' })
  }).then((r) => r.json());
  assert(epicRes.ok && epicRes.id, `create epic failed: ${JSON.stringify(epicRes)}`);
  assert(epicRes.issue && epicRes.issue.issue_type === 'epic', 'created epic issue_type mismatch');

  const childRes = await fetch(p('/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Smoke child bug',
      type: 'bug',
      priority: 1,
      labels: ['smoke', 'triage'],
      acceptance: 'it works',
      parent: epicRes.id
    })
  }).then((r) => r.json());
  assert(childRes.ok && childRes.id, `create child bug failed: ${JSON.stringify(childRes)}`);
  assert(childRes.issue.issue_type === 'bug', 'created child issue_type mismatch');
  assert(childRes.issue.priority === 1, 'created child priority mismatch');
  assert((childRes.issue.labels || []).includes('smoke') && (childRes.issue.labels || []).includes('triage'), 'created child labels mismatch');

  const epicsList = await fetch(p('/epics')).then((r) => r.json());
  assert(epicsList.epics.some((e) => e.id === epicRes.id), '/api/p/<id>/epics missing created epic');

  const badType = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'bad type', type: 'nonsense' })
  });
  assert(badType.status === 400, `bad type should 400, got ${badType.status}`);

  const badPriority = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'bad priority', priority: 9 })
  });
  assert(badPriority.status === 400, `bad priority should 400, got ${badPriority.status}`);

  const badParent = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'bad parent', parent: 'not a valid id!' })
  });
  assert(badParent.status === 400, `bad parent should 400, got ${badParent.status}`);

  // Create validates the assignee with the SAME ASSIGNEE_RE as the
  // set-assignee edit op — it must reject, not sanitize. This route used to
  // strip disallowed characters and keep the remains, so "alice smith" was
  // filed under "alicesmith": an assignee nobody typed and nobody can search
  // for. A 400 is the only honest answer.
  const badAssignee = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'bad assignee', assignee: 'alice smith' })
  });
  assert(badAssignee.status === 400, `create with a malformed assignee should 400, got ${badAssignee.status}`);
  const flagAssignee = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'flag assignee', assignee: '--json' })
  });
  assert(flagAssignee.status === 400, `create with a flag-shaped assignee should 400, got ${flagAssignee.status}`);
  const okAssignee = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'assigned at birth', assignee: 'ann-marie.o@example.com' })
  }).then((r) => r.json());
  assert(okAssignee.ok && okAssignee.issue.assignee === 'ann-marie.o@example.com',
    `create should keep a valid assignee verbatim, got ${JSON.stringify(okAssignee.issue && okAssignee.issue.assignee)}`);

  const noTitle = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '   ' })
  });
  assert(noTitle.status === 400, `empty title should 400, got ${noTitle.status}`);

  console.log(`smoke ok (create + epics): epic=${epicRes.id}, child=${childRes.id}`);

  // --- blocker DIRECTION regression guard -----------------------------------
  // `bd dep add A B` = "A depends on B" (B blocks A), stored as a row on A.
  // Reading that backwards inverted blocked/ready across the whole UI for
  // weeks (see docs/beads-coverage.md), so pin the invariant against a real
  // bd-created dependency rather than a hand-written fixture.
  const depA = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Dependent A'], { cwd: repoDir }));
  const depB = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Blocker B'], { cwd: repoDir }));
  run('bd', ['dep', 'add', depA, depB], { cwd: repoDir });
  run('bd', ['export', '-o', '.beads/issues.jsonl'], { cwd: repoDir });

  const relIssues = (await fetch(p('/issues')).then((r) => r.json())).issues;
  const issueA = relIssues.find((i) => i.id === depA);
  const issueB = relIssues.find((i) => i.id === depB);
  assert(issueA && issueB, 'dependency fixture issues missing from the export');
  assert(blockersOf(issueA).includes(depB),
    `blockersOf(A) must contain B (A depends on B); got ${JSON.stringify(blockersOf(issueA))}`);
  assert(blockersOf(issueB).length === 0,
    `blockersOf(B) must be empty (nothing blocks B); got ${JSON.stringify(blockersOf(issueB))}`);
  assert(blockedByIssue(depB, relIssues).includes(depA), 'blockedByIssue(B) must contain A');
  // parent-child must never count as a blocker
  assert(blockersOf(relIssues.find((i) => i.id === childRes.id) || {}).length === 0,
    'a parent-child row must not make a child look blocked');

  console.log(`smoke ok (blocker direction): ${depB} blocks ${depA}`);

  // --- link types: enum parity with the installed bd ------------------------
  // The frontend can't import lib/bd.mjs, so relationships.js mirrors its
  // LINK_TYPES. Pin BOTH copies to the enum the installed binary actually
  // prints, so a bd upgrade that changes the vocabulary fails loudly here
  // instead of producing a dropdown full of types bd will reject.
  const depAddHelp = run('bd', ['dep', 'add', '--help'], { cwd: repoDir });
  const enumMatch = depAddHelp.match(/Dependency type \(([^)]+)\)/);
  assert(enumMatch, 'could not parse the --type enum out of `bd dep add --help`');
  const cliLinkTypes = enumMatch[1].split('|').map((s) => s.trim()).filter(Boolean);
  assert(cliLinkTypes.length === 10, `expected 10 dep types from bd, got ${cliLinkTypes.length}: ${cliLinkTypes.join(',')}`);
  const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
  assert(sameSet(SERVER_LINK_TYPES, cliLinkTypes),
    `lib/bd.mjs LINK_TYPES drifted from \`bd dep add --help\`:\n  bd:  ${cliLinkTypes.join('|')}\n  lib: ${SERVER_LINK_TYPES.join('|')}`);
  assert(sameSet(UI_LINK_TYPES, SERVER_LINK_TYPES),
    `public/ui/relationships.js LINK_TYPES mirror drifted from lib/bd.mjs:\n  lib: ${SERVER_LINK_TYPES.join('|')}\n  ui:  ${UI_LINK_TYPES.join('|')}`);

  console.log(`smoke ok (link-type enum parity): ${cliLinkTypes.join('|')}`);

  // --- non-blocking link types must NOT read as blockers --------------------
  // The regression this pins: if `related`/`discovered-from` ever leak into
  // BLOCKING_DEP_TYPES (or blockersOf stops filtering by type), every issue
  // with a see-also link silently becomes phantom-blocked and drops out of
  // ready work. Created with the real CLI, not a hand-written fixture.
  const linkHub = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Link hub'], { cwd: repoDir }));
  const linkPeer = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Link peer'], { cwd: repoDir }));
  const linkOrigin = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Link origin'], { cwd: repoDir }));
  run('bd', ['dep', 'add', linkHub, linkPeer, '--type', 'related'], { cwd: repoDir });
  run('bd', ['dep', 'add', linkHub, linkOrigin, '--type', 'discovered-from'], { cwd: repoDir });
  run('bd', ['export', '-o', '.beads/issues.jsonl'], { cwd: repoDir });

  const linkIssues = (await fetch(p('/issues')).then((r) => r.json())).issues;
  const hubIssue = linkIssues.find((i) => i.id === linkHub);
  const peerIssue = linkIssues.find((i) => i.id === linkPeer);
  const originIssue = linkIssues.find((i) => i.id === linkOrigin);
  assert(hubIssue && peerIssue && originIssue, 'link fixture issues missing from the export');

  assert(dependenciesByType(hubIssue, 'related').includes(linkPeer),
    `dependenciesByType(hub,'related') must contain the peer; got ${JSON.stringify(dependenciesByType(hubIssue, 'related'))}`);
  assert(dependenciesByType(hubIssue, 'discovered-from').includes(linkOrigin),
    `dependenciesByType(hub,'discovered-from') must contain the origin; got ${JSON.stringify(dependenciesByType(hubIssue, 'discovered-from'))}`);

  // THE regression guard: neither link may make anything look blocked.
  assert(blockersOf(hubIssue).length === 0,
    `a related/discovered-from row must not make an issue blocked; blockersOf(hub) = ${JSON.stringify(blockersOf(hubIssue))}`);
  assert(blockersOf(peerIssue).length === 0, 'the related peer must not be blocked');
  assert(blockersOf(originIssue).length === 0, 'the discovered-from origin must not be blocked');
  assert(!blockedByIssue(linkPeer, linkIssues).includes(linkHub), 'a related row must not register as a blocks edge');

  // `related` is stored one-sided by `bd dep add --type related`, so the
  // bidirectional read has to find it from BOTH ends and dedupe.
  assert(relatedTo(hubIssue, linkIssues).includes(linkPeer), 'relatedTo(hub) must contain the peer (row lives on hub)');
  assert(relatedTo(peerIssue, linkIssues).includes(linkHub), 'relatedTo(peer) must contain the hub (row lives on the OTHER side)');
  assert(relatedTo(hubIssue, linkIssues).length === new Set(relatedTo(hubIssue, linkIssues)).size, 'relatedTo must dedupe');
  assert(!relatedTo(hubIssue, linkIssues).includes(linkHub), 'relatedTo must never include the issue itself');
  assert(!relatedTo(hubIssue, linkIssues).includes(linkOrigin), 'discovered-from must not be read as related');

  // Sections: outbound discovered-from on the hub, inbound on the origin.
  const hubSections = linkSections(hubIssue, linkIssues);
  assert(hubSections.some((s) => s.type === 'discovered-from' && s.dir === 'out' && s.ids.includes(linkOrigin)),
    `hub must expose an outbound discovered-from section; got ${JSON.stringify(hubSections.map((s) => s.key))}`);
  assert(!hubSections.some((s) => s.type === 'related'), 'related must not double-render as a generic section');
  const originSections = linkSections(originIssue, linkIssues);
  assert(originSections.some((s) => s.type === 'discovered-from' && s.dir === 'in' && s.ids.includes(linkHub)),
    `origin must expose an inbound discovered-from section; got ${JSON.stringify(originSections.map((s) => s.key))}`);
  assert(linkSections(peerIssue, linkIssues).length === 0, 'a peer with only a related edge needs no generic sections');

  console.log(`smoke ok (link types): related=${linkPeer}, discovered-from=${linkOrigin}, neither blocks ${linkHub}`);

  // --- add-link / remove-link over HTTP -------------------------------------
  const trackTarget = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Track target'], { cwd: repoDir }));
  const editJson = async (payload) => {
    const r = await fetch(p('/edit'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json() };
  };
  const issuesNow = async () => (await fetch(p('/issues')).then((r) => r.json())).issues;

  const addTracks = await editJson({ id: linkHub, op: 'add-link', other: trackTarget, type: 'tracks' });
  assert(addTracks.status === 200 && addTracks.body.ok, `add-link tracks failed: ${JSON.stringify(addTracks.body)}`);
  assert(addTracks.body.effect && addTracks.body.effect.kind === 'add-link' && addTracks.body.effect.type === 'tracks',
    `add-link must echo its effect; got ${JSON.stringify(addTracks.body.effect)}`);
  let hubAfter = (await issuesNow()).find((i) => i.id === linkHub);
  assert(dependenciesByType(hubAfter, 'tracks').includes(trackTarget), 'add-link tracks did not persist');
  assert(blockersOf(hubAfter).length === 0, 'a tracks link must not make the issue blocked');

  const rmTracks = await editJson({ id: linkHub, op: 'remove-link', other: trackTarget, type: 'tracks' });
  assert(rmTracks.status === 200 && rmTracks.body.ok, `remove-link failed: ${JSON.stringify(rmTracks.body)}`);
  hubAfter = (await issuesNow()).find((i) => i.id === linkHub);
  assert(!dependenciesByType(hubAfter, 'tracks').includes(trackTarget), 'remove-link did not remove the tracks row');

  // Back-compat: add-blocker/remove-blocker still work, still mean `blocks`.
  const legacyAdd = await editJson({ id: linkHub, op: 'add-blocker', blocker: trackTarget });
  assert(legacyAdd.status === 200 && legacyAdd.body.ok, `add-blocker back-compat broke: ${JSON.stringify(legacyAdd.body)}`);
  hubAfter = (await issuesNow()).find((i) => i.id === linkHub);
  assert(blockersOf(hubAfter).includes(trackTarget), 'add-blocker must still create a blocks edge');
  const legacyRm = await editJson({ id: linkHub, op: 'remove-blocker', blocker: trackTarget });
  assert(legacyRm.status === 200 && legacyRm.body.ok, `remove-blocker back-compat broke: ${JSON.stringify(legacyRm.body)}`);
  hubAfter = (await issuesNow()).find((i) => i.id === linkHub);
  assert(!blockersOf(hubAfter).includes(trackTarget), 'remove-blocker must still remove the blocks edge');

  // Injection/validation surface: nothing user-typed reaches --type.
  assert((await editJson({ id: linkHub, op: 'add-link', other: trackTarget, type: 'duplicates' })).status === 400,
    'add-link must reject `duplicates` (bd duplicate owns that edge)');
  assert((await editJson({ id: linkHub, op: 'add-link', other: trackTarget, type: '--dry-run' })).status === 400,
    'add-link must reject a flag-shaped type');
  assert((await editJson({ id: linkHub, op: 'add-link', other: '; rm -rf /', type: 'related' })).status === 400,
    'add-link must reject a non-ID target');
  assert((await editJson({ id: linkHub, op: 'add-link', other: linkHub, type: 'related' })).status === 400,
    'add-link must reject a self-link');

  console.log('smoke ok (add-link/remove-link + back-compat + validation)');

  // --- supersede / mark-duplicate round-trip --------------------------------
  const oldSpec = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Old spec'], { cwd: repoDir }));
  const newSpec = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'New spec'], { cwd: repoDir }));
  const sup = await editJson({ id: oldSpec, op: 'supersede', with: newSpec });
  assert(sup.status === 200 && sup.body.ok, `supersede failed: ${JSON.stringify(sup.body)}`);
  assert(sup.body.effect && sup.body.effect.kind === 'supersede' && sup.body.effect.autoClosed === true,
    `supersede must report its auto-close side effect; got ${JSON.stringify(sup.body.effect)}`);
  assert(String(sup.body.effect.message || '').includes(newSpec), 'supersede effect.message must name the replacement');
  assert(sup.body.issue && sup.body.issue.status === 'closed', 'supersede must leave the superseded issue closed');

  const dupIssue = trimLastLine(run('bd', ['create', '--silent', '--type', 'bug', '-p', '2', '--title', 'Dupe report'], { cwd: repoDir }));
  const canonical = trimLastLine(run('bd', ['create', '--silent', '--type', 'bug', '-p', '2', '--title', 'Canonical report'], { cwd: repoDir }));
  const dup = await editJson({ id: dupIssue, op: 'mark-duplicate', of: canonical });
  assert(dup.status === 200 && dup.body.ok, `mark-duplicate failed: ${JSON.stringify(dup.body)}`);
  assert(dup.body.effect && dup.body.effect.kind === 'mark-duplicate' && dup.body.effect.autoClosed === true,
    `mark-duplicate must report its auto-close side effect; got ${JSON.stringify(dup.body.effect)}`);
  assert(dup.body.issue && dup.body.issue.status === 'closed', 'mark-duplicate must leave the duplicate closed');

  const retiredIssues = await issuesNow();
  const oldIssue = retiredIssues.find((i) => i.id === oldSpec);
  const dupeIssueRec = retiredIssues.find((i) => i.id === dupIssue);
  // Ground truth (bd v1.1.0): the edge hangs off the RETIRED issue and points
  // at the survivor — `supersedes`/`duplicates` rows read "…by/of".
  assert(supersededBy(oldIssue) === newSpec, `supersededBy(old) must be the replacement; got ${supersededBy(oldIssue)}`);
  assert(duplicateOf(dupeIssueRec) === canonical, `duplicateOf(dupe) must be the canonical; got ${duplicateOf(dupeIssueRec)}`);
  assert(supersedes(newSpec, retiredIssues).includes(oldSpec), 'supersedes(new) must contain the retired issue');
  assert(duplicatedBy(canonical, retiredIssues).includes(dupIssue), 'duplicatedBy(canonical) must contain the duplicate');
  // Retired state must OUTRANK blocked/ready (banner precedence) and must
  // never be mistaken for a blocking edge.
  assert(retiredState(oldIssue)?.kind === 'superseded', 'retiredState must classify a supersedes row');
  assert(retiredState(dupeIssueRec)?.kind === 'duplicate', 'retiredState must classify a duplicates row');
  assert(retiredState(retiredIssues.find((i) => i.id === newSpec)) === null, 'the replacement itself is not retired');
  assert(blockersOf(oldIssue).length === 0, 'a supersedes row must not read as a blocker');
  assert(blockersOf(dupeIssueRec).length === 0, 'a duplicates row must not read as a blocker');
  // The banner owns the outbound edge, so it must not ALSO be a chip section.
  assert(!linkSections(oldIssue, retiredIssues).some((s) => s.dir === 'out' && s.type === 'supersedes'),
    'the supersede banner must not double-render as a section');
  assert(linkSections(retiredIssues.find((i) => i.id === newSpec), retiredIssues).some((s) => s.dir === 'in' && s.type === 'supersedes'),
    'the replacement must expose an inbound "Supersedes" section');

  assert((await editJson({ id: oldSpec, op: 'supersede', with: 'not a valid id!' })).status === 400, 'supersede must reject a bad replacement id');
  assert((await editJson({ id: oldSpec, op: 'supersede', with: oldSpec })).status === 400, 'supersede must reject superseding itself');
  assert((await editJson({ id: dupIssue, op: 'mark-duplicate', of: dupIssue })).status === 400, 'mark-duplicate must reject itself');

  console.log(`smoke ok (supersede/duplicate): ${oldSpec}→${newSpec}, ${dupIssue}→${canonical}`);

  // --- set-assignee: reassign AND clear -------------------------------------
  // The clear is the half that's easy to get wrong, so it is pinned against
  // the real binary: `bd update <id> --assignee ""` REMOVES the field (the key
  // disappears from the JSONL export) rather than setting it to "". If a
  // future bd changes that, this fails loudly instead of leaving a UI whose
  // "Clear" button silently does nothing.
  const owned = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Owned work', '-a', 'alice'], { cwd: repoDir }));
  const assigneeOf = async (issueId) => (await issuesNow()).find((i) => i.id === issueId)?.assignee;
  assert(await assigneeOf(owned) === 'alice', `fixture should start assigned to alice; got ${await assigneeOf(owned)}`);

  const reassign = await editJson({ id: owned, op: 'set-assignee', assignee: 'bob' });
  assert(reassign.status === 200 && reassign.body.ok, `set-assignee failed: ${JSON.stringify(reassign.body)}`);
  assert(await assigneeOf(owned) === 'bob', `reassign did not persist; got ${await assigneeOf(owned)}`);
  assert(reassign.body.issue && reassign.body.issue.assignee === 'bob', 'set-assignee must echo the updated issue');

  const unassign = await editJson({ id: owned, op: 'set-assignee', assignee: '' });
  assert(unassign.status === 200 && unassign.body.ok, `set-assignee (clear) failed: ${JSON.stringify(unassign.body)}`);
  const clearedAssignee = await assigneeOf(owned);
  assert(!clearedAssignee, `clearing must leave no assignee; got ${JSON.stringify(clearedAssignee)}`);
  assert(clearedAssignee !== '', 'bd must REMOVE the assignee, not set it to an empty string');

  // Clearing an already-unassigned issue is a no-op, not an error.
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: '' })).status === 200, 'clearing an unassigned issue should be idempotent');
  // An omitted `assignee` is the same as an explicit clear (String(undefined ?? '')).
  assert((await editJson({ id: owned, op: 'set-assignee' })).status === 200, 'set-assignee with no assignee field should clear, not 500');

  // Validation: nothing user-typed reaches the CLI unchecked. `--json` here is
  // the interesting one — bd's flag parser accepts it as a literal VALUE
  // (verified on v1.1.0), so without ASSIGNEE_RE it would become an assignee.
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: 'alice smith' })).status === 400, 'set-assignee must reject whitespace in a name');
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: '; rm -rf /' })).status === 400, 'set-assignee must reject shell metacharacters');
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: '--json' })).status === 400, 'set-assignee must reject a flag-shaped value');
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: '-a' })).status === 400, 'set-assignee must reject a short-flag-shaped value');
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: '-bob' })).status === 400, 'set-assignee must reject any leading hyphen');
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: 'a'.repeat(129) })).status === 400, 'set-assignee must reject an over-long name');
  assert((await editJson({ id: 'not a valid id!', op: 'set-assignee', assignee: 'bob' })).status === 400, 'set-assignee must reject a bad issue id');
  // The forms a real handle takes must all survive — including a hyphen in
  // the MIDDLE, which is the whole reason the rule is "no leading '-'" rather
  // than "no '-'".
  for (const who of ['bob', 'bob.smith', 'bob_smith-2', 'ann-marie', 'bob@example.com']) {
    assert((await editJson({ id: owned, op: 'set-assignee', assignee: who })).status === 200, `set-assignee must accept ${who}`);
    assert(await assigneeOf(owned) === who, `set-assignee did not persist ${who}`);
  }
  await editJson({ id: owned, op: 'set-assignee', assignee: '' });

  console.log(`smoke ok (set-assignee: reassign + clear removes the field + validation): ${owned}`);

  // --- tmux sessions API (hub-level, not project-scoped) ---------------------
  let tmuxPresent = true;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    tmuxPresent = false;
  }

  const tmuxRes = await fetch(`http://127.0.0.1:${port}/api/tmux`);
  assert(tmuxRes.status === 200, `/api/tmux should 200, got ${tmuxRes.status}`);
  const tmuxBody = await tmuxRes.json();
  assert(typeof tmuxBody.available === 'boolean', '/api/tmux missing boolean available');
  assert(Array.isArray(tmuxBody.sessions), '/api/tmux missing sessions array');

  if (!tmuxPresent) {
    assert(tmuxBody.available === false, '/api/tmux should report available:false when tmux binary is absent');
    assert(tmuxBody.sessions.length === 0, '/api/tmux should report no sessions when tmux binary is absent');
    console.log('smoke ok (tmux API: absent -> available:false)');
  } else {
    // tmux is present, but we never create/attach real sessions in smoke —
    // just shape-check whatever the host's tmux server (if any) reports.
    for (const s of tmuxBody.sessions) {
      assert(typeof s.name === 'string', 'tmux session missing name');
      assert(typeof s.created === 'number', 'tmux session missing numeric created');
      assert(typeof s.attached === 'number', 'tmux session missing numeric attached');
      assert(typeof s.windows === 'number', 'tmux session missing numeric windows');
      assert(s.activity === null || typeof s.activity === 'number', 'tmux session activity must be number or null');
      assert(s.lastAttached === null || typeof s.lastAttached === 'number', 'tmux session lastAttached must be number or null');
      assert(Array.isArray(s.panes), 'tmux session missing panes array');
      // Agent/promptability verdict fields (bd-console-2gs) — shape only; the
      // RULES are asserted against fixtures below, since this host's real
      // sessions are whatever they happen to be.
      assert(s.agent === null || typeof s.agent === 'string', 'tmux session agent must be string or null');
      assert(typeof s.mode === 'string', 'tmux session missing mode');
      assert(typeof s.promptable === 'boolean', 'tmux session missing boolean promptable');
      assert((s.promptable === false) === (s.mode === 'server'),
        `only a server-mode session may be non-promptable: ${s.name} mode=${s.mode} promptable=${s.promptable}`);
      for (const pane of s.panes) {
        assert(typeof pane.command === 'string', 'tmux pane missing command');
        assert(typeof pane.cwd === 'string', 'tmux pane missing cwd');
        assert(typeof pane.title === 'string', 'tmux pane missing title');
        assert(typeof pane.pid === 'number', 'tmux pane missing numeric pid');
        assert(typeof pane.promptable === 'boolean', 'tmux pane missing boolean promptable');
      }
      // Termix is unconfigured in this fixture config dir, so the deep-link
      // decoration must be ABSENT rather than present-and-null — that's the
      // contract that keeps an un-set-up hub byte-identical to before the
      // feature. (The composition rules themselves are asserted on fixtures
      // below; the configured-server round-trip is in the settings section.)
      assert(!('termix' in s), `an unconfigured hub must not decorate sessions with termix: ${JSON.stringify(s.termix)}`);
    }

    // has-session against a name that (almost certainly) doesn't exist must
    // 400 cleanly via the preview route's validation, not error out.
    const badSession = await fetch(`http://127.0.0.1:${port}/api/tmux/preview?session=${encodeURIComponent('bad name!')}`);
    assert(badSession.status === 400, `/api/tmux/preview with a bad session name should 400, got ${badSession.status}`);

    // capture-pane is read-only — safe to call against a real session if one
    // happens to be running on this host, but we never send it anything.
    if (tmuxBody.sessions.length) {
      const real = tmuxBody.sessions[0].name;
      const previewRes = await fetch(`http://127.0.0.1:${port}/api/tmux/preview?session=${encodeURIComponent(real)}&lines=5`);
      assert(previewRes.status === 200, `/api/tmux/preview should 200 for a real session, got ${previewRes.status}`);
      const previewBody = await previewRes.json();
      assert(typeof previewBody.text === 'string', '/api/tmux/preview missing text field');
    }

    console.log(`smoke ok (tmux API: present, ${tmuxBody.sessions.length} session(s), shape-checked only)`);
  }

  // --- agent-type + promptability detection (bd-console-2gs) ----------------
  // FIXTURES, not live tmux: every case below is a real pane record measured
  // on a multi-agent host, replayed as synthetic input. The rule under test is
  // that `pane_current_command` alone is never trusted — argv decides, the
  // pane title is a last resort, and every uncertain path stays promptable so
  // detection can only ever ADD refusals it can prove.
  {
    // The case that motivated the whole feature: `claude rc` (Claude Code's
    // Remote Control host) and an interactive `claude` are INDISTINGUISHABLE
    // by pane_current_command — both report "claude".
    const interactiveClaude = classifyPane({
      command: 'claude', title: '✳ core2',
      processes: [{ argv: ['-bash'] }, { argv: ['claude', '--name', 'core2'] }]
    });
    assert(interactiveClaude.agent === 'claude' && interactiveClaude.mode === 'interactive' && interactiveClaude.promptable === true,
      `plain interactive claude should be promptable: ${JSON.stringify(interactiveClaude)}`);
    assert(interactiveClaude.agentSource === 'process', 'an argv match must report agentSource:process');

    const claudeRc = classifyPane({
      command: 'claude', title: '✳ core-rc',
      processes: [
        { argv: ['-bash'] },
        { argv: ['claude', 'rc'] },
        { argv: ['/home/u/.local/share/claude/versions/2.1.211', '--print', '--sdk-url', 'https://api.anthropic.com/v1/code/sessions/cse_x'] }
      ]
    });
    assert(claudeRc.agent === 'claude' && claudeRc.mode === 'server' && claudeRc.promptable === false,
      `\`claude rc\` must be detected as a server, not a prompt: ${JSON.stringify(claudeRc)}`);
    assert(/rc/.test(claudeRc.reason), `the refusal must name the signal it saw: ${claudeRc.reason}`);

    // Claude Code's versioned launcher has a NUMBER for a basename, so the
    // install path is the only thing that names it.
    const sdkChild = classifyPane({
      command: 'node', title: '',
      processes: [{ argv: ['/home/u/.local/share/claude/versions/2.1.211', '--print', '--output-format', 'stream-json'] }]
    });
    assert(sdkChild.agent === 'claude' && sdkChild.promptable === false,
      `the versioned --print launcher is headless claude: ${JSON.stringify(sdkChild)}`);

    // Kimi Code, measured: the pane reports bash, only the TITLE still says
    // "Kimi Code". Name the agent, but stay promptable — titles go stale.
    const kimiByTitle = classifyPane({ command: 'bash', title: 'Kimi Code', processes: [{ argv: ['-bash'] }] });
    assert(kimiByTitle.agent === 'kimi' && kimiByTitle.agentSource === 'title',
      `a stale-able title must still name the agent: ${JSON.stringify(kimiByTitle)}`);
    assert(kimiByTitle.promptable === true && kimiByTitle.mode === 'unknown',
      'a title-only match must never claim a mode or refuse a send');

    // kimi-code rewrites its own argv, so TUI and web server look identical —
    // the server instance record (pid) is the only discriminator.
    const kimiTui = classifyPane({
      command: 'kimi-code', title: 'codium',
      processes: [{ argv: ['-bash'] }, { argv: ['kimi-code'], kimiServer: false }]
    });
    assert(kimiTui.agent === 'kimi' && kimiTui.promptable === true, `kimi TUI is promptable: ${JSON.stringify(kimiTui)}`);
    const kimiWeb = classifyPane({
      command: 'kimi-code', title: 'codium',
      processes: [{ argv: ['-bash'] }, { argv: ['kimi-code'], kimiServer: true }]
    });
    assert(kimiWeb.agent === 'kimi' && kimiWeb.mode === 'server' && kimiWeb.promptable === false,
      `a kimi pane that owns a server instance is not promptable: ${JSON.stringify(kimiWeb)}`);

    // The Gemini CLI's binary is `agy` (Antigravity), NOT `gemini`.
    const gemini = classifyPane({ command: 'agy', title: 'codium', processes: [{ argv: ['-bash'] }, { argv: ['agy'] }] });
    assert(gemini.agent === 'gemini' && gemini.promptable === true, `agy is the gemini CLI: ${JSON.stringify(gemini)}`);
    assert(gemini.agentLabel && /Gemini/.test(gemini.agentLabel), 'the UI label must be human, not the binary name');
    // ...and "codium" in a title must not read as "codex".
    assert(classifyPane({ command: 'vim', title: 'codium' }).agent === null,
      'title matching must be word-anchored — codium is not codex');

    // codex: bare is interactive; app-server is not. `-p` is codex's PROFILE
    // flag, which is why the server-flag lists are per-agent, not shared.
    const codex = classifyPane({ command: 'codex', title: 'pric3d', processes: [{ argv: ['-bash'] }, { argv: ['codex'] }] });
    assert(codex.agent === 'codex' && codex.promptable === true, `bare codex is promptable: ${JSON.stringify(codex)}`);
    const codexServer = classifyPane({
      command: 'codex', title: '',
      processes: [{ argv: ['codex', '-c', 'features.code_mode_host=true', 'app-server', '--listen', 'unix://'] }]
    });
    assert(codexServer.mode === 'server' && codexServer.promptable === false,
      `codex app-server is not promptable: ${JSON.stringify(codexServer)}`);
    assert(classifyPane({ command: 'codex', processes: [{ argv: ['codex', '-p', 'work'] }] }).promptable === true,
      'codex -p selects a profile and stays interactive — it must NOT be read as claude/gemini --print');

    // npx/node wrappers still resolve to the agent underneath.
    const wrapped = classifyPane({
      command: 'node', title: '',
      processes: [{ argv: ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'] }]
    });
    assert(wrapped.agent === 'claude', `a node-wrapped agent must still resolve: ${JSON.stringify(wrapped)}`);

    // A plain shell: no agent, still a legitimate send target (that is what
    // the scheduler has always done).
    const shell = classifyPane({ command: 'bash', title: 'user@host:~', processes: [{ argv: ['-bash'] }] });
    assert(shell.agent === null && shell.mode === 'shell' && shell.promptable === true,
      `a shell pane stays promptable: ${JSON.stringify(shell)}`);

    // DEGRADATION: no /proc evidence at all (non-Linux, dead pid, permission
    // denied) must fall back to tmux's own field and stay promptable — the
    // pre-detection behaviour — and must never throw.
    const noProc = classifyPane({ command: 'claude', title: '' });
    assert(noProc.agent === 'claude' && noProc.agentSource === 'command' && noProc.promptable === true,
      `without /proc, the pane command names the agent and nothing is refused: ${JSON.stringify(noProc)}`);
    for (const junk of [undefined, null, {}, { command: null, title: null, processes: null }, { processes: [{ argv: null }] }]) {
      const v = classifyPane(junk);
      assert(v && v.promptable === true && v.mode === 'unknown', `garbage input must degrade, not throw: ${JSON.stringify(junk)}`);
    }

    // THE INVARIANT: promptable:false happens if and only if mode === 'server'.
    for (const v of [interactiveClaude, claudeRc, sdkChild, kimiByTitle, kimiTui, kimiWeb, gemini, codex, codexServer, shell, noProc]) {
      assert((v.promptable === false) === (v.mode === 'server'),
        `only server mode may be non-promptable: ${JSON.stringify(v)}`);
    }
    console.log('smoke ok (agent detection: claude rc vs interactive, kimi web vs TUI vs stale title, agy=gemini, codex -p, shell, no-/proc degradation)');
  }

  // --- Termix deep links (bd-console-4w7) -----------------------------------
  // FIXTURES ONLY. Nothing here touches a Termix install — no fetch is made,
  // no base URL is resolved, no credential exists. That is the point: the
  // thing a user clicks is pure derivation, so it can be pinned here rather
  // than only observed by having a Termix to click into.
  {
    const cfg = { baseUrl: 'https://termix.example.com', hostId: 7, token: 'tmx_' + 'a'.repeat(64) };

    // The deep-link contract, read from Termix's own src/main.tsx:
    // ?view=terminal&hostId=<id>&tmuxSession=<name>. Pinned as an exact
    // string because it is an UNDOCUMENTED internal contract — if a Termix
    // release changes it, this assertion is where we find out.
    assert(
      termixAttachUrl(cfg, 'work') === 'https://termix.example.com/?view=terminal&hostId=7&tmuxSession=work',
      `attach URL shape drifted: ${termixAttachUrl(cfg, 'work')}`
    );

    // A base URL with a path prefix (Termix behind a reverse-proxy subpath)
    // must keep the prefix and gain exactly one separator.
    assert(
      termixAttachUrl({ ...cfg, baseUrl: 'https://box.lan/termix' }, 'work')
        === 'https://box.lan/termix/?view=terminal&hostId=7&tmuxSession=work',
      'a subpath base URL must be preserved with a single separator'
    );

    // Session names are URL-ENCODED, never interpolated raw: tmux allows
    // ':' and '@' in a name, and both are reserved in a query string.
    const encoded = termixAttachUrl(cfg, 'ops:2@box');
    assert(encoded.endsWith('tmuxSession=ops%3A2%40box'), `session name must be percent-encoded: ${encoded}`);
    assert(new URLSearchParams(new URL(encoded).search).get('tmuxSession') === 'ops:2@box',
      'the encoded session name must decode back to the original');

    // Validation, not sanitization: anything SESSION_NAME_RE would reject at
    // the tmux exec boundary is refused here too, so a hostile-ish name can
    // never reach a composed URL at all.
    for (const bad of ['bad name', 'a/b', '../evil', 'x"y', '', null, undefined, 'a&view=shared']) {
      assert(termixAttachUrl(cfg, bad) === null, `a rejected session name must yield no URL: ${JSON.stringify(bad)}`);
      assert(termixLinkFor(cfg, bad) === null, `a rejected session name must yield no link: ${JSON.stringify(bad)}`);
    }

    // Degradation, and the honesty rule it encodes. No baseUrl -> no link at
    // all (nothing to offer). baseUrl but no hostId -> the link opens Termix
    // and SAYS it can't attach, rather than composing a ?view=terminal aimed
    // at no host, which would gate the user into an empty terminal.
    assert(termixLinkFor({}, 'work') === null, 'no base URL must render no link');
    assert(termixLinkFor({ baseUrl: null, hostId: 7 }, 'work') === null, 'a host id without a base URL is not a link');

    const partial = termixLinkFor({ baseUrl: 'https://termix.example.com' }, 'work');
    assert(partial.mode === 'open', `without a host id the mode must be 'open', got ${partial.mode}`);
    assert(partial.url === 'https://termix.example.com/', `the fallback must be the bare install URL, got ${partial.url}`);
    assert(!partial.url.includes('view='), 'the fallback must NOT use a view param — that gates the user into a terminal with no host');
    assert(/host id/i.test(partial.hint), `the degraded hint must name the missing setting: ${partial.hint}`);

    const full = termixLinkFor(cfg, 'work');
    assert(full.mode === 'attach' && full.url === termixAttachUrl(cfg, 'work'), 'attach mode must carry the attach URL');
    assert(/sign/i.test(full.hint), `the hint must warn that Termix may ask for a login: ${full.hint}`);
    assert(termixHomeUrl(null) === null && termixHomeUrl('https://x.test') === 'https://x.test/', 'home URL fallback shape');

    // The decoration contract used by GET /api/tmux: every session gains a
    // link, an unconfigured hub gains NOTHING (not a null field), and a
    // session whose name can't be linked is passed through untouched.
    const payload = { available: true, sessions: [{ name: 'work' }, { name: 'bad name' }] };
    assert(decorateSessionsWithTermix(payload, {}).sessions[0].termix === undefined,
      'an unconfigured hub must leave sessions exactly as they were');
    const decorated = decorateSessionsWithTermix(payload, cfg);
    assert(decorated.sessions[0].termix.url === termixAttachUrl(cfg, 'work'), 'decoration must attach the composed link');
    assert(decorated.sessions[1].termix === undefined, 'an unlinkable session name must be passed through undecorated');
    assert(payload.sessions[0].termix === undefined, 'decoration must not mutate the input payload');
    assert(decorateSessionsWithTermix({ available: false, sessions: [] }, cfg).sessions.length === 0,
      'a tmux-less host must decorate nothing and not throw');

    // Host id validation: it ends up in a URL, so only a positive integer.
    assert(validateTermixHostId('7') === 7 && validateTermixHostId(7) === 7, 'host id must coerce to a number');
    for (const bad of ['0', '-1', '1.5', 'abc', '', '  ', '7; drop', '1e3', null, undefined]) {
      let threw = false;
      try { validateTermixHostId(bad); } catch { threw = true; }
      assert(threw, `host id ${JSON.stringify(bad)} should be refused`);
    }

    // The API path. Singular — the API-keys doc's curl example says plural,
    // but the OpenAPI spec and Termix's own client both use the singular
    // form, and plural exists only as /host/db/hosts/export.
    assert(termixHostsUrl('https://termix.example.com/') === 'https://termix.example.com/host/db/host',
      `hosts URL shape drifted: ${termixHostsUrl('https://termix.example.com/')}`);

    // The 200 body shape is documented only in prose ("A list of SSH hosts"),
    // so the normalizer tolerates the three plausible envelopes and drops
    // anything without a usable integer id rather than trusting the payload.
    const rows = [{ id: 2, name: 'box', ip: '10.0.0.2', port: 22, username: 'me' }, { id: '1', name: 'other' }, { id: 'nope' }, null];
    for (const [label, envelope] of [['bare array', rows], ['{hosts}', { hosts: rows }], ['{data}', { data: rows }]]) {
      const parsed = normalizeTermixHosts(envelope);
      assert(parsed.length === 2, `${label} envelope should yield 2 usable hosts, got ${parsed.length}`);
      assert(parsed[0].id === 1 && parsed[1].id === 2, `${label} hosts must be sorted by id`);
      assert(parsed[1].enableTerminal === true, 'a host that omits enableTerminal must default to terminal-capable');
    }
    assert(normalizeTermixHosts(null).length === 0 && normalizeTermixHosts({ hosts: 'nope' }).length === 0,
      'a junk payload must normalize to an empty list, not throw');
    assert(normalizeTermixHosts([{ id: 3, enableTerminal: false }])[0].enableTerminal === false,
      'an explicitly terminal-disabled host must stay marked');

    // Auth failures must name the remedy, not the status code.
    assert(/API Keys/.test(describeTermixFailure(401, '')), 'a 401 must point at where API keys are made');
    assert(/API Keys/.test(describeTermixFailure(403, '')), 'a 403 must point at where API keys are made');
    assert(/port/.test(describeTermixFailure(404, '')), 'a 404 must raise the wrong-port possibility');
    assert(/HTTP 500/.test(describeTermixFailure(500, 'boom')), 'an unexpected status should still be reported');

    // Credential shape is presentational only — a warning, never a gate, and
    // never something we check by dialling out to find out.
    assert(looksLikeTermixApiKey('tmx_' + 'a'.repeat(64)), 'a well-formed API key must be recognized');
    assert(!looksLikeTermixApiKey('tmx_' + 'a'.repeat(63)) && !looksLikeTermixApiKey('eyJhbGciOi.jwt.here'),
      'a short key or a JWT must not be mistaken for an API key');

    console.log('smoke ok (termix deep links: view=terminal contract, encoding, hostId degradation, host-list normalization — no network)');
  }

  // --- prompt scheduler (hub-level, not project-scoped) -----------------------
  const schedRes = await fetch(`http://127.0.0.1:${port}/api/schedule`);
  assert(schedRes.status === 200 || schedRes.status === 501, `/api/schedule GET unexpected status ${schedRes.status}`);
  const schedAvailable = schedRes.status === 200;

  if (!schedAvailable) {
    const body = await schedRes.json();
    assert(/node/i.test(body.error || ''), '/api/schedule 501 should explain the Node version requirement');
    console.log('smoke ok (scheduler: node:sqlite unavailable -> 501, skipping CRUD checks)');
  } else {
    const fakeSession = `smoke-fake-${Date.now()}`;
    const nearFuture = Date.now() + 5 * 60 * 1000;

    const createFuture = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'echo smoke', session: fakeSession, runAt: nearFuture })
    }).then((r) => r.json());
    assert(createFuture.ok && createFuture.job && createFuture.job.id, `schedule create (future) failed: ${JSON.stringify(createFuture)}`);
    assert(createFuture.job.status === 'pending', 'newly created schedule job should be pending');
    const futureJobId = createFuture.job.id;

    const listAfterCreate = await fetch(`http://127.0.0.1:${port}/api/schedule`).then((r) => r.json());
    assert(listAfterCreate.jobs.some((j) => j.id === futureJobId && j.status === 'pending'), 'schedule list missing the pending future job');

    const cancelRes = await fetch(`http://127.0.0.1:${port}/api/schedule/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: futureJobId })
    }).then((r) => r.json());
    assert(cancelRes.ok, `schedule cancel failed: ${JSON.stringify(cancelRes)}`);

    const listAfterCancel = await fetch(`http://127.0.0.1:${port}/api/schedule`).then((r) => r.json());
    const cancelledJob = listAfterCancel.jobs.find((j) => j.id === futureJobId);
    assert(cancelledJob && cancelledJob.status === 'cancelled', 'cancelled job did not transition to status "cancelled"');

    // A second cancel on an already-cancelled (non-pending) job must fail.
    const doubleCancel = await fetch(`http://127.0.0.1:${port}/api/schedule/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: futureJobId })
    });
    assert(doubleCancel.status === 400, `cancelling an already-cancelled job should 400, got ${doubleCancel.status}`);

    // Validation: bad session name, empty prompt, non-integer runAt.
    const badSessionCreate = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', session: 'bad name!', runAt: Date.now() })
    });
    assert(badSessionCreate.status === 400, `schedule create with a bad session name should 400, got ${badSessionCreate.status}`);

    const emptyPromptCreate = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '  ', session: fakeSession, runAt: Date.now() })
    });
    assert(emptyPromptCreate.status === 400, `schedule create with an empty prompt should 400, got ${emptyPromptCreate.status}`);

    // A job scheduled for "now" against a session that (deliberately) does
    // not exist must fail on the next scheduler tick, never send anywhere.
    const nonexistentSession = `smoke-nonexistent-${Date.now()}`;
    const createDue = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'this must never be sent', session: nonexistentSession, runAt: Date.now() })
    }).then((r) => r.json());
    assert(createDue.ok && createDue.job && createDue.job.id, `schedule create (due now) failed: ${JSON.stringify(createDue)}`);
    const dueJobId = createDue.job.id;

    let finalJob = null;
    for (let i = 0; i < 30; i++) {
      const list = await fetch(`http://127.0.0.1:${port}/api/schedule`).then((r) => r.json());
      const job = list.jobs.find((j) => j.id === dueJobId);
      if (job && job.status !== 'pending') { finalJob = job; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(finalJob, 'scheduler did not process the due job within the expected window');
    assert(finalJob.status === 'failed', `due job against a nonexistent session should end up "failed", got "${finalJob.status}"`);
    assert(/not found/i.test(finalJob.error || ''), `due job error should mention "not found", got: ${finalJob.error}`);

    console.log(`smoke ok (scheduler CRUD + tick-driven failure): future=${futureJobId}, due=${dueJobId}`);

    // --- requeue a failed job -----------------------------------------------
    // dueJobId is a GENUINELY failed job (its session never existed), which is
    // exactly the state the retry feature exists for. Nothing below creates a
    // tmux session; a requeue re-arms send-keys against a session that may or
    // may not be there, and the response says which.
    const retryPost = (body) => fetch(`http://127.0.0.1:${port}/api/schedule/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const jobById = async (jobId) => (await fetch(`http://127.0.0.1:${port}/api/schedule`).then((r) => r.json())).jobs.find((j) => j.id === jobId);

    const failedBefore = await jobById(dueJobId);
    const retargetSession = `smoke-retarget-${Date.now()}`;
    const retryRes = await retryPost({ id: dueJobId, runAt: Date.now() + 5 * 60 * 1000, session: retargetSession });
    assert(retryRes.status === 200, `retry of a failed job should 200, got ${retryRes.status}`);
    const retryBody = await retryRes.json();
    assert(retryBody.ok && retryBody.job, `retry failed: ${JSON.stringify(retryBody)}`);
    // The SAME row is re-armed — not cloned into a second job.
    assert(retryBody.job.id === dueJobId, 'retry must re-arm the same job row, not create a new one');
    assert(retryBody.job.status === 'pending', `a requeued job must be pending, got ${retryBody.job.status}`);
    assert(retryBody.job.session === retargetSession, 'retry must honour a session retarget');
    assert(retryBody.job.error === null, 'retry must clear the stale error');
    assert(retryBody.job.fired_at === null, 'retry must clear the stale fired_at');
    assert(retryBody.job.retry_count === 1, `retry_count should be 1, got ${retryBody.job.retry_count}`);
    assert(retryBody.job.last_error === failedBefore.error, 'retry must preserve the failure it is retrying in last_error');
    assert(retryBody.sessionLive === false, 'a fabricated session name must report sessionLive:false, never be created');
    const jobCount = (await fetch(`http://127.0.0.1:${port}/api/schedule`).then((r) => r.json())).jobs.filter((j) => j.id === dueJobId).length;
    assert(jobCount === 1, 'requeue must not leave a duplicate row behind');

    // runAt is REQUIRED: the old run_at is in the past, so silently reusing it
    // would fire the prompt on the very next tick.
    assert((await retryPost({ id: dueJobId })).status === 400, 'retry without runAt must 400 rather than reuse the stale time');
    assert((await retryPost({ id: dueJobId, runAt: 'soon' })).status === 400, 'retry with a non-integer runAt must 400');
    assert((await retryPost({ id: dueJobId, runAt: Date.now(), session: 'bad name!' })).status === 400, 'retry with a bad session name must 400');
    assert((await retryPost({ id: 999999, runAt: Date.now() })).status === 400, 'retry of an unknown job must 400');
    // Already pending: nothing to retry.
    assert((await retryPost({ id: dueJobId, runAt: Date.now() })).status === 400, 'retry of a pending job must 400');

    // Cancelled IS retryable (the user is undoing their own withdrawal), and
    // a requeue that fires against a still-missing session must fail again
    // cleanly rather than resurrect anything.
    await fetch(`http://127.0.0.1:${port}/api/schedule/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: dueJobId }),
    });
    const retryCancelled = await retryPost({ id: dueJobId, runAt: Date.now() }).then((r) => r.json());
    assert(retryCancelled.ok, `retry of a cancelled job should be allowed: ${JSON.stringify(retryCancelled)}`);
    assert(retryCancelled.job.retry_count === 2, `retry_count should accumulate, got ${retryCancelled.job.retry_count}`);

    let refailed = null;
    for (let i = 0; i < 30; i++) {
      const job = await jobById(dueJobId);
      if (job && job.status !== 'pending') { refailed = job; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(refailed, 'the requeued job was never processed by the scheduler');
    assert(refailed.status === 'failed', `a requeue aimed at a missing session must fail again, got "${refailed.status}"`);
    assert(/not found/i.test(refailed.error || ''), `re-failure should still name the missing session; got: ${refailed.error}`);

    console.log(`smoke ok (schedule retry: same row re-armed, retarget, explicit runAt required, refires cleanly): job=${dueJobId}`);

    // --- schedule.db migration onto a PRE-EXISTING database ------------------
    // retry_count/last_error were added after the jobs table shipped, so every
    // existing install has a schedule.db without them. The tests above only
    // ever exercise a database this run created, which would pass forever even
    // if the ALTERs were wrong. This one builds the ORIGINAL schema, drops a
    // failed job in it, and then opens it through the real openScheduleDb():
    // if the migration breaks, an upgrading user's scheduler view breaks with
    // it, and that has to fail here rather than on their machine.
    //
    // It runs in a child process on its own BD_CONSOLE_CONFIG_DIR because
    // CONFIG_DIR is resolved at module load — importing lib/schedule.mjs into
    // this process would open the developer's REAL ~/.config/bd-console.
    const migrateDir = join(tempRoot, 'sched-migrate');
    const migrateScript = join(tempRoot, 'sched-migrate.mjs');
    writeFileSync(migrateScript, `
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = process.env.BD_CONSOLE_CONFIG_DIR;
mkdirSync(dir, { recursive: true });

// The jobs table EXACTLY as it shipped before retry_count/last_error existed.
const seed = new DatabaseSync(join(dir, 'schedule.db'));
seed.exec(\`
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL,
    session TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    fired_at INTEGER,
    error TEXT
  )
\`);
seed.prepare('INSERT INTO jobs (prompt, session, run_at, status, created_at, fired_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('legacy prompt', 'legacy-session', 1000, 'failed', 900, 1001, 'tmux session not found');
seed.close();

const { listJobs, retryJob } = await import(process.argv[2]);
const before = (await listJobs())[0];
const retried = await retryJob(before.id, { runAt: Date.now() + 60 * 60 * 1000 });
console.log(JSON.stringify({ before, retried }));
`);
    const migrateOut = JSON.parse(trimLastLine(run(process.execPath, [migrateScript, resolve(join(process.cwd(), 'lib', 'schedule.mjs'))], {
      env: { ...process.env, BD_CONSOLE_CONFIG_DIR: migrateDir },
    })));
    // The pre-existing row survives untouched, and the new columns arrive with
    // usable defaults rather than as missing keys.
    assert(migrateOut.before.prompt === 'legacy prompt', 'migration must preserve pre-existing job rows');
    assert(migrateOut.before.error === 'tmux session not found', 'migration must preserve the stored error');
    assert(migrateOut.before.retry_count === 0, `retry_count should default to 0 on a migrated row, got ${migrateOut.before.retry_count}`);
    assert(migrateOut.before.last_error === null, `last_error should default to NULL on a migrated row, got ${JSON.stringify(migrateOut.before.last_error)}`);
    // And a job that predates the feature is immediately retryable.
    assert(migrateOut.retried.ok, `retrying a pre-migration job failed: ${JSON.stringify(migrateOut.retried)}`);
    assert(migrateOut.retried.job.retry_count === 1, 'retry_count must increment on a migrated row');
    assert(migrateOut.retried.job.last_error === 'tmux session not found', 'retry must move the migrated row\'s error into last_error');
    assert(migrateOut.retried.job.status === 'pending' && migrateOut.retried.job.error === null, 'a retried migrated row must be pending with a cleared error');

    console.log('smoke ok (schedule.db migration: additive ALTERs on a pre-existing db, legacy job retryable)');
  }

  // --- settings API ------------------------------------------------------------
  const settingsGet0 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(settingsGet0.settings, '/api/settings GET missing settings object');
  assert(settingsGet0.settings.host.value === '127.0.0.1', `settings host mismatch: ${JSON.stringify(settingsGet0.settings.host)}`);
  assert(settingsGet0.settings.host.source === 'flag', `settings host source should be 'flag' (--host was passed), got ${settingsGet0.settings.host.source}`);
  assert(settingsGet0.settings.port.value === port, `settings port mismatch: ${JSON.stringify(settingsGet0.settings.port)}`);
  assert(settingsGet0.settings.port.source === 'flag', `settings port source should be 'flag' (--port was passed), got ${settingsGet0.settings.port.source}`);
  assert(settingsGet0.settings.token.set === false && settingsGet0.settings.token.masked === null, 'settings token should start unset');
  assert(settingsGet0.configPath === join(configDir, 'config.json'), `settings configPath mismatch: ${settingsGet0.configPath}`);
  assert(/restart/i.test(settingsGet0.note || ''), 'settings note should mention restart');

  const settingsBadKey = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: '9.9.9.9' })
  });
  assert(settingsBadKey.status === 400, `settings POST with a host key should 400, got ${settingsBadKey.status}`);

  const settingsSetTok = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'sekret-http-token' })
  }).then((r) => r.json());
  assert(settingsSetTok.ok && settingsSetTok.restartRequired === true, `settings token set failed: ${JSON.stringify(settingsSetTok)}`);

  const settingsConfigAfterSet = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(settingsConfigAfterSet.token === 'sekret-http-token', 'settings POST token did not persist to config.json');

  const settingsGet1 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(settingsGet1.settings.token.set === true, 'settings token.set should be true after POST');
  assert(settingsGet1.settings.token.masked === 'sekr…', `settings token.masked mismatch: ${settingsGet1.settings.token.masked}`);

  const settingsClearTok = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: null })
  }).then((r) => r.json());
  assert(settingsClearTok.ok, `settings token clear failed: ${JSON.stringify(settingsClearTok)}`);

  const settingsConfigAfterClear = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(!('token' in settingsConfigAfterClear), 'settings POST token:null did not clear the key');

  console.log('smoke ok (settings API: GET shape + POST token set/clear round-trip + 400 on host)');

  // --- settings API: opt-in per-project default epics (defaultEpics) --------
  // Fixture-only: reuses `epicRes` (the "Smoke epic" created above, in THIS
  // fixture repo) as the epic id mapped into the config — never touches a
  // real repo.
  const defaultEpicsGet0 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(defaultEpicsGet0.defaultEpics && typeof defaultEpicsGet0.defaultEpics === 'object' && !Array.isArray(defaultEpicsGet0.defaultEpics),
    `/api/settings GET missing a defaultEpics object: ${JSON.stringify(defaultEpicsGet0.defaultEpics)}`);
  assert(!defaultEpicsGet0.defaultEpics[projectId], 'defaultEpics should start empty for the fixture project');

  const defaultEpicsSet1 = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultEpics: { [projectId]: { bug: epicRes.id, feature: null } } })
  }).then((r) => r.json());
  assert(defaultEpicsSet1.ok && defaultEpicsSet1.restartRequired === false,
    `defaultEpics set failed (or wrongly required a restart): ${JSON.stringify(defaultEpicsSet1)}`);

  const configAfterDefaultEpics1 = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(configAfterDefaultEpics1.defaultEpics?.[projectId]?.bug === epicRes.id,
    `defaultEpics did not persist to config.json: ${JSON.stringify(configAfterDefaultEpics1.defaultEpics)}`);
  assert(configAfterDefaultEpics1.defaultEpics[projectId].feature === null, 'defaultEpics feature:null did not persist as null');

  const defaultEpicsGet1 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(defaultEpicsGet1.defaultEpics[projectId].bug === epicRes.id,
    `defaultEpics GET round-trip mismatch: ${JSON.stringify(defaultEpicsGet1.defaultEpics)}`);

  // A second POST touching only `task` must merge, not clobber, the `bug`
  // mapping already saved above.
  const defaultEpicsSet2 = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultEpics: { [projectId]: { task: epicRes.id } } })
  }).then((r) => r.json());
  assert(defaultEpicsSet2.ok, `defaultEpics merge-set failed: ${JSON.stringify(defaultEpicsSet2)}`);
  const configAfterMerge = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(configAfterMerge.defaultEpics[projectId].bug === epicRes.id && configAfterMerge.defaultEpics[projectId].task === epicRes.id,
    `defaultEpics merge clobbered a previously-set intent: ${JSON.stringify(configAfterMerge.defaultEpics[projectId])}`);

  // Validation: bad epic id, bad intent key, and bad top-level shape must all 400.
  const defaultEpicsBadId = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultEpics: { [projectId]: { bug: 'not a valid id!' } } })
  });
  assert(defaultEpicsBadId.status === 400, `defaultEpics with a bad epic id should 400, got ${defaultEpicsBadId.status}`);

  const defaultEpicsBadIntent = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultEpics: { [projectId]: { notarealintent: epicRes.id } } })
  });
  assert(defaultEpicsBadIntent.status === 400, `defaultEpics with an unknown intent key should 400, got ${defaultEpicsBadIntent.status}`);

  const defaultEpicsBadShape = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultEpics: 'nope' })
  });
  assert(defaultEpicsBadShape.status === 400, `defaultEpics with a non-object value should 400, got ${defaultEpicsBadShape.status}`);

  // A rejected write must not have partially applied — bug/task mappings
  // from before the bad requests above must be untouched.
  const configAfterBadRequests = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(configAfterBadRequests.defaultEpics[projectId].bug === epicRes.id && configAfterBadRequests.defaultEpics[projectId].task === epicRes.id,
    'a rejected defaultEpics POST should not have mutated config.json');

  console.log('smoke ok (settings API: defaultEpics round-trip + merge + validation rejection)');

  // --- settings API: Termix linkage (address + credential storage) ----------
  // The storage half of the deep-link feature. The whole point of these
  // assertions is that storage stays storage: saving a base URL and a
  // credential contacts NOTHING, and the credential round-trips to config.json
  // but the GET must never hand it back in the clear — the same contract
  // /api/usage is held to above.
  const termixSecret = 'termix-api-secret-value';
  const termixGet0 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(termixGet0.termix, '/api/settings GET missing termix block');
  assert(termixGet0.termix.baseUrl.value === null && termixGet0.termix.baseUrl.source === 'default',
    `termix baseUrl should start unset: ${JSON.stringify(termixGet0.termix.baseUrl)}`);
  assert(termixGet0.termix.token.set === false && termixGet0.termix.token.masked === null,
    `termix token should start unset: ${JSON.stringify(termixGet0.termix.token)}`);

  const termixSet = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { baseUrl: 'https://termix.example.com/', token: termixSecret } })
  }).then((r) => r.json());
  assert(termixSet.ok, `termix save failed: ${JSON.stringify(termixSet)}`);

  const termixConfigAfterSet = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(termixConfigAfterSet.termix.baseUrl === 'https://termix.example.com',
    `termix baseUrl should persist normalized (no trailing slash): ${termixConfigAfterSet.termix.baseUrl}`);
  assert(termixConfigAfterSet.termix.token === termixSecret, 'termix token did not persist to config.json');

  const termixGet1Res = await fetch(`http://127.0.0.1:${port}/api/settings`);
  const termixGet1Text = await termixGet1Res.text();
  assert(!termixGet1Text.includes(termixSecret), '/api/settings response must never contain termix token material');
  const termixGet1 = JSON.parse(termixGet1Text);
  assert(termixGet1.termix.baseUrl.value === 'https://termix.example.com' && termixGet1.termix.baseUrl.source === 'config',
    `termix baseUrl round-trip mismatch: ${JSON.stringify(termixGet1.termix.baseUrl)}`);
  assert(termixGet1.termix.token.set === true && termixGet1.termix.token.masked === 'term…',
    `termix token should read back set + masked only: ${JSON.stringify(termixGet1.termix.token)}`);

  // A partial patch leaves the other key alone.
  await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { baseUrl: 'http://10.9.9.9:8080' } })
  }).then((r) => r.json());
  const termixConfigPartial = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(termixConfigPartial.termix.baseUrl === 'http://10.9.9.9:8080', 'termix partial patch did not update baseUrl');
  assert(termixConfigPartial.termix.token === termixSecret, 'termix partial patch should not disturb the token');

  for (const [label, badBody] of [
    ['non-http scheme', { termix: { baseUrl: 'javascript:alert(1)' } }],
    ['bare hostname', { termix: { baseUrl: 'termix.example.com' } }],
    ['url with a query string', { termix: { baseUrl: 'https://termix.example.com/?a=1' } }],
    ['unknown sub-key', { termix: { apiKey: 'x' } }],
    ['empty object', { termix: {} }],
    ['non-object', { termix: 'https://termix.example.com' }],
  ]) {
    const bad = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(badBody)
    });
    assert(bad.status === 400, `termix POST with ${label} should 400, got ${bad.status}`);
  }

  const termixClear = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { baseUrl: null, token: null } })
  }).then((r) => r.json());
  assert(termixClear.ok, `termix clear failed: ${JSON.stringify(termixClear)}`);
  const termixConfigAfterClear = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(!('termix' in termixConfigAfterClear), 'clearing both termix keys should drop the whole termix object');
  assert(termixConfigAfterClear.defaultEpics, 'termix clear should not disturb the rest of config.json');

  console.log('smoke ok (settings API: termix baseUrl/token round-trip, partial patch, URL validation, credential never echoed)');

  // --- settings API: termix.hostId + the deep-link decoration (bd-console-4w7)
  // NOTHING in this block contacts a Termix, and the ordering is load-bearing:
  // it runs AFTER the clear above, so no credential is stored while it runs.
  // That is what makes the two host-lookup assertions safe — /api/termix/hosts
  // is the only route that can dial out, and both calls below hit a
  // precondition (no base URL / no token) that refuses BEFORE any request is
  // attempted. The deep link itself is composed from stored strings, so the
  // payoff can be verified end-to-end with no Termix in existence.
  const txGet0 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert('hostId' in txGet0.termix, '/api/settings GET must expose a termix.hostId block');
  assert(txGet0.termix.hostId.value === null && txGet0.termix.hostId.source === 'default',
    `termix.hostId should start unset: ${JSON.stringify(txGet0.termix.hostId)}`);

  const txBadHostId = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { hostId: 'not-a-number' } })
  });
  assert(txBadHostId.status === 400, `a non-integer termix.hostId should 400, got ${txBadHostId.status}`);

  const txLookupNoUrl = await fetch(`http://127.0.0.1:${port}/api/termix/hosts`);
  assert(txLookupNoUrl.status === 400, `/api/termix/hosts without a base URL should 400, got ${txLookupNoUrl.status}`);
  assert(/base URL/i.test((await txLookupNoUrl.json()).error || ''), 'the 400 should name the missing base URL');

  // `.invalid` is the reserved TLD that can never resolve — belt and braces on
  // top of "no token is stored, so the lookup refuses before dialling".
  const txSet = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { baseUrl: 'https://smoke.termix.invalid/', hostId: '4' } })
  }).then((r) => r.json());
  assert(txSet.ok && txSet.restartRequired === false, `termix hostId set failed: ${JSON.stringify(txSet)}`);

  const txConfig = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(txConfig.termix.hostId === 4, `termix.hostId must persist as a number, got ${JSON.stringify(txConfig.termix.hostId)}`);
  assert(!('token' in txConfig.termix), 'this block must never store a Termix credential');

  const txGet1 = await fetch(`http://127.0.0.1:${port}/api/settings`).then((r) => r.json());
  assert(txGet1.termix.hostId.value === 4 && txGet1.termix.hostId.source === 'config',
    `termix.hostId should read back from config: ${JSON.stringify(txGet1.termix.hostId)}`);

  const txLookupNoToken = await fetch(`http://127.0.0.1:${port}/api/termix/hosts`);
  assert(txLookupNoToken.status === 400, `/api/termix/hosts without a token should 400, got ${txLookupNoToken.status}`);
  assert(/token/i.test((await txLookupNoToken.json()).error || ''), 'the 400 should name the missing token');

  // The payoff: with Termix configured, GET /api/tmux carries a ready-made
  // deep link per session — and carries no credential of any kind.
  const txTmux = await fetch(`http://127.0.0.1:${port}/api/tmux`).then((r) => r.json());
  for (const s of txTmux.sessions) {
    assert(s.termix && s.termix.mode === 'attach', `a configured hub must decorate ${s.name} with an attach link: ${JSON.stringify(s.termix)}`);
    const expectedQuery = new URLSearchParams({ view: 'terminal', hostId: '4', tmuxSession: s.name }).toString();
    assert(s.termix.url === `https://smoke.termix.invalid/?${expectedQuery}`,
      `decorated link shape mismatch for ${s.name}: ${s.termix.url}`);
  }

  const txClear = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termix: { baseUrl: null, token: null, hostId: null } })
  }).then((r) => r.json());
  assert(txClear.ok, `termix clear failed: ${JSON.stringify(txClear)}`);
  const txConfigCleared = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
  assert(!('termix' in txConfigCleared), 'clearing every termix key should remove the whole nested object');

  console.log(`smoke ok (settings API: termix.hostId round-trip, host lookup refuses before dialling, ${txTmux.sessions.length} session(s) decorated)`);

  // --- saved prompts API ---------------------------------------------------------
  const promptsGet0 = await fetch(`http://127.0.0.1:${port}/api/prompts`);
  assert(promptsGet0.status === 200 || promptsGet0.status === 501, `/api/prompts GET unexpected status ${promptsGet0.status}`);
  const promptsAvailable = promptsGet0.status === 200;
  assert(promptsAvailable === schedAvailable, 'prompts availability should match scheduler (node:sqlite) availability');

  if (!promptsAvailable) {
    const body = await promptsGet0.json();
    assert(/node/i.test(body.error || ''), '/api/prompts 501 should explain the Node version requirement');
    console.log('smoke ok (prompts: node:sqlite unavailable -> 501, skipping CRUD checks)');
  } else {
    const createP1 = await fetch(`http://127.0.0.1:${port}/api/prompts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Prompt 1', prompt: 'do the first thing' })
    }).then((r) => r.json());
    assert(createP1.ok && createP1.id, `create prompt 1 failed: ${JSON.stringify(createP1)}`);

    const createP2 = await fetch(`http://127.0.0.1:${port}/api/prompts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Prompt 2', prompt: 'do the second thing' })
    }).then((r) => r.json());
    assert(createP2.ok && createP2.id, `create prompt 2 failed: ${JSON.stringify(createP2)}`);

    const listP0 = await fetch(`http://127.0.0.1:${port}/api/prompts`).then((r) => r.json());
    const p1 = listP0.prompts.find((x) => x.id === createP1.id);
    const p2 = listP0.prompts.find((x) => x.id === createP2.id);
    assert(p1 && p1.name === 'Smoke Prompt 1' && p1.prompt === 'do the first thing' && p1.last_used_at == null, 'prompt 1 shape mismatch');
    assert(p2 && p2.last_used_at == null, 'prompt 2 shape mismatch');
    // Both unused so far: most-recently-created (p2) should sort first.
    assert(
      listP0.prompts.findIndex((x) => x.id === createP2.id) < listP0.prompts.findIndex((x) => x.id === createP1.id),
      'prompts list should order newest-created first when unused'
    );

    const useP1 = await fetch(`http://127.0.0.1:${port}/api/prompts/used`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: createP1.id })
    }).then((r) => r.json());
    assert(useP1.ok, `prompt used-stamping failed: ${JSON.stringify(useP1)}`);

    const listP1 = await fetch(`http://127.0.0.1:${port}/api/prompts`).then((r) => r.json());
    const p1After = listP1.prompts.find((x) => x.id === createP1.id);
    assert(typeof p1After.last_used_at === 'number', 'prompt last_used_at was not stamped');
    assert(
      listP1.prompts.findIndex((x) => x.id === createP1.id) < listP1.prompts.findIndex((x) => x.id === createP2.id),
      'a just-used prompt should sort before an unused, older-created one'
    );

    const badCreate = await fetch(`http://127.0.0.1:${port}/api/prompts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  ', prompt: 'x' })
    });
    assert(badCreate.status === 400, `prompt create with an empty name should 400, got ${badCreate.status}`);

    const deleteP2 = await fetch(`http://127.0.0.1:${port}/api/prompts/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: createP2.id })
    }).then((r) => r.json());
    assert(deleteP2.ok, `prompt delete failed: ${JSON.stringify(deleteP2)}`);

    const listP2 = await fetch(`http://127.0.0.1:${port}/api/prompts`).then((r) => r.json());
    assert(!listP2.prompts.some((x) => x.id === createP2.id), 'deleted prompt still present in list');

    console.log(`smoke ok (prompts CRUD + used-stamping + delete): ${createP1.id}, ${createP2.id}`);
  }

  // --- git insights: fabricated temp repo (no remote) ---------------------------
  const gitFake = await fetch(p('/git')).then((r) => r.json());
  assert(gitFake.git, '/api/p/<id>/git should return git insights for the fabricated repo');
  assert(typeof gitFake.git.branch === 'string' && gitFake.git.branch, 'fabricated repo git insights missing branch');
  assert(gitFake.git.lastCommit && typeof gitFake.git.lastCommit.hash === 'string' && gitFake.git.lastCommit.hash,
    'fabricated repo git insights missing lastCommit');
  assert(typeof gitFake.git.lastCommit.time === 'number', 'fabricated repo lastCommit.time should be a numeric epoch');
  assert(gitFake.git.webUrl === null, 'fabricated repo (no remote) should have webUrl: null');
  assert(gitFake.git.remoteUrl === null, 'fabricated repo (no remote) should have remoteUrl: null');

  const projectsWithGit = await fetch(`http://127.0.0.1:${port}/api/projects?git=1`).then((r) => r.json());
  assert(projectsWithGit.projects[projectId] && projectsWithGit.projects[projectId].git, '/api/projects?git=1 missing git key for registered project');
  assert(projectsWithGit.projects[projectId].path === repoDir, '/api/projects?git=1 should preserve the path field');

  const projectsNoGit = await fetch(`http://127.0.0.1:${port}/api/projects`).then((r) => r.json());
  assert(!('git' in (projectsNoGit.projects[projectId] || {})), 'plain /api/projects should not include a git key');

  console.log('smoke ok (git insights: fabricated repo, no remote)');

  // Register THIS bd-console working repo in an isolated, temporary
  // registry/server to verify webUrl parsing against a real remote. We only
  // assert what `git remote get-url origin` on this checkout independently
  // reports — never a hardcoded host/owner.
  let selfOriginUrl = null;
  try { selfOriginUrl = run('git', ['remote', 'get-url', 'origin'], { cwd: process.cwd() }).trim(); } catch { /* no origin configured */ }

  if (selfOriginUrl) {
    const gitProbeConfigDir = join(tempRoot, 'git-probe-config');
    mkdirSync(gitProbeConfigDir, { recursive: true });
    writeFileSync(
      join(gitProbeConfigDir, 'registry.json'),
      JSON.stringify({ projects: { selfrepo: { path: process.cwd() } } }, null, 2)
    );
    const gitProbePort = await getPort();
    const gitProbeEnv = { ...process.env, BD_CONSOLE_CONFIG_DIR: gitProbeConfigDir };
    const gitProbeServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(gitProbePort)], {
      cwd: process.cwd(),
      env: gitProbeEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${gitProbePort}/api/meta`);
      const selfGit = await fetch(`http://127.0.0.1:${gitProbePort}/api/p/selfrepo/git`).then((r) => r.json());
      assert(selfGit.git, 'self-repo git insights missing');
      assert(selfGit.git.remoteUrl === selfOriginUrl, 'self-repo remoteUrl should match `git remote get-url origin`');

      const expectedWebUrl = (() => {
        const sshMatch = selfOriginUrl.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
        const httpsMatch = !sshMatch && selfOriginUrl.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
        const m = sshMatch || httpsMatch;
        if (!m) return null;
        const [, host, ownerRepo] = m;
        return ['github.com', 'gitlab.com', 'codeberg.org'].includes(host) ? `https://${host}/${ownerRepo}` : null;
      })();
      assert(selfGit.git.webUrl === expectedWebUrl, `self-repo webUrl mismatch: got ${selfGit.git.webUrl}, expected ${expectedWebUrl}`);

      console.log(`smoke ok (git insights: self repo, webUrl=${selfGit.git.webUrl})`);
    } finally {
      gitProbeServer.kill('SIGTERM');
      await new Promise((resolveP) => gitProbeServer.once('exit', () => resolveP()));
    }
  } else {
    console.log('smoke skip (git insights: self repo has no origin remote)');
  }

  // --- doc editing ---------------------------------------------------------------
  const docSaveRes = await fetch(p('/doc'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'docs/plan.md', content: '# Plan\n\n- item\n- edited by smoke\n' })
  }).then((r) => r.json());
  assert(docSaveRes.ok && docSaveRes.path === 'docs/plan.md' && typeof docSaveRes.mtime === 'number', `doc save failed: ${JSON.stringify(docSaveRes)}`);

  const docReread = await fetch(p(`/doc?path=${encodeURIComponent('docs/plan.md')}`)).then((r) => r.json());
  assert(docReread.content.includes('edited by smoke'), 'doc save did not persist (re-read mismatch)');

  const docNewFile = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'docs/new-from-smoke.md', content: '# New\n' })
  }).then((r) => r.json());
  assert(docNewFile.ok, `doc create-new-file failed: ${JSON.stringify(docNewFile)}`);
  const docNewReread = await fetch(p(`/doc?path=${encodeURIComponent('docs/new-from-smoke.md')}`)).then((r) => r.json());
  assert(docNewReread.content === '# New\n', 'newly created doc content mismatch on re-read');

  const docTraversal = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '../outside.md', content: 'nope' })
  });
  assert(docTraversal.status >= 400 && docTraversal.status < 500, `doc traversal escape should 4xx, got ${docTraversal.status}`);

  const docNonMd = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'docs/notes.txt', content: 'nope' })
  });
  assert(docNonMd.status === 400, `doc non-.md path should 400, got ${docNonMd.status}`);

  console.log('smoke ok (doc editing: save/reread + new-file + traversal/non-md rejection)');

  // --- bd-console-09n: "New doc" pure derivations (docCreate.js) ------------
  // Signal-free like relationships.js/formulas.js above, so assertable here
  // without a browser — see docCreate.js's own header for the contract.
  assert(newDocName('plan') === 'plan.md' && newDocName('plan.md') === 'plan.md',
    `newDocName must append .md exactly once; got ${JSON.stringify([newDocName('plan'), newDocName('plan.md')])}`);
  assert(newDocName('  ') === '', 'a blank name must yield no filename');

  assert(newDocPath('docs', 'plan') === 'docs/plan.md' && newDocPath('', 'plan') === 'plan.md',
    `newDocPath must join folder + name, and omit a leading slash for the root; got ${JSON.stringify([newDocPath('docs', 'plan'), newDocPath('', 'plan')])}`);
  assert(newDocPath('/docs/', 'plan') === 'docs/plan.md',
    'newDocPath must strip stray leading/trailing slashes from the folder');

  const newDocFixtureDocs = [{ path: 'README.md' }, { path: 'docs/plan.md' }, { path: 'notes/2026-07.md' }];
  const autoFolders = docFolders(newDocFixtureDocs);
  assert(autoFolders.includes('') && autoFolders.includes('docs') && autoFolders.includes('notes'),
    `docFolders (auto-discovery) should offer the project root plus every existing ancestor folder; got ${JSON.stringify(autoFolders)}`);
  const rootedFolders = docFolders(newDocFixtureDocs, ['docs']);
  assert(rootedFolders.includes('docs') && !rootedFolders.includes('notes') && !rootedFolders.includes(''),
    `THE BUG this guards: a configured docRoots must exclude folders outside it (and the bare root, unless it IS a root) — resolveDocPath() would reject a write there anyway; got ${JSON.stringify(rootedFolders)}`);

  assert(newDocProblem('docs', '', newDocFixtureDocs) === 'Give the document a name.',
    'an empty name must be refused with a name-specific reason');
  assert(newDocProblem('docs', 'sub/evil', newDocFixtureDocs) !== null,
    'a name containing a slash must be refused (the folder comes from the picker, not free text)');
  assert(/letters, numbers/.test(newDocProblem('docs', '$$$', newDocFixtureDocs) || ''),
    'a name with no usable characters must be refused');
  assert(/cannot contain "\.\."/.test(newDocProblem('docs', 'a..b', newDocFixtureDocs) || ''),
    'a name containing ".." must be refused even when it otherwise matches the character class');
  assert(/already exists/.test(newDocProblem('docs', 'plan', newDocFixtureDocs) || ''),
    'a name colliding with an existing doc must be refused, telling the author to open it instead');
  assert(newDocProblem('docs', 'brand-new', newDocFixtureDocs) === null,
    'a fresh, well-formed name must be accepted');

  assert(newDocTemplate('new') === '# New\n\n', `newDocTemplate should title-case a simple stem; got ${JSON.stringify(newDocTemplate('new'))}`);
  assert(newDocTemplate('release-notes.md') === '# Release notes\n\n',
    `newDocTemplate should strip .md and humanize dashes/underscores; got ${JSON.stringify(newDocTemplate('release-notes.md'))}`);
  assert(newDocTemplate('') === '# Untitled\n\n', 'newDocTemplate must fall back to Untitled for an empty stem');

  console.log('smoke ok (docCreate.js derivations: name/path joining, folder offering, save-gate reasons, starter template)');

  // --- bd-console-09n: create-only doc write route (`create: true`) --------
  // Same POST /api/doc route the editor uses; `create: true` is what lets the
  // "New doc" dialog land a file without ever risking an overwrite — see the
  // /api/doc POST handler in lib/routes.mjs.
  const docCreateNew = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'docs/created-by-smoke.md', content: '# Created\n\n', create: true })
  }).then((r) => r.json());
  assert(docCreateNew.ok && docCreateNew.path === 'docs/created-by-smoke.md',
    `create:true on a fresh path should succeed: ${JSON.stringify(docCreateNew)}`);
  const docCreateReread = await fetch(p(`/doc?path=${encodeURIComponent('docs/created-by-smoke.md')}`)).then((r) => r.json());
  assert(docCreateReread.content === '# Created\n\n', 'doc created with create:true did not persist');

  // THE BUG this guards: `create: true` must refuse to land on a path that
  // already has content, and must not have touched that content on the way
  // to refusing.
  const docCreateConflict = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'docs/created-by-smoke.md', content: '# Overwritten\n', create: true })
  });
  assert(docCreateConflict.status === 409, `create:true against an existing path should 409, got ${docCreateConflict.status}`);
  const docCreateConflictBody = await docCreateConflict.json();
  assert(/already exists/i.test(docCreateConflictBody.error || ''), `409 body should explain the conflict: ${JSON.stringify(docCreateConflictBody)}`);
  const docCreateUnchanged = await fetch(p(`/doc?path=${encodeURIComponent('docs/created-by-smoke.md')}`)).then((r) => r.json());
  assert(docCreateUnchanged.content === '# Created\n\n', 'a 409 create:true attempt must not have touched the existing content');

  // create:true does not bypass ordinary path validation — resolveDocPath()
  // rejects a traversal before the create/409 check ever runs, so this must
  // 400 like any other traversal attempt, not fall through as a "new" file.
  const docCreateTraversal = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '../outside-create.md', content: 'nope', create: true })
  });
  assert(docCreateTraversal.status === 400, `create:true traversal escape should 400, got ${docCreateTraversal.status}`);
  assert(!existsSync(join(tempRoot, 'outside-create.md')), 'create:true traversal must not have written outside the workspace');

  console.log('smoke ok (create-only doc route: fresh-path success, existing-path 409 without overwrite, traversal still rejected)');

  // --- daemon lifecycle: `start` always supersedes (Feature 1) --------------
  // BD_CONSOLE_PERSIST=0 is mandatory here: it forces the plain-spawn path so
  // this test never touches systemd/systemctl on the real machine.
  const daemonConfigDir = join(tempRoot, 'daemon-config');
  mkdirSync(daemonConfigDir, { recursive: true });
  const daemonSystemdDir = join(tempRoot, 'daemon-systemd');
  mkdirSync(daemonSystemdDir, { recursive: true });
  // BD_CONSOLE_SYSTEMD_DIR isolation matters even with PERSIST=0: the
  // supersede step inspects the systemd unit, and it must see the temp dir's
  // (nonexistent) unit, never the machine's real bd-console.service.
  const daemonEnv = { ...process.env, BD_CONSOLE_CONFIG_DIR: daemonConfigDir, BD_CONSOLE_SYSTEMD_DIR: daemonSystemdDir, BD_CONSOLE_PERSIST: '0' };
  const daemonPort = await getPort();
  const daemonPidPath = join(daemonConfigDir, 'console.pid');

  function runServeCommand(args) {
    return execFileSync(process.execPath, [serverEntry, ...args, '--host', '127.0.0.1', '--port', String(daemonPort)], {
      cwd: process.cwd(),
      env: daemonEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  runServeCommand(['start']);
  assert(existsSync(daemonPidPath), 'daemon `start` did not write a pid file');
  const daemonPid1 = Number(readFileSync(daemonPidPath, 'utf8').trim());
  daemonPid = daemonPid1;
  assert(isPidAlive(daemonPid1), 'daemon `start` pid is not alive');
  const daemonMeta1 = await fetch(`http://127.0.0.1:${daemonPort}/api/meta`).then((r) => r.json());
  assert(daemonMeta1.mode === 'hub', 'daemon /api/meta should report hub mode');
  assert(daemonMeta1.pid === daemonPid1, 'hub /api/meta pid did not match the pid file after first start');

  // Running `start` again must supersede — never silently no-op.
  runServeCommand(['start']);
  const daemonPid2 = Number(readFileSync(daemonPidPath, 'utf8').trim());
  daemonPid = daemonPid2;
  assert(daemonPid2 !== daemonPid1, 'supersede did not replace the running daemon (pid unchanged)');
  assert(!isPidAlive(daemonPid1), 'previous daemon process is still alive after supersede');
  assert(isPidAlive(daemonPid2), 'superseding daemon pid is not alive');
  const daemonMeta2 = await fetch(`http://127.0.0.1:${daemonPort}/api/meta`).then((r) => r.json());
  assert(daemonMeta2.pid === daemonPid2, 'hub /api/meta pid did not match the pid file after supersede');

  runServeCommand(['stop']);
  assert(await waitForExit(daemonPid2), 'daemon still running after `stop`');
  daemonPid = null;

  console.log(`smoke ok (daemon supersede): ${daemonPid1} -> ${daemonPid2}`);

  // --- systemd unit-file generation (Feature 2) ------------------------------
  // Pure text generation only — no systemctl calls, nothing installed, safe
  // to run unconditionally.
  const unitText = renderServiceUnit({
    execPath: '/usr/bin/node',
    serveEntry: '/opt/bd-console/serve.mjs',
    forwardArgs: ['--port', '4180'],
    path: '/usr/bin:/home/user/.local/bin'
  });
  assert(unitText.includes('ExecStart=/usr/bin/node /opt/bd-console/serve.mjs --port 4180'), 'unit file ExecStart mismatch');
  assert(unitText.includes('Environment="PATH=/usr/bin:/home/user/.local/bin"'),
    'unit file must embed the invoking PATH so the daemon can find bd/tmux under systemd');
  assert(unitText.includes('Restart=on-failure'), 'unit file missing Restart=on-failure');
  assert(unitText.includes('WantedBy=default.target'), 'unit file missing WantedBy=default.target');
  assert(unitText.includes('[Service]') && unitText.includes('[Install]'), 'unit file missing expected sections');

  console.log('smoke ok (systemd unit-file generation)');

  // --- `update --dry-run` (Feature 3) -----------------------------------
  // Never runs a real update against this working tree — --dry-run only
  // detects the install flavor and prints the commands it WOULD run.
  // BD_CONSOLE_SYSTEMD_DIR isolates the read-only systemd unit check that
  // `update` performs (via daemonStatus) from the real machine's units.
  const updateSystemdDir = join(tempRoot, 'update-systemd');
  mkdirSync(updateSystemdDir, { recursive: true });
  const updateEnv = {
    ...process.env,
    BD_CONSOLE_CONFIG_DIR: join(tempRoot, 'update-config'),
    BD_CONSOLE_SYSTEMD_DIR: updateSystemdDir,
    BD_CONSOLE_PERSIST: '0'
  };
  const dryRunOut = execFileSync(process.execPath, [serverEntry, 'update', '--dry-run'], {
    cwd: process.cwd(),
    env: updateEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert(dryRunOut.includes('detected flavor: git-clone'), `update --dry-run did not detect git-clone flavor:\n${dryRunOut}`);
  assert(dryRunOut.includes('pull --ff-only'), `update --dry-run did not print the planned git pull command:\n${dryRunOut}`);
  assert(dryRunOut.includes('current version:'), `update --dry-run did not print the current version:\n${dryRunOut}`);

  console.log('smoke ok (update --dry-run)');

  // --- `bd-console settings` set/list/unset round-trip (Feature 1) -----------
  const settingsConfigDir = join(tempRoot, 'settings-config');
  const settingsSystemdDir = join(tempRoot, 'settings-systemd');
  mkdirSync(settingsConfigDir, { recursive: true });
  mkdirSync(settingsSystemdDir, { recursive: true });
  const settingsEnv = {
    ...process.env,
    BD_CONSOLE_CONFIG_DIR: settingsConfigDir,
    BD_CONSOLE_SYSTEMD_DIR: settingsSystemdDir
  };

  function runSettings(args) {
    return execFileSync(process.execPath, [serverEntry, 'settings', ...args], {
      cwd: process.cwd(),
      env: settingsEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  runSettings(['set', 'host', '10.1.2.3']);
  runSettings(['set', 'port', '9191']);
  runSettings(['set', 'token', 'sekret-token-value']);
  runSettings(['set', 'persist', 'false']);

  const settingsListOut = runSettings(['list']);
  assert(settingsListOut.includes('10.1.2.3'), `settings list missing host round-trip:\n${settingsListOut}`);
  assert(settingsListOut.includes('9191'), `settings list missing port round-trip:\n${settingsListOut}`);
  assert(/token\s+set \(sekr\.\.\.\)/.test(settingsListOut), `settings list did not mask the token:\n${settingsListOut}`);
  assert(!settingsListOut.includes('sekret-token-value'), 'settings list leaked the full token value');
  assert(/persist\s+false/.test(settingsListOut), `settings list missing persist round-trip:\n${settingsListOut}`);
  assert(/\bconfig\b/.test(settingsListOut), `settings list did not report "config" as a source:\n${settingsListOut}`);

  const settingsConfigPath = join(settingsConfigDir, 'config.json');
  const settingsConfig1 = JSON.parse(readFileSync(settingsConfigPath, 'utf8'));
  assert(settingsConfig1.host === '10.1.2.3', 'settings set host did not persist to config.json');
  assert(settingsConfig1.port === 9191, 'settings set port did not persist to config.json');
  assert(settingsConfig1.token === 'sekret-token-value', 'settings set token did not persist to config.json');
  assert(settingsConfig1.persist === false, 'settings set persist did not persist to config.json');

  runSettings(['unset', 'token']);
  const settingsConfig2 = JSON.parse(readFileSync(settingsConfigPath, 'utf8'));
  assert(!('token' in settingsConfig2), 'settings unset token did not remove the key');
  assert(settingsConfig2.host === '10.1.2.3', 'settings unset token should not disturb other keys');

  let badSetFailed = false;
  try {
    runSettings(['set', 'port', '99999']);
  } catch {
    badSetFailed = true;
  }
  assert(badSetFailed, 'settings set with an out-of-range port should fail');

  // termix.* takes the same CLI path, nested one level down in config.json,
  // and its credential is masked in `list` exactly like the write token's.
  runSettings(['set', 'termix.baseUrl', 'https://termix.example.com/']);
  runSettings(['set', 'termix.token', 'termix-cli-secret']);
  runSettings(['set', 'termix.hostId', '12']);
  const settingsConfig3 = JSON.parse(readFileSync(settingsConfigPath, 'utf8'));
  assert(settingsConfig3.termix.baseUrl === 'https://termix.example.com', 'settings set termix.baseUrl did not persist normalized');
  assert(settingsConfig3.termix.token === 'termix-cli-secret', 'settings set termix.token did not persist to config.json');
  assert(settingsConfig3.termix.hostId === 12, `settings set termix.hostId must persist as a number: ${JSON.stringify(settingsConfig3.termix.hostId)}`);

  const settingsListOut2 = runSettings(['list']);
  assert(/termix\.hostId\s+12/.test(settingsListOut2), `settings list missing termix.hostId:\n${settingsListOut2}`);
  assert(settingsListOut2.includes('https://termix.example.com'), `settings list missing termix.baseUrl:\n${settingsListOut2}`);
  assert(/termix\.token\s+set \(term\.\.\.\)/.test(settingsListOut2), `settings list did not mask termix.token:\n${settingsListOut2}`);
  assert(!settingsListOut2.includes('termix-cli-secret'), 'settings list leaked the full termix token value');

  runSettings(['unset', 'termix.token']);
  const settingsConfig4 = JSON.parse(readFileSync(settingsConfigPath, 'utf8'));
  assert(!('token' in settingsConfig4.termix), 'settings unset termix.token did not remove the key');
  assert(settingsConfig4.termix.baseUrl === 'https://termix.example.com', 'settings unset termix.token should not disturb termix.baseUrl');

  let badTermixSetFailed = false;
  try {
    runSettings(['set', 'termix.baseUrl', 'not-a-url']);
  } catch {
    badTermixSetFailed = true;
  }
  assert(badTermixSetFailed, 'settings set with a non-URL termix.baseUrl should fail');

  let badHostIdSetFailed = false;
  try {
    runSettings(['set', 'termix.hostId', 'seven']);
  } catch {
    badHostIdSetFailed = true;
  }
  assert(badHostIdSetFailed, 'settings set with a non-integer termix.hostId should fail');

  console.log('smoke ok (settings set/list/unset round-trip, incl. nested termix.* + masked credential)');

  // --- non-TTY first run applies 0.0.0.0:4180 defaults (Feature 1) -----------
  // isFirstRun requires no --host/--port flags and no BD_CONSOLE_HOST/PORT env,
  // which means this necessarily binds the *real* default port (4180) — there
  // is no way to redirect it without defeating the first-run condition being
  // tested. Isolated via a fresh BD_CONSOLE_CONFIG_DIR/SYSTEMD_DIR either way.
  //
  // SAFETY: if ANYTHING already holds 4180 (most likely a real bd-console
  // deployment on this machine), SKIP this sub-test entirely. `start`'s
  // supersede logic would otherwise kill the real daemon. A raw TCP connect
  // is used, not an HTTP probe — a busy daemon that's slow to answer HTTP
  // still accepts the connection, so this cannot race the way a fetch with a
  // short timeout can. The systemd unit state is checked as a second signal.
  const port4180Busy = await new Promise((resolveP) => {
    const sock = net.connect({ port: 4180, host: '127.0.0.1', timeout: 1000 });
    sock.once('connect', () => { sock.destroy(); resolveP(true); });
    sock.once('timeout', () => { sock.destroy(); resolveP(true); }); // listening but slow — treat as busy
    sock.once('error', () => resolveP(false));
  });
  let unitActive = false;
  try {
    execFileSync('systemctl', ['--user', 'is-active', '--quiet', 'bd-console.service'], { stdio: 'ignore' });
    unitActive = true;
  } catch { /* inactive, missing, or no systemd — all mean not active */ }

  if (port4180Busy || unitActive) {
    console.log('smoke skip (non-TTY first-run: port 4180 in use or bd-console.service active — skipping to avoid superseding a real deployment)');
  } else {
  const firstRunConfigDir = join(tempRoot, 'first-run-config');
  const firstRunSystemdDir = join(tempRoot, 'first-run-systemd');
  mkdirSync(firstRunConfigDir, { recursive: true });
  mkdirSync(firstRunSystemdDir, { recursive: true });
  const firstRunEnv = {
    ...process.env,
    BD_CONSOLE_CONFIG_DIR: firstRunConfigDir,
    BD_CONSOLE_SYSTEMD_DIR: firstRunSystemdDir,
    BD_CONSOLE_PERSIST: '0'
  };
  const firstRunLogPath = join(firstRunConfigDir, 'console.log');
  const firstRunPidPath = join(firstRunConfigDir, 'console.pid');

  const preCheck = await fetch('http://127.0.0.1:4180/api/meta', { signal: AbortSignal.timeout(500) }).catch(() => null);
  assert(!preCheck, 'port 4180 already answering before the first-run test — cannot verify the default bind');

  execFileSync(process.execPath, [serverEntry, 'start'], {
    cwd: process.cwd(),
    env: firstRunEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  firstRunPid = Number(readFileSync(firstRunPidPath, 'utf8').trim());

  const firstRunLog = readFileSync(firstRunLogPath, 'utf8');
  assert(firstRunLog.includes('first run detected'), `first-run log missing the default-applied line:\n${firstRunLog}`);
  assert(firstRunLog.includes('0.0.0.0:4180'), `first-run log did not mention the applied 0.0.0.0:4180 default:\n${firstRunLog}`);
  assert(firstRunLog.includes("bd-console settings"), `first-run log did not point at 'bd-console settings':\n${firstRunLog}`);

  await waitFor('http://127.0.0.1:4180/api/meta');
  const firstRunMeta = await fetch('http://127.0.0.1:4180/api/meta').then((r) => r.json());
  assert(firstRunMeta.mode === 'hub', 'first-run default-bind server did not answer /api/meta on 4180');
  assert(firstRunMeta.port === 4180, 'first-run default-bind server reported an unexpected port');
  assert(firstRunMeta.writable === true, 'first-run default-bind server should keep writes open (no token)');

  execFileSync(process.execPath, [serverEntry, 'stop'], {
    cwd: process.cwd(),
    env: firstRunEnv,
    stdio: 'ignore'
  });
  assert(await waitForExit(firstRunPid), 'first-run daemon still running after `stop`');
  firstRunPid = null;

  console.log('smoke ok (non-TTY first-run defaults + log line)');
  }

  // --- provider usage adapters (lib/usage.mjs via GET /api/usage) ------------
  // Fixture-only: never reads the real ~/.claude, ~/.codex, ~/.kimi-code or
  // ~/.gemini, never hits the real network, never touches a real kimi server.
  // BD_CONSOLE_CLAUDE_DIR / BD_CONSOLE_CODEX_DIR / BD_CONSOLE_KIMI_DIR /
  // BD_CONSOLE_GEMINI_DIR redirect all four adapters at fabricated temp dirs the
  // same way BD_CONSOLE_CONFIG_DIR redirects the registry/config above.
  {
    const usageConfigDir = join(tempRoot, 'usage-config');
    const usageClaudeDir = join(tempRoot, 'usage-claude');
    const usageCodexDir = join(tempRoot, 'usage-codex-sessions');
    mkdirSync(usageConfigDir, { recursive: true });
    mkdirSync(usageClaudeDir, { recursive: true });
    const codexDayDir = join(usageCodexDir, '2026', '01', '01');
    mkdirSync(codexDayDir, { recursive: true });

    // Fabricated, already-expired Claude Code credentials — expiresAt is in
    // the past, so getClaudeUsage() must report 'token-expired' *without*
    // ever attempting the network call (proving the no-network-on-expiry path).
    const fakeAccessToken = 'sk-ant-oat01-SMOKE-FIXTURE-TOKEN-DO-NOT-USE-1234567890ABCDEF';
    writeFileSync(join(usageClaudeDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: fakeAccessToken,
        refreshToken: 'fake-refresh-token-do-not-use',
        expiresAt: Date.now() - 60000,
        subscriptionType: 'pro',
        rateLimitTier: 'default'
      }
    }));

    // Fabricated Codex rollout session: a stale token_count event, a
    // non-token_count event, then a fresh token_count event — getCodexUsage()
    // must select the LAST token_count event's rate_limits.
    const primaryResetsAtSec = Math.floor(Date.now() / 1000) + 3 * 3600;
    const secondaryResetsAtSec = Math.floor(Date.now() / 1000) + 6 * 86400;
    const staleLine = JSON.stringify({ payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 5, window_minutes: 300, resets_at: primaryResetsAtSec - 100 },
      secondary: null, plan_type: 'pro', credits: {}
    } } });
    const noiseLine = JSON.stringify({ payload: { type: 'something_else' } });
    const freshLine = JSON.stringify({ payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 63.5, window_minutes: 300, resets_at: primaryResetsAtSec },
      secondary: { used_percent: 12, window_minutes: 10080, resets_at: secondaryResetsAtSec },
      plan_type: 'pro', credits: {}
    } } });
    writeFileSync(join(codexDayDir, 'rollout-test.jsonl'), [staleLine, noiseLine, freshLine, ''].join('\n'));

    // --- Kimi Code fixture (~/.kimi-code, redirected by BD_CONSOLE_KIMI_DIR) --
    // Two server instance records (one stale, one beating), a session index
    // with a malformed line, two sessions in two workspaces — one with agent
    // wire logs to sum, one only half-described in workspaces.json — and a
    // server.token whose contents must never reach the HTTP response.
    const usageKimiDir = join(tempRoot, 'usage-kimi');
    const kimiInstancesDir = join(usageKimiDir, 'server', 'instances');
    mkdirSync(kimiInstancesDir, { recursive: true });
    const kimiSecret = 'kimi-smoke-server-token-DO-NOT-LEAK-0123456789';
    writeFileSync(join(usageKimiDir, 'server.token'), kimiSecret);

    // A pid above Linux's pid_max: process.kill(pid, 0) can only ever report
    // "no such process", which is what makes the dead-pid path deterministic.
    const KIMI_DEAD_PID = 4194304;
    writeFileSync(join(kimiInstancesDir, '01STALEINSTANCE.json'), JSON.stringify({
      server_id: '01STALEINSTANCE', pid: KIMI_DEAD_PID, host: '127.0.0.1', port: 31111,
      started_at: Date.now() - 7200000, heartbeat_at: Date.now() - 600000, host_version: '0.30.0'
    }));
    writeFileSync(join(kimiInstancesDir, '01FRESHINSTANCE.json'), JSON.stringify({
      server_id: '01FRESHINSTANCE', pid: process.pid, host: '0.0.0.0', port: 33333,
      started_at: Date.now() - 3600000, heartbeat_at: Date.now() - 5000, host_version: '0.32.0'
    }));

    const kimiSessionA = join(usageKimiDir, 'sessions', 'wd_alpha_aaa111', 'session_a');
    const kimiSessionB = join(usageKimiDir, 'sessions', 'wd_beta_bbb222', 'session_b');
    mkdirSync(join(kimiSessionA, 'agents', 'main'), { recursive: true });
    mkdirSync(join(kimiSessionA, 'agents', 'agent-0'), { recursive: true });
    mkdirSync(kimiSessionB, { recursive: true });

    // Session A: the v2 state.json shape (epoch-ms timestamps, `cwd`) with an
    // over-long title that must come back truncated to 120 chars.
    const kimiLongTitle = 'Build the thing, then build the other thing, and keep going well past the point where any card could render this title in full without eating the entire row';
    writeFileSync(join(kimiSessionA, 'state.json'), JSON.stringify({
      id: 'session_a', version: 2, cwd: '/tmp/alpha-project',
      createdAt: Date.now() - 90000, updatedAt: Date.now() - 60000, archived: false,
      agents: { main: { type: 'main' }, 'agent-0': { type: 'sub' } },
      lastPrompt: 'do the thing', title: kimiLongTitle
    }));
    // Session B: the v1 shape (ISO strings, `workDir`) — both must parse.
    writeFileSync(join(kimiSessionB, 'state.json'), JSON.stringify({
      createdAt: new Date(Date.now() - 172800000).toISOString(),
      updatedAt: new Date(Date.now() - 172800000).toISOString(),
      title: 'New Session', workDir: '/tmp/beta-project', agents: { main: { type: 'main' } }
    }));
    // Recency comes from state.json mtime, so B is explicitly backdated —
    // session A must win as `latestSession`.
    const kimiTwoDaysAgo = new Date(Date.now() - 172800000);
    utimesSync(join(kimiSessionB, 'state.json'), kimiTwoDaysAgo, kimiTwoDaysAgo);

    // usage.record events across TWO agents of the same session (main + a
    // sub-agent) plus noise and a malformed line, so the sum proves both the
    // fan-out aggregation and the skip-what-doesn't-parse rule.
    const kimiUsageLine = (model, inputOther, output, inputCacheRead, inputCacheCreation) =>
      JSON.stringify({ type: 'usage.record', model, usage: { inputOther, output, inputCacheRead, inputCacheCreation }, usageScope: 'turn', time: Date.now() });
    writeFileSync(join(kimiSessionA, 'agents', 'main', 'wire.jsonl'), [
      kimiUsageLine('kimi-code/k3', 100, 20, 1000, 5),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part' }, time: Date.now() }),
      '{ not json at all',
      kimiUsageLine('kimi-code/k3', 200, 30, 2000, 0),
      JSON.stringify({ type: 'turn.ended', turnId: 1, reason: 'completed', time: Date.now() }),
      ''
    ].join('\n'));
    writeFileSync(join(kimiSessionA, 'agents', 'agent-0', 'wire.jsonl'), [
      kimiUsageLine('kimi-code/k3-256k', 50, 10, 500, 0),
      JSON.stringify({ type: 'turn.ended', turnId: 1, reason: 'completed', time: Date.now() }),
      ''
    ].join('\n'));
    const kimiExpected = { input: 350, output: 60, cacheRead: 3500, cacheCreation: 5 };
    kimiExpected.total = kimiExpected.input + kimiExpected.output + kimiExpected.cacheRead + kimiExpected.cacheCreation;

    writeFileSync(join(usageKimiDir, 'session_index.jsonl'), [
      JSON.stringify({ sessionId: 'session_a', sessionDir: kimiSessionA, workDir: '/tmp/alpha-project' }),
      JSON.stringify({ sessionId: 'session_b', sessionDir: kimiSessionB, workDir: '/tmp/beta-project' }),
      'not json',
      JSON.stringify({ sessionId: 'no-dir' }),
      ''
    ].join('\n'));
    // Only alpha is named here — beta must fall back to its workDir with a
    // null name rather than disappearing.
    writeFileSync(join(usageKimiDir, 'workspaces.json'), JSON.stringify({
      version: 1,
      workspaces: { wd_alpha_aaa111: { root: '/tmp/alpha-project', name: 'alpha', created_at: '2026-01-01T00:00:00.000Z' } },
      deleted_workspace_ids: []
    }));

    // --- Gemini / Antigravity CLI fixture (~/.gemini, BD_CONSOLE_GEMINI_DIR) --
    // A fabricated `agy` home: the language server's own glog file (header
    // facts + a 429 RESOURCE_EXHAUSTED reply + the account email the real CLI
    // really does log), the conversation metadata cache, updater/config JSON,
    // and an antigravity-oauth-token whose contents must never reach the HTTP
    // response — the adapter must not even open it.
    const usageGeminiDir = join(tempRoot, 'usage-gemini');
    const geminiAppDir = join(usageGeminiDir, 'antigravity-cli');
    mkdirSync(join(geminiAppDir, 'log'), { recursive: true });
    mkdirSync(join(geminiAppDir, 'cache'), { recursive: true });
    mkdirSync(join(geminiAppDir, 'updater'), { recursive: true });
    mkdirSync(join(usageGeminiDir, 'config', 'projects'), { recursive: true });

    const geminiSecret = 'ya29.GEMINI-SMOKE-OAUTH-TOKEN-DO-NOT-LEAK-0123456789';
    writeFileSync(join(geminiAppDir, 'antigravity-oauth-token'), geminiSecret);
    // The real CLI writes the signed-in account's address into its own log.
    // The adapter must lift the auth METHOD off that line and nothing else.
    const geminiEmail = 'gemini-smoke-fixture@example.invalid';

    const gemTwo = (n) => String(n).padStart(2, '0');
    const gemGlogStamp = (d) => `${gemTwo(d.getMonth() + 1)}${gemTwo(d.getDate())} `
      + `${gemTwo(d.getHours())}:${gemTwo(d.getMinutes())}:${gemTwo(d.getSeconds())}.000000`;
    // glog omits the year, so the adapter infers it from the log file's mtime —
    // an event an hour old must come back with the right year even across a
    // new-year boundary.
    const geminiExhaustedAt = new Date(Math.floor((Date.now() - 3600000) / 1000) * 1000);
    const geminiStartedAt = new Date(Math.floor((Date.now() - 7200000) / 1000) * 1000);
    const geminiLogName = `cli-${geminiStartedAt.getFullYear()}${gemTwo(geminiStartedAt.getMonth() + 1)}`
      + `${gemTwo(geminiStartedAt.getDate())}_${gemTwo(geminiStartedAt.getHours())}`
      + `${gemTwo(geminiStartedAt.getMinutes())}${gemTwo(geminiStartedAt.getSeconds())}.log`;
    // An older log that must LOSE to the newest one by mtime.
    writeFileSync(join(geminiAppDir, 'log', 'cli-20200101_000000.log'),
      `I0101 00:00:00.000000 4242 server.go:1417] Language server version: 0.0.1\n`);
    const geminiOldLogTime = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(geminiAppDir, 'log', 'cli-20200101_000000.log'), geminiOldLogTime, geminiOldLogTime);
    writeFileSync(join(geminiAppDir, 'log', geminiLogName), [
      `I${gemGlogStamp(geminiStartedAt)} ${process.pid} server.go:1367] Starting language server process with pid ${process.pid}`,
      `I${gemGlogStamp(geminiStartedAt)} ${process.pid} server.go:1417] Language server version: 1.1.4`,
      `I${gemGlogStamp(geminiStartedAt)} ${process.pid} server.go:538] Language server listening on random port at 41227 for HTTPS (gRPC)`,
      `I${gemGlogStamp(geminiStartedAt)} ${process.pid} server.go:546] Language server listening on random port at 37871 for HTTP`,
      `E${gemGlogStamp(geminiStartedAt)} ${process.pid} log.go:398] error getting token source: You are not logged into Antigravity.`,
      `I${gemGlogStamp(geminiStartedAt)} ${process.pid} server_oauth.go:216] applyAuthResult: email=${geminiEmail}, authMethod=consumer, quotaProject=`,
      `I${gemGlogStamp(geminiExhaustedAt)} ${process.pid} quota_manager.go:72] quotaRefreshLoop: starting reload (force=true)`,
      `E${gemGlogStamp(geminiExhaustedAt)} ${process.pid} log.go:398] RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).`,
      ''
    ].join('\n'));

    // Two real conversations plus an internal one that must be excluded. The
    // newest has an empty Title, so its display name must fall back to Preview
    // — truncated to 120 chars.
    const geminiLongPreview = 'Wire the Antigravity adapter into the hub and keep going well past the point where any ~350px card could render this preview in full without eating the entire row';
    writeFileSync(join(geminiAppDir, 'cache', 'conversation_metadata.json'), JSON.stringify({
      conversations: {
        'gem-old': {
          summary: {
            ID: 'gem-old', Title: 'Older IDE conversation', Preview: 'p', NumSteps: 4,
            UpdatedAt: new Date(Date.now() - 172800000).toISOString(),
            WorkspaceURIs: ['file:///tmp/gem-beta'], AppDataDir: 'antigravity', ProjectID: '', AgentName: ''
          },
          is_internal: false, last_modified_time: new Date(Date.now() - 172800000).toISOString()
        },
        'gem-new': {
          summary: {
            ID: 'gem-new', Title: '', Preview: geminiLongPreview, NumSteps: 7,
            UpdatedAt: new Date(Date.now() - 60000).toISOString(),
            WorkspaceURIs: ['file:///tmp/gem-alpha'], AppDataDir: 'antigravity-cli',
            ProjectID: 'default-cli-project', AgentName: ''
          },
          is_internal: false, last_modified_time: new Date(Date.now() - 60000).toISOString()
        },
        'gem-internal': {
          summary: { ID: 'gem-internal', Title: 'internal', NumSteps: 1, UpdatedAt: new Date().toISOString(), AppDataDir: 'antigravity-cli' },
          is_internal: true, last_modified_time: new Date().toISOString()
        }
      }
    }));
    writeFileSync(join(geminiAppDir, 'updater', 'update_status.json'),
      JSON.stringify({ success: true, message: 'Update successful, restart CLI to use' }));
    writeFileSync(join(geminiAppDir, 'settings.json'),
      JSON.stringify({ trustedWorkspaces: ['/tmp/gem-alpha', '/tmp/gem-beta'] }));
    writeFileSync(join(usageGeminiDir, 'config', 'config.json'),
      JSON.stringify({ userSettings: { remoteControlHostname: 'codium-golden-venus' } }));
    writeFileSync(join(usageGeminiDir, 'config', 'projects', 'default-cli-project.json'),
      JSON.stringify({ id: 'default-cli-project', name: 'CLI Project', projectResources: {} }));

    const usagePort = await getPort();
    const usageEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: usageConfigDir,
      BD_CONSOLE_CLAUDE_DIR: usageClaudeDir,
      BD_CONSOLE_CODEX_DIR: usageCodexDir,
      BD_CONSOLE_KIMI_DIR: usageKimiDir,
      BD_CONSOLE_GEMINI_DIR: usageGeminiDir
    };
    const usageServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(usagePort)], {
      cwd: process.cwd(), env: usageEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${usagePort}/api/meta`);
      const usageRes = await fetch(`http://127.0.0.1:${usagePort}/api/usage`);
      assert(usageRes.status === 200, `/api/usage should 200 (no token configured), got ${usageRes.status}`);
      const usageBody = await usageRes.json();
      const rawText = JSON.stringify(usageBody);
      assert(!rawText.includes(fakeAccessToken.slice(0, 12)), '/api/usage response must never contain token material');

      const claude = usageBody.providers && usageBody.providers.claude;
      assert(claude && claude.status === 'token-expired', `expired claude creds should report token-expired, got: ${JSON.stringify(claude)}`);
      assert(claude.plan === 'pro' && claude.tier === 'default', `claude token-expired result should still carry plan/tier: ${JSON.stringify(claude)}`);
      assert(Array.isArray(claude.windows) && claude.windows.length === 0, 'claude token-expired result should have empty windows');
      assert(/refresh/i.test(claude.message || ''), 'claude token-expired result should hint at refreshing Claude Code');

      const codex = usageBody.providers && usageBody.providers.codex;
      assert(codex && codex.status === 'ok', `fabricated codex session should report ok, got: ${JSON.stringify(codex)}`);
      assert(codex.plan === 'pro', `codex plan mismatch: ${JSON.stringify(codex)}`);
      assert(typeof codex.asOf === 'number' && codex.asOf > 0, 'codex result missing numeric asOf (file mtime)');
      const primary = (codex.windows || []).find((w) => w.id === 'primary');
      const secondary = (codex.windows || []).find((w) => w.id === 'secondary');
      assert(primary && primary.percent === 63.5, `codex should use the LAST token_count event, got: ${JSON.stringify(primary)}`);
      assert(primary.label === '5h', `codex primary window label should be '5h' (300 minutes), got: ${primary.label}`);
      assert(primary.resetsAt === primaryResetsAtSec * 1000, `codex primary resetsAt should be resets_at*1000, got: ${primary.resetsAt}`);
      assert(secondary && secondary.label === '7d', `codex secondary window label should be '7d' (10080 minutes), got: ${JSON.stringify(secondary)}`);
      assert(secondary.resetsAt === secondaryResetsAtSec * 1000, `codex secondary resetsAt should be resets_at*1000, got: ${secondary.resetsAt}`);

      console.log('smoke ok (usage API: fixture claude token-expired + fixture codex ok, LAST-event selection, no token material leaked)');

      // --- ?fresh=1 cache bypass (bd-console-0fg) --------------------------
      // Exercised against the expired-creds fixture, so it proves the cache
      // plumbing without ever touching the network: a repeat GET must be
      // served from cache (same fetchedAt, cached:true), ?fresh=1 must
      // recompute, and a second immediate ?fresh=1 must be refused by the
      // server-side minimum interval between fresh calls.
      const getUsage = (qs = '') => fetch(`http://127.0.0.1:${usagePort}/api/usage${qs}`).then((r) => r.json());
      const cachedBody = await getUsage();
      const cachedClaude = cachedBody.providers.claude;
      assert(cachedClaude.cached === true, `repeat /api/usage should be served from cache, got: ${JSON.stringify(cachedClaude)}`);
      assert(cachedClaude.fetchedAt === claude.fetchedAt, 'cached /api/usage should keep the original fetchedAt');

      const freshBody = await getUsage('?fresh=1');
      const freshClaude = freshBody.providers.claude;
      assert(!freshClaude.cached, `?fresh=1 should bypass the cache, got: ${JSON.stringify(freshClaude)}`);
      assert(freshClaude.fetchedAt >= claude.fetchedAt, '?fresh=1 result should be recomputed (fetchedAt not older)');
      assert(freshClaude.status === 'token-expired', `?fresh=1 must not change the fixture's status: ${JSON.stringify(freshClaude)}`);

      const fresh2Claude = (await getUsage('?fresh=1')).providers.claude;
      assert(fresh2Claude.cached === true, `a second immediate ?fresh=1 should be throttled to cache, got: ${JSON.stringify(fresh2Claude)}`);
      assert(fresh2Claude.fetchedAt === freshClaude.fetchedAt, 'throttled ?fresh=1 should return the previous computed result');

      console.log('smoke ok (usage API: ?fresh=1 bypasses the cache once, then is throttled to cache)');

      // ---- kimi block --------------------------------------------------
      const kimi = usageBody.providers && usageBody.providers.kimi;
      assert(kimi && kimi.status === 'ok', `fixture kimi dir should report ok, got: ${JSON.stringify(kimi)}`);
      assert(!rawText.includes(kimiSecret) && !rawText.includes(kimiSecret.slice(0, 16)),
        '/api/usage response must never contain ~/.kimi-code/server.token material');
      assert(Array.isArray(kimi.windows) && kimi.windows.length === 0,
        'kimi must expose no quota windows (Kimi Code publishes no rate-limit data)');

      // Freshest heartbeat wins, and it drives `state` — not the pid.
      assert(kimi.server && kimi.server.state === 'running', `fresh heartbeat should report running, got: ${JSON.stringify(kimi.server)}`);
      assert(kimi.server.version === '0.32.0' && kimi.server.port === 33333 && kimi.server.host === '0.0.0.0',
        `kimi should report the FRESH instance record, got: ${JSON.stringify(kimi.server)}`);
      assert(kimi.server.instances === 2, `kimi should count both instance records, got: ${kimi.server.instances}`);
      assert(kimi.server.staleAfterMs === 90000, `kimi staleness threshold should be documented on the payload, got: ${kimi.server.staleAfterMs}`);
      assert(typeof kimi.server.heartbeatAgeMs === 'number' && kimi.server.heartbeatAgeMs < 90000,
        `kimi heartbeatAgeMs should be fresh, got: ${kimi.server.heartbeatAgeMs}`);

      assert(kimi.sessions && kimi.sessions.total === 2,
        `kimi should count 2 well-formed session_index lines (malformed ones skipped), got: ${JSON.stringify(kimi.sessions)}`);
      const kimiAlpha = kimi.sessions.workspaces.find((w) => w.id === 'wd_alpha_aaa111');
      const kimiBeta = kimi.sessions.workspaces.find((w) => w.id === 'wd_beta_bbb222');
      assert(kimiAlpha && kimiAlpha.name === 'alpha' && kimiAlpha.sessions === 1,
        `kimi alpha workspace should take its name from workspaces.json, got: ${JSON.stringify(kimiAlpha)}`);
      assert(kimiBeta && kimiBeta.name === null && kimiBeta.root === '/tmp/beta-project',
        `kimi workspace missing from workspaces.json should fall back to its workDir, got: ${JSON.stringify(kimiBeta)}`);
      assert(kimi.sessions.workspaces[0].id === 'wd_alpha_aaa111',
        'kimi workspaces should be ordered most-recently-active first');

      const latest = kimi.latestSession;
      assert(latest && latest.id === 'session_a', `kimi latestSession should be the newest session by mtime, got: ${JSON.stringify(latest && latest.id)}`);
      assert(latest.workDir === '/tmp/alpha-project' && latest.workspaceName === 'alpha' && latest.agents === 2,
        `kimi latestSession detail mismatch: ${JSON.stringify(latest)}`);
      assert(latest.title.length === 120 && kimiLongTitle.startsWith(latest.title),
        `kimi session title should be truncated to 120 chars, got ${latest.title.length}`);
      assert(!JSON.stringify(latest).includes('do the thing'), 'kimi must not surface a session lastPrompt');
      assert(latest.tokens.input === kimiExpected.input && latest.tokens.output === kimiExpected.output
        && latest.tokens.cacheRead === kimiExpected.cacheRead && latest.tokens.cacheCreation === kimiExpected.cacheCreation
        && latest.tokens.total === kimiExpected.total,
        `kimi token totals should sum usage.record across every agent of the session, got: ${JSON.stringify(latest.tokens)}`);
      assert(latest.tokens.records === 3 && latest.tokens.turns === 2 && latest.tokens.truncated === false,
        `kimi token record/turn counts mismatch: ${JSON.stringify(latest.tokens)}`);
      assert(latest.tokens.models.length === 2 && latest.tokens.models[0].model === 'kimi-code/k3' && latest.model === 'kimi-code/k3',
        `kimi per-model breakdown should be biggest-first, got: ${JSON.stringify(latest.tokens.models)}`);

      console.log('smoke ok (usage API: kimi fixture ok — freshest instance, session/workspace rollup, cross-agent token sum, server.token never leaked)');

      // ---- gemini block --------------------------------------------------
      const gemini = usageBody.providers && usageBody.providers.gemini;
      assert(gemini && gemini.status === 'ok', `fixture gemini dir should report ok, got: ${JSON.stringify(gemini)}`);
      assert(gemini.variant === 'antigravity-cli', `gemini should name its CLI variant, got: ${gemini.variant}`);

      // The two things that must never escape: the OAuth token (which the
      // adapter must not even open) and the account email the CLI logs itself.
      const geminiRaw = JSON.stringify(gemini);
      assert(!rawText.includes(geminiSecret) && !rawText.includes(geminiSecret.slice(0, 16)),
        '/api/usage response must never contain antigravity-oauth-token material');
      assert(!rawText.includes(geminiEmail) && !rawText.includes('example.invalid') && !geminiRaw.includes('email='),
        '/api/usage response must never contain the account email the Antigravity CLI logs');

      // No gauge, ever: Gemini publishes no limit/utilization/reset anywhere.
      assert(Array.isArray(gemini.windows) && gemini.windows.length === 0,
        'gemini must expose no quota windows (Antigravity publishes no rate-limit data)');
      assert(gemini.quota && gemini.quota.published === false,
        `gemini must say outright that no quota is published, got: ${JSON.stringify(gemini.quota)}`);
      assert(gemini.quota.exhaustedEvents === 1,
        `gemini should count the RESOURCE_EXHAUSTED reply in the log, got: ${JSON.stringify(gemini.quota)}`);
      assert(gemini.quota.lastExhaustedAt === geminiExhaustedAt.getTime(),
        `gemini should date the 429 from its year-less glog stamp (expected ${geminiExhaustedAt.getTime()}), got: ${gemini.quota.lastExhaustedAt}`);

      // Header facts come from the NEWEST log; the backdated 0.0.1 one must lose.
      assert(gemini.server && gemini.server.state === 'running',
        `a just-written log plus a live pid should report running, got: ${JSON.stringify(gemini.server)}`);
      assert(gemini.server.version === '1.1.4' && gemini.server.pid === process.pid && gemini.server.pidAlive === true,
        `gemini should read the newest log's header, got: ${JSON.stringify(gemini.server)}`);
      assert(gemini.server.startedAt === geminiStartedAt.getTime(),
        `gemini startedAt should come from the log FILE NAME (glog has no year), got: ${gemini.server.startedAt}`);
      const geminiHttp = (gemini.server.ports || []).find((p) => p.protocol === 'http');
      const geminiGrpc = (gemini.server.ports || []).find((p) => p.protocol === 'grpc');
      assert(geminiHttp && geminiHttp.port === 37871 && geminiGrpc && geminiGrpc.port === 41227,
        `gemini should record both bound ports, got: ${JSON.stringify(gemini.server.ports)}`);

      // "not logged in" then a successful applyAuthResult -> the LAST transition wins.
      assert(gemini.auth && gemini.auth.state === 'signed-in' && gemini.auth.method === 'consumer',
        `gemini auth should take the last transition in the log, got: ${JSON.stringify(gemini.auth)}`);

      assert(gemini.conversations.total === 2,
        `gemini should exclude is_internal conversations, got: ${JSON.stringify(gemini.conversations.total)}`);
      const geminiLatest = gemini.conversations.latest;
      assert(geminiLatest && geminiLatest.id === 'gem-new' && geminiLatest.steps === 7 && geminiLatest.workspace === '/tmp/gem-alpha',
        `gemini latest conversation mismatch: ${JSON.stringify(geminiLatest)}`);
      assert(geminiLatest.title.length === 120 && geminiLongPreview.startsWith(geminiLatest.title),
        `an empty Title should fall back to Preview truncated to 120 chars, got ${geminiLatest.title.length}`);
      assert(gemini.conversations.byApp.length === 2 && gemini.conversations.workspaces.length === 2
        && gemini.conversations.workspaces[0].path === '/tmp/gem-alpha',
        `gemini conversations should roll up per app and per workspace, newest first: ${JSON.stringify(gemini.conversations)}`);

      assert(gemini.config.trustedWorkspaces === 2 && gemini.config.remoteHost === 'codium-golden-venus',
        `gemini config facts mismatch: ${JSON.stringify(gemini.config)}`);
      assert(gemini.config.projects.length === 1 && gemini.config.projects[0].name === 'CLI Project',
        `gemini should list declared projects, got: ${JSON.stringify(gemini.config.projects)}`);
      assert(gemini.update && gemini.update.ok === true, `gemini should report the last self-update outcome, got: ${JSON.stringify(gemini.update)}`);

      console.log('smoke ok (usage API: gemini fixture ok — newest-log header, year-less 429 dated, auth method without the email, no quota invented, oauth token never opened)');
    } finally {
      usageServer.kill('SIGTERM');
      await new Promise((resolveP) => usageServer.once('exit', () => resolveP()));
    }

    // --- missing dirs -> no-creds / no-data --------------------------------
    const usageEmptyConfigDir = join(tempRoot, 'usage-empty-config');
    const usageEmptyClaudeDir = join(tempRoot, 'usage-empty-claude'); // exists, but no .credentials.json inside
    const usageEmptyCodexDir = join(tempRoot, 'usage-empty-codex-sessions'); // does not exist at all
    mkdirSync(usageEmptyConfigDir, { recursive: true });
    mkdirSync(usageEmptyClaudeDir, { recursive: true });
    const usageEmptyPort = await getPort();
    const usageEmptyKimiDir = join(tempRoot, 'usage-empty-kimi'); // does not exist at all
    const usageEmptyGeminiDir = join(tempRoot, 'usage-empty-gemini'); // does not exist at all
    const usageEmptyEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: usageEmptyConfigDir,
      BD_CONSOLE_CLAUDE_DIR: usageEmptyClaudeDir,
      BD_CONSOLE_CODEX_DIR: usageEmptyCodexDir,
      BD_CONSOLE_KIMI_DIR: usageEmptyKimiDir,
      BD_CONSOLE_GEMINI_DIR: usageEmptyGeminiDir
    };
    const usageEmptyServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(usageEmptyPort)], {
      cwd: process.cwd(), env: usageEmptyEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${usageEmptyPort}/api/meta`);
      const emptyBody = await fetch(`http://127.0.0.1:${usageEmptyPort}/api/usage`).then((r) => r.json());
      assert(emptyBody.providers.claude.status === 'no-creds', `missing .credentials.json should report no-creds, got: ${JSON.stringify(emptyBody.providers.claude)}`);
      assert(emptyBody.providers.codex.status === 'no-data', `missing codex sessions dir should report no-data, got: ${JSON.stringify(emptyBody.providers.codex)}`);
      assert(emptyBody.providers.kimi.status === 'not-installed', `missing kimi dir should report not-installed, got: ${JSON.stringify(emptyBody.providers.kimi)}`);
      // Machines without the Antigravity CLI must produce a `gemini` block that
      // renders to nothing — status 'not-installed' and no invented gauge.
      assert(emptyBody.providers.gemini.status === 'not-installed', `missing gemini dir should report not-installed, got: ${JSON.stringify(emptyBody.providers.gemini)}`);
      assert(Array.isArray(emptyBody.providers.gemini.windows) && emptyBody.providers.gemini.windows.length === 0,
        'a not-installed gemini block must still carry an empty windows array');
      console.log('smoke ok (usage API: missing dirs -> no-creds/no-data/not-installed)');
    } finally {
      usageEmptyServer.kill('SIGTERM');
      await new Promise((resolveP) => usageEmptyServer.once('exit', () => resolveP()));
    }

    // --- kimi heartbeat staleness ------------------------------------------
    // The heartbeat — not the pid — decides whether the server counts as up. A
    // record 10 minutes past its last beat is never 'running'; the pid only
    // distinguishes 'stale' (process still there, gone quiet) from 'stopped'.
    for (const scenario of [
      { name: 'stale', pid: process.pid, expected: 'stale', expectedPidAlive: true },
      { name: 'stopped', pid: 4194304, expected: 'stopped', expectedPidAlive: false }
    ]) {
      const staleKimiDir = join(tempRoot, `usage-kimi-${scenario.name}`);
      mkdirSync(join(staleKimiDir, 'server', 'instances'), { recursive: true });
      writeFileSync(join(staleKimiDir, 'server', 'instances', '01OLD.json'), JSON.stringify({
        server_id: '01OLD', pid: scenario.pid, host: '0.0.0.0', port: 33333,
        started_at: Date.now() - 7200000, heartbeat_at: Date.now() - 600000, host_version: '0.32.0'
      }));
      const staleConfigDir = join(tempRoot, `usage-kimi-${scenario.name}-config`);
      mkdirSync(staleConfigDir, { recursive: true });
      const stalePort = await getPort();
      const staleServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(stalePort)], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BD_CONSOLE_CONFIG_DIR: staleConfigDir,
          BD_CONSOLE_CLAUDE_DIR: usageEmptyClaudeDir,
          BD_CONSOLE_CODEX_DIR: usageEmptyCodexDir,
          BD_CONSOLE_KIMI_DIR: staleKimiDir,
          BD_CONSOLE_GEMINI_DIR: usageEmptyGeminiDir
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      try {
        await waitFor(`http://127.0.0.1:${stalePort}/api/meta`);
        const staleBody = await fetch(`http://127.0.0.1:${stalePort}/api/usage`).then((r) => r.json());
        const staleKimi = staleBody.providers.kimi;
        assert(staleKimi.status === 'ok', `a kimi dir with only a stale instance is still installed, got: ${JSON.stringify(staleKimi)}`);
        assert(staleKimi.server.state === scenario.expected,
          `stale heartbeat + ${scenario.name} pid should report ${scenario.expected}, got: ${JSON.stringify(staleKimi.server)}`);
        assert(staleKimi.server.pidAlive === scenario.expectedPidAlive,
          `kimi pidAlive mismatch for the ${scenario.name} scenario: ${JSON.stringify(staleKimi.server)}`);
        assert(staleKimi.server.heartbeatAgeMs > 90000, `stale heartbeat age should exceed the threshold, got: ${staleKimi.server.heartbeatAgeMs}`);
        assert(staleKimi.sessions.total === 0 && staleKimi.latestSession === null,
          `a kimi dir with no session_index should report zero sessions, got: ${JSON.stringify(staleKimi.sessions)}`);
        console.log(`smoke ok (usage API: kimi stale heartbeat -> ${scenario.expected})`);
      } finally {
        staleServer.kill('SIGTERM');
        await new Promise((resolveP) => staleServer.once('exit', () => resolveP()));
      }
    }

    // --- token-gated the same way /api/tmux/preview is ---------------------
    const usageAuthConfigDir = join(tempRoot, 'usage-auth-config');
    mkdirSync(usageAuthConfigDir, { recursive: true });
    const usageAuthPort = await getPort();
    const usageAuthEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: usageAuthConfigDir,
      BD_CONSOLE_TOKEN: 'usage-smoke-token',
      BD_CONSOLE_CLAUDE_DIR: usageEmptyClaudeDir,
      BD_CONSOLE_CODEX_DIR: usageEmptyCodexDir,
      BD_CONSOLE_KIMI_DIR: usageEmptyKimiDir,
      BD_CONSOLE_GEMINI_DIR: usageEmptyGeminiDir
    };
    const usageAuthServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(usageAuthPort)], {
      cwd: process.cwd(), env: usageAuthEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${usageAuthPort}/api/meta`);
      const noAuthRes = await fetch(`http://127.0.0.1:${usageAuthPort}/api/usage`);
      assert(noAuthRes.status === 401, `/api/usage without a token should 401 when a token is configured, got ${noAuthRes.status}`);
      const withAuthRes = await fetch(`http://127.0.0.1:${usageAuthPort}/api/usage`, { headers: { 'x-bd-token': 'usage-smoke-token' } });
      assert(withAuthRes.status === 200, `/api/usage with the correct token should 200, got ${withAuthRes.status}`);
      console.log('smoke ok (usage API: token-gated like /api/tmux/preview)');
    } finally {
      usageAuthServer.kill('SIGTERM');
      await new Promise((resolveP) => usageAuthServer.once('exit', () => resolveP()));
    }

    // --- gemini installed-but-idle -> no-data ------------------------------
    // The CLI's app-data dir exists (so it IS installed) but it has never
    // logged or held a conversation. That must be 'no-data', not 'ok' with an
    // empty everything and not 'not-installed' — the row says "installed · no
    // sessions yet", exactly like the kimi row's equivalent state.
    const bareGeminiDir = join(tempRoot, 'usage-gemini-bare');
    mkdirSync(join(bareGeminiDir, 'antigravity-cli'), { recursive: true });
    const bareGeminiConfigDir = join(tempRoot, 'usage-gemini-bare-config');
    mkdirSync(bareGeminiConfigDir, { recursive: true });
    const bareGeminiPort = await getPort();
    const bareGeminiServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(bareGeminiPort)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BD_CONSOLE_CONFIG_DIR: bareGeminiConfigDir,
        BD_CONSOLE_CLAUDE_DIR: usageEmptyClaudeDir,
        BD_CONSOLE_CODEX_DIR: usageEmptyCodexDir,
        BD_CONSOLE_KIMI_DIR: usageEmptyKimiDir,
        BD_CONSOLE_GEMINI_DIR: bareGeminiDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${bareGeminiPort}/api/meta`);
      const bareBody = await fetch(`http://127.0.0.1:${bareGeminiPort}/api/usage`).then((r) => r.json());
      const bareGemini = bareBody.providers.gemini;
      assert(bareGemini.status === 'no-data', `an empty antigravity-cli dir should report no-data, got: ${JSON.stringify(bareGemini)}`);
      assert(bareGemini.server === null && bareGemini.conversations.total === 0,
        `a bare gemini dir should report no server and no conversations, got: ${JSON.stringify(bareGemini)}`);
      assert(bareGemini.quota.exhaustedEvents === 0 && bareGemini.quota.lastExhaustedAt === null,
        `a bare gemini dir must not invent quota events, got: ${JSON.stringify(bareGemini.quota)}`);
      console.log('smoke ok (usage API: gemini installed-but-idle -> no-data)');
    } finally {
      bareGeminiServer.kill('SIGTERM');
      await new Promise((resolveP) => bareGeminiServer.once('exit', () => resolveP()));
    }
  }

  // --- scopedLimits parsing (lib/usage.mjs, pure function) -------------------
  // Not directly testable end-to-end without the live OAuth usage endpoint
  // (real network) — unit-test the pure mapping helper instead: a fabricated
  // weekly_scoped entry (has scope.model) must map through; scope:null
  // entries (session/weekly_all) must be ignored.
  {
    const fabricatedLimits = [
      {
        kind: 'weekly_scoped', group: 'weekly', percent: 87, severity: 'warning',
        resets_at: '2026-08-01T00:00:00.000Z', is_active: true,
        scope: { model: { id: 'claude-fable-5', display_name: 'Fable' }, surface: 'api' }
      },
      {
        kind: 'session', group: 'session', percent: 40, severity: 'info',
        resets_at: '2026-07-20T00:00:00.000Z', is_active: true,
        scope: null
      },
      {
        kind: 'weekly_all', group: 'weekly', percent: 55, severity: 'warning',
        resets_at: '2026-07-25T00:00:00.000Z', is_active: false,
        scope: null
      }
    ];
    const parsed = parseScopedLimits(fabricatedLimits);
    assert(Array.isArray(parsed) && parsed.length === 1, `parseScopedLimits should keep only the scoped entry, got: ${JSON.stringify(parsed)}`);
    assert(parsed[0].model === 'Fable', `parseScopedLimits model mismatch: ${JSON.stringify(parsed[0])}`);
    assert(parsed[0].percent === 87, `parseScopedLimits percent mismatch: ${JSON.stringify(parsed[0])}`);
    assert(parsed[0].severity === 'warning', `parseScopedLimits severity mismatch: ${JSON.stringify(parsed[0])}`);
    assert(parsed[0].resetsAt === new Date('2026-08-01T00:00:00.000Z').getTime(), `parseScopedLimits resetsAt mismatch: ${JSON.stringify(parsed[0])}`);
    assert(parsed[0].active === true, `parseScopedLimits active mismatch: ${JSON.stringify(parsed[0])}`);
    assert(parseScopedLimits(null).length === 0, 'parseScopedLimits(null) should return []');
    assert(parseScopedLimits(undefined).length === 0, 'parseScopedLimits(undefined) should return []');
    assert(parseScopedLimits([]).length === 0, 'parseScopedLimits([]) should return []');
    console.log('smoke ok (parseScopedLimits: maps scoped entry, ignores scope:null entries)');
  }

  // --- 429 backoff beats ?fresh=1 (lib/usage.mjs, in-process) ---------------
  // The one usage behavior that can't be reached through the fixture servers
  // above (they never get as far as a network call), so it's driven in-process
  // with a stubbed global fetch: getClaudeUsage() calls the global, so
  // swapping it lets us fabricate a 429 and COUNT upstream attempts. The
  // contract under test is the whole point of bd-console-0fg: once we've been
  // rate-limited, an explicit human refresh must NOT produce another upstream
  // call — it gets the cached answer, flagged, with a retryAt.
  {
    const rlClaudeDir = join(tempRoot, 'usage-429-claude');
    mkdirSync(rlClaudeDir, { recursive: true });
    writeFileSync(join(rlClaudeDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-SMOKE-429-FIXTURE-DO-NOT-USE',
        refreshToken: 'fake-refresh-token-do-not-use',
        expiresAt: Date.now() + 3600_000, // valid, so the adapter reaches the (stubbed) fetch
        subscriptionType: 'pro',
        rateLimitTier: 'default'
      }
    }));

    const prevClaudeDir = process.env.BD_CONSOLE_CLAUDE_DIR;
    const realFetch = globalThis.fetch;
    process.env.BD_CONSOLE_CLAUDE_DIR = rlClaudeDir;
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response('{"error":"rate_limited"}', { status: 429 });
    };
    try {
      const limited = await getClaudeUsage();
      assert(limited.status === 'rate-limited', `a 429 should map to status rate-limited, got: ${JSON.stringify(limited)}`);
      assert(upstreamCalls === 1, `expected exactly 1 upstream attempt, got ${upstreamCalls}`);
      assert(typeof limited.retryAt === 'number' && (limited.retryAt - Date.now()) >= 10 * 60_000,
        `429 backoff should be at least 10 minutes, got retryAt in ${(limited.retryAt - Date.now()) / 60000}m`);

      const duringBackoff = await getClaudeUsage({ fresh: true });
      assert(upstreamCalls === 1, `fresh=1 must not hit upstream during a 429 backoff (upstream calls: ${upstreamCalls})`);
      assert(duringBackoff.status === 'rate-limited' && duringBackoff.cached === true,
        `fresh=1 during backoff should return the cached rate-limited result: ${JSON.stringify(duringBackoff)}`);
      assert(duringBackoff.retryAt === limited.retryAt, 'cached rate-limited result should keep the same retryAt');

      const polled = await getClaudeUsage();
      assert(upstreamCalls === 1, `a normal poll must not hit upstream during a 429 backoff (upstream calls: ${upstreamCalls})`);
      assert(polled.cached === true, 'poll during backoff should be flagged cached');

      console.log('smoke ok (usage adapter: 429 -> >=10m backoff, honored even for fresh=1)');
    } finally {
      globalThis.fetch = realFetch;
      if (prevClaudeDir === undefined) delete process.env.BD_CONSOLE_CLAUDE_DIR;
      else process.env.BD_CONSOLE_CLAUDE_DIR = prevClaudeDir;
    }
  }

  // --- usage history (lib/usage-history.mjs via GET /api/usage/history) ------
  // Fixture-only: fabricated transcript files under a temp BD_CONSOLE_CLAUDE_DIR
  // — never the real ~/.claude or ~/.codex, never the network.
  {
    const histConfigDir = join(tempRoot, 'history-config');
    const histClaudeDir = join(tempRoot, 'history-claude');
    const histCodexDir = join(tempRoot, 'history-codex-sessions'); // left empty/nonexistent
    mkdirSync(histConfigDir, { recursive: true });
    const histProjectDir = join(histClaudeDir, 'projects', '-x-proj');
    mkdirSync(histProjectDir, { recursive: true });

    const histNow = Date.now();
    const HIST_DAY_MS = 24 * 60 * 60 * 1000;
    const ts1 = histNow - 1 * HIST_DAY_MS;  // model-a, in range, in "current" 7d period
    const ts2 = histNow - 2 * HIST_DAY_MS;  // model-b, in range, in "current" 7d period
    const ts3 = histNow - 35 * HIST_DAY_MS; // model-a, OUTSIDE the default 30-day window -> must be excluded

    const histRecord = (ts, model, usage) => JSON.stringify({
      timestamp: new Date(ts).toISOString(),
      message: { model, usage }
    });

    const histLines = [
      histRecord(ts1, 'model-a', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }), // total 165
      histRecord(ts2, 'model-b', { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), // total 300
      histRecord(ts3, 'model-a', { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) // excluded (>30d old)
    ];
    writeFileSync(join(histProjectDir, 't.jsonl'), histLines.join('\n') + '\n');

    const histPort = await getPort();
    const histEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: histConfigDir,
      BD_CONSOLE_CLAUDE_DIR: histClaudeDir,
      BD_CONSOLE_CODEX_DIR: histCodexDir
    };
    const histServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(histPort)], {
      cwd: process.cwd(), env: histEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${histPort}/api/meta`);

      const histRes = await fetch(`http://127.0.0.1:${histPort}/api/usage/history`);
      assert(histRes.status === 200, `/api/usage/history should 200, got ${histRes.status}`);
      const hist = await histRes.json();

      assert(typeof hist.generatedAt === 'number', '/api/usage/history missing numeric generatedAt');
      assert(hist.range && typeof hist.range.from === 'number' && typeof hist.range.to === 'number', '/api/usage/history missing numeric range.from/to');

      const claude = hist.claude;
      assert(claude && claude.available === true, `claude history should be available: ${JSON.stringify(claude)}`);
      assert(claude.totalTokens === 465, `claude totalTokens should exclude the >30d-old record (165+300=465), got ${claude.totalTokens}`);
      assert(claude.messages === 2, `claude messages should be 2 (one record excluded), got ${claude.messages}`);

      assert(Array.isArray(claude.byModel) && claude.byModel.length === 2, `claude byModel should have 2 entries, got: ${JSON.stringify(claude.byModel)}`);
      assert(claude.byModel[0].model === 'model-b' && claude.byModel[0].tokens === 300, `claude byModel should be sorted desc by tokens (model-b first): ${JSON.stringify(claude.byModel)}`);
      assert(claude.byModel[1].model === 'model-a' && claude.byModel[1].tokens === 165, `claude byModel model-a mismatch: ${JSON.stringify(claude.byModel)}`);
      assert(
        claude.byModel[1].input === 100 && claude.byModel[1].output === 50 && claude.byModel[1].cacheRead === 10 && claude.byModel[1].cacheCreate === 5,
        `claude byModel model-a token breakdown mismatch: ${JSON.stringify(claude.byModel[1])}`
      );

      assert(Array.isArray(claude.byProject) && claude.byProject.length === 1, `claude byProject should have 1 entry, got: ${JSON.stringify(claude.byProject)}`);
      assert(claude.byProject[0].project === '-x-proj' && claude.byProject[0].tokens === 465 && claude.byProject[0].messages === 2, `claude byProject mismatch: ${JSON.stringify(claude.byProject)}`);
      assert(typeof claude.byProject[0].name === 'string' && claude.byProject[0].name, 'claude byProject entry missing readable name');

      assert(Array.isArray(claude.byProjectModel) && claude.byProjectModel.length === 2, `claude byProjectModel should have 2 entries, got: ${JSON.stringify(claude.byProjectModel)}`);
      const pm300 = claude.byProjectModel.find((e) => e.model === 'model-b');
      const pm165 = claude.byProjectModel.find((e) => e.model === 'model-a');
      assert(pm300 && pm300.project === '-x-proj' && pm300.tokens === 300, `claude byProjectModel model-b mismatch: ${JSON.stringify(claude.byProjectModel)}`);
      assert(pm165 && pm165.project === '-x-proj' && pm165.tokens === 165, `claude byProjectModel model-a mismatch: ${JSON.stringify(claude.byProjectModel)}`);

      const histDateKey = (ts) => new Date(ts).toISOString().slice(0, 10);
      assert(Array.isArray(claude.daily) && claude.daily.length === 2, `claude daily should have 2 entries, got: ${JSON.stringify(claude.daily)}`);
      assert(claude.daily[0].date <= claude.daily[1].date, 'claude daily should be ascending by date');
      const day1 = claude.daily.find((d) => d.date === histDateKey(ts1));
      const day2 = claude.daily.find((d) => d.date === histDateKey(ts2));
      assert(day1 && day1.byModel['model-a'] === 165, `claude daily missing/mismatched model-a entry: ${JSON.stringify(claude.daily)}`);
      assert(day2 && day2.byModel['model-b'] === 300, `claude daily missing/mismatched model-b entry: ${JSON.stringify(claude.daily)}`);

      assert(claude.periods && claude.periods.current.tokens === 465 && claude.periods.current.messages === 2, `claude periods.current mismatch: ${JSON.stringify(claude.periods)}`);
      assert(claude.periods.previous.tokens === 0 && claude.periods.previous.messages === 0, `claude periods.previous mismatch: ${JSON.stringify(claude.periods)}`);
      assert(claude.periods.current.windowDays === 7 && claude.periods.previous.windowDays === 7, `claude periods windowDays should be 7: ${JSON.stringify(claude.periods)}`);

      assert(hist.codex && typeof hist.codex.available === 'boolean', '/api/usage/history codex missing boolean available');

      console.log(`smoke ok (usage history: byModel/byProject/daily/periods math, >30d record excluded): totalTokens=${claude.totalTokens}`);
    } finally {
      histServer.kill('SIGTERM');
      await new Promise((resolveP) => histServer.once('exit', () => resolveP()));
    }

    // --- missing claude dir -> available:false ------------------------------
    const histMissingConfigDir = join(tempRoot, 'history-missing-config');
    const histMissingClaudeDir = join(tempRoot, 'history-missing-claude'); // never created
    mkdirSync(histMissingConfigDir, { recursive: true });
    const histMissingPort = await getPort();
    const histMissingEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: histMissingConfigDir,
      BD_CONSOLE_CLAUDE_DIR: histMissingClaudeDir,
      BD_CONSOLE_CODEX_DIR: histCodexDir
    };
    const histMissingServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(histMissingPort)], {
      cwd: process.cwd(), env: histMissingEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${histMissingPort}/api/meta`);
      const missingBody = await fetch(`http://127.0.0.1:${histMissingPort}/api/usage/history`).then((r) => r.json());
      assert(missingBody.claude.available === false, `missing claude dir should report available:false, got: ${JSON.stringify(missingBody.claude)}`);
      console.log('smoke ok (usage history: missing claude dir -> available:false)');
    } finally {
      histMissingServer.kill('SIGTERM');
      await new Promise((resolveP) => histMissingServer.once('exit', () => resolveP()));
    }

    // --- token-gated the same way /api/usage is -----------------------------
    const histAuthConfigDir = join(tempRoot, 'history-auth-config');
    mkdirSync(histAuthConfigDir, { recursive: true });
    const histAuthPort = await getPort();
    const histAuthEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: histAuthConfigDir,
      BD_CONSOLE_TOKEN: 'history-smoke-token',
      BD_CONSOLE_CLAUDE_DIR: histMissingClaudeDir,
      BD_CONSOLE_CODEX_DIR: histCodexDir
    };
    const histAuthServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(histAuthPort)], {
      cwd: process.cwd(), env: histAuthEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${histAuthPort}/api/meta`);
      const noAuthRes = await fetch(`http://127.0.0.1:${histAuthPort}/api/usage/history`);
      assert(noAuthRes.status === 401, `/api/usage/history without a token should 401 when a token is configured, got ${noAuthRes.status}`);
      const withAuthRes = await fetch(`http://127.0.0.1:${histAuthPort}/api/usage/history`, { headers: { 'x-bd-token': 'history-smoke-token' } });
      assert(withAuthRes.status === 200, `/api/usage/history with the correct token should 200, got ${withAuthRes.status}`);
      console.log('smoke ok (usage history: token-gated like /api/usage)');
    } finally {
      histAuthServer.kill('SIGTERM');
      await new Promise((resolveP) => histAuthServer.once('exit', () => resolveP()));
    }
  }

  // --- bd (beads CLI) version check (lib/bdversion.mjs + GET /api/bd-version)
  // Pure-function assertions first (no server, no network), then the live
  // route against the real installed `bd`, with the GitHub lookup redirected
  // via BD_CONSOLE_GITHUB_API_BASE — either at an unroutable port (offline)
  // or a local stub server (fabricated "behind" release) — never the real
  // GitHub API, so this suite is offline-safe and never touches the real
  // 60/hr/IP rate limit.
  {
    // --- pure: `bd version` stdout parsing ---------------------------------
    assert(parseBdVersionStdout('bd version 1.1.0 (8e4e59d39: HEAD@8e4e59d39f34)\n') === '1.1.0',
      'parseBdVersionStdout should extract the version out of real bd stdout');
    assert(parseBdVersionStdout('bd version v2.0.0-beta.1 (abc: HEAD)') === '2.0.0-beta.1',
      'parseBdVersionStdout should tolerate a v-prefixed, pre-release version');
    assert(parseBdVersionStdout('garbage, no version here') === null,
      'parseBdVersionStdout should return null on malformed stdout');
    assert(parseBdVersionStdout('') === null, 'parseBdVersionStdout should return null on empty stdout');
    assert(parseBdVersionStdout(null) === null, 'parseBdVersionStdout should return null on null stdout');

    // --- pure: version compare / behind -------------------------------------
    assert(compareVersions('v1.2.0', '1.2.0') === 0, 'compareVersions should ignore a v prefix');
    assert(compareVersions('1.1.0', '1.2.0') === -1, 'compareVersions should report installed < latest as -1');
    assert(compareVersions('1.3.0', '1.2.0') === 1, 'compareVersions should report installed > latest as 1');
    assert(compareVersions('abc', '1.2.0') === null, 'compareVersions should return null for an unparseable version');
    assert(compareVersions('1.2.0', null) === null, 'compareVersions should return null when one side is missing');

    assert(isBehind('1.1.0', '1.2.0') === true, 'isBehind should be true when installed < latest');
    assert(isBehind('1.2.0', '1.2.0') === false, 'isBehind should be false on an EXACT match (never nag)');
    assert(isBehind('1.3.0', '1.2.0') === false, 'isBehind should be false when installed is NEWER than latest (never nag a pre-release runner)');
    assert(isBehind(null, '1.2.0') === null, 'isBehind should be null when installed is unknown');
    assert(isBehind('1.2.0', null) === null, 'isBehind should be null when latest is unknown');

    console.log('smoke ok (bd version: stdout parsing + version compare — v-prefix/equal/behind/ahead/malformed/null)');

    // --- API: real bd, GitHub lookup pointed at an unreachable port --------
    // Nothing listens on 127.0.0.1:1 — connections fail immediately
    // (ECONNREFUSED) rather than needing a slow black-hole-route timeout,
    // simulating "offline" cheaply. Must never throw, and must never lose
    // the local "installed" fact just because the network is unreachable.
    const bdvConfigDir = join(tempRoot, 'bdversion-offline-config');
    mkdirSync(bdvConfigDir, { recursive: true });
    const bdvPort = await getPort();
    const bdvEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: bdvConfigDir,
      BD_CONSOLE_GITHUB_API_BASE: 'http://127.0.0.1:1'
    };
    const bdvServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(bdvPort)], {
      cwd: process.cwd(), env: bdvEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${bdvPort}/api/meta`);
      const res = await fetch(`http://127.0.0.1:${bdvPort}/api/bd-version`);
      assert(res.status === 200, `/api/bd-version should 200, got ${res.status}`);
      const body = await res.json();
      assert(typeof body.installed === 'string' && body.installed, `/api/bd-version should report a non-null installed version on this machine, got: ${JSON.stringify(body)}`);
      assert(body.latest === null, `/api/bd-version should report latest:null when GitHub is unreachable, got: ${JSON.stringify(body.latest)}`);
      assert(body.latestSource === null, `/api/bd-version latestSource should be null when GitHub is unreachable, got: ${body.latestSource}`);
      assert(body.behind === null, `/api/bd-version behind should be null when latest is unknown, got: ${body.behind}`);
      assert(Array.isArray(body.binaries) && body.binaries.length > 0, `/api/bd-version should list at least one bd binary, got: ${JSON.stringify(body.binaries)}`);
      assert(typeof body.multipleBinaries === 'boolean', '/api/bd-version missing boolean multipleBinaries');
      assert(['brew', 'npm', 'script', 'unknown'].includes(body.installFlavor), `/api/bd-version installFlavor should be one of the known flavors, got: ${body.installFlavor}`);
      assert(typeof body.checkedAt === 'number' && body.checkedAt > 0, '/api/bd-version missing numeric checkedAt');
      console.log(`smoke ok (bd version API: offline GitHub -> installed=${body.installed} still reported, latest:null, never throws)`);
    } finally {
      bdvServer.kill('SIGTERM');
      await new Promise((resolveP) => bdvServer.once('exit', () => resolveP()));
    }

    // --- API: stub GitHub -> "behind" + update hint + cache reuse ----------
    let stubHits = 0;
    const stubTag = 'v99.0.0';
    const stub = createServer((req, res) => {
      if (req.url === '/repos/gastownhall/beads/releases/latest') {
        stubHits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tag_name: stubTag }));
      } else {
        res.writeHead(404); res.end('{}');
      }
    });
    const stubPort = await getPort();
    await new Promise((resolveP) => stub.listen(stubPort, '127.0.0.1', resolveP));
    try {
      const bdvBehindConfigDir = join(tempRoot, 'bdversion-behind-config');
      mkdirSync(bdvBehindConfigDir, { recursive: true });
      const bdvBehindPort = await getPort();
      const bdvBehindEnv = {
        ...process.env,
        BD_CONSOLE_CONFIG_DIR: bdvBehindConfigDir,
        BD_CONSOLE_GITHUB_API_BASE: `http://127.0.0.1:${stubPort}`
      };
      const bdvBehindServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(bdvBehindPort)], {
        cwd: process.cwd(), env: bdvBehindEnv, stdio: ['ignore', 'pipe', 'pipe']
      });
      try {
        await waitFor(`http://127.0.0.1:${bdvBehindPort}/api/meta`);
        const res1 = await fetch(`http://127.0.0.1:${bdvBehindPort}/api/bd-version`);
        const body1 = await res1.json();
        assert(body1.latest === '99.0.0', `/api/bd-version should normalize the v-prefixed tag, got: ${JSON.stringify(body1.latest)}`);
        assert(body1.latestSource === 'github', `first call should hit the stub GitHub server (source: 'github'), got: ${body1.latestSource}`);
        assert(body1.behind === true, `installed (real bd, ~1.x) should be behind the fabricated v99.0.0, got: ${JSON.stringify(body1)}`);
        assert(typeof body1.updateHint === 'string' && body1.updateHint.length > 0, `/api/bd-version should offer an updateHint when behind, got: ${body1.updateHint}`);

        const res2 = await fetch(`http://127.0.0.1:${bdvBehindPort}/api/bd-version`);
        const body2 = await res2.json();
        assert(body2.latestSource === 'cache', `a second call within the TTL should be served from cache, got: ${body2.latestSource}`);
        assert(stubHits === 1, `stub GitHub server should have been hit exactly once (second call cached), got ${stubHits} hits`);

        console.log('smoke ok (bd version API: fabricated newer release -> behind:true, updateHint present, second call served from cache)');
      } finally {
        bdvBehindServer.kill('SIGTERM');
        await new Promise((resolveP) => bdvBehindServer.once('exit', () => resolveP()));
      }
    } finally {
      await new Promise((resolveP) => stub.close(resolveP));
    }

    // --- token-gated the same way /api/usage is -----------------------------
    const bdvAuthConfigDir = join(tempRoot, 'bdversion-auth-config');
    mkdirSync(bdvAuthConfigDir, { recursive: true });
    const bdvAuthPort = await getPort();
    const bdvAuthEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: bdvAuthConfigDir,
      BD_CONSOLE_TOKEN: 'bdversion-smoke-token',
      BD_CONSOLE_GITHUB_API_BASE: 'http://127.0.0.1:1'
    };
    const bdvAuthServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(bdvAuthPort)], {
      cwd: process.cwd(), env: bdvAuthEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${bdvAuthPort}/api/meta`);
      const noAuthRes = await fetch(`http://127.0.0.1:${bdvAuthPort}/api/bd-version`);
      assert(noAuthRes.status === 401, `/api/bd-version without a token should 401 when a token is configured, got ${noAuthRes.status}`);
      const withAuthRes = await fetch(`http://127.0.0.1:${bdvAuthPort}/api/bd-version`, { headers: { 'x-bd-token': 'bdversion-smoke-token' } });
      assert(withAuthRes.status === 200, `/api/bd-version with the correct token should 200, got ${withAuthRes.status}`);
      console.log('smoke ok (bd version API: token-gated like /api/usage)');
    } finally {
      bdvAuthServer.kill('SIGTERM');
      await new Promise((resolveP) => bdvAuthServer.once('exit', () => resolveP()));
    }
  }

  // --- Claude Code / Codex CLI version check (lib/cliversions.mjs +
  // GET /api/cli-versions) --------------------------------------------------
  // Same shape as the bd version suite above: pure-function assertions first
  // (no server, no network), then the live route against the real installed
  // `claude`/`codex`, with the npm registry lookup redirected via
  // BD_CONSOLE_NPM_REGISTRY_BASE at an unroutable port — never the real npm
  // registry, so this suite is offline-safe.
  {
    // --- pure: `--version` stdout parsing -----------------------------------
    assert(parseCliVersionStdout('2.1.220 (Claude Code)') === '2.1.220',
      'parseCliVersionStdout should extract the version out of real `claude --version` stdout');
    assert(parseCliVersionStdout('codex-cli 0.144.1') === '0.144.1',
      'parseCliVersionStdout should extract the version out of real `codex --version` stdout, ignoring the codex-cli prefix');
    assert(parseCliVersionStdout('v1.2.3') === '1.2.3',
      'parseCliVersionStdout should tolerate a v-prefixed version');
    assert(parseCliVersionStdout('garbage, no version here') === null,
      'parseCliVersionStdout should return null on malformed stdout');
    assert(parseCliVersionStdout('') === null, 'parseCliVersionStdout should return null on empty stdout');
    assert(parseCliVersionStdout(null) === null, 'parseCliVersionStdout should return null on null stdout');
    console.log('smoke ok (cli versions: --version stdout parsing — plain/prefixed/v-prefixed/malformed/empty/null)');

    // --- API: real claude/codex, npm registry lookup pointed at an
    // unreachable port ------------------------------------------------------
    // Nothing listens on 127.0.0.1:1 — connections fail immediately
    // (ECONNREFUSED) rather than needing a slow black-hole-route timeout,
    // simulating "offline" cheaply. Must never throw, and must never lose
    // the local "installed" fact just because the network is unreachable.
    const clivConfigDir = join(tempRoot, 'cliversions-offline-config');
    mkdirSync(clivConfigDir, { recursive: true });
    const clivPort = await getPort();
    const clivEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: clivConfigDir,
      BD_CONSOLE_NPM_REGISTRY_BASE: 'http://127.0.0.1:1'
    };
    const clivServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(clivPort)], {
      cwd: process.cwd(), env: clivEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${clivPort}/api/meta`);
      const res = await fetch(`http://127.0.0.1:${clivPort}/api/cli-versions`);
      assert(res.status === 200, `/api/cli-versions should 200, got ${res.status}`);
      const body = await res.json();
      assert(body && body.tools && typeof body.tools === 'object',
        `/api/cli-versions should return a tools object, got: ${JSON.stringify(body)}`);
      for (const tool of ['claude', 'codex']) {
        const info = body.tools[tool];
        assert(info, `/api/cli-versions tools should include "${tool}", got: ${JSON.stringify(body.tools)}`);
        assert(info.tool === tool, `${tool} info.tool should echo the tool key, got: ${info.tool}`);
        assert(typeof info.label === 'string' && info.label,
          `${tool} info should have a non-empty label, got: ${JSON.stringify(info.label)}`);
        assert(info.latest === null, `${tool} latest should be null when the npm registry is unreachable, got: ${JSON.stringify(info.latest)}`);
        assert(info.latestSource === null, `${tool} latestSource should be null when the npm registry is unreachable, got: ${info.latestSource}`);
        assert(info.behind === null, `${tool} behind should be null when latest is unknown, got: ${info.behind}`);
        assert(Array.isArray(info.binaries), `${tool} info.binaries should be an array, got: ${JSON.stringify(info.binaries)}`);
        assert(typeof info.multipleBinaries === 'boolean', `${tool} info missing boolean multipleBinaries`);
        assert(typeof info.checkedAt === 'number' && info.checkedAt > 0, `${tool} info missing numeric checkedAt`);
        assert('installed' in info && 'installFlavor' in info && 'updateHint' in info && 'error' in info,
          `${tool} info should have the full field set, got: ${JSON.stringify(Object.keys(info))}`);
      }
      console.log(`smoke ok (cli versions API: offline npm registry -> claude installed=${body.tools.claude.installed}, codex installed=${body.tools.codex.installed}, latest:null both, never throws)`);
    } finally {
      clivServer.kill('SIGTERM');
      await new Promise((resolveP) => clivServer.once('exit', () => resolveP()));
    }
  }

  // --- Phase 2: MapView edge-model split (layoutEdges vs overlayEdges) -----
  // Pure, fixture-driven — buildGraph() is signal/store-free (a plain issues
  // array in, a plain object out — see public/ui/console2/graphModel.js), so
  // this pins the load-bearing constraint from docs/beads-coverage.md Phase 2
  // directly, with no server/daemon/bd involved: non-blocking link types
  // must NEVER reach layoutEdges (the layering/critical-chain input) — every
  // other present type must be routed to overlayEdges instead, tagged with
  // its type, deduped for the bidirectional related/relates-to pair, and
  // restricted to endpoints buildGraph actually placed (closed issues never
  // become nodes, so an edge touching one must not leak into either set).
  {
    const gmIssues = [
      { id: 'g-a', status: 'open', priority: 2, dependencies: [] },
      { id: 'g-b', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-b', depends_on_id: 'g-a', type: 'blocks' }] },
      { id: 'g-c', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-c', depends_on_id: 'g-b', type: 'blocks' }] },
      { id: 'g-d', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-d', depends_on_id: 'g-a', type: 'related' }] },
      { id: 'g-e', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-e', depends_on_id: 'g-d', type: 'relates-to' }] },
      { id: 'g-f', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-f', depends_on_id: 'g-a', type: 'discovered-from' }] },
      { id: 'g-g', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-g', depends_on_id: 'g-a', type: 'tracks' }] },
      // closed: its outbound related row must not leak into either edge set
      // (buildGraph/graphLayout only ever place non-closed issues as nodes).
      { id: 'g-h', status: 'closed', priority: 2, dependencies: [{ issue_id: 'g-h', depends_on_id: 'g-a', type: 'related' }] },
    ];
    const graph = buildGraph(gmIssues);

    assert(graph.nodes.every((n) => n.issue.status !== 'closed'), 'buildGraph must never place a closed issue as a node');
    assert(!graph.nodes.some((n) => n.id === 'g-h'), 'a closed issue must not appear as a node');

    const layoutPairs = graph.layoutEdges.map((e) => e.from + '->' + e.to).sort();
    assert(JSON.stringify(layoutPairs) === JSON.stringify(['g-a->g-b', 'g-b->g-c']),
      `layoutEdges must contain ONLY the blocking chain; got ${JSON.stringify(layoutPairs)}`);
    // THE regression this pins: a non-blocking-typed edge must never reach layoutEdges.
    const nonBlockingIds = ['g-d', 'g-e', 'g-f', 'g-g'];
    assert(!graph.layoutEdges.some((e) => nonBlockingIds.includes(e.from) || nonBlockingIds.includes(e.to)),
      `a non-blocking-typed issue must never appear on a layoutEdges endpoint; got ${JSON.stringify(layoutPairs)}`);

    const overlayByType = {};
    for (const e of graph.overlayEdges) (overlayByType[e.type] || (overlayByType[e.type] = [])).push(e.from + '->' + e.to);
    assert((overlayByType.related || []).length === 2, `expected 2 deduped related overlay edges, got ${JSON.stringify(overlayByType.related)}`);
    assert((overlayByType.related || []).includes('g-a->g-d'), `related overlay edge g-a<->g-d missing; got ${JSON.stringify(overlayByType.related)}`);
    assert((overlayByType.related || []).includes('g-d->g-e'),
      `related/relates-to must fold into one deduped "related" overlay edge; got ${JSON.stringify(overlayByType.related)}`);
    assert((overlayByType['discovered-from'] || []).includes('g-f->g-a'), 'discovered-from overlay edge missing');
    assert((overlayByType['tracks'] || []).includes('g-g->g-a'), 'tracks overlay edge missing');
    assert(!('blocks' in overlayByType), 'overlayEdges must never contain a blocking-typed edge');
    assert(!graph.overlayEdges.some((e) => e.from === 'g-h' || e.to === 'g-h'), 'a closed issue must not appear on any overlay edge');

    console.log(`smoke ok (graph edge model: layoutEdges excludes non-blocking types, related deduped): ${layoutPairs.join(',')}`);
  }

  // --- Large-project Map/Docs scopes (bd-console-7wn.6) -------------------
  {
    const scopeIssues = [
      { id: 's-epic', title: 'Checkout epic', issue_type: 'epic', status: 'open', priority: 2, dependencies: [] },
      { id: 's-active', title: 'Active checkout work', issue_type: 'task', status: 'in_progress', priority: 2, dependencies: [
        { issue_id: 's-active', depends_on_id: 's-epic', type: 'parent-child' },
        { issue_id: 's-active', depends_on_id: 's-blocker', type: 'blocks' }] },
      { id: 's-blocker', title: 'Required migration', issue_type: 'task', status: 'open', priority: 3, dependencies: [] },
      { id: 's-next', title: 'Follows active work', issue_type: 'task', status: 'open', priority: 3, dependencies: [
        { issue_id: 's-next', depends_on_id: 's-epic', type: 'parent-child' },
        { issue_id: 's-next', depends_on_id: 's-active', type: 'blocks' }] },
      { id: 's-urgent', title: 'Urgent independent work', issue_type: 'bug', status: 'open', priority: 1, dependencies: [] },
      { id: 's-noise', title: 'Unrelated backlog', issue_type: 'task', status: 'open', priority: 4, dependencies: [] },
      { id: 's-done', title: 'Closed history', issue_type: 'task', status: 'closed', priority: 0, dependencies: [] },
    ];
    const currentIds = mapScopeIssues(scopeIssues, 'current').map((i) => i.id);
    for (const id of ['s-active', 's-blocker', 's-next', 's-urgent', 's-epic']) {
      assert(currentIds.includes(id), `current map scope should preserve active/urgent context ${id}; got ${JSON.stringify(currentIds)}`);
    }
    assert(!currentIds.includes('s-noise') && !currentIds.includes('s-done'),
      `current map scope should omit unrelated backlog and closed history; got ${JSON.stringify(currentIds)}`);
    const epicIds = mapScopeIssues(scopeIssues, 'epic', 's-epic').map((i) => i.id);
    assert(epicIds.includes('s-epic') && epicIds.includes('s-active') && epicIds.includes('s-next') && epicIds.includes('s-blocker'),
      `epic map scope should include descendants and their external blocker; got ${JSON.stringify(epicIds)}`);
    assert(!epicIds.includes('s-urgent') && !epicIds.includes('s-noise'),
      `epic map scope should not include unrelated open work; got ${JSON.stringify(epicIds)}`);
    assert(mapScopeIssues(scopeIssues, 'all').length === 6, 'all-open map scope must preserve access to every non-closed issue');

    const docsFixture = [
      { path: 'README.md' }, { path: 'AGENTS.md' }, { path: 'docs/index.md' },
      { path: 'docs/operators/deploy.md' }, { path: 'notes/2026-07.md' },
    ];
    assert(docGroup('README.md') === 'Project root' && docGroup('docs/operators/deploy.md') === 'docs',
      'document groups should use the top-level folder and keep root files together');
    const grouped = groupDocs(docsFixture);
    assert(JSON.stringify(grouped.map((g) => [g.name, g.items.length])) === JSON.stringify([
      ['Project root', 2], ['docs', 2], ['notes', 1],
    ]), `document grouping should remain compact and deterministic; got ${JSON.stringify(grouped)}`);
    assert(groupDocs(docsFixture, 'deploy').flatMap((g) => g.items).map((d) => d.path).join() === 'docs/operators/deploy.md',
      'document search must still reach a file nested below grouped folders');
    assert(starterDocs(docsFixture, 3).map((d) => d.path).includes('README.md'),
      'document start page should prioritize a repository README');
    console.log('smoke ok (large-project map scopes + grouped/searchable docs navigation)');
  }

  // --- Phase 3 / bd-console-6ag.4: molecules group like epics --------------
  // Pure, fixture-driven — containerGroups() is signal/store/bd-free. This
  // pins the bug the container-type refactor fixed: a poured molecule's root
  // bead has issue_type 'molecule', NOT 'epic' (confirmed against bd v1.1.0,
  // docs/molecules-design.md §3.2), and every grouping site used to test
  // `issue_type === 'epic'` literally — so the molecule rendered as a bare
  // ungrouped row with its four steps loose in the Standalone section.
  // The fixture below is a verbatim transcription of a real `bd mol pour`
  // export (root + 4 steps, parent-child root←step plus the blocks chain
  // derived from the formula's `needs`).
  {
    const molIssues = [
      { id: 'mf-mol-und', title: 'mol-feature', issue_type: 'molecule', status: 'open', priority: 2, dependencies: null },
      { id: 'mf-mol-v6u', title: 'Design auth', issue_type: 'task', status: 'closed', priority: 2, dependencies: [
        { issue_id: 'mf-mol-v6u', depends_on_id: 'mf-mol-und', type: 'parent-child' }] },
      { id: 'mf-mol-4yy', title: 'Implement auth', issue_type: 'task', status: 'in_progress', priority: 2, dependencies: [
        { issue_id: 'mf-mol-4yy', depends_on_id: 'mf-mol-und', type: 'parent-child' },
        { issue_id: 'mf-mol-4yy', depends_on_id: 'mf-mol-v6u', type: 'blocks' }] },
      { id: 'mf-mol-bku', title: 'Test auth', issue_type: 'task', status: 'open', priority: 2, dependencies: [
        { issue_id: 'mf-mol-bku', depends_on_id: 'mf-mol-und', type: 'parent-child' },
        { issue_id: 'mf-mol-bku', depends_on_id: 'mf-mol-4yy', type: 'blocks' }] },
      { id: 'mf-mol-9zm', title: 'Review auth', issue_type: 'task', status: 'open', priority: 2, dependencies: [
        { issue_id: 'mf-mol-9zm', depends_on_id: 'mf-mol-und', type: 'parent-child' },
        { issue_id: 'mf-mol-9zm', depends_on_id: 'mf-mol-bku', type: 'blocks' }] },
      // A hand-made epic with one child — molecules must not displace epics.
      { id: 'mf-epic1', title: 'An epic', issue_type: 'epic', status: 'open', priority: 1, dependencies: null },
      { id: 'mf-kid1', title: 'Epic child', issue_type: 'task', status: 'open', priority: 2, dependencies: [
        { issue_id: 'mf-kid1', depends_on_id: 'mf-epic1', type: 'parent-child' }] },
      // A genuinely standalone bead — the only thing that may land in orphans.
      { id: 'mf-loose', title: 'Loose task', issue_type: 'task', status: 'open', priority: 3, dependencies: null },
    ];

    assert(CONTAINER_TYPES.includes('epic') && CONTAINER_TYPES.includes('molecule'),
      `CONTAINER_TYPES must cover epic AND molecule; got ${JSON.stringify(CONTAINER_TYPES)}`);
    assert(isContainer(molIssues[0]) && isMolecule(molIssues[0]), 'a molecule root must be a container');
    assert(isContainer(molIssues[5]) && !isMolecule(molIssues[5]), 'an epic must be a container but not a molecule');
    assert(!isContainer(molIssues[1]), 'a molecule STEP must not be treated as a container');

    const { groups, orphans } = containerGroups(molIssues);
    const molGroup = groups.find((g) => g.container.id === 'mf-mol-und');
    assert(molGroup, 'THE BUG: a molecule root produced no group — its steps would render un-nested');
    const stepIds = molGroup.children.map((c) => c.id).sort();
    assert(JSON.stringify(stepIds) === JSON.stringify(['mf-mol-4yy', 'mf-mol-9zm', 'mf-mol-bku', 'mf-mol-v6u']),
      `molecule group must contain all 4 poured steps; got ${JSON.stringify(stepIds)}`);
    assert(molGroup.total === 4 && molGroup.closed === 1,
      `molecule progress must count all children (expected 4 total / 1 closed); got ${molGroup.total}/${molGroup.closed}`);
    const epicGroup = groups.find((g) => g.container.id === 'mf-epic1');
    assert(epicGroup && epicGroup.children.length === 1, 'epic grouping must still work alongside molecules');
    // THE regression this pins: no molecule step (nor either container) may
    // fall through into the ungrouped "Standalone" bucket.
    assert(JSON.stringify(orphans.map((o) => o.id)) === JSON.stringify(['mf-loose']),
      `only the genuinely standalone bead may be an orphan; got ${JSON.stringify(orphans.map((o) => o.id))}`);

    // Step -> molecule root resolution (Detail's "part of molecule X" link).
    assert(moleculeRootOf(molIssues[1], molIssues)?.id === 'mf-mol-und', 'a step must resolve to its molecule root');
    assert(moleculeRootOf(molIssues[0], molIssues)?.id === 'mf-mol-und', 'a molecule root must resolve to itself');
    assert(moleculeRootOf(molIssues[6], molIssues) === null, 'an epic child must NOT resolve to a molecule root');
    assert(moleculeRootOf(molIssues[7], molIssues) === null, 'a standalone bead has no molecule root');

    const roll = moleculeRollup(molIssues[0], molIssues);
    assert(roll.total === 4 && roll.closed === 1 && roll.inProgress === 1 && roll.percent === 25,
      `molecule rollup mismatch: ${JSON.stringify({ t: roll.total, c: roll.closed, p: roll.inProgress, pct: roll.percent })}`);
    // "Test auth" is blocked by the in-progress "Implement auth"; "Review
    // auth" is blocked by "Test auth" — neither may count as plain open.
    assert(roll.blocked === 2 && roll.open === 0,
      `molecule rollup blocked/open mismatch: ${roll.blocked}/${roll.open}`);

    console.log('smoke ok (molecule containment: molecule root groups its 4 steps, rollup 1/4 closed 25%)');
  }

  // --- progressive discoverability: learn.js lifecycle (pure) --------------
  // The whole promise of this layer is "never nags": a nudge appears in ONE
  // session, a dismissal is permanent across reloads, and doing the thing the
  // nudge was about retires it whether or not it was ever seen. Those are
  // storage-shaped promises, which is exactly the kind that rot silently — so
  // they're asserted against a fake localStorage here, with no browser.
  {
    // A fake localStorage. `dump` is the persisted bytes, so "survives a
    // reload" can be tested honestly: a second store instance reading the same
    // bytes IS a reload.
    const fakeStorage = () => {
      const m = new Map();
      return {
        map: m,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    };

    // Every concept the UI links to must exist, and every hint must point at a
    // real concept — a dead "Read more" is worse than no tooltip at all.
    const requiredConcepts = [
      'bead', 'epic', 'molecule', 'formula', 'ready', 'blocked', 'triage',
      'blocks', 'related', 'discovered-from', 'tracks', 'until', 'caused-by',
      'validates', 'relates-to', 'supersedes', 'parent-child',
    ];
    for (const key of requiredConcepts) {
      const c = concept(key);
      assert(c, `learn.js is missing a definition for "${key}"`);
      assert(c.short && c.when && c.body, `concept "${key}" must define short/when/body`);
    }
    // Every one of bd's 10 link types is explained, by its own bd name.
    for (const t of UI_LINK_TYPES) assert(concept(t), `link type "${t}" has no plain-language definition`);
    for (const c of CONCEPTS) {
      assert(CONCEPT_GROUPS.some((g) => g.id === c.group), `concept "${c.key}" is in unknown group "${c.group}"`);
    }
    for (const h of HINTS) assert(!h.concept || concept(h.concept), `hint "${h.id}" points at a missing concept`);
    assert(isLearnHash('#/learn') && isLearnHash('#/learn/blocks'), '#/learn must be recognised as the learn route');
    assert(!isLearnHash('#/p2/x') && !isLearnHash('#/learnedstuff'), 'only #/learn is the learn route');
    assert(learnAnchorFromHash(conceptHref('blocks')) === 'blocks', 'concept deep links must round-trip');
    assert(learnAnchorFromHash('#/learn/not-a-concept') === null, 'unknown anchors must not resolve');

    // Context derivation: parent-child is containment, not a link the user had
    // to reason about, so an epic-with-children project still reads as "has
    // never used a link" and still gets taught what links are.
    const now = Date.UTC(2026, 0, 30);
    const fresh = new Date(now - 2 * 86400000).toISOString();
    const ancient = new Date(now - 40 * 86400000).toISOString();
    const issues = [
      { id: 'a-1', issue_type: 'epic', status: 'open', updated_at: fresh, dependencies: [] },
      { id: 'a-2', issue_type: 'task', status: 'open', updated_at: fresh, dependencies: [{ depends_on_id: 'a-1', type: 'parent-child' }] },
      { id: 'a-3', issue_type: 'task', status: 'open', updated_at: ancient, dependencies: [] },
      { id: 'a-4', issue_type: 'task', status: 'closed', updated_at: ancient, dependencies: [] },
      // Padding to clear the "links-none" hint's 6-issue floor — a project
      // with three beads in it is not one that needs a lecture about graphs.
      { id: 'a-5', issue_type: 'task', status: 'open', updated_at: fresh, dependencies: [] },
      { id: 'a-6', issue_type: 'bug', status: 'open', updated_at: fresh, dependencies: [] },
      { id: 'a-7', issue_type: 'chore', status: 'open', updated_at: fresh, dependencies: [] },
    ];
    const ctx = learnContext(issues, { now, formulas: 2 });
    assert(ctx.issues === 7 && ctx.open === 6, `learnContext counts: ${JSON.stringify(ctx)}`);
    assert(ctx.links === 0, 'parent-child alone must not count as "this project uses links"');
    assert(ctx.containers === 1 && ctx.molecules === 0, 'epic counts as a container, not a molecule');
    assert(ctx.staleOpen === 1, 'only the open 40-day-old issue is stale (the closed one is not)');
    assert(learnContext([{ id: 'b', dependencies: [{ depends_on_id: 'c', type: 'blocks' }] }]).links === 1,
      'a blocks row is a link');

    const ctxLinked = learnContext([...issues, { id: 'a-8', issue_type: 'task', status: 'open', updated_at: fresh, dependencies: [{ depends_on_id: 'a-3', type: 'blocks' }] }], { now, formulas: 2 });

    // A hint shows ONCE. Not once per page load — once, full stop.
    {
      const storage = fakeStorage();
      const s = createLearnStore(storage);
      assert(s.shouldShow('links-none', ctx), 'a 6+ issue project with no links should be taught what links are');
      assert(s.noteShown('links-none') === true, 'the single permitted appearance retires the hint');
      assert(!s.shouldShow('links-none', ctx), 'a shown hint must not show again');
      // Same persisted bytes, new instance == a page reload.
      const reloaded = createLearnStore(storage);
      assert(!reloaded.shouldShow('links-none', ctx), 'a shown hint must not come back after a reload');
      // noteShown is idempotent within a session so a remount can't double-count.
      const s2 = createLearnStore(fakeStorage());
      s2.noteShown('links-none'); s2.noteShown('links-none'); s2.noteShown('links-none');
      assert(s2.snapshot().hints['links-none'].shows === 1, 'a remount must not spend more than one appearance');
    }

    // Dismissal is permanent, and survives a reload.
    {
      const storage = fakeStorage();
      const s = createLearnStore(storage);
      assert(s.shouldShow('links-none', ctx), 'precondition: hint is showable');
      s.dismiss('links-none');
      assert(!s.shouldShow('links-none', ctx), 'a dismissed hint is gone immediately');
      assert(storage.getItem(LEARN_KEY), 'dismissal must be written to storage, not just memory');
      const reloaded = createLearnStore(storage);
      assert(reloaded.status('links-none') === 'dismissed', 'dismissal must survive a reload');
      assert(!reloaded.shouldShow('links-none', ctx), 'a dismissed hint must not return after a reload');
      assert(reloaded.pickNudge(ctx)?.id !== 'links-none', 'a dismissed hint must not be picked');
    }

    // Retirement, both ways: by doing the thing (recordAction, fired from the
    // write path itself) and by the data showing it was already done.
    {
      const s = createLearnStore(fakeStorage());
      assert(s.shouldShow('links-none', ctx), 'precondition');
      assert(s.recordAction('link') === true, 'creating a link retires the "no links" hint');
      assert(s.status('links-none') === 'retired', 'retired, not merely hidden');
      assert(!s.shouldShow('links-none', ctx), 'a retired hint never shows, even though its condition still holds');
      assert(s.recordAction('link') === false, 'a second link changes nothing');

      const s2 = createLearnStore(fakeStorage());
      assert(!s2.shouldShow('links-none', ctxLinked), 'a project that already has links is never taught about links');
      s2.evaluate(ctxLinked);
      assert(s2.status('links-none') === 'retired', 'an already-outgrown hint retires silently, so it can never surface later');

      // Molecules: pouring one retires the "you have recipes you never use" hint.
      const s3 = createLearnStore(fakeStorage());
      assert(s3.shouldShow('formulas-unused', ctx), 'formulas present + no molecules poured should nudge');
      s3.recordAction('pour');
      assert(!s3.shouldShow('formulas-unused', ctx), 'pouring retires the molecules nudge');
      assert(!createLearnStore(fakeStorage()).shouldShow('formulas-unused', learnContext(issues, { now, formulas: 0 })),
        'no formulas, no molecule nudge');
    }

    // Exactly one nudge is ever offered, and it is the highest-priority one.
    {
      const s = createLearnStore(fakeStorage());
      const busy = learnContext(
        Array.from({ length: 14 }, (_, n) => ({ id: 'z-' + n, issue_type: 'task', status: 'open', updated_at: ancient, dependencies: [] })),
        { now, formulas: 3 },
      );
      assert(busy.issues === 14 && busy.links === 0 && busy.containers === 0 && busy.staleOpen === 14,
        `context for the all-hints-true case: ${JSON.stringify(busy)}`);
      const showable = HINTS.filter((h) => s.shouldShow(h.id, busy));
      assert(showable.length === 4, `all four hints are individually true here, got ${showable.length}`);
      const picked = s.pickNudge(busy);
      assert(picked && picked.id === 'links-none', `pickNudge must return exactly the top-priority hint, got ${picked?.id}`);
    }

    // The master switch: off suppresses every nudge, and nothing else. The
    // glossary is reference, not a tutorial, and stays available forever.
    {
      const storage = fakeStorage();
      const s = createLearnStore(storage);
      s.setEnabled(false);
      assert(!s.isEnabled(), 'master switch off');
      for (const h of HINTS) assert(!s.shouldShow(h.id, ctx), `hint "${h.id}" must be suppressed while hints are off`);
      assert(s.pickNudge(ctx) === null, 'no nudge is ever picked while hints are off');
      // Tooltips/#/learn read CONCEPTS directly and never consult the store —
      // asserted structurally: the glossary is a module constant, not state.
      assert(concept('molecule').short.length > 0 && CONCEPTS.length >= 25,
        'the concept glossary must remain fully available with hints off');
      assert(createLearnStore(storage).isEnabled() === false, 'the master switch persists across a reload');
      // ...and back on, with a clean slate.
      const s2 = createLearnStore(storage);
      s2.dismiss('stale-open');
      s2.reset();
      assert(s2.isEnabled() && s2.status('stale-open') === 'new', 'reset re-enables hints and un-dismisses everything');
      assert(createLearnStore(storage).status('stale-open') === 'new', 'reset persists');
    }

    // Corrupt/foreign storage must degrade to defaults, never throw: this runs
    // on every page load in every browser, including ones with junk under the key.
    {
      const storage = fakeStorage();
      storage.setItem(LEARN_KEY, '{not json');
      assert(createLearnStore(storage).isEnabled(), 'unparseable state falls back to defaults');
      storage.setItem(LEARN_KEY, JSON.stringify({ v: 99, enabled: false }));
      assert(createLearnStore(storage).isEnabled(), 'a future schema version is ignored, not obeyed');
    }

    console.log(`smoke ok (learn.js: ${CONCEPTS.length} concepts, ${HINTS.length} hints, one-shot + dismissal + retirement + master switch)`);
  }

  // --- bd-console-0nd: the retired classic route must REDIRECT ------------
  // #/p/<id> and #/p/<id>/docs were the classic per-project view. It is gone;
  // Console 2.0 (#/p2/<id>) is the only per-project view. Bookmarks and links
  // to the old hashes have to land on the project, NOT 404 and NOT fall back
  // to the hub — that's the whole point of retiring it as a route rather than
  // deleting it. store.js's parseHash() wraps these two pure functions with
  // the browser-only half (history.replaceState), which is why they live in
  // an import-free module: this is assertable here.
  {
    assert(legacyProjectHash('#/p/bd-console') === '#/p2/bd-console', '#/p/<id> must redirect to #/p2/<id>');
    assert(legacyProjectHash('#/p/bd-console/docs') === '#/p2/bd-console', "the classic Docs tab must redirect to the project's Console 2.0 view");
    assert(legacyProjectHash('#/p/my%20repo/docs') === '#/p2/my%20repo', 'the project segment must pass through still-encoded');
    // Nothing else may be rewritten — a redirect that fires on #/p2 would be
    // an infinite loop, and one that fires on a hub-level route would strand
    // it.
    for (const h of ['#/p2/bd-console', '#/', '', '#/tmux', '#/schedule', '#/settings', '#/learn', '#/p']) {
      assert(legacyProjectHash(h) === null, `${h || '(empty)'} must not be treated as a retired classic route`);
    }

    // Belt and braces: even if the URL rewrite can't run, the retired hash
    // still resolves to the project, never to the hub.
    assert(parseRoute('#/p/bd-console').view === 'console2', '#/p/<id> must parse as the console2 view');
    assert(parseRoute('#/p/bd-console').projectId === 'bd-console', '#/p/<id> must keep its project id');
    assert(parseRoute('#/p/bd-console/docs').projectId === 'bd-console', 'the docs tab suffix must not change the project');
    assert(parseRoute('#/p2/my%20repo').projectId === 'my repo', 'the project id must be decoded once');
    // Hub-level routes still route — they no longer have a per-project top bar
    // linking to them, so a regression here would strand them.
    assert(parseRoute('#/tmux').view === 'tmux', '#/tmux must still route');
    assert(parseRoute('#/schedule').view === 'schedule', '#/schedule must still route');
    assert(parseRoute('#/settings').view === 'settings', '#/settings must still route');
    assert(parseRoute('#/').view === 'hub' && parseRoute('').view === 'hub' && parseRoute('#/nope').view === 'hub',
      'anything unrecognised falls back to the hub');

    // The classic components must be gone, not merely unlinked.
    for (const f of ['ProjectView.js', 'DocsView.js', 'IssueList.js', 'IssueDetail.js', 'FiltersPane.js']) {
      assert(!existsSync(resolve(join(process.cwd(), 'public', 'ui', 'components', f))),
        `public/ui/components/${f} is a retired classic-view component and must not come back`);
    }
    const routedSrc = readFileSync(resolve(join(process.cwd(), 'public', 'app.js')), 'utf8')
      + readFileSync(resolve(join(process.cwd(), 'public', 'ui', 'components', 'App.js')), 'utf8')
      + readFileSync(resolve(join(process.cwd(), 'public', 'ui', 'console2', 'Console2.js')), 'utf8');
    assert(!/['"`]#\/p\/|view === 'project'/.test(routedSrc),
      "nothing may link to #/p/<id> or branch on the retired 'project' view any more");
    console.log('smoke ok (bd-console-0nd: classic view retired — #/p/<id> and #/p/<id>/docs redirect to #/p2/<id>, hub routes intact)');
  }

  // --- Phase 3: formula derivations (pure) --------------------------------
  // The two rules here are bd's, verified live, and neither is what the docs
  // imply: (1) ANY --var switches `bd cook` into runtime mode, which then
  // demands EVERY declared variable resolve — vars with a `default` resolve
  // themselves, vars without one must be supplied; (2) bd does NOT enforce a
  // var's `enum`/`pattern` (confirmed: an out-of-enum value substitutes
  // verbatim, exit 0), so those checks are ours to make.
  {
    const f = {
      formula: 'mol-audit',
      steps: [{ id: 'recon', title: 'Recon {{scope}}' }, { id: 'report', title: 'Report {{scope}}', needs: ['recon'] }],
      vars: {
        scope: { description: 'Audit scope', required: true, enum: ['api', 'ui', 'infra'] },
        ticket: { description: 'Ticket', required: true, pattern: '^[A-Z]+-[0-9]+$' },
        owner: { description: 'Owner', default: 'unassigned' },
      },
    };
    const specs = formulaVars(f);
    assert(specs.length === 3, `expected 3 declared vars, got ${specs.length}`);
    assert(specs.find((s) => s.key === 'owner').hasDefault, 'owner declares a default');
    assert(specs.find((s) => s.key === 'scope').enum.length === 3, 'enum must survive');

    assert(pourBeadCount(f) === 3, 'pour creates one root + one bead per step');

    // A var with a default is never "missing" — it self-resolves in runtime mode.
    assert(JSON.stringify(missingVars(f, {})) === JSON.stringify(['scope', 'ticket']),
      `missingVars mismatch: ${JSON.stringify(missingVars(f, {}))}`);
    assert(missingVars(f, { scope: 'api', ticket: 'SEC-1' }).length === 0, 'defaults must not block a pour');

    // Mode selection: empty OR partially-filled -> compile (placeholders);
    // fully resolvable -> runtime. Sending a partial --var set is an ERROR
    // exit from bd, not a partial render, so the mode has to be chosen here.
    assert(previewMode(f, {}) === 'compile', 'an empty form previews in compile mode');
    assert(previewMode(f, { scope: 'api' }) === 'compile', 'a partially-filled form must NOT ask bd for runtime mode');
    assert(previewMode(f, { scope: 'api', ticket: 'SEC-1' }) === 'runtime', 'a fully-resolvable form previews in runtime mode');
    assert(Object.keys(previewVars(f, { scope: 'api' })).length === 0, 'compile mode must send no --var at all');
    assert(previewVars(f, { scope: 'api', ticket: 'SEC-1' }).scope === 'api', 'runtime mode sends the filled vars');

    // enum/pattern — ours to enforce, because bd does not.
    assert(varViolations(f, { scope: 'api', ticket: 'SEC-1' }).length === 0, 'valid values must not flag');
    assert(varViolations(f, { scope: 'bogus' })[0]?.key === 'scope', 'an out-of-enum value must flag');
    assert(varViolations(f, { ticket: 'lowercase' })[0]?.key === 'ticket', 'a pattern-violating value must flag');
    assert(varViolations({ vars: { x: { pattern: '([' } } }, { x: 'anything' }).length === 0,
      'an unparseable pattern in the formula must not break the form');

    // The ONE number read out of each dry-run's opaque text. Verbatim
    // transcripts from bd v1.1.0; a shape change returns null (advisory), it
    // never throws or invents a count.
    assert(previewIssueCount('\nDry run: would pour 5 issues from proto mol-feature\n\n  - x (from y)\n') === 5,
      'pour dry-run count must be read from bd\'s own wording');
    assert(previewIssueCount('some other output entirely') === null, 'an unrecognized dry-run must yield null, not a guess');
    assert(burnIssueCount('Dry run: would burn mol X\n\nIssues to delete (4 total):\n  - [open] a (b) [ROOT]\n') === 4,
      'burn dry-run count must be read from bd\'s own wording');
    assert(burnIssueCount('') === null, 'an empty burn dry-run must yield null');

    console.log('smoke ok (formula derivations: runtime-vs-compile mode, defaults self-resolve, enum/pattern enforced client-side)');
  }

  // --- Phase 3: formula/molecule ROUTES, end to end -----------------------
  // Against the real `bd init`'d fixture repo above: author a formula, browse
  // it, preview variables, dry-run, pour (a real multi-bead write), verify the
  // beads landed with the right shapes, then burn them back out. This is the
  // one place the text-not-JSON dry-run quirk and the pour->burn round trip
  // are exercised against the actual installed bd rather than a fixture.
  {
    const formulaDir = join(repoDir, '.beads', 'formulas');
    mkdirSync(formulaDir, { recursive: true });
    writeFileSync(join(formulaDir, 'smoke-flow.formula.json'), JSON.stringify({
      formula: 'smoke-flow',
      description: 'Smoke workflow: design then ship',
      version: 1,
      type: 'workflow',
      vars: {
        thing: { description: 'What is being built', required: true },
        owner: { description: 'Owner', default: 'nobody' },
      },
      steps: [
        { id: 'design', title: 'Design {{thing}}', type: 'task' },
        { id: 'ship', title: 'Ship {{thing}} for {{owner}}', type: 'task', needs: ['design'] },
      ],
    }, null, 2));

    const list = await fetch(p('/formulas')).then((r) => r.json());
    assert(Array.isArray(list.formulas), '/api/formulas must always return an array (bd emits bare null when empty)');
    const listed = list.formulas.find((f) => f.name === 'smoke-flow');
    assert(listed && listed.steps === 2 && listed.vars === 2, `formula list entry mismatch: ${JSON.stringify(listed)}`);

    const shown = await fetch(p('/formulas/smoke-flow')).then((r) => r.json());
    assert(shown.formula?.formula === 'smoke-flow', 'formula show mismatch');
    assert(missingVars(shown.formula, {}).length === 1, 'only the default-less var should block (owner has a default)');

    const missingFormula = await fetch(p('/formulas/definitely-not-a-formula'));
    assert(missingFormula.status === 404, `unknown formula should 404, got ${missingFormula.status}`);
    const leak = await missingFormula.json();
    assert(!/\//.test(leak.error || ''), `formula-not-found must not leak search paths: ${leak.error}`);
    const badName = await fetch(p('/formulas/' + encodeURIComponent('../etc/passwd')));
    assert(badName.status === 400, `a path-ish formula name should 400, got ${badName.status}`);

    // Compile mode: no --var, placeholders intact.
    const compile = await fetch(p('/formulas/smoke-flow/preview')).then((r) => r.json());
    assert(compile.mode === 'compile' && compile.preview.steps[0].title === 'Design {{thing}}',
      `compile preview mismatch: ${JSON.stringify(compile.preview?.steps?.[0])}`);
    // Runtime mode: substituted, and the default filled itself in.
    const runtime = await fetch(p('/formulas/smoke-flow/preview?var.thing=widgets')).then((r) => r.json());
    assert(runtime.mode === 'runtime' && runtime.preview.steps[0].title === 'Design widgets',
      `runtime preview mismatch: ${JSON.stringify(runtime.preview?.steps?.[0])}`);
    assert(runtime.preview.steps[1].title === 'Ship widgets for nobody', 'a var default must self-resolve in runtime mode');
    // bd's missing-variable complaint is PLAIN TEXT on stderr, not JSON —
    // surfaced as a 400 with bd's own wording rather than parsed.
    const gap = await fetch(p('/formulas/smoke-flow/preview?var.owner=alice'));
    assert(gap.status === 400, `an unresolvable runtime preview should 400, got ${gap.status}`);
    assert(/thing/.test((await gap.json()).error || ''), 'the 400 should name the unfilled variable');

    // Dry run: OPAQUE TEXT. bd silently ignores --json here (v1.1.0), so the
    // route must not promise structure — it returns the block verbatim.
    const dry = await fetch(p('/molecules/pour-preview?proto=smoke-flow&var.thing=widgets')).then((r) => r.json());
    assert(dry.ok && typeof dry.preview === 'string', 'pour dry-run must return preview TEXT');
    assert(previewIssueCount(dry.preview) === 3, `dry-run should say 3 issues; got ${JSON.stringify(dry.preview)}`);
    assert(/Design widgets/.test(dry.preview), 'dry-run text should itemize the substituted steps');
    const dryMissing = await fetch(p('/molecules/pour-preview?proto=nope-not-here'));
    assert(dryMissing.status === 404, `dry-run of an unknown proto should 404, got ${dryMissing.status}`);
    assert(!/\/.+\//.test((await dryMissing.json()).error || ''), 'an unknown-proto error must not leak absolute paths');

    // THE write.
    const beforePour = (await fetch(p('/issues')).then((r) => r.json())).issues.length;
    const poured = await fetch(p('/molecules/pour'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proto: 'smoke-flow', vars: { thing: 'widgets' } }),
    }).then((r) => r.json());
    assert(poured.ok && poured.created === 3, `pour should create 3 beads: ${JSON.stringify(poured)}`);
    assert(poured.new_epic_id, 'pour must report the new molecule root id');
    assert(poured.missing.length === 0, `every mapped bead must be observable in the export; missing ${JSON.stringify(poured.missing)}`);

    const afterPour = (await fetch(p('/issues')).then((r) => r.json())).issues;
    assert(afterPour.length === beforePour + 3, `issue count should grow by 3; ${beforePour} -> ${afterPour.length}`);
    const root = afterPour.find((i) => i.id === poured.new_epic_id);
    // The whole reason bd-console-6ag.4 existed: this type is NOT 'epic'.
    assert(root && root.issue_type === 'molecule', `molecule root issue_type must be "molecule"; got ${root?.issue_type}`);
    // ...and the container-grouping pass must nest its steps under it.
    const grouped = containerGroups(afterPour).groups.find((g) => g.container.id === root.id);
    assert(grouped && grouped.children.length === 2, `poured molecule must group its 2 steps; got ${grouped?.children.length}`);
    assert(grouped.children.every((c) => moleculeRootOf(c, afterPour)?.id === root.id), 'each step must resolve back to its root');
    // The `needs` edge became a real `blocks` dependency.
    const ship = grouped.children.find((c) => /^Ship widgets/.test(c.title));
    const design = grouped.children.find((c) => /^Design widgets/.test(c.title));
    assert(ship && design && blockersOf(ship).includes(design.id), 'a formula `needs` must become a blocks dependency');

    const molRes = await fetch(p('/molecules/' + root.id + '?parallel=1')).then((r) => r.json());
    assert(molRes.molecule?.root?.id === root.id, 'GET /api/molecules/:id must return the molecule');
    assert(molRes.progress?.total === 2, `mol progress should report 2 steps; got ${molRes.progress?.total}`);
    assert(molRes.parallel && molRes.parallel.parallel_groups, 'parallel=1 must merge in bd ready --mol data');
    const molMissing = await fetch(p('/molecules/xx-nothere'));
    assert(molMissing.status === 404, `unknown molecule should 404, got ${molMissing.status}`);

    // Burn as undo — dry run first, then the real cascade delete.
    const burnDry = await fetch(p('/molecules/burn-preview?id=' + root.id)).then((r) => r.json());
    assert(burnDry.ok && burnIssueCount(burnDry.preview) === 3, `burn dry-run should list 3 issues; got ${JSON.stringify(burnDry.preview)}`);
    const burned = await fetch(p('/molecules/burn'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: root.id }),
    }).then((r) => r.json());
    assert(burned.ok && burned.deleted_count === 3, `burn should delete 3 beads: ${JSON.stringify(burned)}`);
    assert(burned.deleted.includes(root.id), 'burn response must list the deleted ids (field is `deleted`, not `deleted_ids`)');
    const afterBurn = (await fetch(p('/issues')).then((r) => r.json())).issues;
    assert(afterBurn.length === beforePour, `burn should return the repo to its pre-pour size; ${beforePour} -> ${afterBurn.length}`);
    assert(!afterBurn.some((i) => i.issue_type === 'molecule'), 'no molecule should survive the burn');

    // Validation: garbage never reaches execFile.
    const badProto = await fetch(p('/molecules/pour'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proto: 'a b; rm -rf /', vars: {} }),
    });
    assert(badProto.status === 400, `a shell-ish proto should 400, got ${badProto.status}`);
    const badVarKey = await fetch(p('/molecules/pour'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proto: 'smoke-flow', vars: { 'a b': 'x' } }),
    });
    assert(badVarKey.status === 400, `a non-identifier var key should 400, got ${badVarKey.status}`);

    console.log(`smoke ok (formulas/molecules routes: browse -> preview -> dry-run -> pour(3) -> burn(3)): ${poured.new_epic_id}`);
  }

  // --- bd-console-9it: formula AUTHORING, pure derivations ------------------
  // The naming and candidate rules that decide what the two authoring dialogs
  // put in front of the user. Pure, so they're asserted here rather than only
  // observable by clicking.
  {
    // A step's prerequisites are spelled `needs` by hand and `depends_on` by
    // `bd mol distill` — reading only the first is why every distilled recipe
    // used to preview as if its steps had no order at all.
    assert(stepNeeds({ needs: ['a'] }).join() === 'a', '`needs` must be read');
    assert(stepNeeds({ depends_on: ['b'] }).join() === 'b', 'THE BUG: distill writes `depends_on`, which must be read too');
    assert(stepNeeds({}).length === 0 && stepNeeds(null).length === 0, 'a step with no prerequisites yields []');

    assert(slugifyFormulaName('Release 2.1 hardening!') === 'release-2-1-hardening',
      `formula name slug mismatch: ${slugifyFormulaName('Release 2.1 hardening!')}`);
    assert(slugifyFormulaName('!!!') === '', 'an unusable title yields no name rather than one the server would reject');
    // A version-shaped value gets called `version`, not `v2_1`.
    assert(slugifyVarName('2.1') === 'version' && slugifyVarName('v3') === 'version', 'version-ish values name themselves `version`');
    assert(slugifyVarName('Acme Corp') === 'acme_corp', 'var names are snake_case identifiers');
    assert(/^[A-Za-z0-9_]+$/.test(slugifyVarName('9lives')), 'a var name must satisfy the server VAR_KEY_RE');

    assert(formulaStem('release.formula.json') === 'release' && formulaStem('release.toml') === 'release',
      'the formula stem is the identity bd loads by');
    assert(formulaFileName('release') === 'release.formula.json' && formulaFileName('a.toml') === 'a.toml',
      'a bare name gets the .formula.json bd itself writes');

    // Only strings that RECUR are offered — a variable appearing once is noise.
    const cands = distillCandidates(['Release 2.1', 'Write notes for 2.1', 'Tag version 2.1', 'Announce 2.1']);
    assert(cands.length > 0 && cands[0].value === '2.1' && cands[0].name === 'version',
      `distill candidates should lead with the recurring value: ${JSON.stringify(cands)}`);
    assert(!cands.some((c) => /^announce$/i.test(c.value)), 'a value appearing in exactly one title is not a candidate');
    assert(distillCandidates(['only one title']).length === 0, 'one title cannot establish a recurring value');

    // The local half of the save gate: the two mistakes that make a formula
    // unloadable, caught while typing.
    assert(formulaSaveProblem('starter.formula.json', newFormulaTemplate('starter')) === null,
      'the seeded example must pass the local save gate as-is');
    assert(/must be "starter"/.test(formulaSaveProblem('starter.formula.json', newFormulaTemplate('other')) || ''),
      'a formula whose name disagrees with its filename must be refused locally');
    assert(/JSON/.test(formulaSaveProblem('x.formula.json', '{ nope') || ''), 'unparseable JSON is reported before the round trip');
    assert(formulaSaveProblem('x.formula.json', '   ') !== null, 'an empty draft is refused');

    console.log('smoke ok (formula authoring derivations: needs/depends_on, name slugs, recurring-value candidates, save gate)');
  }

  // --- bd-console-9it: formula AUTHORING routes, end to end ----------------
  // THE dead end this closes: `bd formula` has list/show/convert and NO create
  // (re-verified on v1.1.0), so the pour flow's prerequisite could not be
  // produced anywhere in the product. Both authoring paths are exercised here
  // against the real bd, and both are proven to end in a formula that POURS.
  {
    const fmt = { method: 'POST', headers: { 'content-type': 'application/json' } };
    const postJson = (path, body) => fetch(p(path), { ...fmt, body: JSON.stringify(body) });

    // --- path safety, before anything is written -------------------------
    for (const bad of ['../../etc/passwd', '../evil.formula.json', 'sub/dir.formula.json', '.hidden.json', 'evil.sh', 'noext']) {
      const r = await fetch(p('/formula-file?name=' + encodeURIComponent(bad)));
      assert(r.status === 400, `reading "${bad}" must 400, got ${r.status}`);
      const w = await postJson('/formula-file', { name: bad, content: '{}' });
      assert(w.status === 400, `writing "${bad}" must 400, got ${w.status}`);
    }
    // ...and the same for the name distill would use as a FILENAME. bd itself
    // does not sanitize it — `bd mol distill <epic> ../evil` writes outside the
    // formulas directory (reproduced on v1.1.0) — so this check is the only
    // thing between a URL and that.
    const evilDistill = await fetch(p('/formula-distill-preview?epic=' + encodeURIComponent(seedId) + '&name=' + encodeURIComponent('../evil')));
    assert(evilDistill.status === 400, `a traversal formula name must 400, got ${evilDistill.status}`);

    // --- editor round trip: write -> read -> list -> pour -----------------
    const seeded = newFormulaTemplate('smoke-seed');
    const written = await postJson('/formula-file', { name: 'smoke-seed.formula.json', content: seeded });
    const writtenBody = await written.json();
    assert(written.status === 200, `writing the seeded example must succeed, got ${written.status}: ${JSON.stringify(writtenBody)}`);
    assert(writtenBody.formula === 'smoke-seed' && writtenBody.steps === 3,
      `write response mismatch: ${JSON.stringify(writtenBody)}`);

    const readBack = await fetch(p('/formula-file?name=smoke-seed.formula.json')).then((r) => r.json());
    assert(readBack.content === seeded, 'a formula must read back byte-for-byte');

    const fileList = await fetch(p('/formula-files')).then((r) => r.json());
    assert(fileList.dir && !fileList.dir.startsWith('/'), `the formulas dir must be reported project-relative, got ${fileList.dir}`);
    assert(fileList.files.some((f) => f.name === 'smoke-seed.formula.json' && f.formula === 'smoke-seed'),
      `formula-files must list what was just written: ${JSON.stringify(fileList.files)}`);

    // It reaches the Molecules dialog (which lists via `bd formula list`)...
    const listedAfterWrite = await fetch(p('/formulas')).then((r) => r.json());
    assert(listedAfterWrite.formulas.some((f) => f.name === 'smoke-seed'),
      'a formula written through the editor must appear in the pour dialog');
    // ...and it actually pours. This is the whole point of seeding a WORKING
    // example rather than an empty file: a beginner's first save validates and
    // their first pour succeeds.
    const seedPour = await postJson('/molecules/pour', { proto: 'smoke-seed', vars: { thing: 'onboarding' } }).then((r) => r.json());
    assert(seedPour.ok && seedPour.created === 4, `the seeded example must pour 4 beads: ${JSON.stringify(seedPour)}`);
    await postJson('/molecules/burn', { id: seedPour.new_epic_id });

    // --- validation happens BEFORE the write ------------------------------
    // A malformed formula file is silently SKIPPED by `bd formula list` rather
    // than reported (verified) — the recipe would just vanish — so a bad draft
    // must never reach the disk in the first place.
    const formulaDirPath = join(repoDir, '.beads', 'formulas');
    const malformed = await postJson('/formula-file', { name: 'smoke-bad.formula.json', content: '{ not json' });
    assert(malformed.status === 400, `malformed JSON must 400, got ${malformed.status}`);
    assert(/json|parse/i.test((await malformed.json()).error || ''), "the rejection should carry bd's own parse error");
    assert(!existsSync(join(formulaDirPath, 'smoke-bad.formula.json')), 'THE RULE: a rejected formula must not be written at all');

    // A dangling `needs` is caught by bd's own validator.
    const dangling = await postJson('/formula-file', {
      name: 'smoke-dangle.formula.json',
      content: JSON.stringify({ formula: 'smoke-dangle', version: 1, type: 'workflow', steps: [{ id: 'a', title: 'A', type: 'task', needs: ['ghost'] }] }),
    });
    assert(dangling.status === 400 && /unknown step/i.test((await dangling.json()).error || ''), 'a dangling `needs` must be refused');
    assert(!existsSync(join(formulaDirPath, 'smoke-dangle.formula.json')), 'a structurally invalid formula must not be written');

    // The trap that motivated the stem check: `bd formula list` reports the
    // name from the file CONTENT, but show/cook/pour resolve by FILE BASENAME.
    // A mismatch therefore lists under a name nothing can open.
    const mismatch = await postJson('/formula-file', {
      name: 'smoke-outer.formula.json',
      content: JSON.stringify({ formula: 'smoke-inner', version: 1, type: 'workflow', steps: [{ id: 'a', title: 'A', type: 'task' }] }),
    });
    assert(mismatch.status === 400, `a name/filename mismatch must 400, got ${mismatch.status}`);
    assert(!existsSync(join(formulaDirPath, 'smoke-outer.formula.json')), 'a name/filename mismatch must not be written');
    // An empty step list pours a molecule with nothing in it — bd allows it,
    // this doesn't.
    const stepless = await postJson('/formula-file', {
      name: 'smoke-empty.formula.json',
      content: JSON.stringify({ formula: 'smoke-empty', version: 1, type: 'workflow', steps: [] }),
    });
    assert(stepless.status === 400, `a step-less formula must 400, got ${stepless.status}`);

    // --- distill round trip: epic -> formula -> pour ----------------------
    const epicId = (await postJson('/create', { title: 'Ship release 4.2', type: 'epic', priority: 1 }).then((r) => r.json())).id;
    const kid1 = (await postJson('/create', { title: 'Write notes for 4.2', type: 'task', parent: epicId }).then((r) => r.json())).id;
    const kid2 = (await postJson('/create', { title: 'Tag version 4.2', type: 'task', parent: epicId }).then((r) => r.json())).id;
    await postJson('/edit', { id: kid2, op: 'add-blocker', blocker: kid1 });

    // A childless bead has no shape to save; bd would happily write a 0-step
    // formula for one (verified), which lists fine and pours nothing.
    const childless = await postJson('/formula-distill', { epic: kid1, name: 'smoke-nothing' });
    assert(childless.status === 400, `distilling a childless bead must 400, got ${childless.status}`);

    const distillVars = 'var.version=4.2';
    const distillDry = await fetch(p(`/formula-distill-preview?epic=${epicId}&name=smoke-release&${distillVars}`)).then((r) => r.json());
    // OPAQUE TEXT, exactly like the pour dry run: bd silently ignores --json on
    // every --dry-run path, re-verified for distill on v1.1.0.
    assert(distillDry.ok && typeof distillDry.preview === 'string', 'the distill dry run must return preview TEXT');
    assert(/\{\{version\}\}/.test(distillDry.preview), `the dry run must show the marked blanks: ${distillDry.preview}`);
    assert(!/\/[^\s]*\/[^\s]*formulas/.test(distillDry.preview), `the dry run must not leak absolute host paths: ${distillDry.preview}`);

    const distilled = await postJson('/formula-distill', { epic: epicId, name: 'smoke-release', vars: { version: '4.2' } }).then((r) => r.json());
    assert(distilled.ok && distilled.steps === 2, `distill should capture 2 steps: ${JSON.stringify(distilled)}`);
    assert(distilled.file === 'smoke-release.formula.json', `distill file mismatch: ${distilled.file}`);
    assert(distilled.variables.includes('version'), 'distill must report the variables it created');

    // Overwrite is opt-in — `bd mol distill` clobbers silently otherwise.
    const clobber = await postJson('/formula-distill', { epic: epicId, name: 'smoke-release', vars: {} });
    assert(clobber.status === 409, `re-distilling onto an existing name must 409 without overwrite, got ${clobber.status}`);

    // It shows up in the Molecules dialog...
    const listedAfterDistill = await fetch(p('/formulas')).then((r) => r.json());
    assert(listedAfterDistill.formulas.some((f) => f.name === 'smoke-release'),
      'a distilled formula must appear in the pour dialog');
    // ...its steps carry `depends_on` (not `needs`), which is why stepNeeds()
    // above has to read both...
    const distilledDoc = (await fetch(p('/formulas/smoke-release')).then((r) => r.json())).formula;
    const wired = distilledDoc.steps.find((s) => stepNeeds(s).length > 0);
    assert(wired && Array.isArray(wired.depends_on), `distill must emit depends_on, got ${JSON.stringify(distilledDoc.steps)}`);
    // ...and it pours, reproducing the original epic's shape for a new version.
    const rePour = await postJson('/molecules/pour', { proto: 'smoke-release', vars: { version: '5.0' } }).then((r) => r.json());
    assert(rePour.ok && rePour.created === 3, `the distilled formula must pour 3 beads: ${JSON.stringify(rePour)}`);
    const rePoured = (await fetch(p('/issues')).then((r) => r.json())).issues;
    const tagStep = rePoured.find((i) => i.title === 'Tag version 5.0');
    const notesStep = rePoured.find((i) => i.title === 'Write notes for 5.0');
    assert(tagStep && notesStep, `the distilled variable must substitute on pour: ${JSON.stringify(rePoured.map((i) => i.title))}`);
    assert(blockersOf(tagStep).includes(notesStep.id), 'the original epic\'s blocking order must survive the round trip');
    await postJson('/molecules/burn', { id: rePour.new_epic_id });

    console.log(`smoke ok (formula authoring routes: editor write->pour(4), traversal/extension/malformed rejected pre-write, distill ${epicId}->smoke-release->pour(3))`);
  }

  // --- hub-route contract: public/ui/api.js HUB_PATHS vs lib/routes.mjs ------
  // bd-console-xsv: lib/routes.mjs matches hub-level routes on the UNPREFIXED
  // path, so calling one through the prefixing apiGet/apiPost 404s in a way
  // that most of these endpoints already treat as "feature unavailable" — i.e.
  // silently. api.js now throws on that instead, but only for paths it KNOWS
  // are hub-level, which makes the list itself the thing that can rot. This
  // asserts it can't: a new hub route has to be declared, and a retired one
  // has to be removed. Source-level on purpose — api.js imports store.js
  // (signals, bare specifiers) and so isn't importable in plain Node.
  {
    const routesSrc = readFileSync(resolve(join(process.cwd(), 'lib', 'routes.mjs')), 'utf8');
    const apiSrc = readFileSync(resolve(join(process.cwd(), 'public', 'ui', 'api.js')), 'utf8');
    const served = new Set([...routesSrc.matchAll(/originalPath === '(\/api\/[^']+)'/g)].map((m) => m[1]));
    const block = apiSrc.match(/export const HUB_PATHS = new Set\(\[([\s\S]*?)\]\)/);
    assert(block, 'public/ui/api.js must export a HUB_PATHS set');
    const declared = new Set([...block[1].matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1]));
    assert(served.size > 0 && declared.size > 0, 'hub-route contract check found nothing to compare — the source scrape has drifted');
    const undeclared = [...served].filter((x) => !declared.has(x));
    const stale = [...declared].filter((x) => !served.has(x));
    assert(undeclared.length === 0,
      `lib/routes.mjs serves ${undeclared.join(', ')} on the unprefixed path, but HUB_PATHS in public/ui/api.js doesn't list it — add it there, or the first project-scoped view that calls it through apiGet/apiPost will 404 silently (bd-console-xsv)`);
    assert(stale.length === 0,
      `HUB_PATHS in public/ui/api.js lists ${stale.join(', ')}, which lib/routes.mjs no longer serves hub-level — remove it, or apiGet/apiPost will throw on a path that is now project-scoped`);
    console.log(`smoke ok (hub-route contract: ${declared.size} hub-level routes declared in api.js match lib/routes.mjs)`);
  }

  // --- POST /api/register (lib/registry.mjs registerProjectPath) -------------
  // The browser-side `bd-console add`. It shipped with UI + validation and no
  // coverage for one concrete reason: registering a throwaway project into the
  // SHARED registry above would silently widen every hub-level aggregate that
  // iterates all registered projects (/api/projects, the usage/stats/CLI
  // version loops), so a later assertion could start failing for a reason that
  // has nothing to do with what it tests.
  //
  // The fix is the same one the usage sections use for ~/.claude and ~/.codex:
  // point the thing being tested at a fabricated directory. Here that's a
  // second server on its OWN BD_CONSOLE_CONFIG_DIR — so it gets its own
  // registry.json, every registration lands there, and the main hub's registry
  // is asserted byte-identical afterwards. It also carries BD_CONSOLE_TOKEN so
  // the auth gate is testable in the same process.
  {
    const mainRegistryBefore = readFileSync(registryPath, 'utf8');
    const registerConfigDir = join(tempRoot, 'register-config');
    mkdirSync(registerConfigDir, { recursive: true });
    const registerToken = 'register-smoke-token';
    const registerPort = await getPort();
    const registerEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: registerConfigDir,
      BD_CONSOLE_TOKEN: registerToken
    };
    const registerServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(registerPort)], {
      cwd: process.cwd(), env: registerEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${registerPort}/api/meta`);
      const registerUrl = `http://127.0.0.1:${registerPort}/api/register`;
      const registryFile = join(registerConfigDir, 'registry.json');
      const isolatedProjects = () => (existsSync(registryFile)
        ? (JSON.parse(readFileSync(registryFile, 'utf8')).projects || {})
        : {});
      const register = (body, { token = registerToken } = {}) => fetch(registerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-bd-token': token } : {}) },
        body: JSON.stringify(body)
      });
      const errorOf = async (res) => (await res.json()).error || '';

      // --- auth gate: same one /api/usage and /api/settings POST use --------
      const noToken = await register({ path: repoDir }, { token: null });
      assert(noToken.status === 401, `/api/register without a token should 401 when a token is configured, got ${noToken.status}`);
      const wrongToken = await register({ path: repoDir }, { token: 'not-the-token' });
      assert(wrongToken.status === 401, `/api/register with the wrong token should 401, got ${wrongToken.status}`);
      assert(Object.keys(isolatedProjects()).length === 0, 'a rejected-by-auth register must not have written the registry');

      // --- happy path: a real beads repo ------------------------------------
      const okRes = await register({ path: repoDir });
      const okBody = await okRes.json();
      assert(okRes.status === 200 && okBody.ok === true, `registering a valid beads repo should 200, got ${okRes.status}: ${JSON.stringify(okBody)}`);
      assert(okBody.id === 'repo' && okBody.path === repoDir, `register response mismatch: ${JSON.stringify(okBody)}`);
      const afterOk = isolatedProjects();
      assert(afterOk.repo && afterOk.repo.path === repoDir, `registry.json missing the registered repo: ${JSON.stringify(afterOk)}`);
      // It is live on that hub immediately — no restart, which is the whole
      // point of registering from the UI.
      const listed = await fetch(`http://127.0.0.1:${registerPort}/api/projects`).then((r) => r.json());
      assert(listed.projects && listed.projects.repo && listed.projects.repo.path === repoDir,
        `a freshly registered project must appear in /api/projects: ${JSON.stringify(listed)}`);

      // --- duplicates -------------------------------------------------------
      const dup = await register({ path: repoDir });
      const dupErr = await errorOf(dup);
      assert(dup.status === 409, `re-registering the same path should 409, got ${dup.status}`);
      assert(/already registered as 'repo'/.test(dupErr), `duplicate rejection should name the existing id, got: ${dupErr}`);
      // The same directory reached through a `..` hop is the SAME project —
      // resolve() normalizes before the registry is consulted, so this must be
      // a duplicate rather than a second entry pointing at a dotted path.
      const dotted = await register({ path: join(repoDir, '..', 'repo') });
      assert(dotted.status === 409, `a path that normalizes to an existing project should 409, got ${dotted.status}`);
      const afterDup = isolatedProjects();
      assert(Object.keys(afterDup).length === 1, `duplicate registrations must not add entries: ${JSON.stringify(afterDup)}`);
      assert(!Object.values(afterDup).some((pr) => pr.path.includes('..')), 'a stored project path must be resolved, never dotted');

      // --- not a beads project ---------------------------------------------
      const plainDir = join(tempRoot, 'register-plain-dir');
      mkdirSync(plainDir, { recursive: true });
      const noBeads = await register({ path: plainDir });
      const noBeadsErr = await errorOf(noBeads);
      assert(noBeads.status === 400, `a directory with no .beads/ should 400, got ${noBeads.status}`);
      assert(/no beads project at/.test(noBeadsErr) && /bd init/.test(noBeadsErr),
        `the rejection should say what to do about it, got: ${noBeadsErr}`);

      // THE RULE (lib/registry.mjs rule 2): "that folder doesn't exist" and
      // "it exists but isn't a beads repo" must be the SAME answer. A caller
      // who can tell them apart has a filesystem-probe oracle for the host.
      const missingDir = join(tempRoot, 'register-no-such-dir');
      const missing = await register({ path: missingDir });
      const missingErr = await errorOf(missing);
      assert(missing.status === 400, `a nonexistent directory should 400, got ${missing.status}`);
      assert(missingErr.replace(missingDir, '<PATH>') === noBeadsErr.replace(plainDir, '<PATH>'),
        `nonexistent and non-beads rejections must be indistinguishable apart from the echoed path:\n  ${missingErr}\n  ${noBeadsErr}`);

      // --- path validation --------------------------------------------------
      for (const relative of ['relative/path', '../../etc', 'repo', './']) {
        const res = await register({ path: relative });
        const err = await errorOf(res);
        assert(res.status === 400 && /absolute/.test(err), `relative path ${JSON.stringify(relative)} should be refused as non-absolute, got ${res.status}: ${err}`);
      }
      for (const [label, badPath] of [['NUL byte', `${repoDir}\0/etc/passwd`], ['over-long', `/${'a'.repeat(5000)}`]]) {
        const res = await register({ path: badPath });
        const err = await errorOf(res);
        assert(res.status === 400 && /not a valid filesystem path/.test(err), `${label} path should be refused, got ${res.status}: ${err}`);
      }
      for (const [label, body] of [['missing', {}], ['blank', { path: '   ' }], ['non-string', { path: 42 }], ['null', { path: null }]]) {
        const res = await register(body);
        const err = await errorOf(res);
        assert(res.status === 400 && /path is required/.test(err), `${label} path should be refused, got ${res.status}: ${err}`);
      }

      // Rule 1: nothing is ever executed — the path is only stat()ed. An
      // absolute path full of shell metacharacters is inert by construction,
      // not by quoting, so the canary must never appear.
      const canary = join(tempRoot, 'register-canary');
      const injected = await register({ path: `/tmp/$(touch ${canary})\`touch ${canary}\`;touch ${canary}` });
      assert(injected.status === 400, `a metacharacter path should be refused, got ${injected.status}`);
      assert(!existsSync(canary), 'THE RULE: /api/register must never execute anything from the path it is given');

      // `~` / `~/…` expand against the daemon user's home before the .beads
      // probe — the echoed path proves the expansion happened without needing
      // a beads repo to live there.
      const tildeLeaf = `not-a-beads-repo-${process.pid}`;
      const tilde = await register({ path: `~/${tildeLeaf}` });
      const tildeErr = await errorOf(tilde);
      assert(tilde.status === 400 && tildeErr.includes(join(homedir(), tildeLeaf)),
        `~/ should expand to the daemon user's home, got: ${tildeErr}`);

      // --- isolation held ---------------------------------------------------
      assert(Object.keys(isolatedProjects()).length === 1, `only the one valid repo should ever have been registered: ${JSON.stringify(isolatedProjects())}`);
      assert(readFileSync(registryPath, 'utf8') === mainRegistryBefore,
        'the register tests must not have touched the main hub registry — every hub-level aggregate above iterates it');

      console.log('smoke ok (POST /api/register: registers, 401s unauthed, 409s duplicates, refuses non-beads/relative/NUL/oversized paths, executes nothing)');
    } finally {
      registerServer.kill('SIGTERM');
      await new Promise((resolveP) => registerServer.once('exit', () => resolveP()));
    }
  }

  // --- process health: memory rollups + OOM thresholds (bd-console-oic) -----
  // FIXTURES ONLY — synthetic /proc text and synthetic byte counts. Nothing
  // below reads this machine's real memory, walks a real pid or needs a tmux
  // server, which is what lets the two REAL incidents (a Claude Code process
  // OOM-killed at 18.4GB on 2026-07-31, taking 8 in-flight agents with it, and
  // one at 11.2GB on 2026-08-06, taking a month-old tmux session) be replayed
  // here as the calibration for the thresholds.
  {
    // /proc/meminfo, trimmed to the fields that matter, from the 29GB host
    // these incidents happened on. The zero-swap lines are the point.
    const swaplessMeminfo = [
      'MemTotal:       30795944 kB',
      'MemFree:         7592788 kB',
      'MemAvailable:   18260292 kB',
      'Buffers:         1113068 kB',
      'SwapCached:            0 kB',
      'SwapTotal:             0 kB',
      'SwapFree:              0 kB',
      ''
    ].join('\n');
    const mem = parseMeminfo(swaplessMeminfo);
    assert(mem && mem.totalBytes === 30795944 * 1024, `MemTotal must parse as bytes: ${JSON.stringify(mem)}`);
    assert(mem.swapTotalBytes === 0, 'SwapTotal 0 must survive as 0, not as "missing"');
    // MemAvailable, not MemFree: MemFree counts page cache as used and reads
    // alarmingly low on a perfectly healthy box.
    assert(mem.availableBytes === 18260292 * 1024, 'MemAvailable is the headroom figure');
    // Pre-3.14 kernels have no MemAvailable at all — fall back, don't fail.
    const oldKernel = parseMeminfo('MemTotal: 8000000 kB\nMemFree: 2000000 kB\n');
    assert(oldKernel.availableBytes === 2000000 * 1024, 'a kernel without MemAvailable must fall back to MemFree');
    for (const junk of ['', 'garbage', 'MemTotal: 0 kB', null, undefined]) {
      assert(parseMeminfo(junk) === null, `unparseable meminfo must be null, not a zero-total host: ${junk}`);
    }

    // /proc/<pid>/statm counts PAGES. Getting the page size wrong on a
    // 16K-page aarch64 host would under-report RSS by 4x — the wrong
    // direction for a warning — so the size is calibrated against our own
    // process, whose VmRSS is reported in explicit kB.
    assert(parseStatm('1215829 133419 42 1 0 92 0', 4096) === 133419 * 4096, 'statm field 2 is resident pages');
    assert(calibratePageSize('100 50 1 1 0 1 0', 'VmRSS:\t     200 kB\n') === 4096, '200kB over 50 pages is a 4K page');
    assert(calibratePageSize('100 50 1 1 0 1 0', 'VmRSS:\t     800 kB\n') === 16384, '800kB over 50 pages is a 16K page');
    assert(calibratePageSize('nonsense', '') === 4096, 'uncalibratable input falls back to 4K, it does not throw');
    assert(parseStatm('', 4096) === null && parseStatm(null, 4096) === null, 'unreadable statm is null');

    // /proc/<pid>/stat's comm field can contain SPACES AND PARENTHESES, so
    // the only safe parse splits after the LAST ')'. utime+stime are fields
    // 14/15, starttime is 22.
    const stat = parseProcStat(`4242 (node (main) x) S 1 4242 4242 0 -1 4194304 1 2 3 4 ${1200} ${340} 0 0 20 0 12 0 ${987654} 0 0`);
    assert(stat && stat.cpuTicks === 1540, `utime+stime must survive a parenthesised comm: ${JSON.stringify(stat)}`);
    assert(stat.startTicks === 987654, 'starttime is field 22');
    assert(parseProcStat('') === null && parseProcStat('no parens here') === null, 'garbage stat is null');

    // Rollup: the OOM'd process in the 2026-08-06 incident was a CHILD of the
    // pane process, so the subtree — not the pane pid — is what gets summed.
    // The peak is reported separately and is NEVER a sum: the kernel's OOM
    // killer scores processes individually, so "the fattest single process"
    // is a different question from "what is this session responsible for".
    const tree = [
      { pid: 100, name: 'bash', rss: 6 * 1024 * 1024, cpuTicks: 12 },
      { pid: 101, name: 'claude', rss: 500 * 1024 * 1024, cpuTicks: 900 },
      { pid: 102, name: 'claude', rss: 300 * 1024 * 1024, cpuTicks: 40 },
      { pid: 103, name: 'dead', rss: null, cpuTicks: null }
    ];
    const rolled = rollupProcesses(tree);
    assert(rolled.rssBytes === 806 * 1024 * 1024, `subtree RSS is the sum of readable nodes: ${JSON.stringify(rolled)}`);
    assert(rolled.procs === 3, 'a node whose /proc entry vanished mid-walk is skipped, not counted as 0');
    assert(rolled.peakRssBytes === 500 * 1024 * 1024 && rolled.peakName === 'claude' && rolled.peakPid === 101,
      `the peak must name the single fattest process: ${JSON.stringify(rolled)}`);
    assert(rolled.cpuTicks === 952, 'CPU ticks roll up across the subtree too');
    assert(rollupProcesses([]) === null && rollupProcesses(null) === null,
      'no readable samples must yield null (feature ABSENT), never a confident 0 bytes');
    assert(rollupProcesses([{ pid: 1, rss: null }]) === null, 'a subtree with no memory readings at all is null');

    // Panes are separate process trees, so a session sums them — but its peak
    // stays a max.
    const combined = combineRollups([rolled, { rssBytes: 100 * 1024 * 1024, peakRssBytes: 90 * 1024 * 1024, peakName: 'vim', peakPid: 7, procs: 1, cpuTicks: 5 }]);
    assert(combined.rssBytes === 906 * 1024 * 1024 && combined.procs === 4, `session RSS sums its panes: ${JSON.stringify(combined)}`);
    assert(combined.peakRssBytes === 500 * 1024 * 1024, 'peak across panes is a max, never a sum');
    assert(combineRollups([null, undefined]) === null && combineRollups([]) === null, 'nothing measurable stays null');

    // THE CALIBRATION. Thresholds are fractions of THIS host's RAM with
    // absolute floors, so one rule works on a 29GB workstation and an 8GB
    // laptop. Measured healthy agent sessions on the incident host sit at
    // 0.25–0.6 GB; the two killed processes were 11.2GB and 18.4GB.
    const HOST_29GB = 30795944 * 1024;
    assert(memoryLevel(500 * 1024 * 1024, HOST_29GB) === 'ok', 'a healthy 0.5GB agent session must never be flagged');
    assert(memoryLevel(2 * 1024 ** 3, HOST_29GB) === 'ok', '2GB on a 29GB box is still normal');
    assert(memoryLevel(4 * 1024 ** 3, HOST_29GB) === 'warn', '4GB (13%) is the amber band');
    assert(memoryLevel(11.2 * 1024 ** 3, HOST_29GB) === 'crit',
      'the 2026-08-06 process (11.2GB) must be RED long before the kernel picks it');
    assert(memoryLevel(18.4 * 1024 ** 3, HOST_29GB) === 'crit',
      'the 2026-07-31 process (18.4GB) must be RED long before the kernel picks it');
    // Floors keep small hosts sane: 12% of 8GB is under a gigabyte, which
    // would flag a perfectly ordinary editor.
    const HOST_8GB = 8 * 1024 ** 3;
    assert(memoryLevel(1.5 * 1024 ** 3, HOST_8GB) === 'ok', 'the 2GB floor protects small hosts from noise');
    assert(memoryLevel(2.5 * 1024 ** 3, HOST_8GB) === 'warn' && memoryLevel(5 * 1024 ** 3, HOST_8GB) === 'crit',
      'above the floors, small hosts still get both bands');
    // A threshold expressed as a fraction of an unknown total is not a verdict.
    assert(memoryLevel(99 * 1024 ** 3, null) === 'ok' && memoryLevel(null, HOST_29GB) === 'ok',
      'unknown inputs must never manufacture an alarm');
    assert(SESSION_CRIT_FRACTION > SESSION_WARN_FRACTION, 'crit must sit above warn');

    // The explanation that rides with the number — never a bare color.
    const described = describeSessionMemory(rolled, HOST_29GB);
    assert(described.level === 'ok' && /largest single process/.test(described.reason),
      `a rollup's reason must name the peak process: ${described.reason}`);
    const hot = describeSessionMemory({ rssBytes: 12 * 1024 ** 3, peakRssBytes: 11.2 * 1024 ** 3, peakName: 'claude', peakPid: 5, procs: 3, cpuTicks: 1 }, HOST_29GB);
    assert(hot.level === 'crit' && /OOM/.test(hot.reason), `a crit session must say what happens next: ${hot.reason}`);
    assert(describeSessionMemory(null, HOST_29GB) === null, 'nothing measured -> nothing said');

    // HOST LEVEL. "One process at 18GB" and "twelve processes at 1.5GB" are
    // different shapes of the same danger, so both are checked.
    const okHost = classifyHostMemory(mem, { agentRssBytes: 3.5 * 1024 ** 3, agentSessions: 9, peakRssBytes: 549 * 1024 * 1024, peakName: 'claude', peakSession: 'core2' });
    assert(okHost.level === 'ok' && okHost.label === 'memory ok',
      `today's real numbers (18GB available, 3.5GB of agents) must be quiet: ${JSON.stringify(okHost.level)}`);
    assert(okHost.swapless === true && /NO swap/.test(okHost.reason),
      'the zero-swap fact is load-bearing and must be stated, not implied');

    // The SWAP distinction: identical headroom, different verdict. A machine
    // with swap degrades (and a human notices); a swapless one just gets a
    // process killed.
    const tightBytes = 4.5 * 1024 ** 3; // ~15% of 29GB
    const swaplessTight = classifyHostMemory({ ...mem, availableBytes: tightBytes }, { agentRssBytes: 8 * 1024 ** 3, agentSessions: 6 });
    const swappedTight = classifyHostMemory({ ...mem, availableBytes: tightBytes, swapTotalBytes: 8 * 1024 ** 3, swapFreeBytes: 8 * 1024 ** 3 }, { agentRssBytes: 8 * 1024 ** 3, agentSessions: 6 });
    assert(swaplessTight.level === 'warn', `15% headroom with no swap is a warning: ${JSON.stringify(swaplessTight.level)}`);
    assert(swappedTight.level === 'ok', `the same headroom WITH swap free is not: ${JSON.stringify(swappedTight.level)}`);
    const nearlyGone = classifyHostMemory({ ...mem, availableBytes: 1.5 * 1024 ** 3 }, { agentRssBytes: 8 * 1024 ** 3, agentSessions: 6 });
    assert(nearlyGone.level === 'crit' && nearlyGone.label === 'memory critical', 'under 8% headroom on a swapless host is red');

    // The many-small-processes shape: no single session is alarming, but the
    // agents collectively own the machine — which is exactly how 2026-08-06
    // played out (Postgres asked for memory; the kernel killed the fattest).
    const twelveAgents = classifyHostMemory({ ...mem, availableBytes: 9 * 1024 ** 3 }, { agentRssBytes: 12 * 1.8 * 1024 ** 3, agentSessions: 12, peakRssBytes: 1.8 * 1024 ** 3, peakName: 'claude', peakSession: 'core7' });
    assert(twelveAgents.level === 'crit', `12 agents at 1.8GB own 74% of RAM — that is red even with headroom left: ${JSON.stringify(twelveAgents)}`);
    assert(/across 12 sessions/.test(twelveAgents.reason), 'the host reason must say how the total is spread');
    assert(classifyHostMemory(null, {}) === null && classifyHostMemory({ totalBytes: 0 }, {}) === null,
      'no meminfo -> no host block at all (feature absent, never wrong)');
    for (const level of ['ok', 'warn', 'crit']) {
      const sample = { ok: okHost, warn: swaplessTight, crit: nearlyGone }[level];
      assert(typeof sample.label === 'string' && sample.label.length > 0,
        'every host level carries its state IN TEXT — color is never the only signal');
    }

    // Byte/day/CPU formatting: the sub-second CPU totals are the interesting
    // ones (a 6-minute poller accrues milliseconds), so they must not round
    // away to "0.0s".
    assert(fmtBytes(512 * 1024 * 1024) === '512 MB' && fmtBytes(1.5 * 1024 ** 3) === '1.5 GB', `fmtBytes: ${fmtBytes(1.5 * 1024 ** 3)}`);
    assert(fmtBytes(null) === '—', 'unknown bytes render as an em dash, not as 0');
    assert(fmtDays(0.5) === '12h' && fmtDays(7.84) === '7.8d' && fmtDays(17.9) === '18d', `fmtDays: ${fmtDays(17.9)}`);
    assert(fmtCpuSeconds(0.04) === '40ms' && fmtCpuSeconds(3.26) === '3.3s', `fmtCpuSeconds: ${fmtCpuSeconds(0.04)}`);

    console.log('smoke ok (process health: meminfo/statm/stat parsing, page-size calibration, subtree rollup + peak, thresholds replaying the 11.2GB & 18.4GB kills, swap-vs-swapless bands, 12-agent aggregate)');
  }

  // --- idle-but-active sessions (bd-console-xo8) ----------------------------
  // FIXTURES ONLY — injected clocks and synthetic CPU samples, no tmux, no
  // /proc. Replays the field case: an `agy` process ran 17 days in a forgotten
  // tmux session with zero user interaction, made 8,476 API calls and hit
  // RESOURCE_EXHAUSTED, and nothing surfaced it.
  {
    const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);
    const daysAgoSec = (d) => Math.floor((NOW - d * 86400000) / 1000);
    const busy = { windowMs: 12 * 60000, ticks: 400, cpuSeconds: 4, cpuPercent: 0.55, known: true, busy: true };
    const parked = { windowMs: 12 * 60000, ticks: 0, cpuSeconds: 0, cpuPercent: 0, known: true, busy: false };
    const notYet = { windowMs: 30000, ticks: 0, cpuSeconds: 0, cpuPercent: 0, known: false, busy: false };

    // The case itself: 17.9 days of total terminal silence, process still
    // burning CPU.
    const forgotten = idleVerdict({
      now: NOW, attached: 0, lastAttached: daysAgoSec(17.9), activity: daysAgoSec(17.9),
      created: daysAgoSec(20), cpu: busy, procName: 'Gemini (Antigravity)', idleDays: IDLE_DAYS_DEFAULT
    });
    assert(forgotten && /18d/.test(forgotten.label), `the marker must name the age: ${JSON.stringify(forgotten)}`);
    assert(/last attached/.test(forgotten.reason) && /CPU/.test(forgotten.reason),
      `the tooltip must name the EVIDENCE that produced the verdict: ${forgotten.reason}`);
    assert(/Gemini/.test(forgotten.reason), 'the reason names the process it measured');

    // Someone is attached right now: never a finding, however old the session.
    assert(idleVerdict({ now: NOW, attached: 1, lastAttached: daysAgoSec(30), activity: daysAgoSec(30), cpu: busy }) === null,
      'a session with a client attached is being watched by definition');

    // Alive but PARKED is not a finding either — that is every idle shell on
    // the host, and flagging them would drown the real one.
    assert(idleVerdict({ now: NOW, attached: 0, lastAttached: daysAgoSec(30), activity: daysAgoSec(30), cpu: parked }) === null,
      'a parked shell (zero CPU accrued) is not "still doing work"');
    assert(idleVerdict({ now: NOW, attached: 0, lastAttached: daysAgoSec(30), activity: daysAgoSec(30), cpu: null }) === null,
      'no CPU sample yet means NO VERDICT, which is not the same as "idle"');
    assert(idleVerdict({ now: NOW, attached: 0, lastAttached: daysAgoSec(30), activity: daysAgoSec(30), cpu: notYet }) === null,
      'a window shorter than the minimum must not produce a verdict');

    // Under the threshold: nothing, no matter how busy.
    assert(idleVerdict({ now: NOW, attached: 0, lastAttached: daysAgoSec(3), activity: daysAgoSec(3), cpu: busy }) === null,
      '3 days is a long weekend, not an abandoned session');

    // THE RULE THAT KEEPS THIS HONEST: silence must be total. A session driven
    // through this console's own send-keys (or through Termix) never updates
    // last_attached, but it DOES produce pane output — so recent output alone
    // must clear the flag.
    assert(idleVerdict({ now: NOW, attached: 0, lastAttached: daysAgoSec(30), activity: daysAgoSec(0.5), cpu: busy }) === null,
      'a session that printed something 12 hours ago is being driven by SOMETHING — do not call it forgotten');

    // Never attached, never printed: fall back to session creation so a
    // headless session started a month ago still ages.
    const headless = idleVerdict({ now: NOW, attached: 0, lastAttached: null, activity: null, created: daysAgoSec(30), cpu: busy });
    assert(headless && /never attached/.test(headless.reason), `a never-attached session ages from creation: ${JSON.stringify(headless)}`);

    // A server-mode session is MEANT to run unattended — still marked (a
    // forgotten server burns quota exactly like a forgotten TUI), but the
    // tooltip carries the counter-evidence instead of implying a fault.
    const server = idleVerdict({ now: NOW, attached: 0, lastAttached: daysAgoSec(20), activity: daysAgoSec(20), cpu: busy, serverMode: true });
    assert(server && /server mode/.test(server.reason), `server-mode sessions get the caveat, not silence: ${server.reason}`);

    // Configurable-ish: the constant is a documented default, not a law.
    assert(idleDaysSetting({}) === IDLE_DAYS_DEFAULT, 'no env -> the documented default');
    assert(idleDaysSetting({ BD_CONSOLE_IDLE_DAYS: '14' }) === 14, 'BD_CONSOLE_IDLE_DAYS overrides it');
    assert(idleDaysSetting({ BD_CONSOLE_IDLE_DAYS: 'nonsense' }) === IDLE_DAYS_DEFAULT, 'garbage falls back');
    assert(idleDaysSetting({ BD_CONSOLE_IDLE_DAYS: '0' }) >= 0.25, 'the override is clamped, never zero');

    // Degradation: junk in, null out, never a throw.
    for (const junk of [undefined, null, {}, { attached: null, cpu: {} }, { lastAttached: 'x', cpu: busy }]) {
      assert(idleVerdict(junk) === null, `garbage input must degrade to "no marker": ${JSON.stringify(junk)}`);
    }

    // --- the CPU sampler ----------------------------------------------------
    // The whole signal is a DELTA, so a single poll can never answer "is this
    // still doing work" — only two can. Keyed by pid because cumulative ticks
    // are monotonic per pid: that is the only arithmetic that survives a child
    // exiting mid-window without the session's total going backwards.
    const tracker = createCpuTracker();
    let t = NOW;
    const first = tracker.observe('agy', [{ pid: 500, cpuTicks: 1000 }, { pid: 501, cpuTicks: 20 }], t);
    assert(first && first.known === false && first.busy === false,
      'the FIRST sight of a pid has no history to subtract — no verdict yet');

    t += IDLE_CPU_MIN_WINDOW_MS + 1000;
    const second = tracker.observe('agy', [{ pid: 500, cpuTicks: 1004 }, { pid: 501, cpuTicks: 20 }], t);
    assert(second.known === true && second.busy === true && second.ticks === 4,
      `4 ticks over a settled window is evidence of work: ${JSON.stringify(second)}`);
    assert(second.cpuSeconds > 0 && second.cpuPercent > 0, 'the rate is reported so the tooltip can quote it');

    // A child exiting must not make the session's CPU go backwards.
    t += 60000;
    const afterChildExit = tracker.observe('agy', [{ pid: 500, cpuTicks: 1004 }], t);
    assert(afterChildExit.ticks === 4 && afterChildExit.busy === true,
      `a vanished pid stops contributing, it does not subtract: ${JSON.stringify(afterChildExit)}`);

    // A genuinely parked session accrues nothing and never claims work.
    const idleTracker = createCpuTracker();
    let it = NOW;
    idleTracker.observe('bash', [{ pid: 900, cpuTicks: 7 }], it);
    it += IDLE_CPU_MIN_WINDOW_MS + 1000;
    const stillParked = idleTracker.observe('bash', [{ pid: 900, cpuTicks: 7 }], it);
    assert(stillParked.known === true && stillParked.busy === false && stillParked.ticks === 0,
      `zero ticks over a settled window is a parked process: ${JSON.stringify(stillParked)}`);

    // The rolling window restarts so evidence stays RECENT, and a recent
    // observation keeps counting across the restart instead of blinking off.
    t += IDLE_CPU_MAX_WINDOW_MS + 1000;
    const rolled2 = tracker.observe('agy', [{ pid: 500, cpuTicks: 1004 }], t);
    assert(rolled2.ticks === 0 && rolled2.windowMs === 0, 'past the cap the baseline restarts');
    assert(rolled2.busy === true, 'a positive observation inside the evidence TTL survives the restart');

    // Bounded: pids and sessions we stop seeing are forgotten.
    tracker.prune(t + 3 * 60 * 60 * 1000);
    assert(tracker._sizes().pids === 0 && tracker._sizes().sessions === 0, 'the sampler must not grow without bound');

    // A session with no readable processes at all yields no sample (and so no
    // verdict) rather than a confident "not working".
    assert(tracker.observe('gone', [], t) === null, 'nothing measurable -> null, never a false negative dressed as a fact');

    console.log('smoke ok (idle-but-active: 18d silence + live CPU flags, attached/parked/recent-output/short-window do not, server-mode caveat, per-pid deltas survive child exit, sampler is bounded)');
  }

  // --- provider harness (lib/usage/harness.mjs, bd-console-hi7) --------------
  // The four adapters used to hand-roll a copy of this scaffolding each, so the
  // rules below were only ever asserted through whichever provider happened to
  // exercise them (the 429 backoff via Claude, TTLs via nothing at all). They
  // are shared now, so they are tested once, directly, against fabricated
  // providers — no fixture dirs, no network, no clock-waiting.
  //
  // Imported dynamically so this block stays self-contained and appendable
  // (bd-console-m90 will split this file; nothing above needs to change).
  {
    const { defineProvider } = await import('../lib/usage/harness.mjs');

    // ---- TTL is selected by the RESULT's status, not by the caller ---------
    // `other: 0` means "a failure is never served from cache", which is what
    // makes the selection observable without waiting out a real TTL.
    let ttlCalls = 0;
    const ttlStatuses = ['error', 'error', 'ok', 'ok'];
    const ttlProbe = defineProvider({
      provider: 'ttl-probe',
      ttl: { ok: 60_000, other: 0 },
      compute: async () => ({ provider: 'ttl-probe', status: ttlStatuses[ttlCalls++] || 'ok', fetchedAt: Date.now() })
    });
    const ttlA = await ttlProbe.get();
    assert(ttlA.status === 'error' && ttlCalls === 1, `first call should compute: ${JSON.stringify(ttlA)}`);
    await ttlProbe.get();
    assert(ttlCalls === 2, `an error result must take the failure TTL, not the ok one (compute calls: ${ttlCalls})`);
    const ttlOk = await ttlProbe.get();
    assert(ttlOk.status === 'ok' && ttlCalls === 3, `third call should compute the ok result: ${JSON.stringify(ttlOk)}`);
    const ttlCached = await ttlProbe.get();
    assert(ttlCalls === 3, `an ok result must be held for the ok TTL (compute calls: ${ttlCalls})`);
    assert(ttlCached.fetchedAt === ttlOk.fetchedAt, 'a cache hit must return the same computed value');
    // A provider with no `fresh` policy has no refresh button, so it neither
    // honors the flag nor stamps `cached` — Codex/Kimi/Gemini behavior.
    const ttlIgnoresFresh = await ttlProbe.get({ fresh: true });
    assert(ttlCalls === 3, `a provider without a fresh policy must ignore { fresh: true } (compute calls: ${ttlCalls})`);
    assert(ttlIgnoresFresh.cached === undefined, 'a provider without a refresh button must not stamp cached');

    // ---- fresh: bypasses a warm entry once, then is throttled --------------
    let freshCalls = 0;
    const freshProbe = defineProvider({
      provider: 'fresh-probe',
      ttl: { ok: 60_000, other: 60_000 },
      fresh: { minIntervalMs: 20_000 },
      compute: async () => ({ provider: 'fresh-probe', status: 'ok', n: ++freshCalls, fetchedAt: Date.now() })
    });
    const f1 = await freshProbe.get();
    assert(f1.n === 1 && f1.cached === undefined, `first computed result is not cached: ${JSON.stringify(f1)}`);
    const f2 = await freshProbe.get();
    assert(f2.n === 1 && f2.cached === true, `a warm poll is served from cache and says so: ${JSON.stringify(f2)}`);
    const f3 = await freshProbe.get({ fresh: true });
    assert(f3.n === 2 && f3.cached === undefined, `fresh must bypass a warm entry: ${JSON.stringify(f3)}`);
    const f4 = await freshProbe.get({ fresh: true });
    assert(f4.n === 2 && f4.cached === true,
      `a second fresh inside minIntervalMs must collapse into the first: ${JSON.stringify(f4)}`);

    // ---- backoff: one declaration buys long TTL + retryAt + fresh refusal --
    // ttl is 0 for BOTH ok and other here, so the only thing that can keep this
    // value warm is the backoff window — which is the point.
    let backoffCalls = 0;
    const backoffProbe = defineProvider({
      provider: 'backoff-probe',
      ttl: { ok: 0, other: 0 },
      backoff: { statuses: ['rate-limited'], ttlMs: 15 * 60_000 },
      fresh: { minIntervalMs: 0 }, // throttle disabled so ONLY the backoff can refuse
      compute: async () => { backoffCalls += 1; return { provider: 'backoff-probe', status: 'rate-limited', fetchedAt: Date.now() }; }
    });
    const b1 = await backoffProbe.get();
    assert(b1.status === 'rate-limited' && backoffCalls === 1, `first call computes: ${JSON.stringify(b1)}`);
    assert(typeof b1.retryAt === 'number' && (b1.retryAt - Date.now()) >= 10 * 60_000,
      `a backoff status must be stamped with retryAt: ${JSON.stringify(b1)}`);
    const b2 = await backoffProbe.get({ fresh: true });
    assert(backoffCalls === 1, `fresh must not go upstream during a backoff (compute calls: ${backoffCalls})`);
    assert(b2.cached === true && b2.retryAt === b1.retryAt, `cached backoff result keeps its retryAt: ${JSON.stringify(b2)}`);
    const b3 = await backoffProbe.get();
    assert(backoffCalls === 1 && b3.cached === true, `a normal poll during backoff is cached too: ${JSON.stringify(b3)}`);

    // ---- never throws, whatever compute() does -----------------------------
    for (const [name, compute] of [
      ['rejects', async () => { throw new Error('boom'); }],
      ['throws synchronously', () => { throw new Error('boom'); }],
      ['returns null', async () => null],
      ['returns a string', async () => 'not an object'],
      ['returns undefined', async () => undefined]
    ]) {
      const junk = defineProvider({
        provider: 'junk-probe', ttl: { ok: 0, other: 0 }, publishesQuota: false, compute
      });
      const value = await junk.get();
      assert(value && value.status === 'error' && value.provider === 'junk-probe',
        `compute() that ${name} must become status:error, not a rejection: ${JSON.stringify(value)}`);
      assert(Array.isArray(value.windows) && value.windows.length === 0,
        `a no-quota provider carries windows:[] even on the error path (${name}): ${JSON.stringify(value)}`);
      assert(typeof value.fetchedAt === 'number', `the error fallback must still be stamped (${name})`);
    }
    // A quota-publishing provider's error fallback stays shaped the way the
    // Claude and Codex adapters have always shaped theirs: no windows key at
    // all, so "we don't know" is not rendered as "zero gauges".
    const quotaJunk = defineProvider({
      provider: 'quota-junk', ttl: { ok: 0, other: 0 }, publishesQuota: true,
      compute: async () => { throw new Error('boom'); }
    });
    assert((await quotaJunk.get()).windows === undefined,
      'a quota-publishing provider must not grow an empty windows array on the error path');

    // ---- "publishes no quota" is enforced, not just documented -------------
    const sneaky = defineProvider({
      provider: 'sneaky-probe', ttl: { ok: 0, other: 0 }, publishesQuota: false,
      compute: async () => ({
        provider: 'sneaky-probe', status: 'ok', fetchedAt: Date.now(),
        windows: [{ id: 'invented', label: '5h', percent: 42, resetsAt: null }]
      })
    });
    const sneaked = await sneaky.get();
    assert(Array.isArray(sneaked.windows) && sneaked.windows.length === 0,
      `a provider that publishes no quota must not be able to grow a gauge: ${JSON.stringify(sneaked.windows)}`);

    console.log('smoke ok (usage harness: status-driven TTLs, fresh bypass + throttle, backoff beats fresh with retryAt, never throws on garbage, no-quota providers cannot grow a gauge)');
  }

  // --- gemini 429 dedupe (bd-console-a2h) -----------------------------------
  // Field-found: the adapter reported `exhaustedEvents: 3` for what was ONE
  // incident — the Antigravity CLI logs a single 429 up to three times as it
  // propagates through its logger, all inside the same glog second. It was also
  // a background cache refresh, on a machine whose owner hadn't opened the CLI
  // in weeks, so calling it a user quota hit overstated twice over. Driven
  // in-process against a fabricated log: same second = one incident, and the
  // origin is reported.
  {
    const { getGeminiUsage } = await import('../lib/usage/gemini.mjs');

    const dedupeRoot = join(tempRoot, 'usage-gemini-429');
    const dedupeApp = join(dedupeRoot, 'antigravity-cli');
    mkdirSync(join(dedupeApp, 'log'), { recursive: true });

    const pad2 = (n) => String(n).padStart(2, '0');
    const glog = (d, ms) => `${pad2(d.getMonth() + 1)}${pad2(d.getDate())} `
      + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${ms}`;
    const burstAt = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
    const earlierAt = new Date(Math.floor((Date.now() - 3_600_000) / 1000) * 1000);
    const startedAt = new Date(Math.floor((Date.now() - 7_200_000) / 1000) * 1000);
    const dedupeLogName = `cli-${startedAt.getFullYear()}${pad2(startedAt.getMonth() + 1)}`
      + `${pad2(startedAt.getDate())}_${pad2(startedAt.getHours())}`
      + `${pad2(startedAt.getMinutes())}${pad2(startedAt.getSeconds())}.log`;
    writeFileSync(join(dedupeApp, 'log', dedupeLogName), [
      `I${glog(startedAt, '000000')} ${process.pid} server.go:1417] Language server version: 1.1.4`,
      // An earlier, separate incident with no background marker: a distinct
      // second must stay a distinct incident, and an origin we can't prove is
      // reported as unknown rather than guessed.
      `E${glog(earlierAt, '100000')} ${process.pid} log.go:398] RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).`,
      // Mentions RESOURCE_EXHAUSTED but is not a 429 reply — the real log has
      // one of these inside a dumped JSON body. It must not be counted at all.
      `I${glog(earlierAt, '200000')} ${process.pid} log.go:100]     "status": "RESOURCE_EXHAUSTED"`,
      // The three-line propagation burst, verbatim in shape from the real log.
      `W${glog(burstAt, '652581')} ${process.pid} log_context.go:117] Cache(loadCodeAssistResponse): Singleflight refresh failed: RESOURCE_EXHAUSTED (code 429)`,
      `E${glog(burstAt, '653012')} ${process.pid} log.go:398] RESOURCE_EXHAUSTED (code 429)`,
      `W${glog(burstAt, '653202')} ${process.pid} log_context.go:117] Failed to refresh cache in background: RESOURCE_EXHAUSTED (code 429)`,
      ''
    ].join('\n'));

    const prevGeminiDir = process.env.BD_CONSOLE_GEMINI_DIR;
    process.env.BD_CONSOLE_GEMINI_DIR = dedupeRoot;
    try {
      const dedupe = await getGeminiUsage();
      assert(dedupe.status === 'ok', `the 429 fixture should read ok, got: ${JSON.stringify(dedupe.status)}`);
      const q = dedupe.quota;
      assert(q.exhaustedEvents === 2,
        `four 429-ish lines in two distinct seconds are TWO incidents, not four: ${JSON.stringify(q)}`);
      assert(q.exhaustedLogLines === 4,
        `the raw line count stays auditable (and the non-429 RESOURCE_EXHAUSTED line is not one of them): ${JSON.stringify(q)}`);
      assert(q.backgroundEvents === 1,
        `only the burst names itself a background cache refresh: ${JSON.stringify(q)}`);
      assert(q.lastExhaustedAt === burstAt.getTime(),
        `the newest incident dates the block (expected ${burstAt.getTime()}): ${JSON.stringify(q)}`);
      assert(q.lastExhaustedOrigin === 'background',
        `a burst logged by the background refresher must be labelled background, not a user quota hit: ${JSON.stringify(q)}`);
      assert(q.published === false && Array.isArray(dedupe.windows) && dedupe.windows.length === 0,
        'counting 429s must never turn into a quota gauge');
    } finally {
      if (prevGeminiDir === undefined) delete process.env.BD_CONSOLE_GEMINI_DIR;
      else process.env.BD_CONSOLE_GEMINI_DIR = prevGeminiDir;
    }
    console.log('smoke ok (usage API: gemini 429s dedupe by glog second — one incident logged three times counts once, and says it was a background cache refresh)');
  }

  console.log(`smoke ok: ${seedId}, ${quickRes.id}`);
} catch (err) {
  console.error(`smoke failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise((resolveP) => server.once('exit', () => resolveP()));
  }
  if (daemonPid && isPidAlive(daemonPid)) {
    try { process.kill(daemonPid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (firstRunPid && isPidAlive(firstRunPid)) {
    try { process.kill(firstRunPid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
