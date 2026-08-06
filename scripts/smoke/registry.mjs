// smoke: project registration and per-project git insight.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs registry
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export async function runRegistry(ctx) {
  const { assert, run, getPort, waitFor, tempRoot, repoDir, serverEntry, port, projectId, p, registryPath } = ctx;

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

  // --- POST /api/register (lib/registry.mjs registerProjectPath) -------------
  // The browser-side `bd-console add`. It shipped with UI + validation and no
  // coverage for one concrete reason: registering a throwaway project into the
  // SHARED fixture registry the harness sets up would silently widen every
  // hub-level aggregate that iterates all registered projects (/api/projects,
  // the usage/stats/CLI version loops), so a later assertion could start
  // failing for a reason that
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
}
