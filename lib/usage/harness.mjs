// lib/usage/harness.mjs — the shared scaffolding every provider adapter in
// lib/usage/ is built on. Before this existed each adapter hand-rolled the same
// ~40 lines of cache variable, TTL pair, try/catch and status plumbing, so
// adding a fifth provider meant copying a fourth copy of it. Now a provider is
// a `compute()` plus a small policy object, and everything below is decided by
// DATA rather than by an `if (provider === 'claude')` somewhere.
//
// THE IRON RULES THIS HARNESS ENFORCES (see lib/usage.mjs for the full list):
//
//   NEVER THROWS. get() catches everything compute() can throw and turns it
//   into `{ status: 'error' }`. Callers get a value, never a rejected promise —
//   /api/usage answers for the providers that worked even when one blew up.
//
//   ONE UPSTREAM CALL PER TTL. Every viewer of every hub tab collapses onto one
//   process-wide cache entry per provider, so the call rate upstream is exactly
//   1 per TTL no matter how many people are watching.
//
//   "PUBLISHES NO QUOTA" IS A FIRST-CLASS ANSWER. A provider says
//   `publishesQuota: false` and the harness guarantees `windows: []` on every
//   result it hands back, including its own error fallback. It is not an
//   oversight to be filled in later — it is the measured truth for Kimi and
//   Gemini, and the harness makes it impossible to accidentally grow a gauge
//   for them.
import { homedir } from 'node:os';
import { join } from 'node:path';

// Every adapter resolves its home directory the same way: a
// BD_CONSOLE_<PROVIDER>_DIR override (which is how scripts/smoke.mjs points all
// four at fabricated fixture dirs) falling back to a path under $HOME. One
// place implements it so a new provider cannot invent a fifth convention.
export function providerRoot(envVar, ...segments) {
  const override = process.env[envVar];
  if (override) return override;
  return join(homedir(), ...segments);
}

// defineProvider(policy) -> { get }
//
// policy:
//   provider        string  — the `provider` field stamped on the error fallback
//   compute         async fn() -> result object (must set its own `fetchedAt`)
//   ttl             { ok, other } — cache lifetime by outcome, in ms
//   backoff         { statuses: [...], ttlMs } | null
//                   A "backoff status" is one where the provider has told us to
//                   slow down. Declaring it here buys three behaviors at once,
//                   which is the whole reason it's one concept and not three
//                   flags: the long TTL, a `retryAt` stamped on the value, and
//                   refusal to honor `fresh` while it holds.
//   fresh           { minIntervalMs } | null
//                   Presence means get({ fresh: true }) may bypass a warm cache
//                   entry — the human-triggered ↻ path. Absence means the
//                   argument is ignored entirely (a local disk read has no
//                   upstream to be polite to and so needs no bypass).
//                   A provider with a refresh button is also the only kind that
//                   needs `cached: true` on its results: it's the answer to "did
//                   my click actually do anything?", so the flag rides along
//                   with this policy rather than being a separate knob.
//   publishesQuota  boolean — false means this provider exposes no rate-limit
//                   data anywhere, and `windows` is [] on purpose (see above).
export function defineProvider(policy) {
  const {
    provider,
    compute,
    ttl,
    backoff = null,
    fresh = null,
    publishesQuota = true
  } = policy;

  const backoffStatuses = new Set(backoff ? backoff.statuses : []);
  const marksCached = Boolean(fresh);

  let cache = null; // { at: epochMs, ttl: ms, value }
  let lastFreshAt = null; // epochMs of the last fresh-triggered compute()

  const ttlFor = (status) => {
    if (backoffStatuses.has(status)) return backoff.ttlMs;
    return status === 'ok' ? ttl.ok : ttl.other;
  };

  // The value handed back when compute() throws. A no-quota provider carries
  // its empty `windows` even here, so the UI's shape checks hold on the error
  // path too and no consumer has to special-case a half-formed block.
  const errorFallback = (now) => ({
    provider,
    status: 'error',
    ...(publishesQuota ? {} : { windows: [] }),
    fetchedAt: now
  });

  async function get({ fresh: wantFresh = false } = {}) {
    const now = Date.now();
    if (cache && (now - cache.at) < cache.ttl) {
      const backingOff = backoffStatuses.has(cache.value.status);
      const tooSoon = fresh != null && lastFreshAt != null && (now - lastFreshAt) < fresh.minIntervalMs;
      // `fresh` is the fast path, not an override of everything: during a
      // backoff it is ignored outright (more requests make a rate limit worse),
      // and two fresh calls inside minIntervalMs collapse into one so a
      // rapid-click user can't turn the button into a poll loop.
      const bypass = fresh != null && wantFresh && !backingOff && !tooSoon;
      if (!bypass) return marksCached ? { ...cache.value, cached: true } : cache.value;
    }
    if (fresh != null && wantFresh) lastFreshAt = now;

    let value;
    try {
      value = await compute();
    } catch {
      value = errorFallback(now);
    }
    // A compute() that returns null/undefined/a string instead of throwing is
    // just as much a failure, and it must not reach the lines below and turn
    // "never throws" into a TypeError on the way out.
    if (!value || typeof value !== 'object') value = errorFallback(now);

    // Enforced, not merely documented — see the iron rules above.
    if (!publishesQuota && (!Array.isArray(value.windows) || value.windows.length > 0)) {
      value = { ...value, windows: [] };
    }

    const ttlMs = ttlFor(value.status);
    // Stamped on the value (not just the cache entry) so every later cache hit
    // hands the UI the same honest "retry at" instant.
    if (backoffStatuses.has(value.status)) value = { ...value, retryAt: now + ttlMs };

    cache = { at: now, ttl: ttlMs, value };
    return value;
  }

  return { get };
}
