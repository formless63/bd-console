// smoke: tmux sessions, agent detection, and process/host health.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs tmux
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

import { execFileSync } from 'node:child_process';
// Pure tmux agent-type/promptability classifier (bd-console-2gs) — importable
// here because every I/O-shaped input (argv, kimi server pids) is gathered by
// its caller, so the rules can be asserted against fixtures with no tmux
// server, no /proc, and no live agents.
import { classifyPane } from '../../lib/tmux.mjs';
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
} from '../../lib/health.mjs';

export async function runTmux(ctx) {
  const { assert, port } = ctx;

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
}
