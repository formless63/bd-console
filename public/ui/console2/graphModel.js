// console2/graphModel.js — pure dependency-graph derivation for MapView.
//
// Deliberately signal-free and store-free (only imports ../relationships.js,
// which is itself dependency-free — see that file's header) so the WHOLE
// edge model is importable and assertable from plain Node, exactly like
// relationships.js is for the direction invariant. This is what makes
// scripts/smoke.mjs's "layoutEdges excludes non-blocking types" assertion
// possible without spinning up a browser: `derive.js`'s `graphLayout()` is a
// thin wrapper that just calls `buildGraph(store.issues.value)` below.
//
// docs/beads-coverage.md Phase 2 — THE load-bearing split:
//   layoutEdges — BLOCKING_DEP_TYPES only (via relationships.js's blockersOf,
//     which already filters to that set). These alone feed the longest-path
//     layering + critical-chain passes below. If a non-blocking edge ever
//     influenced layering, "layer 0 = can start now" stops being true — so
//     layering logic here is UNCHANGED from the pre-Phase-2 implementation,
//     just relocated out of derive.js.
//   overlayEdges — every other PRESENT link type (related/relates-to fold
//     into one undirected 'related', plus discovered-from, tracks, caused-by,
//     validates, supersedes, duplicates), tagged with a display type, drawn
//     as non-layout-affecting curves between nodes the layout pass already
//     placed. An overlay edge whose endpoint isn't in the placed (non-closed)
//     node set is dropped — MapView only ever shows open work, so an edge to
//     a closed issue (e.g. a `supersedes` row, which lives on the
//     auto-closed retiring issue) simply has nowhere to render, same as
//     today's blocking edges.
import {
  blockersOf, dependenciesByType, RELATED_DEP_TYPES,
  SUPERSEDE_DEP_TYPE, DUPLICATE_DEP_TYPE,
} from '../relationships.js';

// Large repositories need a useful subset before they need the complete
// picture. This stays pure/store-free so the scope rules can be smoke-tested
// alongside the graph model below.
const parentId = (issue) => (issue.dependencies || []).find((d) => d.type === 'parent-child')?.depends_on_id || null;
const updatedAt = (issue) => new Date(issue.updated_at || issue.created_at || 0).getTime() || 0;

export function mapScopeIssues(issues, mode = 'current', epicId = null) {
  const open = (issues || []).filter((i) => i.status !== 'closed');
  if (mode === 'all') return open;

  const byId = new Map(open.map((i) => [i.id, i]));
  const ids = new Set();
  if (mode === 'epic' && epicId && byId.has(epicId)) {
    ids.add(epicId);
    // Include descendants, not just direct children: nested planning
    // structures should remain intact when an epic is selected.
    let changed = true;
    while (changed) {
      changed = false;
      for (const issue of open) {
        if (!ids.has(issue.id) && ids.has(parentId(issue))) { ids.add(issue.id); changed = true; }
      }
    }
  } else {
    // "Current work" means actively worked and urgent work. Cap the urgent
    // tail so a repo with years of P1s does not recreate the all-open hairball.
    const active = open.filter((i) => i.status === 'in_progress');
    const urgent = open
      .filter((i) => i.status !== 'in_progress' && Number(i.priority) <= 1)
      .sort((a, b) => Number(a.priority) - Number(b.priority) || updatedAt(b) - updatedAt(a))
      .slice(0, 24);
    [...active, ...urgent].forEach((i) => ids.add(i.id));

    // A quiet project still needs an entry point: show the most important,
    // recently touched open work instead of an unexplained empty graph.
    if (!ids.size) {
      open.slice().sort((a, b) => Number(a.priority) - Number(b.priority) || updatedAt(b) - updatedAt(a)).slice(0, 12)
        .forEach((i) => ids.add(i.id));
    }
  }

  // Pull in one dependency step around the focus. External blockers explain
  // why focused work is stuck; immediate dependents show what it unlocks.
  const focused = new Set(ids);
  for (const issue of open) {
    const blockers = blockersOf(issue);
    if (ids.has(issue.id)) blockers.forEach((id) => { if (byId.has(id)) focused.add(id); });
    if (blockers.some((id) => ids.has(id))) focused.add(issue.id);
  }
  // Keep the owning epic visible as context without pulling in all siblings.
  for (const id of [...focused]) {
    const parent = parentId(byId.get(id));
    if (parent && byId.has(parent)) focused.add(parent);
  }
  return open.filter((i) => focused.has(i.id));
}

// Raw dependency types eligible for the overlay layer: every `bd dep add
// --type` value that ISN'T in BLOCKING_DEP_TYPES, minus `parent-child`
// (hierarchy has its own dedicated surface — epic grouping in Flow — and
// isn't graphed as a MapView edge), plus the two state-transition types
// (`supersedes`, `duplicates`) that also aren't blockers.
export const OVERLAY_DEP_TYPES = Object.freeze([
  'tracks', 'related', 'relates-to', 'discovered-from', 'caused-by', 'validates',
  SUPERSEDE_DEP_TYPE, DUPLICATE_DEP_TYPE,
]);

// `related` and `relates-to` are the same human-level edge (see
// relationships.js's RELATED_DEP_TYPES) — fold both into one display/toggle
// type so a link drawn by either raw type renders and toggles as one thing.
function displayType(rawType) { return RELATED_DEP_TYPES.has(rawType) ? 'related' : rawType; }

// The distinct toggle-able overlay types a legend/checkbox row can ever show
// (i.e. `OVERLAY_DEP_TYPES` after folding related/relates-to together).
export const OVERLAY_TOGGLE_TYPES = Object.freeze([...new Set(OVERLAY_DEP_TYPES.map(displayType))]);

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

// Longest blocking path (by node count) through the open subgraph. Unchanged
// from the pre-Phase-2 implementation.
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

// Layered DAG layout + edge model for MAP over non-closed issues. Roots
// (nothing blocks them) on the left; blocker -> blocked edges point
// rightward. Longest-path layering + one barycenter ordering pass, computed
// from layoutEdges ONLY. Returns { nodes, layoutEdges, overlayEdges, width,
// height, criticalChain }.
export function buildGraph(issues) {
  const open = (issues || []).filter((i) => i.status !== 'closed');
  const set = new Set(open.map((i) => i.id));
  const m = new Map(open.map((i) => [i.id, i]));

  // ---- layoutEdges: blocking only (blockersOf already filters to
  // BLOCKING_DEP_TYPES) — `set.has(b)` drops closed/missing blockers, same
  // net effect as the old openBlockersOf() filter. ------------------------
  const inEdges = new Map();   // node -> [blockers]
  const outEdges = new Map();  // node -> [blocked dependents]
  for (const id of set) { inEdges.set(id, []); outEdges.set(id, []); }
  const layoutPairs = [];
  for (const i of open) {
    for (const b of blockersOf(i)) {
      if (!set.has(b)) continue;
      inEdges.get(i.id).push(b);
      outEdges.get(b).push(i.id);
      layoutPairs.push({ from: b, to: i.id });
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
  const layoutEdges = layoutPairs.map((e) => ({ ...e, a: pos.get(e.from), b: pos.get(e.to) }));

  // ---- overlayEdges: every other present type, non-layout-affecting -----
  const overlayEdges = [];
  const seenRelated = new Set();
  const seenDirected = new Set();
  const sortedIds = [...set].sort();
  for (const id of sortedIds) {
    const issue = m.get(id);
    for (const rawType of OVERLAY_DEP_TYPES) {
      const targets = dependenciesByType(issue, rawType);
      if (!targets.length) continue;
      const type = displayType(rawType);
      for (const target of targets) {
        if (target === id || !set.has(target)) continue;
        if (type === 'related') {
          const [a, b] = [id, target].sort();
          const key = a + '|' + b;
          if (seenRelated.has(key)) continue;
          seenRelated.add(key);
          overlayEdges.push({ from: a, to: b, type, a: pos.get(a), b: pos.get(b) });
        } else {
          const key = type + ':' + id + ':' + target;
          if (seenDirected.has(key)) continue;
          seenDirected.add(key);
          overlayEdges.push({ from: id, to: target, type, a: pos.get(id), b: pos.get(target) });
        }
      }
    }
  }

  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  const width = PAD * 2 + Math.max(1, cols.length) * COL_W;
  const height = PAD * 2 + maxRows * ROW_H;

  return { nodes, layoutEdges, overlayEdges, width, height, criticalChain: criticalChain(inEdges, set) };
}
