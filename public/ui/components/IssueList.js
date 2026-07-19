// IssueList.js — the middle pane: sortable, grouped list of issue rows.
import { html } from 'htm/preact';
import { store, listRows, setSort, toggleIssueGroup, selectIssue } from '../store.js';
import { PriBadge, StatusBadge, fmtDate } from './common.js';

function SortHead() {
  const { key, dir } = store.sort.value;
  const arrow = (k) => key === k ? html`<span class="sort-arrow">${dir === 1 ? '↑' : '↓'}</span>` : null;
  return html`
    <div class="list-head">
      <span>Issue</span>
      <span class="sort" onClick=${() => setSort('priority')}>Pri ${arrow('priority')}</span>
      <span class="sort" onClick=${() => setSort('status')}>Status ${arrow('status')}</span>
      <span class="sort col-updated" onClick=${() => setSort('updated_at')}>Updated ${arrow('updated_at')}</span>
    </div>`;
}

function Row({ issue }) {
  const sel = store.selectedId.value === issue.id;
  const isEpic = issue.issue_type === 'epic';
  return html`
    <button
      class=${'issue-row' + (sel ? ' sel' : '') + (issue.status === 'closed' ? ' closed' : '')}
      onClick=${() => selectIssue(issue.id)}
    >
      <span class="it-main">
        <span class="it-title">${isEpic ? html`<span class="epic-glyph">◆</span> ` : ''}${issue.title}</span>
        <span class="it-id">${issue.id}${isEpic ? html` <span class="epic-mark">epic</span>` : ''}</span>
      </span>
      <span>${PriBadge(issue.priority)}</span>
      <span>${StatusBadge(issue)}</span>
      <span class="muted small col-updated">${fmtDate(issue.updated_at)}</span>
    </button>`;
}

function GroupHead({ row }) {
  const collapsed = store.collapsedIssueGroups.value.has(row.key);
  return html`
    <div class=${'group-head' + (collapsed ? ' collapsed' : '')}>
      <button class="group-toggle" onClick=${() => toggleIssueGroup(row.key)} aria-expanded=${!collapsed}>
        <span class="group-chev">${collapsed ? '▸' : '▾'}</span>
        <span class="group-title">${row.title}</span>
        <span class="group-meta">${row.count}${row.epic ? html` · ${row.epic.id}` : ''}</span>
      </button>
      ${row.epic && html`<button class="btn btn-ghost btn-xs" onClick=${() => selectIssue(row.epic.id)}>View</button>`}
    </div>`;
}

export function IssueList() {
  const rows = listRows.value;
  const loading = store.issuesLoading.value && store.issues.value.length === 0;
  return html`
    <section class="list-pane">
      ${SortHead()}
      <div class="issue-list">
        ${loading
          ? Array.from({ length: 8 }).map((_, n) => html`<div key=${n} class="issue-row skeleton-row"><span class="skeleton-bar w-70"></span><span class="skeleton-bar w-30"></span></div>`)
          : rows.length === 0
            ? html`<div class="pane-empty muted">No issues match your filters.</div>`
            : rows.map((row) => row.kind === 'group'
                ? html`<${GroupHead} key=${row.key} row=${row} />`
                : html`<${Row} key=${row.issue.id} issue=${row.issue} />`)}
      </div>
    </section>`;
}
