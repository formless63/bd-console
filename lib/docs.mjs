// lib/docs.mjs — markdown doc discovery + safe path resolution for /api/docs
// and /api/doc.
import { readdir, stat } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'vendor',
  'coverage', 'target', '.beads', '.cache', 'db', '.turbo', 'tmp'
]);

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function rootMatches(rel, root) {
  return root === '.' || root === '' || rel === root || rel.startsWith(root + '/');
}

// docRoots comes from a project-controlled JSON file, so treat it as input,
// not as a trusted path. Roots are deliberately workspace-relative. Invalid
// entries are ignored instead of becoming an escape hatch for doc reads or
// writes; a configured (but empty after validation) list means "no docs", not
// "fall back to auto-discovery".
export function validateDocRoots(workspace, roots) {
  if (!Array.isArray(roots)) return null;
  let realWorkspace;
  try { realWorkspace = realpathSync(workspace); } catch { return []; }
  const valid = [];
  for (const raw of roots) {
    if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) continue;
    const value = raw.trim().replaceAll('\\', '/');
    if (value.startsWith('/') || value.split('/').includes('..')) continue;
    const full = resolve(workspace, value);
    if (!inside(resolve(workspace), full)) continue;
    try {
      const real = realpathSync(full);
      if (!inside(realWorkspace, real)) continue;
      valid.push(value.replace(/^\.\//, '').replace(/\/$/, '') || '.');
    } catch { /* a missing root is simply not discoverable */ }
  }
  return [...new Set(valid)];
}

export async function walkMd(ctx, dir, group, out, depth) {
  if (depth > 8) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.planning' && depth > 0) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walkMd(ctx, full, group, out, depth + 1);
    } else if (extname(e.name).toLowerCase() === '.md') {
      const rel = relative(ctx.workspace, full).split(sep).join('/');
      let mtime = 0;
      try { mtime = (await stat(full)).mtimeMs; } catch {}
      out.push({ path: rel, name: e.name, group, mtime });
    }
  }
}

export async function getDocs(ctx) {
  const out = [];
  if (ctx.configDocRoots) {
    for (const r of ctx.configDocRoots) {
      const full = join(ctx.workspace, r);
      if (existsSync(full) && (await stat(full)).isDirectory()) await walkMd(ctx, full, r, out, 0);
      else if (existsSync(full)) out.push({ path: r, name: basename(r), group: '(files)', mtime: 0 });
    }
  } else {
    // auto-discover: every top-level dir + the repo root's own *.md
    let entries = [];
    try { entries = await readdir(ctx.workspace, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.planning')) continue;
        await walkMd(ctx, join(ctx.workspace, e.name), e.name, out, 0);
      } else if (extname(e.name).toLowerCase() === '.md') {
        let mtime = 0;
        try { mtime = (await stat(join(ctx.workspace, e.name))).mtimeMs; } catch {}
        out.push({ path: e.name, name: e.name, group: '(top level)', mtime });
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function resolveDocPath(ctx, reqPath) {
  if (!reqPath || reqPath.includes('\0')) return null;
  const full = resolve(ctx.workspace, reqPath);
  const rel = relative(ctx.workspace, full);
  if (rel.startsWith('..') || resolve(ctx.workspace, rel) !== full) return null;
  if (extname(full).toLowerCase() !== '.md') return null;
  const top = rel.split(sep)[0];
  if (SKIP_DIRS.has(top)) return null;
  if (ctx.configDocRoots && !ctx.configDocRoots.some((r) => rootMatches(rel, r))) return null;

  // Lexical normalization does not stop a symlink such as docs/current.md ->
  // /etc/passwd. Confine existing targets by realpath, and confine the nearest
  // existing parent for a new document (the caller separately requires that
  // parent directory to exist). This check is synchronous because routes use
  // resolveDocPath as the authorization decision before reading/writing.
  let realWorkspace;
  try { realWorkspace = realpathSync(ctx.workspace); } catch { return null; }
  let realTarget;
  try { realTarget = realpathSync(full); } catch {
    let parent = full;
    while (parent !== dirname(parent)) {
      try { realTarget = realpathSync(parent); break; } catch { parent = dirname(parent); }
    }
  }
  if (!realTarget || !inside(realWorkspace, realTarget)) return null;
  if (ctx.configDocRoots) {
    const root = ctx.configDocRoots.find((r) => rootMatches(rel, r));
    if (!root) return null;
    let realRoot;
    try { realRoot = realpathSync(resolve(ctx.workspace, root)); } catch { return null; }
    if (!inside(realRoot, realTarget)) return null;
  }
  return full;
}
