// common.js — shared presentational helpers and formatters used across views.
import { html } from 'htm/preact';
import { PRI_LABEL, effStatus } from '../store.js';

export function timeAgo(s) {
  if (!s) return '';
  const d = new Date(s), m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  return d.toLocaleDateString();
}
export function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s), days = Math.round((Date.now() - d) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 14) return days + 'd ago';
  return d.toLocaleDateString();
}
export function fmtClock(ms) { return ms ? new Date(ms).toLocaleTimeString() : 'never'; }

export const statusText = (s) => s.replace('_', ' ');

export const PriBadge = (p) => html`<span class=${'badge pri pri-' + p}>${PRI_LABEL[p] ?? p}</span>`;
export const StatusBadge = (issue) => {
  const s = effStatus(issue);
  return html`<span class=${'badge st st-' + s}>${statusText(s)}</span>`;
};
export const StatusDot = (s) => html`<span class=${'dot-status st-' + s}></span>`;

export function syncLabel(info) {
  if (!info) return 'sync unknown';
  if (info.error) return 'export error';
  if (!info.exists) return 'export missing';
  if (info.stale) return 'sync stale';
  return 'sync ok';
}
export function syncState(info) {
  if (!info) return 'ok';
  if (info.error) return 'err';
  if (!info.exists || info.stale) return 'warn';
  return 'ok';
}
