// HubView.js — the global hub landing page: a hero header, a live tmux
// sessions strip, and a responsive grid of project cards carrying issue
// metrics and (optional) git insights.
//
// Split into components/hub/* (bd-console-974.7) as this file grew past
// ~1000 lines: hub/shared.js (tiny cross-cutting bits), hub/ProjectGrid.js
// (project radar/cards/add-project form), hub/UsageSection.js (live quota +
// terminal sessions row + usage-attribution band). What's left here is the
// hub shell itself — the header, the ops strip (bd version/tmux/schedule
// chips — small enough, and tied closely enough to loadBdVersion, that it
// didn't earn its own module), and the top-level layout/data-loading that
// wires the pieces together.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { store, navigate, loadProjectStats, loadTmux, loadSchedule, loadProjectsGit, loadBdVersion, toggleHubSection, loadHub, loadBootMeta } from '../store.js';
import { timeAgo, hostMemSummary, hostMemTip } from './common.js';
import { ChevronIcon, ExternalLinkIcon, copyUpdateCommand } from './hub/shared.js';
import { ProjectRadar, ProjectCard, AddProjectForm } from './hub/ProjectGrid.js';
import { QuotaSessionsRow, AttributionBand } from './hub/UsageSection.js';

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
// now rendered inline inside QuotaSessionsRow (components/hub/UsageSection.js),
// side by side with the live quota band — showing every session (no 6-row
// cap) inside its own internally-scrolling container instead of truncating.

// ---------------------------------------------------------------------------
// bd (beads CLI) version helpers — GET /api/bd-version (see lib/bdversion.mjs)
// backs the version/update/multi-binary chips rendered inline in OpsStrip
// above (one-shot fetch there; the server caches the GitHub lookup for hours,
// so polling would just re-hit the same cached value). A manual refresh
// isn't offered from the hub — Settings has the fuller card + explicit
// "recheck". These used to back a standalone BdVersionRow beneath the
// header; consolidated into the single ops chip row per the hub cleanup.
// ---------------------------------------------------------------------------
const BEADS_REPO_URL = 'https://github.com/gastownhall/beads';
const BEADS_DOCS_URL = 'https://beads.gascity.com';

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
        ? store.hubUnreachable.value
          ? html`<div class="empty-state hub-empty-state hub-unreachable-state">
              <div class="empty-icon">⚠</div>
              <p>Can't reach the bd-console server.</p>
              <p class="muted small">
                The daemon may be down, or this network can't reach it. Check that it's running on the host and
                that this browser can reach its address, then retry.
              </p>
              <button class="btn" onClick=${() => { loadHub(); loadBootMeta(); }}>Retry</button>
            </div>`
          : html`<div class="empty-state hub-empty-state">
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
