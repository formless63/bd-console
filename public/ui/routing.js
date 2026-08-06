// routing.js — the hash router, as pure functions.
//
// Deliberately import-free (no signals, no DOM) so scripts/smoke.mjs can
// import and assert it in plain Node, the same way relationships.js and
// learn.js are asserted. store.js wraps parseRoute() with the one side effect
// that genuinely needs the DOM (rewriting a retired URL in place).
//
// Retired route: `#/p/<id>` and `#/p/<id>/docs` were the classic per-project
// view (three-pane issues layout + docs tab). Console 2.0 (`#/p2/<id>`) is the
// only per-project view now, so those hashes REDIRECT rather than 404 or fall
// back to the hub — bookmarks and pasted links from before the retirement have
// to keep landing on the project they name.

// Returns the canonical hash a retired hash should become, or null if `hash`
// isn't a retired route. The project segment is passed through still-encoded,
// so `#/p/my%20repo/docs` → `#/p2/my%20repo`.
export function legacyProjectHash(hash) {
  const parts = String(hash || '').replace(/^#/, '').split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) return '#/p2/' + parts[1];
  return null;
}

// hash -> route object. `p` and `p2` both resolve to the console2 view: the
// redirect below is a URL rewrite, and this is the belt-and-braces half — even
// if the rewrite is unavailable (no history API), a retired hash still renders
// Console 2.0 instead of dumping the user on the hub.
export function parseRoute(hash) {
  const parts = String(hash || '').replace(/^#/, '').split('/').filter(Boolean);
  if ((parts[0] === 'p2' || parts[0] === 'p') && parts[1]) {
    return { view: 'console2', projectId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'tmux') return { view: 'tmux' };
  if (parts[0] === 'schedule') return { view: 'schedule' };
  if (parts[0] === 'settings') return { view: 'settings' };
  return { view: 'hub' };
}
