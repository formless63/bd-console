// console2/derive.js — pure, client-side derivations over the shared issue
// list: pulse stats, flow lanes, the dependency-graph layout for MAP, and the
// unblock hint / critical chain. All computed from store.issues so they stay in
// lockstep with the classic view's semantics (reusing store's relationship
// helpers verbatim).
import { computed } from '@preact/signals';
import {
  store, byId, effStatus, isReady, openBlockersOf, blockersOf,
  parentOf, childrenOf, blocksList,
} from '../store.js';
import { c2 } from './state.js';

export const DAY = 86400000;
export const STALE_DAYS = 21;
export const AGE_AMBER_H = 24;
export const AGE_RED_H = 72;

const ts = (s) => (s ? new Date(s).getTime() : 0);
export function ageMs(issue) { return Date.now() - ts(issue.updated_at || issue.created_at); }
export function hasLabel(issue, l) { return (issue.labels || []).includes(l); }

// A workable "ready" item: open, no open blockers, and not an epic (epics are
// containers, not pickup work).
export function isPickup(issue) { return isReady(issue) && issue.issue_type !== 'epic'; }
export function isStale(issue) {
  return issue.status !== 'closed' && ageMs(issue) > STALE_DAYS * DAY;
}

// The five flow lanes, computed once.
export const lanes = computed(() => {
  const issues = store.issues.value;
  const weekAgo = Date.now() - 7 * DAY;
  const triage = [], ready = [], progress = [], blocked = [], done = [];
  for (const i of issues) {
    const s = effStatus(i);
    if (s === 'closed') {
      if (ts(i.closed_at || i.updated_at) >= weekAgo) done.push(i);
      continue;
    }
    if (s === 'in_progress') { progress.push(i); continue; }
    if (s === 'blocked') { blocked.push(i); continue; }
    // open + unblocked
    if (hasLabel(i, 'triage')) triage.push(i);
    else if (i.issue_type !== 'epic') ready.push(i);
    else ready.push(i); // epics live in Ready too but sort last
  }
  const byPri = (a, b) => a.priority - b.priority || a.id.localeCompare(b.id);
  const epicLast = (a, b) => (a.issue_type === 'epic') - (b.issue_type === 'epic') || byPri(a, b);
  return {
    triage: triage.sort(byPri),
    ready: ready.sort(epicLast),
    in_progress: progress.sort(byPri),
    blocked: blocked.sort(byPri),
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

// Layered DAG layout for MAP over non-closed issues. Roots (nothing blocks
// them) on the left; blocker → blocked edges point rightward. Longest-path
// layering + one barycenter ordering pass. Returns nodes with {col,row,x,y}.
export function graphLayout() {
  const issues = store.issues.value.filter((i) => i.status !== 'closed');
  const set = new Set(issues.map((i) => i.id));
  const m = byId.value;

  // edges: blocker -> blocked (both in set)
  const inEdges = new Map();   // node -> [blockers]
  const outEdges = new Map();  // node -> [blocked dependents]
  for (const id of set) { inEdges.set(id, []); outEdges.set(id, []); }
  const edges = [];
  for (const i of issues) {
    for (const b of openBlockersOf(i)) {
      if (!set.has(b)) continue;
      inEdges.get(i.id).push(b);
      outEdges.get(b).push(i.id);
      edges.push({ from: b, to: i.id });
    }
  }

  // longest-path layer via memoised DFS (graph is a DAG in practice)
  const layer = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (layer.has(id)) return layer.get(id);
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    let d = 0;
    for (const b of inEdges.get(id)) d = Math.max(d, depth(b) + 1);
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const id of set) depth(id);

  // group by column
  const cols = [];
  for (const id of set) {
    const c = layer.get(id);
    (cols[c] || (cols[c] = [])).push(id);
  }

  // initial order: priority then id
  for (const c of cols) c.sort((a, b) => {
    const ia = m.get(a), ib = m.get(b);
    return ia.priority - ib.priority || a.localeCompare(b);
  });

  // barycenter pass (order each column by mean row of its blockers)
  const rowOf = new Map();
  cols.forEach((c) => c.forEach((id, r) => rowOf.set(id, r)));
  for (let c = 1; c < cols.length; c++) {
    cols[c].sort((a, b) => {
      const ba = mean(inEdges.get(a).map((x) => rowOf.get(x) ?? 0));
      const bb = mean(inEdges.get(b).map((x) => rowOf.get(x) ?? 0));
      return ba - bb || (m.get(a).priority - m.get(b).priority);
    });
    cols[c].forEach((id, r) => rowOf.set(id, r));
  }

  // geometry
  const COL_W = 210, ROW_H = 92, PAD = 40;
  const nodes = [];
  cols.forEach((c, ci) => c.forEach((id, ri) => {
    nodes.push({
      id, issue: m.get(id), col: ci, row: ri,
      x: PAD + ci * COL_W, y: PAD + ri * ROW_H,
    });
  }));
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const laidEdges = edges.map((e) => ({ ...e, a: pos.get(e.from), b: pos.get(e.to) }));

  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  const width = PAD * 2 + Math.max(1, cols.length) * COL_W;
  const height = PAD * 2 + maxRows * ROW_H;

  return { nodes, edges: laidEdges, width, height, criticalChain: criticalChain(inEdges, set) };
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

// Longest blocking path (by node count) through the open subgraph.
function criticalChain(inEdges, set) {
  const memo = new Map();
  const prev = new Map();
  const visiting = new Set();
  const len = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 1;
    visiting.add(id);
    let best = 1, p = null;
    for (const b of inEdges.get(id)) {
      const l = len(b) + 1;
      if (l > best) { best = l; p = b; }
    }
    visiting.delete(id);
    memo.set(id, best); prev.set(id, p);
    return best;
  };
  let tail = null, max = 0;
  for (const id of set) { const l = len(id); if (l > max) { max = l; tail = id; } }
  const chain = new Set();
  let cur = tail;
  while (cur) { chain.add(cur); cur = prev.get(cur); }
  return max > 1 ? chain : new Set();
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

export { byId, effStatus, isReady, openBlockersOf, blockersOf, parentOf, childrenOf, blocksList };
