// lib/systemd.mjs — systemd --user unit generation + lifecycle helpers.
//
// Shared by lib/daemon.mjs (persist-by-default boot supervision) and
// scripts/init.mjs (`--install-service`, kept as a thin delegator).
//
// Everything that only reads or renders text is synchronous and side-effect
// free (safe to call from tests / smoke). Anything that touches the real
// systemd user session or filesystem is isolated in a small set of async
// functions so callers can gate them explicitly.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { SYSTEMD_USER_DIR } from './paths.mjs';

export const SERVICE_NAME = 'bd-console.service';

export function serviceUnitPath() {
  return `${SYSTEMD_USER_DIR}/${SERVICE_NAME}`;
}

// True when `systemctl --user` can actually talk to a user session (i.e. a
// login session with a DBus user bus exists). False on non-Linux, when
// systemctl isn't installed, or when there's no user session (common in
// containers/CI) — callers use this to decide the default for `persist`.
export function systemctlUserAvailable() {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('systemctl', ['--user', 'show-environment'], {
      stdio: 'ignore',
      timeout: 2000
    });
    return true;
  } catch {
    return false;
  }
}

// systemd unit-file quoting: wrap in double quotes and escape backslashes/
// quotes if the argument contains anything that isn't safely bare. Good
// enough for the paths/flags bd-console forwards (no shell involved either
// way — systemd parses ExecStart= itself, execve()s directly).
function quoteArg(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

// Pure text generation — no filesystem or systemctl calls. Safe to call and
// assert on from smoke/tests.
//
// PATH is captured from the invoking shell: systemd --user units get a
// minimal default PATH that typically lacks the dirs where `bd` (and nvm's
// node) live (~/.local/bin, ~/.nvm/...), which silently breaks every bd
// invocation the daemon makes once an export goes stale.
export function renderServiceUnit({ execPath, serveEntry, forwardArgs = [], path = process.env.PATH }) {
  const execStart = [execPath, serveEntry, ...forwardArgs].map(quoteArg).join(' ');
  const envLines = path ? `Environment="PATH=${String(path).replace(/(["\\])/g, '\\$1')}"\n` : '';
  return `[Unit]
Description=bd-console Global Hub
After=network.target

[Service]
Type=simple
${envLines}ExecStart=${execStart}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function runCmd(cmd, args) {
  return new Promise((resolveP) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 10000 }, (err, stdout, stderr) => {
      resolveP({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}

export function systemctl(args) {
  return runCmd('systemctl', ['--user', ...args]);
}

export function serviceUnitExists() {
  return existsSync(serviceUnitPath());
}

export async function isServiceActive() {
  if (!serviceUnitExists()) return false;
  const r = await systemctl(['is-active', SERVICE_NAME]);
  return r.stdout.trim() === 'active';
}

// MainPID of the running unit, or null when inactive/unknown.
export async function serviceMainPid() {
  const r = await systemctl(['show', '-p', 'MainPID', '--value', SERVICE_NAME]);
  const pid = Number(r.stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function writeUnitFile({ execPath, serveEntry, forwardArgs }) {
  mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  const path = serviceUnitPath();
  writeFileSync(path, renderServiceUnit({ execPath, serveEntry, forwardArgs }), 'utf8');
  return path;
}

async function enableLinger() {
  const user = process.env.USER || process.env.LOGNAME || '';
  if (!user) return { lingerOk: false, lingerError: 'could not determine current user for loginctl enable-linger' };
  const linger = await runCmd('loginctl', ['enable-linger', user]);
  return {
    lingerOk: linger.ok,
    lingerError: linger.ok ? null : (linger.stderr.trim() || `loginctl enable-linger exited ${linger.code}`)
  };
}

// Writes/refreshes the unit file, daemon-reloads, and enables+starts it.
// loginctl enable-linger is best-effort: failures are reported but never
// abort the install. Real side effects — only call this when the caller has
// decided persist should actually be freshly installed (no unit was active
// before this call).
export async function installAndStartService({ execPath, serveEntry, forwardArgs = [] }) {
  const path = writeUnitFile({ execPath, serveEntry, forwardArgs });

  const reload = await systemctl(['daemon-reload']);
  if (!reload.ok) return { ok: false, step: 'daemon-reload', error: reload.stderr.trim(), unitPath: path };

  const enable = await systemctl(['enable', '--now', SERVICE_NAME]);
  if (!enable.ok) return { ok: false, step: 'enable --now', error: enable.stderr.trim(), unitPath: path };

  const { lingerOk, lingerError } = await enableLinger();
  return { ok: true, unitPath: path, lingerOk, lingerError };
}

// Refresh the unit file (flags may have changed) and restart via systemctl.
// Used by the superseding `start` path when a systemd unit is already the
// active supervisor — `restart` (rather than `enable --now`) is the correct
// verb since the unit is already enabled.
export async function refreshAndRestartService({ execPath, serveEntry, forwardArgs = [] }) {
  const path = writeUnitFile({ execPath, serveEntry, forwardArgs });

  const reload = await systemctl(['daemon-reload']);
  if (!reload.ok) return { ok: false, step: 'daemon-reload', error: reload.stderr.trim(), unitPath: path };

  const restart = await systemctl(['restart', SERVICE_NAME]);
  if (!restart.ok) return { ok: false, step: 'restart', error: restart.stderr.trim(), unitPath: path };

  return { ok: true, unitPath: path, lingerOk: null, lingerError: null };
}

export async function stopService() {
  return systemctl(['stop', SERVICE_NAME]);
}
