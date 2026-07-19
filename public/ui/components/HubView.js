// HubView.js — the global hub landing page: a responsive grid of project cards,
// each showing live status tallies and linking through to the project view.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { store, navigate, loadProjectStats } from '../store.js';

const STATUS_META = [
  ['open', 'Open'], ['in_progress', 'Active'], ['blocked', 'Blocked'], ['closed', 'Closed'],
];

function ProjectCard({ id, project }) {
  const [stats, setStats] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    loadProjectStats(id).then((s) => live && setStats(s)).catch(() => live && setErr(true));
    return () => { live = false; };
  }, [id]);

  const open = () => navigate('#/p/' + encodeURIComponent(id));
  return html`
    <button class="hub-card" onClick=${open}>
      <div class="hub-card-top">
        <span class="hub-card-title">${id}</span>
        ${stats && html`<span class="hub-card-total">${stats.total} issues</span>`}
      </div>
      <div class="hub-card-path">${project.path}</div>
      <div class="hub-card-stats">
        ${err
          ? html`<span class="muted small">Failed to load</span>`
          : !stats
            ? STATUS_META.map(([k]) => html`<span key=${k} class="stat-pill skeleton-pill"></span>`)
            : STATUS_META.map(([k, label]) => html`
                <span key=${k} class=${'stat-pill s-' + k}>
                  <span class=${'dot-status st-' + k}></span>${stats[k]} ${label}
                </span>`)}
      </div>
      <div class="hub-card-cta">Open project →</div>
    </button>`;
}

export function HubView() {
  const projects = store.projects.value;
  const entries = Object.entries(projects);
  return html`
    <main class="hub">
      <div class="hub-header">
        <h1>Global Hub</h1>
        <p class="muted">Select a project to manage its beads.</p>
      </div>
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
