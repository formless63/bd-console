#!/usr/bin/env node
// bd-console-9vc: `npm run check` only ran `node --check`, which is pure
// syntax — it says nothing about whether a named import actually resolves
// to something the target module exports. The frontend is native ES
// modules loaded by the browser via public/index.html's import map (no
// bundler), so a deletion that removes an export another file still
// imports by name passes `node --check`, passes smoke, and only blows up
// in the browser at module-evaluation time. This script closes that gap
// with a zero-dependency static check: for every JS/MJS file we maintain,
// parse its import/export statements well enough to verify every named
// (and default) import resolves to a real export, following re-export
// chains, and that every bare specifier is either declared in the
// frontend import map or a real Node built-in on the backend.
//
// This is deliberately NOT a JS parser. It is a single-pass tokenizer
// good enough to (a) tell code apart from comments/strings/templates/regex
// literals so those don't get misread as import/export statements, and
// (b) extract the handful of declaration shapes this codebase actually
// uses. See scanCode() for the tokenizer and parseModule() for the
// declaration grammar it feeds.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_ROOT = join(ROOT, 'public');
const VENDOR_ROOT = join(PUBLIC_ROOT, 'vendor') + sep;

// ---------------------------------------------------------------------
// 1. Tokenizer: turn source into a same-length "code mask" where every
//    character that is part of a comment, string, template literal, or
//    regex literal is blanked to a space (newlines are always preserved
//    so line numbers stay correct). Real code characters pass through
//    unchanged. This is what lets the statement scanner below treat
//    `\bimport\b` / `\bexport\b` occurring in a comment or string as
//    inert text instead of a declaration.
//
//    Regex-vs-division is resolved with the standard heuristic: a bare
//    `/` starts a regex literal unless the previous significant token was
//    a value (identifier, number, `)`, `]`, or a closed string/template/
//    regex) — mirrors what real lexers do, and matters here because this
//    codebase has at least one literal regex containing a backtick
//    (public/ui/markdown.js), which would otherwise desync template
//    tracking for the rest of the file.
const KEYWORDS_ALLOW_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'yield', 'case', 'do', 'else',
]);

function isIdentStart(c) { return /[A-Za-z_$]/.test(c); }
function isIdentPart(c) { return /[A-Za-z0-9_$]/.test(c); }
function isDigit(c) { return c >= '0' && c <= '9'; }

function scanCode(src) {
  const n = src.length;
  const out = new Array(n);
  const stack = []; // frames: {type:'string',q}|{type:'template'}|{type:'template-expr',depth}|{type:'line-comment'}|{type:'block-comment'}|{type:'regex',inClass}
  let i = 0;
  let prevAllowsRegex = true; // true == a following bare `/` starts a regex

  const top = () => stack[stack.length - 1];

  while (i < n) {
    const frame = top();
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';

    if (!frame || frame.type === 'template-expr') {
      // "code" mode — either true top level or inside a `${ }` expression.
      if (frame && c === '{') { frame.depth++; out[i] = c; i++; continue; }
      if (frame && c === '}') {
        frame.depth--;
        out[i] = c; i++;
        if (frame.depth === 0) stack.pop(); // back to the enclosing template
        prevAllowsRegex = false;
        continue;
      }
      if (c === '/' && c2 === '/') { stack.push({ type: 'line-comment' }); out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && c2 === '*') { stack.push({ type: 'block-comment' }); out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === "'" || c === '"') { stack.push({ type: 'string', q: c }); out[i] = ' '; i++; continue; }
      if (c === '`') { stack.push({ type: 'template' }); out[i] = ' '; i++; continue; }
      if (c === '/' && prevAllowsRegex) { stack.push({ type: 'regex', inClass: false }); out[i] = ' '; i++; continue; }
      if (isIdentStart(c)) {
        let j = i + 1;
        while (j < n && isIdentPart(src[j])) j++;
        const word = src.slice(i, j);
        for (let k = i; k < j; k++) out[k] = src[k];
        prevAllowsRegex = KEYWORDS_ALLOW_REGEX.has(word);
        i = j;
        continue;
      }
      if (isDigit(c)) {
        let j = i + 1;
        while (j < n && /[0-9a-fA-Fx_.pP+\-]/.test(src[j]) && isIdentPart(src[j]) || (j < n && src[j] === '.')) j++;
        for (let k = i; k < j; k++) out[k] = src[k];
        prevAllowsRegex = false;
        i = j;
        continue;
      }
      out[i] = c;
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        // Whitespace is not a token — it must not disturb whichever real
        // token last set prevAllowsRegex, or `a / b` (division) gets
        // misread as the start of a regex literal the moment a space
        // separates the operator from its operand.
      } else if (c === ')' || c === ']') {
        prevAllowsRegex = false;
      } else {
        prevAllowsRegex = true; // operators/`(`/`{`/`,`/`;`/`}` etc — conservative default
      }
      i++;
      continue;
    }

    if (frame.type === 'line-comment') {
      if (c === '\n') { stack.pop(); continue; } // let code mode consume the newline itself
      out[i] = ' '; i++; continue;
    }

    if (frame.type === 'block-comment') {
      if (c === '*' && c2 === '/') { stack.pop(); out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      out[i] = c === '\n' ? '\n' : ' '; i++; continue;
    }

    if (frame.type === 'string') {
      if (c === '\\') { out[i] = ' '; out[i + 1] = c2 === '\n' ? '\n' : ' '; i += 2; continue; }
      if (c === frame.q) { stack.pop(); out[i] = ' '; i++; prevAllowsRegex = false; continue; }
      if (c === '\n') { stack.pop(); out[i] = '\n'; i++; continue; } // unterminated — bail defensively
      out[i] = ' '; i++; continue;
    }

    if (frame.type === 'template') {
      if (c === '\\') { out[i] = ' '; out[i + 1] = c2 === '\n' ? '\n' : ' '; i += 2; continue; }
      if (c === '`') { stack.pop(); out[i] = ' '; i++; prevAllowsRegex = false; continue; }
      if (c === '$' && c2 === '{') { stack.push({ type: 'template-expr', depth: 1 }); out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      out[i] = c === '\n' ? '\n' : ' '; i++; continue;
    }

    if (frame.type === 'regex') {
      if (c === '\\') { out[i] = ' '; out[i + 1] = c2 === '\n' ? '\n' : ' '; i += 2; continue; }
      if (c === '\n') { stack.pop(); continue; } // unterminated — bail defensively, let code mode see the newline
      if (c === '[') { frame.inClass = true; out[i] = ' '; i++; continue; }
      if (c === ']') { frame.inClass = false; out[i] = ' '; i++; continue; }
      if (c === '/' && !frame.inClass) {
        stack.pop(); out[i] = ' '; i++;
        while (i < n && /[a-zA-Z]/.test(src[i])) { out[i] = src[i]; i++; } // flags
        prevAllowsRegex = false;
        continue;
      }
      out[i] = ' '; i++; continue;
    }

    // Unreachable, but never loop forever on an unknown frame type.
    out[i] = c; i++;
  }

  return out.join('');
}

// ---------------------------------------------------------------------
// 2. Statement extraction: given a code mask, find genuine top-level
//    import/export declarations (not `import()`, not `import.meta`, not
//    `obj.export`, not text buried in a comment/string) and slice out the
//    exact original source text of each one.

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src[i] === '\n') line++;
  return line;
}

function findStatements(src) {
  const mask = scanCode(src);
  const stmts = [];

  const importRe = /(?<![.\w$])import\b/g;
  let m;
  while ((m = importRe.exec(mask))) {
    const start = m.index;
    const after = mask.slice(start + 6).match(/^\s*(\S)/);
    const next = after ? after[1] : '';
    if (next === '(' || next === '.') continue; // dynamic import(...) / import.meta
    const semi = mask.indexOf(';', start);
    const end = semi === -1 ? src.length : semi + 1;
    stmts.push({ type: 'import', start, end, text: src.slice(start, end), line: lineOf(src, start) });
  }

  const exportRe = /(?<![.\w$])export\b/g;
  while ((m = exportRe.exec(mask))) {
    const start = m.index;
    const after = mask.slice(start + 6).match(/^\s*(\{|\*|default\b|function\b|async\b|class\b|const\b|let\b|var\b)/);
    if (!after) continue; // e.g. `data.export` handled by lookbehind, but also `{ export: x }` / `{ export }`
    const kind = after[1];
    let end;
    if (kind === 'function' || kind === 'async' || kind === 'class') {
      // Body-delimited forms: we only need the name, which is on the
      // declaration line — grab a short bounded window.
      end = Math.min(src.length, start + 400);
    } else if (kind === 'default') {
      end = Math.min(src.length, start + 400);
    } else {
      const semi = mask.indexOf(';', start);
      end = semi === -1 ? Math.min(src.length, start + 2000) : semi + 1;
    }
    stmts.push({ type: 'export', start, end, text: src.slice(start, end), line: lineOf(src, start) });
  }

  stmts.sort((a, b) => a.start - b.start);
  return stmts;
}

// ---------------------------------------------------------------------
// 3. Declaration grammar: turn each statement's text into structured
//    import items / export names. Covers every shape actually seen in
//    this codebase plus the ones the issue calls out by name: export
//    function/const/let/class, export async function, export { a, b as
//    c }, export default, export * from, export { x } from, default
//    imports, namespace imports, mixed default+named, and multi-line
//    import blocks (the statement text already spans newlines because it
//    was sliced up to the real `;`).

function splitTopLevel(str) {
  // Split on commas that aren't nested inside (), [], {}.
  const parts = [];
  let depth = 0, cur = '';
  for (const c of str) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function parseImportStatement(text) {
  const body = text.replace(/^import\b/, '').replace(/;\s*$/, '').trim();
  if (!body) return null;
  if (body[0] === "'" || body[0] === '"') {
    const spec = body.slice(1, -1);
    return { specifier: spec, default: null, namespace: null, named: [] };
  }
  const m = body.match(/^([\s\S]*?)\bfrom\s*(['"])([\s\S]*?)\2\s*$/);
  if (!m) return null;
  const bindings = m[1].trim();
  const specifier = m[3];
  let def = null, ns = null; const named = [];

  const nsOnly = bindings.match(/^\*\s*as\s+(\w+)$/);
  const defNs = bindings.match(/^(\w+)\s*,\s*\*\s*as\s+(\w+)$/);
  const defNamed = bindings.match(/^(\w+)\s*,\s*\{([\s\S]*)\}$/);
  const namedOnly = bindings.match(/^\{([\s\S]*)\}$/);
  const defOnly = bindings.match(/^(\w+)$/);

  if (nsOnly) { ns = nsOnly[1]; }
  else if (defNs) { def = defNs[1]; ns = defNs[2]; }
  else if (defNamed) {
    def = defNamed[1];
    for (const item of splitTopLevel(defNamed[2])) {
      const im = item.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (im) named.push({ imported: im[1], local: im[2] || im[1] });
    }
  } else if (namedOnly) {
    for (const item of splitTopLevel(namedOnly[1])) {
      const im = item.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (im) named.push({ imported: im[1], local: im[2] || im[1] });
    }
  } else if (defOnly) { def = defOnly[1]; }
  else return null;

  return { specifier, default: def, namespace: ns, named };
}

// Result shape per file: { locals:Set<string>, reExportNamed:Map<name,{specifier,imported}>, reExportAll: string[] }
function parseExportStatement(text, into) {
  const rest = text.replace(/^export\b/, '');

  let m;
  if ((m = rest.match(/^\s*default\b/))) { into.locals.add('default'); return; }

  if ((m = rest.match(/^\s*(?:async\s+)?function\s*\*?\s+(\w+)/))) { into.locals.add(m[1]); return; }
  if ((m = rest.match(/^\s*class\s+(\w+)/))) { into.locals.add(m[1]); return; }

  if ((m = rest.match(/^\s*\*\s*as\s+(\w+)\s+from\s*(['"])([\s\S]*?)\2/))) {
    into.reExportNamed.set(m[1], { specifier: m[3], imported: '*' });
    return;
  }
  if ((m = rest.match(/^\s*\*\s*from\s*(['"])([\s\S]*?)\1/))) {
    into.reExportAll.push(m[2]);
    return;
  }

  if ((m = rest.match(/^\s*\{([\s\S]*?)\}\s*(?:from\s*(['"])([\s\S]*?)\2)?/))) {
    const items = splitTopLevel(m[1]);
    const fromSpec = m[3] || null;
    for (const item of items) {
      const im = item.match(/^(\w+|default)(?:\s+as\s+(\w+))?$/);
      if (!im) continue;
      const exportedName = im[2] || im[1];
      if (fromSpec) into.reExportNamed.set(exportedName, { specifier: fromSpec, imported: im[1] });
      else into.locals.add(exportedName); // re-exports a name already bound locally in this file
    }
    return;
  }

  if ((m = rest.match(/^\s*(?:const|let|var)\s+([\s\S]*)/))) {
    // Declarator list up to the statement's real terminating `;` — the
    // caller already bounded `text` there. Split on top-level commas,
    // take the binding target (before `=`), and pull identifiers out of
    // it (handles plain names and simple {..}/[..] destructuring).
    const declBody = m[1].replace(/;\s*$/, '');
    for (const decl of splitTopLevel(declBody)) {
      const target = decl.split('=')[0].trim();
      if (!target) continue;
      if (target[0] === '{' || target[0] === '[') {
        const names = target.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
        for (const n of names) if (n !== 'default') into.locals.add(n);
      } else {
        const nm = target.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
        if (nm) into.locals.add(nm[0]);
      }
    }
  }
}

const moduleCache = new Map();

function parseModule(absPath) {
  if (moduleCache.has(absPath)) return moduleCache.get(absPath);
  let src;
  try { src = readFileSync(absPath, 'utf8'); } catch { moduleCache.set(absPath, null); return null; }
  const info = { locals: new Set(), reExportNamed: new Map(), reExportAll: [] };
  for (const stmt of findStatements(src)) {
    if (stmt.type === 'export') parseExportStatement(stmt.text, info);
  }
  moduleCache.set(absPath, info);
  return info;
}

function resolveExportExists(absPath, name, visited = new Set()) {
  if (visited.has(absPath)) return false;
  visited.add(absPath);
  const info = parseModule(absPath);
  if (!info) return false;
  if (info.locals.has(name)) return true;
  const re = info.reExportNamed.get(name);
  if (re) {
    if (re.imported === '*') return true; // namespace re-export always "exists"
    const target = resolveSpecifierPath(absPath, re.specifier);
    if (target && existsSync(target)) return resolveExportExists(target, re.imported, visited);
    return false;
  }
  for (const spec of info.reExportAll) {
    const target = resolveSpecifierPath(absPath, spec);
    if (target && existsSync(target) && resolveExportExists(target, name, visited)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// 4. File discovery + specifier resolution.

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'vendor') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function isBareSpecifier(spec) {
  return !(spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/'));
}

function resolveSpecifierPath(fromFile, spec) {
  if (spec.startsWith('.')) return resolve(dirname(fromFile), spec);
  if (spec.startsWith('/')) return join(PUBLIC_ROOT, spec.slice(1));
  return null; // bare — resolved separately against the import map / node builtins
}

function isUnderVendor(absPath) {
  return absPath.startsWith(VENDOR_ROOT);
}

function loadImportMapKeys() {
  const htmlPath = join(PUBLIC_ROOT, 'index.html');
  let html;
  try { html = readFileSync(htmlPath, 'utf8'); } catch { return new Set(); }
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) return new Set();
  try { return new Set(Object.keys(JSON.parse(m[1]).imports || {})); }
  catch { return new Set(); }
}

// ---------------------------------------------------------------------
// 5. Drive the check.

const entryFiles = [
  ...walk(PUBLIC_ROOT),
  ...readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => join(ROOT, 'lib', f)),
  ...readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => join(ROOT, 'scripts', f)),
  join(ROOT, 'serve.mjs'),
];

const importMapKeys = loadImportMapKeys();
const problems = [];
let namedImportCount = 0;
let bareSpecifierCount = 0;

for (const file of entryFiles) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  const underPublic = file.startsWith(PUBLIC_ROOT + sep);

  for (const stmt of findStatements(src)) {
    if (stmt.type !== 'import') continue;
    const parsed = parseImportStatement(stmt.text);
    if (!parsed) {
      problems.push({ file: rel, line: stmt.line, message: `could not parse import statement: ${stmt.text.split('\n')[0].trim()}` });
      continue;
    }
    const { specifier } = parsed;

    if (isBareSpecifier(specifier)) {
      bareSpecifierCount++;
      if (underPublic) {
        const ok = importMapKeys.has(specifier)
          || [...importMapKeys].some((k) => k.endsWith('/') && specifier.startsWith(k));
        if (!ok) {
          problems.push({ file: rel, line: stmt.line, message: `bare specifier '${specifier}' is not declared in public/index.html's import map` });
        }
      } else if (!isBuiltin(specifier)) {
        problems.push({ file: rel, line: stmt.line, message: `bare specifier '${specifier}' is not a Node built-in (project has zero npm dependencies)` });
      }
      continue;
    }

    const target = resolveSpecifierPath(file, specifier);
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      problems.push({ file: rel, line: stmt.line, message: `cannot resolve '${specifier}' -> ${target ? relative(ROOT, target) : '?'} (file not found)` });
      continue;
    }
    if (isUnderVendor(target)) continue; // vendored — trusted boundary, existence check above is enough

    if (parsed.default !== null) {
      namedImportCount++;
      if (!resolveExportExists(target, 'default')) {
        problems.push({ file: rel, line: stmt.line, message: `imports default from '${specifier}' but ${relative(ROOT, target)} has no default export` });
      }
    }
    for (const { imported, local } of parsed.named) {
      namedImportCount++;
      if (!resolveExportExists(target, imported)) {
        const as = local !== imported ? ` (as ${local})` : '';
        problems.push({ file: rel, line: stmt.line, message: `imports '${imported}'${as} from '${specifier}' but ${relative(ROOT, target)} does not export it` });
      }
    }
    // namespace imports (`* as ns`) need nothing beyond the file existing.
  }
}

if (problems.length) {
  problems.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.message}`);
  console.error(`\ncheck-imports failed: ${problems.length} problem(s) across ${entryFiles.length} files`);
  process.exitCode = 1;
} else {
  console.log(`check-imports ok: ${entryFiles.length} files, ${namedImportCount} named/default imports, ${bareSpecifierCount} bare specifiers`);
}
