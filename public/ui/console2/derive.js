// console2/derive.js — pure, client-side derivations over the shared issue
// list: pulse stats, flow lanes, the dependency-graph layout for MAP, and the
// unblock hint / critical chain. All computed from store.issues so they stay in
// lockstep with the classic view's semantics (reusing store's relationship
// helpers verbatim).
import { computed } from '@preact/signals';
import {
  store, byId, effStatus, isReady, openBlockersOf, blockersOf,
  parentOf, childrenOf, blocksList, isContainer,
} from '../store.js';
import { c2 } from './state.js';
import { buildGraph, OVERLAY_DEP_TYPES, OVERLAY_TOGGLE_TYPES } from './graphModel.js';
export { OVERLAY_DEP_TYPES, OVERLAY_TOGGLE_TYPES };

export const DAY = 86400000;
export const STALE_DAYS = 21;
export const AGE_AMBER_H = 24;
export const AGE_RED_H = 72;

const ts = (s) => (s ? new Date(s).getTime() : 0);
export function ageMs(issue) { return Date.now() - ts(issue.updated_at || issue.created_at); }
export function hasLabel(issue, l) { return (issue.labels || []).includes(l); }

// A workable "ready" item: open, no open blockers, and not a CONTAINER —
// epics and molecule roots both exist to hold steps, not to be picked up.
export function isPickup(issue) { return isReady(issue) && !isContainer(issue); }
export function isStale(issue) {
  return issue.status !== 'closed' && ageMs(issue) > STALE_DAYS * DAY;
}

// The five flow lanes, computed once.
export const lanes = computed(() => {
  const issues = store.issues.value;
  const weekAgo = Date.now() - 7 * DAY;
  const triage = [], ready = [], progress = [], blocked = [], done = [], deferred = [];
  for (const i of issues) {
    const s = effStatus(i);
    if (s === 'closed') {
      if (ts(i.closed_at || i.updated_at) >= weekAgo) done.push(i);
      continue;
    }
    if (s === 'in_progress') { progress.push(i); continue; }
    if (s === 'blocked') { blocked.push(i); continue; }
    // `bd update --defer` sets status to 'deferred' (with defer_until). Without
    // this branch a deferred issue matched none of the checks above and fell
    // into Ready — visible and claimable on the primary screen, while the
    // pulse's Ready tile (which keys off isReady, i.e. status === 'open')
    // correctly excluded it, so the lane and the count disagreed. Deferred work
    // is deliberately not-now: it gets its own lane rather than being hidden,
    // so "I deferred that" stays visible without polluting Ready.
    if (s === 'deferred') { deferred.push(i); continue; }
    // open + unblocked
    if (hasLabel(i, 'triage')) triage.push(i);
    else ready.push(i); // containers (epic/molecule) live in Ready too, sorted last
  }
  const byPri = (a, b) => a.priority - b.priority || a.id.localeCompare(b.id);
  const containerLast = (a, b) => isContainer(a) - isContainer(b) || byPri(a, b);
  return {
    triage: triage.sort(byPri),
    ready: ready.sort(containerLast),
    in_progress: progress.sort(byPri),
    blocked: blocked.sort(byPri),
    deferred: deferred.sort((a, b) => ts(a.defer_until) - ts(b.defer_until) || byPri(a, b)),
    done: done.sort((a, b) => ts(b.closed_at) - ts(a.closed_at)),
  };
});

// Pulse numbers — every field is reproduced by the puppeteer test's own math.
export const pulse = computed(() => {
  const issues = store.issues.value;
  const readyN = issues.filter(isPickup).length;
  const inProg = issues.filter((i) => effStatus(i) === 'in_progress');
  const blocked = issues.filter((i) => effStatus(i) === 'blocked');
  const triage = issues.filter((i) => i.status !== 'closed' && hasLabel(i, 'triage'));
  const stale = issues.filter(isStale);

  // priority distribution over non-closed issues
  const pri = [0, 0, 0, 0, 0];
  for (const i of issues) if (i.status !== 'closed') pri[i.priority] = (pri[i.priority] || 0) + 1;

  // weekly velocity (closed per week, 8 buckets, oldest→newest)
  const weeks = 8;
  const vel = new Array(weeks).fill(0);
  const now = Date.now();
  for (const i of issues) {
    if (i.status !== 'closed') continue;
    const t = ts(i.closed_at || i.updated_at);
    if (!t) continue;
    const wk = Math.floor((now - t) / (7 * DAY));
    if (wk >= 0 && wk < weeks) vel[weeks - 1 - wk] += 1;
  }

  return {
    ready: readyN,
    inProgress: inProg,
    blocked: blocked,
    triage: triage.length,
    stale: stale.length,
    priority: pri,
    velocity: vel,
    unblock: unblockHint(),
  };
});

// The single open issue whose closure would flip the most currently-blocked
// issues to ready (i.e. it is their ONLY open blocker).
export function unblockHint() {
  const issues = store.issues.value;
  const m = byId.value;
  const gain = new Map(); // candidateId -> count
  for (const i of issues) {
    if (effStatus(i) !== 'blocked') continue;
    const ob = openBlockersOf(i);
    if (ob.length === 1) {
      const c = ob[0];
      gain.set(c, (gain.get(c) || 0) + 1);
    }
  }
  let best = null;
  for (const [id, count] of gain) {
    if (!best || count > best.count) best = { id, count, issue: m.get(id) };
  }
  return best;
}

// Layered DAG layout + edge model for MAP over non-closed issues. Thin
// signal-reading wrapper: all the actual derivation (layering, critical
// chain, layoutEdges-vs-overlayEdges split) lives in the pure, store-free
// graphModel.js so it can be unit-tested from plain Node (see
// scripts/smoke.mjs) without a signals runtime. Returns
// { nodes, layoutEdges, overlayEdges, width, height, criticalChain }.
export function graphLayout(issues = store.issues.value) {
  return buildGraph(issues);
}

// ---------------------------------------------------------------------------
// Focus (Pulse stat click / omnibar view command) — the single source of
// truth for "which issues does the current lane/status focus narrow Flow
// to." Both the ungrouped lanes and the epic-grouped rows read this so a
// focus set from either surface visibly narrows both render paths (fixes:
// focus previously only dimmed the ungrouped lanes via CSS and had no effect
// at all on the epic-grouped view, which never read c2.laneFocus).
// Returns null when no focus is active (render everything), else a Set of
// matching issue ids.
export const focusedIds = computed(() => {
  const focus = c2.laneFocus.value;
  if (!focus) return null;
  if (focus === 'stale') return new Set(store.issues.value.filter(isStale).map((i) => i.id));
  const L = lanes.value;
  return new Set((L[focus] || []).map((i) => i.id));
});

export const LANE_LABEL = {
  triage: 'Triage', ready: 'Ready', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', stale: 'Stale · 21d+',
};

export { byId, effStatus, isReady, openBlockersOf, blockersOf, parentOf, childrenOf, blocksList, isContainer };
