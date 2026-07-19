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
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { PID_PATH, LOG_PATH } from './paths.mjs';
import {
  serviceUnitExists, isServiceActive, installAndStartService,
  refreshAndRestartService, stopService
} from './systemd.mjs';

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
  const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
  return Number.isFinite(pid) ? pid : null;
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

async function waitForReady(host, port, { timeoutMs = 5000, intervalMs = 125 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeMeta(host, port, Math.min(intervalMs * 3, 900));
    if (probe.reachable && probe.ok && looksLikeBdConsole(probe.data)) return probe.data;
    await sleep(intervalMs);
  }
  return null;
}

// --- supersede -------------------------------------------------------------
// Tears down anything currently serving `port`, in order: (1) a pid-file
// tracked plain daemon, (2) an active systemd unit, (3) a port-takeover
// check to catch anything the first two steps missed (e.g. a foreground
// instance). Returns a list of human-readable notes for the caller to print.
// Throws PortConflictError if the port is held by something that doesn't
// look like bd-console.
async function supersedeExisting({ host, port }) {
  const notes = [];

  // 1. pid-file-tracked plain daemon.
  const filePid = readPidFile();
  if (filePid && isProcessRunning(filePid)) {
    notes.push(`stopped previous plain daemon (pid ${filePid})`);
    await terminateProcess(filePid);
  }
  if (existsSync(PID_PATH)) {
    try { unlinkSync(PID_PATH); } catch { /* ignore */ }
  }

  // 2. active systemd unit. Stopped unconditionally (even if the new
  // deployment will itself be systemd-supervised) — the caller decides
  // whether to re-enable+start fresh or refresh+restart based on
  // `wasSystemdActive`.
  const wasSystemdActive = serviceUnitExists() && await isServiceActive();
  if (wasSystemdActive) {
    notes.push('stopped active systemd unit (bd-console.service)');
    await stopService();
  }

  // 3. port takeover — catches anything steps 1-2 didn't (e.g. a foreground
  // `bd-console` with no pid file, or lag in the systemd stop taking effect).
  const probe = await probeMeta(loopbackHost(host), port, 800);
  if (probe.reachable) {
    if (probe.ok && looksLikeBdConsole(probe.data)) {
      const heldPid = probe.data.pid;
      if (heldPid && heldPid !== filePid) {
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
export async function daemonStart({ host, port, persist, forwardArgs = [], serveEntry }) {
  const { notes, wasSystemdActive } = await supersedeExisting({ host, port });

  let supervised;
  let pid = null;
  let unitPath = null;

  if (persist) {
    supervised = 'systemd';
    const install = { execPath: process.execPath, serveEntry, forwardArgs };
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
    const child = spawn(process.execPath, [serveEntry, ...forwardArgs], {
      detached: true,
      stdio: ['ignore', out, err],
      env: process.env
    });
    child.unref();
    pid = child.pid;
    writeFileSync(PID_PATH, String(pid));
  }

  const meta = await waitForReady(host, port, { timeoutMs: 5000, intervalMs: 125 });
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
  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      result.stopped = true;
    } catch (e) {
      if (e.code === 'ESRCH') result.stale = true;
      else result.error = e.message;
    }
  } else {
    result.stale = true;
  }
  try { unlinkSync(PID_PATH); } catch { /* ignore */ }
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
  const pidAlive = pid !== null && isProcessRunning(pid);
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
