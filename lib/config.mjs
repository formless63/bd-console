// lib/config.mjs — global config loading + effective settings resolution.
//
// This is the single source of truth for how host/port/token/persist are
// resolved (precedence: CLI flags > env vars > global config file >
// defaults) and for detecting "first run" (see isFirstRun below). The
// interactive setup / `bd-console settings` UX lives in lib/settings.mjs and
// calls back into the helpers here to read and persist the config file.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_PATH, LEGACY_CONFIG_PATH } from './paths.mjs';
import { systemctlUserAvailable } from './systemd.mjs';

export const DEFAULT_PORT = 4180;
// Fallback bind changed from 127.0.0.1 -> 0.0.0.0 (see CHANGELOG / issue
// discussion). First-run (see isFirstRun) exists specifically so this new,
// more permissive default is never applied silently without at least a
// log line (non-TTY) or an interactive walkthrough (TTY).
export const DEFAULT_HOST = '0.0.0.0';

export function loadConfigFile(path) {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.warn(`bd-console: ignoring invalid config file at ${path}`);
    return {};
  }
}

// Global config lives at CONFIG_PATH (config.json). Older installs wrote
// `bd-console.json` inside the config dir instead — fall back to that if the
// new file isn't there yet.
export function loadGlobalConfig() {
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
  if (typeof globalConfig.persist === 'boolean') return { value: globalConfig.persist, source: 'config' };
  return { value: systemctlUserAvailable(), source: 'default' };
}

// Precedence: CLI flags > env vars > global config file > defaults.
// Also reports, per key, which tier actually supplied the effective value
// (`sources`) — used by `bd-console settings list` / the interactive
// walkthrough so users can see *why* a value is what it is.
export function resolveSettings({ argsPort, argsHost } = {}) {
  const globalConfig = loadGlobalConfig();

  const portSource = argsPort ? 'flag' : (process.env.BD_CONSOLE_PORT ? 'env' : (globalConfig.port ? 'config' : 'default'));
  const port = argsPort || Number(process.env.BD_CONSOLE_PORT) || globalConfig.port || DEFAULT_PORT;

  const hostSource = argsHost ? 'flag' : (process.env.BD_CONSOLE_HOST ? 'env' : (globalConfig.host ? 'config' : 'default'));
  const host = argsHost || process.env.BD_CONSOLE_HOST || globalConfig.host || DEFAULT_HOST;

  const tokenSource = process.env.BD_CONSOLE_TOKEN ? 'env' : (globalConfig.token ? 'config' : 'default');
  const token = process.env.BD_CONSOLE_TOKEN || globalConfig.token || null;

  const { value: persist, source: persistSource } = resolvePersistWithSource(globalConfig);

  return {
    port, host, token, persist, globalConfig,
    sources: { port: portSource, host: hostSource, token: tokenSource, persist: persistSource }
  };
}

// --- Termix linkage (scaffolding) -----------------------------------------
// Termix (https://github.com/LukeGus/Termix) is a self-hosted web SSH /
// terminal manager. The eventual goal is that a tmux session row in the hub
// links straight into a Termix terminal instead of making you go find it.
//
// This block stores ONLY the address and credential so that later feature has
// something to read. Nothing in bd-console contacts the URL: it is never
// fetched, probed, health-checked or validated against a live server, and the
// credential is never sent anywhere. Treat any change here that adds an
// outbound request as a new decision, not an implementation detail.
export const TERMIX_KEYS = ['baseUrl', 'token'];

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

// Same precedence shape as the settings above: env var > global config file >
// unset. The env tier matters more here than elsewhere — it's the only way to
// supply the credential without it sitting in plaintext in config.json.
export function resolveTermix(globalConfig = loadGlobalConfig()) {
  const stored = (globalConfig.termix && typeof globalConfig.termix === 'object' && !Array.isArray(globalConfig.termix))
    ? globalConfig.termix
    : {};

  const envUrl = process.env.BD_CONSOLE_TERMIX_URL;
  const envToken = process.env.BD_CONSOLE_TERMIX_TOKEN;

  return {
    baseUrl: envUrl || stored.baseUrl || null,
    token: envToken || stored.token || null,
    sources: {
      baseUrl: envUrl ? 'env' : (stored.baseUrl ? 'config' : 'default'),
      token: envToken ? 'env' : (stored.token ? 'config' : 'default')
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
export function saveGlobalConfig(patch = {}, unsetKeys = []) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const current = existsSync(CONFIG_PATH) ? loadConfigFile(CONFIG_PATH) : {};
  const next = { ...current, ...patch };
  for (const key of unsetKeys) delete next[key];
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
