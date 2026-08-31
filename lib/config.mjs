// lib/config.mjs — global config loading + effective settings resolution.
//
// This is the single source of truth for how host/port/token/persist are
// resolved (precedence: CLI flags > env vars > global config file >
// defaults) and for detecting "first run" (see isFirstRun below). The
// interactive setup / `bd-console settings` UX lives in lib/settings.mjs and
// calls back into the helpers here to read and persist the config file.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_PATH, LEGACY_CONFIG_PATH } from './paths.mjs';
import { systemctlUserAvailable } from './systemd.mjs';

export const DEFAULT_PORT = 4180;
// Fallback bind changed from 127.0.0.1 -> 0.0.0.0 (see CHANGELOG / issue
// discussion). First-run (see isFirstRun) exists specifically so this new,
// more permissive default is never applied silently without at least a
// log line (non-TTY) or an interactive walkthrough (TTY).
export const DEFAULT_HOST = '0.0.0.0';

// A TCP port, or null when the value isn't one. `--port abc` used to become
// NaN, fail every `||` test in resolveSettings, and silently bind the DEFAULT
// port — so the user got a server on a port they didn't ask for and no error.
// Same 1-65535 rule lib/settings.mjs applies to `settings set port` (kept as a
// separate check there rather than importing across the CLI/config boundary).
export function parsePort(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

const CONFIG_MAX_STRING = 4096;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Config is user-editable JSON. Keep malformed values from flowing into
// arithmetic, path construction, or object spreads. Unknown keys are kept for
// forward compatibility (defaultEpics and future settings live here).
function normalizeConfigObject(value, path) {
  if (!isPlainObject(value)) {
    if (value !== undefined) console.warn(`bd-console: ignoring invalid config file at ${path} (top level must be an object)`);
    return {};
  }
  const out = { ...value };
  if ('port' in out && parsePort(out.port) === null) {
    console.warn(`bd-console: ignoring invalid port in config file at ${path}`);
    delete out.port;
  } else if ('port' in out) out.port = parsePort(out.port);
  for (const key of ['host', 'token']) {
    if (!(key in out)) continue;
    if (typeof out[key] !== 'string' || !out[key].trim() || out[key].length > CONFIG_MAX_STRING) {
      console.warn(`bd-console: ignoring invalid ${key} in config file at ${path}`);
      delete out[key];
    } else out[key] = out[key].trim();
  }
  if ('persist' in out && typeof out.persist !== 'boolean') {
    console.warn(`bd-console: ignoring invalid persist in config file at ${path}`);
    delete out.persist;
  }
  if ('termix' in out && !isPlainObject(out.termix)) {
    console.warn(`bd-console: ignoring invalid termix config at ${path}`);
    delete out.termix;
  }
  if ('defaultEpics' in out && !isPlainObject(out.defaultEpics)) {
    console.warn(`bd-console: ignoring invalid defaultEpics in config file at ${path}`);
    delete out.defaultEpics;
  }
  return out;
}

function ensurePrivateMode(path, mode, { strict = false } = {}) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      if (strict) throw new Error(`refusing to use symlink for private path ${path}`);
      return;
    }
    chmodSync(path, mode);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    if (strict) throw err;
  }
}

// Called by writers and by daemon startup. Existing installs get tightened
// in-place, while symlinked paths are never chmod'ed through to another file.
export function ensurePrivateConfigDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  ensurePrivateMode(CONFIG_DIR, 0o700, { strict: true });
  for (const path of [CONFIG_PATH, LEGACY_CONFIG_PATH]) ensurePrivateMode(path, 0o600);
}

export function loadConfigFile(path) {
  if (!path || !existsSync(path)) return {};
  try {
    return normalizeConfigObject(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch {
    console.warn(`bd-console: ignoring invalid config file at ${path}`);
    return {};
  }
}

// Global config lives at CONFIG_PATH (config.json). Older installs wrote
// `bd-console.json` inside the config dir instead — fall back to that if the
// new file isn't there yet.
export function loadGlobalConfig() {
  ensurePrivateConfigDir();
  if (existsSync(CONFIG_PATH)) return loadConfigFile(CONFIG_PATH);
  if (existsSync(LEGACY_CONFIG_PATH)) return loadConfigFile(LEGACY_CONFIG_PATH);
  return {};
}

// Per-workspace `bd-console.json` now only contributes docRoots; host/port/
// token are resolved solely from global config, env vars, or CLI flags.
export function loadWorkspaceConfig(workspacePath) {
  return loadConfigFile(join(workspacePath, 'bd-console.json'));
}

// persist: whether `start` should install/keep bd-console supervised by a
// systemd --user unit (see lib/systemd.mjs) so it survives logout/reboot.
// Precedence: env override > global config file > platform-probed default.
// The probe (systemctlUserAvailable) shells out to `systemctl --user`, so it
// only runs when neither an env override nor a config value is present.
function resolvePersistWithSource(globalConfig) {
  const envVal = process.env.BD_CONSOLE_PERSIST;
  if (envVal === '0') return { value: false, source: 'env' };
  if (envVal === '1') return { value: true, source: 'env' };
  if (envVal !== undefined) throw new Error(`BD_CONSOLE_PERSIST must be 0 or 1 (got '${envVal}')`);
  if (typeof globalConfig.persist === 'boolean') return { value: globalConfig.persist, source: 'config' };
  return { value: systemctlUserAvailable(), source: 'default' };
}

// Precedence: CLI flags > env vars > global config file > defaults.
// Also reports, per key, which tier actually supplied the effective value
// (`sources`) — used by `bd-console settings list` / the interactive
// walkthrough so users can see *why* a value is what it is.
export function resolveSettings({ argsPort, argsHost } = {}) {
  const globalConfig = loadGlobalConfig();

  const envPort = process.env.BD_CONSOLE_PORT;
  const parsedArgPort = argsPort === undefined || argsPort === null ? null : parsePort(argsPort);
  if (argsPort !== undefined && argsPort !== null && parsedArgPort === null) {
    throw new Error(`port must be an integer between 1 and 65535 (got '${argsPort}')`);
  }
  const parsedEnvPort = envPort === undefined ? null : parsePort(envPort);
  if (envPort !== undefined && parsedEnvPort === null) {
    throw new Error(`BD_CONSOLE_PORT must be an integer between 1 and 65535 (got '${envPort}')`);
  }
  const portSource = parsedArgPort !== null ? 'flag' : (parsedEnvPort !== null ? 'env' : (globalConfig.port !== undefined ? 'config' : 'default'));
  const port = parsedArgPort ?? parsedEnvPort ?? globalConfig.port ?? DEFAULT_PORT;

  const envHost = process.env.BD_CONSOLE_HOST;
  const checkedArgHost = argsHost === undefined || argsHost === null ? null : String(argsHost).trim();
  if (argsHost !== undefined && argsHost !== null && !checkedArgHost) throw new Error('--host needs an address or hostname');
  if (envHost !== undefined && (!String(envHost).trim() || String(envHost).length > CONFIG_MAX_STRING)) {
    throw new Error('BD_CONSOLE_HOST must be a non-empty address or hostname');
  }
  const hostSource = checkedArgHost ? 'flag' : (envHost ? 'env' : (globalConfig.host ? 'config' : 'default'));
  const host = checkedArgHost || (envHost && String(envHost).trim()) || globalConfig.host || DEFAULT_HOST;

  const envToken = process.env.BD_CONSOLE_TOKEN;
  if (envToken !== undefined && envToken.trim().length > CONFIG_MAX_STRING) {
    throw new Error(`BD_CONSOLE_TOKEN is too long (max ${CONFIG_MAX_STRING} characters)`);
  }
  const tokenSource = envToken && envToken.trim() ? 'env' : (globalConfig.token ? 'config' : 'default');
  const token = envToken && envToken.trim() ? envToken.trim() : (globalConfig.token || null);

  const { value: persist, source: persistSource } = resolvePersistWithSource(globalConfig);

  return {
    port, host, token, persist, globalConfig,
    sources: { port: portSource, host: hostSource, token: tokenSource, persist: persistSource }
  };
}

// --- Termix linkage -------------------------------------------------------
// Termix (https://github.com/Termix-SSH/Termix) is a self-hosted web SSH /
// terminal manager. lib/termix.mjs turns these three values into a per-session
// deep link, so a tmux row in the hub opens that session inside Termix instead
// of making you go find it.
//
// Storage only, still: NOTHING here contacts the URL. The single outbound path
// in the whole codebase is lib/termix.mjs's fetchTermixHosts(), reached only by
// an explicit user click on GET /api/termix/hosts. The deep link itself is pure
// string composition and never carries the credential.
//
//   baseUrl  the address the BROWSER will open, e.g. https://termix.example.com
//            (the shipped Docker image fronts every internal service with one
//            nginx on a single port — never point this at :30001 etc.)
//   token    a Termix API key ("tmx_" + 64 hex), created in Termix's own admin
//            UI. Used only by the optional host lookup, server-side.
//   hostId   which Termix host entry corresponds to THIS machine. bd-console
//            cannot infer it, so it is a plain stored value; without it the
//            deep link degrades to "open Termix" (see lib/termix.mjs).
export const TERMIX_KEYS = ['baseUrl', 'token', 'hostId'];

// Structural validation only — "is this a URL we could sanely join a path
// onto", not "is there a Termix over there". Returns the normalized origin +
// path with trailing slashes stripped, so a later deep-link can do
// `${baseUrl}/whatever` without doubling separators.
export function normalizeTermixBaseUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('Termix base URL must be a non-empty string');
  if (s.length > 2048) throw new Error('Termix base URL is too long (max 2048 characters)');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Termix base URL must be a full URL, e.g. https://termix.example.com');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Termix base URL must use http:// or https://');
  }
  if (u.search || u.hash) throw new Error('Termix base URL must not include a query string or fragment');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export function validateTermixToken(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('Termix API token must be a non-empty string');
  if (s.length > 4096) throw new Error('Termix API token is too long (max 4096 characters)');
  return s;
}

// Termix host ids are an INTEGER primary key in its own database (the app
// itself reads the query param back as a string and never parses it, so the
// strictness here is ours, not Termix's — it keeps a user-supplied value that
// ends up in a URL from being anything but a number).
export function validateTermixHostId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('Termix host id must be a non-empty value');
  if (!/^[0-9]+$/.test(s)) throw new Error('Termix host id must be a positive integer (Termix numbers its hosts)');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Termix host id must be a positive integer (Termix numbers its hosts)');
  return n;
}

// Same precedence shape as the settings above: env var > global config file >
// unset. The env tier matters more here than elsewhere — it's the only way to
// supply the credential without it sitting in plaintext in config.json.
export function resolveTermix(globalConfig = loadGlobalConfig()) {
  const stored = (globalConfig.termix && typeof globalConfig.termix === 'object' && !Array.isArray(globalConfig.termix))
    ? globalConfig.termix
    : {};

  const envUrl = process.env.BD_CONSOLE_TERMIX_URL;
  const envToken = process.env.BD_CONSOLE_TERMIX_TOKEN;
  const envHostId = process.env.BD_CONSOLE_TERMIX_HOST_ID;

  // hostId is coerced rather than trusted: it may arrive as a string from the
  // env tier or from a hand-edited config.json, and everything downstream
  // (the deep link, the settings display) wants one shape. A junk value
  // resolves to null — i.e. "not configured" — instead of poisoning a URL.
  let hostId = null;
  let hostIdSource = 'default';
  for (const [candidate, source] of [[envHostId, 'env'], [stored.hostId, 'config']]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    try { hostId = validateTermixHostId(candidate); hostIdSource = source; break; } catch { /* try the next tier */ }
  }

  return {
    baseUrl: envUrl || stored.baseUrl || null,
    token: envToken || stored.token || null,
    hostId,
    sources: {
      baseUrl: envUrl ? 'env' : (stored.baseUrl ? 'config' : 'default'),
      token: envToken ? 'env' : (stored.token ? 'config' : 'default'),
      hostId: hostIdSource
    }
  };
}

// config.json's `termix` is a nested object, so it can't ride saveGlobalConfig's
// flat top-level merge — this merges within the sub-object and drops the key
// entirely once nothing is left in it, so an unset Termix looks exactly like
// one that was never configured.
export function saveTermixConfig(patch = {}, unsetKeys = []) {
  const current = loadGlobalConfig().termix;
  const base = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
  const next = { ...base, ...patch };
  for (const key of unsetKeys) delete next[key];
  if (Object.keys(next).length === 0) return saveGlobalConfig({}, ['termix']);
  return saveGlobalConfig({ termix: next });
}

// First-run: no config.json (or legacy bd-console.json) has ever been
// written to the config dir, AND the caller didn't pin host/port explicitly
// via flags or env. Used to gate the interactive setup / "defaults applied"
// log line — see lib/settings.mjs `maybeFirstRunSetup`. Scoped to host/port
// only (not token/persist) because those are the two values whose *default*
// just changed (127.0.0.1 -> 0.0.0.0).
export function isFirstRun({ argsPort, argsHost } = {}) {
  if (argsPort || argsHost) return false;
  if (process.env.BD_CONSOLE_PORT || process.env.BD_CONSOLE_HOST) return false;
  return !existsSync(CONFIG_PATH) && !existsSync(LEGACY_CONFIG_PATH);
}

// Merge `patch` into the on-disk config.json (creating the config dir and
// file as needed), deleting any keys named in `unsetKeys`, and writing the
// result back out. Returns the new config object. This is the only writer
// of config.json — lib/settings.mjs (interactive setup, `settings set`/
// `unset`) is the only caller.
//
// Written tmp-file-then-rename (the pattern saveRegistry, /api/doc and the
// formula writer use): a plain writeFileSync truncates before it writes, so a
// crash mid-write leaves config.json unparseable — and loadConfigFile treats
// that as "no config", i.e. a silent revert to the DEFAULT bind and no token.
export function saveGlobalConfig(patch = {}, unsetKeys = []) {
  ensurePrivateConfigDir();
  const current = loadGlobalConfig();
  const next = { ...current, ...patch };
  for (const key of unsetKeys) delete next[key];
  const tmp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    ensurePrivateMode(tmp, 0o600, { strict: true });
    renameSync(tmp, CONFIG_PATH);
    ensurePrivateMode(CONFIG_PATH, 0o600, { strict: true });
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
  return next;
}
