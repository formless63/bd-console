// TokenDialog.js — set / clear the write token used for POST requests. Opens
// automatically when a write is rejected with 401.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, toast } from '../store.js';
import { getToken, setToken } from '../api.js';

export function TokenDialog() {
  const ref = useRef(null);
  const open = store.tokenDialogOpen.value;
  const [value, setValue] = useState(getToken());

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setValue(getToken()); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);

  const close = () => (store.tokenDialogOpen.value = false);
  const required = store.meta.value?.tokenRequired;
  const save = () => { setToken(value.trim()); toast(value.trim() ? 'Token saved' : 'Token cleared'); close(); };

  return html`
    <dialog class="dialog" ref=${ref} onClose=${close} onClick=${(e) => { if (e.target === ref.current) close(); }}>
      <div class="dialog-body">
        <div class="dialog-head">Write token</div>
        <p class="muted small">
          ${required
            ? 'This server requires a token for writes. Paste it below; it is stored in this browser only.'
            : 'This server does not require a write token. You can still set one for future use.'}
        </p>
        <input class="field" type="password" placeholder="x-bd-token…" value=${value}
          onInput=${(e) => setValue(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); }} />
        <div class="dialog-actions">
          <button class="btn btn-ghost" onClick=${() => { setToken(''); setValue(''); toast('Token cleared'); }}>Clear</button>
          <button class="btn btn-accent" onClick=${save}>Save</button>
        </div>
      </div>
    </dialog>`;
}
