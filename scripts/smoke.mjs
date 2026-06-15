#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';

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
mkdirSync(repoDir, { recursive: true });

let server;

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
  run(process.execPath, [initEntry, '--repo', repoDir, '--apply-agent-docs', '--create-missing-agent-docs'], { cwd: process.cwd() });
  assert(existsSync(join(repoDir, 'bd-console.json')), 'init did not create bd-console.json');
  assert(readFileSync(join(repoDir, 'bd-console.json'), 'utf8').includes('"host": "127.0.0.1"'), 'init config missing expected host');
  assert(readFileSync(join(repoDir, 'AGENTS.md'), 'utf8').includes('BEGIN BD-CONSOLE SETUP'), 'AGENTS.md missing bd-console setup block');
  assert(readFileSync(join(repoDir, 'CLAUDE.md'), 'utf8').includes('BEGIN BD-CONSOLE SETUP'), 'CLAUDE.md missing bd-console setup block');

  const port = await getPort();
  const serverEntry = resolve(join(process.cwd(), 'serve.mjs'));
  server = spawn(process.execPath, [serverEntry, '--repo', repoDir, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitFor(`http://127.0.0.1:${port}/api/meta`);

  const meta = await fetch(`http://127.0.0.1:${port}/api/meta`).then((r) => r.json());
  assert(meta.name === 'repo', 'meta name mismatch');

  const issues0 = await fetch(`http://127.0.0.1:${port}/api/issues`).then((r) => r.json());
  assert(Array.isArray(issues0.issues) && issues0.issues.some((i) => i.id === seedId), 'seed issue missing from /api/issues');

  const docs = await fetch(`http://127.0.0.1:${port}/api/docs`).then((r) => r.json());
  assert(docs.docs.some((d) => d.path === 'README.md'), 'top-level README missing from /api/docs');
  assert(docs.docs.some((d) => d.path === 'docs/plan.md'), 'nested doc missing from /api/docs');

  const doc = await fetch(`http://127.0.0.1:${port}/api/doc?path=${encodeURIComponent('docs/plan.md')}`).then((r) => r.json());
  assert(doc.content.includes('Plan'), '/api/doc returned unexpected content');

  const comments0 = await fetch(`http://127.0.0.1:${port}/api/comments?id=${encodeURIComponent(seedId)}`).then((r) => r.json());
  assert(Array.isArray(comments0.comments), '/api/comments did not return an array');

  const commentRes = await fetch(`http://127.0.0.1:${port}/api/comment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, text: 'smoke comment' })
  }).then((r) => r.json());
  assert(commentRes.comments.some((c) => c.text === 'smoke comment'), 'comment write path failed');

  await fetch(`http://127.0.0.1:${port}/api/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, op: 'claim' })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `edit claim failed (${r.status})`);
  });

  await fetch(`http://127.0.0.1:${port}/api/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, op: 'set-priority', priority: '1' })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `edit priority failed (${r.status})`);
  });

  await fetch(`http://127.0.0.1:${port}/api/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, op: 'add-label', label: 'smoke' })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `edit label failed (${r.status})`);
  });

  const issuesAfterEdit = await fetch(`http://127.0.0.1:${port}/api/issues`).then((r) => r.json());
  const edited = issuesAfterEdit.issues.find((i) => i.id === seedId);
  assert(edited && edited.priority === 1, 'priority edit did not persist');
  assert(edited && edited.status === 'in_progress', 'claim action did not persist');
  assert(edited && (edited.labels || []).includes('smoke'), 'label edit did not persist');

  const quickRes = await fetch(`http://127.0.0.1:${port}/api/quick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Quick smoke issue', description: 'created by smoke', label: 'triage', priority: '3' })
  }).then((r) => r.json());
  assert(quickRes.id, 'quick capture did not return an issue id');

  const issues1 = await fetch(`http://127.0.0.1:${port}/api/issues`).then((r) => r.json());
  assert(issues1.issues.some((i) => i.id === quickRes.id), 'quick-captured issue missing after export refresh');

  console.log(`smoke ok: ${seedId}, ${quickRes.id}`);
} catch (err) {
  console.error(`smoke failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise((resolveP) => server.once('exit', () => resolveP()));
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
