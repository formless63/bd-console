#!/usr/bin/env node
/**
 * bd-console — a standalone, project-agnostic viewer + light editor for
 * beads (https://github.com/gastownhall/beads) issues and a project's docs.
 *
 * bd-console runs as a Global Hub: one server, many registered projects.
 *
 *   bd-console                 # run the hub server in the foreground
 *   bd-console start           # (re)start the hub as a supervised background process
 *   bd-console stop            # stop it, however it's currently supervised
 *   bd-console status          # pid + port-reachability + supervision report
 *   bd-console update          # self-upgrade in place, then restart if running
 *   bd-console add ~/code/proj # register a project with the hub
 *   bd-console add .           # register the project at (or above) cwd
 *   bd-console remove <id>     # unregister a project
 *   bd-console list            # list registered projects
 *
 * `start` semantics: it ALWAYS supersedes any existing deployment rather than
 * silently no-oping — it stops a previous plain daemon (pid file), stops an
 * active systemd unit, and (if something else is still answering on the
 * configured port and identifies itself as bd-console) takes over that port
 * too. It refuses to kill a process on the port that does NOT look like
 * bd-console. Once the old deployment is torn down it starts a fresh one and
 * polls /api/meta until the replacement actually answers, printing the
 * dashboard URL and how it's supervised on success, or the tail of the log
 * (systemd journal or the plain log file) and a nonzero exit on failure.
 *
 * `persist` controls how `start` supervises the new process: when true it
 * installs/refreshes a systemd --user unit (bd-console.service, enabled so it
 * survives logout/reboot via `loginctl enable-linger`) and routes
 * start/stop/status through systemctl; when false it uses a detached,
 * pid-file-tracked background process (the original behavior). Default: true
 * on Linux when `systemctl --user` is usable, false otherwise. Override with
 * the `persist` key in the global config file or the BD_CONSOLE_PERSIST=0/1
 * env var.
 *
 * `update` detects how bd-console is installed (a git clone -> `git pull
 * --ff-only`, refusing to touch a dirty working tree; otherwise an npm
 * global install -> `npm install -g <repo>`), runs it, and — if bd-console
 * was running before the update — restarts it via the same superseding
 * `start` path so the new code goes live immediately. `--dry-run` prints the
 * detected flavor and exact command(s) without running them.
 *
 * Global settings (host/port/token/persist) come from, in order of
 * precedence: CLI flags (--port, --host) > env vars (BD_CONSOLE_PORT,
 * BD_CONSOLE_HOST, BD_CONSOLE_TOKEN, BD_CONSOLE_PERSIST) > the global config
 * file (~/.config/bd-console/config.json, or BD_CONSOLE_CONFIG_DIR/config.json)
 * > defaults (127.0.0.1:4180, persist auto-detected).
 *
 * A per-project `bd-console.json` at a registered workspace's root may still
 * set `docRoots` to scope the docs tree for that project.
 *
 * Writes go through `bd` (execFile with an args array — no shell, no injection).
 * If a token is configured, it is required on write (POST) endpoints.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { REGISTRY_PATH, LOG_PATH, PID_PATH } from './lib/paths.mjs';
import { loadRegistry, addProject, removeProject, listProjects } from './lib/registry.mjs';
import { resolveSettings } from './lib/config.mjs';
import {
  daemonStart, daemonStop, daemonStatus, hostLabel,
  PortConflictError, tailStartupLog
} from './lib/daemon.mjs';
import { runUpdate, DirtyWorkTreeError } from './lib/update.mjs';
import { createRequestHandler } from './lib/routes.mjs';

// --- args -------------------------------------------------------------------
const COMMANDS = new Set(['start', 'stop', 'status', 'add', 'remove', 'list', 'update']);

function parseArgs(argv) {
  const out = { command: null, positional: [], port: null, host: null, forward: [], dryRun: false };
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
    } else if (a === '--dry-run') {
      out.dryRun = true;
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
const { port: PORT, host: HOST, token: TOKEN, persist: PERSIST } = resolveSettings({ argsPort: ARGS.port, argsHost: ARGS.host });
const SERVE_ENTRY = fileURLToPath(import.meta.url);

// --- daemon commands ----------------------------------------------------
async function cmdStart() {
  try {
    const result = await daemonStart({
      host: HOST, port: PORT, persist: PERSIST, forwardArgs: ARGS.forward, serveEntry: SERVE_ENTRY
    });
    for (const note of result.notes) console.log(`  ${note}`);
    console.log(result.supervised === 'systemd'
      ? 'Started bd-console (systemd-supervised).'
      : `Started bd-console in background (PID: ${result.pid}).`);
    console.log(`Dashboard: http://${hostLabel(HOST)}:${PORT}`);
    if (result.supervised === 'systemd') {
      console.log(`Supervision: systemd --user unit (${result.unitPath})`);
      console.log('Manage with: systemctl --user {status,stop,restart} bd-console.service');
    } else {
      console.log(`Supervision: plain background process (pid file: ${PID_PATH})`);
      console.log(`Logs:      ${LOG_PATH}`);
    }
    console.log(`Run 'bd-console status' to check it, 'bd-console stop' to stop.`);
    process.exit(0);
  } catch (err) {
    console.error(`bd-console: failed to start — ${err.message}`);
    if (!(err instanceof PortConflictError)) {
      const supervised = err.supervised || (PERSIST ? 'systemd' : 'plain');
      const tail = await tailStartupLog(supervised);
      if (tail) {
        console.error('');
        console.error('Last lines of log:');
        console.error(tail);
      }
    }
    process.exit(1);
  }
}

async function cmdStop() {
  const result = await daemonStop();
  if (!result.running) {
    console.log('bd-console is not running.');
  } else if (result.supervised === 'systemd') {
    if (result.stopped) console.log('Stopped bd-console (systemd unit bd-console.service).');
    else console.error(`Error stopping systemd unit: ${result.error}`);
  } else if (result.stopped) {
    console.log(`Stopped bd-console (PID: ${result.pid}).`);
  } else if (result.stale) {
    console.log(`Process ${result.pid} is not running.`);
  } else {
    console.error(`Error stopping process: ${result.error}`);
  }
  process.exit(0);
}

async function cmdStatus() {
  const result = await daemonStatus({ host: HOST, port: PORT });
  if (!result.running) {
    console.log(result.stalePid
      ? `bd-console is STOPPED (stale PID: ${result.stalePid}).`
      : 'bd-console is not running.');
    process.exit(0);
  }
  console.log('bd-console is RUNNING');
  console.log(`  supervision: ${result.supervised}`);
  console.log(`  pid:         ${result.pid ?? 'unknown'}`);
  console.log(`  port ${PORT}:    ${result.portReachable ? 'reachable (/api/meta responded)' : 'NOT reachable (process may be starting or wedged)'}`);
  console.log(`Dashboard: http://${hostLabel(HOST)}:${PORT}`);
  console.log(`Logs:      ${LOG_PATH}`);
  process.exit(0);
}

async function cmdUpdate() {
  const pkgRoot = dirname(SERVE_ENTRY);
  try {
    const before = await daemonStatus({ host: HOST, port: PORT });
    const result = await runUpdate({
      pkgRoot,
      dryRun: ARGS.dryRun,
      wasRunning: before.running,
      restart: () => daemonStart({ host: HOST, port: PORT, persist: PERSIST, forwardArgs: ARGS.forward, serveEntry: SERVE_ENTRY })
    });

    if (result.dryRun) {
      console.log('bd-console update --dry-run');
      console.log(`  detected flavor: ${result.flavor}`);
      console.log(`  current version: ${result.beforeVersion || 'unknown'}`);
      console.log('  would run:');
      for (const cmd of result.commands) console.log(`    ${cmd}`);
      process.exit(0);
    }

    console.log(`bd-console update (${result.flavor})`);
    console.log(`  before: ${result.beforeVersion || 'unknown'}`);
    console.log(`  after:  ${result.afterVersion || 'unknown'}`);
    if (result.unchanged) console.log('Already up to date.');
    if (before.running) {
      if (result.restarted) {
        console.log(`Restarted (${result.restarted.supervised}-supervised). Dashboard: http://${hostLabel(HOST)}:${PORT}`);
      } else {
        console.log("Update finished, but the restart step did not complete — run 'bd-console start' manually.");
      }
    } else {
      console.log("Run 'bd-console start' to launch the updated version.");
    }
    process.exit(0);
  } catch (err) {
    console.error(`bd-console: update failed — ${err.message}`);
    if (err instanceof DirtyWorkTreeError) {
      console.error('(working tree left untouched — commit or stash your changes, then retry)');
    }
    process.exit(1);
  }
}

if (ARGS.command === 'start') {
  await cmdStart();
} else if (ARGS.command === 'stop') {
  await cmdStop();
} else if (ARGS.command === 'status') {
  await cmdStatus();
} else if (ARGS.command === 'update') {
  await cmdUpdate();
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
