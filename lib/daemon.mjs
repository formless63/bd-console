// lib/daemon.mjs — bd-console daemon lifecycle: start (always supersedes any
// existing deployment, with health verification), stop, status.
//
// Two supervision modes:
//   - "plain": a detached, pid-file-tracked node child process (the original
//     behavior).
//   - "systemd": a systemd --user unit (see lib/systemd.mjs) that keeps
//     bd-console running across logout/reboot. This is the default on Linux
//     when `systemctl --user` is functional (see lib/config.mjs `persist`).
//
// `start` always tears down whatever is currently serving the configured
// port — a stale pid-file process, an active systemd unit, or an unknown
// bd-console instance that's simply not tracked by either — before spawning
// the new one, then polls /api/meta until the replacement is actually
// answering requests.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { PID_PATH, LOG_PATH, CONFIG_DIR } from './paths.mjs';
import { randomBytes } from 'node:crypto';
import {
  serviceUnitExists, isServiceActive, serviceMainPid, installAndStartService,
  refreshAndRestartService, stopService, persistedEnvironment
} from './systemd.mjs';

const PID_META_PATH = `${PID_PATH}.meta`;

function tightenPrivateFile(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) chmodSync(path, 0o600);
  } catch { /* absent or unreadable state is handled by the caller */ }
}

function atomicPrivateWrite(path, content) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path); // replaces a symlink entry; never follows its target
    chmodSync(path, 0o600);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created or already renamed */ }
    throw err;
  }
}

export function hostLabel(host) {
  return host === '0.0.0.0' ? 'localhost' : host;
}

// Virtual bridge/tunnel interfaces (docker, libvirt, LXC, veth pairs, ...)
// aren't addresses a person browses to — skip them so wildcard-bind URL
// listings show the real LAN/tailnet addresses instead of 20 bridges.
const VIRTUAL_IF_RE = /^(docker|br-|veth|virbr|vmnet|lxc|lxd|cni|flannel|podman)/;

export function nonLoopbackIPv4s({ includeVirtual = false } = {}) {
  const nets = networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    if (!includeVirtual && VIRTUAL_IF_RE.test(name)) continue;
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// URLs a person can actually open: a wildcard bind resolves to the machine's
// real interface addresses (LAN IP first) with localhost as the fallback; a
// specific bind is just that address.
export function dashboardUrls(host, port) {
  if (host === '0.0.0.0' || host === '::') {
    const urls = nonLoopbackIPv4s().map((ip) => `http://${ip}:${port}`);
    urls.push(`http://localhost:${port}`);
    return urls;
  }
  return [`http://${hostLabel(host)}:${port}`];
}

function loopbackHost(host) {
  return (host === '0.0.0.0' || host === '::' || !host) ? '127.0.0.1' : host;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isProcessRunning(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile() {
  if (!existsSync(PID_PATH)) return null;
  tightenPrivateFile(PID_PATH);
  const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function procIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
    return { startTime: fields[19] || null, cmdline };
  } catch {
    // macOS and other supported non-Linux hosts have no /proc. `ps` still
    // gives us a stable process start time plus the exact command, which is
    // enough to reject a reused PID without making plain-daemon stop/start a
    // Linux-only feature.
    try {
      const line = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
        encoding: 'utf8', timeout: 1000,
      }).trim();
      if (!line) return null;
      return { startTime: line.slice(0, 24).trim(), cmdline: line.slice(24).trim() };
    } catch { return null; }
  }
}

function readPidMeta() {
  if (!existsSync(PID_META_PATH)) return null;
  tightenPrivateFile(PID_META_PATH);
  try {
    const value = JSON.parse(readFileSync(PID_META_PATH, 'utf8'));
    return value && Number.isInteger(value.pid) && value.pid > 0 ? value : null;
  } catch { return null; }
}

// A numeric PID is not an identity: it may have been reused after a crash.
// New pid files carry the /proc start time and command line; old numeric-only
// files remain usable only when /proc proves the target is bd-console.
function isBdConsoleProcess(pid, expected = null, serveEntry = null) {
  const actual = procIdentity(pid);
  if (!actual || !/\bserve\.mjs(?:\s|$)/.test(actual.cmdline)) return false;
  const expectedEntry = serveEntry || expected?.serveEntry;
  if (expectedEntry && !actual.cmdline.includes(String(expectedEntry))) return false;
  if (!expected) return true;
  return expected.pid === pid
    && (!expected.startTime || expected.startTime === actual.startTime)
    && (!expected.cmdline || expected.cmdline === actual.cmdline);
}

function writePidRecord(pid, serveEntry, nonce = randomBytes(16).toString('hex')) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort for existing dirs */ }
  atomicPrivateWrite(PID_PATH, String(pid));
  const identity = procIdentity(pid);
  atomicPrivateWrite(PID_META_PATH, JSON.stringify({
    pid, nonce, startTime: identity?.startTime || null, cmdline: identity?.cmdline || null,
    serveEntry: String(serveEntry || '')
  }) + '\n');
  return nonce;
}

function removePidRecord() {
  for (const path of [PID_PATH, PID_META_PATH]) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

// Thrown when `start` finds the port held by something that doesn't look
// like bd-console — we refuse to kill unknown processes.
export class PortConflictError extends Error {}

// --- /api/meta probing --------------------------------------------------
// `looksLikeBdConsole` intentionally checks for both `mode` and `hostname`
// (present on every bd-console /api/meta response, hub or per-project) so we
// don't mistake an arbitrary JSON API on the same port for bd-console.
function looksLikeBdConsole(data) {
  return !!data && typeof data === 'object'
    && typeof data.mode === 'string' && typeof data.hostname === 'string';
}

async function probeMeta(host, port, timeoutMs = 800) {
  try {
    const res = await fetch(`http://${loopbackHost(host)}:${port}/api/meta`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON — leave data null */ }
    return { reachable: true, ok: res.ok, status: res.status, data };
  } catch (err) {
    return { reachable: false, error: err };
  }
}

// --- process termination -------------------------------------------------
async function terminateProcess(pid, { graceMs = 3000, pollMs = 100 } = {}) {
  if (!isProcessRunning(pid)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if (e.code === 'ESRCH') return true;
    throw e;
  }
  const softDeadline = Date.now() + graceMs;
  while (Date.now() < softDeadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(pollMs);
  }
  if (isProcessRunning(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    const hardDeadline = Date.now() + 1000;
    while (Date.now() < hardDeadline) {
      if (!isProcessRunning(pid)) return true;
      await sleep(pollMs);
    }
  }
  return !isProcessRunning(pid);
}

async function waitForPortFree(host, port, { timeoutMs = 3000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeMeta(host, port, 500);
    if (!probe.reachable) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function waitForReady(host, port, { timeoutMs = 5000, intervalMs = 125, expectedPid = null, token } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeMeta(host, port, Math.min(intervalMs * 3, 900));
    if (probe.reachable && probe.ok && expectedMeta(probe.data, {
      host, port, pid: expectedPid, token
    })) return probe.data;
    await sleep(intervalMs);
  }
  return null;
}

function expectedMeta(data, { host, port, pid, token } = {}) {
  if (!looksLikeBdConsole(data)) return false;
  if (data.host !== host || data.port !== port) return false;
  if (pid !== undefined && pid !== null && data.pid !== pid) return false;
  if (token !== undefined && data.tokenRequired !== !!token) return false;
  return true;
}

// --- supersede -------------------------------------------------------------
// Tears down anything currently serving `port`, in order: (1) a pid-file
// tracked plain daemon, (2) an active systemd unit, (3) a port-takeover
// check to catch anything the first two steps missed (e.g. a foreground
// instance). Returns a list of human-readable notes for the caller to print.
// Throws PortConflictError if the port is held by something that doesn't
// look like bd-console.
async function supersedeExisting({ host, port, willReplaceUnit = false, serveEntry = null }) {
  const notes = [];

  // 1. pid-file-tracked plain daemon.
  const filePid = readPidFile();
  if (filePid && isProcessRunning(filePid)) {
    const record = readPidMeta();
    if (isBdConsoleProcess(filePid, record, serveEntry)) {
      notes.push(`stopped previous plain daemon (pid ${filePid})`);
      await terminateProcess(filePid);
    } else {
      notes.push(`left unrelated process referenced by stale pid file (pid ${filePid})`);
    }
  }
  removePidRecord();

  // 2. active systemd unit. The unit is machine-global, but it is only ours
  // to stop when (a) this start will itself manage the unit (persist mode
  // replaces it regardless of port), or (b) the unit's process is the one
  // actually holding OUR target port. A `start --port X` with persist off
  // must never take down a unit serving a different port.
  let wasSystemdActive = serviceUnitExists() && await isServiceActive();
  if (wasSystemdActive) {
    let stopUnit = willReplaceUnit;
    if (!stopUnit) {
      const unitPid = await serviceMainPid();
      const probe = await probeMeta(loopbackHost(host), port, 800);
      stopUnit = !!(unitPid && probe.reachable && probe.ok
        && expectedMeta(probe.data, { host, port, pid: unitPid })
        && isBdConsoleProcess(unitPid, null, serveEntry));
    }
    if (stopUnit) {
      notes.push('stopped active systemd unit (bd-console.service)');
      await stopService();
    } else {
      notes.push('left the active systemd unit running (it serves a different port)');
      wasSystemdActive = false;
    }
  }

  // 3. port takeover — catches anything steps 1-2 didn't (e.g. a foreground
  // `bd-console` with no pid file, or lag in the systemd stop taking effect).
  const probe = await probeMeta(loopbackHost(host), port, 800);
  if (probe.reachable) {
    if (probe.ok && looksLikeBdConsole(probe.data)) {
      const heldPid = probe.data.pid;
      if (!expectedMeta(probe.data, { host, port }) || !heldPid || !isBdConsoleProcess(heldPid, null, serveEntry)) {
        throw new PortConflictError(
          `Port ${port} is answering with an unverified bd-console identity. `
          + `Refusing to kill an unverified process — free the port manually or choose a different --port.`
        );
      }
      if (heldPid !== filePid) {
        notes.push(`stopped bd-console instance holding port ${port} (pid ${heldPid})`);
        await terminateProcess(heldPid);
      }
      const freed = await waitForPortFree(host, port, { timeoutMs: 3000 });
      if (!freed) {
        throw new PortConflictError(
          `Port ${port} is still answering after attempting to stop the existing bd-console instance.`
        );
      }
    } else {
      throw new PortConflictError(
        `Port ${port} is already in use by a process that does not look like bd-console `
        + `(no bd-console /api/meta response). Refusing to kill an unknown process — `
        + `free the port manually or choose a different --port.`
      );
    }
  }

  return { notes, wasSystemdActive };
}

// --- log tailing (for start-failure diagnostics) --------------------------
export function tailLogFile(path, lines = 15) {
  if (!existsSync(path)) return '';
  try {
    const text = readFileSync(path, 'utf8');
    const all = text.split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function tailJournal(lines = 15) {
  return new Promise((resolveP) => {
    execFile('journalctl', ['--user', '-u', 'bd-console.service', '-n', String(lines), '--no-pager'],
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => resolveP(err ? '' : stdout));
  });
}

// Reads the most relevant tail of logs for a failed start: the systemd
// journal when systemd is the supervisor, otherwise the plain LOG_PATH file.
export async function tailStartupLog(supervised, lines = 15) {
  if (supervised === 'systemd') {
    const journal = await tailJournal(lines);
    if (journal.trim()) return journal;
  }
  return tailLogFile(LOG_PATH, lines);
}

// --- start -----------------------------------------------------------------
// Always supersedes any existing deployment, then brings up a fresh one
// (systemd-supervised when `persist` is true, otherwise a detached plain
// daemon), then polls /api/meta until it's actually answering.
//
// Returns:
//   { supervised: 'systemd'|'plain', pid, ready, meta, notes, unitPath? }
// Throws PortConflictError (port held by a non-bd-console process) or an
// Error carrying `.supervised` and `.notes` if the new instance never
// becomes ready (caller should tail the log and exit nonzero).
export async function daemonStart({ host, port, token = null, persist, forwardArgs = [], serveEntry }) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(CONFIG_DIR, 0o700); } catch { /* surfaced by the file open below if unusable */ }
  const { notes, wasSystemdActive } = await supersedeExisting({ host, port, willReplaceUnit: !!persist, serveEntry });

  let supervised;
  let pid = null;
  let unitPath = null;

  if (persist) {
    supervised = 'systemd';
    const install = {
      execPath: process.execPath, serveEntry, forwardArgs,
      environment: persistedEnvironment(process.env)
    };
    const result = wasSystemdActive
      ? await refreshAndRestartService(install)
      : await installAndStartService(install);
    if (!result.ok) {
      const err = new Error(`systemd ${result.step} failed: ${result.error}`);
      err.supervised = supervised;
      err.notes = notes;
      throw err;
    }
    unitPath = result.unitPath;
    if (result.lingerError) notes.push(`warning: loginctl enable-linger failed (${result.lingerError})`);
  } else {
    supervised = 'plain';
    const out = openSync(LOG_PATH, 'a');
    const err = openSync(LOG_PATH, 'a');
    try { chmodSync(LOG_PATH, 0o600); } catch { /* best effort */ }
    const child = spawn(process.execPath, [serveEntry, ...forwardArgs], {
      detached: true,
      stdio: ['ignore', out, err],
      env: process.env
    });
    child.unref();
    pid = child.pid;
    writePidRecord(pid, serveEntry);
  }

  const expectedPid = pid ?? await serviceMainPid();
  const meta = await waitForReady(host, port, {
    timeoutMs: 5000, intervalMs: 125, expectedPid, token
  });
  if (!meta) {
    const failure = new Error(`bd-console did not become ready on port ${port} within 5s.`);
    failure.supervised = supervised;
    failure.notes = notes;
    throw failure;
  }

  return { supervised, pid: pid ?? meta.pid ?? null, ready: true, meta, notes, unitPath };
}

// --- stop --------------------------------------------------------------
// Stops whichever supervisor is currently running: an active systemd unit
// takes precedence (mirrors `start`'s supersede order), otherwise the
// pid-file-tracked plain daemon.
export async function daemonStop() {
  if (serviceUnitExists() && await isServiceActive()) {
    const result = await stopService();
    return {
      running: true,
      supervised: 'systemd',
      stopped: result.ok,
      error: result.ok ? null : result.stderr.trim()
    };
  }

  const pid = readPidFile();
  if (pid === null) return { running: false, supervised: 'none' };

  const result = { running: true, supervised: 'plain', pid };
  if (isProcessRunning(pid) && isBdConsoleProcess(pid, readPidMeta(), process.argv[1] || null)) {
    try {
      process.kill(pid, 'SIGTERM');
      result.stopped = true;
    } catch (e) {
      if (e.code === 'ESRCH') result.stale = true;
      else result.error = e.message;
    }
  } else if (isProcessRunning(pid)) {
    result.refused = true;
    result.error = 'pid file does not identify a bd-console process; refusing to terminate it';
  } else {
    result.stale = true;
  }
  if (!result.refused) removePidRecord();
  return result;
}

// --- status --------------------------------------------------------------
// Reports pid liveness, actual port reachability (a live /api/meta fetch —
// not just "is a process alive"), and how the running instance (if any) is
// supervised: 'systemd' (active user unit), 'plain' (pid-file daemon),
// 'foreground' (answering the port but not tracked by either — e.g. run
// directly without `start`), or 'none'.
export async function daemonStatus({ host, port } = {}) {
  const systemdActive = serviceUnitExists() && await isServiceActive();

  const pid = readPidFile();
  const pidAlive = pid !== null && isProcessRunning(pid) && isBdConsoleProcess(pid, readPidMeta());
  const stalePid = pid !== null && !pidAlive ? pid : null;

  const probe = port ? await probeMeta(host, port, 800) : { reachable: false };
  const portReachable = probe.reachable && probe.ok && looksLikeBdConsole(probe.data);

  let supervised = 'none';
  if (systemdActive) supervised = 'systemd';
  else if (pidAlive) supervised = 'plain';
  else if (portReachable) supervised = 'foreground';

  return {
    running: systemdActive || pidAlive || portReachable,
    supervised,
    pid: portReachable && probe.data.pid ? probe.data.pid : pid,
    pidAlive,
    stalePid,
    portReachable,
    meta: portReachable ? probe.data : null
  };
}
