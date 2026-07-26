// lib/bd.mjs — the `bd` CLI wrapper (no shell; args array) + issue export
// helpers + the issue-edit dispatcher.
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.\d+)*$/; // bead id: prefix-xxx or prefix-xxx.N
export const LABEL_RE = /^[A-Za-z0-9_.:-]+$/;

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
export function bd(ctx, args) {
  return new Promise((resolveP) => {
    execFile('bd', args, { cwd: ctx.workspace, maxBuffer: 8 * 1024 * 1024, timeout: 20000 }, (err, stdout, stderr) => {
      // ENOENT means the daemon's PATH can't see `bd` at all (classic systemd
      // minimal-PATH symptom) — say so instead of a bare "bd <cmd> failed".
      const enoent = err && err.code === 'ENOENT';
      resolveP({
        ok: !err,
        stdout: stdout || '',
        stderr: (stderr || '') || (enoent ? "bd binary not found on the daemon's PATH — restart with 'bd-console start' to refresh the systemd unit's PATH" : ''),
        code: err?.code
      });
    });
  });
}

// --- issues -----------------------------------------------------------------
export async function getIssues(ctx) {
  if (!existsSync(ctx.issuesExportPath)) return [];
  const text = await readFile(ctx.issuesExportPath, 'utf8');
  const issues = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec._type === 'issue') issues.push(rec);
    } catch { /* skip */ }
  }
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
  const exportedAt = await mtimeMs(ctx.issuesExportPath);
  const lastTouchedAt = await mtimeMs(ctx.lastTouchedPath);
  const exists = exportedAt > 0;
  const stale = !!lastTouchedAt && (!exists || exportedAt < lastTouchedAt);
  return {
    exists,
    stale,
    exportedAt: exportedAt || null,
    lastTouchedAt: lastTouchedAt || null
  };
}

export async function refreshIssuesExport(ctx) {
  const r = await bd(ctx, ['export', '-o', join('.beads', 'issues.jsonl')]);
  if (!r.ok) {
    return { ok: false, error: (r.stderr || 'bd export failed').trim() };
  }
  return { ok: true, ...(await getExportInfo(ctx)) };
}

export async function ensureIssuesExportFresh(ctx, options = {}) {
  const force = !!options.force;
  const info = await getExportInfo(ctx);
  if (!force && info.exists && !info.stale) return { ok: true, refreshed: false, ...info };
  const refreshed = await refreshIssuesExport(ctx);
  if (!refreshed.ok) return { ok: false, refreshed: false, ...info, error: refreshed.error };
  return { ok: true, refreshed: true, ...refreshed };
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
    const defer = String(body.defer ?? '');
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
