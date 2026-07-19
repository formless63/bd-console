// console2/MapView.js — dependency graph of open issues as a layered SVG DAG.
// Roots left, dependents right; blocker→blocked edges as curves. Pan/zoom via a
// wheel+drag transform, no libraries. Hovering a node lights its full up/down
// stream chain; the longest blocking path (critical chain) is always emphasized.
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, selectIssue, effStatus } from '../store.js';
import { graphLayout } from './derive.js';
import { TYPE_GLYPH } from './ui.js';

const NODE_W = 168, NODE_H = 54;
const ZOOM_MIN = 0.3, ZOOM_MAX = 2.4;

function dist(t0, t1) { return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY); }
function mid(t0, t1) { return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 }; }

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
  const pinch = useRef(null);
  const svgRef = useRef(null);

  const highlight = hover ? chainFrom(hover, edges) : null;

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
      <div class="c2-map-zoombtns">
        <button class="c2-map-zoombtn" aria-label="Zoom in" onClick=${() => zoomBy(1.25)}>+</button>
        <button class="c2-map-zoombtn" aria-label="Zoom out" onClick=${() => zoomBy(1 / 1.25)}>−</button>
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
