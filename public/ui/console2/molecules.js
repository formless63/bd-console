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
import { toast, loadIssues, selectIssue, requireToken } from '../store.js';
import { previewMode, previewVars } from '../formulas.js';
import { flashCli } from './state.js';

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
