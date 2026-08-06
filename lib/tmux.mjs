// lib/tmux.mjs — tmux session introspection + literal prompt injection.
//
// All tmux interaction goes through execFile('tmux', [...args]) — args
// arrays only, never shell strings. Every function degrades gracefully when
// the tmux binary is missing or no tmux server is running: callers get
// { available: false } / empty results / {ok:false, error} rather than a
// thrown exception.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
// Reused deliberately: lib/usage.mjs already owns "where does Kimi Code keep
// its state" (incl. the BD_CONSOLE_KIMI_DIR test override). Detection here
// reads one more thing out of that same root — the server instance records —
// rather than re-deriving the path.
import { kimiRoot } from './usage.mjs';
// Process/host health (bd-console-oic, bd-console-xo8). Same division of
// labour as classifyPane(): this module does the bounded /proc walking, and
// lib/health.mjs owns the /proc formats, the thresholds and the verdicts — all
// pure, so they are pinned by fixtures in scripts/smoke.mjs instead of by
// whatever this machine happens to be doing.
import {
  readProcSample, readHostMemory, pageSize, rollupProcesses, combineRollups,
  describeSessionMemory, classifyHostMemory, createCpuTracker, idleVerdict, idleDaysSetting
} from './health.mjs';

// Defense in depth: tmux's `-t` target syntax has its own mini-grammar
// (session:window.pane, `=exact`, etc.) so even though we always pass args
// arrays (never a shell string), a crafted session "name" could still change
// which target a command resolves to. Reject anything that isn't a plain
// token before it ever reaches a tmux invocation.
export const SESSION_NAME_RE = /^[A-Za-z0-9_.:@-]+$/;

// Field separator for tmux format strings. tmux's format engine escapes most
// C0 control characters (e.g. 0x1f, 0x01, 0x1e all come back as literal
// "\NNN" text) when they appear literally in a -F string, but passes tab
// (0x09) through unescaped — so tab it is. Session names/paths/titles
// containing a literal tab are vanishingly rare and, worst case, just shift
// a field boundary rather than corrupting anything unsafely.
const SEP = '\t';

function runTmux(args, opts = {}) {
  return new Promise((resolveP) => {
    execFile('tmux', args, { maxBuffer: 8 * 1024 * 1024, timeout: 10000, ...opts }, (err, stdout, stderr) => {
      resolveP({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}

// Parses a tmux epoch-seconds format field into a Number, or null when the
// field is empty (tmux may print nothing for e.g. #{session_last_attached}
// on a session that's never been attached to) or non-positive/non-finite.
// Epoch 0 is treated the same as empty — "0" reads as "unset" here, not as
// the 1970 boundary, since that's the only sense tmux uses it in practice.
function parseEpochSeconds(v) {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Agent-type + promptability detection (bd-console-2gs)
//
// WHY THIS IS LAYERED: `pane_current_command` alone is NOT enough. Measured on
// a real multi-agent host:
//   * `claude rc` (Claude Code's Remote Control / spawn host — a SERVER, not a
//     prompt) reports pane_current_command=claude, exactly like an interactive
//     session does. Only the pane process's actual argv tells them apart.
//   * a Kimi Code pane can report pane_current_command=bash while the pane
//     TITLE still says "Kimi Code".
//   * `kimi-code` rewrites its own argv, so its web-server mode (an HTTP
//     listener, NOT a send-keys target) looks argv-identical to its TUI. The
//     only on-disk discriminator is ~/.kimi-code/server/instances/*.json,
//     which records the serving pid.
//   * the Gemini CLI's binary is `agy` (Antigravity), not `gemini`.
//
// So: tmux -F fields → the pane pid's /proc argv and its descendants' →
// pane title as a last-resort tiebreak. Every layer is optional; when a layer
// is unavailable (no /proc, dead pid, non-Linux, permission denied) detection
// degrades toward `unknown` and promptable:true — i.e. the behaviour that
// existed before this feature — so nothing regresses into "silently refuses".
// ---------------------------------------------------------------------------

const AGENT_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini (Antigravity)',
  kimi: 'Kimi Code'
};

export function agentLabel(agent) {
  return AGENT_LABELS[agent] || null;
}

// Executable basename → agent id. `agy` is the Antigravity/Gemini CLI's real
// binary name; `gemini` is kept for hosts still on the older name.
const AGENT_BY_BIN = new Map([
  ['claude', 'claude'], ['claude-code', 'claude'],
  ['codex', 'codex'], ['codex-cli', 'codex'],
  ['agy', 'gemini'], ['antigravity', 'gemini'], ['gemini', 'gemini'],
  ['kimi-code', 'kimi'], ['kimi', 'kimi']
]);

// argv[0]s that say nothing by themselves — step one token deeper.
const WRAPPER_BINS = new Set([
  'node', 'nodejs', 'bun', 'deno', 'npx', 'env', 'python', 'python3', 'tsx', 'ts-node',
  'sh', 'bash', 'zsh', 'dash'
]);

// A pane sitting at a plain shell prompt: not an agent, but still a perfectly
// valid send-keys target (that is what the scheduler has always done).
const SHELL_BINS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'nu', 'elvish']);

// Installed-path fingerprints, for the case where the binary is invoked via an
// absolute path whose basename carries no name (Claude Code's versioned
// launcher, `.../share/claude/versions/2.1.211`, is the live example).
// Only ever tested against argv[0]/argv[1] — never the whole argv — so an
// editor that happens to have a ~/.claude/... file open isn't mistaken for an
// agent.
const PATH_HINTS = [
  [/(^|\/)\.claude\/|\/claude\/versions\/|@anthropic-ai\/claude-code/, 'claude'],
  [/(^|\/)\.codex\/|@openai\/codex/, 'codex'],
  [/(^|\/)\.kimi-code\/|(^|\/)kimi-code\//, 'kimi'],
  [/antigravity/i, 'gemini']
];

// Subcommands that put an agent into a server/headless mode. send-keys into
// one of these types text at a process that is not reading a prompt — the
// exact silent no-op this feature exists to expose.
const SERVER_SUBCOMMANDS = {
  claude: new Set(['rc', 'mcp', 'serve']),
  codex: new Set(['app-server', 'mcp', 'mcp-server', 'proxy', 'exec', 'serve']),
  gemini: new Set(['mcp', 'serve', 'server']),
  kimi: new Set(['web', 'serve', 'server', 'mcp'])
};

// Same idea, flag-shaped. Deliberately per-agent, never generic: `-p` means
// "print / non-interactive" to claude and gemini but "profile" to codex, so a
// shared list would mislabel a perfectly interactive `codex -p work` session.
const SERVER_FLAGS = {
  claude: new Set(['-p', '--print', '--sdk-url', '--input-format', '--output-format']),
  codex: new Set(['--listen', '--headless']),
  gemini: new Set(['-p', '--prompt', '--headless', '--listen', '--port']),
  kimi: new Set(['--port', '--listen', '--headless', '--dangerous-bypass-auth'])
};

// Agent names as they show up in a pane TITLE. Word-anchored so "codium"
// doesn't read as "codex" and a cwd tail doesn't read as an agent.
const TITLE_HINTS = [
  [/\bkimi(\s|-)?code\b|\bkimi\b/i, 'kimi'],
  [/\bclaude(\s|-)?code\b|\bclaude\b/i, 'claude'],
  [/\bcodex\b/i, 'codex'],
  [/\bgemini\b|\bantigravity\b/i, 'gemini']
];

// argv[0] of a login shell is "-bash"; strip that and any directory part.
function binName(token) {
  if (!token) return '';
  const t = String(token).replace(/^-/, '');
  const cut = t.lastIndexOf('/');
  return (cut >= 0 ? t.slice(cut + 1) : t).trim().toLowerCase();
}

// Resolves one process's argv to { agent, idx } — idx being where the agent's
// own binary sits, so subcommand/flag scanning starts after it. Returns null
// when nothing in this argv names an agent.
function agentFromArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  let i = 0;
  // At most 3 hops so `env FOO=1 npx claude` resolves but a pathological argv
  // can't spin.
  for (let hops = 0; hops < 3; hops++) {
    const name = binName(argv[i]);
    if (!name) break;
    const direct = AGENT_BY_BIN.get(name);
    if (direct) return { agent: direct, idx: i };
    if (!WRAPPER_BINS.has(name)) break;
    let j = i + 1;
    while (j < argv.length && (String(argv[j]).startsWith('-') || String(argv[j]).includes('='))) j++;
    if (j >= argv.length) break;
    i = j;
  }
  for (const tok of argv.slice(0, 2)) {
    for (const [re, agent] of PATH_HINTS) if (re.test(String(tok))) return { agent, idx: argv.indexOf(tok) };
  }
  return null;
}

// The first server-mode token in an agent's own argv, or null. Returned as
// text so the UI can say WHICH signal made the call ("rc", "--print", …)
// instead of an unfalsifiable "trust me".
function serverSignal(agent, argv, idx) {
  const subs = SERVER_SUBCOMMANDS[agent];
  const flags = SERVER_FLAGS[agent];
  for (let i = idx + 1; i < argv.length; i++) {
    const tok = String(argv[i]);
    if (tok.startsWith('-')) {
      if (flags && flags.has(tok.split('=')[0])) return tok.split('=')[0];
      continue;
    }
    if (tok.includes('=')) continue;
    // First bare word after the binary is the subcommand; anything after it is
    // that subcommand's own argument, so stop looking either way.
    return subs && subs.has(tok.toLowerCase()) ? tok.toLowerCase() : nextFlagSignal(argv, i, flags);
  }
  return null;
}

// Flags can follow a subcommand (`claude rc --port 1`), so keep scanning flags
// once the subcommand itself came back clean.
function nextFlagSignal(argv, from, flags) {
  if (!flags) return null;
  for (let i = from; i < argv.length; i++) {
    const tok = String(argv[i]);
    if (tok.startsWith('-') && flags.has(tok.split('=')[0])) return tok.split('=')[0];
  }
  return null;
}

function verdict(agent, agentSource, mode, promptable, reason) {
  return { agent, agentLabel: agentLabel(agent), agentSource, mode, promptable, reason };
}

// classifyPane(pane) — PURE. Everything I/O-shaped has already been gathered
// by the caller, which is what makes this fixture-testable in scripts/smoke.mjs
// without a real tmux server or a real /proc.
//
//   pane.command   — tmux's #{pane_current_command}
//   pane.title     — tmux's #{pane_title}
//   pane.processes — [{ argv: [...], kimiServer?: boolean }], the pane pid
//                    first, then descendants, shallowest-first. May be [].
//
// Returns { agent, agentLabel, agentSource, mode, promptable, reason }:
//   mode 'interactive' — a known agent CLI at a prompt          → promptable
//   mode 'server'      — headless/serving; send-keys goes nowhere → NOT promptable
//   mode 'shell'       — no agent, just a shell                 → promptable
//   mode 'unknown'     — not enough evidence                    → promptable
// promptable is false ONLY for 'server'. Every uncertain path lands on true,
// which is the pre-detection behaviour.
export function classifyPane(pane = {}) {
  const command = String(pane?.command || '');
  const title = String(pane?.title || '');
  const processes = Array.isArray(pane?.processes) ? pane.processes : [];

  // Layer 1 — real argv of the pane process and its descendants. Shallowest
  // match wins: `bash -> claude rc -> (8 sdk children)` must read as one
  // `claude rc` server, not as eight headless children.
  for (const proc of processes) {
    const argv = Array.isArray(proc?.argv) ? proc.argv.map(String) : [];
    const hit = agentFromArgv(argv);
    if (!hit) continue;
    const { agent } = hit;
    const label = agentLabel(agent) || agent;
    if (agent === 'kimi' && proc?.kimiServer) {
      return verdict(agent, 'process', 'server', false,
        `${label} is serving its web UI from this pane (see ~/.kimi-code/server/instances) — it has no prompt to type into`);
    }
    const signal = serverSignal(agent, argv, hit.idx);
    if (signal) {
      return verdict(agent, 'process', 'server', false,
        `${label} is running in \`${signal}\` mode here — a server/headless process, not an interactive prompt`);
    }
    return verdict(agent, 'process', 'interactive', true, `${label} is running interactively here`);
  }

  // Layer 2 — tmux's own foreground-command field. Names the agent but says
  // nothing about its mode, so it can only ever conclude "interactive".
  const byCommand = AGENT_BY_BIN.get(binName(command));
  if (byCommand) {
    const label = agentLabel(byCommand) || byCommand;
    return verdict(byCommand, 'command', 'interactive', true,
      `${label} is the pane's foreground command`);
  }

  // Layer 3 — the pane title. Titles go STALE (a pane whose Kimi Code exited
  // keeps the title), so a title-only match names the agent but refuses to
  // claim a mode.
  for (const [re, agent] of TITLE_HINTS) {
    if (re.test(title)) {
      const label = agentLabel(agent) || agent;
      return verdict(agent, 'title', 'unknown', true,
        `${label} was matched from the pane title only — titles can be stale, so treat this as a guess`);
    }
  }

  if (SHELL_BINS.has(binName(command))) {
    return verdict(null, null, 'shell', true, 'A plain shell — text would be typed at the shell prompt');
  }
  return verdict(null, null, 'unknown', true, 'No agent detected in this pane');
}

// --- process-tree evidence gathering ---------------------------------------
// Linux-only by construction; every other platform (and every unreadable
// /proc) simply yields no processes, which sends classifyPane() to its
// tmux-field/title layers.
const PROC_MAX_DEPTH = 3;
const PROC_MAX_NODES = 24;
const PROC_OK = process.platform === 'linux';

async function readArgv(pid) {
  try {
    const buf = await readFile(`/proc/${pid}/cmdline`);
    return buf.toString('utf8').split('\0').filter((s) => s !== '');
  } catch { return null; }
}

// /proc/<pid>/task/<pid>/children is a single read that yields direct children
// — no full /proc scan, no ps(1). Absent on exotic kernels; that just means an
// empty child list, i.e. graceful degradation to the pane process alone.
async function readChildPids(pid) {
  try {
    const txt = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return txt.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; }
}

// BFS from the pane pid, bounded in both depth and node count so a pane
// running a fan-out (a `claude rc` host with a dozen SDK children) can't turn
// one /api/tmux poll into hundreds of reads.
//
// Each visited node also carries its resident memory + cumulative CPU ticks
// (bd-console-oic/xo8) — two extra one-line reads per node, taken here rather
// than in a second walk precisely because the OOM'd process in the 2026-08-06
// incident was a CHILD of the pane process, not the pane process itself. Both
// are optional: a node whose /proc entry vanished mid-walk keeps rss/cpuTicks
// null and the rollup simply has one fewer sample.
async function processTree(panePid, kimiPids, pgSize) {
  const pid = Number(panePid);
  if (!PROC_OK || !Number.isInteger(pid) || pid <= 0) return [];
  const out = [];
  let frontier = [pid];
  for (let depth = 0; depth <= PROC_MAX_DEPTH && frontier.length && out.length < PROC_MAX_NODES; depth++) {
    const [argvs, samples] = await Promise.all([
      Promise.all(frontier.map(readArgv)),
      Promise.all(frontier.map((p) => readProcSample(p, pgSize)))
    ]);
    const next = [];
    for (let i = 0; i < frontier.length && out.length < PROC_MAX_NODES; i++) {
      const argv = argvs[i];
      if (argv === null) continue; // dead or unreadable — skip, never throw
      const sample = samples[i];
      out.push({
        pid: frontier[i],
        argv,
        kimiServer: kimiPids.has(frontier[i]),
        name: binName(argv[0]),
        rss: sample?.rss ?? null,
        cpuTicks: sample?.cpuTicks ?? null
      });
      next.push(frontier[i]);
    }
    if (depth === PROC_MAX_DEPTH || out.length >= PROC_MAX_NODES) break;
    const kids = await Promise.all(next.map(readChildPids));
    frontier = kids.flat().slice(0, PROC_MAX_NODES);
  }
  return out;
}

// --- Kimi Code web-server pids ---------------------------------------------
// `kimi-code` overwrites its own argv, so argv can't distinguish `kimi web`
// (an HTTP server on a port — NOT promptable) from the TUI. Its server
// instance records can: each names the serving pid. A stale record could name
// a recycled pid, so only recently-heartbeated records count.
const KIMI_PID_TTL_MS = 15_000;
const KIMI_INSTANCE_MAX_AGE_MS = 10 * 60_000;
const KIMI_MAX_INSTANCE_FILES = 32;
let kimiPidCache = { at: 0, pids: new Set() };

async function kimiServerPids() {
  const now = Date.now();
  if (now - kimiPidCache.at < KIMI_PID_TTL_MS) return kimiPidCache.pids;
  const pids = new Set();
  try {
    const dir = join(kimiRoot(), 'server', 'instances');
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).slice(0, KIMI_MAX_INSTANCE_FILES);
    for (const name of names) {
      try {
        const data = JSON.parse(await readFile(join(dir, name), 'utf8'));
        const pid = Number.isInteger(data?.pid) ? data.pid : null;
        const beat = Number(data?.heartbeat_at ?? data?.started_at);
        if (!pid || !Number.isFinite(beat)) continue;
        if (Math.abs(now - beat) > KIMI_INSTANCE_MAX_AGE_MS) continue;
        pids.add(pid);
      } catch { /* one unreadable/garbage record must not sink the rest */ }
    }
  } catch { /* no ~/.kimi-code at all — the common case */ }
  kimiPidCache = { at: now, pids };
  return pids;
}

// Rolls per-pane verdicts up to the session. send-keys -t <session> lands in
// the ACTIVE pane of the session's current window, so that pane — not pane 0
// — is what "is this session promptable" has to mean.
//
// Memory rolls up differently and deliberately: it is the SUM over every pane
// (all of it is charged to this session, whichever pane you'd type into),
// while the peak stays a max. See lib/health.mjs for why both are reported.
function rollUp(session) {
  const panes = session.panes || [];
  const target = panes.find((p) => p.active) || panes[0] || null;
  session.agent = target?.agent ?? null;
  session.agentLabel = target?.agentLabel ?? null;
  session.agentSource = target?.agentSource ?? null;
  session.mode = target?.mode ?? 'unknown';
  session.promptable = target ? target.promptable !== false : true;
  session.reason = target?.reason || '';
  return session;
}

// Per-poll CPU sampler for the idle-but-active detector. Module-level because
// the whole signal IS the delta between polls — a single /api/tmux request can
// never answer "is this still doing work", only two of them can. Bounded: see
// prune() in lib/health.mjs.
const cpuTracker = createCpuTracker();

// listSessions(): merges `tmux list-sessions` with `tmux list-panes -a` into
// [{ name, created, attached, windows, activity, lastAttached,
//    agent, agentLabel, agentSource, mode, promptable, reason,
//    panes: [{command, cwd, title, pid, active, …same verdict fields}] }].
// `activity`/`lastAttached` are epoch seconds (Number) or null when tmux
// reports them empty/unset — see parseEpochSeconds above. The agent/mode/
// promptable fields are ADDITIVE — see classifyPane() for what they mean and
// how they degrade.
//
// Sessions and panes also carry `memory` (subtree RSS + peak process + level
// + reason) and sessions carry `idle` (null, or the unattended-but-working
// verdict), and the returned payload gains a top-level `host: { memory }`.
// All three come from lib/health.mjs and all three are OPTIONAL: on a host
// where /proc can't be read — non-Linux, a hardened container, a pid that
// died mid-walk — they are simply absent, never zero and never an error.
// Returns { available: false, sessions: [] } if tmux is absent or no server
// is running (list-sessions exits non-zero in both cases) — never throws.
export async function listSessions() {
  const sessionsRes = await runTmux([
    'list-sessions', '-F',
    `#{session_name}${SEP}#{session_created}${SEP}#{session_attached}${SEP}#{session_windows}${SEP}#{session_activity}${SEP}#{session_last_attached}`
  ]);
  if (!sessionsRes.ok) return { available: false, sessions: [] };

  const sessions = new Map();
  for (const line of sessionsRes.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, attached, windows, activity, lastAttached] = line.split(SEP);
    if (!name) continue;
    sessions.set(name, {
      name,
      created: Number(created) || 0,
      attached: Number(attached) || 0,
      windows: Number(windows) || 0,
      activity: parseEpochSeconds(activity),
      lastAttached: parseEpochSeconds(lastAttached),
      panes: []
    });
  }

  // Pane cwd is how the UI infers which repo/agent a session is running —
  // always included. A failure here just means panes stay empty; the
  // session list itself is still useful.
  const panesRes = await runTmux([
    'list-panes', '-a', '-F',
    `#{session_name}${SEP}#{pane_current_command}${SEP}#{pane_current_path}${SEP}#{pane_title}${SEP}#{pane_pid}${SEP}#{pane_active}${SEP}#{window_active}`
  ]);
  const allPanes = [];
  if (panesRes.ok) {
    for (const line of panesRes.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [session, command, cwd, title, pid, paneActive, windowActive] = line.split(SEP);
      const s = sessions.get(session);
      if (!s) continue;
      const pane = {
        command: command || '',
        cwd: cwd || '',
        title: title || '',
        pid: Number(pid) || 0,
        // "active" here means "the pane send-keys -t <session> would hit":
        // the active pane of the session's active window.
        active: paneActive === '1' && windowActive === '1'
      };
      s.panes.push(pane);
      allPanes.push(pane);
    }
  }

  // Detection is best-effort by contract: a rejected promise here would take
  // the whole session list with it, so the failure mode is "no verdict fields
  // beyond the classifier's own defaults", never a 500.
  let hostMemory = null;
  try {
    const [kimiPids, pgSize, mem] = await Promise.all([kimiServerPids(), pageSize(), readHostMemory()]);
    hostMemory = mem;
    await Promise.all(allPanes.map(async (pane) => {
      const processes = await processTree(pane.pid, kimiPids, pgSize);
      Object.assign(pane, classifyPane({ command: pane.command, title: pane.title, processes }));
      // Kept on the pane so the tmux cards can attribute a fat session to the
      // pane that owns it, and so the session rollup below has something to
      // sum. `nodes` is NOT returned to clients (argv can hold secrets — see
      // the token gate on /api/tmux/preview); only the numbers are.
      pane.memory = describeSessionMemory(rollupProcesses(processes), hostMemory?.totalBytes);
      pane.nodes = processes;
    }));
  } catch {
    for (const pane of allPanes) {
      if (pane.mode === undefined) Object.assign(pane, classifyPane({ command: pane.command, title: pane.title }));
    }
  }

  const list = Array.from(sessions.values()).map(rollUp);
  const payload = { available: true, sessions: list };
  try {
    decorateHealth(list, hostMemory);
    const host = classifyHostMemory(hostMemory, aggregateAgentMemory(list));
    if (host) payload.host = { memory: host };
  } catch { /* health is additive: absent beats broken */ }
  for (const s of list) for (const p of s.panes) delete p.nodes;
  return payload;
}

// Attaches per-session memory + idle verdicts. Split out of listSessions so a
// failure anywhere in here loses only the health fields, never the session
// list — the pre-existing behaviour has to survive intact.
function decorateHealth(list, hostMemory) {
  const now = Date.now();
  const idleDays = idleDaysSetting();
  for (const session of list) {
    const panes = session.panes || [];
    const rollup = combineRollups(panes.map((p) => p.memory));
    session.memory = describeSessionMemory(rollup, hostMemory?.totalBytes);
    const nodes = panes.flatMap((p) => (Array.isArray(p.nodes) ? p.nodes : []));
    const cpu = cpuTracker.observe(session.name, nodes, now);
    session.idle = idleVerdict({
      now,
      attached: session.attached,
      lastAttached: session.lastAttached,
      activity: session.activity,
      created: session.created,
      cpu,
      procName: session.agentLabel || session.memory?.peakName || panes[0]?.command || '',
      serverMode: session.promptable === false,
      idleDays
    });
  }
  cpuTracker.prune(now);
}

// Host-level aggregate: what the DETECTED AGENT sessions hold, which is the
// number a human can act on, plus the single largest process anywhere in tmux
// — the two different shapes of the same danger (twelve at 1.5GB vs one at
// 18GB). Sessions with no agent still contribute their peak, because the fat
// process that gets killed does not have to be an agent to take a session out.
function aggregateAgentMemory(list) {
  let agentRssBytes = 0, agentSessions = 0, measured = 0;
  let peakRssBytes = 0, peakName = '', peakSession = '';
  for (const s of list) {
    const m = s.memory;
    if (!m) continue;
    measured++;
    if (s.agent) { agentRssBytes += m.rssBytes; agentSessions++; }
    if (m.peakRssBytes > peakRssBytes) {
      peakRssBytes = m.peakRssBytes;
      peakName = m.peakName || '';
      peakSession = s.name;
    }
  }
  if (measured === 0) return {};
  return { agentRssBytes, agentSessions, peakRssBytes, peakName, peakSession };
}

// inspectSession(name): the promptability verdict for the ONE pane that
// send-keys -t <name> would land in (`list-panes -t <session>` resolves to the
// session's current window). Cheaper than listSessions() for the send path.
// Returns null when tmux can't answer — callers must treat null as "unknown",
// never as "not promptable".
export async function inspectSession(name) {
  if (!SESSION_NAME_RE.test(name || '')) return null;
  const r = await runTmux([
    'list-panes', '-t', name, '-F',
    `#{pane_current_command}${SEP}#{pane_current_path}${SEP}#{pane_title}${SEP}#{pane_pid}${SEP}#{pane_active}`
  ]);
  if (!r.ok) return null;
  const panes = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [command, cwd, title, pid, active] = line.split(SEP);
    panes.push({ command: command || '', cwd: cwd || '', title: title || '', pid: Number(pid) || 0, active: active === '1' });
  }
  const target = panes.find((p) => p.active) || panes[0];
  if (!target) return null;
  try {
    const [kimiPids, pgSize] = await Promise.all([kimiServerPids(), pageSize()]);
    const processes = await processTree(target.pid, kimiPids, pgSize);
    return classifyPane({ command: target.command, title: target.title, processes });
  } catch {
    return classifyPane({ command: target.command, title: target.title });
  }
}

// hasSession(name): boolean, never throws.
export async function hasSession(name) {
  if (!SESSION_NAME_RE.test(name || '')) return false;
  const r = await runTmux(['has-session', '-t', name]);
  return r.ok;
}

// capturePane(name, lines=120): text of the last N lines of a pane's
// scrollback + visible content. Returns '' on any failure (missing session,
// tmux absent, etc.) rather than throwing.
export async function capturePane(name, lines = 120) {
  if (!SESSION_NAME_RE.test(name || '')) return '';
  const n = Number.isFinite(Number(lines)) && Number(lines) > 0 ? Math.floor(Number(lines)) : 120;
  const r = await runTmux(['capture-pane', '-p', '-t', name, '-S', `-${n}`]);
  return r.ok ? r.stdout : '';
}

// sendPrompt(name, text, { force }): LITERAL injection into an existing
// interactive session. The -l flag on the first send-keys is required so
// prompt text is never interpreted as tmux key names; Enter is sent as a
// second, separate call. Validates the session exists first. Returns
// {ok:true} or {ok:false, error}; never throws.
//
// REFUSAL POLICY (bd-console-2gs) — why this refuses rather than warns:
//   * The failure it prevents is INVISIBLE. Typing a prompt at `claude rc` or
//     at a `kimi web` server returns success from tmux's point of view and
//     does nothing at all; a scheduled 3am prompt then reads as "delivered"
//     forever. A refusal is the only outcome a human ever finds out about.
//   * It refuses ONLY on the strongest evidence: mode 'server' derived from
//     agentSource 'process', i.e. we read the process's actual argv (or the
//     Kimi server's own instance record). Guesses from pane_current_command
//     or a pane title NEVER refuse — those layers always resolve to
//     promptable:true anyway.
//   * Detection can still be wrong, so the refusal is escapable in one step:
//     pass force:true (the API surfaces it as a 409 that names the override)
//     and the send proceeds unchanged.
//   * The scheduler calls this same function, so a job aimed at a server-mode
//     session now FAILS LOUDLY into the jobs list with this reason instead of
//     silently succeeding — which is the whole point.
export async function sendPrompt(name, text, opts = {}) {
  if (!SESSION_NAME_RE.test(name || '')) return { ok: false, error: 'bad session name' };

  const exists = await hasSession(name);
  if (!exists) return { ok: false, error: 'tmux session not found' };

  if (!opts.force) {
    const v = await inspectSession(name);
    if (v && v.promptable === false && v.agentSource === 'process') {
      return {
        ok: false,
        refused: true,
        verdict: v,
        error: `"${name}" is in ${v.mode} mode: ${v.reason}. Nothing typed here would reach a prompt — send again with force to override.`
      };
    }
  }

  const r1 = await runTmux(['send-keys', '-t', name, '-l', '--', String(text ?? '')]);
  if (!r1.ok) return { ok: false, error: (r1.stderr || 'tmux send-keys failed').trim() };

  const r2 = await runTmux(['send-keys', '-t', name, 'Enter']);
  if (!r2.ok) return { ok: false, error: (r2.stderr || 'tmux send-keys (Enter) failed').trim() };

  return { ok: true };
}
