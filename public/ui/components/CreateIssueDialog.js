// CreateIssueDialog.js — "New issue" modal. Evolved from the old single-field
// quick-capture into a full create form backed by POST /api/create: an intent
// chip picks type + default labels, everything past the title is optional,
// and Enter in the title field submits once a title is present. Backed by a
// native <dialog> for focus/backdrop, same as the other modals in this app.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, createIssue, loadEpics, loadSettings, createEpicInline } from '../store.js';
import { EpicCombobox } from './common.js';
import { ConceptDot } from './ConceptTip.js';
import { learn } from '../learn.js';

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
  const returnFocus = useRef(null);
  const open = store.createOpen.value;
  const [intentId, setIntentId] = useState('idea');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState('3');
  const [labels, setLabels] = useState([]);
  const [labelInput, setLabelInput] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [epicId, setEpicIdRaw] = useState('');
  // Tracks whether the user picked (or created) an epic by hand during THIS
  // dialog session — once true, the default-epic preselect effect below
  // never overwrites the field again, even across an intent change. Reset
  // whenever the dialog transitions closed -> open (a fresh session).
  const [epicManual, setEpicManual] = useState(false);
  const [assignee, setAssignee] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [newEpicOpen, setNewEpicOpen] = useState(false);
  const [newEpicTitle, setNewEpicTitle] = useState('');
  const [newEpicBusy, setNewEpicBusy] = useState(false);
  const [newEpicErr, setNewEpicErr] = useState('');

  const setEpicId = (id, manual = false) => {
    setEpicIdRaw(id);
    if (manual) setEpicManual(true);
  };

  const intent = INTENTS.find((i) => i.id === intentId) || INTENTS[0];
  const isEpic = intent.type === 'epic';

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnFocus.current = document.activeElement;
      d.showModal();
      setErr('');
      setEpicManual(false);
      loadEpics();
      loadSettings();
      setTimeout(() => d.querySelector('#create-title')?.focus(), 30);
    }
    if (!open && d.open) {
      d.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      returnFocus.current = null;
    }
  }, [open]);

  // Preselect the project's configured default epic for the active intent —
  // opt-in via Settings' "Default epics" card (store.settings.value.defaultEpics,
  // keyed by project id then intent id). Never runs once the user has picked
  // an epic by hand this session (epicManual), and never applies to the epic
  // intent itself (which hides the picker entirely). Re-evaluates whenever
  // the intent changes so switching intents after an auto-pick still tracks
  // the newly selected intent's mapping (or clears back to None if it has
  // none) — only a MANUAL pick is sticky across intent changes.
  useEffect(() => {
    if (!open || isEpic || epicManual) return;
    const projectId = store.projectId.value;
    const defaults = store.settings.value?.defaultEpics?.[projectId];
    const mapped = defaults ? defaults[intentId] : null;
    const stillExists = mapped && store.epics.value.some((e) => e.id === mapped);
    setEpicIdRaw(stillExists ? mapped : '');
  }, [open, isEpic, epicManual, intentId, store.settings.value, store.epics.value]);

  const close = () => (store.createOpen.value = false);
  const reset = () => {
    setIntentId('idea'); setTitle(''); setDesc(''); setPriority('3');
    setLabels([]); setLabelInput(''); setAcceptance(''); setEpicIdRaw(''); setEpicManual(false); setAssignee('');
    setNewEpicOpen(false); setNewEpicTitle(''); setNewEpicErr('');
  };

  const submitNewEpic = async () => {
    const t = newEpicTitle.trim();
    if (!t || newEpicBusy) return;
    setNewEpicBusy(true); setNewEpicErr('');
    try {
      const id = await createEpicInline({ title: t, priority: Number(priority) || 2 });
      learn.recordAction('epic');
      setEpicId(id, true);
      setNewEpicOpen(false);
      setNewEpicTitle('');
    } catch (e) { setNewEpicErr(e.message); }
    finally { setNewEpicBusy(false); }
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
        // Epics never carry a parent/assignee/acceptance — the picker,
        // assignee, and acceptance fields are hidden for this intent (see
        // the JSX below), so nothing here should be sent either.
        ...(isEpic ? {} : {
          acceptance: acceptance.trim() || undefined,
          parent: epicId || undefined,
          assignee: assignee.trim() || undefined,
        }),
      });
      // Grouping learned: retire the "this list is getting long" nudge the
      // moment an epic exists or a bead is filed into one. See learn.js.
      if (isEpic) learn.recordAction('epic');
      else if (epicId) learn.recordAction('parent');
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
    <dialog class="dialog dialog-lg" ref=${ref} aria-labelledby="create-dialog-title"
      onCancel=${(e) => { e.preventDefault(); close(); }}
      onClose=${close} onClick=${(e) => { if (e.target === ref.current) close(); }}>
      <div class="dialog-body" onKeyDown=${(e) => { if (e.key === 'Escape') close(); }}>
        <h2 class="dialog-head" id="create-dialog-title">New issue</h2>

        <div class="intent-chips" data-intent-chips role="group" aria-label="Issue type">
          ${INTENTS.map((i) => html`
            <button key=${i.id} type="button" class=${'intent-chip' + (i.id === intentId ? ' on' : '')}
              aria-pressed=${i.id === intentId} onClick=${() => setIntentId(i.id)}>
              ${i.label}
            </button>`)}
        </div>

        <input id="create-title" class="field" placeholder="Title" value=${title}
          aria-label="Issue title" required
          onInput=${(e) => setTitle(e.target.value)} onKeyDown=${titleKeyDown} />
        <textarea class="field" rows="3" placeholder="Description (optional)…" value=${desc}
          aria-label="Issue description" onInput=${(e) => setDesc(e.target.value)}></textarea>

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
          ${!isEpic && html`
            <label class="dialog-field epic-field">
              <span>
                epic<${ConceptDot} k="epic" />
                <button type="button" class="btn-inline-new" onClick=${() => setNewEpicOpen((o) => !o)}>
                  ${newEpicOpen ? 'cancel' : '+ new epic'}
                </button>
              </span>
              <${EpicCombobox} epics=${store.epics.value} value=${epicId} onChange=${(id) => setEpicId(id, true)} placeholder="None" />
              ${newEpicOpen && html`
                <div class="inline-new-epic">
                  <input class="field" placeholder="New epic title…" value=${newEpicTitle} autofocus
                    onInput=${(e) => setNewEpicTitle(e.target.value)}
                    onKeyDown=${(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); submitNewEpic(); }
                      if (e.key === 'Escape') { e.stopPropagation(); setNewEpicOpen(false); setNewEpicErr(''); }
                    }} />
                  <button type="button" class="btn btn-xs btn-accent" disabled=${newEpicBusy || !newEpicTitle.trim()} onClick=${submitNewEpic}>
                    ${newEpicBusy ? '…' : 'Create'}
                  </button>
                  <button type="button" class="btn btn-xs btn-ghost" onClick=${() => { setNewEpicOpen(false); setNewEpicErr(''); setNewEpicTitle(''); }}>Cancel</button>
                </div>`}
              ${newEpicErr && html`<span class="form-err">${newEpicErr}</span>`}
            </label>`}
        </div>

        <label class="dialog-field"><span>labels</span>
          <div class="edit-chiprow">
            ${labels.map((l) => html`
              <button key=${l} type="button" class="chip removable" title="Remove label" onClick=${() => removeLabel(l)}>${l} <span class="chip-x">×</span></button>`)}
            ${intent.labels.map((l) => html`<span key=${'auto-' + l} class="chip auto" title="Applied automatically by the selected type">${l}</span>`)}
          </div>
          <div class="edit-row">
            <input class="edit-input" placeholder="add a label…" aria-label="Label to add" value=${labelInput}
              onInput=${(e) => setLabelInput(e.target.value)}
              onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }} />
            <button type="button" class="btn" onClick=${addLabel}>Add</button>
          </div>
        </label>

        ${!isEpic && html`
          <label class="dialog-field"><span>acceptance criteria</span>
            <textarea class="field" rows="2" placeholder="Optional…" value=${acceptance} aria-label="Acceptance criteria" onInput=${(e) => setAcceptance(e.target.value)}></textarea>
          </label>`}
        ${!isEpic && html`
          <label class="dialog-field"><span>assignee</span>
            <input class="field" placeholder="Optional" value=${assignee} aria-label="Assignee" onInput=${(e) => setAssignee(e.target.value)} />
          </label>`}

        <div class="dialog-actions">
          ${err && html`<span class="form-err" role="alert">${err}</span>`}
          <button type="button" class="btn btn-ghost" onClick=${close}>Cancel</button>
          <button type="button" class="btn btn-accent" disabled=${busy} onClick=${submit}>Create</button>
        </div>
      </div>
    </dialog>`;
}
