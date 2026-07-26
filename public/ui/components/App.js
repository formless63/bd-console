// App.js — root component. Chooses the view from the route signal and mounts the
// persistent chrome (top bar, toasts, dialogs).
import { html } from 'htm/preact';
import { store } from '../store.js';
import { TopBar } from './TopBar.js';
import { HubView } from './HubView.js';
import { ProjectView } from './ProjectView.js';
import { TmuxView } from './TmuxView.js';
import { ScheduleView } from './ScheduleView.js';
import { SettingsView } from './SettingsView.js';
import { Toasts } from './Toasts.js';
import { CreateIssueDialog } from './CreateIssueDialog.js';
import { Console2 } from '../console2/Console2.js';
import { LearnView } from './LearnView.js';
import { isLearnHash } from '../learn.js';

function CurrentView(route) {
  if (route.view === 'project') return html`<${ProjectView} />`;
  if (route.view === 'tmux') return html`<${TmuxView} />`;
  if (route.view === 'schedule') return html`<${ScheduleView} />`;
  if (route.view === 'settings') return html`<${SettingsView} />`;
  return html`<${HubView} />`;
}

export function App() {
  const route = store.route.value;

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
        <${LearnView} />
      </div>
      <${Toasts} />
    `;
  }

  // Console 2.0 is a full-viewport flagship view — it renders without the
  // classic TopBar chrome, but keeps global Toasts.
  if (route.view === 'console2') {
    // CreateIssueDialog rides along: Console 2.0's "+ New" button and the `i`
    // shortcut drive the same store.createOpen signal the classic view uses,
    // so the full-fidelity create flow (type, labels, acceptance, epic
    // target) is reachable here too — the omnibar only does quick triage
    // capture.
    return html`<${Console2} /><${CreateIssueDialog} /><${Toasts} />`;
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
