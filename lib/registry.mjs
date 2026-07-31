// lib/registry.mjs — the hub project registry (~/.config/bd-console/registry.json).
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { CONFIG_DIR, REGISTRY_PATH } from './paths.mjs';

export function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { projects: {} };
  try { return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')); }
  catch { return { projects: {} }; }
}

export function saveRegistry(data) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
}

export function getProjectId(workspacePath) {
  return basename(workspacePath).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

// Walk up from `start` looking for a `.beads/` directory.
export function findWorkspace(start) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.beads'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Register a project. `inputPath` is optional; falls back to walking up from
// cwd, then to cwd itself — mirrors `bd-console add [path]` semantics.
export function addProject(inputPath) {
  const ws = resolve(inputPath || findWorkspace(process.cwd()) || process.cwd());
  if (!existsSync(join(ws, '.beads'))) {
    throw new Error(`no .beads/ found at ${ws}`);
  }
  const id = getProjectId(ws);
  const reg = loadRegistry();
  let finalId = id;
  let i = 1;
  while (reg.projects[finalId] && reg.projects[finalId].path !== ws) {
    finalId = `${id}-${i++}`;
  }
  reg.projects[finalId] = { path: ws };
  saveRegistry(reg);
  return { id: finalId, path: ws };
}

// A filesystem path arriving over HTTP is a different animal from one typed at
// a shell prompt, so POST /api/register goes through here instead of calling
// addProject() directly. Two rules shape this function:
//
//   1. NOTHING is ever executed. No shell, no execFile, no `bd` — the path is
//      only ever stat()ed and stored, so an exotic path is inert by
//      construction rather than by quoting.
//   2. The "not a beads repo" answer is deliberately UNDIFFERENTIATED. A
//      caller who could tell "that folder doesn't exist" apart from "it exists
//      but has no .beads/" would have a filesystem-probe oracle: point it at
//      /home/<guess> and read the server's disk layout one guess at a time.
//      One message covers both, names only the path the caller already sent,
//      and still says exactly what to do about it. (`already registered` is
//      not held back — the registry is already readable ungated on
//      /api/projects, so that answer reveals nothing new.)
//
// Returns { ok: true, id, path } or { ok: false, status, error }.
const REGISTER_PATH_MAX = 4096;

export function registerProjectPath(inputPath) {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : '';
  if (!raw) return { ok: false, status: 400, error: 'path is required' };
  if (raw.includes('\0') || raw.length > REGISTER_PATH_MAX) {
    return { ok: false, status: 400, error: 'that is not a valid filesystem path' };
  }
  // `~` / `~/…` only (never `~user`): people type the path they know, and the
  // daemon runs as them. Everything after expansion still has to be absolute.
  const expanded = raw === '~' ? homedir()
    : raw.startsWith('~/') ? join(homedir(), raw.slice(2))
      : raw;
  if (!isAbsolute(expanded)) {
    return { ok: false, status: 400, error: 'path must be absolute — e.g. /home/you/code/my-project' };
  }
  const ws = resolve(expanded);

  // Checked before the .beads/ probe on purpose: a project whose .beads/ was
  // later deleted should still be told it's already registered.
  const reg = loadRegistry();
  const already = Object.entries(reg.projects || {}).find(([, p]) => p && p.path === ws);
  if (already) {
    return { ok: false, status: 409, error: `already registered as '${already[0]}'`, id: already[0] };
  }

  let isRepo = false;
  try { isRepo = statSync(join(ws, '.beads')).isDirectory(); } catch { isRepo = false; }
  if (!isRepo) {
    return {
      ok: false,
      status: 400,
      error: `no beads project at ${ws} — the folder must exist and contain a .beads/ directory (run 'bd init' there first)`
    };
  }

  try {
    const added = addProject(ws);
    return { ok: true, id: added.id, path: added.path };
  } catch {
    // addProject() re-checks .beads/ and writes the registry file; collapse any
    // failure (a racing delete, an unwritable config dir) to one message rather
    // than forwarding an errno string that describes the host.
    return { ok: false, status: 500, error: 'could not write the project registry' };
  }
}

export function removeProject(id) {
  const reg = loadRegistry();
  if (!reg.projects[id]) throw new Error(`project '${id}' not found`);
  delete reg.projects[id];
  saveRegistry(reg);
}

export function listProjects() {
  return loadRegistry().projects;
}
