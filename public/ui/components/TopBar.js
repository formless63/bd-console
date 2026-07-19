// TopBar.js — sticky application header: brand, hub link, live health/export
// indicator, theme picker, token settings, refresh and quick-capture.
import { html } from 'htm/preact';
import { store, navigate, loadIssues, loadDocs, loadHub, tally } from '../store.js';
import { THEME_PRESETS, SCHEMES, setPreset, setScheme } from '../theme.js';
import { syncLabel, syncState } from './common.js';

function ThemePicker() {
  return html`
    <div class="theme-picker">
      <sl-select
        class="theme-select"
        size="small"
        value=${store.themePreset.value}
        onsl-change=${(e) => setPreset(e.target.value)}
        title="Theme preset"
      >
        ${THEME_PRESETS.map((p) => html`<sl-option key=${p.id} value=${p.id}>${p.name}</sl-option>`)}
      </sl-select>
      <sl-select
        class="scheme-select"
        size="small"
        value=${store.themeScheme.value}
        onsl-change=${(e) => setScheme(e.target.value)}
        title="Light / dark"
      >
        ${SCHEMES.map((s) => html`<sl-option key=${s.id} value=${s.id}>${s.name}</sl-option>`)}
      </sl-select>
    </div>`;
}

function HubNav() {
  const view = store.route.value.view;
  return html`
    <nav class="hub-nav">
      <button class=${'nav-link' + (view === 'tmux' ? ' active' : '')} onClick=${() => navigate('#/tmux')} title="tmux sessions">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1 3a1 1 0 011-1h12a1 1 0 011 1v10a1 1 0 01-1 1H2a1 1 0 01-1-1V3zm2 1.5L5.5 7 3 9.5l1 1L7.5 7 4 3.5l-1 1zM8 10h5v1H8v-1z"/></svg>
        <span class="hide-sm">Terminal</span>
      </button>
      <button class=${'nav-link' + (view === 'schedule' ? ' active' : '')} onClick=${() => navigate('#/schedule')} title="Prompt scheduler">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 100 14A7 7 0 008 1zm.75 3.5v4l3 1.8-.6 1-3.65-2.2V4.5h1.25z"/></svg>
        <span class="hide-sm">Schedule</span>
      </button>
    </nav>`;
}

function BrandLink({ name }) {
  return html`
    <button class="brand-link" onClick=${() => navigate('#/')} title="bd-console — back to hub">
      ${name}
    </button>`;
}

function HealthPill() {
  const route = store.route.value;
  if (route.view !== 'project') return null;
  const meta = store.meta.value || {};
  const exp = meta.export;
  const t = tally.value;
  const state = syncState(exp);
  return html`
    <sl-tooltip content=${'Export ' + syncLabel(exp) + '. bd ' + (meta.health?.bdVersion || '?')}>
      <div class=${'health-pill state-' + state}>
        <span class="hp-dot"></span>
        <span class="hp-count">${store.issues.value.length}</span>
        <span class="hp-sep">·</span>
        <span class="hp-open">${t.open} open</span>
        <span class="hp-blocked">${t.blocked} blocked</span>
      </div>
    </sl-tooltip>`;
}

export function TopBar() {
  const route = store.route.value;
  const inProject = route.view === 'project';
  const name = inProject ? (store.meta.value?.name || route.projectId) : 'bd-console';

  const refresh = async () => {
    if (route.view === 'hub') { loadHub(); return; }
    await loadIssues({ force: true });
    if (store.docs.value.length) loadDocs();
  };

  return html`
    <header class="topbar">
      <div class="brand">
        ${inProject
          ? html`<button class="icon-btn ghost hub-back" title="Back to hub" onClick=${() => navigate('#/')}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10 12L6 8l4-4v8z"/></svg>
              <span>Hub</span>
            </button>`
          : html`<span class="brand-dot"></span>`}
        <${BrandLink} name=${name} />
      </div>

      <div class="topbar-right">
        ${HubNav()}
        ${HealthPill()}
        ${inProject && html`<button class="btn btn-accent new-issue-trigger" onClick=${() => (store.createOpen.value = true)} title="New issue (i)">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1v6H2v2h6v6h2V9h6V7h-6V1z"/></svg>
          <span class="hide-sm">New issue</span>
        </button>`}
        ${ThemePicker()}
        <button class=${'icon-btn settings-trigger' + (route.view === 'settings' ? ' active' : '')} title="Settings" onClick=${() => navigate('#/settings')}>
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.5 7.5 0 000-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1l-.4-2.5H10l-.4 2.5c-.6.3-1.2.6-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 000 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.4 2.5h4l.4-2.5c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z"/></svg>
        </button>
        <button class="icon-btn" title="Reload data" onClick=${refresh}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 3a5 5 0 104.546 2.914l1.32-1.32V8H10.5l1.243-1.243A3.5 3.5 0 1011.5 8H13A5 5 0 008 3z"/></svg>
        </button>
      </div>
    </header>`;
}
