// lib/registry.mjs — the hub project registry (~/.config/bd-console/registry.json).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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

export function removeProject(id) {
  const reg = loadRegistry();
  if (!reg.projects[id]) throw new Error(`project '${id}' not found`);
  delete reg.projects[id];
  saveRegistry(reg);
}

export function listProjects() {
  return loadRegistry().projects;
}
