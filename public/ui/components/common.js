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

// Compact combined-unit age, e.g. "3d 4h", "2h 15m", "5m" — used for
// "time since created" stats where a single rounded unit (as timeAgo gives)
// reads as too coarse. `createdSec` is epoch seconds; falsy -> '—'.
export function ageText(createdSec) {
  if (!createdSec) return '—';
  const diffMs = Date.now() - createdSec * 1000;
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const remMins = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${remMins}m`;
  return `${mins}m`;
}

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

// Copies text to the clipboard, trying the modern async Clipboard API first
// and falling back to a hidden-textarea + execCommand('copy') for contexts
// where navigator.clipboard is unavailable (notably: browsing the console
// over plain http via a LAN IP, which most browsers treat as an insecure
// context and refuse to expose the Clipboard API on). Resolves true/false —
// never throws — so callers can toast the outcome either way.
export async function copyToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to the legacy fallback below */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

export function CopyIcon() {
  return html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M4 1.5A1.5 1.5 0 0 0 2.5 3v7A1.5 1.5 0 0 0 4 11.5h1v-1H4a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v1h1V3A1.5 1.5 0 0 0 9 1.5H4Zm3 3A1.5 1.5 0 0 0 5.5 6v7A1.5 1.5 0 0 0 7 14.5h5a1.5 1.5 0 0 0 1.5-1.5V6A1.5 1.5 0 0 0 12 4.5H7ZM6.5 6a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5V6Z"/></svg>`;
}
