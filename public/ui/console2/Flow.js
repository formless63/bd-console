// console2/Flow.js — the default canvas: swim-lanes (Triage · Ready · In
// progress · Blocked · Done this week) of intent cards, plus an epic-grouping
// toggle that regroups everything into epic rows with layer-by-layer progress.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
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

// Rendering every card in a large project makes Flow slower and, more
// importantly, makes the current work indistinguishable from its history.
// Reveal cards in small, predictable batches. Counts always describe the full
// set, so this is presentation-only and never changes the underlying filter.
const REVEAL_BATCH = 12;
const CURRENT_INITIAL = 4;

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
         >
      <button class="c2-card-open" aria-label=${`Open ${issue.issue_type || 'issue'} ${id}: ${issue.title}`}
        aria-haspopup="dialog" onClick=${() => selectIssue(id)}>
        <span class="c2-card-top">
          ${StatusGlyph(issue)}
          ${TypeGlyph(issue.issue_type)}
          <span class="c2-card-title">${issue.title}</span>
          ${Pip(issue.priority)}
        </span>
        <span class="c2-card-meta">
          <span class="c2-card-id">${id}</span>
          ${(issue.labels || []).slice(0, 3).map((l) => html`<span key=${l} class=${'c2-chip' + (l === 'triage' ? ' triage' : '')}>${l}</span>`)}
          ${issue.assignee && html`<span class="c2-assignee" title="Assignee">@${issue.assignee}</span>`}
          ${s === 'in_progress' && AgeChip(issue)}
          ${stale && html`<span class="c2-age c2-age-amber" title="No update in 21d+">stale</span>`}
        </span>
      </button>
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
  const [limit, setLimit] = useState(REVEAL_BATCH);
  const filtered = focusSet ? items.filter((i) => focusSet.has(i.id)) : items;
  const shown = filtered.slice(0, limit);
  const remaining = filtered.length - shown.length;
  const focused = focus && filtered.length > 0 && (focus === laneKey || focus === 'stale');
  const dimLane = !!focus && filtered.length === 0;
  return html`
    <section class=${'c2-lane lane-' + cls + (dimLane ? ' dim' : '') + (focused ? ' focus' : '')}>
      <header class="c2-lane-head">
        <span class="c2-lane-dot"></span>
        <h2 class="c2-lane-title">${title}</h2>
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
          : html`
              ${shown.map((i) => html`<${Card} key=${i.id} issue=${i} />`)}
              ${remaining > 0 && html`
                <button class="c2-reveal" onClick=${() => setLimit(limit + REVEAL_BATCH)}>
                  Show ${Math.min(REVEAL_BATCH, remaining)} more
                  <span>${remaining} remaining</span>
                </button>`}
            `}
      </div>
    </section>`;
}

function stopEvent(fn) {
  return (e) => { e.stopPropagation(); fn(); };
}

// A container row deliberately separates current work from completed history.
// Completed containers stay visible as compact summaries, while active
// containers open with only their non-closed children. A status focus is an
// explicit request, so it bypasses history hiding (but keeps batched reveal).
function IssueGroup({ container, kids, closed, total, complete, focusActive, standalone = false }) {
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [currentLimit, setCurrentLimit] = useState(CURRENT_INITIAL);
  const [historyLimit, setHistoryLimit] = useState(REVEAL_BATCH);
  const current = kids.filter((i) => i.status !== 'closed');
  const history = kids.filter((i) => i.status === 'closed');
  const bodyOpen = focusActive || !complete || expanded;
  const showHistory = focusActive || historyOpen || (complete && expanded);
  const shownCurrent = current.slice(0, currentLimit);
  const shownHistory = showHistory ? history.slice(0, historyLimit) : [];
  const currentRemaining = current.length - shownCurrent.length;
  const historyRemaining = history.length - shownHistory.length;
  const visible = focusActive
    ? kids.slice(0, Math.max(currentLimit, historyLimit))
    : [...shownCurrent, ...shownHistory];
  const focusRemaining = focusActive ? kids.length - visible.length : 0;
  const title = standalone ? 'Standalone' : container.title;
  const rowId = standalone ? '__orphans' : container.id;
  const rowType = standalone ? '' : ' ct-' + container.issue_type;
  const statusSummary = focusActive
    ? `${kids.length} ${kids.length === 1 ? 'match' : 'matches'}`
    : `${current.length} active · ${history.length} complete`;
  const openDetail = standalone ? null : () => selectIssue(container.id);

  return html`
    <section class=${'c2-epicrow' + rowType + (standalone ? ' standalone' : '') + (complete && !bodyOpen ? ' collapsed' : '')}
      key=${rowId} aria-labelledby=${'c2-group-' + rowId}>
      <header class="c2-epicrow-head">
        ${standalone
          ? html`<h2 class="c2-epicrow-title muted" id=${'c2-group-' + rowId}>${title}</h2>`
          : html`<button class="c2-epicrow-open" onClick=${openDetail} aria-haspopup="dialog"
              aria-label=${`Open ${container.issue_type || 'group'} ${container.id}: ${title}`}>
              ${StatusGlyph(container)}
              ${TypeGlyph(container.issue_type)}
              <span class="c2-epicrow-title" id=${'c2-group-' + rowId}>${title}</span>
              <span class="c2-epicrow-id">${container.id}</span>
            </button>`}
        <span class="c2-epicrow-summary">${statusSummary}</span>
        ${!standalone && html`
          <span class="c2-progress" title=${`${closed}/${total} closed`}>
            <span class="c2-progress-track" aria-hidden="true">
              <span class="c2-progress-fill" style=${`width:${total ? Math.round((closed / total) * 100) : 0}%`}></span>
            </span>
            <span class="c2-progress-num">${closed}/${total}</span>
          </span>`}
        ${complete && history.length > 0 && !focusActive && html`
          <button class="c2-mini c2-rowtoggle" aria-expanded=${bodyOpen}
              onClick=${stopEvent(() => setExpanded(!expanded))}>
            ${expanded ? 'Collapse' : `Show ${history.length} completed`}
          </button>`}
      </header>
      ${bodyOpen && html`
        <div class="c2-epicrow-body">
          ${visible.length === 0
            ? (focusActive
              ? html`<div class="c2-lane-empty c2-gridwide">no matches</div>`
              : html`<${LearnEmpty} compact k="epic"
                  what=${'Nothing has been put inside "' + title + '" yet.'}
                  why="Open any issue, set its Parent to this one, and it will appear here with a progress bar across the whole group." />`)
            : visible.map((k) => html`<${Card} key=${k.id} issue=${k} />`)}
          ${!focusActive && currentRemaining > 0 && html`
            <button class="c2-reveal" onClick=${() => setCurrentLimit(currentLimit + REVEAL_BATCH)}>
              Show ${Math.min(REVEAL_BATCH, currentRemaining)} more active
              <span>${currentRemaining} remaining</span>
            </button>`}
          ${!focusActive && !showHistory && history.length > 0 && html`
            <button class="c2-reveal c2-history-reveal" aria-expanded="false" onClick=${() => setHistoryOpen(true)}>
              Show completed work
              <span>${history.length} hidden</span>
            </button>`}
          ${!focusActive && showHistory && historyRemaining > 0 && html`
            <button class="c2-reveal c2-history-reveal" onClick=${() => setHistoryLimit(historyLimit + REVEAL_BATCH)}>
              Show ${Math.min(REVEAL_BATCH, historyRemaining)} more completed
              <span>${historyRemaining} remaining</span>
            </button>`}
          ${!focusActive && showHistory && !complete && html`
            <button class="c2-reveal c2-history-hide" aria-expanded="true" onClick=${() => setHistoryOpen(false)}>
              Hide completed work
              <span>return to current work</span>
            </button>`}
          ${focusRemaining > 0 && html`
            <button class="c2-reveal" onClick=${() => {
              setCurrentLimit(currentLimit + REVEAL_BATCH);
              setHistoryLimit(historyLimit + REVEAL_BATCH);
            }}>
              Show ${Math.min(REVEAL_BATCH, focusRemaining)} more matches
              <span>${focusRemaining} remaining</span>
            </button>`}
        </div>`}
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
  // Grouping itself is relationships.js's containerGroups() — pure and
  // asserted in smoke. Containers are
  // epics AND poured-molecule roots, so a molecule gets its own row with its
  // steps nested instead of scattering across the orphan section.
  const { groups, orphans: allOrphans } = containerGroups(store.issues.value);
  const rows = groups
    .map(({ container, children, closed, total }) => ({
      epic: container,
      kids: focusSet ? children.filter((k) => focusSet.has(k.id)) : children,
      closed,
      total,
      // Do not collapse a container that still has current work even if its
      // own status was closed early. Empty closed containers and containers
      // whose children are all closed are completed summaries.
      complete: children.every((k) => k.status === 'closed') && (container.status === 'closed' || children.length > 0),
    }))
    .filter((r) => !focusSet || r.kids.length > 0)
    // Stable sort: preserve the project's container order within each bucket,
    // but make users pass current work before they reach completed summaries.
    .sort((a, b) => Number(a.complete) - Number(b.complete));
  const orphans = focusSet ? allOrphans.filter((o) => focusSet.has(o.id)) : allOrphans;
  const hiddenHistory = groups.reduce((n, g) => n + g.closed, 0)
    + allOrphans.filter((o) => o.status === 'closed').length;
  const completedSections = rows.filter((r) => r.complete).length
    + (allOrphans.length > 0 && allOrphans.every((o) => o.status === 'closed') ? 1 : 0);
  return html`
    <div class="c2-epicrows">
      ${!focusSet && hiddenHistory > 0 && html`
        <div class="c2-flow-scope">
          <strong>Current work first</strong>
          <span>${hiddenHistory} completed ${hiddenHistory === 1 ? 'item is' : 'items are'} available inside ${hiddenHistory === 1 ? 'its' : 'their'} groups${completedSections ? `; ${completedSections} completed ${completedSections === 1 ? 'group is' : 'groups are'} collapsed` : ''}.</span>
        </div>`}
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
      ${rows.map(({ epic, kids, closed, total, complete }) => html`
        <${IssueGroup} key=${epic.id} container=${epic} kids=${kids} closed=${closed} total=${total}
          complete=${complete} focusActive=${!!focusSet} />`)}
      ${orphans.length > 0 && html`
        <${IssueGroup} key="__orphans" kids=${orphans} closed=${orphans.filter((k) => k.status === 'closed').length}
          total=${orphans.length} complete=${orphans.every((k) => k.status === 'closed')}
          focusActive=${!!focusSet} standalone />`}
    </div>`;
}

export function Flow() {
  const L = lanes.value;
  const focus = c2.laneFocus.value;
  const focusSet = focusedIds.value;
  const epic = c2.epicGroup.value;
  const pid = store.projectId.value;
  // See Pulse.js's identical bootLoading — first load (or a project switch)
  // for this project, not a background refresh, which never re-triggers it
  // once c2.ready has latched for this project. Without this every lane
  // rendered its full "nothing here yet" teaching copy against a list that
  // simply hadn't arrived yet.
  const bootLoading = store.issuesLoading.value && !c2.ready.value;
  return html`
    <div class="c2-flow">
      <div class="c2-flow-bar">
        <button class="c2-mini c2-grouptoggle" aria-pressed=${epic} onClick=${() => setEpicGroup(pid, !epic)}>
          ${epic ? 'Ungroup' : 'Group by epic'}
        </button>
        <${ConceptDot} k="epic" />
        ${focus && html`<button class="c2-clearfocus" title="Clear focus" onClick=${() => (c2.laneFocus.value = null)}>focus: ${LANE_LABEL[focus] || focus} <span aria-hidden="true">✕</span></button>`}
      </div>
      ${bootLoading
        ? html`<div class="c2-lane-empty" aria-busy="true">Loading…</div>`
        : epic
          ? html`<${EpicRows} focusSet=${focusSet} />`
          : html`<div class="c2-lanes">
              ${LANES.map(([key, title, cls]) => html`<${Lane} key=${key} laneKey=${key} title=${title} cls=${cls} items=${L[key]} focus=${focus} focusSet=${focusSet} />`)}
            </div>`}
    </div>`;
}
