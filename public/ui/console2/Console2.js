// console2/Console2.js — root of the Console 2.0 "mission control" view.
// Owns bootstrapping (loads issues/docs/tmux for the routed project), the header
// strip with the omnibar + CLI teaching flash, the Pulse rail, the segmented
// Canvas (Flow / Map / Docs) and the Detail slide-over.
import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { effect } from '@preact/signals';
import {
  store, navigate, loadProjectMeta, loadIssues, loadDocs, loadTmux, selectIssue,
} from '../store.js';

// app.js's syncRoute() only manages store.projectId for the classic #/p/<id>
// route; on our #/p2/<id> route it resets projectId to null (its "not a
// project" branch). This synchronous signals effect re-pins projectId whenever
// the console2 route is active, so api.js's project-prefixing stays correct
// without touching app.js. Runs synchronously on any conflicting write, so the
// null is never observable to an in-flight fetch.
effect(() => {
  const r = store.route.value;
  if (r.view === 'console2' && r.projectId && store.projectId.value !== r.projectId) {
    store.projectId.value = r.projectId;
  }
});
import { c2, loadEpicGroupPref } from './state.js';
import { Omnibar } from './Omnibar.js';
import { PulseBar } from './Pulse.js';
import { Flow } from './Flow.js';
import { MapView } from './MapView.js';
import { Docs2 } from './Docs2.js';
import { Detail } from './Detail.js';
import { MoleculeDialog } from './MoleculeDialog.js';
import { DistillDialog, FormulaEditorDialog } from './FormulaAuthor.js';
import { mol, openMolDialog, loadFormulas } from './molecules.js';
import { ThemeSwitch } from './ThemeSwitch.js';
import { NudgeRail } from '../components/ConceptTip.js';
import { learnContext } from '../learn.js';

const MODES = [['flow', 'Flow'], ['map', 'Map'], ['docs', 'Docs']];

function CliFlash() {
  const cli = c2.lastCli.value;
  if (!cli) return null;
  const copy = () => { navigator.clipboard?.writeText(cli.cmd).catch(() => {}); };
  // "✓ ran" reads this as a receipt of something that already happened, not
  // a command being suggested to the user — every action flashes through
  // here (capture, claim, close, defer, …), so the fix is universal.
  return html`
    <div class="c2-cli" key=${cli.at}>
      <span class="c2-cli-ran" aria-hidden="true">✓ ran</span>
      <span class="c2-cli-dollar">$</span>
      <code class="c2-cli-cmd">${cli.cmd}</code>
      <button class="c2-cli-copy" title="Copy" onClick=${copy}>copy</button>
      <button class="c2-cli-x" title="Dismiss" onClick=${() => (c2.lastCli.value = null)}>✕</button>
    </div>`;
}

function Header() {
  const meta = store.meta.value;
  const pid = store.projectId.value;
  const molCount = mol.formulas.value.length;
  const exp = meta?.export;
  const syncState = !exp ? 'unknown' : exp.error ? 'error' : (!exp.exists || exp.stale) ? 'stale' : 'synced';
  return html`
    <header class="c2-header">
      <div class="c2-header-top">
        <a class="c2-hublink" href="#/" title="Back to hub · all projects" aria-label="Back to hub">
          <span class="c2-icon" aria-hidden="true">⌂</span>
        </a>
        <div class="c2-brand">
          <span class="c2-brand-mark">◆</span>
          <div class="c2-brand-txt">
            <span class="c2-brand-name">${meta?.name || pid || 'project'}</span>
            <span class="c2-brand-sub">CONSOLE 2.0 · MISSION CONTROL</span>
          </div>
        </div>
        <${Omnibar} />
        <div class="c2-header-right">
          <button class="c2-new" title="New issue — full form (bug, feature, epic…)  ·  i"
            onClick=${() => (store.createOpen.value = true)}>
            <span aria-hidden="true">+</span><span class="c2-btn-label"> New</span>
          </button>
          ${/* Molecules had exactly one entry point — typing `> mol` into the
                omnibar — which is invisible to anyone who hasn't read the
                docs, i.e. precisely the audience this feature is hardest for.
                A real button, always present, labelled with the formula count
                when there is one, so the machinery is discoverable without
                being loud. */ ''}
          <button class="c2-molbtn" data-mol-open
            title=${molCount ? `Pour a molecule — ${molCount} formula${molCount === 1 ? '' : 's'} available in this project` : 'Molecules — create a whole set of connected issues from a saved recipe'}
            onClick=${() => openMolDialog('')}>
            <span aria-hidden="true">⚗</span><span class="c2-btn-label"> Molecules</span>
            ${molCount > 0 && html`<span class="c2-molbtn-n">${molCount}</span>`}
          </button>
          <a class="c2-learnlink" href="#/learn" title="Concepts — what beads words mean" aria-label="Concepts reference">?</a>
          <div class="c2-themesw-header"><${ThemeSwitch} /></div>
          <span class=${'c2-sync sync-' + syncState} title=${'Issue export: ' + syncState}>${syncState}</span>
          <a class="c2-classic" href=${'#/p/' + encodeURIComponent(pid || '')} title="Open the classic project view">
            <span class="c2-btn-label">classic view </span><span class="c2-icon" aria-hidden="true">→</span>
          </a>
        </div>
      </div>
      <div class="c2-header-echo"><${CliFlash} /></div>
    </header>`;
}

function Canvas() {
  const mode = c2.canvasMode.value;
  return html`
    <div class="c2-canvas">
      <div class="c2-segmented">
        ${MODES.map(([m, label]) => html`
          <button key=${m} class=${'c2-seg' + (mode === m ? ' on' : '')} onClick=${() => (c2.canvasMode.value = m)}>${label}</button>`)}
      </div>
      <div class="c2-canvas-body">
        ${mode === 'flow' ? html`<${Flow} />` : mode === 'map' ? html`<${MapView} />` : html`<${Docs2} />`}
      </div>
    </div>`;
}

// The one place in the app a nudge can appear: a single strip between the
// pulse rail and the canvas. Never overlays anything, never steals focus,
// never more than one — see public/ui/learn.js for why.
// NOTE the always-present wrapper element: .c2 is a grid with explicit
// `grid-template-rows: auto auto auto minmax(0,1fr)` (header / pulse / nudge /
// body), and auto-placement assigns rows by child ORDER. If this component
// returned null when there's no nudge — the overwhelmingly common case —
// .c2-body would slide up into the auto nudge row and lose its 1fr height.
// The slot is empty and zero-height when idle; only the row must be stable.
function Nudges() {
  const issues = store.issues.value;
  const ready = c2.ready.value;
  const formulas = mol.formulas.value.length;
  // Only evaluate once the project has actually finished loading: an empty
  // list mid-bootstrap is not evidence of anything, and evaluating against it
  // would silently retire hints the user never had a chance to see.
  if (!ready) return html`<div class="c2-nudgeslot"></div>`;
  const ctx = learnContext(issues, { formulas });

  const onAction = (hint) => {
    switch (hint.action) {
      case 'learn-links': navigate('#/learn/blocks'); break;
      case 'new-epic': store.createOpen.value = true; break;
      case 'open-molecules': openMolDialog(''); break;
      case 'focus-stale': c2.canvasMode.value = 'flow'; c2.laneFocus.value = 'stale'; break;
      default: break;
    }
  };
  return html`<div class="c2-nudgeslot"><${NudgeRail} ctx=${ctx} onAction=${onAction} /></div>`;
}

export function Console2() {
  const route = store.route.value;
  const pid = route.projectId;

  // Bootstrap: this route isn't handled by app.js syncRoute (which only loads
  // for #/p/<id>), so Console 2.0 owns loading its own project data.
  useEffect(() => {
    if (!pid) return;
    store.projectId.value = pid;
    store.issues.value = [];
    store.selectedId.value = null;
    store.selectedDocPath.value = null;
    store.docContent.value = null;
    c2.ready.value = false;
    c2.bootError.value = null;
    c2.laneFocus.value = null;
    c2.epicGroup.value = loadEpicGroupPref(pid);
    // Cancellation guard: navigating away (or to another project) mid-bootstrap
    // must not let a stale pid's follow-on loads fire or flip ready.
    let cancelled = false;
    (async () => {
      await loadProjectMeta();
      if (cancelled) return;
      // loadFormulas rides along with the bootstrap (rather than waiting for
      // the pour dialog to be opened) for two reasons: the Molecules button
      // can show a count, and the "this project has recipes you've never
      // used" nudge can't be evaluated without knowing there are any. It
      // never throws — molecules.js swallows into mol.formulasError.
      await Promise.all([loadIssues(), loadDocs(), loadTmux(), loadFormulas()]);
      if (!cancelled) c2.ready.value = true;
    })();
    return () => { cancelled = true; };
  }, [pid]);

  const detailOpen = !!store.selectedId.value;

  return html`
    <div class=${'c2' + (detailOpen ? ' detail-open' : '')} data-c2>
      <${Header} />
      <${PulseBar} />
      <${Nudges} />
      <div class="c2-body">
        <${Canvas} />
      </div>
      <${Detail} />
      <${MoleculeDialog} />
      ${/* The two authoring surfaces the pour dialog's prerequisite needs
            (bd-console-9it). Mounted alongside it, never nested inside it:
            both are reachable from the Detail panel and the command palette
            as well, not only from the empty state that motivated them. */ ''}
      <${DistillDialog} />
      <${FormulaEditorDialog} />
      ${detailOpen && html`<div class="c2-scrim" onClick=${() => selectIssue(null)}></div>`}
      ${store.issuesError.value && html`<div class="c2-boot-err">Failed to load issues: ${store.issuesError.value} · <a href=${'#/p/' + encodeURIComponent(pid || '')}>classic view</a></div>`}
    </div>`;
}
