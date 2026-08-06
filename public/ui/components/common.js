// common.js — shared presentational helpers and formatters used across views.
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
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

// ---------------------------------------------------------------------------
// tmux agent-type + promptability presentation (bd-console-2gs).
//
// GET /api/tmux now labels every session/pane with the agent CLI it detected
// (claude/codex/gemini/kimi) and whether that pane can actually be prompted.
// A session in SERVER mode (`claude rc`, a `kimi web` server, `codex
// app-server`) is still LISTED — hiding it would just make the host look
// smaller than it is — but its prompt/delegate affordance is disabled with
// the reason attached, because send-keys into one of those types text at a
// process that will never read it.
//
// Everything here tolerates a server that predates the feature (fields
// absent → no chip, promptable defaults to true).
// ---------------------------------------------------------------------------
export const agentName = (x) => (x && (x.agentLabel || x.agent)) || '';
export const isServerMode = (x) => !!x && x.promptable === false;

// Tooltip for the agent chip: what we detected and how confident that is.
export function agentTip(x) {
  if (!x || !agentName(x)) return '';
  const how = x.agentSource === 'title'
    ? 'matched from the pane title only — that can be stale'
    : x.agentSource === 'command'
      ? "matched from tmux's pane command"
      : x.agentSource === 'process'
        ? 'read from the running process'
        : '';
  return how ? `${agentName(x)} — ${how}` : agentName(x);
}

// Tooltip for a disabled prompt/delegate control.
export function promptTip(x) {
  if (!isServerMode(x)) return x?.reason || '';
  return `${x.reason || 'This session is running in server mode.'} Prompts are disabled here because nothing would read them.`;
}

// The "server mode" marker itself — one component so the hub grid, the tmux
// cards, the schedule picker and Console 2.0 can't drift apart.
export const ServerModeBadge = (x) => (isServerMode(x)
  ? html`<span class="badge server-mode" title=${promptTip(x)}>server mode</span>`
  : null);

// ---------------------------------------------------------------------------
// Termix one-click attach (bd-console-4w7).
//
// GET /api/tmux decorates each session with a `termix` object — {url, mode,
// hint} — whenever the hub has a Termix base URL configured. The URL is
// composed SERVER-side (lib/termix.mjs) precisely so the Termix API key never
// has to reach the browser: what arrives here is an address and a session
// name, nothing secret.
//
// Two modes, and the difference is not cosmetic:
//   'attach'  baseUrl + host id known — the link lands inside that tmux
//             session in Termix's web terminal.
//   'open'    baseUrl only — bd-console can't know which Termix host entry
//             this machine is, so the link only opens Termix. Marked, and the
//             tooltip says what to set instead of implying it attached.
//
// Either way the click may land on Termix's own login screen: the deep link
// goes through Termix's fullscreen gate, which wants its session cookie, and
// bd-console has no way to establish one. The hint text says so rather than
// promising seamlessness we can't deliver.
//
// Absent field -> renders nothing, so an unconfigured hub (and any server
// predating this feature) looks exactly as it did before.
// ---------------------------------------------------------------------------
export function TermixLink({ session }) {
  const link = session && session.termix;
  if (!link || !link.url) return null;
  const degraded = link.mode !== 'attach';
  return html`
    <a
      class=${'termix-link' + (degraded ? ' termix-link-partial' : '')}
      href=${link.url}
      target="_blank"
      rel="noopener noreferrer"
      title=${link.hint}
      aria-label=${link.hint}
      onClick=${(e) => e.stopPropagation()}
    >Termix${degraded ? ' ⚠' : ''}</a>`;
}

// ---------------------------------------------------------------------------
// Process health: per-session memory + the idle-but-active marker
// (bd-console-oic, bd-console-xo8).
//
// GET /api/tmux now carries `session.memory` (resident bytes for the pane's
// whole process subtree, its level, and a sentence explaining it),
// `session.idle` (non-null only when a session has been silent for the
// configured number of days AND its processes are still accruing CPU), and a
// top-level `host.memory` block. All three are ADDITIVE and all three can be
// absent — non-Linux, unreadable /proc, an older server — in which case every
// helper here renders nothing at all rather than a zero or an "unknown".
//
// WHY IT'S ON THE DASHBOARD: this host has no swap, and two Claude Code
// processes were OOM-killed in six days (18.4GB and 11.2GB), each taking a
// whole tmux session — and the agents inside it — with it. Nothing showed it
// coming. The hub is already open on screen; this is where it can.
//
// ACCESSIBILITY: never signalled by color alone. The memory chip carries the
// state word ("high" / "critical") next to the number, the host chip carries
// its label ("memory ok" / "memory tight" / "memory critical"), and the idle
// marker is a text badge. Color only ever reinforces text that is already
// there — the same rule the agent/server-mode chips above follow.
// ---------------------------------------------------------------------------
const KB = 1024, MB = 1024 * 1024, GB = 1024 * 1024 * 1024;
export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(0, Math.round(bytes / KB))} KB`;
}

export const memLevel = (x) => (x && x.memory && x.memory.level) || 'ok';
// The word that rides along with the number so the level is never carried by
// color alone. 'ok' adds nothing — a normal session is just its number.
const MEM_WORD = { warn: 'high', crit: 'critical' };

// Compact "how much RAM is this holding" cell/chip. `x` is a session or a
// pane; both carry the same `memory` shape.
export function MemoryChip({ target, className = '' }) {
  const m = target && target.memory;
  if (!m || !Number.isFinite(m.rssBytes)) return null;
  const word = MEM_WORD[m.level];
  return html`
    <span
      class=${`mem-chip mem-${m.level} ${className}`.trim()}
      title=${m.reason || ''}
    >${fmtBytes(m.rssBytes)}${word ? html`<span class="mem-word"> ${word}</span>` : null}</span>`;
}

// The idle-but-active marker. DELIBERATELY a different marker from
// `server mode`: a deliberate headless server and a session everybody forgot
// about are not the same fact, even when they look identical from outside
// (both detached, both busy). The tooltip always names the evidence that
// produced the verdict — days of silence, and the CPU actually observed.
export const idleTip = (s) => (s && s.idle && s.idle.reason) || '';
export function IdleBadge({ session }) {
  if (!session || !session.idle) return null;
  return html`<span class="badge idle-badge" title=${idleTip(session)}>⏳ ${session.idle.label}</span>`;
}

// One sentence for the host memory block, shared by the hub's ops-strip chip
// and the tmux view's banner so the two can't drift. The swap clause is not
// decoration: with swap a full machine gets slow and a human notices; without
// it, the OOM killer fires with no warning stage at all, which is exactly how
// both incidents played out. `host.label` ("memory ok"/"tight"/"critical")
// leads, so the state is in the text before any color is applied.
export function hostMemSummary(host) {
  if (!host) return '';
  const free = Number.isFinite(host.headroomBytes) ? fmtBytes(host.headroomBytes) : '?';
  const total = Number.isFinite(host.totalBytes) ? fmtBytes(host.totalBytes) : '?';
  return `${host.label || 'memory'} · ${free} free of ${total}${host.swapless ? ' · no swap' : ''}`;
}
export const hostMemTip = (host) => (host && host.reason) || '';

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

// ---------------------------------------------------------------------------
// EpicCombobox — searchable epic picker, shared by CreateIssueDialog's epic/
// parent field and the Settings page's per-intent "Default epics" pickers.
//
// Modeled on ScheduleView's SessionCombobox (a themed <input> + absolutely
// positioned, filtered <ul> menu — see that file's header comment for why a
// native <sl-select>/<datalist> was rejected: no filtering support and an
// unstyleable/unreliable native popover). The key difference from
// SessionCombobox: there, the input's value IS the selected value (a
// freeform session name) so opening the menu never has to reconcile
// "selected value" vs "search text". Here `value` is an epic BEAD ID, but
// the field displays the epic's TITLE — so this component tracks its own
// `query` text (live while the menu is open) separately from the committed
// `value` prop, and always opens showing the FULL unfiltered list (per spec:
// "opens the full list on focus/click"), never pre-filtered to whatever the
// previously selected title happens to be.
//
// Sorting is done HERE, in the frontend, by title (case-insensitive
// localeCompare) — never trusts API order — so id/title sort order can
// diverge (e.g. an epic titled "Zebra" created first, hence a low id, still
// sorts last) and the picker is correct regardless of what the backend
// returns.
export function EpicCombobox({ epics, value, onChange, placeholder = 'None' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(-1);
  const wrapRef = useRef(null);

  const sorted = useMemo(
    () => (epics || []).slice().sort((a, b) => (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase())),
    [epics]
  );
  const selected = value ? sorted.find((e) => e.id === value) : null;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sorted.filter((e) => (e.title || '').toLowerCase().includes(q) || (e.id || '').toLowerCase().includes(q))
    : sorted;

  useEffect(() => {
    function onDocClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setHi(-1); } }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const openMenu = () => { setQuery(''); setOpen(true); setHi(-1); };
  const pick = (id) => { onChange(id); setOpen(false); setQuery(''); setHi(-1); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { openMenu(); return; }
      setHi((i) => Math.min(i + 1, filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return;
      setHi((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      if (hi <= 0) pick('');
      else if (filtered[hi - 1]) pick(filtered[hi - 1].id);
    } else if (e.key === 'Escape') {
      if (open) {
        // Escape must close ONLY this menu, never the enclosing dialog. Per
        // the close-requests spec, a native <dialog>'s Escape-to-close only
        // fires if the Escape keydown event reaches the UA un-canceled —
        // preventDefault() here suppresses that default action outright
        // (stopPropagation alone only stops OUR OWN bubbling handlers, e.g.
        // the dialog body's Escape-to-close listener; it does nothing to
        // the browser's separate native dialog-close behavior).
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setHi(-1);
      }
    }
  };

  const displayValue = open ? query : (selected ? selected.title : '');

  return html`
    <div class="combobox epic-combobox" ref=${wrapRef}>
      <input class="field" placeholder=${placeholder} value=${displayValue} autocomplete="off"
        onFocus=${openMenu}
        onClick=${openMenu}
        onInput=${(e) => { setQuery(e.target.value); setOpen(true); setHi(-1); }}
        onKeyDown=${onKeyDown} />
      ${open && html`
        <ul class="combobox-menu" role="listbox">
          <li role="option" aria-selected=${!value && hi <= 0}
            class=${'combobox-opt epic-opt' + (hi <= 0 ? ' hi' : '')}
            onMouseDown=${(e) => { e.preventDefault(); pick(''); }}
            onMouseEnter=${() => setHi(0)}>
            <span class="combobox-opt-title">None</span>
          </li>
          ${filtered.map((e2, i) => html`
            <li key=${e2.id} role="option" aria-selected=${hi === i + 1}
              class=${'combobox-opt epic-opt' + (hi === i + 1 ? ' hi' : '')}
              onMouseDown=${(ev) => { ev.preventDefault(); pick(e2.id); }}
              onMouseEnter=${() => setHi(i + 1)}>
              <span class="combobox-opt-title">${e2.title}</span>
              <span class="combobox-opt-meta muted small">${e2.id}</span>
            </li>`)}
        </ul>`}
    </div>`;
}
