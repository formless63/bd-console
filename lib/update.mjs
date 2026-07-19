// lib/update.mjs — `bd-console update`: self-upgrade in place.
//
// Two install flavors, detected from the package root (the directory
// containing serve.mjs):
//   - "git-clone": the package root is inside a git work tree -> `git pull
//     --ff-only`. A dirty work tree is never touched (no stash/reset) — we
//     warn and abort with instructions instead.
//   - "npm-global": anything else -> `npm install -g <repo>`.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NPM_GLOBAL_PACKAGE = 'git+https://github.com/formless63/bd-console.git';

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolveP) => {
    execFile(cmd, args, { encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      resolveP({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}

export function readPackageVersion(pkgRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

// True if `pkgRoot` is inside a git work tree.
export async function detectFlavor(pkgRoot) {
  const r = await runCmd('git', ['-C', pkgRoot, 'rev-parse', '--is-inside-work-tree']);
  return (r.ok && r.stdout.trim() === 'true') ? 'git-clone' : 'npm-global';
}

export async function isWorkTreeDirty(pkgRoot) {
  const r = await runCmd('git', ['-C', pkgRoot, 'status', '--porcelain']);
  return r.ok && r.stdout.trim().length > 0;
}

// The exact command(s) `update` will run for a given flavor — used both to
// execute the update and to print a --dry-run plan, so the two can never
// drift apart.
export function plannedCommands(flavor, pkgRoot) {
  if (flavor === 'git-clone') return [['git', ['-C', pkgRoot, 'pull', '--ff-only']]];
  return [['npm', ['install', '-g', NPM_GLOBAL_PACKAGE]]];
}

export function formatCommand([cmd, args]) {
  return [cmd, ...args].join(' ');
}

export class DirtyWorkTreeError extends Error {}
export class UpdateCommandError extends Error {}

// Runs (or, with dryRun, just plans) the update. Does not itself decide
// whether to restart the daemon afterward — pass `wasRunning` and a
// `restart` callback (the superseding daemonStart) and runUpdate will invoke
// it once the update completes successfully.
export async function runUpdate({ pkgRoot, dryRun = false, wasRunning = false, restart } = {}) {
  const flavor = await detectFlavor(pkgRoot);
  const beforeVersion = readPackageVersion(pkgRoot);
  const commands = plannedCommands(flavor, pkgRoot);

  if (dryRun) {
    return { dryRun: true, flavor, beforeVersion, commands: commands.map(formatCommand) };
  }

  if (flavor === 'git-clone' && await isWorkTreeDirty(pkgRoot)) {
    throw new DirtyWorkTreeError(
      `bd-console's working tree at ${pkgRoot} has uncommitted changes — refusing to update. `
      + `Commit or stash them yourself, then re-run 'bd-console update' (this command never `
      + `resets or stashes your changes for you).`
    );
  }

  for (const [cmd, args] of commands) {
    const r = await runCmd(cmd, args, { cwd: pkgRoot, timeout: 5 * 60 * 1000 });
    if (!r.ok) {
      throw new UpdateCommandError(`${formatCommand([cmd, args])} failed: ${(r.stderr || r.stdout || '').trim()}`);
    }
  }

  const afterVersion = readPackageVersion(pkgRoot);
  const unchanged = !!beforeVersion && !!afterVersion && beforeVersion === afterVersion;

  let restarted = null;
  if (wasRunning && typeof restart === 'function') {
    restarted = await restart();
  }

  return { dryRun: false, flavor, beforeVersion, afterVersion, unchanged, restarted };
}
