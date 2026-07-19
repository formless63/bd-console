// Toasts.js — bottom-right toast stack backed by Shoelace <sl-alert>.
import { html } from 'htm/preact';
import { store, dismissToast } from '../store.js';

const VARIANT = { ok: 'success', err: 'danger', warn: 'warning', info: 'primary' };

export function Toasts() {
  const toasts = store.toasts.value;
  return html`
    <div class="toast-stack">
      ${toasts.map((t) => html`
        <sl-alert
          key=${t.id}
          variant=${VARIANT[t.kind] || 'primary'}
          open
          closable
          class="toast"
          onsl-after-hide=${() => dismissToast(t.id)}
        >
          <span>${t.message}</span>
        </sl-alert>
      `)}
    </div>`;
}
