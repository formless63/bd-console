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
