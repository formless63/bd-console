// smoke: provider usage: claude/codex/kimi/gemini adapters, history, harness.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs usage
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseScopedLimits, getClaudeUsage } from '../../lib/usage.mjs';

export async function runUsage(ctx) {
  const { assert, getPort, waitFor, tempRoot, serverEntry } = ctx;

  // --- provider usage adapters (lib/usage.mjs via GET /api/usage) ------------
  // Fixture-only: never reads the real ~/.claude, ~/.codex, ~/.kimi-code or
  // ~/.gemini, never hits the real network, never touches a real kimi server.
  // BD_CONSOLE_CLAUDE_DIR / BD_CONSOLE_CODEX_DIR / BD_CONSOLE_KIMI_DIR /
  // BD_CONSOLE_GEMINI_DIR redirect all four adapters at fabricated temp dirs the
  // same way BD_CONSOLE_CONFIG_DIR redirects the registry/config in
  // scripts/smoke/harness.mjs (which also pins all four at empty dirs, so a
  // section that forgets to override one still cannot read a real home).
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

  // --- provider harness (lib/usage/harness.mjs, bd-console-hi7) --------------
  // The four adapters used to hand-roll a copy of this scaffolding each, so the
  // rules below were only ever asserted through whichever provider happened to
  // exercise them (the 429 backoff via Claude, TTLs via nothing at all). They
  // are shared now, so they are tested once, directly, against fabricated
  // providers — no fixture dirs, no network, no clock-waiting.
  //
  // Imported dynamically so this block stays self-contained (bd-console-m90).
  {
    const { defineProvider } = await import('../../lib/usage/harness.mjs');

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
    const { getGeminiUsage } = await import('../../lib/usage/gemini.mjs');

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
}
