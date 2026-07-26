// console2/molecules.js — state + actions for formulas and molecules
// (docs/molecules-design.md v1: browse → variable preview → dry-run confirm →
// pour → burn-as-undo).
//
// Split the way the rest of Console 2.0 splits: every derivation that can be
// pure lives in ../formulas.js and ../relationships.js (import-free, asserted
// by scripts/smoke.mjs in plain Node); this module owns only the signals and
// the fetches.
import { signal } from '@preact/signals';
import { apiGet, apiPost, AuthError } from '../api.js';
import { byId, childrenOf, toast, loadIssues, selectIssue, requireToken } from '../store.js';
import {
  previewMode, previewVars,
  FORMULA_NAME_RE, formulaFileName, formulaStem, slugifyFormulaName,
  distillCandidates, newFormulaTemplate, formulaSaveProblem,
} from '../formulas.js';
import { flashCli } from './state.js';
import { learn } from '../learn.js';

// A spawn creating this many beads at once earns an extra "are you sure" line
// in the confirm step. Client-side heuristic only — bd imposes no limit.
export const BIG_POUR_THRESHOLD = 25;

// --- pour dialog ------------------------------------------------------------
export const mol = {
  open: signal(false),
  // 'browse'  — pick a formula
  // 'form'    — fill variables, live `bd cook` preview
  // 'confirm' — the `bd mol pour --dry-run` block, then the real pour
  stage: signal('browse'),

  formulas: signal([]),
  formulasLoading: signal(false),
  formulasError: signal(null),
  filter: signal(''),

  formula: signal(null),        // `bd formula show` document
  formulaLoading: signal(false),
  formulaError: signal(null),

  values: signal({}),           // { varKey: string }
  assignee: signal(''),

  preview: signal(null),        // `bd cook --json` document
  previewMode: signal('compile'),
  previewLoading: signal(false),
  previewError: signal(null),

  dryRun: signal(null),         // { preview: <opaque text>, command }
  dryRunLoading: signal(false),
  dryRunError: signal(null),
  rawOpen: signal(false),       // "Raw bd output" disclosure

  pouring: signal(false),
  pourError: signal(null),
  pourPartial: signal(null),    // { verified, created: [{id,title}] } on failure
};

export function openMolDialog(prefill = '') {
  mol.open.value = true;
  mol.stage.value = 'browse';
  mol.filter.value = '';
  mol.formula.value = null;
  mol.formulaError.value = null;
  mol.values.value = {};
  mol.assignee.value = '';
  mol.preview.value = null;
  mol.previewError.value = null;
  mol.dryRun.value = null;
  mol.dryRunError.value = null;
  mol.rawOpen.value = false;
  mol.pourError.value = null;
  mol.pourPartial.value = null;
  loadFormulas().then(() => {
    // `> mol <name>` jumps straight into that formula's form when it resolves.
    if (prefill && mol.formulas.value.some((f) => f.name === prefill)) chooseFormula(prefill);
    else if (prefill) mol.filter.value = prefill;
  });
}

export function closeMolDialog() {
  mol.open.value = false;
  clearPreviewTimer();
}

export async function loadFormulas() {
  mol.formulasLoading.value = true;
  mol.formulasError.value = null;
  try {
    const data = await apiGet('/api/formulas');
    mol.formulas.value = data.formulas || [];
  } catch (e) {
    mol.formulas.value = [];
    mol.formulasError.value = e.message;
  } finally {
    mol.formulasLoading.value = false;
  }
}

export async function chooseFormula(name) {
  mol.stage.value = 'form';
  mol.formulaLoading.value = true;
  mol.formulaError.value = null;
  mol.formula.value = null;
  mol.values.value = {};
  mol.preview.value = null;
  mol.previewError.value = null;
  try {
    const data = await apiGet('/api/formulas/' + encodeURIComponent(name));
    mol.formula.value = data.formula || null;
    refreshPreview();
  } catch (e) {
    mol.formulaError.value = e.message;
  } finally {
    mol.formulaLoading.value = false;
  }
}

export function backToBrowse() {
  mol.stage.value = 'browse';
  mol.dryRun.value = null;
  mol.dryRunError.value = null;
}

export function setVar(key, value) {
  mol.values.value = { ...mol.values.value, [key]: value };
  schedulePreview();
}

// Live preview is debounced on the same ~300ms beat as every other
// as-you-type control in this app; each keystroke re-issues `bd cook`, which
// is the one call here whose --json is reliable on every path.
let previewTimer = null;
let previewSeq = 0;
function clearPreviewTimer() { if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; } }
function schedulePreview() {
  clearPreviewTimer();
  previewTimer = setTimeout(() => { previewTimer = null; refreshPreview(); }, 300);
}

export async function refreshPreview() {
  const formula = mol.formula.value;
  if (!formula) return;
  const name = formula.formula;
  const values = mol.values.value;
  const mode = previewMode(formula, values);
  const vars = previewVars(formula, values);
  const seq = ++previewSeq;

  mol.previewLoading.value = true;
  mol.previewError.value = null;
  const qs = Object.entries(vars).map(([k, v]) => `var.${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  try {
    const data = await apiGet('/api/formulas/' + encodeURIComponent(name) + '/preview' + (qs ? '?' + qs : ''));
    if (seq !== previewSeq) return; // a newer keystroke already won
    mol.preview.value = data.preview || null;
    mol.previewMode.value = data.mode || mode;
  } catch (e) {
    if (seq !== previewSeq) return;
    mol.previewError.value = e.message;
  } finally {
    if (seq === previewSeq) mol.previewLoading.value = false;
  }
}

// Step 2 of the mandatory two-step confirmation: the real `bd mol pour
// --dry-run`. Its output is opaque preview TEXT (bd ignores --json here), so
// it is stored and rendered verbatim.
export async function runDryRun() {
  const formula = mol.formula.value;
  if (!formula) return;
  mol.stage.value = 'confirm';
  mol.dryRunLoading.value = true;
  mol.dryRunError.value = null;
  mol.dryRun.value = null;
  mol.pourError.value = null;
  mol.pourPartial.value = null;
  const vars = filledVars();
  const qs = ['proto=' + encodeURIComponent(formula.formula)]
    .concat(Object.entries(vars).map(([k, v]) => `var.${encodeURIComponent(k)}=${encodeURIComponent(v)}`))
    .join('&');
  try {
    const data = await apiGet('/api/molecules/pour-preview?' + qs);
    mol.dryRun.value = { preview: data.preview || '', command: data.command || '' };
  } catch (e) {
    mol.dryRunError.value = e.message;
  } finally {
    mol.dryRunLoading.value = false;
  }
}

function filledVars() {
  const out = {};
  for (const [k, v] of Object.entries(mol.values.value)) {
    const s = String(v ?? '').trim();
    if (s) out[k] = s;
  }
  return out;
}

// THE write. Only reachable from the confirm stage, which only exists after a
// dry-run rendered — there is deliberately no path from "open the dialog" to
// "beads created" that skips the preview.
export async function doPour() {
  const formula = mol.formula.value;
  if (!formula || mol.pouring.value) return;
  mol.pouring.value = true;
  mol.pourError.value = null;
  mol.pourPartial.value = null;
  const assignee = mol.assignee.value.trim();
  try {
    const data = await apiPost('/api/molecules/pour', {
      proto: formula.formula,
      vars: filledVars(),
      ...(assignee ? { assignee } : {}),
    });
    flashCli(data.command || `bd mol pour ${formula.formula}`, 'pour');
    // They've poured. The "you have never used these recipes" nudge is done,
    // and the dialog's "what is a molecule?" explainer can rest collapsed —
    // whatever it had to teach has now been demonstrated for real.
    learn.recordAction('pour');
    learn.setFlag('mol-intro-done', true);
    await loadIssues();
    // Land on the thing that was just created, not a list to re-find it in.
    if (data.new_epic_id) await selectIssue(data.new_epic_id);
    closeMolDialog();
    if (data.warning) toast(data.warning, 'warn', 6000);
    // A success exit that nonetheless left beads unaccounted for is reported,
    // never swallowed — see lib/bd.mjs's pourMolecule() on partial failure.
    if (data.missing && data.missing.length) {
      toast(`Poured ${data.new_epic_id}, but ${data.missing.length} bead(s) did not appear in the export — check with \`bd mol show ${data.new_epic_id}\``, 'err', 9000);
    } else {
      toast(`✓ Poured ${data.new_epic_id} · ${formula.formula} (${data.created} issues)`);
    }
    return data;
  } catch (e) {
    if (e instanceof AuthError) { requireToken('A write token is required to pour a molecule.'); closeMolDialog(); return; }
    mol.pourError.value = e.message;
    // The server's partial-failure report rides on the error payload (see
    // api.js's parse) — a pour that half-succeeded says so instead of being
    // reported as "failed, nothing happened."
    mol.pourPartial.value = e.payload?.partial || null;
    await loadIssues(); // whatever landed should be visible either way
  } finally {
    mol.pouring.value = false;
  }
}

// ---------------------------------------------------------------------------
// AUTHORING (bd-console-9it) — the two ways to PRODUCE a formula.
//
// Until this section the pour flow above had a prerequisite the product could
// not create: `bd formula` has list/show/convert and no create, so a project
// with no formulas showed a dialog pointing at a capability the user could not
// reach. The two paths below are the real ones bd supports, and they answer
// different moments:
//
//   distill — "I already built this once by hand, save it as a template"
//   editor  — "write one from scratch, or fix the one that's broken"
// ---------------------------------------------------------------------------

// --- A. distill: epic -> formula --------------------------------------------
export const distill = {
  open: signal(false),
  epicId: signal(null),
  epicTitle: signal(''),
  name: signal(''),
  // [{ key, name, value }] — each row is one `--var name=value`, i.e. "replace
  // this concrete text with this blank". `key` is a stable local row id only.
  vars: signal([]),
  suggestions: signal([]),   // candidate rows the user can accept with a click
  titles: signal([]),        // the epic's own title + its children's

  preview: signal(null),     // { preview: <opaque text>, command }
  previewLoading: signal(false),
  previewError: signal(null),

  saving: signal(false),
  error: signal(null),
  conflict: signal(null),    // an existing formula of the same name, awaiting "replace it"
};

let varRowSeq = 0;

export function openDistillDialog(issue) {
  if (!issue) return;
  const children = childrenOf(issue.id);
  const titles = [issue.title, ...children.map((c) => c.title)].filter(Boolean);
  distill.open.value = true;
  distill.epicId.value = issue.id;
  distill.epicTitle.value = issue.title || issue.id;
  distill.name.value = slugifyFormulaName(issue.title) || 'my-formula';
  distill.titles.value = titles;
  distill.suggestions.value = distillCandidates(titles);
  distill.vars.value = [];
  distill.preview.value = null;
  distill.previewError.value = null;
  distill.error.value = null;
  distill.conflict.value = null;
}

/** `> template <id>` and the palette both route through here. */
export function openDistillFor(id) {
  const issue = byId.value.get(String(id || '').trim());
  if (!issue) { toast(`No issue called ${id} in this project`, 'err'); return; }
  if (childrenOf(issue.id).length === 0) {
    toast(`${issue.id} has no children yet — a template is made from the shape of an epic`, 'err', 5000);
    return;
  }
  openDistillDialog(issue);
}

export function closeDistillDialog() { distill.open.value = false; }

export function addDistillVar(name = '', value = '') {
  distill.vars.value = [...distill.vars.value, { key: 'v' + (++varRowSeq), name, value }];
  invalidateDistillPreview();
}
export function setDistillVar(key, patch) {
  distill.vars.value = distill.vars.value.map((v) => (v.key === key ? { ...v, ...patch } : v));
  invalidateDistillPreview();
}
export function removeDistillVar(key) {
  distill.vars.value = distill.vars.value.filter((v) => v.key !== key);
  invalidateDistillPreview();
}
export function acceptSuggestion(s) {
  if (distill.vars.value.some((v) => v.value === s.value)) return;
  addDistillVar(s.name, s.value);
}

// Any edit invalidates the dry run: the confirm button must never be enabled
// against a preview of different inputs. Same rule the pour flow enforces.
function invalidateDistillPreview() {
  distill.preview.value = null;
  distill.previewError.value = null;
  distill.conflict.value = null;
}
export function setDistillName(name) {
  distill.name.value = name;
  invalidateDistillPreview();
}

function distillVarMap() {
  const out = {};
  for (const row of distill.vars.value) {
    const name = String(row.name || '').trim();
    const value = String(row.value || '').trim();
    if (name && value) out[name] = value;
  }
  return out;
}

/** Rows that are half-filled or misnamed — surfaced, never silently dropped. */
export function distillVarProblems() {
  const out = [];
  const seen = new Set();
  for (const row of distill.vars.value) {
    const name = String(row.name || '').trim();
    const value = String(row.value || '').trim();
    if (!name && !value) continue;
    if (!name || !value) { out.push({ key: row.key, message: 'needs both a blank name and the text it replaces' }); continue; }
    if (!/^[A-Za-z0-9_]+$/.test(name)) { out.push({ key: row.key, message: 'blank names can only use letters, numbers and _' }); continue; }
    if (seen.has(name)) { out.push({ key: row.key, message: `there is already a blank called ${name}` }); continue; }
    seen.add(name);
  }
  return out;
}

export function distillNameProblem() {
  const n = String(distill.name.value || '').trim();
  if (!n) return 'Give the template a name.';
  if (!FORMULA_NAME_RE.test(n)) return 'Use letters, numbers, dots, dashes and underscores — no slashes.';
  return null;
}

// The dry run. Opaque TEXT: `bd mol distill --dry-run` ignores --json exactly
// the way `mol pour --dry-run` does (docs/molecules-design.md; re-verified on
// v1.1.0), so it is rendered verbatim and never parsed.
export async function runDistillPreview() {
  const epic = distill.epicId.value;
  const name = String(distill.name.value || '').trim();
  if (!epic || distillNameProblem() || distillVarProblems().length) return;
  distill.previewLoading.value = true;
  distill.previewError.value = null;
  distill.preview.value = null;
  const qs = ['epic=' + encodeURIComponent(epic), 'name=' + encodeURIComponent(name)]
    .concat(Object.entries(distillVarMap()).map(([k, v]) => `var.${encodeURIComponent(k)}=${encodeURIComponent(v)}`))
    .join('&');
  try {
    const data = await apiGet('/api/formula-distill-preview?' + qs);
    distill.preview.value = { preview: data.preview || '', command: data.command || '', file: data.file || formulaFileName(name) };
  } catch (e) {
    distill.previewError.value = e.message;
  } finally {
    distill.previewLoading.value = false;
  }
}

// THE write — one file, no beads. Only reachable once a dry run has rendered.
export async function saveDistill({ overwrite = false } = {}) {
  const epic = distill.epicId.value;
  const name = String(distill.name.value || '').trim();
  if (!epic || distill.saving.value) return;
  distill.saving.value = true;
  distill.error.value = null;
  try {
    const data = await apiPost('/api/formula-distill', { epic, name, vars: distillVarMap(), overwrite });
    flashCli(data.command || `bd mol distill ${epic} ${name}`, 'distill');
    await loadFormulas();
    closeDistillDialog();
    toast(`✓ Saved ${data.formula} — ${data.steps} step${data.steps === 1 ? '' : 's'}, ready to pour`, 'ok', 5000);
    return data;
  } catch (e) {
    if (e instanceof AuthError) { requireToken('A write token is required to save a template.'); closeDistillDialog(); return; }
    // 409 is not a failure, it's a question: distill OVERWRITES silently, so
    // the user gets told what they are about to replace before it happens.
    if (e.status === 409) { distill.conflict.value = { file: e.payload?.file || formulaFileName(name) }; return; }
    distill.error.value = e.message;
  } finally {
    distill.saving.value = false;
  }
}

// --- B. the formula editor ---------------------------------------------------
// Same shape as the doc editor (console2/Docs2.js + POST /api/doc): a file
// list, a textarea, a dirty dot, Ctrl-S. The one difference that matters is
// that a save can be REFUSED — the server runs `bd cook` against a copy first,
// because a malformed formula file is silently skipped by `bd formula list`
// rather than reported, so writing one would make the recipe simply vanish.
export const fed = {
  open: signal(false),
  dir: signal('.beads/formulas'),
  files: signal([]),          // [{ name, formula, size, mtime }]
  filesLoading: signal(false),
  filesError: signal(null),

  name: signal(''),           // file basename being edited ('' = picker)
  draft: signal(''),
  dirty: signal(false),
  isNew: signal(false),
  loading: signal(false),
  loadError: signal(null),

  saving: signal(false),
  saveError: signal(null),
};

export async function loadFormulaFiles() {
  fed.filesLoading.value = true;
  fed.filesError.value = null;
  try {
    const data = await apiGet('/api/formula-files');
    fed.dir.value = data.dir || '.beads/formulas';
    fed.files.value = data.files || [];
  } catch (e) {
    fed.files.value = [];
    fed.filesError.value = e.message;
  } finally {
    fed.filesLoading.value = false;
  }
}

export function openFormulaEditor(name = '', { fresh = false } = {}) {
  fed.open.value = true;
  fed.saveError.value = null;
  fed.loadError.value = null;
  if (!name && !fresh) {
    fed.name.value = '';
    fed.draft.value = '';
    fed.dirty.value = false;
    fed.isNew.value = false;
  }
  loadFormulaFiles().then(() => {
    if (fresh) { newFormula(); return; }
    if (!name) return;
    // Accept either a file basename or a formula name — the palette argument
    // is whatever the user typed.
    const target = fed.files.value.find((f) => f.name === name || f.formula === name || f.formula === formulaStem(name));
    if (target) openFormulaFile(target.name);
    else newFormula(slugifyFormulaName(formulaStem(name)));
  });
}

export function closeFormulaEditor() {
  fed.open.value = false;
}

export function backToFormulaList() {
  fed.name.value = '';
  fed.draft.value = '';
  fed.dirty.value = false;
  fed.isNew.value = false;
  fed.saveError.value = null;
  fed.loadError.value = null;
}

export async function openFormulaFile(name) {
  fed.name.value = name;
  fed.isNew.value = false;
  fed.dirty.value = false;
  fed.saveError.value = null;
  fed.loadError.value = null;
  fed.loading.value = true;
  fed.draft.value = '';
  try {
    const data = await apiGet('/api/formula-file?name=' + encodeURIComponent(name));
    if (fed.name.value !== name) return;
    fed.draft.value = data.content || '';
  } catch (e) {
    if (fed.name.value !== name) return;
    fed.loadError.value = e.message;
  } finally {
    if (fed.name.value === name) fed.loading.value = false;
  }
}

// "New formula" seeds a WORKING example — three wired steps and one blank —
// rather than an empty file. A beginner's first save then validates and their
// first pour succeeds, which is the whole point of the seed.
export function newFormula(suggested = '') {
  const base = suggested || uniqueFormulaName('my-formula');
  fed.name.value = formulaFileName(base);
  fed.draft.value = newFormulaTemplate(base);
  fed.isNew.value = true;
  fed.dirty.value = true;
  fed.loadError.value = null;
  fed.saveError.value = null;
  fed.loading.value = false;
}

function uniqueFormulaName(base) {
  const taken = new Set(fed.files.value.map((f) => f.formula));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now()}`;
}

/** Renaming the file also renames the formula — they are the same identity. */
export function renameFormulaFile(nextName) {
  fed.name.value = nextName;
  fed.dirty.value = true;
}

export function setFormulaDraft(text) {
  fed.draft.value = text;
  fed.dirty.value = true;
  fed.saveError.value = null;
}

export async function saveFormula() {
  const name = String(fed.name.value || '').trim();
  if (!name || fed.saving.value) return;
  const local = formulaSaveProblem(name, fed.draft.value);
  if (local) { fed.saveError.value = local; return; }
  fed.saving.value = true;
  fed.saveError.value = null;
  try {
    const data = await apiPost('/api/formula-file', { name, content: fed.draft.value });
    flashCli(`bd-console formula save ${name}`, 'formula');
    fed.dirty.value = false;
    fed.isNew.value = false;
    await Promise.all([loadFormulaFiles(), loadFormulas()]);
    toast(`✓ Saved ${data.formula} — ${data.steps} step${data.steps === 1 ? '' : 's'}`);
    return data;
  } catch (e) {
    if (e instanceof AuthError) { requireToken('A write token is required to save a formula.'); return; }
    // bd's own words. The server validated against a copy in a temp dir, so
    // NOTHING was written — the file on disk is still whatever it was.
    fed.saveError.value = e.message;
  } finally {
    fed.saving.value = false;
  }
}

/** Save, then hand straight over to the pour flow for the thing just written. */
export async function saveFormulaAndPour() {
  const data = await saveFormula();
  if (!data) return;
  closeFormulaEditor();
  openMolDialog(data.formula);
}

// --- molecule detail (Detail slide-over) ------------------------------------
export const molDetail = {
  id: signal(null),
  data: signal(null),          // { molecule, progress, parallel }
  loading: signal(false),
  error: signal(null),

  burnPreview: signal(null),   // { preview, command } — opaque text
  burnLoading: signal(false),
  burnError: signal(null),
  burning: signal(false),
};

// Live-only: a molecule's parallel-group/ready semantics are an authoritative
// server-side computation with no client-side equivalent. Failure is NOT an
// error state — Detail already renders the parent-child step list from the
// loaded issues list, so this degrades to "it's a molecule, here are its
// children" rather than blanking the panel.
export async function loadMoleculeDetail(id, { force = false } = {}) {
  if (!id) { molDetail.id.value = null; molDetail.data.value = null; return; }
  if (!force && molDetail.id.value === id && molDetail.data.value) return;
  const sameMolecule = molDetail.id.value === id;
  molDetail.id.value = id;
  // A forced refresh of the SAME molecule keeps the previous data on screen
  // while the new copy is in flight — blanking it would make every write in
  // the app flicker the step list.
  if (!sameMolecule) molDetail.data.value = null;
  molDetail.error.value = null;
  molDetail.loading.value = true;
  if (!sameMolecule) {
    molDetail.burnPreview.value = null;
    molDetail.burnError.value = null;
  }
  try {
    const data = await apiGet('/api/molecules/' + encodeURIComponent(id) + '?parallel=1');
    if (molDetail.id.value !== id) return;
    molDetail.data.value = data;
  } catch (e) {
    if (molDetail.id.value !== id) return;
    molDetail.error.value = e.message;
  } finally {
    if (molDetail.id.value === id) molDetail.loading.value = false;
  }
}

export async function requestBurnPreview(id) {
  molDetail.burnLoading.value = true;
  molDetail.burnError.value = null;
  molDetail.burnPreview.value = null;
  try {
    const data = await apiGet('/api/molecules/burn-preview?id=' + encodeURIComponent(id));
    molDetail.burnPreview.value = { preview: data.preview || '', command: data.command || '' };
  } catch (e) {
    molDetail.burnError.value = e.message;
  } finally {
    molDetail.burnLoading.value = false;
  }
}

export function cancelBurn() {
  molDetail.burnPreview.value = null;
  molDetail.burnError.value = null;
}

export async function confirmBurn(id) {
  if (molDetail.burning.value) return;
  molDetail.burning.value = true;
  molDetail.burnError.value = null;
  try {
    const data = await apiPost('/api/molecules/burn', { id });
    flashCli(data.command || `bd mol burn ${id} --force`, 'burn');
    molDetail.burnPreview.value = null;
    molDetail.id.value = null;
    molDetail.data.value = null;
    await loadIssues();
    await selectIssue(null);
    const orphans = data.orphaned_issues || [];
    toast(
      `Burned ${id} — ${data.deleted_count} issue(s) deleted`
      + (orphans.length ? `; ${orphans.length} outside issue(s) lost a dependency on it` : ''),
      orphans.length ? 'warn' : 'ok',
      orphans.length ? 8000 : 4000,
    );
    return data;
  } catch (e) {
    if (e instanceof AuthError) { requireToken('A write token is required to burn a molecule.'); return; }
    molDetail.burnError.value = e.message;
  } finally {
    molDetail.burning.value = false;
  }
}
