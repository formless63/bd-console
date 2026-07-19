// app.js — application entry point. Boots Shoelace + theme, wires routing and
// global keyboard shortcuts, then renders the Preact app.
import './ui/shoelace.js';
import { render } from 'preact';
import { html } from 'htm/preact';
import { App } from './ui/components/App.js';
import { initTheme } from './ui/theme.js';
import {
  store, parseHash, selectAdjacent, selectIssue,
  loadBootMeta, loadHub, loadProjectMeta, loadIssues, loadDocs,
} from './ui/store.js';

// --- routing: hash-based so deep links survive a static-file server ----------
let lastProjectId = null;
async function syncRoute() {
  const route = store.route.value;
  if (route.view === 'project') {
    store.projectId.value = route.projectId;
    if (route.projectId !== lastProjectId) {
      lastProjectId = route.projectId;
      store.issues.value = [];
      store.docs.value = [];
      store.selectedId.value = null;
      store.selectedDocPath.value = null;
      store.docContent.value = null;
      await loadProjectMeta();
      loadIssues();
      loadDocs();
    } else if (route.tab === 'docs' && store.docs.value.length === 0) {
      loadDocs();
    }
  } else {
    store.projectId.value = null;
    lastProjectId = null;
    loadHub();
  }
}

function onHashChange() {
  store.route.value = parseHash();
  syncRoute();
}

// --- global keyboard shortcuts ----------------------------------------------
function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || /^SL-(INPUT|SELECT|TEXTAREA)$/.test(tag);
}
function onKeyDown(e) {
  if (e.key === 'Escape') {
    if (store.createOpen.value) store.createOpen.value = false;
    if (store.tokenDialogOpen.value) store.tokenDialogOpen.value = false;
    if (store.mobileFiltersOpen.value) store.mobileFiltersOpen.value = false;
    return;
  }
  if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
  const inProject = store.route.value.view === 'project';
  if (e.key === 'i' && inProject) { e.preventDefault(); store.createOpen.value = true; }
  else if (e.key === 'j' && inProject) { e.preventDefault(); selectAdjacent(1); scrollSelectedIntoView(); }
  else if (e.key === 'k' && inProject) { e.preventDefault(); selectAdjacent(-1); scrollSelectedIntoView(); }
  else if (e.key === '/') { e.preventDefault(); document.querySelector('.issue-search')?.focus(); }
  else if (e.key === 'c') { const box = document.querySelector('#comment-input'); if (box) { e.preventDefault(); box.focus(); } }
}
function scrollSelectedIntoView() {
  setTimeout(() => document.querySelector('.issue-row.sel')?.scrollIntoView({ block: 'nearest' }), 40);
}

// --- boot --------------------------------------------------------------------
async function boot() {
  initTheme();
  render(html`<${App} />`, document.getElementById('app'));
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('keydown', onKeyDown);
  await loadBootMeta();
  store.route.value = parseHash();
  syncRoute();
}
boot();
