// HubView.js — the global hub landing page: a hero header, a live tmux
// sessions strip, and a responsive grid of project cards carrying issue
// metrics and (optional) git insights.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { store, navigate, loadProjectStats, loadTmux, loadSchedule, loadProjectsGit, toggleHubSection } from '../store.js';
import { timeAgo } from './common.js';
import { SessionRowCompact, HubTmuxHead } from './TmuxView.js';

// Chevron used by the mobile collapsible-section headers (ops strip, tmux
// strip) — see .hub-section-toggle / .hub-section-body in styles.css. Only
// visible at <=768px; on desktop the toggle header itself is hidden so this
// never renders there.
function ChevronIcon({ open }) {
  return html`<svg class="hub-section-chevron" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"
    style=${'transform:rotate(' + (open ? '0' : '-90') + 'deg)'}><path fill="currentColor" d="M4 6l4 4 4-4"/></svg>`;
}

const METRICS_META = [
  ['open', 'Ready', 'green'],
  ['in_progress', 'Active', 'accent'],
  ['blocked', 'Blocked', 'red'],
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

function ProjectCard({ id, project }) {
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    loadProjectStats(id).then((s) => live && setStats(s)).catch(() => live && setErr(true));
    return () => { live = false; };
  }, [id]);

  const git = store.projectsGit.value[id];
  // Console 2.0 is the hub's primary destination (the classic view is being
  // retired) — the card's whole click-through, and its CTA hint below, both
  // land on #/p2/<id>. The classic view stays reachable, just not from the
  // hub: Console 2.0's own header carries a "classic view →" link.
  const open = () => navigate('#/p2/' + encodeURIComponent(id));
  const onKeyDown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };

  return html`
    <div class="hub-card" role="button" tabIndex="0" onClick=${open} onKeyDown=${onKeyDown}>
      <div class="hub-card-top">
        <span class="hub-card-title">${id}</span>
        ${stats && html`<span class="hub-card-total">${stats.total} issue${stats.total === 1 ? '' : 's'}</span>`}
      </div>
      <div class="hub-card-path">${project.path}</div>

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
        <span>Open Console 2.0 →</span>
      </div>
    </div>`;
}

// One-shot (not polled) summary strip — cheap enough to fetch every time the
// hub mounts, but the tmux/schedule views themselves own the live polling.
//
// At <=768px this and the tmux strip below eat half the viewport before a
// single project card is visible, so both get a tappable, per-section
// collapse toggle (state persisted in store.collapsedHubSections / bd_hub_
// sections_collapsed) — collapsed by default on first mobile visit. The
// toggle header itself (.hub-section-toggle) is desktop-hidden and
// .hub-section-body's "collapsed" class only takes effect <=768px (see
// styles.css), so desktop rendering is untouched either way.
function OpsStrip() {
  useEffect(() => { loadTmux(); loadSchedule(); loadProjectsGit(); }, []);
  const sessions = store.tmuxSessions.value;
  const pending = store.scheduleJobs.value.filter((j) => j.status === 'pending').length;
  const hasTmux = store.tmuxAvailable.value;
  const collapsed = store.collapsedHubSections.value.has('ops');
  const summary = `${hasTmux ? sessions.length + ' tmux session' + (sessions.length === 1 ? '' : 's') : 'tmux unavailable'} · ${pending} scheduled prompt${pending === 1 ? '' : 's'}`;
  return html`
    <div class="hub-ops-wrap">
      <button type="button" class="hub-section-toggle" aria-expanded=${!collapsed} onClick=${() => toggleHubSection('ops')}>
        <span class="hub-section-toggle-label">Overview</span>
        <span class="hub-section-toggle-summary">${summary}</span>
        <${ChevronIcon} open=${!collapsed} />
      </button>
      <div class=${'ops-strip hub-section-body' + (collapsed ? ' collapsed' : '')}>
        <button class="ops-chip" onClick=${() => navigate('#/tmux')}>
          ${hasTmux ? `${sessions.length} tmux session${sessions.length === 1 ? '' : 's'}` : 'tmux unavailable'}
        </button>
        <span class="ops-sep">·</span>
        <button class="ops-chip" onClick=${() => navigate('#/schedule')}>
          ${pending} scheduled prompt${pending === 1 ? '' : 's'}
        </button>
      </div>
    </div>`;
}

function TmuxSection() {
  const hasTmux = store.tmuxAvailable.value;
  const sessions = store.tmuxSessions.value;
  const projects = store.projects.value;
  if (!hasTmux) return null;
  const collapsed = store.collapsedHubSections.value.has('tmux');
  const attached = sessions.filter((s) => s.attached).length;
  const summary = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${attached} attached`;
  return html`
    <section class="hub-section hub-tmux-section">
      <div
        class="hub-section-head hub-section-toggle-inline"
        role="button"
        tabIndex="0"
        aria-expanded=${!collapsed}
        onClick=${() => toggleHubSection('tmux')}
        onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHubSection('tmux'); } }}
      >
        <h2>Terminal sessions</h2>
        <span class="hub-section-toggle-summary">${summary}</span>
        ${sessions.length > 0 && html`<button class="btn btn-ghost btn-xs" onClick=${(e) => { e.stopPropagation(); navigate('#/tmux'); }}>View all →</button>`}
        <${ChevronIcon} open=${!collapsed} />
      </div>
      <div class=${'hub-section-body' + (collapsed ? ' collapsed' : '')}>
        ${sessions.length === 0
          ? html`<p class="muted small hub-section-empty">No tmux sessions running.</p>`
          : html`<div class="hub-tmux-rows">
              <${HubTmuxHead} />
              ${sessions.slice(0, 6).map((s) => html`<${SessionRowCompact} key=${s.name} session=${s} projects=${projects} onClick=${() => navigate('#/tmux')} />`)}
            </div>`}
      </div>
    </section>`;
}

export function HubView() {
  const projects = store.projects.value;
  const entries = Object.entries(projects);
  return html`
    <main class="hub">
      <div class="hub-header">
        <h1>Global Hub</h1>
        <p class="muted">Select a project to manage its beads.</p>
        ${OpsStrip()}
      </div>

      ${entries.length > 0 && TmuxSection()}

      ${entries.length === 0
        ? html`<div class="empty-state">
            <div class="empty-icon">◇</div>
            <p>No projects registered.</p>
            <p class="muted small">Run <code>bd-console add</code> inside a project to register it.</p>
          </div>`
        : html`<div class="hub-grid">
            ${entries.map(([id, project]) => html`<${ProjectCard} key=${id} id=${id} project=${project} />`)}
          </div>`}
    </main>`;
}
