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
import { c2 } from './state.js';
import { pulse } from './derive.js';
import { Omnibar } from './Omnibar.js';
import { Pulse } from './Pulse.js';
import { Flow } from './Flow.js';
import { MapView } from './MapView.js';
import { Docs2 } from './Docs2.js';
import { Detail } from './Detail.js';

const MODES = [['flow', 'Flow'], ['map', 'Map'], ['docs', 'Docs']];

function CliFlash() {
  const cli = c2.lastCli.value;
  if (!cli) return null;
  const copy = () => { navigator.clipboard?.writeText(cli.cmd).catch(() => {}); };
  return html`
    <div class="c2-cli" key=${cli.at}>
      <span class="c2-cli-dollar">$</span>
      <code class="c2-cli-cmd">${cli.cmd}</code>
      <button class="c2-cli-copy" title="Copy" onClick=${copy}>copy</button>
      <button class="c2-cli-x" title="Dismiss" onClick=${() => (c2.lastCli.value = null)}>✕</button>
    </div>`;
}

function Header() {
  const meta = store.meta.value;
  const pid = store.projectId.value;
  const p = pulse.value;
  const exp = meta?.export;
  const syncState = !exp ? 'unknown' : exp.error ? 'error' : (!exp.exists || exp.stale) ? 'stale' : 'synced';
  return html`
    <header class="c2-header">
      <div class="c2-header-top">
        <div class="c2-brand">
          <span class="c2-brand-mark">◆</span>
          <div class="c2-brand-txt">
            <span class="c2-brand-name">${meta?.name || pid || 'project'}</span>
            <span class="c2-brand-sub">CONSOLE 2.0 · MISSION CONTROL</span>
          </div>
        </div>
        <${Omnibar} />
        <div class="c2-header-right">
          <span class=${'c2-sync sync-' + syncState} title=${'Issue export: ' + syncState}>${syncState}</span>
          <button class="c2-pulse-toggle" onClick=${() => (c2.pulseOpen.value = !c2.pulseOpen.value)}>Pulse</button>
          <a class="c2-classic" href=${'#/p/' + encodeURIComponent(pid || '')} title="Open the classic project view">classic view →</a>
        </div>
      </div>
      <div class="c2-header-echo">
        <span><b>${p.ready}</b> ready</span><span class="sep">·</span>
        <span><b>${p.inProgress.length}</b> active</span><span class="sep">·</span>
        <span><b>${p.blocked.length}</b> blocked</span><span class="sep">·</span>
        <span><b>${p.triage}</b> triage</span>
        <${CliFlash} />
      </div>
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
    (async () => {
      await loadProjectMeta();
      await Promise.all([loadIssues(), loadDocs(), loadTmux()]);
      c2.ready.value = true;
    })();
  }, [pid]);

  const detailOpen = !!store.selectedId.value;

  return html`
    <div class=${'c2' + (detailOpen ? ' detail-open' : '') + (c2.pulseOpen.value ? ' pulse-open' : '')} data-c2>
      <${Header} />
      <div class="c2-body">
        <${Pulse} />
        <${Canvas} />
      </div>
      <${Detail} />
      ${detailOpen && html`<div class="c2-scrim" onClick=${() => selectIssue(null)}></div>`}
      ${c2.pulseOpen.value && html`<div class="c2-scrim mobile" onClick=${() => (c2.pulseOpen.value = false)}></div>`}
      ${store.issuesError.value && html`<div class="c2-boot-err">Failed to load issues: ${store.issuesError.value} · <a href=${'#/p/' + encodeURIComponent(pid || '')}>classic view</a></div>`}
    </div>`;
}
