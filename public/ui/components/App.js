// App.js — root component. Chooses the view from the route signal and mounts the
// persistent chrome (top bar, toasts, dialogs).
import { html } from 'htm/preact';
import { store } from '../store.js';
import { TopBar } from './TopBar.js';
import { HubView } from './HubView.js';
import { ProjectView } from './ProjectView.js';
import { TmuxView } from './TmuxView.js';
import { ScheduleView } from './ScheduleView.js';
import { Toasts } from './Toasts.js';
import { CreateIssueDialog } from './CreateIssueDialog.js';
import { TokenDialog } from './TokenDialog.js';

function CurrentView(route) {
  if (route.view === 'project') return html`<${ProjectView} />`;
  if (route.view === 'tmux') return html`<${TmuxView} />`;
  if (route.view === 'schedule') return html`<${ScheduleView} />`;
  return html`<${HubView} />`;
}

export function App() {
  const route = store.route.value;
  return html`
    <${TopBar} />
    <div class="app-body">
      ${CurrentView(route)}
    </div>
    <${CreateIssueDialog} />
    <${TokenDialog} />
    <${Toasts} />
  `;
}
