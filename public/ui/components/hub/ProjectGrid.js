// components/hub/ProjectGrid.js — the hub's project-facing surfaces: the
// "project radar" strip, the per-project cards (with optional git insights),
// and the no-terminal-required "add a project" form. Split out of HubView.js
// (bd-console-974.7) as a mechanical move — nothing here changed shape, only
// address; HubView.js still owns loading stats and deciding what to render
// when there are zero projects (onboarding vs. "server unreachable").
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { store, navigate, toast, loadHub, requireToken } from '../../store.js';
import { apiPostRaw, AuthError } from '../../api.js';
import { timeAgo } from '../common.js';

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

export function ProjectCard({ id, project, stats, err }) {
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
export function ProjectRadar({ entries, statsById, errors }) {
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
export function AddProjectForm({ onAdded }) {
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
