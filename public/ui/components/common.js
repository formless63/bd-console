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

// Relative time that works both directions — "in 5m" for future timestamps
// (e.g. a not-yet-fired schedule job), "5m ago" for past ones.
export function relTime(ms) {
  if (!ms) return '';
  const diff = ms - Date.now();
  const future = diff >= 0;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  let text;
  if (min < 1) text = 'just now';
  else if (min < 60) text = min + 'm';
  else if (min < 1440) text = Math.round(min / 60) + 'h';
  else text = Math.round(min / 1440) + 'd';
  if (text === 'just now') return text;
  return future ? 'in ' + text : text + ' ago';
}

// Strips ANSI escape sequences (CSI, OSC, and lone C1 codes) from captured
// tmux pane output so it renders cleanly in a plain <pre>.
export function stripAnsi(s) {
  if (!s) return '';
  return s
    .replace(/\x1B\][^\x07\x1B]*(\x07|\x1B\\)/g, '') // OSC ... BEL | ST
    .replace(/\x1B[[0-9;?]*[ -/]*[@-~]/g, '')          // CSI sequences
    .replace(/\x1B[PX^_].*?\x1B\\/g, '')               // DCS/APC/PM/SOS
    .replace(/\x1B[@-Z\\-_]/g, '');                     // remaining Fe escapes
}

// Renders a pane's cwd for display: last one or two path segments, with the
// full path available via title/tooltip at the call site.
export function cwdTail(path) {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return '/' + parts.join('/');
  return '…/' + parts.slice(-2).join('/');
}

// Matches a tmux pane's cwd against the hub's registered project paths —
// returns [id, project] for the longest matching prefix, or null.
export function matchProject(cwd, projects) {
  if (!cwd || !projects) return null;
  let best = null;
  for (const [id, project] of Object.entries(projects)) {
    const p = project.path;
    if (!p) continue;
    if (cwd === p || cwd.startsWith(p.endsWith('/') ? p : p + '/')) {
      if (!best || p.length > best[1].path.length) best = [id, project];
    }
  }
  return best;
}

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
