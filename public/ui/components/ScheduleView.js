// ScheduleView.js — hub-level #/schedule route: create and manage scheduled
// tmux prompts (POST/GET /api/schedule). The create form's session list comes
// live from GET /api/tmux so a vanished session is caught before submit, and
// the job list polls while this view is mounted.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { store, loadSchedule, loadTmux, scheduleCreate, scheduleCancel } from '../store.js';
import { relTime } from './common.js';

const POLL_MS = 5000;
const STATUS_LABEL = { pending: 'pending', sent: 'sent', failed: 'failed', cancelled: 'cancelled' };

function pad(n) { return String(n).padStart(2, '0'); }
function toLocalInputValue(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function presetInHour() { return new Date(Date.now() + 3600 * 1000); }
function presetTonight() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(2, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}
function presetTomorrowMorning() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setDate(d.getDate() + 1);
  d.setHours(6, 0, 0, 0);
  return d;
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

  // If nothing picked yet and sessions arrive, default to the first one.
  useEffect(() => {
    if (!session && sessions.length) setSession(sessions[0].name);
  }, [sessions.length]);

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
      </label>

      <label class="dialog-field"><span>session</span>
        <input class="field" list="sched-session-options" placeholder="tmux session name" value=${session}
          onInput=${(e) => setSession(e.target.value)} />
        <datalist id="sched-session-options">
          ${sessions.map((s) => html`<option key=${s.name} value=${s.name} />`)}
        </datalist>
        ${vanished && html`<span class="form-warn">Session "${session}" is not currently running — the job will fail when it fires.</span>`}
        ${sessions.length === 0 && html`<span class="muted small">No live tmux sessions detected; you can still type a session name.</span>`}
      </label>

      <label class="dialog-field"><span>run at</span>
        <input class="field" type="datetime-local" value=${runAtLocal} onInput=${(e) => setRunAtLocal(e.target.value)} />
        <div class="preset-row">
          <button type="button" class="btn btn-xs btn-ghost" onClick=${() => applyPreset(presetInHour)}>in 1h</button>
          <button type="button" class="btn btn-xs btn-ghost" onClick=${() => applyPreset(presetTonight)}>tonight 02:00</button>
          <button type="button" class="btn btn-xs btn-ghost" onClick=${() => applyPreset(presetTomorrowMorning)}>tomorrow 06:00</button>
        </div>
      </label>

      <p class="muted small sched-note">
        The prompt is typed into the chosen tmux session followed by Enter — make sure an interactive agent is waiting there.
      </p>

      <div class="dialog-actions">
        ${err && html`<span class="form-err">${err}</span>`}
        <button class="btn btn-accent" disabled=${busy} onClick=${submit}>Schedule</button>
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
    if (!confirm('Cancel this scheduled job?')) return;
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
              <div class="sched-list-head muted small">${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${pendingCount} pending</div>
              ${jobs.length === 0
                ? html`<div class="pane-empty muted">No scheduled jobs yet.</div>`
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
