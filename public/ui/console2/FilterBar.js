// console2/FilterBar.js — multi-dimension filtering over the loaded issue
// list (bd-console-974.6): assignee, label, priority, type, a text
// substring and age/staleness. Dimensions AND together; a multi-select
// dimension (label/priority/type) ORs within itself. See filters.js for the
// actual matching logic and filteredIssues, the computed every canvas mode
// (Flow/Map/Pulse, via derive.js) reads instead of store.issues.
//
// Collapsed to a single icon + active-count badge when unused, matching the
// header's Templates-button convention — expanding it is one click, and
// nothing about an active filter narrows the issue list silently: the
// indicator next to it always reads "N of M shown" so a thin lane never
// looks like missing data.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { store, PRI_LABEL } from '../store.js';
import {
  filters, isFilterActive, activeFilterCount, clearFilters, filteredIssues,
  availableAssignees, availableLabels, availableTypes, AGE_OPTIONS, UNASSIGNED,
  savedViewsFor, saveView, deleteView, applyView,
} from './filters.js';
import { TYPE_GLYPH } from './ui.js';

function toggleIn(list, val) {
  return list.includes(val) ? list.filter((x) => x !== val) : [...list, val];
}

function set(patch) { filters.value = { ...filters.value, ...patch }; }

// Plain function (not an htm sub-component) so it can take arbitrary
// children content without htm's dynamic-tag closing syntax — matches how
// ui.js's TypeGlyph/Pip/StatusGlyph are called elsewhere in console2/.
function chip({ key, active, onClick, title, label }) {
  return html`<button key=${key} type="button" class=${'c2-chip c2-fchip' + (active ? ' on' : '')}
    title=${title} aria-pressed=${active} onClick=${onClick}>${label}</button>`;
}

function SavedViews() {
  const pid = store.projectId.value;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [, setTick] = useState(0); // localStorage isn't a signal — force a re-read after save/delete
  const bump = () => setTick((t) => t + 1);
  const views = savedViewsFor(pid);
  const doSave = () => {
    const n = name.trim();
    if (!n) return;
    saveView(pid, n);
    setName('');
    bump();
  };
  return html`
    <div class="c2-savedviews">
      <button type="button" class="c2-mini" aria-expanded=${open} aria-haspopup="true"
        onClick=${() => setOpen(!open)}>
        Views${views.length ? ` (${views.length})` : ''}
      </button>
      ${open && html`
        <div class="c2-savedviews-drop" role="menu">
          ${views.length === 0 && html`<div class="c2-omni-empty">No saved views yet.</div>`}
          ${views.map((v) => html`
            <div class="c2-savedview-row" key=${v.name}>
              <button type="button" class="c2-savedview-apply" role="menuitem"
                onClick=${() => { applyView(v); setOpen(false); }}>
                ${v.name}${v.name === 'default' && html`<span class="c2-savedview-tag">applies on open</span>`}
              </button>
              <button type="button" class="c2-savedview-del" title=${'Delete “' + v.name + '”'}
                aria-label=${'Delete saved view ' + v.name}
                onClick=${() => { deleteView(pid, v.name); bump(); }}>✕</button>
            </div>`)}
          <div class="c2-savedview-save">
            <input class="c2-edit-input" placeholder="Save current filters as…" value=${name}
              onInput=${(e) => setName(e.target.value)}
              onKeyDown=${(e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') setOpen(false); }} />
            <button type="button" class="c2-mini" disabled=${!name.trim()} onClick=${doSave}
              title=${'name it "default" to auto-apply it every time this project opens'}>Save</button>
          </div>
        </div>`}
    </div>`;
}

function FilterPanel() {
  const f = filters.value;
  const assignees = availableAssignees.value;
  const labels = availableLabels.value;
  const types = availableTypes.value;
  return html`
    <div class="c2-filterbar-panel" id="c2-filterbar-panel">
      <div class="c2-filter-row">
        <label class="c2-filter-label" for="c2-filter-text">Text</label>
        <input id="c2-filter-text" class="c2-edit-input c2-filter-text" type="text"
          placeholder="id, title or description…" value=${f.text}
          onInput=${(e) => set({ text: e.target.value })} />
      </div>

      <div class="c2-filter-row">
        <label class="c2-filter-label" for="c2-filter-assignee">Assignee</label>
        <select id="c2-filter-assignee" class="c2-edit-input c2-filter-select" value=${f.assignee}
          onChange=${(e) => set({ assignee: e.target.value })}>
          <option value="">Any assignee</option>
          <option value=${UNASSIGNED}>(unassigned)</option>
          ${assignees.map((a) => html`<option key=${a} value=${a}>${a}</option>`)}
        </select>
      </div>

      <div class="c2-filter-row">
        <label class="c2-filter-label" for="c2-filter-age">Age</label>
        <select id="c2-filter-age" class="c2-edit-input c2-filter-select" value=${f.age}
          onChange=${(e) => set({ age: e.target.value })}>
          ${AGE_OPTIONS.map(([v, label]) => html`<option key=${v} value=${v}>${label}</option>`)}
        </select>
      </div>

      <div class="c2-filter-row">
        <span class="c2-filter-label">Priority</span>
        <div class="c2-filter-chips">
          ${PRI_LABEL.map((label, p) => chip({
            key: p, active: f.priorities.includes(p), title: 'Priority ' + label, label,
            onClick: () => set({ priorities: toggleIn(f.priorities, p) }),
          }))}
        </div>
      </div>

      ${types.length > 0 && html`
        <div class="c2-filter-row">
          <span class="c2-filter-label">Type</span>
          <div class="c2-filter-chips">
            ${types.map((t) => chip({
              key: t, active: f.types.includes(t), title: t, label: `${TYPE_GLYPH[t] || '●'} ${t}`,
              onClick: () => set({ types: toggleIn(f.types, t) }),
            }))}
          </div>
        </div>`}

      ${labels.length > 0 && html`
        <div class="c2-filter-row">
          <span class="c2-filter-label">Label</span>
          <div class="c2-filter-chips c2-filter-chips-wrap">
            ${labels.map((l) => chip({
              key: l, active: f.labels.includes(l), title: l, label: l,
              onClick: () => set({ labels: toggleIn(f.labels, l) }),
            }))}
          </div>
        </div>`}

      <div class="c2-filter-row c2-filter-actions">
        <button type="button" class="c2-mini" disabled=${!isFilterActive(f)} onClick=${clearFilters}>Clear all</button>
        <${SavedViews} />
      </div>
    </div>`;
}

export function FilterBar() {
  const [open, setOpen] = useState(false);
  const f = filters.value;
  const active = isFilterActive(f);
  const count = activeFilterCount(f);
  const total = store.issues.value.length;
  const shown = filteredIssues.value.length;

  return html`
    <div class=${'c2-filterbar' + (active ? ' active' : '')}>
      <button type="button" class="c2-filterbtn" aria-expanded=${open} aria-controls="c2-filterbar-panel"
        title="Filter issues — assignee, label, priority, type, text, age"
        onClick=${() => setOpen(!open)}>
        <span aria-hidden="true">⚲</span><span class="c2-btn-label"> Filter</span>
        ${count > 0 && html`<span class="c2-filterbtn-n">${count}</span>`}
      </button>
      ${active && html`
        <span class="c2-filter-indicator" role="status" aria-live="polite">
          ${shown} of ${total} shown
          <button type="button" class="c2-filter-clear" onClick=${clearFilters}>clear</button>
        </span>`}
      ${!open && html`<${SavedViews} />`}
      ${open && html`<${FilterPanel} />`}
    </div>`;
}
