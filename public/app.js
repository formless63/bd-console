// app.js — application entry point. Boots Shoelace + theme, wires routing and
// global keyboard shortcuts, then renders the Preact app.
import './ui/shoelace.js';

// --- stale-cache detection ---------------------------------------------------
// __BD_STAMP__ is replaced by the origin server with a fingerprint of the
// public/ tree as this file is served (see lib/routes.mjs). /api/meta reports
// the live fingerprint uncached. If they differ, THIS running file came from a
// cache (browser or a fronting CDN/proxy like Cloudflare). One automatic
// reload is attempted; if the mismatch survives it, the cache is upstream of
// the browser and only a purge/bypass rule can fix it — say so, loudly.
const ASSET_STAMP = '__BD_STAMP__';
async function verifyAssetFreshness() {
  if (ASSET_STAMP.startsWith('__BD_')) return; // unstamped origin (dev/direct file) — check disabled
  let live;
  try {
    const res = await fetch('/api/meta', { cache: 'no-store' });
    live = (await res.json()).assetStamp;
  } catch { return; }
  if (!live || live === ASSET_STAMP) { try { sessionStorage.removeItem('bd_stale_retry'); } catch {} return; }

  let retried = null;
  try { retried = sessionStorage.getItem('bd_stale_retry'); } catch { /* storage may be unavailable */ }
  if (retried !== live) {
    try { sessionStorage.setItem('bd_stale_retry', live); } catch {}
    location.reload();
    return;
  }

  // Reload didn't help — the stale copy is served by something upstream.
  // Plain DOM + inline styles on purpose: this must render even when the
  // running (stale) framework/CSS predates the current UI.
  const bar = document.createElement('div');
  bar.setAttribute('role', 'alert');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:10px 44px 10px 14px;'
    + 'background:#93000a;color:#ffdad6;font:13px/1.5 system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.4);';
  bar.innerHTML = '<b>Stale cached UI detected.</b> You are running assets stamped <code>' + ASSET_STAMP
    + '</code> but the server is on <code>' + live + '</code>, and a normal reload did not fix it. '
    + 'Try a hard reload (Ctrl/Cmd+Shift+R) or a private window first. If it keeps coming back, something in front '
    + '(e.g. Cloudflare) is caching these files or rewriting cache headers — set Browser Cache TTL to '
    + '"Respect Existing Headers", purge the cache for this host, or add a cache-bypass rule.';
  const x = document.createElement('button');
  x.textContent = '✕';
  x.setAttribute('aria-label', 'Dismiss');
  x.style.cssText = 'position:absolute;top:6px;right:8px;background:none;border:1px solid #ffdad6;'
    + 'color:#ffdad6;border-radius:4px;width:26px;height:26px;cursor:pointer;';
  x.onclick = () => bar.remove();
  bar.appendChild(x);
  document.body.appendChild(bar);
}
verifyAssetFreshness();
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
