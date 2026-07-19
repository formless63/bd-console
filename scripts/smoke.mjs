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
const env = { ...process.env, BD_CONSOLE_CONFIG_DIR: configDir };

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let server;
let daemonPid; // tracked so `finally` can always clean it up, even on assertion failure

try {
  run('git', ['init'], { cwd: repoDir });
  run('git', ['config', 'user.name', 'bd-console smoke'], { cwd: repoDir });
  run('git', ['config', 'user.email', 'smoke@example.com'], { cwd: repoDir });

  writeFileSync(join(repoDir, 'README.md'), '# Smoke Repo\n\nThis is a smoke test.\n');
  mkdirSync(join(repoDir, 'docs'));
  writeFileSync(join(repoDir, 'docs', 'plan.md'), '# Plan\n\n- item\n');

  run('bd', ['init'], { cwd: repoDir });
  const seedId = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--labels', 'triage', '--title', 'Seed issue'], { cwd: repoDir }));
  run('bd', ['export', '-o', '.beads/issues.jsonl'], { cwd: repoDir });

  const initEntry = resolve(join(process.cwd(), 'scripts', 'init.mjs'));
  run(process.execPath, [initEntry, '--repo', repoDir, '--apply-agent-docs', '--create-missing-agent-docs'], { cwd: process.cwd(), env });
  assert(existsSync(join(repoDir, 'bd-console.json')), 'init did not create bd-console.json');
  assert(readFileSync(join(repoDir, 'bd-console.json'), 'utf8').includes('"host": "127.0.0.1"'), 'init config missing expected host');
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

  // --- daemon lifecycle: `start` always supersedes (Feature 1) --------------
  // BD_CONSOLE_PERSIST=0 is mandatory here: it forces the plain-spawn path so
  // this test never touches systemd/systemctl on the real machine.
  const daemonConfigDir = join(tempRoot, 'daemon-config');
  mkdirSync(daemonConfigDir, { recursive: true });
  const daemonEnv = { ...process.env, BD_CONSOLE_CONFIG_DIR: daemonConfigDir, BD_CONSOLE_PERSIST: '0' };
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
  assert(!isPidAlive(daemonPid2), 'daemon still running after `stop`');
  daemonPid = null;

  console.log(`smoke ok (daemon supersede): ${daemonPid1} -> ${daemonPid2}`);

  // --- systemd unit-file generation (Feature 2) ------------------------------
  // Pure text generation only — no systemctl calls, nothing installed, safe
  // to run unconditionally.
  const unitText = renderServiceUnit({
    execPath: '/usr/bin/node',
    serveEntry: '/opt/bd-console/serve.mjs',
    forwardArgs: ['--port', '4180']
  });
  assert(unitText.includes('ExecStart=/usr/bin/node /opt/bd-console/serve.mjs --port 4180'), 'unit file ExecStart mismatch');
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
  rmSync(tempRoot, { recursive: true, force: true });
}
