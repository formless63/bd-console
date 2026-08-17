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
          <div class="toast-row">
            <span>${t.message}</span>
            ${/* An optional action button — today that means Undo (see
                  store.js's offerUndo). The handler owns dismissal and
                  one-shot-ness; this is purely the affordance. The click never
                  bubbles into <sl-alert>'s own close handling. */ ''}
            ${t.action && html`
              <button type="button" class="toast-action"
                onClick=${(e) => { e.stopPropagation(); t.action.run(); }}>${t.action.label}</button>`}
          </div>
        </sl-alert>
      `)}
    </div>`;
}
