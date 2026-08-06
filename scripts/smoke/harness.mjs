// Shared fixture/harness machinery for the smoke suite (bd-console-m90).
//
// Every domain module under scripts/smoke/ is handed the single `ctx` object
// built here, so the modules themselves contain assertions and (almost)
// nothing else. What lives here:
//
//   * the small assertion/process/HTTP helpers the sections all reuse
//     (assert, run, trimLastLine, getPort, waitFor, isPidAlive, waitForExit)
//   * setup(): one temp root, one throwaway git+beads repo, one `scripts/init.mjs`
//     run, one long-lived `serve.mjs` on a scratch port, and the health wait
//   * ISOLATION, enforced centrally rather than per section (see below)
//   * fixtures shared across domains (the "Smoke epic"), memoized so a single
//     domain can be run on its own without depending on another domain having
//     run first
//   * onCleanup()/teardown(), so a section that spawns a daemon can register
//     its reaping once and have it happen even when an assertion throws
//
// ISOLATION — the load-bearing part. Nothing in this suite may read, write, or
// restart anything belonging to the real machine:
//
//   * BD_CONSOLE_CONFIG_DIR is redirected at a temp dir, so the real hub
//     registry/config in ~/.config/bd-console is never opened, never written,
//     and never has a throwaway project registered into it.
//   * BD_CONSOLE_CLAUDE_DIR / _CODEX_DIR / _KIMI_DIR / _GEMINI_DIR are pinned
//     — on `process.env` itself, in setup(), before any child is spawned — at
//     empty fixture directories. Sections that want provider fixtures override
//     them with their own dirs; sections that don't care inherit an empty dir
//     rather than the developer's real ~/.claude, ~/.codex, ~/.kimi-code or
//     ~/.gemini. Because the pin is on process.env, EVERY child env built as
//     `{ ...process.env, ... }` inherits it and a future section physically
//     cannot forget to isolate itself. No credential file is ever read.
//   * BD_CONSOLE_PERSIST=0 / BD_CONSOLE_SYSTEMD_DIR in the daemon sections keep
//     systemd out of it; the real bd-console.service is never touched.
//
// childEnv() below is the one blessed way to build a child-process env: it
// starts from the (already isolated) process.env and requires the caller to
// name the config dir it wants.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options
  });
}

export function trimLastLine(text) {
  return text.trim().split('\n').pop();
}

export function getPort() {
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

export async function waitFor(url, tries = 50) {
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

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// SIGTERM shutdown isn't instantaneous — give a stopped process a grace
// window before asserting it's gone.
export async function waitForExit(pid, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}

// The four provider adapters (lib/usage/*.mjs) each resolve their data
// directory from one of these env vars, falling back to the real home when
// unset. setup() pins all four at empty fixture dirs so the fallback can never
// fire inside the suite.
const PROVIDER_DIR_VARS = ['BD_CONSOLE_CLAUDE_DIR', 'BD_CONSOLE_CODEX_DIR', 'BD_CONSOLE_KIMI_DIR', 'BD_CONSOLE_GEMINI_DIR'];

export async function setup() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'bd-console-smoke-'));
  const repoDir = join(tempRoot, 'repo');
  const configDir = join(tempRoot, 'config');
  mkdirSync(repoDir, { recursive: true });

  // Pin the provider dirs on process.env BEFORE anything is spawned, so every
  // `{ ...process.env }` child env in every section inherits the isolation.
  // Sections with provider fixtures still override these explicitly.
  const emptyProviderRoot = join(tempRoot, 'empty-provider-home');
  for (const varName of PROVIDER_DIR_VARS) {
    const dir = join(emptyProviderRoot, varName.replace('BD_CONSOLE_', '').replace('_DIR', '').toLowerCase());
    mkdirSync(dir, { recursive: true });
    process.env[varName] = dir;
  }

  // Isolate the hub registry/config from the real ~/.config/bd-console.
  // BD_CONSOLE_SCHED_INTERVAL shortens the scheduler's poll tick so the
  // scheduler smoke tests don't have to wait out the 15s production default.
  const env = childEnv({ configDir, BD_CONSOLE_SCHED_INTERVAL: '200' });

  const cleanups = [];
  const ctx = {
    // helpers — modules destructure what they need off ctx and nothing else
    assert, run, trimLastLine, getPort, waitFor, isPidAlive, waitForExit, childEnv,
    // fixture locations
    tempRoot, repoDir, configDir, env,
    // cross-domain state + shared fixtures (see fixtures below)
    state: {},
    onCleanup: (fn) => { cleanups.push(fn); },
    _cleanups: cleanups,
  };

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
  const server = spawn(process.execPath, [serverEntry, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitFor(`http://127.0.0.1:${port}/api/meta`);

  Object.assign(ctx, {
    initEntry, serverEntry, server, port, projectId, registry, registryPath, seedId,
    serverStderr: () => stderr,
    p: (path) => `http://127.0.0.1:${port}/api/p/${projectId}${path}`,
  });
  ctx.fixtures = createFixtures(ctx);
  return ctx;
}

// Build a child-process env. Starts from the already-isolated process.env (see
// the ISOLATION note at the top), so provider dirs are never the real home
// even when a caller only cares about the config dir.
export function childEnv({ configDir, systemdDir, ...extra } = {}) {
  const out = { ...process.env };
  if (configDir) out.BD_CONSOLE_CONFIG_DIR = configDir;
  if (systemdDir) out.BD_CONSOLE_SYSTEMD_DIR = systemdDir;
  return { ...out, ...extra };
}

// Fixtures shared BETWEEN domain modules. Memoized on ctx.state so that a full
// run creates each one exactly once (and in the same place it always was),
// while a single-domain run creates whatever it needs on demand instead of
// silently depending on another domain having run first.
function createFixtures(ctx) {
  return {
    // The "Smoke epic": created by the issues domain, reused by the settings
    // domain's defaultEpics round-trip.
    async smokeEpic() {
      if (!ctx.state.smokeEpic) {
        ctx.state.smokeEpic = await fetch(ctx.p('/create'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Smoke epic', type: 'epic' })
        }).then((r) => r.json());
      }
      return ctx.state.smokeEpic;
    },
  };
}

export async function teardown(ctx) {
  if (!ctx) return;
  for (const fn of ctx._cleanups || []) {
    try { await fn(); } catch { /* cleanup is best effort */ }
  }
  if (ctx.server && !ctx.server.killed) {
    ctx.server.kill('SIGTERM');
    await new Promise((resolveP) => ctx.server.once('exit', () => resolveP()));
  }
  if (ctx.tempRoot) rmSync(ctx.tempRoot, { recursive: true, force: true });
}
