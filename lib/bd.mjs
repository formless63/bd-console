// lib/bd.mjs — the `bd` CLI wrapper (no shell; args array) + issue export
// helpers + the issue-edit dispatcher.
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.\d+)*$/; // bead id: prefix-xxx or prefix-xxx.N
// A label: same split-character-class discipline as ASSIGNEE_RE below, and for
// the same reason. '-' is legal INSIDE a label (`needs-design`, `doc:a-b.md`)
// but never as the first character, so `--json` / `-p` are rejected instead of
// reaching `bd label add <id> --json` as a flag-shaped value.
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
// An assignee: a handle, a username or an email — no whitespace, no shell
// metacharacters, no flag-shaped values. THE single definition; lib/routes.mjs
// imports it for the create/pour paths so the rule can't drift between "who
// gets it at creation" and "who gets it afterwards".
//
// This is hygiene, not an injection fix: every call site is execFile with an
// args array, and `bd update <id> --assignee --json` is accepted by bd's flag
// parser as the LITERAL value "--json" (verified on v1.1.0) rather than as a
// flag. The regex exists so a fat-fingered value 400s here instead of quietly
// becoming an assignee nobody can search for.
//
// Hence the split character class: '-' is legal INSIDE a handle (bob-smith)
// but never as the first character, so "--json" and "-a" are rejected. A
// single `[A-Za-z0-9._@-]+` would have accepted them, which is exactly the
// "quietly becomes an assignee nobody can search for" case above.
export const ASSIGNEE_RE = /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/;
export const ASSIGNEE_MAX = 128;

// `bd update --defer <when>` takes a relative offset (`+2d`), an ISO date or
// timestamp (`2026-08-01`, `2026-08-01T09:00`), or a short natural-language
// phrase (`next monday`) — bd itself does the parsing, and rejects what it
// can't read. This is the same hygiene as ASSIGNEE_RE: the value must not be
// flag-shaped (no leading '-'), must be one line, and is length-bounded, so a
// junk value 400s here instead of arriving as an opaque bd stderr blob. The
// empty string is handled separately by the caller (it CLEARS the deferral).
export const DEFER_RE = /^[A-Za-z0-9+][A-Za-z0-9 :+._/-]*$/;
export const DEFER_MAX = 64;

export function isValidDefer(value) {
  const s = String(value ?? '');
  return s.length > 0 && s.length <= DEFER_MAX && DEFER_RE.test(s);
}

// The exact `bd dep add --type` enum, verified against `bd dep add --help` on
// bd v1.1.0. User-supplied link types are ALWAYS checked against this
// hardcoded list before reaching execFile — no user text ever becomes a
// `--type` value directly.
//
// Deliberately NOT in this list, even though both appear as stored dependency
// types in the JSONL export:
//   - `duplicates` — produced only by `bd duplicate <id> --of <canonical>`
//     (op: 'mark-duplicate' below). `bd dep add --type duplicates` happens to
//     be accepted by the binary today, but it is not in the documented enum
//     and it skips the auto-close the dedicated command performs.
//   - `depends` / `depends-on` — never written by bd; they exist only in
//     relationships.js's defensive BLOCKING_DEP_TYPES read set.
//
// scripts/smoke.mjs re-parses `bd dep add --help` and fails loudly if a future
// bd upgrade changes the enum, and asserts public/ui/relationships.js's
// browser-side mirror of this list is identical.
export const LINK_TYPES = Object.freeze([
  'blocks',
  'tracks',
  'related',
  'parent-child',
  'discovered-from',
  'until',
  'caused-by',
  'validates',
  'relates-to',
  'supersedes',
]);
const LINK_TYPE_SET = new Set(LINK_TYPES);

// --- bd CLI (no shell; args array) ------------------------------------------
// execFile raises ENOENT for TWO different causes: the `bd` binary isn't on the
// PATH, and `cwd` (the registered workspace) doesn't exist. They are the same
// errno and there is nothing in the error to tell them apart, so a project
// whose directory was deleted or unmounted used to be reported as "bd binary
// not found" — and lib/health.mjs promotes that to a red install problem on
// every OTHER project too. Probe the workspace to say which one it actually is.
function enoentReason(workspace) {
  let dirOk = false;
  try { dirOk = statSync(workspace).isDirectory(); } catch { dirOk = false; }
  return dirOk
    ? "bd binary not found on the daemon's PATH — restart with 'bd-console start' to refresh the systemd unit's PATH"
    : `project directory no longer exists at ${workspace} — remove it from the hub with 'bd-console remove <id>' or restore the path`;
}

export function bd(ctx, args) {
  return new Promise((resolveP) => {
    execFile('bd', args, { cwd: ctx.workspace, maxBuffer: 8 * 1024 * 1024, timeout: 20000 }, (err, stdout, stderr) => {
      const enoent = err && err.code === 'ENOENT';
      resolveP({
        ok: !err,
        stdout: stdout || '',
        stderr: (stderr || '') || (enoent ? enoentReason(ctx.workspace) : ''),
        code: err?.code
      });
    });
  });
}

// --- issues -----------------------------------------------------------------

// Parsed-export memo, keyed by resolved path -> {key, issues} where key is
// mtimeMs+size (bd-console-974.3). Several routes call getIssues() 2-4 times
// per request (a create re-reads the whole export to echo the new issue; the
// stats route derives five tallies from it), and this project's own export is
// ~1MB of JSONL — re-reading and re-JSON.parse-ing it per call was the single
// most expensive thing an idle dashboard did.
//
// Invalidation is entirely implicit: a key that doesn't match the file on disk
// is a miss, so a write made by ANYONE (bd-console, a terminal, an agent, git)
// is picked up with no cache-busting call anywhere. mtime+size can in principle
// collide (a same-millisecond rewrite of identical length), which is why both
// are used; a hash would close that hole and cost the read this memo exists to
// avoid.
//
// The returned array is SHARED between callers. Every call site filters/maps/
// finds over it, none mutate it — keep it that way, or copy at the call site.
const ISSUES_MEMO = new Map();
const ISSUES_MEMO_MAX = 32; // a hub has a handful of projects; this is slack, not a limit anyone reaches

export async function getIssues(ctx) {
  const path = resolve(ctx.issuesExportPath);
  let st;
  try { st = await stat(path); } catch { return []; }
  const key = `${st.mtimeMs}:${st.size}`;

  const hit = ISSUES_MEMO.get(path);
  if (hit && hit.key === key) return hit.issues;

  const text = await readFile(path, 'utf8');
  const issues = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec._type === 'issue') issues.push(rec);
    } catch { /* skip */ }
  }

  // Re-set rather than update in place so the Map's insertion order tracks
  // recency, which makes the eviction below an LRU rather than an arbitrary
  // choice of victim.
  ISSUES_MEMO.delete(path);
  ISSUES_MEMO.set(path, { key, issues });
  while (ISSUES_MEMO.size > ISSUES_MEMO_MAX) ISSUES_MEMO.delete(ISSUES_MEMO.keys().next().value);
  return issues;
}

export async function getIssueById(ctx, id) {
  const issues = await getIssues(ctx);
  return issues.find((issue) => issue.id === id) || null;
}

async function mtimeMs(path) {
  try { return (await stat(path)).mtimeMs; } catch { return 0; }
}

export async function getExportInfo(ctx) {
  // `size` rides along so callers can build a strong validator (GET
  // /api/p/<id>/issues serves an ETag from exportedAt+size) without a second
  // stat of the same file — the same pair getIssues() memoizes on.
  let exportedAt = 0;
  let size = 0;
  try {
    const st = await stat(ctx.issuesExportPath);
    exportedAt = st.mtimeMs;
    size = st.size;
  } catch { /* missing export — reported as exists:false below */ }
  const lastTouchedAt = await mtimeMs(ctx.lastTouchedPath);
  const exists = exportedAt > 0;
  const stale = !!lastTouchedAt && (!exists || exportedAt < lastTouchedAt);
  return {
    exists,
    stale,
    exportedAt: exportedAt || null,
    size: exists ? size : null,
    lastTouchedAt: lastTouchedAt || null
  };
}

// One `bd export` at a time per workspace.
//
// EVERY write path ends with ensureIssuesExportFresh(force:true), so two writes
// landing together (two browser tabs, a UI action while the scheduler fires)
// used to run two `bd export` processes writing the SAME .beads/issues.jsonl
// while getIssues() read it — and getIssues silently skips lines it can't
// parse, so the interleaving surfaced as issues that briefly don't exist rather
// than as an error.
//
// Queued, not coalesced: an export that was ALREADY RUNNING when your write
// finished cannot be trusted to contain your write, so a caller waits for the
// in-flight run and then gets its own. Keyed by resolved workspace path — a
// per-project lock, since the file being written is per-project.
const exportQueues = new Map(); // resolved workspace -> tail promise of the queue

function withExportLock(ctx, fn) {
  const key = resolve(ctx.workspace || '.');
  const prev = exportQueues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // a failed predecessor must not block the queue
  const settled = run.then(() => {}, () => {});
  exportQueues.set(key, settled);
  // Drop the key once the queue drains, so a long-lived daemon doesn't retain
  // an entry per workspace it ever touched.
  settled.then(() => { if (exportQueues.get(key) === settled) exportQueues.delete(key); });
  return run;
}

async function runExport(ctx) {
  const r = await bd(ctx, ['export', '-o', join('.beads', 'issues.jsonl')]);
  if (!r.ok) {
    return { ok: false, error: (r.stderr || 'bd export failed').trim() };
  }
  return { ok: true, ...(await getExportInfo(ctx)) };
}

export async function refreshIssuesExport(ctx) {
  return withExportLock(ctx, () => runExport(ctx));
}

export async function ensureIssuesExportFresh(ctx, options = {}) {
  const force = !!options.force;
  const info = await getExportInfo(ctx);
  if (!force && info.exists && !info.stale) return { ok: true, refreshed: false, ...info };
  return withExportLock(ctx, async () => {
    // Re-checked INSIDE the lock: a non-forced refresh that queued behind
    // someone else's export has nothing left to do once that export landed.
    if (!force) {
      const nowInfo = await getExportInfo(ctx);
      if (nowInfo.exists && !nowInfo.stale) return { ok: true, refreshed: false, ...nowInfo };
    }
    const refreshed = await runExport(ctx);
    if (!refreshed.ok) return { ok: false, refreshed: false, ...info, error: refreshed.error };
    return { ok: true, refreshed: true, ...refreshed };
  });
}

// `bd <cmd> --json` prints a single JSON object; be forgiving about leading
// progress chatter so a stray line never turns a successful write into an
// error. Returns null when nothing parseable is present.
function parseJsonOut(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  if (start === -1) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

// Like parseJsonOut but also accepts a top-level ARRAY (`bd formula list
// --json`) and the bare literal `null` bd emits for an empty formula list.
export function parseBdJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* leading chatter — fall through */ }
  const candidates = [text.indexOf('{'), text.indexOf('[')].filter((n) => n >= 0);
  if (!candidates.length) return null;
  try { return JSON.parse(text.slice(Math.min(...candidates))); } catch { return null; }
}

// bd reports nearly every failure as PLAIN TEXT on stderr — including when
// `--json` was requested (re-confirmed on v1.1.0 for `cook`, `mol pour`,
// `formula show`). Normalize that to one compact line for the client.
//
// Absolute host paths are scrubbed to their basename throughout: bd names them
// freely (the `Search paths:` block after a formula-not-found, `open
// /abs/path/x: no such file`), the browser can do nothing with them, and they
// describe the server's directory layout to whoever is looking at the tab.
export function cleanBdError(raw, fallback = 'bd command failed') {
  const kept = [];
  for (const line of String(raw || '').split('\n')) {
    if (/^\s*Search paths:/i.test(line)) break;
    if (!line.trim()) continue;
    kept.push(redactPaths(line.replace(/^Error:\s*/i, '').trim()));
  }
  return kept.slice(0, 4).join(' — ') || fallback;
}

// /a/b/c.json -> c.json. Only rewrites absolute paths with a real directory
// component, so ordinary prose and bare filenames pass through untouched.
export function redactPaths(text) {
  return String(text || '').replace(/\/[^\s:,)"']*\/([^\s:,)"']+)/g, '$1');
}

// ---------------------------------------------------------------------------
// Formulas & molecules — docs/molecules-design.md, re-verified against
// bd v1.1.0 in a throwaway `bd init` fixture. See that doc for the full
// transcripts; the load-bearing quirks each have a comment at their use site.
// ---------------------------------------------------------------------------

// A formula name is a user-chosen FILE BASENAME (`<name>.formula.json` under a
// formula search path), not a bead id — so it needs its own, slightly looser
// pattern than ID_RE. Path separators and a leading dot are rejected outright:
// these go into an execFile args array (never a shell, never a path join), so
// traversal isn't the risk, but a garbage value should 400 here rather than
// come back as an opaque bd stderr blob.
export const FORMULA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// `bd mol pour <proto>` accepts either a formula name or a bead id; both fit.
export const PROTO_RE = FORMULA_NAME_RE;
export const VAR_KEY_RE = /^[A-Za-z0-9_]+$/;
export const FORMULA_TYPES = Object.freeze(['workflow', 'expansion', 'aspect', 'convoy']);
const VAR_VALUE_MAX = 512;

// Normalizes a `{ key: value }` variable map into sorted [key, value] pairs.
// Sorted so the same form state always produces the same argv (stable CLI
// echo, cacheable preview). An embedded `=` in a VALUE is fine — `--var` takes
// one flag per pair, so `--var msg=a=b` is unambiguous — but newlines are
// rejected: they'd corrupt the one-line CLI echo the UI shows the user.
export function normalizeVars(raw) {
  if (raw == null) return { ok: true, pairs: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'vars must be an object' };
  const pairs = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!VAR_KEY_RE.test(key)) return { ok: false, error: `bad variable name: ${key}` };
    if (value == null || value === '') continue; // an untouched form field is "not provided"
    const v = String(value);
    if (v.length > VAR_VALUE_MAX) return { ok: false, error: `variable "${key}" exceeds ${VAR_VALUE_MAX} characters` };
    if (/[\r\n]/.test(v)) return { ok: false, error: `variable "${key}" must not contain newlines` };
    pairs.push([key, v]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  return { ok: true, pairs };
}

export function varArgs(pairs) {
  return (pairs || []).flatMap(([k, v]) => ['--var', `${k}=${v}`]);
}

// The command line the UI echoes back ("✓ ran $ bd mol pour …"). Display only
// — the real invocation is always the args ARRAY, never this string.
export function cliEcho(args) {
  return 'bd ' + args.map((a) => (/[\s"'$`\\|&;<>()*?!#~]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(' ');
}

// GET /api/formulas. `bd formula list --json` returns a bare `null` (not `[]`)
// when no formulas are registered — normalized here so the client never has
// to special-case it.
export async function listFormulas(ctx, type = null) {
  if (type && !FORMULA_TYPES.includes(type)) {
    return { ok: false, status: 400, error: `type must be one of ${FORMULA_TYPES.join(', ')}` };
  }
  const args = ['formula', 'list', '--json'];
  if (type) args.push('--type', type);
  const r = await bd(ctx, args);
  if (!r.ok) return { ok: false, status: 500, error: cleanBdError(r.stderr || r.stdout, 'bd formula list failed') };
  const parsed = parseBdJson(r.stdout);
  return { ok: true, formulas: Array.isArray(parsed) ? parsed : [] };
}

// GET /api/formulas/:name — the variable-form's field list comes from the
// returned `vars` map, the step preview from `steps`.
export async function showFormula(ctx, name) {
  const r = await bd(ctx, ['formula', 'show', name, '--json']);
  if (!r.ok) {
    const err = String(r.stderr || r.stdout || '');
    if (/not found/i.test(err)) return { ok: false, status: 404, error: 'formula not found' };
    return { ok: false, status: 500, error: cleanBdError(err, 'bd formula show failed') };
  }
  const formula = parseBdJson(r.stdout);
  if (!formula) return { ok: false, status: 500, error: 'bd formula show returned unparseable output' };
  return { ok: true, formula };
}

// GET /api/formulas/:name/preview — the LIVE variable preview.
//
// `bd cook` is the one call in this whole feature area whose `--json` is
// honored on every path (unlike `mol pour --dry-run`, which silently ignores
// it), which is exactly why it, and not a dry-run pour, backs live typing.
//
// Two modes, both real: with no --var it stays in COMPILE mode and returns the
// steps with `{{placeholders}}` intact; with any --var it switches to RUNTIME
// mode, which — re-confirmed on v1.1.0 — requires EVERY declared variable to
// resolve (vars carrying a `default` self-resolve; vars without one must be
// supplied). Its missing-variable complaint is plain text on stderr, exit 1 —
// NOT the JSON error object docs/molecules-design.md §3.1 predicted — so it is
// surfaced as a 400 with bd's own wording rather than parsed.
export async function previewFormula(ctx, name, pairs) {
  const args = ['cook', name, ...varArgs(pairs), '--json'];
  const r = await bd(ctx, args);
  if (!r.ok) {
    const err = String(r.stderr || r.stdout || '');
    if (/not found in search paths/i.test(err)) return { ok: false, status: 404, error: 'formula not found' };
    return { ok: false, status: 400, error: cleanBdError(err, 'bd cook failed'), command: cliEcho(args) };
  }
  const preview = parseBdJson(r.stdout);
  if (!preview) return { ok: false, status: 500, error: 'bd cook returned unparseable output' };
  return { ok: true, preview, mode: pairs.length ? 'runtime' : 'compile', command: cliEcho(args) };
}

// GET /api/molecules/:id — `bd mol show` plus the two cheap, index-backed
// summaries the Detail panel wants. `mol show` on a STEP id succeeds but
// echoes the step back as its own `root` with no dependencies (confirmed), so
// callers must resolve step -> root client-side (relationships.js's
// moleculeRootOf) before calling this, never rely on bd to do it.
export async function showMolecule(ctx, id, { parallel = false } = {}) {
  const r = await bd(ctx, ['mol', 'show', id, '--json']);
  if (!r.ok) {
    // This is the one command in the set whose NOT-FOUND really is JSON:
    // {"error": "molecule 'X' not found", "schema_version": 1} on stdout.
    const parsed = parseBdJson(r.stdout);
    if (parsed?.error) return { ok: false, status: 404, error: String(parsed.error) };
    return { ok: false, status: 500, error: cleanBdError(r.stderr || r.stdout, 'bd mol show failed') };
  }
  const molecule = parseBdJson(r.stdout);
  if (!molecule) return { ok: false, status: 500, error: 'bd mol show returned unparseable output' };

  const pr = await bd(ctx, ['mol', 'progress', id, '--json']);
  const progress = pr.ok ? parseBdJson(pr.stdout) : null;

  let parallelInfo = null;
  if (parallel) {
    const qr = await bd(ctx, ['ready', '--mol', id, '--json']);
    if (qr.ok) parallelInfo = parseBdJson(qr.stdout);
  }
  return { ok: true, molecule, progress, parallel: parallelInfo };
}

// The mandatory pre-pour preview.
//
// `--json` is deliberately NOT passed: on v1.1.0 `bd mol pour --dry-run --json`
// silently ignores --json and prints the human "Dry run: would pour N issues…"
// block anyway (re-confirmed byte-for-byte). Asking for JSON we know we won't
// get would only imply to a future maintainer that the output is structured.
// It is opaque preview TEXT — rendered verbatim, never parsed into a model.
export async function pourPreview(ctx, proto, pairs) {
  const args = ['mol', 'pour', proto, ...varArgs(pairs), '--dry-run'];
  const r = await bd(ctx, args);
  const command = cliEcho(args);
  if (!r.ok) {
    const err = String(r.stderr || r.stdout || '');
    // `bd mol pour` reports a formula that FAILS VALIDATION with the same
    // "not found as formula or proto ID" text it uses for a genuinely absent
    // one (reproduced: a step whose `needs` names a nonexistent step). `bd
    // cook` reports the real reason, so ask it and forward that instead of
    // the misleading message. The other spelling of "absent" that pour emits
    // ("parsing formula: read X: open /abs/X: no such file or directory")
    // gets the same treatment — it too is really just "unknown formula".
    if (/not found as formula or proto/i.test(err) || /no such file or directory/i.test(err)) {
      const why = await previewFormula(ctx, proto, pairs);
      const absent = why.ok || why.status === 404 || /no such file|not found/i.test(why.error || '');
      if (!absent) return { ok: false, status: 400, error: why.error, command };
      return { ok: false, status: 404, error: `"${proto}" is not a known formula or proto`, command };
    }
    return { ok: false, status: 400, error: cleanBdError(err, 'bd mol pour --dry-run failed'), command };
  }
  return { ok: true, preview: String(r.stdout || '').trim(), command };
}

// (The single advisory number read out of that text — "would pour N issues" —
// lives in public/ui/formulas.js's previewIssueCount, next to the rest of the
// formula derivations, so there is exactly one implementation of it.)

// THE write. Creates a root bead plus one bead per formula step in a single
// bd invocation.
//
// Partial failure: docs/molecules-design.md §8 lists "can a pour fail PARTWAY
// through?" as its single riskiest unknown. It is now reproducible — a formula
// whose `needs` edges form a cycle passes cook/validation, creates its beads,
// and then fails at dependency-creation time ("failed to create dependency:
// adding dependency would create a cycle") — and in that case bd rolled back
// completely, leaving zero strays. That is evidence, not a guarantee, so the
// failure path below re-exports and diffs the id set against a snapshot taken
// just before the call, and reports whatever actually landed. A pour that
// half-succeeds gets told to the user honestly instead of being reported as
// "failed, nothing happened."
export async function pourMolecule(ctx, proto, pairs, { assignee = null } = {}) {
  const args = ['mol', 'pour', proto, ...varArgs(pairs)];
  if (assignee) args.push('--assignee', assignee);
  args.push('--json');
  const command = cliEcho(args);

  const snapshot = await ensureIssuesExportFresh(ctx, { force: true });
  const before = new Set(snapshot.ok ? (await getIssues(ctx)).map((i) => i.id) : []);
  const strays = async () => {
    const after = await ensureIssuesExportFresh(ctx, { force: true });
    if (!after.ok) return null; // can't tell — say so rather than claim "nothing happened"
    return (await getIssues(ctx)).filter((i) => !before.has(i.id)).map((i) => ({ id: i.id, title: i.title }));
  };

  const r = await bd(ctx, args);
  if (!r.ok) {
    const partial = snapshot.ok ? await strays() : null;
    return {
      ok: false,
      status: 500,
      error: cleanBdError(r.stderr || r.stdout, 'bd mol pour failed'),
      command,
      // null = we could not verify (export failed); [] = verified clean.
      partial: partial === null ? { verified: false, created: [] } : { verified: true, created: partial },
    };
  }

  // Pour's SUCCESS path does honor --json (only --dry-run drops it).
  const result = parseBdJson(r.stdout);
  const exportInfo = await ensureIssuesExportFresh(ctx, { force: true });
  const created = result && result.id_mapping ? Object.values(result.id_mapping) : [];
  const observed = exportInfo.ok ? (await getIssues(ctx)).filter((i) => !before.has(i.id)).map((i) => i.id) : [];
  const missing = exportInfo.ok ? created.filter((id) => !observed.includes(id)) : [];

  return {
    ok: true,
    status: 200,
    command,
    created: result?.created ?? created.length,
    new_epic_id: result?.new_epic_id ?? null,
    id_mapping: result?.id_mapping ?? {},
    phase: result?.phase ?? null,
    attached: result?.attached ?? 0,
    // A success exit that nonetheless left beads unaccounted for: reported,
    // not swallowed. `warning` also carries any stderr chatter bd emits
    // alongside a zero exit (e.g. the vapor-phase pour warning).
    observedCount: observed.length,
    missing,
    warning: (r.stderr || '').trim() || null,
    export: exportInfo,
  };
}

// Burn's dry-run, same text-not-JSON contract as pour's.
export async function burnPreview(ctx, id) {
  const args = ['mol', 'burn', id, '--dry-run'];
  const r = await bd(ctx, args);
  const command = cliEcho(args);
  if (!r.ok) {
    const parsed = parseBdJson(r.stdout);
    if (parsed?.error) return { ok: false, status: 404, error: String(parsed.error), command };
    return { ok: false, status: 400, error: cleanBdError(r.stderr || r.stdout, 'bd mol burn --dry-run failed'), command };
  }
  return { ok: true, preview: String(r.stdout || '').trim(), command };
}

// The undo for a bad pour: an unconditional cascade delete of the root and
// EVERY issue parented under it.
//
// Verified in a fixture, and the UI copy says so explicitly, because the scope
// is wider than "the beads pour created":
//   - a bead added to the molecule by hand afterwards IS deleted too
//     (`--parent <root>` is the only membership test);
//   - dependency rows from OUTSIDE issues that pointed INTO the molecule are
//     removed, and those outside issues come back in `orphaned_issues` — they
//     survive, but silently lose the edge;
//   - nothing is archived: `bd mol squash` makes digests, `burn` does not.
// Response field is `deleted` (an id array) — docs/molecules-design.md called
// it `deleted_ids`; that was wrong.
export async function burnMolecule(ctx, id) {
  const args = ['mol', 'burn', id, '--force', '--json'];
  const r = await bd(ctx, args);
  const command = cliEcho(args);
  if (!r.ok) {
    const parsed = parseBdJson(r.stdout);
    if (parsed?.error) return { ok: false, status: 404, error: String(parsed.error), command };
    return { ok: false, status: 500, error: cleanBdError(r.stderr || r.stdout, 'bd mol burn failed'), command };
  }
  const result = parseBdJson(r.stdout) || {};
  const exportInfo = await ensureIssuesExportFresh(ctx, { force: true });
  return {
    ok: true,
    status: 200,
    command,
    deleted: Array.isArray(result.deleted) ? result.deleted : [],
    deleted_count: result.deleted_count ?? 0,
    dependencies_removed: result.dependencies_removed ?? 0,
    orphaned_issues: Array.isArray(result.orphaned_issues) ? result.orphaned_issues : [],
    export: exportInfo,
  };
}

// ---------------------------------------------------------------------------
// Formula AUTHORING (bd-console-9it)
//
// The pour flow above needs a formula to exist, and until this file there was
// no way to produce one from the product: `bd formula` exposes only list/show/
// convert (re-verified on v1.1.0 — there is NO `formula create`), so formulas
// were hand-written TOML/JSON on the user's disk. Two real authoring paths
// exist, and both are wrapped here:
//
//   A. `bd mol distill <epic> <name> [--var name=value]` — turns an epic the
//      user already built into a `.formula.json`, replacing concrete values
//      with {{placeholders}}. The natural "save this as a template" move.
//   B. Writing the file directly, which is what the formula editor does.
//
// Three verified bd behaviours shape everything below:
//
//   1. `bd formula list` reports a formula's name from the FILE CONTENT's
//      `formula` field, but `formula show` / `cook` / `mol pour` resolve it by
//      FILE BASENAME. A file named outer.formula.json declaring
//      {"formula":"inner"} therefore LISTS as "inner" and cannot be opened
//      under either name. validateFormulaSource() refuses to write that.
//   2. A malformed file is silently SKIPPED by `bd formula list` — it doesn't
//      error, the formula just vanishes. So validation has to happen before
//      the write, never after.
//   3. `bd mol distill` does NOT sanitize its <name> argument: passing
//      `../evil` writes outside the formulas directory. Every name reaching
//      distill is checked against FORMULA_NAME_RE first.
// ---------------------------------------------------------------------------

// Longest-first: `.formula.json` must be tested before `.json` so
// formulaStem() strips the whole suffix rather than leaving ".formula".
export const FORMULA_EXTS = Object.freeze(['.formula.json', '.formula.toml', '.json', '.toml']);
// A formula FILE basename. Leading dot excluded (no dotfiles), no separators,
// no `..` — this is a filename, and it is joined onto a directory path.
export const FORMULA_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const FORMULA_CONTENT_MAX_BYTES = 256 * 1024;

/** `release.formula.json` -> `release`. THE identity bd loads a formula by. */
export function formulaStem(name) {
  const raw = String(name ?? '');
  const lower = raw.toLowerCase();
  for (const ext of FORMULA_EXTS) {
    if (lower.endsWith(ext) && lower.length > ext.length) return raw.slice(0, -ext.length);
  }
  return raw;
}

/** `release` -> `release.formula.json` (the shape distill itself writes). */
export function formulaFileName(name) {
  const n = String(name ?? '');
  return FORMULA_EXTS.some((e) => n.toLowerCase().endsWith(e)) ? n : `${n}.formula.json`;
}

// The same discipline as docs.mjs's resolveDocPath: resolve, confine to one
// directory, allowlist the extension. Returns null (-> 400) for anything else.
export function resolveFormulaFilePath(dir, name) {
  const n = String(name ?? '');
  if (!n || n.includes('\0')) return null;
  if (n !== basename(n)) return null;            // no separators, no traversal
  if (!FORMULA_FILE_RE.test(n)) return null;     // also rejects `..` and dotfiles
  if (!FORMULA_EXTS.some((e) => n.toLowerCase().endsWith(e))) return null;
  if (!formulaStem(n)) return null;              // a bare extension is not a name
  const full = resolve(dir, n);
  if (dirname(full) !== resolve(dir)) return null; // belt and braces
  return full;
}

// Search path #1 in `bd formula --help` is `<resolved-beads-dir>/formulas/`,
// and `bd context --json` is the only authoritative answer for where that
// resolved beads dir actually is (it can be redirected). Cached per workspace:
// it cannot change while the daemon holds the same registry entry, and this is
// on the path of every formula read.
const formulasDirCache = new Map();
export async function getFormulasDir(ctx) {
  const cached = formulasDirCache.get(ctx.workspace);
  if (cached) return cached;
  let beadsDir = join(ctx.workspace, '.beads');
  const r = await bd(ctx, ['context', '--json']);
  if (r.ok) {
    const parsed = parseBdJson(r.stdout);
    const reported = parsed && typeof parsed.beads_dir === 'string' ? parsed.beads_dir : '';
    if (reported && isAbsolute(reported)) beadsDir = reported;
  }
  const dir = join(beadsDir, 'formulas');
  formulasDirCache.set(ctx.workspace, dir);
  return dir;
}

// GET /api/formula-files — the editor's file list. Deliberately the RAW
// directory listing rather than `bd formula list`, because the editor edits
// files: `formula list` merges in ~/.beads/formulas (not ours to write),
// hides malformed files entirely (exactly the ones a user needs to fix), and
// reports content names rather than filenames.
export async function listFormulaFiles(ctx) {
  const dir = await getFormulasDir(ctx);
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return { dir, files: [] }; }
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || !resolveFormulaFilePath(dir, e.name)) continue;
    let size = 0;
    let mtime = 0;
    try { const st = await stat(join(dir, e.name)); size = st.size; mtime = st.mtimeMs; } catch { /* raced */ }
    files.push({ name: e.name, formula: formulaStem(e.name), size, mtime });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, files };
}

export async function readFormulaFile(ctx, name) {
  const dir = await getFormulasDir(ctx);
  const full = resolveFormulaFilePath(dir, name);
  if (!full) return { ok: false, status: 400, error: 'invalid formula file name' };
  let st;
  try { st = await stat(full); } catch { return { ok: false, status: 404, error: 'formula file not found' }; }
  if (!st.isFile()) return { ok: false, status: 404, error: 'formula file not found' };
  if (st.size > FORMULA_CONTENT_MAX_BYTES) return { ok: false, status: 413, error: 'formula file is too large to edit here' };
  return { ok: true, name, formula: formulaStem(name), content: await readFile(full, 'utf8'), mtime: st.mtimeMs };
}

// THE pre-write gate. `bd cook <path>` is the one command that accepts a FILE
// PATH rather than a search-path name (verified on v1.1.0), which is what
// makes it possible to validate a candidate without first installing it — a
// malformed file dropped into the formulas dir doesn't error, it silently
// disappears from `formula list`, so "write then check" is not an option.
//
// Runs against a copy in the OS temp dir, never inside the project, so a
// rejected draft never exists where bd could pick it up. The extension is
// preserved because bd picks its parser from it (TOML vs JSON).
export async function validateFormulaSource(ctx, name, content) {
  const dir = await getFormulasDir(ctx);
  if (!resolveFormulaFilePath(dir, name)) return { ok: false, status: 400, error: 'invalid formula file name' };
  if (typeof content !== 'string') return { ok: false, status: 400, error: 'content must be a string' };
  if (!content.trim()) return { ok: false, status: 400, error: 'a formula file cannot be empty' };
  if (Buffer.byteLength(content, 'utf8') > FORMULA_CONTENT_MAX_BYTES) {
    return { ok: false, status: 400, error: `content exceeds ${Math.round(FORMULA_CONTENT_MAX_BYTES / 1024)}KB limit` };
  }

  let scratch = null;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'bd-console-formula-'));
    const probe = join(scratch, name);
    await writeFile(probe, content, 'utf8');
    const r = await bd(ctx, ['cook', probe, '--json']);
    if (!r.ok) {
      // bd's OWN message, path-scrubbed — it names the line/field at fault far
      // better than anything this file could reconstruct.
      return { ok: false, status: 400, error: cleanBdError(r.stderr || r.stdout, 'bd rejected this formula') };
    }
    const doc = parseBdJson(r.stdout);
    if (!doc) return { ok: false, status: 400, error: 'bd could not read this formula' };
    // Checks bd itself does NOT make, each of which produces a formula that
    // exists but cannot be used:
    const stem = formulaStem(name);
    if (!doc.formula) return { ok: false, status: 400, error: 'the formula needs a "formula" name field' };
    if (doc.formula !== stem) {
      return {
        ok: false,
        status: 400,
        error: `this file is ${stem}, so its "formula" field must say "${stem}" too (it says "${doc.formula}") — bd lists a formula by the name inside the file but loads it by filename, so a mismatch makes it impossible to pour`,
      };
    }
    if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
      return { ok: false, status: 400, error: 'a formula needs at least one step — pouring it would create an empty molecule' };
    }
    return { ok: true, doc };
  } catch (e) {
    return { ok: false, status: 500, error: `could not validate formula: ${e.message}` };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// POST /api/formula-file. Validated first (above), then written the same way
// /api/doc writes: tmp file + rename, so `bd formula list` never observes a
// half-written file. The `.tmp` suffix keeps the in-flight copy outside every
// formula extension bd globs for.
export async function writeFormulaFile(ctx, name, content, { overwrite = true } = {}) {
  const dir = await getFormulasDir(ctx);
  const full = resolveFormulaFilePath(dir, name);
  if (!full) return { ok: false, status: 400, error: 'invalid formula file name' };

  const validation = await validateFormulaSource(ctx, name, content);
  if (!validation.ok) return validation;

  if (!overwrite && existsSync(full)) {
    return { ok: false, status: 409, error: `${name} already exists` };
  }

  try {
    await mkdir(dir, { recursive: true });
    const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, full);
  } catch (e) {
    return { ok: false, status: 500, error: `failed to write formula: ${e.message}` };
  }
  const st = await stat(full);
  return {
    ok: true,
    status: 200,
    name,
    formula: formulaStem(name),
    steps: Array.isArray(validation.doc.steps) ? validation.doc.steps.length : 0,
    mtime: st.mtimeMs,
  };
}

// --- distill ---------------------------------------------------------------
// `--output <dir>` is passed explicitly on BOTH the preview and the write so
// the file lands exactly where listFormulaFiles() reads. Left to itself bd
// picks the "first writable" of three candidate directories, which could put
// the result somewhere the editor can never show.
function distillArgs(epicId, name, pairs, dir, tail) {
  return ['mol', 'distill', epicId, name, ...varArgs(pairs), '--output', dir, ...tail];
}

// The CLI echo the UI shows. Identical to what ran, except the absolute
// --output directory is rewritten to its project-relative form — the browser
// can do nothing with a host path, and it describes the server's layout (same
// posture as cleanBdError's scrubbing). Copy-pasteable from the repo root.
function distillEcho(ctx, args, dir) {
  const rel = relative(ctx.workspace, dir);
  const shown = rel && !rel.startsWith('..') ? rel : basename(dir);
  return cliEcho(args.map((a) => (a === dir ? shown : a)));
}

// GET /api/formula-distill-preview — OPAQUE TEXT, like pour's dry run.
// docs/molecules-design.md records that `--json` is silently ignored on
// dry-run paths; re-confirmed here for distill on v1.1.0 (the human block is
// printed byte-for-byte whether or not --json is passed). It is rendered
// verbatim and never parsed. Paths are scrubbed because the block names the
// absolute output file.
export async function distillPreview(ctx, epicId, name, pairs) {
  const dir = await getFormulasDir(ctx);
  const args = distillArgs(epicId, name, pairs, dir, ['--dry-run']);
  const command = distillEcho(ctx, args, dir);
  const r = await bd(ctx, args);
  if (!r.ok) {
    const err = String(r.stderr || r.stdout || '');
    if (/not found/i.test(err)) return { ok: false, status: 404, error: `"${epicId}" was not found`, command };
    return { ok: false, status: 400, error: cleanBdError(err, 'bd mol distill --dry-run failed'), command };
  }
  return { ok: true, preview: redactPaths(String(r.stdout || '').trim()), command };
}

// POST /api/formula-distill — the write. Unlike pour this creates no beads; it
// creates one FILE, so the blast radius is a single formula the user named.
// distill's success path DOES honor --json: {formula_name, formula_path,
// schema_version, steps, variables} (variables is `null`, not [], when no
// --var was passed).
export async function distillEpic(ctx, epicId, name, pairs) {
  const dir = await getFormulasDir(ctx);
  await mkdir(dir, { recursive: true }).catch(() => {});
  const args = distillArgs(epicId, name, pairs, dir, ['--json']);
  const command = distillEcho(ctx, args, dir);
  const r = await bd(ctx, args);
  if (!r.ok) {
    const err = String(r.stderr || r.stdout || '');
    if (/not found/i.test(err)) return { ok: false, status: 404, error: `"${epicId}" was not found`, command };
    return { ok: false, status: 500, error: cleanBdError(err, 'bd mol distill failed'), command };
  }
  const result = parseBdJson(r.stdout) || {};
  return {
    ok: true,
    status: 200,
    command,
    formula: result.formula_name || name,
    file: result.formula_path ? basename(result.formula_path) : formulaFileName(name),
    steps: result.steps ?? 0,
    variables: Array.isArray(result.variables) ? result.variables : [],
  };
}

export async function runIssueEdit(ctx, body) {
  const id = String(body.id || '');
  const op = String(body.op || '');
  if (!ID_RE.test(id)) return { ok: false, status: 400, error: 'bad id' };

  let result;
  // Set by the ops that need to tell the UI something beyond "it worked" —
  // notably supersede/mark-duplicate, which auto-close the subject issue.
  let effect = null;
  if (op === 'claim') {
    result = await bd(ctx, ['update', id, '--claim']);
  } else if (op === 'set-status') {
    const status = String(body.status || '');
    if (!['open', 'in_progress', 'closed'].includes(status)) return { ok: false, status: 400, error: 'bad status' };
    if (status === 'closed') {
      const args = ['close', id];
      if (body.reason) args.push('--reason', String(body.reason));
      result = await bd(ctx, args);
    } else if (status === 'open') {
      const args = ['reopen', id];
      if (body.reason) args.push('--reason', String(body.reason));
      result = await bd(ctx, args);
    } else {
      result = await bd(ctx, ['update', id, '--status', status]);
    }
  } else if (op === 'set-priority') {
    const priority = String(body.priority ?? '');
    if (!/^[0-4]$/.test(priority)) return { ok: false, status: 400, error: 'bad priority' };
    result = await bd(ctx, ['update', id, '-p', priority]);
  } else if (op === 'set-assignee') {
    // Reassign, or UNASSIGN with an empty string — the same convention
    // set-parent and set-defer already use, so all three "single scalar field"
    // ops clear the same way.
    //
    // The clearing incantation is the half that's easy to get wrong, so it was
    // verified against bd v1.1.0 in a throwaway fixture rather than assumed:
    // `bd update <id> --assignee ""` clears the field outright — the `assignee`
    // key disappears from the JSONL export entirely, it does not become "".
    // `bd assign <id> ""` (documented in `bd assign --help` as the unassign
    // form) does exactly the same thing and only differs in its stdout receipt
    // ("✓ Unassigned …"). One command handles set AND clear here, so there is
    // no second code path whose validation could drift.
    //
    // `bd update` with NO id updates the last-touched issue — id is validated
    // and always passed, so this can never silently retarget.
    const assignee = String(body.assignee ?? '').trim();
    if (assignee) {
      if (assignee.length > ASSIGNEE_MAX) return { ok: false, status: 400, error: `assignee exceeds ${ASSIGNEE_MAX} characters` };
      if (!ASSIGNEE_RE.test(assignee)) return { ok: false, status: 400, error: 'bad assignee' };
    }
    result = await bd(ctx, ['update', id, '--assignee', assignee]);
  } else if (op === 'add-label' || op === 'remove-label') {
    const label = String(body.label || '').trim();
    if (!LABEL_RE.test(label)) return { ok: false, status: 400, error: 'bad label' };
    result = await bd(ctx, ['label', op === 'add-label' ? 'add' : 'remove', id, label]);
  } else if (op === 'set-parent') {
    const parent = String(body.parent || '').trim();
    if (parent && !ID_RE.test(parent)) return { ok: false, status: 400, error: 'bad parent id' };
    result = await bd(ctx, ['update', id, '--parent', parent]);
  } else if (op === 'add-link' || op === 'remove-link' || op === 'add-blocker' || op === 'remove-blocker') {
    // add-blocker/remove-blocker are the back-compat aliases of add-link/
    // remove-link with the type pinned to `blocks` and the target read from
    // body.blocker instead of body.other. One code path, so the id/type
    // validation below can never diverge between the two spellings.
    const legacy = op === 'add-blocker' || op === 'remove-blocker';
    const adding = op === 'add-link' || op === 'add-blocker';
    const other = String((legacy ? body.blocker : body.other) ?? '').trim();
    if (!ID_RE.test(other)) return { ok: false, status: 400, error: legacy ? 'bad blocker id' : 'bad link target id' };
    if (other === id) return { ok: false, status: 400, error: 'an issue cannot link to itself' };
    const type = legacy ? 'blocks' : String(body.type ?? 'blocks').trim();
    if (!LINK_TYPE_SET.has(type)) return { ok: false, status: 400, error: 'bad link type' };
    // `bd dep remove` takes no --type: a given (issue, depends_on) pair can
    // carry at most one row, so the pair alone identifies the edge.
    result = adding
      ? await bd(ctx, ['dep', 'add', id, other, '--type', type])
      : await bd(ctx, ['dep', 'remove', id, other]);
    effect = { kind: adding ? 'add-link' : 'remove-link', id, other, type };
  } else if (op === 'supersede' || op === 'mark-duplicate') {
    // State transitions, not plain links: bd closes `id` as a side effect and
    // records the edge on `id` itself ({issue_id: id, depends_on_id: other,
    // type: 'supersedes'|'duplicates'}). The `effect` returned below is what
    // lets the UI say "…and closed it" instead of silently closing an issue.
    const superseding = op === 'supersede';
    const other = String((superseding ? body.with : body.of) ?? '').trim();
    if (!ID_RE.test(other)) return { ok: false, status: 400, error: superseding ? 'bad replacement id' : 'bad canonical id' };
    if (other === id) return { ok: false, status: 400, error: superseding ? 'an issue cannot supersede itself' : 'an issue cannot duplicate itself' };
    result = superseding
      ? await bd(ctx, ['supersede', id, '--with', other, '--json'])
      : await bd(ctx, ['duplicate', id, '--of', other, '--json']);
    effect = { kind: op, id, other };
  } else if (op === 'set-defer') {
    const defer = String(body.defer ?? '').trim();
    // Empty CLEARS the deferral (the Detail editor's blank field); anything else
    // has to look like a date bd could parse. Unvalidated, this was the one
    // request field that reached execFile as a raw `--defer <value>` — see
    // DEFER_RE for what that buys.
    if (defer && !isValidDefer(defer)) {
      return { ok: false, status: 400, error: 'bad defer value — use +2d, 2026-08-01, or a short phrase like "next monday"' };
    }
    result = await bd(ctx, ['update', id, '--defer', defer]);
  } else {
    return { ok: false, status: 400, error: 'bad op' };
  }

  if (!result.ok) return { ok: false, status: 500, error: (result.stderr || 'bd command failed').trim() };
  const exportInfo = await ensureIssuesExportFresh(ctx, { force: true });
  if (!exportInfo.ok) return { ok: false, status: 500, error: exportInfo.error, export: exportInfo };
  const issue = await getIssueById(ctx, id);

  if (effect && (effect.kind === 'supersede' || effect.kind === 'mark-duplicate')) {
    // `bd supersede --json` -> {superseded, replacement, status}
    // `bd duplicate --json` -> {duplicate, canonical, status}
    const parsed = parseJsonOut(result.stdout);
    const resultStatus = parsed?.status ?? issue?.status ?? null;
    effect.resultStatus = resultStatus;
    effect.autoClosed = resultStatus === 'closed';
    effect.message = effect.kind === 'supersede'
      ? `${id} superseded by ${effect.other}${effect.autoClosed ? ' — ' + id + ' was closed' : ''}`
      : `${id} marked duplicate of ${effect.other}${effect.autoClosed ? ' — ' + id + ' was closed' : ''}`;
  }

  return { ok: true, status: 200, export: exportInfo, issue, ...(effect ? { effect } : {}) };
}
