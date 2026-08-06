// lib/health.mjs — host memory + per-session process health.
//
// WHY THIS EXISTS (bd-console-oic): this hub runs on a 29GB machine with ZERO
// swap, and two Claude Code processes were OOM-killed in six days:
//   * 2026-07-31 03:48 — 18.4GB RSS. It was the lead orchestrator, so the
//     kill ended its tmux session and destroyed 8 in-flight agents' state.
//   * 2026-08-06 08:06 — 11.2GB RSS in a tmux-spawn scope; Postgres tripped
//     the global OOM and the kernel picked the fattest process, which
//     silently took the user's month-old `core` session with it.
// Neither was visible in advance. Nothing on this machine plotted "how much
// memory are my agents holding" against "how much does this box have left",
// and without swap there is no degraded middle ground to notice — the machine
// is fine, and then a process is gone.
//
// And (bd-console-xo8): an `agy` (Antigravity CLI) process ran 17 days in a
// forgotten tmux session with zero user interaction, made 8,476 API calls
// (~240/day, one poll every ~6 minutes) and hit RESOURCE_EXHAUSTED. Nothing
// surfaced it either; it was found by hand.
//
// Everything here is either (a) a pure function over already-gathered numbers,
// so scripts/smoke.mjs can pin the thresholds against fixtures with no /proc
// and no live agents, or (b) a single bounded /proc read that returns null on
// any failure. Nothing in this module throws, and nothing in it shells out.
//
// --- why RSS, and what RSS is not -------------------------------------------
// The number that matters for "will the OOM killer pick this process" is the
// kernel's own oom_badness score, which is (roughly) RSS + swap-used +
// page-table pages, normalized against total memory. RSS is therefore the
// honest proxy — not virtual size (VSZ counts reservations that were never
// touched and is routinely 10x higher for a Node process, which would make
// every agent look fatal) and not PSS (proportional set size splits shared
// pages between their sharers; it reads lower and is the RIGHT number for
// "how much would I get back by killing this", but it needs
// /proc/<pid>/smaps_rollup, which is far more expensive to read and often
// permission-restricted for other users' processes).
//
// Summing RSS over a process subtree DOUBLE-COUNTS pages shared between a
// parent and its forked children. That is deliberate and it errs in the safe
// direction for a warning system, but it also means the subtree total alone
// can mislead. So every rollup reports BOTH:
//   * rssBytes  — the subtree sum ("how much is this session responsible for")
//   * peakRssBytes — the single fattest process in it ("what the OOM killer
//     would actually aim at"), which is not double-counted and is the exact
//     shape of both real incidents.
// "One process at 18GB" and "twelve processes at 1.5GB" are different shapes
// of the same danger; the host-level aggregate below catches the second one.

import { readFile } from 'node:fs/promises';

const KiB = 1024, MiB = 1024 * 1024, GiB = 1024 * 1024 * 1024;

// USER_HZ. sysconf(_SC_CLK_TCK) is 100 on every Linux ABI in practice (it has
// been fixed at 100 for x86/x86_64/arm/arm64 for the entire lifetime of
// procfs), and it is not readable from Node without a native binding. Only
// used to turn tick deltas into a human "% of one core" figure — a wrong
// constant would scale that percentage, never change a verdict, because the
// idle detector keys off "ticks accrued at all", not off a rate threshold.
const USER_HZ = 100;

// ---------------------------------------------------------------------------
// /proc parsing — pure, so the formats are pinned by fixtures.
// ---------------------------------------------------------------------------

// /proc/<pid>/statm counts PAGES, not bytes, so the page size matters. 4096 is
// right on x86_64 but wrong on a 16K-page aarch64 host (Apple silicon VMs,
// some ARM servers), where it would under-report RSS by 4x — i.e. exactly the
// wrong direction for a warning. calibratePageSize() recovers the real value
// by reading our OWN process two ways: /proc/self/status reports VmRSS in
// explicit kB, /proc/self/statm reports the same quantity in pages. The ratio
// is the page size. Snapped to a real page size because the two files are read
// microseconds apart and our own RSS can move between them.
const PAGE_SIZES = [4 * KiB, 8 * KiB, 16 * KiB, 64 * KiB];
export function calibratePageSize(statmText, statusText) {
  const pages = Number(String(statmText || '').trim().split(/\s+/)[1]);
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(String(statusText || ''));
  if (!Number.isFinite(pages) || pages <= 0 || !m) return 4 * KiB;
  const ratio = (Number(m[1]) * KiB) / pages;
  let best = 4 * KiB, bestErr = Infinity;
  for (const size of PAGE_SIZES) {
    const err = Math.abs(Math.log(ratio / size));
    if (err < bestErr) { bestErr = err; best = size; }
  }
  // A ratio more than ~40% away from any real page size means the two reads
  // disagreed badly (our own RSS moved) — fall back rather than pick a wrong
  // page size with confidence.
  return bestErr < 0.35 ? best : 4 * KiB;
}

// /proc/<pid>/statm: "size resident shared text lib data dt" in pages.
export function parseStatm(text, pageSize = 4 * KiB) {
  const parts = String(text || '').trim().split(/\s+/);
  const resident = Number(parts[1]);
  if (!Number.isFinite(resident) || resident < 0) return null;
  return resident * pageSize;
}

// /proc/<pid>/stat: utime and stime are fields 14 and 15 (1-based), but field
// 2 is the executable name in parentheses and MAY CONTAIN SPACES AND
// PARENTHESES ("(node (main))" is legal), so the only safe parse is to split
// after the LAST ')'. Returns cumulative ticks this process has spent on CPU
// (monotonic for the lifetime of one pid) plus its starttime, which is what
// makes "this has been running for 17 days" sayable.
export function parseProcStat(text) {
  const s = String(text || '');
  const close = s.lastIndexOf(')');
  if (close < 0) return null;
  const rest = s.slice(close + 2).split(/\s+/);
  // rest[0] is field 3 (state), so field N is rest[N - 3].
  const utime = Number(rest[11]), stime = Number(rest[12]), starttime = Number(rest[19]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return {
    cpuTicks: utime + stime,
    startTicks: Number.isFinite(starttime) ? starttime : null
  };
}

// /proc/meminfo. MemAvailable is the kernel's own estimate of what a new
// allocation could get WITHOUT swapping — strictly better than MemFree, which
// counts page cache as "used" and reads alarmingly low on a healthy box.
export function parseMeminfo(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * KiB;
  }
  if (!Number.isFinite(out.MemTotal) || out.MemTotal <= 0) return null;
  return {
    totalBytes: out.MemTotal,
    freeBytes: Number.isFinite(out.MemFree) ? out.MemFree : null,
    // Pre-3.14 kernels have no MemAvailable; MemFree is the honest fallback.
    availableBytes: Number.isFinite(out.MemAvailable) ? out.MemAvailable
      : (Number.isFinite(out.MemFree) ? out.MemFree : null),
    swapTotalBytes: Number.isFinite(out.SwapTotal) ? out.SwapTotal : 0,
    swapFreeBytes: Number.isFinite(out.SwapFree) ? out.SwapFree : 0
  };
}

// ---------------------------------------------------------------------------
// /proc reads — Linux-only by construction, null on anything unexpected.
// ---------------------------------------------------------------------------

const PROC_OK = process.platform === 'linux';
let pageSizePromise = null;

export function pageSize() {
  if (!PROC_OK) return Promise.resolve(4 * KiB);
  if (!pageSizePromise) {
    pageSizePromise = (async () => {
      try {
        const [statm, status] = await Promise.all([
          readFile('/proc/self/statm', 'utf8'),
          readFile('/proc/self/status', 'utf8')
        ]);
        return calibratePageSize(statm, status);
      } catch { return 4 * KiB; }
    })();
  }
  return pageSizePromise;
}

// Two small reads per process (statm is one line, stat is one line). Called
// only for pids the caller already decided to walk — see processTree() in
// lib/tmux.mjs, which is bounded at PROC_MAX_NODES per pane. Never throws:
// a dead pid between the children read and this one is the normal case.
export async function readProcSample(pid, size) {
  if (!PROC_OK) return null;
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  const [statmText, statText] = await Promise.all([
    readFile(`/proc/${n}/statm`, 'utf8').catch(() => null),
    readFile(`/proc/${n}/stat`, 'utf8').catch(() => null)
  ]);
  if (statmText === null && statText === null) return null;
  const rss = statmText === null ? null : parseStatm(statmText, size);
  const cpu = statText === null ? null : parseProcStat(statText);
  return { rss, cpuTicks: cpu?.cpuTicks ?? null, startTicks: cpu?.startTicks ?? null };
}

export async function readHostMemory() {
  if (!PROC_OK) return null;
  try { return parseMeminfo(await readFile('/proc/meminfo', 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Rollups — pure.
// ---------------------------------------------------------------------------

// Number(), except that null/undefined/'' stay MISSING instead of becoming 0.
// This distinction is the whole ballgame here: a process whose /proc entry
// vanished mid-walk has an unknown RSS, and counting it as a 0-byte process
// would quietly understate a session (and, in the CPU sampler, invent a
// delta the next time that pid reads successfully).
function num(v) {
  if (v === null || v === undefined || v === '') return NaN;
  return Number(v);
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(bytes >= 10 * GiB ? 0 : 1)} GB`;
  if (bytes >= MiB) return `${Math.round(bytes / MiB)} MB`;
  return `${Math.max(0, Math.round(bytes / KiB))} KB`;
}

// nodes: [{ pid, name, rss, cpuTicks }] — a pane's bounded process subtree.
// Returns null when nothing in the subtree yielded a memory reading at all
// (non-Linux, dead pane, permission denied), which is what makes the whole
// feature ABSENT rather than wrong in those cases.
export function rollupProcesses(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let rss = 0, peakRss = 0, peakPid = null, peakName = '', procs = 0, cpuTicks = 0, samples = 0;
  for (const node of list) {
    const value = num(node?.rss);
    if (Number.isFinite(num(node?.cpuTicks))) cpuTicks += num(node.cpuTicks);
    if (!Number.isFinite(value) || value < 0) continue;
    samples++;
    procs++;
    rss += value;
    if (value > peakRss) { peakRss = value; peakPid = node?.pid ?? null; peakName = String(node?.name || ''); }
  }
  if (samples === 0) return null;
  return { rssBytes: rss, peakRssBytes: peakRss, peakPid, peakName, procs, cpuTicks };
}

// Merges pane rollups into one session rollup. Panes are separate process
// trees (separate pane pids), so summing them does not re-count anything the
// per-pane rollup already counted; peak stays a max, never a sum, because it
// answers a different question ("what would the OOM killer aim at").
export function combineRollups(rollups) {
  const list = (Array.isArray(rollups) ? rollups : []).filter(Boolean);
  if (list.length === 0) return null;
  const out = { rssBytes: 0, peakRssBytes: 0, peakPid: null, peakName: '', procs: 0, cpuTicks: 0 };
  for (const r of list) {
    out.rssBytes += Number(r.rssBytes) || 0;
    out.procs += Number(r.procs) || 0;
    out.cpuTicks += Number(r.cpuTicks) || 0;
    if ((Number(r.peakRssBytes) || 0) > out.peakRssBytes) {
      out.peakRssBytes = Number(r.peakRssBytes) || 0;
      out.peakPid = r.peakPid ?? null;
      out.peakName = r.peakName || '';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Thresholds. Every number below is a fraction of THIS host's MemTotal with an
// absolute floor, never a bare byte count, so the same rule is meaningful on
// the 29GB workstation these incidents happened on and on an 8GB laptop.
//
// Calibration, measured on the host that motivated the feature:
//   * a healthy Claude Code / Codex / Kimi session subtree sits at 0.25–0.6 GB
//     (9 live sessions sampled), i.e. ~1–2% of RAM;
//   * the two processes that were OOM-killed were 11.2GB (38% of RAM) and
//     18.4GB (63%).
// So the crit line at 25% of RAM (7.3GB here) is ~12x anything healthy ever
// measured and was crossed hours before either kill; the warn line at 12%
// (3.5GB here) is ~6x healthy — high enough that a normal session never trips
// it, low enough to be a warning rather than an obituary.
// ---------------------------------------------------------------------------
export const SESSION_WARN_FRACTION = 0.12;
export const SESSION_CRIT_FRACTION = 0.25;
export const SESSION_WARN_FLOOR = 2 * GiB;
export const SESSION_CRIT_FLOOR = 4 * GiB;

// Host headroom = MemAvailable + SwapFree, as a fraction of MemTotal.
//
// THE SWAP DISTINCTION IS LOAD-BEARING, not decoration. A machine with swap
// degrades when it runs out of RAM: it thrashes, everything gets slow, and a
// human notices and intervenes. A machine WITHOUT swap has no such stage —
// reclaim fails and the OOM killer fires, immediately, choosing by size. So a
// swapless host gets its warning bands set materially wider: 20%/8% instead of
// 12%/5%. On this 29GB box that means "under ~5.9GB available" is amber and
// "under ~2.4GB" is red.
export const HOST_HEADROOM_WARN_SWAPLESS = 0.20;
export const HOST_HEADROOM_CRIT_SWAPLESS = 0.08;
export const HOST_HEADROOM_WARN = 0.12;
export const HOST_HEADROOM_CRIT = 0.05;

// The OTHER shape of the same danger: no single session is alarming, but the
// agents COLLECTIVELY own the machine, so the next allocation by anything at
// all (a build, Postgres, a browser) is what triggers the kill — which is
// literally what happened on 2026-08-06, where Postgres tripped the global OOM
// and the kernel then picked the fattest Claude process.
export const AGENT_SHARE_WARN = 0.50;
export const AGENT_SHARE_CRIT = 0.70;

const RANK = { ok: 0, warn: 1, crit: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);

// Per-session level from its subtree RSS. Returns 'ok' when total is unknown —
// a threshold expressed as a fraction of an unknown quantity is not a verdict.
export function memoryLevel(rssBytes, totalBytes) {
  if (!Number.isFinite(rssBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return 'ok';
  if (rssBytes >= Math.max(SESSION_CRIT_FLOOR, totalBytes * SESSION_CRIT_FRACTION)) return 'crit';
  if (rssBytes >= Math.max(SESSION_WARN_FLOOR, totalBytes * SESSION_WARN_FRACTION)) return 'warn';
  return 'ok';
}

// Decorates a rollup with its level + the sentence that explains it. Pure.
export function describeSessionMemory(rollup, totalBytes) {
  if (!rollup) return null;
  const level = memoryLevel(rollup.rssBytes, totalBytes);
  const share = Number.isFinite(totalBytes) && totalBytes > 0
    ? Math.round((rollup.rssBytes / totalBytes) * 100) : null;
  const peakPart = rollup.procs > 1
    ? ` across ${rollup.procs} processes; largest single process ${fmtBytes(rollup.peakRssBytes)}${rollup.peakName ? ` (${rollup.peakName})` : ''}`
    : '';
  const head = `${fmtBytes(rollup.rssBytes)} resident${share === null ? '' : ` (${share}% of host RAM)`}${peakPart}.`;
  const tail = level === 'crit'
    ? ' That is in OOM-kill range on this host: the kernel picks the largest process, and a kill takes the whole tmux session with it.'
    : level === 'warn'
      ? ' Well above a healthy agent session (0.25–0.6 GB measured) — worth watching or restarting.'
      : '';
  return { ...rollup, level, sharePct: share, reason: head + tail };
}

// Host verdict. `agent` is the aggregate over sessions where an agent CLI was
// actually detected — that is the number a human can act on ("restart an
// agent"), as distinct from total system usage, which is mostly not theirs.
export function classifyHostMemory(mem, agent = {}) {
  if (!mem || !Number.isFinite(mem.totalBytes) || mem.totalBytes <= 0) return null;
  const total = mem.totalBytes;
  const swapTotal = Number.isFinite(mem.swapTotalBytes) ? mem.swapTotalBytes : 0;
  const swapFree = Number.isFinite(mem.swapFreeBytes) ? mem.swapFreeBytes : 0;
  const swapless = swapTotal <= 0;
  const available = Number.isFinite(mem.availableBytes) ? mem.availableBytes : null;
  const headroom = available === null ? null : available + swapFree;
  const headroomPct = headroom === null ? null : (headroom / total) * 100;

  const warnFrac = swapless ? HOST_HEADROOM_WARN_SWAPLESS : HOST_HEADROOM_WARN;
  const critFrac = swapless ? HOST_HEADROOM_CRIT_SWAPLESS : HOST_HEADROOM_CRIT;

  let level = 'ok';
  const reasons = [];
  if (headroom !== null) {
    if (headroom <= total * critFrac) level = worst(level, 'crit');
    else if (headroom <= total * warnFrac) level = worst(level, 'warn');
  }

  const agentRss = Number.isFinite(agent?.agentRssBytes) ? agent.agentRssBytes : null;
  const agentPct = agentRss === null ? null : (agentRss / total) * 100;
  if (agentPct !== null) {
    if (agentPct >= AGENT_SHARE_CRIT * 100) level = worst(level, 'crit');
    else if (agentPct >= AGENT_SHARE_WARN * 100) level = worst(level, 'warn');
  }

  if (headroom !== null) {
    reasons.push(`${fmtBytes(headroom)} of ${fmtBytes(total)} still available`
      + (swapless ? ' and this host has NO swap, so there is no slow-down stage before the OOM killer runs — it just picks the largest process.'
        : ` (including ${fmtBytes(swapFree)} of free swap).`));
  }
  if (agentRss !== null) {
    reasons.push(`Detected agent sessions hold ${fmtBytes(agentRss)}`
      + (agentPct === null ? '' : ` (${Math.round(agentPct)}% of RAM)`)
      + (agent.agentSessions ? ` across ${agent.agentSessions} session${agent.agentSessions === 1 ? '' : 's'}` : '') + '.');
  }
  if (Number.isFinite(agent?.peakRssBytes) && agent.peakRssBytes > 0) {
    reasons.push(`Largest single process: ${fmtBytes(agent.peakRssBytes)}${agent.peakName ? ` (${agent.peakName}` : ''}${agent.peakSession ? `, session ${agent.peakSession}` : ''}${agent.peakName ? ')' : ''}.`);
  }

  // Never signalled by color alone — the label IS the state, in words.
  const label = level === 'crit' ? 'memory critical' : level === 'warn' ? 'memory tight' : 'memory ok';

  return {
    ...mem,
    swapless,
    headroomBytes: headroom,
    headroomPct,
    agentRssBytes: agentRss,
    agentSessions: agent?.agentSessions ?? 0,
    agentPct,
    peakRssBytes: Number.isFinite(agent?.peakRssBytes) ? agent.peakRssBytes : null,
    peakName: agent?.peakName || '',
    peakSession: agent?.peakSession || '',
    level,
    label,
    reason: reasons.join(' ')
  };
}

// ---------------------------------------------------------------------------
// Idle-but-active detection (bd-console-xo8).
//
// WHAT COUNTS AS "NO USER ACTIVITY". tmux gives three usable fields:
//   session_attached      — clients attached RIGHT NOW. Non-zero means a human
//                           could be looking at it; never flag those.
//   session_last_attached — when a human last had it on screen.
//   session_activity      — when the session last produced OUTPUT. NOT a
//                           human signal (the forgotten `agy` bumped it every
//                           6 minutes for 17 days), but its absence is a
//                           strong one: a pane that has printed nothing for a
//                           week is a pane nobody is driving, by any route —
//                           not by attaching, not through this console's own
//                           send-keys, not through Termix.
// So the idle clock is max(last_attached, last_output): "nothing has happened
// in this terminal, by any means, for N days". Requiring BOTH is what keeps
// deliberately detached-but-driven sessions (this host runs several) out of
// the marker.
//
// WHAT COUNTS AS "STILL DOING WORK": the pane's process subtree is alive AND
// has accrued CPU time between samples. That is the only claim /proc supports
// without privileges. Deliberately NOT claimed: network I/O or API call counts
// — /proc/<pid>/net is namespace-wide, not per-process, and per-socket
// accounting needs CAP_NET_ADMIN or eBPF. The `agy` incident was 8,476 API
// calls, and this feature CANNOT see that; what it can see is that something
// nobody has touched in 17 days is still burning CPU, which is enough to go
// look.
//
// Why "accrued any CPU at all" and not a rate threshold: measured on this
// host, an idle agent TUI parked at a prompt burns ~0.8% of one core (spinner
// + input loop) while an actively-working one burns ~11%. A 6-minute poller
// like `agy` sits BELOW the idle TUI in average CPU. Any rate threshold that
// excludes the parked TUI also excludes the exact case this exists for. So the
// bar is "not parked": a plain shell measures a flat 0.00, agents do not.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

// N days of total terminal silence before a session is called unattended.
// Seven is a deliberate week: it survives a long weekend and a week of
// remote-driven work, and the field case had been silent for 17.9 days.
// Override with BD_CONSOLE_IDLE_DAYS (clamped to a sane range) — the constant
// is the documented default, not a hardcoded law.
export const IDLE_DAYS_DEFAULT = 7;
export function idleDaysSetting(env = process.env) {
  const raw = Number(env?.BD_CONSOLE_IDLE_DAYS);
  if (!Number.isFinite(raw)) return IDLE_DAYS_DEFAULT;
  return Math.min(365, Math.max(0.25, raw));
}

// CPU evidence needs a window long enough to be meaningful; /api/tmux is
// polled every ~8s, so this is ~15 polls. Below it, the verdict is simply
// "not yet known" — the marker stays off rather than guessing.
export const IDLE_CPU_MIN_WINDOW_MS = 120_000;
// Rolling window cap: past this the baseline restarts, so evidence always
// describes recent behaviour rather than something that happened at boot.
export const IDLE_CPU_MAX_WINDOW_MS = 15 * 60_000;
// How long a positive observation keeps counting after the window rolls, so
// the marker doesn't blink off for two minutes every quarter hour.
export const IDLE_CPU_EVIDENCE_TTL_MS = 30 * 60_000;

// createCpuTracker() — the one piece of state in this module. Keyed by pid
// (cumulative CPU ticks are monotonic per pid, so per-pid deltas are the only
// arithmetic that survives a child exiting mid-window: a vanished pid simply
// stops contributing instead of making the session's total go backwards).
// `now` is injected on every call precisely so smoke tests can drive it.
export function createCpuTracker() {
  const pids = new Map();      // pid -> { ticks, at }
  const sessions = new Map();  // name -> { startAt, ticks, lastBusyAt, seenAt }

  function observe(name, nodes, now = Date.now()) {
    const list = Array.isArray(nodes) ? nodes : [];
    let delta = 0, sampled = 0, oldest = now;
    for (const node of list) {
      const pid = num(node?.pid);
      const ticks = num(node?.cpuTicks);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(ticks)) continue;
      sampled++;
      const prev = pids.get(pid);
      pids.set(pid, { ticks, at: now });
      if (!prev) continue; // first sight of this pid — no history to subtract
      if (ticks > prev.ticks) delta += ticks - prev.ticks;
      if (prev.at < oldest) oldest = prev.at;
    }
    if (sampled === 0) { sessions.delete(name); return null; }

    let s = sessions.get(name);
    if (!s) s = { startAt: now, ticks: 0, lastBusyAt: 0, seenAt: now };
    s.seenAt = now;
    s.ticks += delta;
    if (delta > 0) s.lastBusyAt = now;
    if (now - s.startAt > IDLE_CPU_MAX_WINDOW_MS) { s.startAt = now; s.ticks = 0; }
    sessions.set(name, s);

    const windowMs = now - s.startAt;
    const settled = windowMs >= IDLE_CPU_MIN_WINDOW_MS;
    const recentlyBusy = s.lastBusyAt > 0 && now - s.lastBusyAt <= IDLE_CPU_EVIDENCE_TTL_MS;
    return {
      windowMs,
      ticks: s.ticks,
      cpuSeconds: s.ticks / USER_HZ,
      cpuPercent: windowMs > 0 ? ((s.ticks / USER_HZ) / (windowMs / 1000)) * 100 : 0,
      // known:false means "no verdict yet", which is NOT the same as "idle".
      known: settled,
      busy: (settled && s.ticks > 0) || recentlyBusy
    };
  }

  // Bounded: forget pids and sessions we stopped seeing. Called once per poll.
  function prune(now = Date.now(), maxAgeMs = 60 * 60_000) {
    for (const [pid, v] of pids) if (now - v.at > maxAgeMs) pids.delete(pid);
    for (const [name, v] of sessions) if (now - v.seenAt > maxAgeMs) sessions.delete(name);
  }

  return { observe, prune, _sizes: () => ({ pids: pids.size, sessions: sessions.size }) };
}

// idleVerdict() — PURE. Returns null (no marker) or the verdict object.
//
//   now           ms epoch
//   attached      tmux session_attached (client count)
//   lastAttached  epoch SECONDS or null
//   activity      epoch SECONDS or null (last pane output)
//   created       epoch SECONDS or null (fallback: never attached)
//   cpu           result of tracker.observe(), or null
//   procName      what to name in the tooltip
//   idleDays      threshold, days
export function idleVerdict(input = {}) {
  const now = Number.isFinite(input?.now) ? input.now : Date.now();
  const idleDays = Number.isFinite(input?.idleDays) ? input.idleDays : IDLE_DAYS_DEFAULT;
  if (Number(input?.attached) > 0) return null; // someone is watching it right now

  const secs = [input?.lastAttached, input?.activity].map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const created = Number(input?.created);
  // Never attached and never produced output: fall back to session creation,
  // so a session started headless a month ago still ages.
  const lastTouchSec = secs.length ? Math.max(...secs) : (Number.isFinite(created) && created > 0 ? created : null);
  if (lastTouchSec === null) return null;

  const sinceMs = now - lastTouchSec * 1000;
  if (!(sinceMs >= idleDays * DAY_MS)) return null;

  const cpu = input?.cpu;
  if (!cpu || !cpu.busy) return null; // alive-but-parked is not a finding

  const days = sinceMs / DAY_MS;
  const attachedSec = Number(input?.lastAttached);
  const outputSec = Number(input?.activity);
  const bits = [];
  bits.push(Number.isFinite(attachedSec) && attachedSec > 0
    ? `last attached ${fmtDays((now - attachedSec * 1000) / DAY_MS)} ago`
    : 'never attached');
  bits.push(Number.isFinite(outputSec) && outputSec > 0
    ? `last pane output ${fmtDays((now - outputSec * 1000) / DAY_MS)} ago`
    : 'no pane output recorded');

  const mins = Math.max(1, Math.round(cpu.windowMs / 60000));
  const work = `${input?.procName ? `${input.procName} is` : 'Its process is'} alive and used `
    + `${fmtCpuSeconds(cpu.cpuSeconds)} of CPU in the last ${mins} min`
    + ` (~${cpu.cpuPercent < 1 ? cpu.cpuPercent.toFixed(2) : cpu.cpuPercent.toFixed(0)}% of one core)`;

  // A server-mode session (`claude rc`, `codex app-server`, a `kimi web`
  // listener) is MEANT to run unattended, so "nobody attached" is not by
  // itself suspicious there. Still marked — a forgotten server burns quota
  // exactly like a forgotten TUI — but the tooltip carries the counter-
  // evidence instead of implying something is wrong.
  const serverNote = input?.serverMode
    ? ' Note: this session is in server mode, which is designed to run without anyone attached — that alone explains the silence, but not whether the work is still wanted.'
    : '';

  return {
    days,
    sinceMs,
    idleDays,
    cpuSeconds: cpu.cpuSeconds,
    cpuPercent: cpu.cpuPercent,
    windowMs: cpu.windowMs,
    serverMode: !!input?.serverMode,
    label: `unattended ${fmtDays(days)}`,
    reason: `Nobody has touched this session in ${fmtDays(days)} (${bits.join(', ')}), but ${work}. `
      + 'A forgotten session that is still running keeps spending API quota and memory — check whether it is still wanted.'
      + serverNote
  };
}

// Sub-second CPU totals are the interesting ones here (a 6-minute poller
// accrues milliseconds), so don't round them away to "0.0s".
export function fmtCpuSeconds(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

// "17.9d" reads as false precision past a couple of weeks; "18d" is enough.
export function fmtDays(days) {
  if (!Number.isFinite(days)) return '—';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 10) return `${days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}
