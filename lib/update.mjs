// lib/update.mjs — `bd-console update`: self-upgrade in place.
//
// Two install flavors, detected from the package root (the directory
// containing serve.mjs):
//   - "git-clone": the package root IS the root of a git work tree -> `git
//     pull --ff-only`. A dirty work tree is never touched (no stash/reset) —
//     we warn and abort with instructions instead. "Is the root of", not "is
//     inside": see detectFlavor for the repo this used to pull by mistake.
//   - "npm-global": anything else -> `npm install -g <repo>`.
import { run } from './exec.mjs';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const NPM_GLOBAL_PACKAGE = 'git+https://github.com/formless63/bd-console.git';

function runCmd(cmd, args, opts = {}) {
  return run(cmd, args, { encoding: 'utf8', ...opts });
}

export function readPackageVersion(pkgRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

// 'git-clone' only when pkgRoot IS the root of a git work tree — not merely
// somewhere inside one.
//
// This used to ask `rev-parse --is-inside-work-tree`, which answers "is any
// ANCESTOR a repo?". An npm-global install lands somewhere like
// ~/.nvm/versions/node/<v>/lib/node_modules/bd-console, and ~/.nvm is itself
// nvm's git clone — so bd-console detected "git-clone" and ran
// `git -C <our dir> pull --ff-only`, which git happily resolved to the
// enclosing NVM repository and fetched from github.com/nvm-sh/nvm. It was
// caught in the field only because that repo's branches had diverged; had it
// been clean and merely behind, --ff-only would have SUCCEEDED and this
// command would have silently upgraded somebody's node version manager
// (bd-console-83y).
//
// Comparing the toplevel to pkgRoot fails in the safe direction: a bd-console
// checkout nested inside a bigger repo reports 'npm-global' and reinstalls
// itself rather than running git against a tree it does not own. realpath on
// both sides because npm install paths routinely run through symlinks.
export async function detectFlavor(pkgRoot) {
  const r = await runCmd('git', ['-C', pkgRoot, 'rev-parse', '--show-toplevel']);
  if (!r.ok) return 'npm-global';
  const top = r.stdout.trim();
  if (!top) return 'npm-global';
  try {
    return realpathSync(top) === realpathSync(pkgRoot) ? 'git-clone' : 'npm-global';
  } catch {
    return 'npm-global';
  }
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
