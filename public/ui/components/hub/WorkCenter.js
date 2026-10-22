import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, loadSchedule } from '../../store.js';
import { apiGetRaw } from '../../api.js';
import { useVisiblePoll } from '../../poll.js';
import { workRevision } from '../../events.js';
import { collectWork, searchWork, activitySince, workSnapshot } from '../../work.js';
const BASELINE_KEY = 'bd_work_review_v1';
function readBaseline() { try { const data = JSON.parse(localStorage.getItem(BASELINE_KEY) || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; } catch { return {}; } }

export function WorkCenter() {
  const projects = store.projects.value;
  const ids = Object.keys(projects).join('\n');
  const revision = workRevision.value;
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('attention');
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(8);
  const [baseline, setBaseline] = useState(readBaseline);
  const [storageError, setStorageError] = useState('');
  const generation = useRef(0);
  const running = useRef(false);
  const queued = useRef(false);
  const mounted = useRef(false);
  const persist = next => {
    setBaseline(next);
    try { localStorage.setItem(BASELINE_KEY, JSON.stringify(next)); setStorageError(''); }
    catch { setStorageError('Activity baseline could not be saved in this browser.'); }
  };
  const refreshRef = useRef(null);
  refreshRef.current = async () => {
    if (running.current) { queued.current = true; return; }
    running.current = true;
    const current = ++generation.current;
    setBusy(true);
    const next = await collectWork(store.projects.value, id => apiGetRaw(`/api/p/${encodeURIComponent(id)}/issues`, { signal: AbortSignal.timeout(20000) }));
    running.current = false;
    if (queued.current && mounted.current) {
      queued.current = false;
      setTimeout(() => { if (mounted.current) refreshRef.current(); }, 0);
    }
    if (current !== generation.current || !mounted.current) return;
    setResults(next); setBusy(false);
    // Only successful first loads establish a baseline. Never replace a
    // failed project's last reviewed snapshot with an empty list.
    const initial = readBaseline(); let changed = false;
    for (const [id, result] of Object.entries(next)) {
      if (!result.error && !initial[id]) { initial[id] = { at: Date.now(), issues: workSnapshot(result.rows) }; changed = true; }
    }
    if (changed) persist(initial);
    loadSchedule();
  };
  useEffect(() => { mounted.current = true; refreshRef.current(); return () => { mounted.current = false; generation.current++; }; }, [ids]);
  useEffect(() => {
    if (!revision) return;
    const timer = setTimeout(() => refreshRef.current(), 500);
    return () => clearTimeout(timer);
  }, [revision]);
  useVisiblePoll(() => { if (!busyRef.current) refreshRef.current(); }, 30000);
  const busyRef = useRef(false); busyRef.current = busy;
  useEffect(() => { setLimit(tab === 'attention' ? 8 : 30); }, [query, tab, project, status]);
  const rows = Object.entries(results).filter(([id]) => Object.hasOwn(projects, id)).flatMap(([, r]) => r.rows || []);
  const failures = store.scheduleJobs.value.filter(j => j.status === 'failed');
  const attention = rows.filter(r => r.reasons.length).sort((a, b) => a.rank - b.rank || (a.issue.priority ?? 2) - (b.issue.priority ?? 2));
  const activity = activitySince(rows, baseline);
  const source = tab === 'search' ? rows : tab === 'activity' ? activity : attention;
  const filtered = searchWork(source, query, { project, status });
  const errors = Object.entries(results).filter(([id, r]) => Object.hasOwn(projects, id) && r.error);
  const markReviewed = () => {
    const next = { ...baseline };
    for (const [id, result] of Object.entries(results)) if (Object.hasOwn(projects, id) && !result.error) next[id] = { at: Date.now(), issues: workSnapshot(result.rows) };
    persist(next);
  };
  return html`<section class="work-center" aria-label="Work across projects">
    <div class="work-heading"><h2>Your work</h2><button class="btn btn-xs" disabled=${busy} onClick=${() => refreshRef.current()}>${busy ? 'Refreshing…' : 'Refresh'}</button></div>
    <div class="work-tabs" role="group" aria-label="Work view">${[['attention', `Needs attention (${attention.length + failures.length})`], ['search', 'Search all projects'], ['activity', `Since review (${activity.length})`]].map(([value, label]) => html`<button type="button" class=${'btn btn-sm' + (tab === value ? ' btn-accent' : '')} aria-pressed=${tab === value} onClick=${() => setTab(value)}>${label}</button>`)}</div>
    <div class="work-filters"><input class="field issue-search" type="search" aria-label="Search all project issues" placeholder="Search issues, content, labels…" value=${query} onInput=${e => { setQuery(e.target.value); if (tab === 'attention') setTab('search'); }} />
      <select class="field" aria-label="Project filter" value=${project} onChange=${e => setProject(e.target.value)}><option value="">All projects</option>${Object.entries(projects).map(([id, p]) => html`<option value=${id}>${p.name || id}</option>`)}</select>
      <select class="field" aria-label="Status filter" value=${status} onChange=${e => setStatus(e.target.value)}><option value="">All statuses</option>${['open','in_progress','blocked','deferred','closed'].map(s => html`<option value=${s}>${s.replaceAll('_', ' ')}</option>`)}</select></div>
    ${errors.length > 0 && html`<div class="work-warning" role="status">Partial results. ${errors.map(([id, r]) => html`<p><strong>${projects[id]?.name || id}</strong>: ${r.error}</p>`)}</div>`}
    ${tab === 'activity' && html`<div class="work-activity-note"><span class="muted small">Changes since your last review in this browser. First visits establish a baseline; this is not a full audit log.</span><button class="btn btn-xs" disabled=${busy || !rows.length} onClick=${markReviewed}>Mark all loaded projects reviewed</button></div>`}
    ${storageError && html`<p role="status">${storageError}</p>`}
    ${tab === 'attention' && !project && !status && failures.map(job => html`<a class="work-row work-failure" href="#/schedule"><strong>Scheduled prompt #${job.id} failed</strong><span>${job.session} · ${job.error || 'Delivery failed'} · Open scheduler to inspect</span></a>`)}
    ${tab === 'attention' && (!store.scheduleAvailable.value || store.scheduleAvailableReason.value) && html`<p class="muted small">Scheduler status unavailable; displayed failures may be stale. <a href="#/schedule">Inspect scheduler</a></p>`}
    <div class="work-results">${filtered.slice(0, limit).map(row => html`<a class="work-row" key=${row.projectId + ':' + row.issue.id} href=${row.href}>
      <span class="work-row-title"><strong>${row.issue.title || row.issue.id}</strong><span class="muted small">${row.projectName} · ${row.issue.id} · ${String(row.issue.status || 'unknown').replaceAll('_',' ')} · P${row.issue.priority ?? 2}</span></span>
      <span class="work-reasons">${row.reasons.join(' · ') || (row.issue.description || '').slice(0, 160)}</span></a>`)}</div>
    ${!filtered.length && html`<p class="muted work-empty">${busy ? 'Loading project issues…' : tab === 'activity' ? 'No changes since your last review.' : tab === 'attention' ? 'No issue attention signals in the loaded projects.' : 'No matching issues.'}</p>`}
    ${filtered.length > limit && html`<button class="btn btn-sm" onClick=${() => setLimit(limit + 50)}>Show more (${filtered.length - limit} remaining)</button>`}
    <p class="muted small work-count">${rows.length} issues from ${Object.keys(results).filter(id => Object.hasOwn(projects, id) && !results[id].error).length} of ${Object.keys(projects).length} projects</p>
  </section>`;
}
