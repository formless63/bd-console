// ScheduleView.js — hub-level #/schedule route: create and manage scheduled
// tmux prompts (POST/GET /api/schedule). The create form's session list comes
// live from GET /api/tmux via a themed custom combobox (see SessionCombobox
// below — native <input list=…>/<datalist> was replaced after it proved
// unreliable in this app's layout; see the note on SessionCombobox for the
// root-cause writeup), and the scheduled-prompt list polls while this view
// is mounted.
// Saved prompts (GET/POST /api/prompts…) are optional — they degrade to
// "hidden" if the backend hasn't landed the endpoints yet.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  store, loadSchedule, loadTmux, scheduleCreate, scheduleCancel,
  loadPrompts, savePrompt, deletePrompt, markPromptUsed,
} from '../store.js';
import { relTime, cwdTail } from './common.js';

const POLL_MS = 5000;
const STATUS_LABEL = { pending: 'pending', sent: 'sent', failed: 'failed', cancelled: 'cancelled' };

function pad(n) { return String(n).padStart(2, '0'); }
function toLocalInputValue(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// +N hours from now.
function presetPlusHours(hours) { return new Date(Date.now() + hours * 3600 * 1000); }
// Next local occurrence of a given hour (0-23) — today if it's still ahead,
// otherwise tomorrow. Used for the "2am" / "4am" presets.
function presetNextClock(hour) {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}
const RUN_AT_PRESETS = [
  { label: '+1h', fn: () => presetPlusHours(1) },
  { label: '+2h', fn: () => presetPlusHours(2) },
  { label: '+3h', fn: () => presetPlusHours(3) },
  { label: '+4h', fn: () => presetPlusHours(4) },
  { label: '+5h', fn: () => presetPlusHours(5) },
  { label: '2am', fn: () => presetNextClock(2) },
  { label: '4am', fn: () => presetNextClock(4) },
];

// ---------------------------------------------------------------------------
// SessionCombobox — replaces a plain <input list=…>/<datalist>.
//
// Root cause of the original "doesn't seem to work" report: reproduced with
// headless + headed Chrome (Xvfb) against both the live app and a bare
// zero-dependency <input list>/<datalist> control page. In both cases the
// native suggestion popover never rendered on focus or programmatic
// interaction — only a precise mouse click on the tiny, undiscoverable arrow
// glyph opens it, and even then the popover is unstyleable (always renders
// in the OS/browser's default light chrome, clashing with every dark theme
// preset here). That combination — invisible affordance + no theming hook +
// unreliable rendering in this app's flex/sticky layout — makes it
// effectively non-functional for users. Replaced with a small themed
// combobox: a real <input> (so freeform names still work) plus an
// absolutely-positioned suggestion menu we fully control, filtered as you
// type, keyboard-navigable, and closes on blur/Escape/selection.
//
// Follow-up fix (user report): the menu previously only opened while typing,
// and the field silently pre-filled with sessions[0] — so anyone who didn't
// start typing only ever saw (and only ever targeted) the same one session.
// A stray-prompt incident already taught us silent default targeting is
// dangerous, so there is now no default: the field starts empty, opens its
// full session list on focus *and* on click (covers the case where the
// input is already focused but the menu got dismissed), and every option
// shows what it's actually running (pane command + cwd) so the choice is
// informed rather than a guess.
function SessionCombobox({ value, onChange, sessions }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const wrapRef = useRef(null);

  const q = value.trim().toLowerCase();
  const filtered = q ? sessions.filter((s) => s.name.toLowerCase().includes(q)) : sessions;

  useEffect(() => {
    function onDocClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const pick = (name) => { onChange(name); setOpen(false); setHi(-1); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { if (open && hi >= 0 && filtered[hi]) { e.preventDefault(); pick(filtered[hi].name); } }
    else if (e.key === 'Escape') { setOpen(false); setHi(-1); }
  };

  // A session's first pane's command + cwd tail, so users can tell what's
  // actually running there instead of picking blind by name alone.
  const paneSummary = (s) => {
    const first = s.panes && s.panes[0];
    if (!first) return 'no active pane';
    const cmd = first.command || '—';
    const cwd = cwdTail(first.cwd);
    return cwd ? `${cmd} · ${cwd}` : cmd;
  };

  return html`
    <div class="combobox" ref=${wrapRef}>
      <input class="field" placeholder="choose or type a session…" value=${value} autocomplete="off"
        onFocus=${() => setOpen(true)}
        onClick=${() => setOpen(true)}
        onInput=${(e) => { onChange(e.target.value); setOpen(true); setHi(-1); }}
        onKeyDown=${onKeyDown} />
      ${open && filtered.length > 0 && html`
        <ul class="combobox-menu" role="listbox">
          ${filtered.map((s, i) => html`
            <li key=${s.name} role="option" aria-selected=${i === hi}
              class=${'combobox-opt session-opt' + (i === hi ? ' hi' : '')}
              onMouseDown=${(e) => { e.preventDefault(); pick(s.name); }}
              onMouseEnter=${() => setHi(i)}>
              <span class="combobox-opt-row">
                <span class="combobox-opt-name">${s.name}</span>
                ${s.attached ? html`<span class="badge tmux-attach on combobox-opt-badge">attached</span>` : null}
              </span>
              <span class="combobox-opt-meta muted small">${paneSummary(s)}</span>
            </li>`)}
        </ul>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// Saved prompts — optional feature backed by an endpoint that may not exist
// yet on an older/mid-deploy server; hides itself on failure.
function SavedPrompts({ prompt, onPick }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const wrapRef = useRef(null);
  const available = store.promptsAvailable.value;
  const prompts = store.prompts.value;

  useEffect(() => { loadPrompts(); }, []);
  useEffect(() => {
    function onDocClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setSaving(false); } }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  if (!available) return null;

  const pick = async (p) => {
    onPick(p.prompt);
    setOpen(false);
    markPromptUsed(p.id);
  };
  const remove = async (e, p) => {
    e.stopPropagation();
    if (!confirm(`Delete saved prompt "${p.name}"?`)) return;
    try { await deletePrompt(p.id); } catch { /* toasted by the store action */ }
  };
  const doSave = async () => {
    const n = name.trim();
    if (!n) return;
    if (!prompt.trim()) return;
    try {
      await savePrompt(n, prompt);
      setName(''); setSaving(false); setOpen(false);
    } catch { /* toasted by the store action */ }
  };

  return html`
    <div class="combobox saved-prompts" ref=${wrapRef}>
      <button type="button" class="btn btn-xs btn-ghost" onClick=${() => setOpen((o) => !o)}>
        Saved prompts${prompts.length ? ` (${prompts.length})` : ''}
      </button>
      ${open && html`
        <div class="combobox-menu saved-prompts-menu">
          ${!saving
            ? html`<button type="button" class="saved-prompts-save-trigger" onClick=${() => setSaving(true)} disabled=${!prompt.trim()}>
                + Save current prompt…
              </button>`
            : html`<div class="saved-prompts-save-row">
                <input class="field" placeholder="name this prompt…" value=${name} autofocus
                  onInput=${(e) => setName(e.target.value)}
                  onKeyDown=${(e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') setSaving(false); }} />
                <button type="button" class="btn btn-xs btn-accent" disabled=${!name.trim()} onClick=${doSave}>Save</button>
              </div>`}
          ${prompts.length === 0
            ? html`<div class="saved-prompts-empty muted small">No saved prompts yet.</div>`
            : prompts.map((p) => html`
                <div key=${p.id} class="combobox-opt saved-prompt-opt" onClick=${() => pick(p)}>
                  <span class="combobox-opt-name" title=${p.prompt}>${p.name}</span>
                  <button type="button" class="saved-prompt-del" title="Delete"
                    onMouseDown=${(e) => e.stopPropagation()} onClick=${(e) => remove(e, p)}>×</button>
                </div>`)}
        </div>`}
    </div>`;
}

function CreateForm() {
  const sessions = store.tmuxSessions.value;
  const [prompt, setPrompt] = useState('');
  const [session, setSession] = useState('');
  const [runAtLocal, setRunAtLocal] = useState(toLocalInputValue(new Date(Date.now() + 5 * 60 * 1000)));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Consume a session preset handed off from TmuxView's "Schedule a prompt
  // here" button, once, then clear it so it doesn't stick around.
  useEffect(() => {
    const preset = store.scheduleSessionPreset.value;
    if (preset) { setSession(preset); store.scheduleSessionPreset.value = null; }
  }, []);

  const vanished = session && sessions.length > 0 && !sessions.some((s) => s.name === session);

  const applyPreset = (fn) => setRunAtLocal(toLocalInputValue(fn()));

  const submit = async () => {
    if (!prompt.trim()) { setErr('Prompt is required'); return; }
    if (!session.trim()) { setErr('Choose a target session'); return; }
    const runAtMs = new Date(runAtLocal).getTime();
    if (!Number.isFinite(runAtMs)) { setErr('Pick a valid run time'); return; }
    setBusy(true); setErr('');
    try {
      await scheduleCreate({ prompt, session: session.trim(), runAt: runAtMs });
      setPrompt('');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return html`
    <div class="sched-form">
      <label class="dialog-field"><span>prompt</span>
        <textarea class="field" rows="5" placeholder="What should be typed into the session?"
          value=${prompt} onInput=${(e) => setPrompt(e.target.value)}></textarea>
        <div class="sched-prompt-tools">
          <${SavedPrompts} prompt=${prompt} onPick=${setPrompt} />
        </div>
      </label>

      <label class="dialog-field"><span>session</span>
        <${SessionCombobox} value=${session} onChange=${setSession} sessions=${sessions} />
        ${vanished && html`<span class="form-warn">Session "${session}" is not currently running — the scheduled prompt will fail when it fires.</span>`}
        ${sessions.length === 0 && html`<span class="muted small">No live tmux sessions detected; you can still type a session name.</span>`}
      </label>

      <label class="dialog-field"><span>run at</span>
        <input class="field" type="datetime-local" value=${runAtLocal} onInput=${(e) => setRunAtLocal(e.target.value)} />
        <div class="preset-row">
          ${RUN_AT_PRESETS.map((p) => html`
            <button key=${p.label} type="button" class="btn btn-xs btn-ghost" onClick=${() => applyPreset(p.fn)}>${p.label}</button>`)}
        </div>
      </label>

      <p class="muted small sched-note">
        The prompt is typed into the chosen tmux session followed by Enter — make sure an interactive agent is waiting there.
      </p>

      <div class="dialog-actions">
        ${err && html`<span class="form-err">${err}</span>`}
        <button class="btn btn-accent" disabled=${busy || !session.trim()} onClick=${submit}>Schedule</button>
      </div>
    </div>`;
}

function JobRow({ job, expanded, onToggle, onCancel }) {
  const status = job.status;
  const long = (job.prompt || '').length > 140;
  const shown = expanded || !long ? job.prompt : job.prompt.slice(0, 140) + '…';
  return html`
    <div class="sched-row">
      <div class="sched-row-top">
        <span class=${'job-status ' + status}>${STATUS_LABEL[status] || status}</span>
        <span class="sched-session">${job.session}</span>
        <span class="sched-time" title=${new Date(job.run_at).toLocaleString()}>${new Date(job.run_at).toLocaleString()} · ${relTime(job.run_at)}</span>
        ${status === 'pending' && html`<button class="btn btn-xs btn-ghost sched-cancel" onClick=${() => onCancel(job.id)}>Cancel</button>`}
      </div>
      <div class=${'sched-prompt' + (long ? ' clickable' : '')} onClick=${long ? onToggle : undefined}>
        ${shown}
        ${long && html`<span class="sched-expand">${expanded ? ' (show less)' : ' (show more)'}</span>`}
      </div>
      ${(job.fired_at || job.error) && html`
        <div class="sched-meta muted small">
          ${job.fired_at && html`<span>fired ${relTime(job.fired_at)}</span>`}
          ${job.error && html`<span class="sched-error">error: ${job.error}</span>`}
        </div>`}
    </div>`;
}

export function ScheduleView() {
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  useEffect(() => {
    loadSchedule();
    loadTmux();
    const t = setInterval(() => { loadSchedule(); loadTmux(); }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const toggle = (id) => {
    const set = new Set(expandedIds);
    set.has(id) ? set.delete(id) : set.add(id);
    setExpandedIds(set);
  };

  const cancel = async (id) => {
    if (!confirm('Cancel this scheduled prompt?')) return;
    try { await scheduleCancel(id); } catch (e) { /* toasted by the store action */ }
  };

  const jobs = store.scheduleJobs.value;
  const pendingCount = jobs.filter((j) => j.status === 'pending').length;

  return html`
    <main class="strip-view">
      <div class="view-header">
        <h1>Scheduled prompts</h1>
        <button class="btn btn-ghost" onClick=${() => { loadSchedule(); loadTmux(); }}>Refresh</button>
      </div>

      ${!store.scheduleAvailable.value
        ? html`<div class="empty-state">
            <div class="empty-icon">⏱</div>
            <p>The scheduler needs Node ≥ 22 (node:sqlite) on the server host.</p>
          </div>`
        : html`
          <div class="sched-layout">
            <section class="sched-list-pane">
              <div class="sched-list-head muted small">${jobs.length} scheduled prompt${jobs.length === 1 ? '' : 's'} · ${pendingCount} pending</div>
              ${jobs.length === 0
                ? html`<div class="pane-empty muted">No scheduled prompts yet.</div>`
                : html`<div class="sched-list">
                    ${jobs.map((j) => html`<${JobRow} key=${j.id} job=${j} expanded=${expandedIds.has(j.id)} onToggle=${() => toggle(j.id)} onCancel=${cancel} />`)}
                  </div>`}
            </section>
            <section class="sched-create-pane">
              <h2 class="sched-create-title">Schedule a prompt</h2>
              ${CreateForm()}
            </section>
          </div>`}
    </main>`;
}
