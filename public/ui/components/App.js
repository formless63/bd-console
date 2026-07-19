// App.js — root component. Chooses the view from the route signal and mounts the
// persistent chrome (top bar, toasts, dialogs).
import { html } from 'htm/preact';
import { store } from '../store.js';
import { TopBar } from './TopBar.js';
import { HubView } from './HubView.js';
import { ProjectView } from './ProjectView.js';
import { Toasts } from './Toasts.js';
import { QuickCapture } from './QuickCapture.js';
import { TokenDialog } from './TokenDialog.js';

export function App() {
  const route = store.route.value;
  return html`
    <${TopBar} />
    <div class="app-body">
      ${route.view === 'project' ? html`<${ProjectView} />` : html`<${HubView} />`}
    </div>
    <${QuickCapture} />
    <${TokenDialog} />
    <${Toasts} />
  `;
}
