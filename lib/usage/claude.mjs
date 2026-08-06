// lib/usage/claude.mjs — Claude Code quota, from the OAuth usage endpoint.
//
// The only adapter here that talks to the network, and therefore the only one
// with a rate limit to respect: everything unusual about its policy below
// (long OK TTL, a hard backoff, a throttled `fresh` bypass) exists because this
// one makes an upstream call.
//
// Never logs or echoes accessToken/refreshToken, and never refreshes one. A
// token past its expiresAt short-circuits before any network call (the endpoint
// would just reject it, and we don't want to depend on that behavior).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineProvider, providerRoot } from './harness.mjs';
import { toEpochMs } from './read.mjs';

// Cache TTLs are the ONLY thing standing between an open hub tab and the
// OAuth usage endpoint: every viewer of every tab collapses onto this one
// process-wide cache, so the upstream call rate is exactly 1 per TTL no
// matter how many people are watching. A 60s TTL meant a hub left open all
// day made ~1,440 OAuth calls/day and tripped the limit quickly (bd-console-0fg),
// so the steady state is now 5 minutes — quota gauges that move on a 5h/7d
// window do not need minute resolution.
const CLAUDE_OK_TTL_MS = 5 * 60_000;
// Failures (network blip, expired token, malformed creds) retry sooner than a
// success so a transient error doesn't freeze the card for 5 minutes — but
// 15s was needlessly eager for a card nobody reads more than once a minute.
const CLAUDE_ERR_TTL_MS = 60_000;
// A 429 means we've been told to slow down. Now that the steady state is
// already 5 minutes, getting rate-limited at that cadence means the limit is
// strict, so back off hard rather than nibbling at it: 15 minutes, and this
// window is honored even for an explicit human-triggered refresh — a person
// hammering ↻ must not be able to sustain the rate limit. Declaring
// 'rate-limited' as the harness's backoff status is what buys all three halves
// of that: the long TTL, the `retryAt` stamp, and the refusal to go upstream.
const CLAUDE_RATELIMIT_TTL_MS = 15 * 60_000;
// Floor between two upstream calls caused by `fresh` requests. The refresh
// button is the fast path, but "fast" is not "unbounded": repeat clicks
// inside this window are served from cache (flagged `cached: true`) instead
// of becoming upstream calls.
const CLAUDE_FRESH_MIN_MS = 20_000;
const CLAUDE_FETCH_TIMEOUT_MS = 8_000;

function claudeCredsPath() {
  return join(providerRoot('BD_CONSOLE_CLAUDE_DIR', '.claude'), '.credentials.json');
}

async function computeClaudeUsage() {
  const fetchedAt = Date.now();

  let raw;
  try {
    raw = await readFile(claudeCredsPath(), 'utf8');
  } catch {
    return { provider: 'claude', status: 'no-creds', fetchedAt };
  }

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    return { provider: 'claude', status: 'error', fetchedAt };
  }

  const oauth = creds && typeof creds === 'object' ? creds.claudeAiOauth : null;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return { provider: 'claude', status: 'no-creds', fetchedAt };
  }

  const plan = oauth.subscriptionType ?? null;
  const tier = oauth.rateLimitTier ?? null;

  const expiresAt = Number(oauth.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    // Expired — never attempt a network call, never attempt to refresh.
    return {
      provider: 'claude', status: 'token-expired', plan, tier, windows: [], scopedLimits: [], fetchedAt,
      message: 'open Claude Code to refresh'
    };
  }

  let res;
  try {
    res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20'
      },
      signal: AbortSignal.timeout(CLAUDE_FETCH_TIMEOUT_MS)
    });
  } catch {
    return { provider: 'claude', status: 'error', plan, tier, windows: [], fetchedAt };
  }

  if (!res.ok) {
    const status = res.status === 429 ? 'rate-limited' : 'error';
    const extra = status === 'rate-limited' ? { message: 'rate-limited; backing off' } : {};
    return { provider: 'claude', status, plan, tier, windows: [], scopedLimits: [], fetchedAt, ...extra };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { provider: 'claude', status: 'error', plan, tier, windows: [], scopedLimits: [], fetchedAt };
  }

  const windows = [];
  if (data && data.five_hour) {
    windows.push({ id: 'session', label: '5h', percent: data.five_hour.utilization ?? null, resetsAt: toEpochMs(data.five_hour.resets_at) });
  }
  if (data && data.seven_day) {
    windows.push({ id: 'weekly', label: '7d', percent: data.seven_day.utilization ?? null, resetsAt: toEpochMs(data.seven_day.resets_at) });
  }

  const scopedLimits = parseScopedLimits(data && data.limits);

  return { provider: 'claude', status: 'ok', plan, tier, windows, scopedLimits, fetchedAt };
}

// parseScopedLimits(limitsArray): pure mapping from the OAuth usage
// endpoint's `limits[]` to per-model cap entries. Every entry whose
// `scope.model.display_name` is set (e.g. a weekly_scoped cap on a specific
// model) becomes `{ model, percent, severity, resetsAt, active }`; entries
// with `scope: null` (session/weekly_all, not model-specific) are ignored.
// The model set is dynamic — only currently-capped models ever appear here,
// nothing is hardcoded. Exported standalone so it's unit-testable without a
// live network call (see scripts/smoke.mjs).
export function parseScopedLimits(limitsArray) {
  if (!Array.isArray(limitsArray)) return [];
  const out = [];
  for (const entry of limitsArray) {
    if (!entry || typeof entry !== 'object') continue;
    const displayName = entry.scope && entry.scope.model && typeof entry.scope.model.display_name === 'string'
      ? entry.scope.model.display_name
      : null;
    if (!displayName) continue;
    out.push({
      model: displayName,
      percent: entry.percent ?? null,
      severity: entry.severity ?? null,
      resetsAt: toEpochMs(entry.resets_at),
      active: entry.is_active === true
    });
  }
  return out;
}

// getClaudeUsage({ fresh }): see the header. The only provider that declares
// both a `fresh` bypass and a backoff status, because it's the only one with an
// upstream that can push back.
//
// `fresh: true` is the human-triggered fast path (the hub's ↻ button, via
// GET /api/usage?fresh=1) and may bypass a warm ok/error cache entry — but it
// is deliberately NOT an override of everything:
//   - during a 429 backoff it is ignored entirely (no upstream call), because
//     the whole point of the backoff is that more requests make it worse;
//   - two fresh calls inside CLAUDE_FRESH_MIN_MS collapse into one, so a
//     rapid-click user can't turn the button into a poll loop.
// Whenever the answer comes from cache the result carries `cached: true`, and
// a rate-limited result carries `retryAt` (when the backoff lifts), so the UI
// can say "cached, still backing off" instead of silently pretending the
// refresh worked.
export const getClaudeUsage = defineProvider({
  provider: 'claude',
  compute: computeClaudeUsage,
  ttl: { ok: CLAUDE_OK_TTL_MS, other: CLAUDE_ERR_TTL_MS },
  backoff: { statuses: ['rate-limited'], ttlMs: CLAUDE_RATELIMIT_TTL_MS },
  fresh: { minIntervalMs: CLAUDE_FRESH_MIN_MS },
  publishesQuota: true
}).get;
