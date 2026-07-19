// lib/config.mjs — global config loading + effective settings resolution.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_PATH, LEGACY_CONFIG_PATH } from './paths.mjs';

const DEFAULT_PORT = 4180;
const DEFAULT_HOST = '127.0.0.1';

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

// Precedence: CLI flags > env vars > global config file > defaults.
export function resolveSettings({ argsPort, argsHost } = {}) {
  const globalConfig = loadGlobalConfig();
  const port = argsPort || Number(process.env.BD_CONSOLE_PORT) || globalConfig.port || DEFAULT_PORT;
  const host = argsHost || process.env.BD_CONSOLE_HOST || globalConfig.host || DEFAULT_HOST;
  const token = process.env.BD_CONSOLE_TOKEN || globalConfig.token || null;
  return { port, host, token, globalConfig };
}
