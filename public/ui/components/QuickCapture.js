// QuickCapture.js — modal for capturing a quick idea (title/description/label/
// priority) via POST /api/quick. Backed by a native <dialog> for focus/backdrop.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, quickCapture } from '../store.js';

export function QuickCapture() {
  const ref = useRef(null);
  const open = store.quickOpen.value;
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [label, setLabel] = useState('triage');
  const [priority, setPriority] = useState('3');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { d.showModal(); setErr(''); setTimeout(() => d.querySelector('#quick-title')?.focus(), 30); }
    if (!open && d.open) d.close();
  }, [open]);

  const close = () => (store.quickOpen.value = false);
  const submit = async () => {
    if (!title.trim()) { setErr('Title required'); return; }
    setBusy(true); setErr('');
    try {
      await quickCapture({ title: title.trim(), description: desc.trim() || undefined, label: label.trim() || 'triage', priority });
      setTitle(''); setDesc('');
      close();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return html`
    <dialog class="dialog" ref=${ref} onClose=${close} onClick=${(e) => { if (e.target === ref.current) close(); }}>
      <div class="dialog-body" onKeyDown=${(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); if (e.key === 'Escape') close(); }}>
        <div class="dialog-head">Capture an idea</div>
        <input id="quick-title" class="field" placeholder="What's the idea? (title)" value=${title} onInput=${(e) => setTitle(e.target.value)} />
        <textarea class="field" rows="3" placeholder="Optional detail…" value=${desc} onInput=${(e) => setDesc(e.target.value)}></textarea>
        <div class="dialog-row">
          <label class="dialog-field"><span>label</span>
            <input class="field" value=${label} onInput=${(e) => setLabel(e.target.value)} />
          </label>
          <label class="dialog-field"><span>priority</span>
            <select class="field" value=${priority} onChange=${(e) => setPriority(e.target.value)}>
              <option value="1">P1</option><option value="2">P2</option><option value="3">P3</option><option value="4">P4</option>
            </select>
          </label>
        </div>
        <div class="dialog-actions">
          ${err && html`<span class="form-err">${err}</span>`}
          <button class="btn btn-ghost" onClick=${close}>Cancel</button>
          <button class="btn btn-accent" disabled=${busy} onClick=${submit}>Capture</button>
        </div>
      </div>
    </dialog>`;
}
