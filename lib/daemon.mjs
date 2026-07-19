// lib/daemon.mjs — pid-file-based background daemon start/stop/status.
//
// Behavior is moved as-is from the previous single-file serve.mjs (a future
// wave is expected to rewrite daemon management — this is a relocation, not a
// redesign).
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { PID_PATH, LOG_PATH } from './paths.mjs';

export function hostLabel(host) {
  return host === '0.0.0.0' ? 'localhost' : host;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Starts serveEntry (the serve.mjs bin path) as a detached background
// process, forwarding `forwardArgs` (e.g. ['--port', '5000']). Returns
// { alreadyRunning: true, pid } if a live instance is already tracked by the
// pid file, otherwise { alreadyRunning: false, pid } for the newly spawned
// process.
export function daemonStart({ forwardArgs, serveEntry }) {
  if (existsSync(PID_PATH)) {
    const pid = Number(readFileSync(PID_PATH, 'utf8'));
    if (isProcessRunning(pid)) {
      return { alreadyRunning: true, pid };
    }
  }
  const out = openSync(LOG_PATH, 'a');
  const err = openSync(LOG_PATH, 'a');
  const childArgs = [serveEntry, ...forwardArgs];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env // propagate environment variables
  });
  child.unref();
  writeFileSync(PID_PATH, child.pid.toString());
  return { alreadyRunning: false, pid: child.pid };
}

// Returns one of:
//   { running: false }                     — no pid file
//   { running: true, pid, stopped: true }   — signaled successfully
//   { running: true, pid, stale: true }     — pid file was stale (ESRCH)
//   { running: true, pid, error }           — signal failed for another reason
export function daemonStop() {
  if (!existsSync(PID_PATH)) return { running: false };
  const pid = Number(readFileSync(PID_PATH, 'utf8'));
  const result = { running: true, pid };
  try {
    process.kill(pid, 'SIGTERM');
    result.stopped = true;
  } catch (e) {
    if (e.code === 'ESRCH') result.stale = true;
    else result.error = e.message;
  }
  try { unlinkSync(PID_PATH); } catch {}
  return result;
}

// Returns { running: false } (no pid file), { running: true, pid }, or
// { running: false, stale: true, pid } (pid file present but process is dead).
export function daemonStatus() {
  if (!existsSync(PID_PATH)) return { running: false };
  const pid = Number(readFileSync(PID_PATH, 'utf8'));
  if (isProcessRunning(pid)) return { running: true, pid };
  return { running: false, stale: true, pid };
}
