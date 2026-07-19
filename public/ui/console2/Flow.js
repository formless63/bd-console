// console2/Flow.js — the default canvas: swim-lanes (Triage · Ready · In
// progress · Blocked · Done this week) of intent cards, plus an epic-grouping
// toggle that regroups everything into epic rows with layer-by-layer progress.
import { html } from 'htm/preact';
import { store, selectIssue, effStatus, childrenOf, parentOf } from '../store.js';
import { c2, setEpicGroup } from './state.js';
import { lanes, isStale, focusedIds, LANE_LABEL } from './derive.js';
import { actClaim, actStart, actClose, actDefer } from './actions.js';
import { TypeGlyph, Pip, AgeChip, StatusGlyph, glyphStatus } from './ui.js';

const LANES = [
  ['triage', 'Triage', 'triage'],
  ['ready', 'Ready', 'ready'],
  ['in_progress', 'In progress', 'in_progress'],
  ['blocked', 'Blocked', 'blocked'],
  ['done', 'Done · 7d', 'done'],
];

function Card({ issue }) {
  const id = issue.id;
  const s = effStatus(issue);
  const g = glyphStatus(issue);
  const stale = isStale(issue);
  const sel = store.selectedId.value === id;
  const closed = issue.status === 'closed';

  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const doDefer = () => { const w = prompt('Defer ' + id + ' until (e.g. +2d, next monday):', '+2d'); if (w) actDefer(id, w); };
  const doClose = () => { const r = prompt('Close reason (optional):', ''); actClose(id, r || ''); };

  return html`
    <div class=${'c2-card st-' + g + (sel ? ' sel' : '') + (issue.priority <= 0 ? ' p0' : '')}
         role="button" tabIndex="0"
         onClick=${() => selectIssue(id)}
         onKeyDown=${(e) => { if (e.key === 'Enter') selectIssue(id); }}>
      <div class="c2-card-top">
        ${StatusGlyph(issue)}
        ${TypeGlyph(issue.issue_type)}
        <span class="c2-card-title">${issue.title}</span>
        ${Pip(issue.priority)}
      </div>
      <div class="c2-card-meta">
        <span class="c2-card-id">${id}</span>
        ${(issue.labels || []).slice(0, 3).map((l) => html`<span key=${l} class=${'c2-chip' + (l === 'triage' ? ' triage' : '')}>${l}</span>`)}
        ${issue.assignee && html`<span class="c2-assignee" title="Assignee">@${issue.assignee}</span>`}
        ${s === 'in_progress' && AgeChip(issue)}
        ${stale && html`<span class="c2-age c2-age-amber" title="No update in 21d+">stale</span>`}
      </div>
      ${!closed && html`
        <div class="c2-card-actions">
          ${issue.status !== 'in_progress' && html`<button class="c2-mini" title="Claim" onClick=${stop(() => actClaim(id))}>claim</button>`}
          ${issue.status !== 'in_progress' && html`<button class="c2-mini" title="Start" onClick=${stop(() => actStart(id))}>start</button>`}
          <button class="c2-mini" title="Defer" onClick=${stop(doDefer)}>defer</button>
          <button class="c2-mini" title="Close" onClick=${stop(doClose)}>close</button>
          <button class="c2-mini" title="Open detail" onClick=${stop(() => selectIssue(id))}>open →</button>
        </div>`}
    </div>`;
}

// focusSet, when non-null, is the authoritative set of issue ids the current
// Pulse/omnibar focus narrows to (see derive.js's focusedIds) — lanes whose
// items don't intersect it visibly empty out rather than just dimming, so
// the focus control has an actual, assertable effect on rendered card count.
function Lane({ laneKey, title, cls, items, focus, focusSet }) {
  const filtered = focusSet ? items.filter((i) => focusSet.has(i.id)) : items;
  const focused = focus && filtered.length > 0 && (focus === laneKey || focus === 'stale');
  const dimLane = !!focus && filtered.length === 0;
  return html`
    <section class=${'c2-lane lane-' + cls + (dimLane ? ' dim' : '') + (focused ? ' focus' : '')}>
      <header class="c2-lane-head">
        <span class="c2-lane-dot"></span>
        <span class="c2-lane-title">${title}</span>
        <span class="c2-lane-count">${filtered.length}</span>
      </header>
      <div class="c2-lane-body">
        ${filtered.length === 0
          ? html`<div class="c2-lane-empty">${focus ? 'no matches' : '—'}</div>`
          : filtered.map((i) => html`<${Card} key=${i.id} issue=${i} />`)}
      </div>
    </section>`;
}

// Same narrowing contract as Lane: focusSet non-null means "only show cards
// whose id is in this set." Progress pips still count against ALL children
// (not just the focused subset) so the epic's real completion state doesn't
// visually lie while a focus is active; rows (and the orphans section) that
// end up with zero visible cards under a focus are hidden entirely — that's
// the epic-grouped view's half of the focus-bug fix (previously this
// function never read c2.laneFocus / focusedIds at all).
function EpicRows({ focusSet }) {
  const issues = store.issues.value;
  const epics = issues.filter((i) => i.issue_type === 'epic');
  const rows = epics
    .map((e) => {
      const allKids = childrenOf(e.id);
      const kids = focusSet ? allKids.filter((k) => focusSet.has(k.id)) : allKids;
      const closed = allKids.filter((k) => k.status === 'closed').length;
      return { epic: e, kids, closed, total: allKids.length };
    })
    .filter((r) => !focusSet || r.kids.length > 0);
  const allOrphans = issues.filter((i) => i.issue_type !== 'epic' && !parentOf(i));
  const orphans = focusSet ? allOrphans.filter((o) => focusSet.has(o.id)) : allOrphans;
  return html`
    <div class="c2-epicrows">
      ${focusSet && rows.length === 0 && orphans.length === 0 && html`<div class="c2-lane-empty">No issues match this focus.</div>`}
      ${rows.map(({ epic, kids, closed, total }) => html`
        <section class="c2-epicrow" key=${epic.id}>
          <header class="c2-epicrow-head" onClick=${() => selectIssue(epic.id)}>
            ${StatusGlyph(epic)}
            ${TypeGlyph('epic')}
            <span class="c2-epicrow-title">${epic.title}</span>
            <span class="c2-epicrow-id">${epic.id}</span>
            <span class="c2-progress" title=${`${closed}/${total} closed`}>
              <span class="c2-progress-track">
                ${Array.from({ length: Math.max(total, 1) }).map((_, n) => html`<span key=${n} class=${'c2-progress-cell' + (n < closed ? ' on' : '')}></span>`)}
              </span>
              <span class="c2-progress-num">${closed}/${total}</span>
            </span>
          </header>
          <div class="c2-epicrow-body">
            ${kids.length === 0 ? html`<div class="c2-lane-empty">${focusSet ? 'no matches' : 'no children'}</div>`
              : kids.map((k) => html`<${Card} key=${k.id} issue=${k} />`)}
          </div>
        </section>`)}
      ${orphans.length > 0 && html`
        <section class="c2-epicrow" key="__orphans">
          <header class="c2-epicrow-head"><span class="c2-epicrow-title muted">Standalone</span><span class="c2-epicrow-id">${orphans.length}</span></header>
          <div class="c2-epicrow-body">${orphans.map((k) => html`<${Card} key=${k.id} issue=${k} />`)}</div>
        </section>`}
    </div>`;
}

export function Flow() {
  const L = lanes.value;
  const focus = c2.laneFocus.value;
  const focusSet = focusedIds.value;
  const epic = c2.epicGroup.value;
  const pid = store.projectId.value;
  return html`
    <div class="c2-flow">
      <div class="c2-flow-bar">
        <button class="c2-mini c2-grouptoggle" aria-pressed=${epic} onClick=${() => setEpicGroup(pid, !epic)}>
          ${epic ? 'Ungroup' : 'Group by epic'}
        </button>
        ${focus && html`<button class="c2-clearfocus" title="Clear focus" onClick=${() => (c2.laneFocus.value = null)}>focus: ${LANE_LABEL[focus] || focus} <span aria-hidden="true">✕</span></button>`}
      </div>
      ${epic
        ? html`<${EpicRows} focusSet=${focusSet} />`
        : html`<div class="c2-lanes">
            ${LANES.map(([key, title, cls]) => html`<${Lane} key=${key} laneKey=${key} title=${title} cls=${cls} items=${L[key]} focus=${focus} focusSet=${focusSet} />`)}
          </div>`}
    </div>`;
}
