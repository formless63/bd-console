// lib/systemd.mjs — systemd --user unit generation + lifecycle helpers.
//
// Shared by lib/daemon.mjs (persist-by-default boot supervision) and
// scripts/init.mjs (`--install-service`, kept as a thin delegator).
//
// Everything that only reads or renders text is synchronous and side-effect
// free (safe to call from tests / smoke). Anything that touches the real
// systemd user session or filesystem is isolated in a small set of async
// functions so callers can gate them explicitly.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync, lstatSync } from 'node:fs';
import { SYSTEMD_USER_DIR } from './paths.mjs';
import { run } from './exec.mjs';

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

// Only carry settings that are part of bd-console's documented environment
// contract into the user unit. systemd does not inherit the launching shell's
// environment, and losing these here is especially surprising for a unit
// started after logout. Secrets are intentionally included only when the user
// explicitly supplied them in the environment; config-file credentials remain
// in config.json and are picked up through BD_CONSOLE_CONFIG_DIR.
export const PERSISTED_ENV_KEYS = [
  'BD_CONSOLE_CONFIG_DIR', 'BD_CONSOLE_HOST', 'BD_CONSOLE_PORT',
  'BD_CONSOLE_TOKEN', 'BD_CONSOLE_PERSIST', 'BD_CONSOLE_TRUSTED_HOSTS',
  'BD_CONSOLE_TERMIX_URL', 'BD_CONSOLE_TERMIX_TOKEN', 'BD_CONSOLE_TERMIX_HOST_ID',
  // Test/deployment isolation uses this path too; preserving it is harmless
  // and keeps a unit generated under an alternate state root self-contained.
  'BD_CONSOLE_SYSTEMD_DIR'
];

export function persistedEnvironment(environment = process.env) {
  return Object.fromEntries(PERSISTED_ENV_KEYS
    .filter((key) => environment && environment[key] !== undefined)
    .map((key) => [key, String(environment[key])]));
}

function quoteEnvironment(key, value) {
  // Environment= uses systemd's own quoting, not shell quoting. Escape `%`
  // too so a token containing a specifier cannot be expanded by systemd, and
  // encode controls so a credential can never inject another unit directive.
  const encoded = String(value).replace(/[\x00-\x1f\x7f"\\%]/g, (m) => {
    if (m === '%') return '%%';
    if (m === '"' || m === '\\') return `\\${m}`;
    return `\\x${m.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
  return `Environment="${key}=${encoded}"`;
}

// Pure text generation — no filesystem or systemctl calls. Safe to call and
// assert on from smoke/tests.
//
// PATH is captured from the invoking shell: systemd --user units get a
// minimal default PATH that typically lacks the dirs where `bd` (and nvm's
// node) live (~/.local/bin, ~/.nvm/...), which silently breaks every bd
// invocation the daemon makes once an export goes stale.
export function renderServiceUnit({ execPath, serveEntry, forwardArgs = [], path = process.env.PATH, environment = persistedEnvironment(process.env) }) {
  const execStart = [execPath, serveEntry, ...forwardArgs].map(quoteArg).join(' ');
  const envLines = path ? `Environment="PATH=${String(path).replace(/(["\\])/g, '\\$1')}"\n` : '';
  const settingsEnv = Object.entries(environment)
    .filter(([key, value]) => PERSISTED_ENV_KEYS.includes(key) && value !== undefined)
    .map(([key, value]) => `${quoteEnvironment(key, value)}\n`).join('');
  return `[Unit]
Description=bd-console Global Hub
After=network.target

[Service]
Type=simple
${envLines}ExecStart=${execStart}
${settingsEnv}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function runCmd(cmd, args) {
  return run(cmd, args, { encoding: 'utf8', timeout: 10000 });
}

export function systemctl(args) {
  return runCmd('systemctl', ['--user', ...args]);
}

export function serviceUnitExists() {
  if (!existsSync(serviceUnitPath())) return false;
  try {
    if (lstatSync(SYSTEMD_USER_DIR).isSymbolicLink() || lstatSync(serviceUnitPath()).isSymbolicLink()) return false;
    chmodSync(SYSTEMD_USER_DIR, 0o700);
    chmodSync(serviceUnitPath(), 0o600);
    return true;
  } catch { return false; }
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

function writeUnitFile({ execPath, serveEntry, forwardArgs, environment = persistedEnvironment(process.env) }) {
  mkdirSync(SYSTEMD_USER_DIR, { recursive: true, mode: 0o700 });
  if (lstatSync(SYSTEMD_USER_DIR).isSymbolicLink()) {
    throw new Error(`refusing to write a service unit through symlinked directory ${SYSTEMD_USER_DIR}`);
  }
  try { chmodSync(SYSTEMD_USER_DIR, 0o700); } catch { /* existing systemd dir may be managed externally */ }
  const path = serviceUnitPath();
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, renderServiceUnit({ execPath, serveEntry, forwardArgs, environment }), {
      encoding: 'utf8', mode: 0o600, flag: 'wx'
    });
    renameSync(tmp, path); // replaces a symlink entry instead of following it
    chmodSync(path, 0o600);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created or already renamed */ }
    throw err;
  }
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
export async function installAndStartService({ execPath, serveEntry, forwardArgs = [], environment = persistedEnvironment(process.env) }) {
  const path = writeUnitFile({ execPath, serveEntry, forwardArgs, environment });

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
export async function refreshAndRestartService({ execPath, serveEntry, forwardArgs = [], environment = persistedEnvironment(process.env) }) {
  const path = writeUnitFile({ execPath, serveEntry, forwardArgs, environment });

  const reload = await systemctl(['daemon-reload']);
  if (!reload.ok) return { ok: false, step: 'daemon-reload', error: reload.stderr.trim(), unitPath: path };

  const restart = await systemctl(['restart', SERVICE_NAME]);
  if (!restart.ok) return { ok: false, step: 'restart', error: restart.stderr.trim(), unitPath: path };

  return { ok: true, unitPath: path, lingerOk: null, lingerError: null };
}

export async function stopService() {
  return systemctl(['stop', SERVICE_NAME]);
}
