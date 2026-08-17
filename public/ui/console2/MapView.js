// console2/MapView.js — dependency graph of open issues as a layered SVG DAG.
// Roots left, dependents right; blocker→blocked edges as curves. Pan/zoom via a
// wheel+drag transform, no libraries. Hovering a node lights its full up/down
// stream blocking chain; the longest blocking path (critical chain) is always
// emphasized.
//
// docs/beads-coverage.md Phase 2: alongside the blocking DAG above, MapView
// also draws OVERLAY edges (related/tracks/discovered-from/caused-by/
// validates/supersedes/duplicates) — non-blocking link types that do NOT
// affect layering (see graphModel.js's buildGraph). They're toggled per type
// via the compact control in the toolbar, default to blocking+related only
// (the doc's own rationale: all ~7 overlay types at once is unreadable), and
// persist per-project in localStorage (console2/state.js).
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, selectIssue } from '../store.js';
import { graphLayout, OVERLAY_TOGGLE_TYPES, filteredIssues } from './derive.js';
import { mapScopeIssues } from './graphModel.js';
import { c2, loadMapOverlayPref, setMapOverlayPref } from './state.js';
import { TYPE_GLYPH, glyphStatus, STATUS_GLYPH_CHAR, STATUS_GLYPH_LABEL } from './ui.js';
import { LearnEmpty, ConceptDot } from '../components/ConceptTip.js';

const NODE_W = 168, NODE_H = 54;
const ZOOM_MIN = 0.3, ZOOM_MAX = 2.4;

// Overlay types that read as a symmetric "see also" edge get no arrowhead;
// every other present overlay type is directional and keeps one.
const SYMMETRIC_OVERLAY_TYPES = new Set(['related']);
const OVERLAY_TYPE_LABEL = {
  related: 'Related', tracks: 'Tracks', 'discovered-from': 'Discovered from',
  'caused-by': 'Caused by', validates: 'Validates', supersedes: 'Supersedes', duplicates: 'Duplicates',
};

function dist(t0, t1) { return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY); }
function mid(t0, t1) { return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 }; }

function chainFrom(id, edges) {
  // gather up + downstream reachable from id over BLOCKING edges only
  const up = new Map(), down = new Map();
  for (const e of edges) {
    (up.get(e.to) || up.set(e.to, []).get(e.to)).push(e.from);
    (down.get(e.from) || down.set(e.from, []).get(e.from)).push(e.to);
  }
  const walk = (start, m, acc) => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      for (const nxt of (m.get(cur) || [])) if (!acc.has(nxt)) { acc.add(nxt); stack.push(nxt); }
    }
  };
  const acc = new Set([id]);
  walk(id, up, acc); walk(id, down, acc);
  return acc;
}

// Direct overlay neighbors of `id` among the currently-VISIBLE overlay edges
// (i.e. after the toggle-set filter). Deliberately NOT transitive — the
// spec calls for lighting "visible overlay neighbors", not a whole connected
// component (which for a busy `related` web could be most of the graph).
function overlayNeighborsOf(id, visibleOverlayEdges) {
  const out = new Set();
  for (const e of visibleOverlayEdges) {
    if (e.from === id) out.add(e.to);
    else if (e.to === id) out.add(e.from);
  }
  return out;
}

// Cubic curve for a layout (blocking) edge: right edge of `a` to left edge of
// `b` — unchanged from the pre-Phase-2 rendering, since layout guarantees `a`
// is strictly left of `b`.
function layoutPath(e) {
  const x1 = e.a.x + NODE_W, y1 = e.a.y + NODE_H / 2;
  const x2 = e.b.x, y2 = e.b.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

// Bowed curve for an overlay edge, between arbitrary (not necessarily
// left-to-right) node positions — pulled back off each node's center so an
// arrowhead lands outside the node box instead of underneath it, and bowed
// perpendicular to the a→b line so it never overlaps a straight layout edge
// running between the same two columns.
function overlayPath(e) {
  const ax = e.a.x + NODE_W / 2, ay = e.a.y + NODE_H / 2;
  const bx = e.b.x + NODE_W / 2, by = e.b.y + NODE_H / 2;
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const pullback = NODE_W / 2 + 12;
  const sx = ax + ux * pullback, sy = ay + uy * pullback;
  const ex = bx - ux * pullback, ey = by - uy * pullback;
  const nx = -uy, ny = ux;
  const bow = Math.min(46, len * 0.22);
  const cx = (sx + ex) / 2 + nx * bow, cy = (sy + ey) / 2 + ny * bow;
  return `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
}

export function MapView() {
  // FilterBar's narrowing (console2/filters.js), not the raw project issue
  // list — every scope mode below (current epic / whole project) and the
  // epic picker itself are built from whatever FilterBar currently shows, so
  // Map respects an active filter combination the same way Flow does.
  const issues = filteredIssues.value; // subscribe
  const [scopeMode, setScopeMode] = useState('current');
  const [epicId, setEpicId] = useState('');
  const [displayMode, setDisplayMode] = useState('graph');
  const openIssues = useMemo(() => issues.filter((i) => i.status !== 'closed'), [issues]);
  const epics = useMemo(() => openIssues
    .filter((i) => i.issue_type === 'epic' || i.issue_type === 'molecule')
    .sort((a, b) => Number(a.priority) - Number(b.priority) || a.title.localeCompare(b.title)), [openIssues]);
  const effectiveEpicId = epicId || epics[0]?.id || '';
  const scopedIssues = useMemo(() => mapScopeIssues(issues, scopeMode, effectiveEpicId), [issues, scopeMode, effectiveEpicId]);
  const layout = useMemo(() => graphLayout(scopedIssues), [scopedIssues]);
  const { nodes, layoutEdges, overlayEdges, width, height, criticalChain } = layout;

  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState(null);
  const drag = useRef(null);
  const pinch = useRef(null);
  const svgRef = useRef(null);

  useEffect(() => {
    setScopeMode('current');
    setEpicId('');
    setDisplayMode('graph');
  }, [store.projectId.value]);

  useEffect(() => { setView({ x: 0, y: 0, k: 1 }); }, [scopeMode, effectiveEpicId]);

  // Per-project overlay-type toggle set — loaded on project switch, then
  // read reactively off c2.mapOverlayTypes (subscribed via .value below).
  useEffect(() => {
    c2.mapOverlayTypes.value = loadMapOverlayPref(store.projectId.value);
  }, [store.projectId.value]);
  const enabledOverlay = c2.mapOverlayTypes.value;
  // Reads c2.mapOverlayTypes.value FRESH at click time rather than closing
  // over the `enabledOverlay` render-scoped snapshot above — two toggles
  // clicked in quick succession (e.g. an automated "enable all" pass, or
  // just a fast double-click) would otherwise both compute `next` from the
  // same stale pre-render Set and the second click's write would silently
  // clobber the first's.
  const toggleOverlayType = (type) => {
    const next = new Set(c2.mapOverlayTypes.value);
    next.has(type) ? next.delete(type) : next.add(type);
    setMapOverlayPref(store.projectId.value, next);
  };

  // Only offer toggles/legend entries for types with at least one edge in
  // the CURRENT graph — never render a checkbox for a type with zero edges.
  const overlayCounts = new Map();
  for (const e of overlayEdges) overlayCounts.set(e.type, (overlayCounts.get(e.type) || 0) + 1);
  const presentOverlayTypes = OVERLAY_TOGGLE_TYPES.filter((t) => overlayCounts.has(t));
  const visibleOverlayEdges = overlayEdges.filter((e) => enabledOverlay.has(e.type));

  const highlight = hover ? chainFrom(hover, layoutEdges) : null;
  const overlayHighlight = hover ? overlayNeighborsOf(hover, visibleOverlayEdges) : null;

  const onWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => ({ ...v, k: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * factor)) }));
  };
  const onDown = (e) => { drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y }; };
  const onMove = (e) => {
    if (!drag.current) return;
    setView((v) => ({ ...v, x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) }));
  };
  const onUp = () => { drag.current = null; };
  const reset = () => setView({ x: 0, y: 0, k: 1 });
  const zoomBy = (factor) => setView((v) => ({ ...v, k: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * factor)) }));

  // Touch: single-finger drag pans, two-finger pinch zooms. Registered via a
  // manual effect (not onTouchX props) so we can pass { passive: false } —
  // that's required to preventDefault() and stop the page from scrolling
  // under the gesture; JSX's onTouchMove is passive by default in Preact.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const touchStart = (e) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        drag.current = { x: t.clientX, y: t.clientY, ox: view.x, oy: view.y };
        pinch.current = null;
      } else if (e.touches.length === 2) {
        drag.current = null;
        pinch.current = { d0: dist(e.touches[0], e.touches[1]), k0: view.k, ox: view.x, oy: view.y, m0: mid(e.touches[0], e.touches[1]) };
      }
    };
    const touchMove = (e) => {
      if (e.touches.length === 2 && pinch.current) {
        e.preventDefault();
        const d1 = dist(e.touches[0], e.touches[1]);
        const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinch.current.k0 * (d1 / (pinch.current.d0 || 1))));
        setView((v) => ({ ...v, k }));
      } else if (e.touches.length === 1 && drag.current) {
        e.preventDefault();
        const t = e.touches[0];
        setView((v) => ({ ...v, x: drag.current.ox + (t.clientX - drag.current.x), y: drag.current.oy + (t.clientY - drag.current.y) }));
      }
    };
    const touchEnd = (e) => {
      if (e.touches.length === 0) { drag.current = null; pinch.current = null; }
      else if (e.touches.length === 1) {
        // dropped from pinch to single-finger — restart drag baseline cleanly
        const t = e.touches[0];
        drag.current = { x: t.clientX, y: t.clientY, ox: view.x, oy: view.y };
        pinch.current = null;
      }
    };
    el.addEventListener('touchstart', touchStart, { passive: true });
    el.addEventListener('touchmove', touchMove, { passive: false });
    el.addEventListener('touchend', touchEnd, { passive: true });
    el.addEventListener('touchcancel', touchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', touchStart);
      el.removeEventListener('touchmove', touchMove);
      el.removeEventListener('touchend', touchEnd);
      el.removeEventListener('touchcancel', touchEnd);
    };
  }, [view.x, view.y, view.k]);

  const layoutEdge = (e, i) => {
    const d = layoutPath(e);
    const onChain = criticalChain.has(e.from) && criticalChain.has(e.to);
    const lit = highlight && highlight.has(e.from) && highlight.has(e.to);
    const dim = highlight && !lit;
    return html`<path key=${'l' + i} d=${d} class=${'c2-edge' + (onChain ? ' crit' : '') + (lit ? ' lit' : '') + (dim ? ' dim' : '')} marker-end="url(#c2arrow)" />`;
  };

  const overlayEdge = (e, i) => {
    const d = overlayPath(e);
    const lit = overlayHighlight && (e.from === hover || e.to === hover);
    const dim = hover && !lit;
    const symmetric = SYMMETRIC_OVERLAY_TYPES.has(e.type);
    const cls = 'c2-edge c2-edge-overlay c2-edge-type-' + e.type + (lit ? ' ov-lit' : '') + (dim ? ' dim' : '');
    return html`<path key=${'o' + i} d=${d} class=${cls} marker-end=${symmetric ? undefined : `url(#c2arrow-ov-${e.type})`} />`;
  };

  const node = (n) => {
    // Status determines both the node's outline color (existing .c2-node.st-*
    // rules) AND a shape-distinct glyph in the top-right corner (colorblind
    // safety — never color alone). glyphStatus splits effStatus's plain
    // "open" into ready/deferred so nodes actually get distinguished; closed
    // issues never reach here (graphLayout only lays out non-closed issues).
    // TYPE_GLYPH falls back to a plain bullet for any issue_type it doesn't
    // recognize (e.g. `molecule`), so an unfamiliar type renders, not crashes.
    const s = glyphStatus(n.issue);
    const onChain = criticalChain.has(n.id);
    const litBlocking = highlight && highlight.has(n.id);
    const litOverlay = overlayHighlight && overlayHighlight.has(n.id);
    const dim = hover && !litBlocking && !litOverlay;
    const scale = 1 + (4 - n.issue.priority) * 0.04; // higher priority (lower number) = bigger
    const w = NODE_W * scale, h = NODE_H * scale;
    return html`
      <g key=${n.id} transform=${`translate(${n.x - (w - NODE_W) / 2} ${n.y - (h - NODE_H) / 2})`}
         class=${'c2-node st-' + s + (onChain ? ' crit' : '') + (litBlocking ? ' lit' : '') + (litOverlay ? ' ov-lit' : '') + (dim ? ' dim' : '')}
         onMouseEnter=${() => setHover(n.id)} onMouseLeave=${() => setHover(null)}
         onFocus=${() => setHover(n.id)} onBlur=${() => setHover(null)}
         role="button" tabIndex="0" aria-haspopup="dialog" aria-label=${`${n.issue.title}. ${STATUS_GLYPH_LABEL[s] || s}. Open issue ${n.id}`}
         onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectIssue(n.id); } }}
         onClick=${() => selectIssue(n.id)} style="cursor:pointer">
        <rect width=${w} height=${h} rx="10" class="c2-node-box" />
        <text x="12" y="21" class="c2-node-glyph">${TYPE_GLYPH[n.issue.issue_type] || '●'}</text>
        <text x="30" y="21" class="c2-node-id">${n.id}</text>
        <text x="12" y="39" class="c2-node-title">${(n.issue.title || '').slice(0, 22)}</text>
        <text x=${w - 16} y="15" class=${'c2-node-mark st-' + s}>${STATUS_GLYPH_CHAR[s] || STATUS_GLYPH_CHAR.open}<title>${STATUS_GLYPH_LABEL[s] || s}</title></text>
      </g>`;
  };

  const directionalTypes = OVERLAY_TOGGLE_TYPES.filter((t) => !SYMMETRIC_OVERLAY_TYPES.has(t));

  const listRows = nodes.slice().sort((a, b) => Number(a.issue.priority) - Number(b.issue.priority) || a.id.localeCompare(b.id));
  const blockingIn = new Map(), blockingOut = new Map();
  for (const e of layoutEdges) {
    (blockingIn.get(e.to) || blockingIn.set(e.to, []).get(e.to)).push(e.from);
    (blockingOut.get(e.from) || blockingOut.set(e.from, []).get(e.from)).push(e.to);
  }

  const setScope = (mode) => {
    if (mode === 'epic' && !effectiveEpicId) return;
    setScopeMode(mode);
  };

  return html`
    <div class="c2-map">
      <div class="c2-map-toolbar">
        <h2 class="c2-hud-label">Dependency map<${ConceptDot} k="blocks" /></h2>
        <span class="c2-map-scope-count">${nodes.length} of ${openIssues.length} open</span>
        <div class="c2-map-viewtoggle" role="group" aria-label="Map display">
          <button class=${'c2-mini' + (displayMode === 'graph' ? ' active' : '')} aria-pressed=${displayMode === 'graph'} onClick=${() => setDisplayMode('graph')}>Graph</button>
          <button class=${'c2-mini' + (displayMode === 'list' ? ' active' : '')} aria-pressed=${displayMode === 'list'} onClick=${() => setDisplayMode('list')}>List</button>
        </div>
        ${displayMode === 'graph' && layoutEdges.length > 0 ? html`<button class="c2-mini" onClick=${reset}>reset view</button>` : ''}
      </div>
      <div class="c2-map-scopebar" role="group" aria-label="Choose which work to map">
        <span class="c2-map-scope-label">Show</span>
        <button class=${'c2-map-scope' + (scopeMode === 'current' ? ' active' : '')} aria-pressed=${scopeMode === 'current'} onClick=${() => setScope('current')}>
          Current work
        </button>
        <button class=${'c2-map-scope' + (scopeMode === 'epic' ? ' active' : '')} aria-pressed=${scopeMode === 'epic'} disabled=${!epics.length} onClick=${() => setScope('epic')}>
          One epic
        </button>
        <button class=${'c2-map-scope' + (scopeMode === 'all' ? ' active' : '')} aria-pressed=${scopeMode === 'all'} onClick=${() => setScope('all')}>
          All open
        </button>
        ${scopeMode === 'epic' && epics.length ? html`
          <label class="c2-map-epicpick">
            <span class="sr-only">Epic to map</span>
            <select value=${effectiveEpicId} onChange=${(e) => setEpicId(e.target.value)}>
              ${epics.map((epic) => html`<option key=${epic.id} value=${epic.id}>${epic.id} · ${epic.title}</option>`)}
            </select>
          </label>` : ''}
        <span class="c2-map-scope-help">
          ${scopeMode === 'current' ? 'Active and urgent work, plus what blocks or follows it.'
            : scopeMode === 'epic' ? 'The selected epic, its children, and their immediate dependencies.'
              : 'Every open issue. Best for small projects or a full audit.'}
        </span>
      </div>
      ${displayMode === 'graph' && layoutEdges.length > 0 ? html`
        <div class="c2-map-graphhint"><i class="lg crit"></i> critical chain · scroll to zoom · drag to pan</div>` : ''}
      ${displayMode === 'graph' && presentOverlayTypes.length && layoutEdges.length > 0 ? html`
        <div class="c2-map-overlaybar" role="group" aria-label="Overlay link types">
          <span class="c2-ov-static"><i class="c2-ovswatch c2-ovswatch-blocking"></i>Blocking</span>
          ${presentOverlayTypes.map((t) => html`
            <label key=${t} class="c2-ovtoggle">
              <input type="checkbox" checked=${enabledOverlay.has(t)} onChange=${() => toggleOverlayType(t)} />
              <i class=${'c2-ovswatch c2-ovswatch-' + t}></i>
              <span class="c2-ovlabel">${OVERLAY_TYPE_LABEL[t] || t}</span>
              <span class="c2-ovcount">${overlayCounts.get(t)}</span>
            </label>`)}
        </div>` : ''}
      ${nodes.length === 0 ? html`
        <div class="c2-map-emptywrap">
          <${LearnEmpty} icon="◇" title=${openIssues.length ? 'No work in this scope' : 'Dependency map'}
            what=${openIssues.length ? 'Choose another scope above to see more work.' : 'This draws a picture of what is waiting on what, across open work.'}
            why=${openIssues.length ? 'Current work is intentionally compact. All open always gives you the complete project.' : 'There is no open work to draw right now. Capture something and it will appear here.'} />
        </div>`
      : displayMode === 'list' ? html`
        <div class="c2-map-listwrap">
          <table class="c2-map-list">
            <caption class="sr-only">Issues in the selected dependency map scope</caption>
            <thead><tr><th>Issue</th><th>Status</th><th>Waiting on</th><th>Unlocks</th><th></th></tr></thead>
            <tbody>
              ${listRows.map((n) => {
                const s = glyphStatus(n.issue);
                const waits = blockingIn.get(n.id) || [];
                const unlocks = blockingOut.get(n.id) || [];
                return html`<tr key=${n.id}>
                  <td><strong>${n.issue.title}</strong><span>${n.id} · P${n.issue.priority}</span></td>
                  <td><span class=${'c2-map-list-status st-' + s}>${STATUS_GLYPH_CHAR[s] || STATUS_GLYPH_CHAR.open} ${STATUS_GLYPH_LABEL[s] || s}</span></td>
                  <td>${waits.length ? waits.join(', ') : '—'}</td>
                  <td>${unlocks.length ? unlocks.join(', ') : '—'}</td>
                  <td><button class="c2-mini" onClick=${() => selectIssue(n.id)}>Open</button></td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>`
      : layoutEdges.length === 0 ? html`
        <div class="c2-map-emptywrap">
          <${LearnEmpty} icon="◇" title="No dependencies in this scope" k="blocks"
            what=${`${nodes.length} open ${nodes.length === 1 ? 'issue is' : 'issues are'} visible here, but none are waiting on another.`}
            why="Switch to List for a selectable overview, choose a wider scope, or open an issue and use “Blocked by” to describe what must happen first." />
        </div>`
      : html`
      <div class="c2-map-zoombtns">
        <button class="c2-map-zoombtn" aria-label="Zoom in" onClick=${() => zoomBy(1.25)}>+</button>
        <button class="c2-map-zoombtn" aria-label="Zoom out" onClick=${() => zoomBy(1 / 1.25)}>−</button>
      </div>
      <svg ref=${svgRef} class="c2-map-svg" aria-label="Dependency graph. Use Tab to reach issue nodes, or switch to List for a table."
        onWheel=${onWheel} onMouseDown=${onDown} onMouseMove=${onMove} onMouseUp=${onUp} onMouseLeave=${onUp}>
        <defs>
          <marker id="c2arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="c2-arrowhead" />
          </marker>
          ${directionalTypes.map((t) => html`
            <marker key=${t} id=${'c2arrow-ov-' + t} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" class=${'c2-arrowhead c2-arrow-ov-' + t} />
            </marker>`)}
        </defs>
        <g transform=${`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <g class="c2-edges">${layoutEdges.map(layoutEdge)}</g>
          <g class="c2-edges-overlay">${visibleOverlayEdges.map(overlayEdge)}</g>
          <g class="c2-nodes">${nodes.map(node)}</g>
        </g>
      </svg>`}
    </div>`;
}
