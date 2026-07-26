// console2/Flow.js — the default canvas: swim-lanes (Triage · Ready · In
// progress · Blocked · Done this week) of intent cards, plus an epic-grouping
// toggle that regroups everything into epic rows with layer-by-layer progress.
import { html } from 'htm/preact';
import { store, selectIssue, effStatus, containerGroups } from '../store.js';
import { c2, setEpicGroup } from './state.js';
import { lanes, isStale, focusedIds, LANE_LABEL } from './derive.js';
import { actClaim, actStart, actClose, actDefer } from './actions.js';
import { TypeGlyph, Pip, AgeChip, StatusGlyph, glyphStatus } from './ui.js';
import { LearnEmpty, ConceptDot } from '../components/ConceptTip.js';

const LANES = [
  ['triage', 'Triage', 'triage'],
  ['ready', 'Ready', 'ready'],
  ['in_progress', 'In progress', 'in_progress'],
  ['blocked', 'Blocked', 'blocked'],
  ['deferred', 'Deferred', 'deferred'],
  ['done', 'Done · 7d', 'done'],
];

// An empty lane is the best teaching moment in the app: the user is looking
// straight at a labelled box with nothing in it and wondering what it is for.
// One line on what belongs here, one on why it matters, and — where there is
// an unambiguous next move — one button. `emptyGood` marks the lanes whose
// emptiness is a success (nothing blocked, nothing stale) rather than a gap,
// so the copy congratulates instead of instructing.
const LANE_EMPTY = {
  triage: {
    concept: 'triage',
    what: 'Half-formed thoughts land here.',
    why: 'Type anything into the box at the top and press Enter — it arrives here instead of being lost, and you can sort it out later.',
  },
  ready: {
    concept: 'ready',
    what: 'Work you could pick up right now shows up here.',
    why: 'A piece of work is ready when nothing it depends on is still open. Nothing is here yet — either everything is done, or everything is waiting on something else.',
  },
  in_progress: {
    concept: 'in_progress',
    what: 'Whatever is being worked on right now sits here.',
    why: 'Press claim on a card to put your name on it and move it here — it tells everyone else where you are, and starts the clock so nothing quietly ages.',
  },
  blocked: {
    concept: 'blocked',
    what: 'Nothing is waiting on anything else. Good.',
    why: 'When you record that one piece of work blocks another, the blocked one lands here and leaves again by itself the moment its blocker closes.',
    emptyGood: true,
  },
  done: {
    concept: 'closed',
    what: 'Everything closed in the last seven days appears here.',
    why: 'It is the only honest answer to "what did we actually get done this week", and it empties itself as things age out.',
  },
};

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
          ? (focus
            // A focus narrowing a lane to nothing is a filter result, not an
            // empty section — explaining what the lane is for here would be
            // answering a question the user didn't ask.
            ? html`<div class="c2-lane-empty">no matches</div>`
            : html`<${LearnEmpty} compact k=${LANE_EMPTY[laneKey]?.concept}
                what=${LANE_EMPTY[laneKey]?.what || 'Nothing here yet.'}
                why=${LANE_EMPTY[laneKey]?.why} />`)
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
  // Grouping itself is relationships.js's containerGroups() — pure, shared
  // with the classic view's semantics and asserted in smoke. Containers are
  // epics AND poured-molecule roots, so a molecule gets its own row with its
  // steps nested instead of scattering across the orphan section.
  const { groups, orphans: allOrphans } = containerGroups(store.issues.value);
  const rows = groups
    .map(({ container, children, closed, total }) => ({
      epic: container,
      kids: focusSet ? children.filter((k) => focusSet.has(k.id)) : children,
      closed,
      total,
    }))
    .filter((r) => !focusSet || r.kids.length > 0);
  const orphans = focusSet ? allOrphans.filter((o) => focusSet.has(o.id)) : allOrphans;
  return html`
    <div class="c2-epicrows">
      ${focusSet && rows.length === 0 && orphans.length === 0 && html`<div class="c2-lane-empty">No issues match this focus.</div>`}
      ${/* Grouping is ON by default, so a project that has never made an epic
            lands here and sees a single "Standalone" pile with nothing
            explaining what the grouping it just asked for would have done.
            One block, only while there is genuinely nothing to group, that
            says what an epic is for and offers to make one. Vanishes the
            instant the first epic exists. */ ''}
      ${!focusSet && rows.length === 0 && orphans.length > 0 && html`
        <${LearnEmpty} k="epic" icon="◆"
          what="Nothing has been grouped yet, so everything is in one pile below."
          why="An epic is an issue whose job is to hold other issues. Make one, set it as the parent of a few of these, and this view becomes one row per epic with its own progress bar."
          actionLabel="Create an epic"
          onAction=${() => { store.createOpen.value = true; }} />`}
      ${rows.map(({ epic, kids, closed, total }) => html`
        <section class=${'c2-epicrow ct-' + epic.issue_type} key=${epic.id}>
          <header class="c2-epicrow-head" onClick=${() => selectIssue(epic.id)}>
            ${StatusGlyph(epic)}
            ${TypeGlyph(epic.issue_type)}
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
            ${kids.length === 0
              ? (focusSet
                ? html`<div class="c2-lane-empty">no matches</div>`
                : html`<${LearnEmpty} compact k="epic"
                    what=${'Nothing has been put inside "' + epic.title + '" yet.'}
                    why="Open any issue, set its Parent to this one, and it will appear here with a progress bar across the whole group." />`)
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
        <${ConceptDot} k="epic" />
        ${focus && html`<button class="c2-clearfocus" title="Clear focus" onClick=${() => (c2.laneFocus.value = null)}>focus: ${LANE_LABEL[focus] || focus} <span aria-hidden="true">✕</span></button>`}
      </div>
      ${epic
        ? html`<${EpicRows} focusSet=${focusSet} />`
        : html`<div class="c2-lanes">
            ${LANES.map(([key, title, cls]) => html`<${Lane} key=${key} laneKey=${key} title=${title} cls=${cls} items=${L[key]} focus=${focus} focusSet=${focusSet} />`)}
          </div>`}
    </div>`;
}
