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
export function saveGlobalConfig(patch = {}, unsetKeys = []) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const current = existsSync(CONFIG_PATH) ? loadConfigFile(CONFIG_PATH) : {};
  const next = { ...current, ...patch };
  for (const key of unsetKeys) delete next[key];
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
