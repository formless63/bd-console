// App.js — root component. Chooses the view from the route signal and mounts the
// persistent chrome (top bar, toasts, dialogs).
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { store } from '../store.js';
import { startEventStream } from '../events.js';
import { TopBar } from './TopBar.js';
import { HubView } from './HubView.js';
import { Toasts } from './Toasts.js';
import { CreateIssueDialog } from './CreateIssueDialog.js';
import { isLearnHash } from '../learn.js';

// Route-only surfaces stay out of the initial module graph. This is native
// browser ESM rather than a bundler convention: each route imports its own
// module only when it is first visited. Keep the loader component deliberately
// small and local so the hub's always-available chrome remains synchronous.
const ROUTE_LOADERS = {
  tmux: () => import('./TmuxView.js').then((m) => m.TmuxView),
  schedule: () => import('./ScheduleView.js').then((m) => m.ScheduleView),
  settings: () => import('./SettingsView.js').then((m) => m.SettingsView),
  learn: () => import('./LearnView.js').then((m) => m.LearnView),
  console2: () => import('../console2/Console2.js').then((m) => m.Console2),
};

function SurfaceLoading() {
  return html`<div class="app-surface-loading" role="status" aria-live="polite">Loading view…</div>`;
}

function LazySurface({ load, label }) {
  const [state, setState] = useState({ component: null, error: null, attempt: 0 });
  const { component: Surface, error, attempt } = state;
  useEffect(() => {
    let live = true;
    setState((old) => ({ ...old, component: null, error: null }));
    load().then((component) => {
      if (live) setState((old) => ({ ...old, component }));
    }).catch((e) => {
      if (live) setState((old) => ({ ...old, error: e }));
    });
    return () => { live = false; };
  }, [load, attempt]);
  if (Surface) return html`<${Surface} />`;
  if (error) return html`
    <div class="app-surface-error" role="alert">
      <p>Could not load ${label}.</p>
      <button type="button" class="btn" onClick=${() => setState((old) => ({ ...old, attempt: old.attempt + 1 }))}>Retry</button>
    </div>`;
  return html`<${SurfaceLoading} />`;
}

function CurrentView(route) {
  if (ROUTE_LOADERS[route.view]) {
    return html`<${LazySurface} key=${route.view} load=${ROUTE_LOADERS[route.view]} label=${route.view} />`;
  }
  return html`<${HubView} />`;
}

export function App() {
  const route = store.route.value;

  // App-lifetime, route-independent: one connection for the whole session,
  // started once here rather than per-view, so switching projects or
  // navigating away from Console 2.0 never tears it down and reconnects it.
  useEffect(() => { startEventStream(); }, []);

  // #/learn — the concepts reference. Handled here rather than in store.js's
  // parseHash (which another agent owns and which falls back to the hub for
  // anything it doesn't recognise): store.route is reassigned a fresh object on
  // every hashchange, so reading location.hash during this render is reliably
  // re-evaluated whenever the URL changes. The route falls through to `hub`
  // underneath, which is harmless — it just means the hub data stays warm.
  if (isLearnHash(location.hash)) {
    return html`
      <${TopBar} />
      <div class="app-body">
        <${LazySurface} key="learn" load=${ROUTE_LOADERS.learn} label="learn" />
      </div>
      <${Toasts} />
    `;
  }

  // Console 2.0 is THE per-project view (#/p2/<id>, and where the retired
  // #/p/<id> redirects to). Full-viewport: it renders its own header instead
  // of the hub-level TopBar, but keeps global Toasts.
  if (route.view === 'console2') {
    // CreateIssueDialog rides along: Console 2.0's "+ New" button and the `i`
    // shortcut drive the same store.createOpen signal, so the full-fidelity
    // create flow (type, labels, acceptance, epic target) is reachable here —
    // the omnibar only does quick triage capture.
    return html`<${LazySurface} key="console2" load=${ROUTE_LOADERS.console2} /><${CreateIssueDialog} /><${Toasts} />`;
  }
  return html`
    <${TopBar} />
    <div class="app-body">
      ${CurrentView(route)}
    </div>
    <${CreateIssueDialog} />
    <${Toasts} />
  `;
}
