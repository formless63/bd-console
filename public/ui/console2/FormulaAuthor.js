// console2/FormulaAuthor.js — the two authoring surfaces for formulas
// (bd-console-9it): "Save as reusable template" (bd mol distill) and the
// formula editor.
//
// WHY THIS FILE EXISTS. The pour dialog next door instantiates a formula, but
// nothing in the product could produce one: `bd formula` exposes list, show
// and convert — there is no create — so formulas were hand-written files, and
// a user who opened Molecules was told to use a thing they had no way to make.
// These are the two authoring moments bd actually supports:
//
//   DistillDialog       "I built this epic once already; save its shape."
//   FormulaEditorDialog "Write one from scratch, or fix a broken one."
//
// Both follow the safety shape the rest of Console 2.0 uses: nothing is
// written until the user has seen what will be written. Distill shows bd's own
// dry run first; the editor's save is refused outright by the server unless
// `bd cook` accepts the draft.
import { html } from 'htm/preact';
import { useEffect, useRef } from 'preact/hooks';
import {
  distill, closeDistillDialog, setDistillName, addDistillVar, setDistillVar,
  removeDistillVar, acceptSuggestion, runDistillPreview, saveDistill,
  distillVarProblems, distillNameProblem,
  fed, closeFormulaEditor, backToFormulaList, openFormulaFile, newFormula,
  renameFormulaFile, setFormulaDraft, saveFormula, saveFormulaAndPour,
} from './molecules.js';
import { formulaFileName, formulaSaveProblem, formulaStem } from '../formulas.js';
import { ConceptDot, LearnEmpty } from '../components/ConceptTip.js';

// ---------------------------------------------------------------------------
// A. Save an epic as a reusable template — `bd mol distill`
// ---------------------------------------------------------------------------

// How variable marking is surfaced. `bd mol distill --var name=value` replaces
// a CONCRETE STRING wherever it appears in the epic's titles, so the question
// asked of the user is literally "which words in these titles are the parts
// that change next time?" — not "declare a schema". The suggestions are the
// strings that recur across the epic (distillCandidates in ../formulas.js);
// one click accepts one, and any row can be typed by hand.
//
// Only the `--var name=value` order is ever sent. bd accepts both orders and
// detects which side is concrete, but sending one consistent order means the
// echoed command is always readable the same way.
function VarRow({ row, problem }) {
  return html`
    <div class="fa-varrow">
      <input class="c2-edit-input fa-varname" aria-label="Blank name" placeholder="blank name"
        value=${row.name} onInput=${(e) => setDistillVar(row.key, { name: e.target.value })} />
      <span class="fa-vararrow" aria-hidden="true">←</span>
      <input class=${'c2-edit-input fa-varvalue' + (problem ? ' bad' : '')} aria-label="Text to replace"
        placeholder="the text it replaces" value=${row.value}
        onInput=${(e) => setDistillVar(row.key, { value: e.target.value })} />
      <button class="c2-mini fa-varx" title="Remove this blank" aria-label="Remove this blank"
        onClick=${() => removeDistillVar(row.key)}>✕</button>
      ${problem && html`<span class="fa-varbad">${problem.message}</span>`}
    </div>`;
}

function DistillForm() {
  const rows = distill.vars.value;
  const problems = distillVarProblems();
  const problemFor = (key) => problems.find((p) => p.key === key);
  const suggestions = distill.suggestions.value.filter((s) => !rows.some((r) => r.value === s.value));
  const nameProblem = distillNameProblem();
  const titles = distill.titles.value;

  return html`
    <div class="fa-form">
      <p class="fa-lead">
        This saves the <b>shape</b> of ${distill.epicTitle.value} — its steps and what waits for what — as a
        reusable recipe. Nothing about the original epic changes.
      </p>

      <div class="mol-var">
        <label class="mol-var-k" for="fa-name">name</label>
        <input class=${'c2-edit-input mol-var-input' + (nameProblem ? ' bad' : '')} id="fa-name"
          value=${distill.name.value} onInput=${(e) => setDistillName(e.target.value)} />
        <span class="mol-var-hint">
          Saved as <code>${formulaFileName(String(distill.name.value || 'name').trim() || 'name')}</code>.
          ${nameProblem && html`<span class="mol-var-bad"> ${nameProblem}</span>`}
        </span>
      </div>

      <div class="fa-block">
        <div class="c2-hud-label">Blanks to fill in later</div>
        <p class="fa-note">
          Anything you mark here becomes a blank the recipe asks for each time it's used. Pick the words that
          would be different next time — a version, a customer, a service name.
        </p>
        ${titles.length > 0 && html`
          <div class="fa-titles" data-fa-titles>
            ${titles.slice(0, 8).map((t, n) => html`<div class="fa-title" key=${n}>${t}</div>`)}
            ${titles.length > 8 && html`<div class="fa-title muted">…and ${titles.length - 8} more</div>`}
          </div>`}
        ${suggestions.length > 0 && html`
          <div class="fa-suggest" data-fa-suggest>
            <span class="fa-suggest-lead">Appears more than once:</span>
            ${suggestions.map((s) => html`
              <button class="c2-chip fa-chip" key=${s.value} title=${`Replace “${s.value}” with {{${s.name}}}`}
                onClick=${() => acceptSuggestion(s)}>“${s.value}” → {{${s.name}}}</button>`)}
          </div>`}
        ${rows.length > 0 && html`
          <div class="fa-varlist">
            <div class="fa-varhead"><span>blank</span><span></span><span>replaces this text</span><span></span></div>
            ${rows.map((r) => html`<${VarRow} key=${r.key} row=${r} problem=${problemFor(r.key)} />`)}
          </div>`}
        <button class="c2-mini fa-addvar" onClick=${() => addDistillVar()}>+ mark something else</button>
        ${rows.length === 0 && html`
          <p class="fa-note muted">You can save it with no blanks at all — every step keeps its exact wording.</p>`}
      </div>
    </div>`;
}

function DistillPreview() {
  const dry = distill.preview.value;
  return html`
    <div class="fa-preview">
      ${distill.previewLoading.value && html`<div class="c2-lane-empty">running <code>bd mol distill --dry-run</code>…</div>`}
      ${distill.previewError.value && html`<div class="mol-err">Preview failed: ${distill.previewError.value}</div>`}
      ${dry && html`
        <div class="mol-dry">
          <div class="mol-dry-head">This writes one file: <code>${dry.file}</code>. No issues are created or changed.</div>
          ${/* Rendered VERBATIM. bd ignores --json on every --dry-run path
                (docs/molecules-design.md; re-verified for distill on v1.1.0),
                so this block is human text, not a contract. */ ''}
          <pre class="mol-dry-text" data-fa-dryrun>${dry.preview}</pre>
          <pre class="mol-dry-cmd">$ ${dry.command}</pre>
        </div>`}
      ${distill.conflict.value && html`
        <div class="mol-warn" data-fa-conflict>
          ⚠ <code>${distill.conflict.value.file}</code> already exists. Saving replaces it — the old version is not kept.
        </div>`}
      ${distill.error.value && html`<div class="mol-err" data-fa-error>Save failed: ${distill.error.value}</div>`}
    </div>`;
}

export function DistillDialog() {
  const ref = useRef(null);
  const open = distill.open.value;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { d.showModal(); setTimeout(() => d.querySelector('#fa-name')?.focus(), 30); }
    if (!open && d.open) d.close();
  }, [open]);

  const ready = !distillNameProblem() && distillVarProblems().length === 0;
  const dry = distill.preview.value;
  const conflict = distill.conflict.value;

  return html`
    <dialog class="dialog dialog-lg fa-dialog" ref=${ref} data-fa-distill
      onCancel=${(e) => { e.preventDefault(); closeDistillDialog(); }} onClose=${closeDistillDialog}>
      <div class="dialog-body">
        <div class="dialog-head mol-head">
          <span aria-hidden="true">⚗</span> Save as a reusable template<${ConceptDot} k="formula" />
          <button class="c2-detail-close mol-x" title="Close" onClick=${closeDistillDialog}>✕</button>
        </div>
        <${DistillForm} />
        <${DistillPreview} />
        <div class="dialog-actions mol-actions">
          <button class="c2-mini" onClick=${closeDistillDialog}>Cancel</button>
          <button class="c2-mini" data-fa-preview-btn disabled=${!ready || distill.previewLoading.value}
            title=${ready ? 'Run bd mol distill --dry-run' : 'Fix the highlighted fields first'}
            onClick=${runDistillPreview}>${dry ? 'Re-check' : 'Preview →'}</button>
          <button class=${'c2-mini ' + (conflict ? 'danger' : 'accent')} data-fa-save-btn
            disabled=${!dry || distill.saving.value}
            title=${dry ? 'Write the formula file' : 'Preview it first'}
            onClick=${() => saveDistill({ overwrite: !!conflict })}>
            ${distill.saving.value ? 'Saving…' : conflict ? 'Replace it' : 'Save template'}
          </button>
        </div>
      </div>
    </dialog>`;
}

// ---------------------------------------------------------------------------
// B. The formula editor
// ---------------------------------------------------------------------------

function FilePicker() {
  const files = fed.files.value;
  return html`
    <div class="fa-picker">
      <p class="fa-lead">
        Formulas are plain files in <code>${fed.dir.value}</code>, shared with everyone who has this repo.
      </p>
      ${fed.filesLoading.value && html`<div class="c2-lane-empty">loading…</div>`}
      ${fed.filesError.value && html`<div class="mol-err">${fed.filesError.value}</div>`}
      ${!fed.filesLoading.value && files.length === 0 && html`
        <${LearnEmpty} compact icon="⚗" title="No formula files yet" k="formula"
          what="Nothing has been written into this project's formulas folder."
          why="Start from the example below — it already has three steps wired in order and one blank to fill in, so it saves and pours as-is. Edit it into the job you actually repeat." />`}
      ${files.length > 0 && html`
        <div class="mol-flist">
          ${files.map((f) => html`
            <button class="mol-frow" key=${f.name} onClick=${() => openFormulaFile(f.name)}>
              <span class="mol-frow-glyph" aria-hidden="true">⚗</span>
              <span class="mol-frow-main">
                <span class="mol-frow-name">${f.formula}</span>
                <span class="mol-frow-desc">${f.name}</span>
              </span>
              <span class="mol-frow-meta">edit</span>
            </button>`)}
        </div>`}
      <button class="c2-mini accent fa-new" data-fa-new onClick=${() => newFormula()}>+ New formula</button>
    </div>`;
}

function EditorPane() {
  const ref = useRef(null);
  // Ctrl-S / ⌘-S, exactly as the doc editor binds it.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveFormula(); }
    };
    const el = ref.current;
    el?.addEventListener('keydown', onKey);
    return () => el?.removeEventListener('keydown', onKey);
  });

  const name = fed.name.value;
  const local = formulaSaveProblem(name, fed.draft.value);
  return html`
    <div class="fa-editor">
      <div class="fa-editbar">
        <button class="c2-mini" onClick=${backToFormulaList}>← Files</button>
        <input class="c2-edit-input fa-filename" aria-label="File name" value=${name}
          onInput=${(e) => renameFormulaFile(e.target.value)} />
        ${fed.dirty.value && html`<span class="c2-dirty" title="Unsaved changes">●</span>`}
        <span class="fa-editbar-spacer"></span>
        <span class="fa-editbar-note">loads as <code>${formulaStem(name)}</code></span>
      </div>
      ${fed.loading.value
        ? html`<div class="c2-lane-empty">loading…</div>`
        : fed.loadError.value
          ? html`<div class="mol-err">${fed.loadError.value}</div>`
          : html`<textarea ref=${ref} class="fa-textarea" data-fa-textarea spellcheck="false"
              value=${fed.draft.value} onInput=${(e) => setFormulaDraft(e.target.value)}></textarea>`}
      ${/* Two layers, and the difference is stated plainly in the copy: this
            one is a local courtesy check while you type; the SERVER runs
            `bd cook` against a temp copy and is the one that decides. A
            rejected save writes nothing at all. */ ''}
      ${local && !fed.saveError.value && html`<div class="mol-hint mol-hint-bad" data-fa-local-problem>${local}</div>`}
      ${fed.saveError.value && html`
        <div class="mol-err" data-fa-save-error>
          <b>Not saved.</b> ${fed.saveError.value}
          <div class="fa-note">The file on disk is unchanged — bd checked a copy first, because a formula it can't
          read is skipped silently rather than reported.</div>
        </div>`}
    </div>`;
}

export function FormulaEditorDialog() {
  const ref = useRef(null);
  const open = fed.open.value;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const editing = !!fed.name.value;
  return html`
    <dialog class="dialog dialog-lg fa-dialog fa-editor-dialog" ref=${ref} data-fa-editor
      onCancel=${(e) => { e.preventDefault(); closeFormulaEditor(); }} onClose=${closeFormulaEditor}>
      <div class="dialog-body">
        <div class="dialog-head mol-head">
          <span aria-hidden="true">⚗</span> ${editing ? 'Edit formula' : 'Formulas'}<${ConceptDot} k="formula" />
          <button class="c2-detail-close mol-x" title="Close" onClick=${closeFormulaEditor}>✕</button>
        </div>
        ${editing ? html`<${EditorPane} />` : html`<${FilePicker} />`}
        <div class="dialog-actions mol-actions">
          <button class="c2-mini" onClick=${closeFormulaEditor}>Close</button>
          ${editing && html`
            <button class="c2-mini" data-fa-save disabled=${fed.saving.value} onClick=${saveFormula}>
              ${fed.saving.value ? 'Checking…' : 'Save ⌘S'}
            </button>
            ${/* Plain "&", not the entity: htm renders template text
                  verbatim rather than decoding HTML entities. */ ''}
            <button class="c2-mini accent" data-fa-save-pour disabled=${fed.saving.value} onClick=${saveFormulaAndPour}>
              Save & pour →
            </button>`}
        </div>
      </div>
    </dialog>`;
}
