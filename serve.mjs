#!/usr/bin/env node
/**
 * bd-console — a standalone, project-agnostic viewer + light editor for
 * beads (https://github.com/gastownhall/beads) issues and a project's docs.
 *
 * bd-console runs as a Global Hub: one server, many registered projects.
 *
 *   bd-console                 # run the hub server in the foreground
 *   bd-console start           # run the hub server as a background daemon
 *   bd-console add ~/code/proj # register a project with the hub
 *   bd-console add .           # register the project at (or above) cwd
 *   bd-console remove <id>     # unregister a project
 *   bd-console list            # list registered projects
 *   bd-console status / stop   # manage the background daemon
 *
 * Global settings (host/port/token) come from, in order of precedence:
 * CLI flags (--port, --host) > env vars (BD_CONSOLE_PORT, BD_CONSOLE_HOST,
 * BD_CONSOLE_TOKEN) > the global config file (~/.config/bd-console/config.json,
 * or BD_CONSOLE_CONFIG_DIR/config.json) > defaults (127.0.0.1:4180).
 *
 * A per-project `bd-console.json` at a registered workspace's root may still
 * set `docRoots` to scope the docs tree for that project.
 *
 * Writes go through `bd` (execFile with an args array — no shell, no injection).
 * If a token is configured, it is required on write (POST) endpoints.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { REGISTRY_PATH, LOG_PATH } from './lib/paths.mjs';
import { loadRegistry, addProject, removeProject, listProjects } from './lib/registry.mjs';
import { resolveSettings } from './lib/config.mjs';
import { daemonStart, daemonStop, daemonStatus, hostLabel } from './lib/daemon.mjs';
import { createRequestHandler } from './lib/routes.mjs';

// --- args -------------------------------------------------------------------
const COMMANDS = new Set(['start', 'stop', 'status', 'add', 'remove', 'list']);

function parseArgs(argv) {
  const out = { command: null, positional: [], port: null, host: null, forward: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!out.command && COMMANDS.has(a)) {
      out.command = a;
    } else if (a === '--port') {
      out.port = Number(argv[++i]);
      out.forward.push('--port', argv[i]);
    } else if (a === '--host') {
      out.host = argv[++i];
      out.forward.push('--host', argv[i]);
    } else if (
      (out.command === null || out.command === 'start' || out.command === 'stop' || out.command === 'status')
      && /^\d+$/.test(a)
    ) {
      out.port = Number(a);
      out.forward.push(a); // bare port, back-compat
    } else {
      out.positional.push(a);
    }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

const REGISTRY = loadRegistry();
if (Object.keys(REGISTRY.projects).length === 0 && ARGS.command !== 'add') {
  console.warn('bd-console Hub Mode: No projects registered yet. Use `bd-console add` to register projects.');
}

// --- add / remove / list (exit immediately) ---------------------------------
if (ARGS.command === 'add') {
  try {
    const { id, path } = addProject(ARGS.positional[0]);
    console.log(`Added project '${id}' -> ${path}`);
    process.exit(0);
  } catch (e) {
    console.error(`bd-console: ${e.message}`);
    process.exit(1);
  }
} else if (ARGS.command === 'remove') {
  const id = ARGS.positional[0];
  if (!id) { console.error('bd-console: specify project id to remove'); process.exit(1); }
  try {
    removeProject(id);
    console.log(`Removed project '${id}'`);
    process.exit(0);
  } catch (e) {
    console.error(`bd-console: ${e.message}`);
    process.exit(1);
  }
} else if (ARGS.command === 'list') {
  const projects = listProjects();
  console.log('Registered projects:');
  for (const [id, p] of Object.entries(projects)) {
    console.log(`  ${id}: ${p.path}`);
  }
  process.exit(0);
}

// --- effective settings -------------------------------------------------
const { port: PORT, host: HOST, token: TOKEN } = resolveSettings({ argsPort: ARGS.port, argsHost: ARGS.host });

// --- daemon commands ----------------------------------------------------
if (ARGS.command === 'start') {
  const result = daemonStart({ forwardArgs: ARGS.forward, serveEntry: fileURLToPath(import.meta.url) });
  if (result.alreadyRunning) {
    console.log(`bd-console is already running (PID: ${result.pid}).`);
  } else {
    console.log(`Started bd-console in background (PID: ${result.pid}).`);
  }
  console.log(`Dashboard: http://${hostLabel(HOST)}:${PORT}`);
  if (!result.alreadyRunning) {
    console.log(`Logs:      ${LOG_PATH}`);
    console.log(`Run 'bd-console status' to check it, 'bd-console stop' to stop.`);
  }
  process.exit(0);
} else if (ARGS.command === 'stop') {
  const result = daemonStop();
  if (!result.running) {
    console.log('bd-console is not running (no pid file).');
  } else if (result.stopped) {
    console.log(`Stopped bd-console (PID: ${result.pid}).`);
  } else if (result.stale) {
    console.log(`Process ${result.pid} is not running.`);
  } else {
    console.error(`Error stopping process: ${result.error}`);
  }
  process.exit(0);
} else if (ARGS.command === 'status') {
  const result = daemonStatus();
  if (!result.running && !result.stale) {
    console.log('bd-console is not running (no pid file).');
  } else if (result.running) {
    console.log(`bd-console is RUNNING (PID: ${result.pid}).`);
    console.log(`Dashboard: http://${hostLabel(HOST)}:${PORT}`);
    console.log(`Logs:      ${LOG_PATH}`);
  } else {
    console.log(`bd-console is STOPPED (stale PID: ${result.pid}).`);
  }
  process.exit(0);
}

// --- run the server in the foreground ---------------------------------------
function isLocalOnlyHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

const handler = createRequestHandler({ host: HOST, port: PORT, token: TOKEN });
const server = createServer(handler);

server.listen(PORT, HOST, () => {
  console.log(`bd-console [hub mode] → http://${hostLabel(HOST)}:${PORT}`);
  console.log(`  registry: ${REGISTRY_PATH}`);
  console.log(`  writes: ${TOKEN ? 'token-gated' : 'open'}`);
  if (!isLocalOnlyHost(HOST) && !TOKEN) {
    console.warn('  warning: writes are open on a non-localhost bind; set a token or bind to 127.0.0.1');
  }
});
