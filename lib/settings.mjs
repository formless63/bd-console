// lib/settings.mjs — first-run interactive setup + the `bd-console settings`
// command family. lib/config.mjs stays the single source of truth for how
// settings *resolve*; everything here is UX (prompting, printing, and
// writing config.json via config.mjs's saveGlobalConfig).
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { CONFIG_PATH } from './paths.mjs';
import { DEFAULT_HOST, DEFAULT_PORT, isFirstRun, resolveSettings, saveGlobalConfig } from './config.mjs';
import { daemonStatus, nonLoopbackIPv4s } from './daemon.mjs';

const KEYS = ['host', 'port', 'token', 'persist'];

function validateAndCoerce(key, rawValue) {
  const raw = String(rawValue ?? '').trim();
  switch (key) {
    case 'port': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error('port must be an integer between 1 and 65535');
      }
      return n;
    }
    case 'host': {
      if (!raw) throw new Error('host must be a non-empty string');
      return raw;
    }
    case 'persist': {
      const lower = raw.toLowerCase();
      if (lower !== 'true' && lower !== 'false') throw new Error('persist must be true or false');
      return lower === 'true';
    }
    case 'token': {
      if (!raw) throw new Error('token must be a non-empty string');
      return raw;
    }
    default:
      throw new Error(`unknown setting: ${key} (expected one of ${KEYS.join(', ')})`);
  }
}

function formatValue(key, value) {
  if (key === 'token') {
    if (!value) return '(unset)';
    return `set (${String(value).slice(0, 4)}...)`;
  }
  return value === null || value === undefined || value === '' ? '(unset)' : String(value);
}

async function noteRestartIfRunning() {
  const s = resolveSettings({});
  const status = await daemonStatus({ host: s.host, port: s.port });
  if (status.running) console.log("restart to apply: bd-console start");
}

function printLanWanGuidance() {
  console.log('  [1] this machine / home LAN  -> bind 0.0.0.0, open writes (LAN-only exposure)');
  console.log('  [2] VPS / internet-exposed    -> bind to a private/tailnet interface, or 127.0.0.1');
  console.log("Note: if this box is ever exposed publicly, put an authenticating reverse proxy in");
  console.log("front (e.g. Pangolin's auth) rather than rely on the token alone.");
}

// --- first-run ---------------------------------------------------------
// Called only from the CLI paths that lead to actually serving traffic
// (bare `bd-console` foreground, `bd-console start`) — never from
// add/remove/list/settings/update. If this isn't a first run, it's a no-op.
export async function maybeFirstRunSetup({ argsHost, argsPort } = {}) {
  if (!isFirstRun({ argsHost, argsPort })) return;

  if (!process.stdin.isTTY) {
    console.log(
      `bd-console: first run detected — no config found and no --host/--port/env override given; `
      + `applying defaults (${DEFAULT_HOST}:${DEFAULT_PORT}, no token). `
      + `Change this anytime with 'bd-console settings'.`
    );
    return;
  }

  await runFirstRunInteractive();
}

async function runFirstRunInteractive() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('bd-console first-run setup');
    console.log('');
    console.log('Where will you access this dashboard from?');
    printLanWanGuidance();
    const choice = (await rl.question('Choice [1]: ')).trim() || '1';

    const patch = {};
    if (choice === '2') {
      const ips = nonLoopbackIPv4s();
      const options = [...ips, '127.0.0.1'];
      console.log('');
      console.log('Recommended: bind to a private interface (tailnet/VPN IP) rather than 0.0.0.0.');
      options.forEach((ip, i) => console.log(`  [${i + 1}] ${ip}`));
      console.log(`  [${options.length + 1}] bind 0.0.0.0 anyway (public) — a random token will be generated`);
      const hostChoice = (await rl.question(`Choice [1]: `)).trim() || '1';
      const idx = Number(hostChoice) - 1;
      if (idx >= 0 && idx < options.length) {
        patch.host = options[idx];
      } else {
        patch.host = '0.0.0.0';
        patch.token = randomBytes(16).toString('hex');
        console.log('');
        console.log(`Generated token (shown once, save it now): ${patch.token}`);
      }
    } else {
      patch.host = '0.0.0.0';
      console.log('');
      console.log(
        "Recommended: bind 0.0.0.0:4180 with open writes for LAN use. If you ever expose this "
        + "publicly, put an authenticating reverse proxy in front (e.g. Pangolin's auth) rather "
        + "than rely on the token."
      );
    }

    console.log('');
    const portAns = (await rl.question(`Port [${DEFAULT_PORT}]: `)).trim();
    if (portAns) {
      try {
        patch.port = validateAndCoerce('port', portAns);
      } catch (e) {
        console.warn(`${e.message} — using default ${DEFAULT_PORT}.`);
        patch.port = DEFAULT_PORT;
      }
    } else {
      patch.port = DEFAULT_PORT;
    }

    saveGlobalConfig(patch);
    console.log('');
    console.log(`Saved to ${CONFIG_PATH}`);
    console.log("Change these anytime with 'bd-console settings'.");
  } finally {
    rl.close();
  }
}

// --- `bd-console settings list` -----------------------------------------
export function printSettingsList() {
  const s = resolveSettings({});
  console.log('key      value                   source');
  for (const key of KEYS) {
    console.log(`${key.padEnd(9)}${formatValue(key, s[key]).padEnd(24)}${s.sources[key]}`);
  }
}

// --- `bd-console settings set <key> <value>` / `unset <key>` -----------
export async function settingsSet(key, value) {
  if (!key) throw new Error('usage: bd-console settings set <key> <value>');
  if (!KEYS.includes(key)) throw new Error(`unknown setting: ${key} (expected one of ${KEYS.join(', ')})`);
  if (value === undefined) throw new Error(`usage: bd-console settings set ${key} <value>`);
  const coerced = validateAndCoerce(key, value);
  saveGlobalConfig({ [key]: coerced });
  console.log(`Saved ${key} = ${key === 'token' ? 'set' : coerced} to ${CONFIG_PATH}`);
  await noteRestartIfRunning();
}

export async function settingsUnset(key) {
  if (!key) throw new Error('usage: bd-console settings unset <key>');
  if (!KEYS.includes(key)) throw new Error(`unknown setting: ${key} (expected one of ${KEYS.join(', ')})`);
  saveGlobalConfig({}, [key]);
  console.log(`Unset ${key} in ${CONFIG_PATH}`);
  await noteRestartIfRunning();
}

// --- `bd-console settings` (bare, interactive) ---------------------------
async function runInteractiveSettings() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const s = resolveSettings({});
    console.log('Current settings (Enter keeps the current value; type "unset" to clear an optional one):');
    console.log('');

    const patch = {};
    const unset = [];

    console.log(`host: ${s.host}  (source: ${s.sources.host})`);
    printLanWanGuidance();
    const hostAns = (await rl.question(`New host [${s.host}]: `)).trim();
    if (hostAns) patch.host = validateAndCoerce('host', hostAns);

    console.log('');
    console.log(`port: ${s.port}  (source: ${s.sources.port})`);
    const portAns = (await rl.question(`New port [${s.port}]: `)).trim();
    if (portAns) patch.port = validateAndCoerce('port', portAns);

    console.log('');
    console.log(`token: ${formatValue('token', s.token)}  (source: ${s.sources.token})`);
    const tokenAns = (await rl.question(`New token [Enter=keep, "unset"=clear]: `)).trim();
    if (tokenAns.toLowerCase() === 'unset') unset.push('token');
    else if (tokenAns) patch.token = validateAndCoerce('token', tokenAns);

    console.log('');
    console.log(`persist: ${s.persist}  (source: ${s.sources.persist})`);
    const persistAns = (await rl.question(`New persist [Enter=keep, "unset"=clear, true/false]: `)).trim();
    if (persistAns.toLowerCase() === 'unset') unset.push('persist');
    else if (persistAns) patch.persist = validateAndCoerce('persist', persistAns);

    if (Object.keys(patch).length === 0 && unset.length === 0) {
      console.log('');
      console.log('No changes.');
      return;
    }

    saveGlobalConfig(patch, unset);
    console.log('');
    console.log(`Saved to ${CONFIG_PATH}`);
    await noteRestartIfRunning();
  } finally {
    rl.close();
  }
}

// --- dispatch --------------------------------------------------------------
// `positional` is whatever followed the `settings` command word (e.g. []
// for bare, ['list'], ['set', 'host', '0.0.0.0'], ['unset', 'token']).
export async function runSettingsCommand(positional = []) {
  const [sub, ...rest] = positional;
  if (!sub) return runInteractiveSettings();
  if (sub === 'list') return printSettingsList();
  if (sub === 'set') return settingsSet(rest[0], rest[1]);
  if (sub === 'unset') return settingsUnset(rest[0]);
  throw new Error(`unknown settings subcommand: ${sub} (expected list, set, or unset)`);
}
