// lib/paths.mjs — resolves bd-console's on-disk config locations.
//
// Everything server-global (registry, config, pid, logs) lives under a single
// config directory. Override it with BD_CONSOLE_CONFIG_DIR (mainly useful for
// tests, so they don't touch the real ~/.config/bd-console).
import { join } from 'node:path';

export const CONFIG_DIR = process.env.BD_CONSOLE_CONFIG_DIR
  || join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'bd-console');

export const REGISTRY_PATH = join(CONFIG_DIR, 'registry.json');

// Global config file. Historically this was `bd-console.json` inside the
// registry dir; new installs should use `config.json`. loadGlobalConfig()
// (lib/config.mjs) prefers CONFIG_PATH and falls back to LEGACY_CONFIG_PATH.
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const LEGACY_CONFIG_PATH = join(CONFIG_DIR, 'bd-console.json');

export const PID_PATH = join(CONFIG_DIR, 'console.pid');
export const LOG_PATH = join(CONFIG_DIR, 'console.log');
