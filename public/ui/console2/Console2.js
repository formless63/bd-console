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
import { eventsAvailable } from '../events.js';
import { useVisiblePoll } from '../poll.js';

// app.js's syncRoute() resets store.projectId to null on every non-console2
// route (its "not a project" branch). This synchronous signals effect re-pins
// projectId whenever the console2 route is active, so api.js's
// project-prefixing stays correct without touching app.js. Runs synchronously
// on any conflicting write, so the null is never observable to an in-flight
// fetch.
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
import { WorkflowGuide } from './WorkflowGuide.js';
import { NudgeRail } from '../components/ConceptTip.js';
import { learnContext } from '../learn.js';
import { FilterBar } from './FilterBar.js';
import { loadDefaultView } from './filters.js';
import { useConsole2Keyboard, openHelp } from './keyboardNav.js';
import { HelpOverlay } from './HelpOverlay.js';

const MODES = [['flow', 'Flow'], ['map', 'Map'], ['docs', 'Docs']];

function CliFlash() {
  const cli = c2.lastCli.value;
  if (!cli) return null;
  const copy = () => { navigator.clipboard?.writeText(cli.cmd).catch(() => {}); };
  // "✓ ran" reads this as a receipt of something that already happened, not
  // a command being suggested to the user — every action flashes through
  // here (capture, claim, close, defer, …), so the fix is universal.
  return html`
    <div class="c2-cli" key=${cli.at} role="status" aria-live="polite">
      <span class="c2-cli-ran" aria-hidden="true">✓ ran</span>
      <span class="c2-cli-dollar">$</span>
      <code class="c2-cli-cmd">${cli.cmd}</code>
      <button class="c2-cli-copy" title="Copy" aria-label="Copy command" onClick=${copy}>copy</button>
      <button class="c2-cli-x" title="Dismiss" aria-label="Dismiss command receipt" onClick=${() => (c2.lastCli.value = null)}>✕</button>
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
            <h1 class="c2-brand-name">${meta?.name || pid || 'project'}</h1>
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
            <span aria-hidden="true">⚗</span><span class="c2-btn-label"> Templates</span>
            ${molCount > 0 && html`<span class="c2-molbtn-n">${molCount}</span>`}
          </button>
          <a class="c2-learnlink" href="#/learn" title="Guide and concepts — learn the project workflow">
            <span aria-hidden="true">?</span><span class="c2-btn-label"> Guide</span>
          </a>
          <button class="c2-learnlink" type="button" title="Keyboard shortcuts (?)" onClick=${openHelp}>
            <span aria-hidden="true">⌨</span><span class="c2-btn-label"> Shortcuts</span>
          </button>
          <div class="c2-themesw-header"><${ThemeSwitch} /></div>
          ${/* Console 2.0 shipped with no route to #/settings at all: the only
                ways in were a detour through the (now retired) classic view's
                gear or tripping a 401 redirect. Icon-only and unlabelled on
                purpose — the labelled controls beside it (+New / Templates /
                Guide) are things you do, while this and the hub link are
                places you go, which this header already renders as bare
                glyphs. It stays in the HEADER at every breakpoint, unlike the
                theme switch, which hands off to the pulse-details panel at
                <=768px: that one is a multi-control popover that genuinely
                can't work in a 44px slot, whereas this is a single navigation
                target shaped exactly like the hub link that already survives
                there — and burying the fix for "Settings is unreachable"
                inside a drawer that's collapsed by default on phones would
                just rebuild the detour it removes. */ ''}
          <a class="c2-setlink" href="#/settings" aria-label="Settings"
            title="Settings — access token, bd health, docs roots, appearance">
            <span class="c2-icon" aria-hidden="true">⚙</span>
          </a>
          <span class=${'c2-sync sync-' + syncState} title=${'Issue export: ' + syncState}>${syncState}</span>
        </div>
      </div>
      <div class="c2-header-echo"><${CliFlash} /></div>
    </header>`;
}

function Canvas() {
  const mode = c2.canvasMode.value;
  const chooseMode = (next) => {
    c2.canvasMode.value = next;
    setTimeout(() => document.querySelector('#c2-view-tab-' + next)?.focus(), 0);
  };
  return html`
    <div class="c2-canvas">
      <nav class="c2-segmented" aria-label="Project workspace views" role="tablist">
        ${MODES.map(([m, label]) => html`
          <button key=${m} class=${'c2-seg' + (mode === m ? ' on' : '')}
            id=${'c2-view-tab-' + m} role="tab" aria-selected=${mode === m}
            aria-controls="c2-view-panel" tabIndex=${mode === m ? '0' : '-1'}
            onClick=${() => (c2.canvasMode.value = m)}
            onKeyDown=${(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const at = MODES.findIndex(([key]) => key === m);
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? MODES.length - 1
                : (at + (e.key === 'ArrowRight' ? 1 : -1) + MODES.length) % MODES.length;
              chooseMode(MODES[next][0]);
            }}>${label}</button>`)}
      </nav>
      ${/* Docs is issue-free — filtering the issue list has nothing to say
            there, so FilterBar only mounts for the two issue-driven modes. */ ''}
      ${mode !== 'docs' && html`<${FilterBar} />`}
      <div class="c2-canvas-body" id="c2-view-panel" role="tabpanel"
        aria-labelledby=${'c2-view-tab-' + mode} tabIndex="0">
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
  return html`<div class="c2-nudgeslot">
    <${WorkflowGuide} />
    <${NudgeRail} ctx=${ctx} onAction=${onAction} />
  </div>`;
}

export function Console2() {
  const route = store.route.value;
  const pid = route.projectId;

  // j/k card cursor, [ / ] lane jump, ?-help — scoped to exactly as long as
  // this route is mounted (own module, see keyboardNav.js's header comment
  // for why app.js isn't the owner here).
  useConsole2Keyboard();

  // Live refresh's fallback path: /api/events (started once in App.js) is
  // the primary mechanism, but on a server that predates it (a clean 404 —
  // see events.js) eventsAvailable latches false and this becomes the only
  // thing keeping issues current. Reads eventsAvailable.value and
  // store.projectId.value fresh on every tick (per poll.js's own contract)
  // rather than closing over `pid`, which this effect does not re-run for on
  // every project switch. A no-op once the stream is live.
  useVisiblePoll(() => {
    if (eventsAvailable.value === false && store.projectId.value) loadIssues();
  }, 15000);

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
    c2.laneFocus.value = null;
    c2.epicGroup.value = loadEpicGroupPref(pid);
    // FilterBar (bd-console-974.6): a "default" saved view (if any) applies
    // on project open; otherwise start from a clean, unfiltered slate. Never
    // carries the PREVIOUS project's filter combination across a switch.
    loadDefaultView(pid);
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
      <main class="c2-body" id="c2-project-workspace">
        <${Canvas} />
      </main>
      <${Detail} />
      <${MoleculeDialog} />
      ${/* The two authoring surfaces the pour dialog's prerequisite needs
            (bd-console-9it). Mounted alongside it, never nested inside it:
            both are reachable from the Detail panel and the command palette
            as well, not only from the empty state that motivated them. */ ''}
      <${DistillDialog} />
      <${FormulaEditorDialog} />
      <${HelpOverlay} />
      ${detailOpen && html`<div class="c2-scrim" aria-hidden="true" onClick=${() => selectIssue(null)}></div>`}
      ${/* The escape hatch here used to be "open the classic view instead".
            That view is retired (and #/p/<id> now redirects straight back
            here), so the only honest offer left is a retry and the hub. */ ''}
      ${store.issuesError.value && html`<div class="c2-boot-err" role="alert">Failed to load issues: ${store.issuesError.value} · <a href="#" onClick=${(e) => { e.preventDefault(); loadIssues({ force: true }); }}>retry</a> · <a href="#/">hub</a></div>`}
    </div>`;
}
