// console2/ui.js — small presentational primitives shared across the view:
// type glyphs, priority pips, HUD corner brackets, status glyphs, and card
// affordances.
import { html } from 'htm/preact';
import { effStatus, isReady } from '../store.js';
import { ageMs, AGE_AMBER_H, AGE_RED_H } from './derive.js';

export const TYPE_GLYPH = {
  epic: '◆', feature: '✦', task: '●', bug: '▲', chore: '⬡',
};
export const PRI_LABEL = ['P0', 'P1', 'P2', 'P3', 'P4'];

export function TypeGlyph(type) {
  return html`<span class=${'c2-glyph c2-glyph-' + type} title=${type}>${TYPE_GLYPH[type] || '●'}</span>`;
}
export function Pip(p) {
  return html`<span class=${'c2-pip c2-pip-' + p} title=${'Priority ' + PRI_LABEL[p]}>${PRI_LABEL[p]}</span>`;
}
export function Corners() {
  return html`<span class="c2-corners" aria-hidden="true"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></span>`;
}

// Age chip that reddens as an in-progress item ages.
export function AgeChip(issue) {
  const h = ageMs(issue) / 3600000;
  const level = h > AGE_RED_H ? 'red' : h > AGE_AMBER_H ? 'amber' : 'ok';
  const label = h < 1 ? '<1h' : h < 24 ? Math.round(h) + 'h' : Math.round(h / 24) + 'd';
  return html`<span class=${'c2-age c2-age-' + level} title="Age since last update">${label}</span>`;
}

export function statusClass(issue) { return 'st-' + effStatus(issue); }

// ---------------------------------------------------------------------------
// Status glyphs — a coherent, colorblind-safe (shape-distinct, not just
// color-distinct) icon per issue status, used everywhere a status renders:
// cards, epic-row headers, map nodes, the detail slide-over, relationship
// chips, and the pulse rail. Previously the only per-status signal on a card
// was the type glyph's color (e.g. every task showed the same green ● glyph
// whether ready, in progress, or closed) — this replaces that with an
// explicit, always-present status mark.
//
// effStatus() only distinguishes {open, in_progress, blocked, closed}; this
// derives two more useful buckets client-side: "ready" (open + unblocked —
// the common case for "open") and "deferred" (open, unblocked, but with a
// future deferred_until — i.e. open-but-not-actionable-yet, distinct from
// ready).
export function glyphStatus(issue) {
  const s = effStatus(issue);
  if (s !== 'open') return s; // in_progress | blocked | closed
  if (issue.deferred_until && new Date(issue.deferred_until).getTime() > Date.now()) return 'deferred';
  return isReady(issue) ? 'ready' : 'open';
}

export const STATUS_GLYPH_CHAR = {
  ready: '▷',        // hollow play triangle — pickable now
  open: '○',          // hollow circle — open but not (yet) ready; shape-distinct from ready's triangle
  in_progress: '◐',   // half-filled circle — actively worked (pulses, see .c2-sglyph.st-in_progress)
  blocked: '⊘',        // circled slash — cannot proceed
  closed: '✓',         // checkmark — done
  deferred: '◔',       // partial disc / clock-ish — parked until a future date
};
export const STATUS_GLYPH_LABEL = {
  ready: 'Ready', open: 'Open', in_progress: 'In progress', blocked: 'Blocked', closed: 'Closed', deferred: 'Deferred',
};

export function StatusGlyph(issue) {
  const g = glyphStatus(issue);
  const char = STATUS_GLYPH_CHAR[g] || STATUS_GLYPH_CHAR.open;
  const label = STATUS_GLYPH_LABEL[g] || g;
  return html`<span class=${'c2-sglyph st-' + g} title=${label} aria-label=${label} role="img">${char}</span>`;
}
