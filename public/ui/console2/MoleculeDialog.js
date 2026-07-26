// console2/MoleculeDialog.js — the pour flow: browse formulas → fill
// variables with a live preview → see the real `bd mol pour --dry-run` →
// confirm → pour. Opened by the Omnibar's `mol` command.
//
// The three stages ARE the safety rail (docs/molecules-design.md §6):
// confirmation here is structural, not a checkbox. There is no path from
// opening this dialog to beads existing that doesn't route through the
// dry-run block, and the button that performs the write is labelled with the
// bead count bd itself reported.
import { html } from 'htm/preact';
import { useEffect, useRef } from 'preact/hooks';
import {
  mol, closeMolDialog, chooseFormula, backToBrowse, setVar,
  runDryRun, doPour, BIG_POUR_THRESHOLD,
} from './molecules.js';
import {
  formulaVars, formulaSteps, pourBeadCount, missingVars,
  varViolations, previewIssueCount,
} from '../formulas.js';

function FormulaRow({ f }) {
  return html`
    <button class="mol-frow" onClick=${() => chooseFormula(f.name)}>
      <span class="mol-frow-glyph" aria-hidden="true">⚗</span>
      <span class="mol-frow-main">
        <span class="mol-frow-name">${f.name}</span>
        <span class="mol-frow-desc">${f.description || 'No description'}</span>
      </span>
      <span class="mol-frow-meta">${f.type || 'workflow'} · ${f.steps} step${f.steps === 1 ? '' : 's'} · ${f.vars} var${f.vars === 1 ? '' : 's'}</span>
    </button>`;
}

function Browse() {
  const list = mol.formulas.value;
  const q = mol.filter.value.trim().toLowerCase();
  const shown = q
    ? list.filter((f) => (f.name + ' ' + (f.description || '')).toLowerCase().includes(q))
    : list;
  return html`
    <div class="mol-browse">
      <input class="c2-edit-input mol-filter" id="mol-filter" placeholder="Filter formulas…" value=${mol.filter.value}
        onInput=${(e) => (mol.filter.value = e.target.value)} />
      ${mol.formulasLoading.value && html`<div class="c2-lane-empty">loading formulas…</div>`}
      ${mol.formulasError.value && html`<div class="mol-err">Could not list formulas: ${mol.formulasError.value}</div>`}
      ${!mol.formulasLoading.value && !mol.formulasError.value && list.length === 0 && html`
        <div class="c2-lane-empty">
          No formulas registered for this project.
          <div class="mol-hint">Formulas are <code>.formula.json</code> files under <code>.beads/formulas/</code>. Write one, or capture an existing epic with <code>bd mol distill</code>.</div>
        </div>`}
      ${shown.length > 0 && html`<div class="mol-flist">${shown.map((f) => html`<${FormulaRow} key=${f.name} f=${f} />`)}</div>`}
      ${list.length > 0 && shown.length === 0 && html`<div class="c2-lane-empty">No formula matches “${mol.filter.value}”.</div>`}
    </div>`;
}

function VarField({ spec, value, violation }) {
  const common = {
    class: 'c2-edit-input mol-var-input' + (violation ? ' bad' : ''),
    id: 'mol-var-' + spec.key,
    value,
    onInput: (e) => setVar(spec.key, e.target.value),
  };
  return html`
    <div class="mol-var">
      <label class="mol-var-k" for=${'mol-var-' + spec.key}>
        ${spec.key}${!spec.hasDefault ? html`<span class="mol-req" title="Required — bd's runtime mode needs every variable resolved">*</span>` : ''}
      </label>
      ${spec.enum
        ? html`<select ...${common} onChange=${(e) => setVar(spec.key, e.target.value)}>
            <option value="">— choose —</option>
            ${spec.enum.map((o) => html`<option key=${o} value=${o}>${o}</option>`)}
          </select>`
        : html`<input ...${common} placeholder=${spec.hasDefault ? String(spec.default) : ''} />`}
      <span class="mol-var-hint">
        ${spec.description}
        ${spec.hasDefault ? html` <span class="muted">(default: ${String(spec.default)})</span>` : ''}
        ${violation ? html`<span class="mol-var-bad"> ${violation.message}</span>` : ''}
      </span>
    </div>`;
}

function Form() {
  const formula = mol.formula.value;
  if (mol.formulaLoading.value) return html`<div class="c2-lane-empty">loading formula…</div>`;
  if (mol.formulaError.value) return html`<div class="mol-err">${mol.formulaError.value}</div>`;
  if (!formula) return null;

  const specs = formulaVars(formula);
  const values = mol.values.value;
  const missing = missingVars(formula, values);
  const violations = varViolations(formula, values);
  const violationFor = (key) => violations.find((v) => v.key === key);
  const total = pourBeadCount(formula);
  const preview = mol.preview.value;
  const steps = formulaSteps(preview || formula);

  return html`
    <div class="mol-form">
      <div class="mol-desc">${formula.description || 'No description'}</div>

      ${specs.length === 0
        ? html`<div class="c2-lane-empty">This formula declares no variables.</div>`
        : specs.map((spec) => html`<${VarField} key=${spec.key} spec=${spec}
            value=${values[spec.key] ?? ''} violation=${violationFor(spec.key)} />`)}

      <div class="mol-var">
        <label class="mol-var-k" for="mol-assignee">assignee</label>
        <input class="c2-edit-input mol-var-input" id="mol-assignee" placeholder="(optional)"
          value=${mol.assignee.value} onInput=${(e) => (mol.assignee.value = e.target.value)} />
        <span class="mol-var-hint">Passed to <code>bd mol pour --assignee</code>.</span>
      </div>

      <div class="mol-preview">
        <div class="c2-hud-label">
          Preview (live)
          <span class=${'mol-mode m-' + mol.previewMode.value}>${mol.previewMode.value}</span>
          ${mol.previewLoading.value && html`<span class="mol-spin">…</span>`}
        </div>
        ${mol.previewError.value
          ? html`<div class="mol-err">${mol.previewError.value}</div>`
          : html`<div class="mol-steps" data-mol-steps>
              ${steps.map((s) => html`
                <div class="mol-step" key=${s.id}>
                  <span class="mol-step-id">${s.id}</span>
                  <span class="mol-step-title">${s.title}</span>
                  ${(s.needs || []).length > 0 && html`<span class="mol-step-needs">needs: ${(s.needs || []).join(', ')}</span>`}
                </div>`)}
            </div>`}
        <div class="mol-count" data-mol-count>
          ${total} issue${total === 1 ? '' : 's'} will be created (1 molecule root + ${total - 1} step${total - 1 === 1 ? '' : 's'})
        </div>
        ${total > BIG_POUR_THRESHOLD && html`
          <div class="mol-warn">⚠ That's a big spawn — double-check the formula before continuing.</div>`}
      </div>

      ${missing.length > 0 && html`<div class="mol-hint" data-mol-missing>Fill in: <b>${missing.join(', ')}</b> — bd substitutes every variable or none.</div>`}
      ${violations.length > 0 && html`<div class="mol-hint mol-hint-bad">${violations.map((v) => html`<div key=${v.key}>${v.key}: ${v.message}</div>`)}</div>`}
    </div>`;
}

function Confirm() {
  const formula = mol.formula.value;
  const dry = mol.dryRun.value;
  const count = dry ? previewIssueCount(dry.preview) : null;
  const total = count ?? pourBeadCount(formula);

  return html`
    <div class="mol-confirm">
      ${mol.dryRunLoading.value && html`<div class="c2-lane-empty">running <code>bd mol pour --dry-run</code>…</div>`}
      ${mol.dryRunError.value && html`<div class="mol-err">Dry run failed: ${mol.dryRunError.value}</div>`}
      ${dry && html`
        <div class="mol-dry">
          <div class="mol-dry-head" data-mol-confirm-count>This will create <b>${total}</b> issue${total === 1 ? '' : 's'}.</div>
          ${/* Rendered VERBATIM and never parsed: bd ignores --json on the
                dry-run path, so this block is human text, not a contract.
                Showing it as-is keeps the UI honest about what it previewed
                instead of implying a structure the CLI doesn't provide. */ ''}
          <pre class="mol-dry-text" data-mol-dryrun>${dry.preview}</pre>
          ${total > BIG_POUR_THRESHOLD && html`
            <div class="mol-warn">⚠ ${total} beads in one spawn. If that isn't what you meant, go back.</div>`}
          <button class="c2-mini mol-raw-toggle" aria-expanded=${mol.rawOpen.value}
            onClick=${() => (mol.rawOpen.value = !mol.rawOpen.value)}>
            ${mol.rawOpen.value ? '▾' : '▸'} the command this previewed
          </button>
          ${mol.rawOpen.value && html`<pre class="mol-dry-cmd">$ ${dry.command}</pre>`}
        </div>`}

      ${mol.pourError.value && html`
        <div class="mol-err" data-mol-pour-error>
          <div>Pour failed: ${mol.pourError.value}</div>
          ${/* docs/molecules-design.md §8 flagged mid-pour partial failure as
                unverified. The server re-exports and diffs on every failure
                rather than assuming atomicity — this reports what it saw. */ ''}
          ${mol.pourPartial.value && html`<div class="mol-partial">
            ${!mol.pourPartial.value.verified
              ? html`<b>Could not verify what was created</b> — the issue export could not be refreshed. Run <code>bd mol show ${mol.formula.value?.formula}</code> before retrying.`
              : mol.pourPartial.value.created.length === 0
                ? 'Verified: no issues were created.'
                : html`<b>${mol.pourPartial.value.created.length} issue(s) were created before the failure</b> — this pour was partial:
                    <ul>${mol.pourPartial.value.created.map((c) => html`<li key=${c.id}><code>${c.id}</code> ${c.title}</li>`)}</ul>
                    Clean them up with <code>bd mol burn</code> or by hand before retrying.`}
          </div>`}
        </div>`}
    </div>`;
}

export function MoleculeDialog() {
  const ref = useRef(null);
  const open = mol.open.value;
  const stage = mol.stage.value;
  const formula = mol.formula.value;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setTimeout(() => d.querySelector('#mol-filter')?.focus(), 30);
    }
    if (!open && d.open) d.close();
  }, [open]);

  const values = mol.values.value;
  const canPreview = formula
    && missingVars(formula, values).length === 0
    && varViolations(formula, values).length === 0;

  const title = stage === 'browse'
    ? 'Pour a molecule'
    : stage === 'form' ? `Pour: ${formula?.formula || ''}` : `Pour: ${formula?.formula || ''} — confirm`;

  return html`
    <dialog class="dialog dialog-lg mol-dialog" ref=${ref} onCancel=${(e) => { e.preventDefault(); closeMolDialog(); }} onClose=${closeMolDialog}>
      <div class="dialog-body">
        <div class="dialog-head mol-head">
          <span aria-hidden="true">⚗</span> ${title}
          <button class="c2-detail-close mol-x" title="Close" onClick=${closeMolDialog}>✕</button>
        </div>

        ${stage === 'browse' && html`<${Browse} />`}
        ${stage === 'form' && html`<${Form} />`}
        ${stage === 'confirm' && html`<${Confirm} />`}

        <div class="dialog-actions mol-actions">
          ${stage === 'browse' && html`<button class="c2-mini" onClick=${closeMolDialog}>Cancel</button>`}
          ${stage === 'form' && html`
            <button class="c2-mini" onClick=${backToBrowse}>← Formulas</button>
            <button class="c2-mini accent" data-mol-preview-btn disabled=${!canPreview} onClick=${runDryRun}
              title=${canPreview ? 'Run bd mol pour --dry-run' : 'Fill every variable first'}>Preview spawn →</button>`}
          ${stage === 'confirm' && html`
            <button class="c2-mini" disabled=${mol.pouring.value} onClick=${() => (mol.stage.value = 'form')}>← Back</button>
            <button class="c2-mini danger" data-mol-pour-btn
              disabled=${mol.pouring.value || !mol.dryRun.value}
              onClick=${doPour}>
              ${mol.pouring.value ? 'Pouring…' : `Pour ${previewIssueCount(mol.dryRun.value?.preview) ?? pourBeadCount(formula)} issues`}
            </button>`}
        </div>
      </div>
    </dialog>`;
}
