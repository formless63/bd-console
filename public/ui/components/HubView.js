// HubView.js — the global hub landing page: a hero header, a live tmux
// sessions strip, and a responsive grid of project cards carrying issue
// metrics and (optional) git insights.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { store, navigate, loadProjectStats, loadTmux, loadSchedule, loadProjectsGit, loadUsage, loadUsageHistory, loadBdVersion, loadCliVersions, toggleHubSection, toast, loadHub, requireToken } from '../store.js';
import { apiPostRaw, AuthError } from '../api.js';
import { useVisiblePoll } from '../poll.js';
import { timeAgo, copyToClipboard, hostMemSummary, hostMemTip } from './common.js';
import { SessionRowCompact, HubTmuxHead } from './TmuxView.js';
import { ProviderAttribution, formatTokens } from './UsageCharts.js';

// Chevron used by the mobile collapsible-section headers (ops strip, tmux
// strip, usage/quota) — see .hub-section-toggle / .hub-section-body in
// styles.css. Only visible at <=768px; on desktop the toggle header itself
// is hidden so this never renders there. Pass alwaysVisible for a section
// that collapses at every viewport (currently just the usage attribution
// band), which needs the chevron on desktop too.
function ChevronIcon({ open, alwaysVisible }) {
  return html`<svg class=${'hub-section-chevron' + (alwaysVisible ? ' chevron-visible' : '')} width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"
    style=${'transform:rotate(' + (open ? '0' : '-90') + 'deg)'}><path fill="currentColor" d="M4 6l4 4 4-4"/></svg>`;
}

// Unmistakable external-link glyph (box + escaping arrow) — used by the bd
// version link and the docs chip so both read as "leaves the app" even
// without relying on target="_blank" alone (which isn't visually apparent).
function ExternalLinkIcon() {
  return html`<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" class="external-link-icon">
    <path fill="currentColor" d="M6.5 2a.5.5 0 000 1H11.3L5.15 9.15a.5.5 0 10.7.7L12 3.7V8.5a.5.5 0 001 0v-6a.5.5 0 00-.5-.5h-6z"/>
    <path fill="currentColor" d="M4 4a2 2 0 00-2 2v6a2 2 0 002 2h6a2 2 0 002-2V9a.5.5 0 00-1 0v3a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1h3a.5.5 0 000-1H4z"/>
  </svg>`;
}

const METRICS_META = [
  ['open', 'Ready', 'green'],
  ['in_progress', 'Active', 'accent'],
  ['blocked', 'Blocked', 'red'],
  ['triage', 'Inbox', 'purple'],
];

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function GitLinkIcon() {
  return html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M6.5 2a.5.5 0 000 1H12l-6.65 6.65a.5.5 0 10.7.7L12.7 3.7V9a.5.5 0 001 0V3a1 1 0 00-1-1H6.5z"/></svg>`;
}
function BranchIcon() {
  return html`<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M5 2.5a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zm.5 2.45v6.1a1.5 1.5 0 11-1 0V4.95a1.5 1.5 0 111 0zM11 12a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm-2.5-1.5V9c0-1.1.9-2 2-2h.5a1.5 1.5 0 100-1H10.5A3 3 0 007.5 9v1.5"/></svg>`;
}
// Official GitHub "mark" logo, inline so currentColor picks up the theme.
function GitHubMarkIcon() {
  return html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
}

// Parses "owner/repo" out of a webUrl (github/gitlab/codeberg all use
// /owner/repo as the last two path segments) for the repo chip's label.
function ownerRepoFromWebUrl(webUrl) {
  try {
    const u = new URL(webUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { host: u.hostname, label: parts.slice(-2).join('/') };
  } catch { return null; }
}

// Repo chip — replaces the old icon-only "open remote" link with a labeled
// chip: GitHub mark for github.com remotes, a generic external glyph for
// other forges (gitlab/codeberg/etc.), always showing "owner/repo".
function RepoChip({ webUrl }) {
  const parsed = ownerRepoFromWebUrl(webUrl);
  if (!parsed) return null;
  const isGithub = parsed.host === 'github.com';
  return html`
    <a class="repo-chip" href=${webUrl} target="_blank" rel="noopener noreferrer" title=${webUrl}
      onClick=${(e) => e.stopPropagation()}>
      ${isGithub ? html`<${GitHubMarkIcon} />` : html`<${GitLinkIcon} />`}
      <span class="repo-chip-text">${parsed.label}</span>
    </a>`;
}

function GitInsights({ git }) {
  if (!git) return null;
  const any = git.branch || git.lastCommit || git.webUrl || (git.dirty ?? 0) > 0 || git.ahead != null || git.behind != null || git.commits7d != null;
  if (!any) return null;
  return html`
    <div class="hub-card-git">
      <div class="hub-card-git-row">
        ${git.branch && html`<span class="git-chip git-branch"><${BranchIcon} />${git.branch}</span>`}
        ${git.ahead != null && git.ahead > 0 && html`<span class="git-chip git-ahead" title="${git.ahead} commit(s) ahead of upstream">↑${git.ahead}</span>`}
        ${git.behind != null && git.behind > 0 && html`<span class="git-chip git-behind" title="${git.behind} commit(s) behind upstream">↓${git.behind}</span>`}
        ${(git.dirty ?? 0) > 0 && html`<span class="git-chip git-dirty" title="${git.dirty} file(s) with uncommitted changes">●${git.dirty}</span>`}
        ${git.commits7d != null && html`<span class="git-chip git-velocity">${git.commits7d} commit${git.commits7d === 1 ? '' : 's'}/wk</span>`}
        ${git.webUrl && html`<${RepoChip} webUrl=${git.webUrl} />`}
      </div>
      ${git.lastCommit && (git.lastCommit.subject || git.lastCommit.hash) && html`
        <div class="hub-card-commit muted small" title=${[git.lastCommit.author, git.lastCommit.subject].filter(Boolean).join(' · ')}>
          <span class="commit-subject">${truncate(git.lastCommit.subject, 58) || git.lastCommit.hash?.slice(0, 7)}</span>
          ${git.lastCommit.time && html`<span class="commit-time"> · ${timeAgo(git.lastCommit.time * 1000)}</span>`}
        </div>`}
    </div>`;
}

function ProjectCard({ id, project, stats, err }) {
  const git = store.projectsGit.value[id];
  // Console 2.0 is the ONLY per-project destination now that the classic view
  // is retired — the card's whole click-through, and its CTA hint below, both
  // land on #/p2/<id> (as does the retired #/p/<id>, which redirects there;
  // see routing.js).
  const open = () => navigate('#/p2/' + encodeURIComponent(id));
  const onKeyDown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };

  return html`
    <div class="hub-card" role="button" tabIndex="0" onClick=${open} onKeyDown=${onKeyDown}>
      <div class="hub-card-top">
        <span class="hub-card-title">${id}</span>
        ${stats && html`<span class="hub-card-total">${stats.openTotal} open · ${stats.total} lifetime</span>`}
      </div>
      <div class="hub-card-path">${project.path}</div>
      ${/* Registered, but the folder itself isn't there anymore (moved,
            renamed, or the disk/mount it lived on is gone) — `missing` on the
            /api/projects entry (older servers never send it, so this simply
            never renders for them). Everything else on the card still tries
            to render normally; this is a heads-up, not a different card. */ ''}
      ${project.missing && html`
        <span class="hub-chip hub-chip-crit hub-card-missing-badge" title="Registered at this path, but the directory could not be found on disk.">
          ⚠ directory missing
        </span>`}

      <${GitInsights} git=${git} />

      <div class="hub-card-stats">
        ${err
          ? html`<span class="muted small">Failed to load</span>`
          : !stats
            ? METRICS_META.map(([k]) => html`<span key=${k} class="stat-pill skeleton-pill"></span>`)
            : html`
              ${METRICS_META.map(([k, label]) => html`
                <span key=${k} class=${'stat-pill s-' + k}>
                  <span class=${'dot-status st-' + k}></span>${stats[k]} ${label}
                </span>`)}
              ${stats.closed7d > 0 && html`<span class="stat-pill s-velocity" title="Closed in the last 7 days">⚡ ${stats.closed7d}/wk</span>`}
              ${stats.openBugs > 0 && html`<span class="stat-pill s-bugs" title="Open bugs">🐞 ${stats.openBugs}</span>`}
            `}
      </div>
      <div class="hub-card-cta">
        <span>Open project workspace →</span>
      </div>
    </div>`;
}

// Dense, always-visible project radar: the landing page remains an
// information station, but entering a project and spotting where attention is
// needed no longer requires scrolling past the host-wide instrumentation.
function ProjectRadar({ entries, statsById, errors }) {
  if (entries.length === 0) return null;
  return html`
    <section class="hub-radar" aria-labelledby="hub-radar-title">
      <div class="hub-section-head hub-radar-head">
        <div>
          <h2 id="hub-radar-title">Project radar</h2>
          <span class="muted small">Current work across every registered project</span>
          <span class="hub-radar-legend" aria-label="Metric key: ready, active, blocked, inbox">
            <b>R</b> ready · <b>A</b> active · <b>B</b> blocked · <b>I</b> inbox
          </span>
        </div>
        <a class="hub-guide-link" href="#/learn">Start here · project workflow →</a>
      </div>
      <div class="hub-radar-grid">
        ${entries.map(([id]) => {
          const s = statsById[id];
          return html`
            <button type="button" class="hub-radar-project" key=${id}
              onClick=${() => navigate('#/p2/' + encodeURIComponent(id))}>
              <span class="hub-radar-name">${id}</span>
              ${errors.has(id) ? html`<span class="muted small">unavailable</span>`
                : !s ? html`<span class="hub-radar-loading" aria-label="Loading project health"></span>`
                  : html`
                    <span class="hub-radar-total">${s.openTotal} open</span>
                    <span class="hub-radar-metric ready" title="Ready now">${s.open}R</span>
                    <span class="hub-radar-metric active" title="In progress">${s.in_progress}A</span>
                    <span class="hub-radar-metric blocked" title="Blocked">${s.blocked}B</span>
                    <span class="hub-radar-metric triage" title="Inbox / triage">${s.triage}I</span>`}
              <span aria-hidden="true" class="hub-radar-arrow">→</span>
            </button>`;
        })}
      </div>
    </section>`;
}

// One-shot (not polled) summary strip — cheap enough to fetch every time the
// hub mounts, but the tmux/schedule views themselves own the live polling.
// Also the hub's single "glanceable status" chip row: tmux sessions and
// scheduled prompts (native to this strip) plus the bd version/docs/update/
// multiple-binaries chips that used to be their own standalone row below the
// header (see the removed BdVersionRow — folded in here per the consolidation
// pass so every hub-wide status lives in one uniformly-styled row). Every
// chip shares the .hub-chip base (padding/radius/font-size/border) — only
// color varies (.hub-chip-amber, .hub-chip-warn) — plus a leading emoji so
// each kind is glanceable without reading the text first.
//
// At <=768px this and the tmux strip below eat half the viewport before a
// single project card is visible, so both get a tappable, per-section
// collapse toggle (state persisted in store.collapsedHubSections / bd_hub_
// sections_collapsed) — collapsed by default on first mobile visit. The
// toggle header itself (.hub-section-toggle) is desktop-hidden and
// .hub-section-body's "collapsed" class only takes effect <=768px (see
// styles.css), so desktop rendering is untouched either way.
function OpsStrip() {
  useEffect(() => { loadTmux(); loadSchedule(); loadProjectsGit(); loadBdVersion(); }, []);
  const sessions = store.tmuxSessions.value;
  const pending = store.scheduleJobs.value.filter((j) => j.status === 'pending').length;
  const hasTmux = store.tmuxAvailable.value;
  const collapsed = store.collapsedHubSections.value.has('ops');
  // Host memory + forgotten-session count (bd-console-oic / bd-console-xo8).
  // Both are ADDITIVE and both vanish when the server can't measure them, so
  // a non-Linux host (or an older daemon) sees the row exactly as before.
  const host = store.tmuxHost.value;
  const unattended = sessions.filter((s) => s && s.idle).length;
  // The collapsed-on-mobile summary carries the memory state whenever it is
  // NOT ok — a warning that only exists inside a collapsed section is a
  // warning nobody sees, which is the failure mode this feature exists to fix.
  const summary = `${hasTmux ? sessions.length + ' tmux session' + (sessions.length === 1 ? '' : 's') : 'tmux unavailable'} · ${pending} scheduled prompt${pending === 1 ? '' : 's'}`
    + (host && host.level !== 'ok' ? ` · ${host.label}` : '');

  const bdKnown = store.bdVersionAvailable.value;
  const v = store.bdVersion.value;
  const showVersion = bdKnown && v && v.installed;
  const behind = showVersion && v.behind === true && v.latest;

  return html`
    <div class="hub-ops-wrap">
      <button type="button" class="hub-section-toggle" aria-expanded=${!collapsed} onClick=${() => toggleHubSection('ops')}>
        <span class="hub-section-toggle-label">Overview</span>
        <span class="hub-section-toggle-summary">${summary}</span>
        <${ChevronIcon} open=${!collapsed} />
      </button>
      <div class=${'ops-strip hub-section-body' + (collapsed ? ' collapsed' : '')}>
        <button type="button" class="hub-chip" onClick=${() => navigate('#/tmux')}>
          🖥️ ${hasTmux ? `${sessions.length} tmux session${sessions.length === 1 ? '' : 's'}` : 'tmux unavailable'}
        </button>
        <button type="button" class="hub-chip" onClick=${() => navigate('#/schedule')}>
          ⏰ ${pending} scheduled prompt${pending === 1 ? '' : 's'}
        </button>
        ${host && html`
          <button
            type="button"
            class=${'hub-chip' + (host.level === 'crit' ? ' hub-chip-crit' : host.level === 'warn' ? ' hub-chip-amber' : '')}
            title=${hostMemTip(host)}
            onClick=${() => navigate('#/tmux')}
          >🧠 ${hostMemSummary(host)}</button>`}
        ${unattended > 0 && html`
          <button type="button" class="hub-chip hub-chip-amber"
            title=${'Sessions nobody has attached to (and that have printed nothing) for days, whose processes are still using CPU — see the session table for what each one is running.'}
            onClick=${() => navigate('#/tmux')}>
            ⏳ ${unattended} unattended session${unattended === 1 ? '' : 's'}
          </button>`}
        ${showVersion && html`
          <a class="hub-chip hub-chip-link" href=${BEADS_REPO_URL} target="_blank" rel="noopener noreferrer"
            title=${'Installed via `bd version`' + (v.checkedAt ? ' · checked ' + timeAgo(v.checkedAt) : '') + ' — open beads on GitHub'}>
            🏷️ bd ${v.installed}<${ExternalLinkIcon} />
          </a>`}
        <a class="hub-chip hub-chip-link" href=${BEADS_DOCS_URL} target="_blank" rel="noopener noreferrer" title="Open beads documentation">
          📚 bd-docs<${ExternalLinkIcon} />
        </a>
        <button type="button" class="hub-chip" onClick=${() => navigate('#/learn')}>
          🧭 project guide
        </button>
        ${behind && html`
          <button type="button" class="hub-chip hub-chip-amber"
            title=${v.updateHint ? `Copy: ${v.updateHint}` : 'A newer bd release is available — see Settings for update options'}
            onClick=${() => v.updateHint ? copyUpdateCommand(v.updateHint) : navigate('#/settings')}>
            ⬆️ update available → ${v.latest}
          </button>`}
        ${showVersion && v.multipleBinaries && html`
          <span class="hub-chip hub-chip-warn" title=${'Multiple bd binaries on PATH:\n' + v.binaries.join('\n') + '\n\nSee Settings for details.'}>
            ⚠️ multiple bd on PATH
          </span>`}
      </div>
    </div>`;
}

// Note: the tmux session list used to be its own stacked hub-section
// ("Terminal sessions", full-width, capped to 6 rows + "View all →"). It's
// now rendered inline inside QuotaSessionsRow, side by side with the live
// quota band — see that function, below the Usage section — showing every
// session (no 6-row cap) inside its own internally-scrolling container
// instead of truncating.

// ---------------------------------------------------------------------------
// bd (beads CLI) version helpers — GET /api/bd-version (see lib/bdversion.mjs)
// backs the version/update/multi-binary chips rendered inline in OpsStrip
// above (one-shot fetch there; the server caches the GitHub lookup for hours,
// so polling would just re-hit the same cached value). A manual refresh
// isn't offered from the hub — Settings has the fuller card + explicit
// "recheck". These used to back a standalone BdVersionRow beneath the
// header; consolidated into the single ops chip row per the hub cleanup.
// ---------------------------------------------------------------------------
async function copyUpdateCommand(cmd) {
  const ok = await copyToClipboard(cmd);
  toast(ok ? `Copied "${cmd}"` : cmd, ok ? 'ok' : 'warn', ok ? 3200 : 8000);
}

const BEADS_REPO_URL = 'https://github.com/gastownhall/beads';
const BEADS_DOCS_URL = 'https://beads.gascity.com';

// ---------------------------------------------------------------------------
// Usage section — Claude Code / Codex quota gauges (GET /api/usage, polled
// every 5 min while the hub is mounted AND visible). Placed near the ops
// strip since it's the same kind of hub-wide, not-project-scoped glanceable
// status.
//
// 5 minutes, not the original 60s: the server's cache is what actually meters
// the upstream Claude OAuth call, but a 60s client poll against a 60s server
// TTL meant an open hub sustained ~1 OAuth call/minute forever and tripped the
// provider's rate limit (bd-console-0fg). These gauges track 5h/7d windows —
// minute resolution buys nothing. The ↻ button is the fast path when someone
// actually wants "now" (see refreshUsageAll).
// ---------------------------------------------------------------------------
const USAGE_POLL_MS = 5 * 60000;
// History (attribution) is a heavier fetch than the live-quota gauges above
// — refresh it on its own cadence (5 min) plus on mount / manual refresh /
// range switch. It reads local session logs only, so it never touches a
// provider's rate limit; it lands on the same 5 min as the quota poll purely
// because that is the right cadence for both, not because they share a timer.
const USAGE_HISTORY_POLL_MS = 5 * 60000;
// 'Gemini (Antigravity)' matches AGENT_LABEL in lib/tmux.mjs exactly — the same
// CLI shows up in the Terminal-sessions card under that name, and two different
// names for one tool on one screen is a bug.
const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', gemini: 'Gemini (Antigravity)' };
const HISTORY_RANGE_OPTIONS = [7, 30, 90];

// "resets in Xh Ym" / "resets in Ym" — deliberately not timeAgo/relTime
// (both round to a single unit), since a countdown reading "resets in 1h"
// when it's actually 1h 55m away is misleading for scheduling decisions.
function formatResetIn(resetsAt) {
  if (!resetsAt) return null;
  const diffMin = Math.round((resetsAt - Date.now()) / 60000);
  if (diffMin <= 0) return 'resets soon';
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function gaugeColorClass(percent) {
  if (typeof percent !== 'number') return 'gauge-ok';
  if (percent > 85) return 'gauge-crit';
  if (percent >= 60) return 'gauge-warn';
  return 'gauge-ok';
}

// Scoped limits carry their own authoritative severity from the server
// (normal/warning/critical) — map it directly to the same status classes
// the percent-derived gauges use, rather than re-deriving it from percent.
function severityGaugeClass(severity) {
  if (severity === 'critical') return 'gauge-crit';
  if (severity === 'warning') return 'gauge-warn';
  return 'gauge-ok';
}

function UsageGauge({ w }) {
  const pct = typeof w.percent === 'number' ? Math.max(0, Math.min(100, w.percent)) : null;
  return html`
    <div class="usage-gauge-row">
      <span class="usage-gauge-label">${w.label}</span>
      <span class="usage-gauge-pct">${pct != null ? Math.round(pct) + '%' : '—'}</span>
      ${w.resetsAt && html`<span class="usage-gauge-reset muted small">${formatResetIn(w.resetsAt)}</span>`}
      <div class="usage-gauge-track" role="progressbar" aria-valuenow=${pct ?? 0} aria-valuemin="0" aria-valuemax="100">
        <div class=${'usage-gauge-fill ' + gaugeColorClass(pct)} style=${'width:' + (pct ?? 0) + '%'}></div>
      </div>
    </div>`;
}

// A single per-model scoped limit row (GET /api/usage's dynamic
// scopedLimits[] — only currently-capped models appear). A critical + active
// entry means the model is actually throttled right now, so it gets a loud
// treatment (icon + text label, never color alone) in addition to the red
// fill everything else already gets from severityGaugeClass.
function ScopedLimitRow({ lim }) {
  const pct = typeof lim.percent === 'number' ? Math.max(0, Math.min(100, lim.percent)) : null;
  const loud = lim.severity === 'critical' && lim.active;
  return html`
    <div class=${'usage-gauge-row usage-scoped-limit' + (loud ? ' critical-active' : '')}>
      <span class="usage-gauge-label usage-scoped-limit-label" title=${lim.model}>${lim.model}</span>
      <span class="usage-gauge-pct">${pct != null ? Math.round(pct) + '%' : '—'}</span>
      ${loud && html`<span class="usage-throttled-badge" title="Currently rate-limited">⛔ throttled</span>`}
      ${lim.resetsAt && html`<span class="usage-gauge-reset muted small">${formatResetIn(lim.resetsAt)}</span>`}
      <div class="usage-gauge-track" role="progressbar" aria-valuenow=${pct ?? 0} aria-valuemin="0" aria-valuemax="100">
        <div class=${'usage-gauge-fill ' + severityGaugeClass(lim.severity)} style=${'width:' + (pct ?? 0) + '%'}></div>
      </div>
    </div>`;
}

function summarizeUsage(data) {
  if (!data) return '…';
  if (data.status === 'ok') {
    const pcts = (data.windows || []).map((w) => w.percent).filter((p) => typeof p === 'number');
    return pcts.length ? Math.round(Math.max(...pcts)) + '%' : 'ok';
  }
  if (data.status === 'token-expired') return 'expired';
  return 'not detected';
}

// Kimi's contribution to the collapsed-section summary — a server state, not a
// percentage, because there is no quota to summarize. Returns null when Kimi
// isn't installed so the summary string stays untouched on machines without it.
function summarizeKimi(data) {
  if (!data || data.status === 'not-installed') return null;
  if (data.status === 'error') return 'unavailable';
  if (!data.server) return 'not running';
  return KIMI_STATE_LABEL[data.server.state] || data.server.state || 'unknown';
}

// Same contract as summarizeKimi: a state word, never a percentage, and null on
// machines without the Antigravity CLI so the summary string is untouched there.
function summarizeGemini(data) {
  if (!data || data.status === 'not-installed') return null;
  if (data.status === 'error') return 'unavailable';
  if (data.auth && data.auth.state === 'signed-out') return 'signed out';
  if (!data.server) return 'not running';
  return KIMI_STATE_LABEL[data.server.state] || data.server.state || 'unknown';
}

// Version + "update available" chips for the Claude Code / Codex CLIs,
// mirroring the bd-version chips in OpsStrip above but sized down to match
// .usage-plan-chip (this row is ~1/3-width, not the full-bleed ops strip —
// see the .usage-version-chip / .usage-update-chip comment in styles.css).
// Reads store.cliVersions (GET /api/cli-versions, one-shot fetch — see the
// QuotaSessionsRow effect below) and renders nothing at all when the tool
// isn't installed, its info is missing, or the endpoint never came back —
// exactly like a machine without Codex looks today.
//
// multipleBinaries (a shadowed second install of the same CLI on PATH) is
// folded INTO the version chip rather than given a fourth sibling chip. At
// this card's real width — ~350px, one 1fr column of .hub-qs-grid — the codex
// row already runs name + version + update + plan edge to edge, and a
// standalone "⚠️ multiple on PATH" chip pushed the head from one line to
// three and became the widest, loudest thing on a card whose entire job is
// quota (measured, not guessed). Folding it in also matches what the warning
// actually says: it is a statement ABOUT which binary produced that version
// string, not an independent fact. The glyph vocabulary from the ops strip is
// preserved exactly — 🏷️ still means "version", ⚠️ still means "multiple on
// PATH"; only the packaging changes, because there is no room for two chips.
// The full binary list (active first) lives in the title, and the chip is
// never emoji-alone: it carries the version text, a dashed border, and
// cursor:help, the same "hover me, I'm not a button" language .hub-chip-warn
// uses in the ops strip.
function CliVersionChips({ name }) {
  const info = store.cliVersions.value[name];
  if (!info || !info.installed) return null;
  const behind = info.behind === true && info.latest;
  const bins = info.binaries || [];
  const multi = info.multipleBinaries === true && bins.length > 1;
  const checkTitle = `Installed — from \`${name} --version\`` + (info.checkedAt ? ' · checked ' + timeAgo(info.checkedAt) : '');
  const multiTitle = multi
    ? `⚠ ${bins.length} \`${name}\` binaries on PATH — the first one is what actually runs:\n`
      + bins.map((b, i) => `${i + 1}. ${b}${i === 0 ? '  (active)' : '  (shadowed)'}`).join('\n')
      + '\n\nThe version above is the active one. A shadowed install can update without anything here changing.'
    : '';
  return html`
    <span class="usage-cli-chips">
      ${/* No newline between the tag and the closing brace: htm would keep
            the indentation as leading text inside the pill. */ ''}
      <span class=${'usage-version-chip' + (multi ? ' has-multi' : '')}
        title=${multi ? checkTitle + '\n\n' + multiTitle : checkTitle}
      >🏷️ ${info.installed}${multi && html`<span class="usage-multi-mark" aria-hidden="true">⚠️</span>`}</span>
      ${behind && (info.updateHint
        ? html`<button type="button" class="usage-update-chip" title=${`Update available: ${info.latest} — copy: ${info.updateHint}`}
            onClick=${() => copyUpdateCommand(info.updateHint)}>⬆️ ${info.latest}</button>`
        : html`<span class="usage-update-chip" title=${`A newer release (${info.latest}) is available`}>⬆️ ${info.latest}</span>`)}
    </span>`;
}

function ProviderUsageRow({ name, data }) {
  const label = PROVIDER_LABEL[name] || name;

  if (!data || data.status === 'no-creds' || data.status === 'no-data') {
    return html`
      <div class="usage-row usage-row-quiet">
        <span class="usage-row-quiet-name">
          <span class="usage-provider-name">${label}</span>
          <${CliVersionChips} name=${name} />
        </span>
        <span class="muted small">not detected</span>
      </div>`;
  }
  if (data.status === 'token-expired') {
    return html`
      <div class="usage-row usage-row-quiet">
        <span class="usage-row-quiet-name">
          <span class="usage-provider-name">${label}</span>
          <${CliVersionChips} name=${name} />
        </span>
        <span class="muted small">${data.message || 'open Claude Code to refresh'}</span>
      </div>`;
  }
  if (data.status === 'error' || data.status === 'rate-limited') {
    // Rate-limited is not the same failure as "usage unavailable": the server
    // is deliberately holding off, and ↻ will not change that until the
    // backoff lifts. Say when, so a refresh that returns the same numbers
    // reads as expected rather than broken.
    const retryIn = data.status === 'rate-limited' ? retryInText(data.retryAt) : null;
    const note = data.status === 'rate-limited'
      ? (data.message || 'rate-limited; backing off') + (retryIn ? ' · retrying ' + retryIn : '')
      : 'usage unavailable';
    return html`
      <div class="usage-row usage-row-quiet">
        <span class="usage-row-quiet-name">
          <span class="usage-provider-name">${label}</span>
          <${CliVersionChips} name=${name} />
        </span>
        <span class="muted small" title=${data.status === 'rate-limited'
          ? 'The provider rate-limited the usage endpoint. Showing the last cached answer; refresh is intentionally ignored until the backoff lifts.'
          : ''}>${note}</span>
      </div>`;
  }

  return html`
    <div class="usage-row">
      <div class="usage-row-head">
        <span class="usage-provider-name">${label}</span>
        <${CliVersionChips} name=${name} />
        ${data.plan && html`<span class="usage-plan-chip"
          title=${name === 'claude'
            ? 'Plan as recorded at your last Claude Code login — run /login in Claude Code to refresh (usage percentages are computed server-side against your real limits either way)'
            : 'Plan reported live by the provider'}>${data.plan}</span>`}
        ${name === 'codex' && data.asOf && html`<span class="muted small usage-asof">as of ${timeAgo(data.asOf)}</span>`}
      </div>
      <div class="usage-gauges">
        ${(data.windows || []).length === 0
          ? html`<span class="muted small">no quota data</span>`
          : data.windows.map((w) => html`<${UsageGauge} key=${w.id} w=${w} />`)}
        ${(data.scopedLimits || []).length > 0 && html`
          <div class="usage-scoped-limits">
            ${data.scopedLimits.map((lim) => html`<${ScopedLimitRow} key=${lim.model} lim=${lim} />`)}
          </div>`}
      </div>
    </div>`;
}

// Kimi Code (`kimi web`) — GET /api/usage's `kimi` block. Deliberately NOT
// rendered through ProviderUsageRow: Kimi publishes no quota anywhere (see the
// Kimi section in lib/usage.mjs), so a gauge here would be invented. What it
// does have is stack info — is the server beating, which version, where it
// listens, how many sessions/workspaces, and what the newest session spent —
// so this row carries chips + facts instead of bars, in the same card language.
//
// Renders NOTHING when Kimi isn't installed (status 'not-installed', or the
// block missing entirely on an older server), exactly like a machine without
// Codex looks in the rows above.
const KIMI_STATE_LABEL = { running: 'running', stale: 'stale', stopped: 'stopped' };

// Last "/"-separated segment — "kimi-code/k3" -> "k3" for model ids (the
// provider prefix is identical on every Kimi model and just eats width in a
// ~350px card), and "/home/me/code/thing" -> "thing" for the fallback
// workspace name when workspaces.json didn't name it.
function lastSegment(value) {
  if (!value) return null;
  const trimmed = value.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function KimiServerChip({ server }) {
  if (!server) {
    return html`<span class="usage-state-chip state-stopped"
      title=${'No `kimi web` server record in ~/.kimi-code/server/instances'}>○ not running</span>`;
  }
  const state = KIMI_STATE_LABEL[server.state] || server.state || 'unknown';
  const age = typeof server.heartbeatAgeMs === 'number' ? Math.max(0, Math.round(server.heartbeatAgeMs / 1000)) : null;
  const staleAfter = typeof server.staleAfterMs === 'number' ? Math.round(server.staleAfterMs / 1000) : null;
  // Never state-by-color-alone: the glyph and the word both change with state.
  const glyph = server.state === 'running' ? '●' : server.state === 'stale' ? '◐' : '○';
  const title = [
    age != null ? `Heartbeat ${age}s ago` : 'No heartbeat recorded',
    staleAfter != null ? `the server rewrites it every 15s; treated as stale after ${staleAfter}s` : null,
    server.state === 'stale' ? 'the process still exists but stopped beating' : null,
    server.instances > 1 ? `${server.instances} instance records on disk (newest shown)` : null
  ].filter(Boolean).join(' — ');
  return html`<span class=${'usage-state-chip state-' + (server.state || 'stopped')} title=${title}>${glyph} ${state}</span>`;
}

function KimiUsageRow({ data }) {
  if (!data || data.status === 'not-installed') return null;

  const label = PROVIDER_LABEL.kimi;
  if (data.status === 'error' || data.status === 'no-data') {
    return html`
      <div class="usage-row usage-row-quiet">
        <span class="usage-row-quiet-name"><span class="usage-provider-name">${label}</span></span>
        <span class="muted small">${data.status === 'no-data' ? 'installed · no sessions yet' : 'stack info unavailable'}</span>
      </div>`;
  }

  const server = data.server;
  const sessions = data.sessions || { total: 0, workspaces: [] };
  const workspaces = sessions.workspaces || [];
  const latest = data.latestSession;
  const endpoint = server && server.port ? `${server.host || '127.0.0.1'}:${server.port}` : null;
  const tokens = latest && latest.tokens ? latest.tokens : null;

  return html`
    <div class="usage-row">
      <div class="usage-row-head">
        <span class="usage-provider-name">${label}</span>
        ${server && server.version && html`<span class="usage-version-chip"
          title=${'`kimi web` host version, as recorded by the server itself'}>🏷️ ${server.version}</span>`}
        <${KimiServerChip} server=${server} />
        ${data.asOf && html`<span class="muted small usage-asof">as of ${timeAgo(data.asOf)}</span>`}
      </div>
      <div class="usage-kimi-facts">
        ${endpoint && html`<span class="usage-kimi-endpoint" title="Address the kimi web server recorded for itself">${endpoint}</span>`}
        <span>${sessions.total} session${sessions.total === 1 ? '' : 's'}${workspaces.length
          ? ` · ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`
          : ''}</span>
      </div>
      ${latest && html`
        <div class="usage-kimi-latest" title=${[
          latest.title || null,
          latest.workDir || null,
          tokens ? `${tokens.input.toLocaleString()} in · ${tokens.output.toLocaleString()} out · ${tokens.cacheRead.toLocaleString()} cache read` : null,
          tokens && tokens.truncated ? 'token totals partial — session logs exceeded the read budget' : null
        ].filter(Boolean).join('\n')}>
          <span class="usage-kimi-latest-label">latest</span>
          <span class="usage-kimi-latest-name">${latest.workspaceName || lastSegment(latest.workDir) || latest.title || latest.id}</span>
          ${latest.model && html`<span class="usage-kimi-model">${lastSegment(latest.model)}</span>`}
          ${tokens && tokens.total > 0 && html`<span class="muted small">${formatTokens(tokens.total)} tokens${tokens.truncated ? '+' : ''}</span>`}
          ${tokens && tokens.turns > 0 && html`<span class="muted small">· ${tokens.turns} turn${tokens.turns === 1 ? '' : 's'}</span>`}
        </div>`}
    </div>`;
}

// Gemini / Antigravity CLI (`agy`) — GET /api/usage's `gemini` block. Same
// treatment and same reason as KimiUsageRow above: the provider publishes no
// limit, no utilization and no reset instant anywhere the CLI writes down (see
// the Gemini section in lib/usage.mjs), so a gauge here would be fabricated.
// Chips + facts instead of bars.
//
// The ONE quota fact that is real is `quota.lastExhaustedAt` — not "how much is
// left" but "the API answered 429 RESOURCE_EXHAUSTED, at this instant". It gets
// an amber chip, and only when it actually happened, so a healthy machine sees
// nothing. Renders NOTHING at all when the CLI isn't installed, exactly like
// the Codex and Kimi rows on a machine without them.
//
// That chip is deliberately understated (bd-console-a2h). The server now counts
// INCIDENTS rather than log lines — the CLI logs one 429 up to three times as it
// propagates — and says when the request that hit the limit was the CLI's own
// background cache refresh. "background quota hit" is the honest wording for a
// poller tripping a limit while the user hasn't touched the CLI in weeks; the
// chip must never read as "you burned your quota" when nobody did.
function GeminiServerChip({ server, auth }) {
  if (!server) {
    return html`<span class="usage-state-chip state-stopped"
      title="No language-server log in ~/.gemini/antigravity-cli/log">○ not running</span>`;
  }
  const state = KIMI_STATE_LABEL[server.state] || server.state || 'unknown';
  const idle = typeof server.logIdleMs === 'number' ? Math.max(0, Math.round(server.logIdleMs / 1000)) : null;
  const idleAfter = typeof server.idleAfterMs === 'number' ? Math.round(server.idleAfterMs / 1000) : null;
  const glyph = server.state === 'running' ? '●' : server.state === 'stale' ? '◐' : '○';
  const title = [
    idle != null ? `Language server last wrote to its log ${idle}s ago` : 'No log activity recorded',
    idleAfter != null ? `a live CLI refreshes every ~6 min; treated as gone quiet after ${idleAfter}s` : null,
    server.state === 'stale' ? `pid ${server.pid} still exists but the log went quiet` : null,
    auth && auth.state === 'signed-out' ? 'not signed in to Antigravity' : null
  ].filter(Boolean).join(' — ');
  return html`<span class=${'usage-state-chip state-' + (server.state || 'stopped')} title=${title}>${glyph} ${state}</span>`;
}

function GeminiUsageRow({ data }) {
  if (!data || data.status === 'not-installed') return null;

  const label = PROVIDER_LABEL.gemini;
  if (data.status === 'error' || data.status === 'no-data') {
    return html`
      <div class="usage-row usage-row-quiet">
        <span class="usage-row-quiet-name"><span class="usage-provider-name">${label}</span></span>
        <span class="muted small">${data.status === 'no-data' ? 'installed · no sessions yet' : 'stack info unavailable'}</span>
      </div>`;
  }

  const server = data.server;
  const auth = data.auth || { state: 'unknown', method: null };
  const convos = data.conversations || { total: 0, workspaces: [], latest: null };
  const workspaces = convos.workspaces || [];
  const latest = convos.latest;
  const quota = data.quota || {};
  const exhaustedAt = typeof quota.lastExhaustedAt === 'number' ? quota.lastExhaustedAt : null;
  const httpPort = (server && (server.ports || []).find((p) => p.protocol === 'http')) || null;

  return html`
    <div class="usage-row">
      <div class="usage-row-head">
        <span class="usage-provider-name">${label}</span>
        ${server && server.version && html`<span class="usage-version-chip"
          title="Antigravity language-server version, as the CLI logged it at startup">🏷️ ${server.version}</span>`}
        <${GeminiServerChip} server=${server} auth=${auth} />
        ${auth.state === 'signed-out' && html`<span class="usage-state-chip"
          title="The CLI's log says it is not signed in to Antigravity">○ signed out</span>`}
        ${data.asOf && html`<span class="muted small usage-asof">as of ${timeAgo(data.asOf)}</span>`}
      </div>
      <div class="usage-gemini-facts">
        ${httpPort && html`<span class="usage-gemini-endpoint" title="Local language-server HTTP port the CLI bound at startup">127.0.0.1:${httpPort.port}</span>`}
        <span>${convos.total} conversation${convos.total === 1 ? '' : 's'}${workspaces.length
          ? ` · ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`
          : ''}</span>
        <span title=${'Gemini/Antigravity publishes no quota numbers anywhere on disk — '
          + 'the only quota fact available is whether the API returned 429 RESOURCE_EXHAUSTED'}>no quota published</span>
        ${exhaustedAt && html`<span class="usage-gemini-throttle" title=${[
          `${quota.exhaustedEvents} RESOURCE_EXHAUSTED (429) incident${quota.exhaustedEvents === 1 ? '' : 's'} in the scanned log tail`,
          quota.exhaustedLogLines > quota.exhaustedEvents
            ? `${quota.exhaustedLogLines} log lines — the CLI logs one failure up to three times as it propagates`
            : null,
          quota.lastExhaustedOrigin === 'background'
            ? 'logged by the CLI\'s own background cache refresh, not by anything you asked it to do'
            : null
        ].filter(Boolean).join('\n')}>⚠️ ${quota.lastExhaustedOrigin === 'background' ? 'background quota hit' : 'quota hit'} ${timeAgo(exhaustedAt)}</span>`}
      </div>
      ${latest && html`
        <div class="usage-gemini-latest" title=${[
          latest.title || null,
          latest.workspace || null,
          latest.app ? `recorded under ~/.gemini/${latest.app}` : null
        ].filter(Boolean).join('\n')}>
          <span class="usage-gemini-latest-label">latest</span>
          <span class="usage-gemini-latest-name">${lastSegment(latest.workspace) || latest.title || latest.id}</span>
          ${latest.steps > 0 && html`<span class="muted small">${latest.steps} step${latest.steps === 1 ? '' : 's'}</span>`}
          ${latest.updatedAt && html`<span class="muted small">· ${timeAgo(latest.updatedAt)}</span>`}
        </div>`}
    </div>`;
}

// Manual "↻ refresh" — reloads both the live-quota gauges and the (heavier)
// attribution history at whatever range is currently selected.
//
// This is the human fast path, so the quota call asks the server to bypass its
// own 5-minute OK-cache (?fresh=1). The server can still legitimately answer
// from cache — during a 429 backoff, or when ↻ was clicked seconds ago — and
// says so with `cached: true`. A button that silently does nothing is worse
// than one that explains itself, so toast the reason in that case; a genuinely
// fresh answer just re-renders the gauges and stays quiet.
async function refreshUsageAll() {
  loadUsageHistory();
  const providers = await loadUsage({ fresh: true });
  const claude = providers && providers.claude;
  if (!claude || !claude.cached) return;
  if (claude.status === 'rate-limited') {
    const when = retryInText(claude.retryAt);
    toast(`Claude usage is rate-limited — showing cached data${when ? ', retrying ' + when : ''}`, 'warn', 6000);
  } else {
    toast('Claude usage was just refreshed — showing cached data', 'info', 3200);
  }
}

// "in Xm" / "in Xh Ym" for a server-supplied retryAt (when a 429 backoff
// lifts), or null when there's nothing useful to say.
function retryInText(retryAt) {
  if (!retryAt) return null;
  const mins = Math.round((retryAt - Date.now()) / 60000);
  if (mins <= 0) return 'shortly';
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function HistoryRangePicker({ days, onChange }) {
  return html`
    <div class="usage-range-picker" role="group" aria-label="History range">
      ${HISTORY_RANGE_OPTIONS.map((d) => html`
        <button key=${d} type="button" class=${'usage-range-btn' + (d === days ? ' active' : '')}
          aria-pressed=${d === days} onClick=${() => onChange(d)}>${d}d</button>`)}
      <button type="button" class="icon-btn usage-refresh-btn" title="Refresh usage" onClick=${refreshUsageAll}>↻</button>
    </div>`;
}

// Attribution band — GET /api/usage/history. Clearly headed as historical/
// estimated (NOT quota) since it comes from parsing local session logs
// rather than the provider's own usage endpoint. Degrades to nothing when
// the route itself is unavailable (older server, or backend still landing);
// individual providers degrade to a "gathering usage…" note via
// ProviderAttribution when the route works but has no data yet.
//
// Its own collapse toggle (id 'attrib'), separate from the live-quota
// section's 'usage' id — and unlike every other hub-section toggle, this one
// collapses at EVERY viewport, not just <=768px (see .usage-attrib-head /
// .usage-attrib-body.collapsed in styles.css, deliberately not gated by the
// mobile media query). Defaults to collapsed (store.js) so project cards sit
// higher on the page without the heavier chart content pushing them down;
// still fully expandable, and the choice persists like every other hub
// section's collapse state.
// One-line "worth opening" teaser shown next to the collapsed head — total
// tokens across both providers over the current range, so the collapsed
// state still communicates there's real content underneath instead of
// reading as an empty/optional section.
function attribTeaser(history, days) {
  const total = (history?.claude?.totalTokens || 0) + (history?.codex?.totalTokens || 0);
  if (!total) return null;
  return `${formatTokens(total)} tokens · last ${days}d`;
}

function AttributionBand() {
  const days = store.usageHistoryDays.value;
  useEffect(() => { loadUsageHistory(days); }, []);
  // Skips ticks while the tab is hidden and catches up on return — see
  // public/ui/poll.js. Reads the range signal fresh on every tick rather
  // than closing over `days`, so a range change while this poll is already
  // running keeps polling the newly selected range instead of the one that
  // was active when the effect first mounted.
  useVisiblePoll(() => loadUsageHistory(store.usageHistoryDays.value), USAGE_HISTORY_POLL_MS);

  if (!store.usageHistoryAvailable.value) return null;
  const collapsed = store.collapsedHubSections.value.has('attrib');
  const history = store.usageHistory.value;

  // The heading is styled to match its siblings exactly ("Live quota",
  // "Terminal sessions", "Tracked Projects" — all .hub-section-head h2): this
  // band is one section among several, and a heading that shouts louder than
  // the others just reads as inconsistent. What carries the weight instead is
  // the expand affordance, which is a real .hub-chip — the same chip treatment
  // as the ops strip — rather than a quiet word that could be mistaken for a
  // label. The chip is a <span>, not a <button>: the whole head IS the button,
  // and a nested button would be invalid markup and a second tab stop for one
  // action. The teaser (token total over the range) stays on the heading line
  // so the collapsed state still says there's something underneath.
  const head = (summary, teaser) => html`
    <button type="button" class="usage-attrib-head" aria-expanded=${!collapsed} onClick=${() => toggleHubSection('attrib')}>
      <span class="usage-band-label">
        Usage attribution
        <span class="muted small">· ${summary}${teaser ? ' · ' + teaser : ''}</span>
      </span>
      <span class="hub-chip usage-attrib-chip" data-attrib-toggle>${collapsed ? 'Show more' : 'Show less'}</span>
      <${ChevronIcon} open=${!collapsed} alwaysVisible=${true} />
    </button>`;

  if (!history) {
    return html`
      <div class="usage-band usage-attrib-band">
        ${head('estimated, not quota')}
        <div class=${'usage-attrib-body' + (collapsed ? ' collapsed' : '')}>
          <p class="muted small usage-empty">${store.usageHistoryLoading.value ? 'Gathering usage…' : 'No usage history yet.'}</p>
        </div>
      </div>`;
  }

  const claude = history.claude ? { ...history.claude, _days: days } : null;
  const codex = history.codex ? { ...history.codex, _days: days } : null;

  return html`
    <div class="usage-band usage-attrib-band">
      ${head('estimated from local session logs, not quota', attribTeaser(history, days))}
      <div class=${'usage-attrib-body' + (collapsed ? ' collapsed' : '')}>
        <div class="usage-band-head usage-attrib-controls">
          <${HistoryRangePicker} days=${days} onChange=${(d) => loadUsageHistory(d)} />
        </div>
        <${ProviderAttribution} label="Claude Code" data=${claude} showProjectCharts=${true} />
        <${ProviderAttribution} label="Codex" data=${codex} showProjectCharts=${false} />
      </div>
    </div>`;
}

// Live quota (left, ~1/3) + terminal sessions (right, ~2/3), side by side at
// equal height — see .hub-qs-grid in styles.css. Both halves keep their own
// pre-existing collapse id ('usage' for quota, 'tmux' for sessions) and the
// same hub-section-toggle-inline/hub-section-body markup every other hub
// section uses, so the existing <=768px mobile-collapse behavior (and the
// "desktop is unaffected" CSS gating that comes with it) is untouched — at
// that breakpoint the grid also drops to a single column (styles.css) so the
// two halves simply stack full-width in the same top-to-bottom order as
// before this change (quota above sessions).
//
// This function owns the live-quota poll effect (previously UsageSection's)
// and is always called unconditionally from HubView (never short-circuited
// by `&&`) so that hook stays at a stable position across renders even
// though either half — or both — can independently render nothing.
function QuotaSessionsRow() {
  useEffect(() => {
    loadUsage();
    // One-shot, NOT part of the poll below — the server caches the CLI
    // registry lookup for hours (same reasoning as loadBdVersion() in
    // OpsStrip), so polling it on USAGE_POLL_MS would just re-read the same
    // cached value for no benefit.
    loadCliVersions();
  }, []);
  // Skips ticks while the tab is hidden and catches up on return — see
  // public/ui/poll.js, which is where this behavior now lives so that
  // ScheduleView's usage poll gets it too instead of a copy.
  useVisiblePoll(() => loadUsage(), USAGE_POLL_MS);

  const projects = store.projects.value;
  const hasProjects = Object.keys(projects).length > 0;
  const showQuota = store.usageAvailable.value;
  // Preserves the old TmuxSection's "hide entirely with zero registered
  // projects" behavior in addition to the tmux-unavailable case.
  const showSessions = hasProjects && store.tmuxAvailable.value;
  if (!showQuota && !showSessions) return null;

  const usage = store.usage.value || {};
  const usageCollapsed = store.collapsedHubSections.value.has('usage');
  // Kimi joins the collapsed-state summary only when it's actually installed —
  // on a machine without it the summary reads exactly as it did before.
  const usageSummary = `Claude ${summarizeUsage(usage.claude)} · Codex ${summarizeUsage(usage.codex)}`
    + (summarizeKimi(usage.kimi) ? ` · Kimi ${summarizeKimi(usage.kimi)}` : '')
    + (summarizeGemini(usage.gemini) ? ` · Gemini ${summarizeGemini(usage.gemini)}` : '');

  const sessions = store.tmuxSessions.value;
  const tmuxCollapsed = store.collapsedHubSections.value.has('tmux');
  const attached = sessions.filter((s) => s.attached).length;
  const unattended = sessions.filter((s) => s && s.idle).length;
  const hotSessions = sessions.filter((s) => s && s.memory && s.memory.level !== 'ok').length;
  const tmuxSummary = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${attached} attached`
    + (hotSessions > 0 ? ` · ${hotSessions} high memory` : '')
    + (unattended > 0 ? ` · ${unattended} unattended` : '');

  return html`
    <div class=${'hub-qs-grid' + (showQuota && showSessions ? '' : ' single-col')}>
      ${showQuota && html`
        <section class="hub-section hub-qs-quota">
          <div
            class="hub-section-head hub-section-toggle-inline"
            role="button"
            tabIndex="0"
            aria-expanded=${!usageCollapsed}
            onClick=${() => toggleHubSection('usage')}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHubSection('usage'); } }}
          >
            <h2>Live quota</h2>
            <span class="hub-section-toggle-summary">${usageSummary}</span>
            <${ChevronIcon} open=${!usageCollapsed} />
          </div>
          <div class=${'hub-section-body' + (usageCollapsed ? ' collapsed' : '')}>
            <div class="usage-rows">
              <${ProviderUsageRow} name="claude" data=${usage.claude} />
              <${ProviderUsageRow} name="codex" data=${usage.codex} />
              <${KimiUsageRow} data=${usage.kimi} />
              <${GeminiUsageRow} data=${usage.gemini} />
            </div>
          </div>
        </section>`}
      ${showSessions && html`
        <section class="hub-section hub-qs-sessions">
          <div
            class="hub-section-head hub-section-toggle-inline"
            role="button"
            tabIndex="0"
            aria-expanded=${!tmuxCollapsed}
            onClick=${() => toggleHubSection('tmux')}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHubSection('tmux'); } }}
          >
            <h2>Terminal sessions</h2>
            <span class="hub-section-toggle-summary">${tmuxSummary}</span>
            ${sessions.length > 0 && html`<button class="btn btn-ghost btn-xs" onClick=${(e) => { e.stopPropagation(); navigate('#/tmux'); }}>View all →</button>`}
            <${ChevronIcon} open=${!tmuxCollapsed} />
          </div>
          <div class=${'hub-section-body' + (tmuxCollapsed ? ' collapsed' : '')}>
            ${sessions.length === 0
              ? html`<p class="muted small hub-section-empty">No tmux sessions running.</p>`
              : html`<div class="hub-sessions-scroll"><div class="hub-tmux-rows">
                  <${HubTmuxHead} />
                  ${sessions.map((s) => html`<${SessionRowCompact} key=${s.name} session=${s} projects=${projects} onClick=${() => navigate('#/tmux')} />`)}
                </div></div>`}
          </div>
        </section>`}
    </div>`;
}

// Register a project without a terminal (bd-console-uwq). The hub's empty
// state used to say "run bd-console add" and stop there, which is a wall for
// anyone reading this over the tunnel from a phone.
//
// Note how little this component believes: it does not pre-judge the path,
// beyond refusing to submit an empty one. Every real answer — absolute?
// exists? a beads project? already registered? — comes from POST /api/register
// (see registerProjectPath in lib/registry.mjs), because the browser has no
// view of the daemon's filesystem and a guess rendered as an error would just
// be a lie with a red border.
function AddProjectForm({ onAdded }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const value = path.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const data = await apiPostRaw('/api/register', { path: value });
      await loadHub();
      toast(`Registered ${data.id}`);
      setPath('');
      if (onAdded) onAdded(data.id);
    } catch (err) {
      if (err instanceof AuthError) requireToken('A write token is required to register a project.');
      setError(err.message || 'Could not register that project.');
    } finally {
      setBusy(false);
    }
  };

  return html`
    <form class="hub-add" onSubmit=${submit}>
      <div class="hub-add-row">
        <input class="hub-add-input" type="text" spellcheck="false" autocapitalize="off" autocorrect="off"
          aria-label="Project folder on the machine running bd-console"
          placeholder="/home/you/code/my-project"
          value=${path} onInput=${(e) => { setPath(e.target.value); setError(null); }} />
        <button class="btn" type="submit" disabled=${busy || !path.trim()}>${busy ? 'Adding…' : 'Add project'}</button>
      </div>
      <p class="muted small hub-add-hint">
        The folder as it exists on the machine running bd-console — it must already contain a <code>.beads/</code> directory (run <code>bd init</code> there first). <code>~</code> works.
      </p>
      ${error && html`<p class="hub-add-error" role="alert">${error}</p>`}
    </form>`;
}

export function HubView() {
  const projects = store.projects.value;
  const entries = Object.entries(projects);
  const [statsById, setStatsById] = useState({});
  const [statErrors, setStatErrors] = useState(new Set());
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    let live = true;
    const nextStats = {};
    const nextErrors = new Set();
    Promise.all(entries.map(async ([id]) => {
      try { nextStats[id] = await loadProjectStats(id); }
      catch { nextErrors.add(id); }
    })).then(() => {
      if (!live) return;
      setStatsById(nextStats);
      setStatErrors(nextErrors);
    });
    return () => { live = false; };
  }, [entries.map(([id]) => id).join('\n')]);

  return html`
    <main class="hub">
      <div class="hub-header">
        <h1>Global Hub</h1>
        <p class="hub-header-tagline muted small">Select a project to manage its beads.</p>
        ${OpsStrip()}
      </div>

      <${ProjectRadar} entries=${entries} statsById=${statsById} errors=${statErrors} />

      ${QuotaSessionsRow()}

      ${AttributionBand()}

      ${entries.length === 0
        ? html`<div class="empty-state hub-empty-state">
            <div class="empty-icon">◇</div>
            <p>No projects registered.</p>
            <p class="muted small">Add the first one here — no terminal required.</p>
            <${AddProjectForm} />
            <p class="muted small hub-add-cli">
              Or, from a shell on that machine: <code>bd-console add</code> inside the project (or <code>bd-console add /path/to/project</code> from anywhere).
            </p>
          </div>`
        : html`
          <div class="hub-section-head hub-projects-head">
            <h2>Tracked Projects</h2>
            <button class="btn btn-ghost btn-xs" onClick=${() => setAddOpen(!addOpen)}>${addOpen ? 'Cancel' : '+ Add project'}</button>
          </div>
          ${addOpen && html`<div class="hub-add-wrap"><${AddProjectForm} onAdded=${() => setAddOpen(false)} /></div>`}
          <div class="hub-grid">
            ${entries.map(([id, project]) => html`<${ProjectCard} key=${id} id=${id} project=${project}
              stats=${statsById[id]} err=${statErrors.has(id)} />`)}
          </div>`}
    </main>`;
}
