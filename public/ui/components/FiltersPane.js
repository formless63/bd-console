// FiltersPane.js — left sidebar: health card, search, faceted filter chips and
// view toggles (group-by-epic, ready-only).
import { html } from 'htm/preact';
import { store, facets, toggleFilter, clearFilters, PRI_LABEL } from '../store.js';
import { statusText, fmtClock } from './common.js';

const STATUS_ORDER = ['in_progress', 'blocked', 'open', 'closed'];

function Chips({ kind, order, format, statusColors }) {
  const map = facets.value[kind];
  const active = store.filters.value[kind];
  let keys = [...map.keys()];
  if (order) keys = order.filter((k) => map.has(k));
  else keys.sort((a, b) => map.get(b) - map.get(a) || String(a).localeCompare(String(b)));
  if (!keys.length) return html`<span class="muted small">none</span>`;
  return html`<div class="chips">
    ${keys.map((k) => html`
      <button
        key=${String(k)}
        class=${'chip' + (active.includes(k) ? ' on' : '') + (statusColors ? ' st st-' + k : '')}
        onClick=${() => toggleFilter(kind, k)}
      >${format(k)}<span class="ct">${map.get(k)}</span></button>`)}
  </div>`;
}

function HealthCard() {
  const meta = store.meta.value || {};
  const health = meta.health || {};
  const exp = meta.export || {};
  const errors = health.errors || [];
  const state = health.status || 'ok';
  return html`
    <div class="health-card">
      <div class="health-head">
        <span class="health-title">System</span>
        <span class=${'health-status ' + state}>${state === 'err' ? 'attention' : 'ready'}</span>
      </div>
      <div class="health-kv">
        <span class="health-k">workspace</span><span class="health-v"><code>${meta.name || meta.workspace || '—'}</code></span>
        <span class="health-k">host</span><span class="health-v"><code>${meta.hostname || '—'}</code></span>
        <span class="health-k">writes</span><span class="health-v">${meta.tokenRequired ? 'token-gated' : 'open'}</span>
        <span class="health-k">export</span><span class="health-v">${exp.exists ? (exp.stale ? 'stale' : 'current') : 'missing'}${exp.exportedAt ? ' · ' + fmtClock(exp.exportedAt) : ''}</span>
        <span class="health-k">bd</span><span class="health-v"><code>${health.bdVersion || '—'}</code></span>
      </div>
      ${errors.length > 0 && html`<div class="health-warnings">
        ${errors.map((m, n) => html`<div key=${n} class="health-warning err">${m}</div>`)}
      </div>`}
    </div>`;
}

export function FiltersPane() {
  return html`
    <aside class="filters">
      ${HealthCard()}
      <div class="search-wrap">
        <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M11.7 10.3a6 6 0 10-1.4 1.4l3 3 1.4-1.4-3-3zM3 7a4 4 0 118 0 4 4 0 01-8 0z"/></svg>
        <input
          class="search issue-search"
          type="search"
          placeholder="Search id, title, description…"
          value=${store.search.value}
          onInput=${(e) => (store.search.value = e.target.value)}
        />
      </div>
      <div class="filter-group">
        <div class="filter-label">Status</div>
        <${Chips} kind="status" order=${STATUS_ORDER} statusColors format=${(v) => statusText(v)} />
      </div>
      <div class="filter-group">
        <div class="filter-label">Priority</div>
        <${Chips} kind="priority" order=${[0, 1, 2, 3, 4]} format=${(v) => PRI_LABEL[v]} />
      </div>
      <div class="filter-group">
        <div class="filter-label">Type</div>
        <${Chips} kind="type" format=${(v) => v} />
      </div>
      <div class="filter-group">
        <div class="filter-label">Label</div>
        <${Chips} kind="label" format=${(v) => v} />
      </div>
      <label class="toggle">
        <input type="checkbox" checked=${store.groupEpic.value} onChange=${(e) => (store.groupEpic.value = e.target.checked)} />
        <span>Group by epic</span>
      </label>
      <label class="toggle">
        <input type="checkbox" checked=${store.readyOnly.value} onChange=${(e) => (store.readyOnly.value = e.target.checked)} />
        <span>Ready only <span class="muted small">(open, unblocked)</span></span>
      </label>
      <button class="btn btn-ghost" onClick=${clearFilters}>Clear filters</button>
    </aside>`;
}
