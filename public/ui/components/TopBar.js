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
        <span class="brand-name">${name}</span>
      </div>

      <div class="topbar-right">
        ${HealthPill()}
        ${inProject && html`<button class="btn btn-accent" onClick=${() => (store.quickOpen.value = true)} title="Capture an idea (i)">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1v6H2v2h6v6h2V9h6V7h-6V1z"/></svg>
          <span class="hide-sm">Idea</span>
        </button>`}
        ${ThemePicker()}
        <button class="icon-btn" title="Write token settings" onClick=${() => (store.tokenDialogOpen.value = true)}>
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.5 7.5 0 000-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1l-.4-2.5H10l-.4 2.5c-.6.3-1.2.6-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 000 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.7 1.7 1l.4 2.5h4l.4-2.5c.6-.3 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z"/></svg>
        </button>
        <button class="icon-btn" title="Reload data" onClick=${refresh}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 3a5 5 0 104.546 2.914l1.32-1.32V8H10.5l1.243-1.243A3.5 3.5 0 1011.5 8H13A5 5 0 008 3z"/></svg>
        </button>
      </div>
    </header>`;
}
