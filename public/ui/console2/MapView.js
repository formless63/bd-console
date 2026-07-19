// console2/MapView.js — dependency graph of open issues as a layered SVG DAG.
// Roots left, dependents right; blocker→blocked edges as curves. Pan/zoom via a
// wheel+drag transform, no libraries. Hovering a node lights its full up/down
// stream chain; the longest blocking path (critical chain) is always emphasized.
import { html } from 'htm/preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { store, selectIssue, effStatus } from '../store.js';
import { graphLayout } from './derive.js';
import { TYPE_GLYPH } from './ui.js';

const NODE_W = 168, NODE_H = 54;

function chainFrom(id, edges) {
  // gather up + downstream reachable from id
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

export function MapView() {
  const issues = store.issues.value; // subscribe
  const layout = useMemo(() => graphLayout(), [issues]);
  const { nodes, edges, width, height, criticalChain } = layout;

  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState(null);
  const drag = useRef(null);
  const svgRef = useRef(null);

  const highlight = hover ? chainFrom(hover, edges) : null;

  const onWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => ({ ...v, k: Math.min(2.4, Math.max(0.3, v.k * factor)) }));
  };
  const onDown = (e) => { drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y }; };
  const onMove = (e) => {
    if (!drag.current) return;
    setView((v) => ({ ...v, x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) }));
  };
  const onUp = () => { drag.current = null; };
  const reset = () => setView({ x: 0, y: 0, k: 1 });

  if (nodes.length === 0) {
    return html`<div class="c2-map"><div class="c2-map-empty">No open issues to map.</div></div>`;
  }

  const edge = (e, i) => {
    const x1 = e.a.x + NODE_W, y1 = e.a.y + NODE_H / 2;
    const x2 = e.b.x, y2 = e.b.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    const onChain = criticalChain.has(e.from) && criticalChain.has(e.to);
    const lit = highlight && highlight.has(e.from) && highlight.has(e.to);
    const dim = highlight && !lit;
    return html`<path key=${i} d=${d} class=${'c2-edge' + (onChain ? ' crit' : '') + (lit ? ' lit' : '') + (dim ? ' dim' : '')} marker-end="url(#c2arrow)" />`;
  };

  const node = (n) => {
    const s = effStatus(n.issue);
    const onChain = criticalChain.has(n.id);
    const lit = highlight && highlight.has(n.id);
    const dim = highlight && !lit;
    const scale = 1 + (4 - n.issue.priority) * 0.04; // higher priority (lower number) = bigger
    const w = NODE_W * scale, h = NODE_H * scale;
    return html`
      <g key=${n.id} transform=${`translate(${n.x - (w - NODE_W) / 2} ${n.y - (h - NODE_H) / 2})`}
         class=${'c2-node st-' + s + (onChain ? ' crit' : '') + (lit ? ' lit' : '') + (dim ? ' dim' : '')}
         onMouseEnter=${() => setHover(n.id)} onMouseLeave=${() => setHover(null)}
         onClick=${() => selectIssue(n.id)} style="cursor:pointer">
        <rect width=${w} height=${h} rx="10" class="c2-node-box" />
        <text x="12" y="21" class="c2-node-glyph">${TYPE_GLYPH[n.issue.issue_type] || '●'}</text>
        <text x="30" y="21" class="c2-node-id">${n.id}</text>
        <text x="12" y="39" class="c2-node-title">${(n.issue.title || '').slice(0, 22)}</text>
      </g>`;
  };

  return html`
    <div class="c2-map">
      <div class="c2-map-toolbar">
        <span class="c2-hud-label">Dependency map</span>
        <span class="c2-map-legend"><i class="lg crit"></i> critical chain · scroll to zoom · drag to pan</span>
        <button class="c2-mini" onClick=${reset}>reset view</button>
      </div>
      <svg ref=${svgRef} class="c2-map-svg" onWheel=${onWheel} onMouseDown=${onDown} onMouseMove=${onMove} onMouseUp=${onUp} onMouseLeave=${onUp}>
        <defs>
          <marker id="c2arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="c2-arrowhead" />
          </marker>
        </defs>
        <g transform=${`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <g class="c2-edges">${edges.map(edge)}</g>
          <g class="c2-nodes">${nodes.map(node)}</g>
        </g>
      </svg>
    </div>`;
}
