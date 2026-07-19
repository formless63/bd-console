// console2/ui.js — small presentational primitives shared across the view:
// type glyphs, priority pips, HUD corner brackets, and card affordances.
import { html } from 'htm/preact';
import { effStatus } from '../store.js';
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
