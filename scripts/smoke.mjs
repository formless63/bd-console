#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { buildGraph } from '../public/ui/console2/graphModel.js';
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
import { LINK_TYPES as SERVER_LINK_TYPES } from '../lib/bd.mjs';
import { parseScopedLimits } from '../lib/usage.mjs';
import { parseBdVersionStdout, compareVersions, isBehind } from '../lib/bdversion.mjs';

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
      for (const pane of s.panes) {
        assert(typeof pane.command === 'string', 'tmux pane missing command');
        assert(typeof pane.cwd === 'string', 'tmux pane missing cwd');
        assert(typeof pane.title === 'string', 'tmux pane missing title');
      }
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

  console.log('smoke ok (settings set/list/unset round-trip)');

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
  // Fixture-only: never reads the real ~/.claude or ~/.codex, never hits the
  // real network. BD_CONSOLE_CLAUDE_DIR / BD_CONSOLE_CODEX_DIR redirect both
  // adapters at fabricated temp dirs the same way BD_CONSOLE_CONFIG_DIR
  // redirects the registry/config above.
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

    const usagePort = await getPort();
    const usageEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: usageConfigDir,
      BD_CONSOLE_CLAUDE_DIR: usageClaudeDir,
      BD_CONSOLE_CODEX_DIR: usageCodexDir
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
    const usageEmptyEnv = {
      ...process.env,
      BD_CONSOLE_CONFIG_DIR: usageEmptyConfigDir,
      BD_CONSOLE_CLAUDE_DIR: usageEmptyClaudeDir,
      BD_CONSOLE_CODEX_DIR: usageEmptyCodexDir
    };
    const usageEmptyServer = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(usageEmptyPort)], {
      cwd: process.cwd(), env: usageEmptyEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitFor(`http://127.0.0.1:${usageEmptyPort}/api/meta`);
      const emptyBody = await fetch(`http://127.0.0.1:${usageEmptyPort}/api/usage`).then((r) => r.json());
      assert(emptyBody.providers.claude.status === 'no-creds', `missing .credentials.json should report no-creds, got: ${JSON.stringify(emptyBody.providers.claude)}`);
      assert(emptyBody.providers.codex.status === 'no-data', `missing codex sessions dir should report no-data, got: ${JSON.stringify(emptyBody.providers.codex)}`);
      console.log('smoke ok (usage API: missing dirs -> no-creds/no-data)');
    } finally {
      usageEmptyServer.kill('SIGTERM');
      await new Promise((resolveP) => usageEmptyServer.once('exit', () => resolveP()));
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
      BD_CONSOLE_CODEX_DIR: usageEmptyCodexDir
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
