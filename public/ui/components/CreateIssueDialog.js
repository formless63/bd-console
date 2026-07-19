// CreateIssueDialog.js — "New issue" modal. Evolved from the old single-field
// quick-capture into a full create form backed by POST /api/create: an intent
// chip picks type + default labels, everything past the title is optional,
// and Enter in the title field submits once a title is present. Backed by a
// native <dialog> for focus/backdrop, same as the other modals in this app.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, createIssue, loadEpics } from '../store.js';

// Each intent maps to a `bd create` type plus labels applied automatically
// on top of anything the user adds by hand.
const INTENTS = [
  { id: 'bug', label: 'Log a bug', type: 'bug', labels: [] },
  { id: 'feature', label: 'New feature', type: 'feature', labels: [] },
  { id: 'task', label: 'Task', type: 'task', labels: [] },
  { id: 'idea', label: 'Idea / triage', type: 'task', labels: ['triage'] },
  { id: 'epic', label: 'Epic', type: 'epic', labels: [] },
  { id: 'chore', label: 'Chore', type: 'chore', labels: [] },
];

const LABEL_RE = /^[A-Za-z0-9_.:-]+$/;

export function CreateIssueDialog() {
  const ref = useRef(null);
  const open = store.createOpen.value;
  const [intentId, setIntentId] = useState('idea');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState('3');
  const [labels, setLabels] = useState([]);
  const [labelInput, setLabelInput] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [epicId, setEpicId] = useState('');
  const [assignee, setAssignee] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const intent = INTENTS.find((i) => i.id === intentId) || INTENTS[0];

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setErr('');
      loadEpics();
      setTimeout(() => d.querySelector('#create-title')?.focus(), 30);
    }
    if (!open && d.open) d.close();
  }, [open]);

  const close = () => (store.createOpen.value = false);
  const reset = () => {
    setIntentId('idea'); setTitle(''); setDesc(''); setPriority('3');
    setLabels([]); setLabelInput(''); setAcceptance(''); setEpicId(''); setAssignee('');
  };

  const addLabel = () => {
    const v = labelInput.trim();
    if (!v) return;
    if (!LABEL_RE.test(v)) { setErr(`Bad label "${v}" — use letters, numbers, _ . : -`); return; }
    setErr('');
    if (!labels.includes(v)) setLabels([...labels, v]);
    setLabelInput('');
  };
  const removeLabel = (l) => setLabels(labels.filter((x) => x !== l));

  const submit = async () => {
    if (!title.trim()) { setErr('Title required'); return; }
    setBusy(true); setErr('');
    const allLabels = [...new Set([...intent.labels, ...labels])];
    try {
      await createIssue({
        title: title.trim(),
        type: intent.type,
        priority: Number(priority),
        labels: allLabels,
        description: desc.trim() || undefined,
        acceptance: acceptance.trim() || undefined,
        parent: epicId || undefined,
        assignee: assignee.trim() || undefined,
      });
      reset();
      close();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const titleKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') close();
  };

  return html`
    <dialog class="dialog dialog-lg" ref=${ref} onClose=${close} onClick=${(e) => { if (e.target === ref.current) close(); }}>
      <div class="dialog-body" onKeyDown=${(e) => { if (e.key === 'Escape') close(); }}>
        <div class="dialog-head">New issue</div>

        <div class="intent-chips">
          ${INTENTS.map((i) => html`
            <button key=${i.id} type="button" class=${'intent-chip' + (i.id === intentId ? ' on' : '')} onClick=${() => setIntentId(i.id)}>
              ${i.label}
            </button>`)}
        </div>

        <input id="create-title" class="field" placeholder="Title" value=${title}
          onInput=${(e) => setTitle(e.target.value)} onKeyDown=${titleKeyDown} />
        <textarea class="field" rows="3" placeholder="Description (optional)…" value=${desc} onInput=${(e) => setDesc(e.target.value)}></textarea>

        <div class="dialog-row">
          <label class="dialog-field"><span>priority</span>
            <select class="field" value=${priority} onChange=${(e) => setPriority(e.target.value)}>
              <option value="0">P0</option>
              <option value="1">P1</option>
              <option value="2">P2</option>
              <option value="3">P3</option>
              <option value="4">P4</option>
            </select>
          </label>
          <label class="dialog-field"><span>epic</span>
            <sl-select class="dialog-select" size="medium" value=${epicId} placeholder="None"
              onsl-change=${(e) => setEpicId(e.target.value)}>
              <sl-option value="">None</sl-option>
              ${store.epics.value.map((e2) => html`<sl-option key=${e2.id} value=${e2.id}>${e2.id} — ${e2.title}</sl-option>`)}
            </sl-select>
          </label>
        </div>

        <label class="dialog-field"><span>labels</span>
          <div class="edit-chiprow">
            ${labels.map((l) => html`
              <button key=${l} type="button" class="chip removable" title="Remove label" onClick=${() => removeLabel(l)}>${l} <span class="chip-x">×</span></button>`)}
            ${intent.labels.map((l) => html`<span key=${'auto-' + l} class="chip auto" title="Applied automatically by the selected type">${l}</span>`)}
          </div>
          <div class="edit-row">
            <input class="edit-input" placeholder="add a label…" value=${labelInput}
              onInput=${(e) => setLabelInput(e.target.value)}
              onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }} />
            <button type="button" class="btn" onClick=${addLabel}>Add</button>
          </div>
        </label>

        <label class="dialog-field"><span>acceptance criteria</span>
          <textarea class="field" rows="2" placeholder="Optional…" value=${acceptance} onInput=${(e) => setAcceptance(e.target.value)}></textarea>
        </label>
        <label class="dialog-field"><span>assignee</span>
          <input class="field" placeholder="Optional" value=${assignee} onInput=${(e) => setAssignee(e.target.value)} />
        </label>

        <div class="dialog-actions">
          ${err && html`<span class="form-err">${err}</span>`}
          <button class="btn btn-ghost" onClick=${close}>Cancel</button>
          <button class="btn btn-accent" disabled=${busy} onClick=${submit}>Create</button>
        </div>
      </div>
    </dialog>`;
}
