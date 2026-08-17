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
import { store, parseHash, loadBootMeta, loadHub } from './ui/store.js';

// A narrow, explicitly-named escape hatch for scripts/smoke/browser.mjs (the
// opt-in real-Chrome domain): it needs to simulate a background live-refresh
// (store.issues replaced with fresh objects, same ids — exactly what
// loadIssues() does on an SSE-triggered reload) WITHOUT a real server round
// trip, to assert state-preservation invariants (an open Detail panel, an
// in-progress comment draft) survive it. Not used by any application code —
// only ever read from a headless Chrome the test suite itself launched
// against a scratch fixture. Exposing the live `store` object grants no
// capability a user's own devtools console didn't already have over their
// own page; it's just a named handle instead of a closure to break on.
if (typeof window !== 'undefined') {
  window.__BD_CONSOLE_TEST_HOOKS__ = { store };
}

// --- routing: hash-based so deep links survive a static-file server ----------
function syncRoute() {
  const route = store.route.value;
  if (route.view === 'console2') {
    // Console 2.0 (#/p2/<id>) owns its own project bootstrapping — see
    // console2/Console2.js's route effect + mount useEffect, which set
    // projectId and load issues/docs/tmux themselves. Nulling projectId
    // here (as the generic "not a project" branch below does) raced with
    // that: this handler runs synchronously right after the route signal
    // updates, before Console2's effects settle, so it could stomp the
    // pid Console2 had just set back to null and leak an unscoped
    // /api/issues + /api/docs fetch (404s in hub mode, since those only
    // exist per-project as /api/p/<id>/issues|docs). Leave projectId
    // alone here.
    return;
  }
  store.projectId.value = null;
  loadHub();
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
    return;
  }
  if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
  const view = store.route.value.view;
  // `i` opens the full New-issue dialog in the project view (Console 2.0
  // mounts the same dialog). `/` focuses the search box — Console 2.0's
  // omnibar carries the `.issue-search` class for exactly this.
  //
  // `c` (focus the comment box) went with the classic view: it targeted DOM
  // only its detail pane rendered. j/k came back for Console 2.0
  // (bd-console-974.6) as a card cursor over Flow, but — same ownership split
  // as `/` below — this handler is not where it lives: console2/keyboardNav.js
  // binds its own window keydown listener, scoped to exactly as long as the
  // console2 route is mounted, wired from Console2.js rather than here.
  if (e.key === 'i' && view === 'console2') { e.preventDefault(); store.createOpen.value = true; }
  // Ownership of `/` (bd-console-974.2): Omnibar.js binds its own window
  // keydown listener for '/' and owns it on the console2 view — it does more
  // than focus (also opens the palette via c2.omniOpen). Both handlers used
  // to fire unconditionally, so which one "won" for a given keypress depended
  // on registration order rather than which view was on screen. Skip here
  // whenever console2 is active so there's a single owner per view; every
  // other view (hub, tmux, schedule, settings) has no omnibar, so this
  // handler keeps focusing `.issue-search` for them.
  else if (e.key === '/' && view !== 'console2') { e.preventDefault(); document.querySelector('.issue-search')?.focus(); }
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
