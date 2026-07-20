#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { renderServiceUnit } from '../lib/systemd.mjs';

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
