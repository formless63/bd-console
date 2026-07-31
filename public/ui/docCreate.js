// docCreate.js — the "New doc" entry point, shared by the classic docs view
// and Console 2.0's docs canvas (bd-console-09n). POST /api/doc could always
// create a file; neither view had a way to ask for one, so docs were an
// edit-only world you could never add to from the browser.
//
// Everything above createDoc() is pure derivation (no signals, no fetch) so
// scripts/smoke.mjs can assert it in Node, the same contract relationships.js
// and formulas.js keep — which is why this file has NO top-level imports:
// api.js pulls in store.js, which imports '@preact/signals' as a bare
// specifier that only the browser's import map (public/index.html) can
// resolve. A static `import ... from './api.js'` up here would make Node
// fail to load this module at all, for every export, the instant
// scripts/smoke.mjs imported any of the pure functions below — so createDoc()
// reaches for api.js with a dynamic import instead, entered only when a
// write actually happens.
//
// IMPORTANT: none of this is a security boundary. The server re-validates
// every path through resolveDocPath() (traversal, absolute paths, .md-only,
// docRoots containment) and refuses to overwrite when `create: true`. What
// lives here is the part that makes the dialog pleasant — say "no" before the
// round-trip, not instead of it.

// A leading dot would produce a hidden file the docs walker then skips (see
// SKIP_DIRS / the dotfile rule in lib/docs.mjs) — i.e. a doc you create and
// can never see again. Slashes are rejected because the folder comes from the
// picker, which is what keeps the happy path free of traversal entirely.
const DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export function newDocName(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  return /\.md$/i.test(n) ? n : n + '.md';
}

export function newDocPath(folder, name) {
  const f = String(folder || '').replace(/^\/+|\/+$/g, '');
  const n = newDocName(name);
  if (!n) return '';
  return f ? `${f}/${n}` : n;
}

// Folders a new doc could legitimately land in, derived from the docs that
// already exist (every ancestor folder of every known doc) plus, when the
// project configures docRoots, the roots themselves. Two rules:
//   - offering only EXISTING folders is what satisfies the server's "parent
//     directory does not exist" precondition without the UI having to create
//     directories, and
//   - when docRoots is configured, folders outside it are dropped, because
//     resolveDocPath() would reject a write there anyway.
// `docRoots` is null/undefined in auto-discovery mode, where the project root
// itself ('') is always a valid target.
export function docFolders(docs = [], docRoots = null) {
  const configured = Array.isArray(docRoots) && docRoots.length > 0;
  const roots = configured ? docRoots.map((r) => String(r).replace(/^\/+|\/+$/g, '')) : [];
  const allowed = (f) => !configured || roots.some((r) => f === r || f.startsWith(r + '/'));
  const set = new Set();
  if (configured) {
    // A docRoot can name a single file rather than a directory — that's not a
    // folder anything can be created in.
    for (const r of roots) if (r && !/\.md$/i.test(r)) set.add(r);
  } else {
    set.add('');
  }
  for (const d of docs) {
    const parts = String((d && d.path) || '').split('/');
    parts.pop();
    for (let i = 1; i <= parts.length; i++) {
      const f = parts.slice(0, i).join('/');
      if (allowed(f)) set.add(f);
    }
  }
  return [...set].sort();
}

// Human-readable reason this name can't be used, or null when it can.
export function newDocProblem(folder, name, docs = []) {
  const n = String(name || '').trim();
  if (!n) return 'Give the document a name.';
  if (n.includes('/') || n.includes('\\')) return 'Pick the folder above — a name cannot contain a slash.';
  const stem = n.replace(/\.md$/i, '');
  if (!stem) return 'Give the document a name.';
  if (!DOC_NAME_RE.test(stem)) return 'Use letters, numbers, spaces, dots, dashes or underscores.';
  if (stem.includes('..')) return 'A name cannot contain "..".';
  const path = newDocPath(folder, n);
  if (docs.some((d) => d && d.path === path)) return `${path} already exists — open it instead.`;
  return null;
}

// Starter body, so a brand-new doc opens as something rather than a blank
// pane. The heading is the filename humanized, which is what the author was
// going to type first anyway.
export function newDocTemplate(name) {
  const stem = String(name || '').trim().replace(/\.md$/i, '').replace(/[_-]+/g, ' ').trim();
  const title = stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : 'Untitled';
  return `# ${title}\n\n`;
}

// The write itself. `create: true` is what makes the server 409 instead of
// overwriting an existing file — see the /api/doc handler in lib/routes.mjs.
// The dynamic import (see header) is only ever reached from a real submit,
// never from scripts/smoke.mjs, which exercises this same route directly
// over HTTP instead of through this wrapper.
export async function createDoc(path, content) {
  const { apiPost } = await import('./api.js');
  return apiPost('/api/doc', { path, content, create: true });
}
