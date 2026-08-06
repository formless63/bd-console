// poll.js — the app's one background-polling primitive.
//
// Every view that keeps something fresh wants the same three behaviors, and
// getting any of them wrong is invisible in the UI and expensive on the wire:
//
//   1. a fixed interval while the tab is being looked at,
//   2. NO ticks while the tab is hidden (a hidden tab is a tab nobody is
//      reading, so its poll is pure waste — and for /api/usage it was waste
//      that counted against a provider's rate limit),
//   3. a catch-up tick when the tab comes back, but only if a full interval
//      actually elapsed, so alt-tabbing rapidly doesn't become its own poll
//      loop.
//
// This started life inline in HubView's live-quota effect (bd-console-0fg).
// It lives here because the second copy of it — ScheduleView's usage poll
// (bd-console-idj) — is exactly where a copy-paste would have drifted.
//
// `fn` is captured once on mount, like the effect it replaces: pass an arrow
// that reads whatever signals it needs at call time.
import { useEffect } from 'preact/hooks';

export function useVisiblePoll(fn, intervalMs) {
  useEffect(() => {
    let lastAt = Date.now();
    const tick = () => {
      if (document.hidden) return;
      lastAt = Date.now();
      fn();
    };
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => { if (!document.hidden && (Date.now() - lastAt) >= intervalMs) tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
