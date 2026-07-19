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

function CurrentView(route) {
  if (route.view === 'project') return html`<${ProjectView} />`;
  if (route.view === 'tmux') return html`<${TmuxView} />`;
  if (route.view === 'schedule') return html`<${ScheduleView} />`;
  if (route.view === 'settings') return html`<${SettingsView} />`;
  return html`<${HubView} />`;
}

export function App() {
  const route = store.route.value;
  // Console 2.0 is a full-viewport flagship view — it renders without the
  // classic TopBar chrome, but keeps global Toasts.
  if (route.view === 'console2') {
    return html`<${Console2} /><${Toasts} />`;
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
