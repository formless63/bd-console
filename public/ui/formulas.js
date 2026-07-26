// formulas.js — pure derivations over a bd FORMULA document, the file-backed
// template `bd mol pour` instantiates into a molecule.
//
// Deliberately dependency-free (no signals, no imports), exactly like
// relationships.js, so the browser AND scripts/smoke.mjs in plain Node can
// both use it — which is what makes the variable/preview rules below
// assertable without a browser.
//
// Shape reference (re-confirmed against bd v1.1.0, `bd formula show <n>
// --json`; see docs/molecules-design.md §3.1):
//   { formula, description, version, type, source, schema_version,
//     vars: { <key>: { description?, required?, default?, enum?, pattern? } },
//     steps: [ { id, title, type, needs?: [stepId], description?, gate? } ] }

// Object key order is insertion order for string keys, and bd emits `vars`
// sorted, so this is stable and matches the CLI's own listing.
// -> [{ key, description, required, hasDefault, default, enum, pattern }]
export function formulaVars(formula) {
  const vars = (formula && formula.vars) || {};
  return Object.entries(vars).map(([key, spec]) => {
    const s = spec || {};
    return {
      key,
      description: s.description || '',
      required: !!s.required,
      hasDefault: s.default !== undefined && s.default !== null,
      default: s.default ?? '',
      enum: Array.isArray(s.enum) ? s.enum : null,
      pattern: typeof s.pattern === 'string' ? s.pattern : null,
    };
  });
}

export function formulaSteps(formula) {
  return Array.isArray(formula && formula.steps) ? formula.steps : [];
}

// A step's prerequisites. bd accepts BOTH spellings and writes different ones
// depending on where the formula came from: a hand-written formula uses
// `needs`, but `bd mol distill` emits `depends_on` (verified on v1.1.0 — a
// distilled formula's steps carry depends_on, and cook/pour honor either).
// Reading only `needs` is why a distilled formula previewed as if its steps
// had no order at all.
export function stepNeeds(step) {
  const s = step || {};
  const raw = Array.isArray(s.needs) ? s.needs : Array.isArray(s.depends_on) ? s.depends_on : [];
  return raw.map((n) => String(n));
}

// Beads a pour of this formula creates: one root plus one per step. This is
// the number the confirm button quotes BEFORE the dry-run runs; the dry-run's
// own "would pour N issues" (previewIssueCount below) supersedes it once
// available, since bd is the authority on its own arithmetic.
export function pourBeadCount(formula) {
  return formulaSteps(formula).length + 1;
}

// Which declared variables still have no value.
//
// The rule is bd's, re-confirmed on v1.1.0 and NOT what the CLI's own help
// implies: passing ANY `--var` switches `bd cook` into runtime mode, and
// runtime mode requires EVERY declared variable to resolve — not just the
// ones marked `required`. Variables carrying a `default` resolve themselves,
// so the set that actually blocks a pour is "declared, no default, no value."
export function missingVars(formula, values) {
  const v = values || {};
  return formulaVars(formula)
    .filter((spec) => !spec.hasDefault && !String(v[spec.key] ?? '').trim())
    .map((spec) => spec.key);
}

// Which of `bd cook`'s two modes a given form state can legally ask for.
// 'compile' renders the raw {{placeholders}} (the empty-form case and any
// partially-filled state); 'runtime' renders substituted titles. Asking for
// runtime with a gap is an error exit from bd, not a partial render, so the
// live preview must pick the mode rather than always sending what it has.
export function previewMode(formula, values) {
  const v = values || {};
  const anyProvided = formulaVars(formula).some((spec) => String(v[spec.key] ?? '').trim());
  if (!anyProvided) return 'compile';
  return missingVars(formula, values).length ? 'compile' : 'runtime';
}

// The var map to actually send. In compile mode bd wants NO --var at all
// (any single --var flips it into runtime mode and it then demands the rest),
// so a partially-filled form sends nothing and previews placeholders.
export function previewVars(formula, values) {
  if (previewMode(formula, values) !== 'runtime') return {};
  const out = {};
  for (const spec of formulaVars(formula)) {
    const val = String((values || {})[spec.key] ?? '').trim();
    if (val) out[spec.key] = val;
  }
  return out;
}

// Client-side constraint check for the two schema fields bd itself does NOT
// enforce. Verified: `bd cook mol-audit --var scope=bogus` (declared
// `enum: ["api","ui","infra"]`) and a `pattern`-violating value both succeed
// and substitute the bad value verbatim. So these are advisory UI validation
// — they gate our own submit button and explain themselves; they are not a
// security boundary and bd will happily accept whatever gets through.
// -> [{ key, message }]
export function varViolations(formula, values) {
  const out = [];
  for (const spec of formulaVars(formula)) {
    const val = String((values || {})[spec.key] ?? '').trim();
    if (!val) continue;
    if (spec.enum && !spec.enum.includes(val)) {
      out.push({ key: spec.key, message: `must be one of: ${spec.enum.join(', ')}` });
      continue;
    }
    if (spec.pattern) {
      let re = null;
      try { re = new RegExp(spec.pattern); } catch { re = null; } // a bad pattern in the formula is not the user's problem
      if (re && !re.test(val)) out.push({ key: spec.key, message: `must match ${spec.pattern}` });
    }
  }
  return out;
}

// The ONE number read out of `bd mol pour --dry-run`'s output.
//
// That output is human text, not a contract — `--json` is silently ignored on
// the dry-run path (confirmed on v1.1.0), and its itemized body is rendered
// VERBATIM rather than parsed, precisely so a bd point release can't silently
// break an implicit schema. This single token ("would pour 5 issues") is
// self-describing enough to label a confirm button, and a miss returns null,
// which the UI falls back from to pourBeadCount(). Nothing else in the block
// is ever interpreted.
export function previewIssueCount(text) {
  const m = /would pour\s+(\d+)\s+issue/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

// Same idea for `bd mol burn --dry-run` ("Issues to delete (5 total):").
export function burnIssueCount(text) {
  const m = /Issues to delete\s*\((\d+)\s+total\)/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// AUTHORING (bd-console-9it) — everything below supports the two ways a
// formula can now be produced from inside the app: distilling an epic, and
// writing one in the editor. Pure, so scripts/smoke.mjs asserts the naming and
// candidate rules in plain Node.
// ---------------------------------------------------------------------------

// Mirrors lib/bd.mjs's FORMULA_NAME_RE. A formula's identity is its FILE
// BASENAME (bd loads it by filename, however the file names itself inside).
export const FORMULA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const FORMULA_EXTS = ['.formula.json', '.formula.toml', '.json', '.toml'];

export function formulaStem(fileName) {
  const raw = String(fileName || '');
  const lower = raw.toLowerCase();
  for (const ext of FORMULA_EXTS) {
    if (lower.endsWith(ext) && lower.length > ext.length) return raw.slice(0, -ext.length);
  }
  return raw;
}

export function formulaFileName(name) {
  const n = String(name || '');
  return FORMULA_EXTS.some((e) => n.toLowerCase().endsWith(e)) ? n : `${n}.formula.json`;
}

// "Release 2.1 hardening" -> "release-2-1-hardening". Always produces a value
// FORMULA_NAME_RE accepts, or '' when there is nothing usable to work with
// (the caller supplies its own placeholder rather than being handed a name the
// server would then reject).
export function slugifyFormulaName(text) {
  const s = String(text || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return FORMULA_NAME_RE.test(s) ? s : '';
}

// A `--var` NAME, which bd substitutes as {{name}} and lib/bd.mjs validates
// with VAR_KEY_RE (/^[A-Za-z0-9_]+$/). Version-ish values get called `version`
// because `v2_1` is a terrible name for the blank that holds the version.
export function slugifyVarName(value) {
  const raw = String(value || '').trim();
  if (/^v?\d+(\.\d+)*$/i.test(raw)) return 'version';
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24).replace(/_+$/g, '');
  if (!s) return 'value';
  return /^[0-9]/.test(s) ? 'v_' + s : s;
}

// Words that are never the interesting part of a title.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it',
  'of', 'on', 'or', 'out', 'the', 'this', 'that', 'to', 'up', 'via', 'with',
  'add', 'fix', 'new', 'run', 'set', 'use', 'all', 'do', 'make', 'get',
]);

/**
 * What to offer the user as "mark this as a blank".
 *
 * `bd mol distill --var name=value` replaces a CONCRETE STRING everywhere it
 * appears, so the values worth offering are exactly the ones that recur across
 * the epic's titles — "2.1" in "Release 2.1" / "Tag version 2.1" / "Announce
 * 2.1" is the blank; "Tag" is not. Anything appearing in only one title is
 * left out: replacing it would produce a formula with a variable that only
 * ever shows up once, which is noise, not a template.
 *
 * -> [{ value, name, count }], best first, at most `limit`.
 */
export function distillCandidates(titles, limit = 6) {
  const list = (titles || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (list.length < 2) return [];
  const counts = new Map();
  for (const title of list) {
    const words = title.split(/[^A-Za-z0-9._-]+/).filter(Boolean);
    const seen = new Set();
    for (let i = 0; i < words.length; i++) {
      for (const n of [1, 2]) {
        if (i + n > words.length) break;
        const parts = words.slice(i, i + n);
        const phrase = parts.join(' ');
        if (phrase.length < 2) continue;
        if (parts.every((w) => STOPWORDS.has(w.toLowerCase()))) continue;
        const key = phrase.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = counts.get(key) || { value: phrase, count: 0 };
        entry.count++;
        counts.set(key, entry);
      }
    }
  }
  return [...counts.values()]
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count || b.value.length - a.value.length || a.value.localeCompare(b.value))
    .slice(0, limit)
    .map((c) => ({ value: c.value, name: slugifyVarName(c.value), count: c.count }));
}

/**
 * The seed for "new formula". Deliberately a WORKING example rather than an
 * empty file or a schema skeleton: three wired steps and one {{variable}},
 * so a beginner's first save validates and their first pour succeeds. Every
 * rule the save gate enforces is already satisfied here — in particular the
 * `formula` field matches the filename, which is the mistake that otherwise
 * produces a formula bd lists but cannot load.
 */
export function newFormulaTemplate(name) {
  const n = FORMULA_NAME_RE.test(String(name || '')) ? String(name) : 'my-formula';
  return JSON.stringify({
    formula: n,
    description: 'One line saying what job this recipe does.',
    version: 1,
    type: 'workflow',
    vars: {
      thing: {
        description: 'What this run is about. Every {{thing}} below is replaced with what you type when you pour it.',
        required: true,
      },
    },
    steps: [
      { id: 'plan', title: 'Plan {{thing}}', type: 'task', priority: 2, description: 'Decide what has to be true before any work starts.' },
      { id: 'build', title: 'Build {{thing}}', type: 'task', priority: 2, needs: ['plan'] },
      { id: 'verify', title: 'Verify {{thing}}', type: 'task', priority: 2, needs: ['build'] },
    ],
  }, null, 2) + '\n';
}

/**
 * The local half of the save gate — the two mistakes that make a formula
 * unloadable, checked before the request so the user is told while they are
 * still typing rather than by a round trip. The SERVER re-checks both (and
 * runs `bd cook`, which is the authority); this is a courtesy, not the rule.
 * -> null when fine, else a message.
 */
export function formulaSaveProblem(fileName, content) {
  const stem = formulaStem(fileName);
  if (!stem || !FORMULA_NAME_RE.test(stem)) return 'The file name must start with a letter or number and contain only letters, numbers, dots, dashes and underscores.';
  const text = String(content || '');
  if (!text.trim()) return 'A formula file cannot be empty.';
  // Only JSON is machine-checkable here; a .toml draft is left entirely to bd.
  if (/\.json$/i.test(fileName)) {
    let doc;
    try { doc = JSON.parse(text); } catch (e) { return 'Not valid JSON yet: ' + e.message; }
    if (!doc || typeof doc !== 'object') return 'A formula must be a JSON object.';
    if (doc.formula !== stem) return `"formula" must be "${stem}" (it is ${doc.formula === undefined ? 'missing' : `"${doc.formula}"`}) — bd loads a formula by its file name.`;
    if (!Array.isArray(doc.steps) || doc.steps.length === 0) return 'A formula needs at least one step.';
  }
  return null;
}
