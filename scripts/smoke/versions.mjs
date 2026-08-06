// smoke: version checks: the bd binary and the Claude Code / Codex CLIs.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs versions
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { parseBdVersionStdout, compareVersions, isBehind } from '../../lib/bdversion.mjs';
import { parseCliVersionStdout } from '../../lib/cliversions.mjs';

export async function runVersions(ctx) {
  const { assert, getPort, waitFor, tempRoot, serverEntry } = ctx;

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
}
