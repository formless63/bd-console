// lib/exec.mjs — the ONE execFile-promisification used by every module that
// shells out (bd-console-974.8). Before this file existed, lib/bd.mjs,
// lib/tmux.mjs, lib/git.mjs, lib/update.mjs, lib/systemd.mjs and
// lib/bdversion.mjs each hand-rolled the same `new Promise((resolveP) =>
// execFile(cmd, args, opts, (err, stdout, stderr) => resolveP({...})))`
// wrapper, six copies that had already drifted in small ways (some default
// `stdout`/`stderr` to `''`, some pass through `code`, one trims stdout).
//
// This is a MECHANICAL consolidation, not a behavior change: run() itself
// makes no policy decisions (no cwd default, no ENOENT interpretation, no
// trimming) — every one of those stayed exactly where it was, in the six
// call sites, each of which now calls run() and then does whatever
// caller-specific post-processing it always did. See the call sites for the
// per-caller shape (lib/bd.mjs's bd() merges an ENOENT explanation into
// stderr and keeps `code`; lib/git.mjs's git() trims stdout and drops
// `code`; lib/bdversion.mjs's runBdVersion() drops `code`; lib/tmux.mjs,
// lib/update.mjs and lib/systemd.mjs return run()'s shape unchanged).
//
// Never used with a shell string — every call site passes `cmd` and an args
// ARRAY, exactly as before.
import { execFile } from 'node:child_process';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptions} [opts]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: string|number|undefined}>}
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolveP) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      resolveP({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}
