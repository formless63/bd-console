// lib/termix.mjs — Termix deep links + the one (opt-in) Termix API call.
//
// Termix (https://github.com/Termix-SSH/Termix, Apache-2.0) is a self-hosted
// web SSH / terminal manager. bd-console already knows which tmux sessions are
// running on this host; Termix already knows how to give you a browser
// terminal on this host. This module is the seam between them: given a stored
// `termix` config (lib/config.mjs), it turns a tmux session name into a URL
// that opens Termix straight into that session.
//
// TWO THINGS LIVE HERE, AND THEY ARE VERY DIFFERENT:
//
//   1. Deep-link composition (termixLinkFor / decorateSessionsWithTermix).
//      Pure string work. No network, no credential, no I/O — the link is
//      handed to the user's browser and the user's browser is what talks to
//      Termix. This is what the tmux rows in the hub and Console 2.0 render.
//
//   2. fetchTermixHosts(). The ONLY outbound request in bd-console's entire
//      Termix surface, and it is never made implicitly: it exists so the
//      Settings page can offer "look up my hosts" instead of demanding the
//      user go read an integer out of Termix's own URL bar. Nothing polls it,
//      no page load triggers it, and it is the only place the API key is
//      read. If you are adding a second caller, that is a decision to make
//      deliberately, not an implementation detail.
//
// --- what the deep link actually is ---------------------------------------
// UNDOCUMENTED, and deliberately called out as such: Termix's OpenAPI spec
// says nothing about deep links. The contract below is read from the app's own
// entry point (src/main.tsx), which does:
//
//     const searchParams = new URLSearchParams(window.location.search);
//     const view = searchParams.get("view");
//     const hostId = searchParams.get("hostId");
//     const tmuxSession = searchParams.get("tmuxSession");
//
// `view=terminal` + `hostId` + `tmuxSession` is exactly the one-click attach
// we want. Because it is an internal contract it may change between Termix
// releases — the failure mode is benign (Termix opens somewhere other than the
// session), but that is why the link is composed in one function rather than
// sprinkled across three components.
//
// Any `view` param puts Termix behind its FullscreenAppGate, which requires an
// authenticated Termix session cookie in that browser. bd-console has no way
// to establish one and does not try; a click can therefore land on Termix's
// login screen. The UI says so rather than pretending otherwise.
import { SESSION_NAME_RE } from './tmux.mjs';

// No `/api` prefix: Termix's paths are top-level. The OpenAPI spec's `servers`
// list (localhost:30001, :30003, …) is the INTERNAL microservice split — the
// shipped Docker image fronts all of them with a single nginx (default :8080)
// that path-routes internally, so a client base URL is the nginx origin with
// these paths appended, never a :3000x port.
export const TERMIX_HOSTS_PATH = '/host/db/host';

// Singular. The API-keys doc's curl example says `/host/db/hosts` (plural),
// but both the OpenAPI spec and Termix's own UI client use the singular form;
// plural exists only as `/host/db/hosts/export`.
export function termixHostsUrl(baseUrl) {
  if (!baseUrl) throw new Error('Termix base URL is not configured');
  return `${String(baseUrl).replace(/\/+$/, '')}${TERMIX_HOSTS_PATH}`;
}

// Termix dispatches credentials by prefix: an API key is "tmx_" + 64 hex
// chars, anything else is treated as a login JWT. Both ride the same header,
// so this is presentational — it lets Settings warn "that doesn't look like an
// API key" without ever sending it anywhere to find out.
export const TERMIX_API_KEY_RE = /^tmx_[0-9a-f]{64}$/;
export const looksLikeTermixApiKey = (token) => TERMIX_API_KEY_RE.test(String(token ?? '').trim());

// --- deep links -------------------------------------------------------------

// The attach URL for one session, or null if it can't be composed. Session
// names are validated against tmux.mjs's own SESSION_NAME_RE — the same gate
// every tmux exec path uses — so nothing exotic can be smuggled into a query
// string, and URLSearchParams handles the encoding of what survives it.
export function termixAttachUrl({ baseUrl, hostId } = {}, session) {
  if (!baseUrl || !hostId) return null;
  if (!SESSION_NAME_RE.test(String(session ?? ''))) return null;
  const params = new URLSearchParams({ view: 'terminal', hostId: String(hostId), tmuxSession: String(session) });
  return `${String(baseUrl).replace(/\/+$/, '')}/?${params.toString()}`;
}

// The "we know where Termix is but not which host this box is" fallback: the
// bare install URL. Deliberately NOT `?view=terminal` — a view param without a
// hostId drops the user into a fullscreen terminal gate aimed at nothing,
// which is a worse lie than landing on the homepage.
export function termixHomeUrl(baseUrl) {
  if (!baseUrl) return null;
  return `${String(baseUrl).replace(/\/+$/, '')}/`;
}

// The whole per-row verdict in one object, so three call sites can't drift:
//
//   null            Termix isn't configured — render nothing at all.
//   mode 'attach'   baseUrl + hostId known: one click lands in the session.
//   mode 'open'     baseUrl only: one click lands in Termix, and `hint` says
//                   plainly that we can't attach for them and what to set.
//
// `hint` is the tooltip text verbatim. Both modes mention the sign-in
// possibility, because both are subject to Termix's own session cookie.
export function termixLinkFor(termix, session) {
  const baseUrl = termix?.baseUrl || null;
  if (!baseUrl) return null;
  if (!SESSION_NAME_RE.test(String(session ?? ''))) return null;

  const attach = termixAttachUrl(termix, session);
  if (attach) {
    return {
      url: attach,
      mode: 'attach',
      hint: `Open "${session}" in Termix (host #${termix.hostId}). If you're not signed in to Termix, it'll ask first.`
    };
  }
  return {
    url: termixHomeUrl(baseUrl),
    mode: 'open',
    hint: `Open Termix. bd-console doesn't know which Termix host this machine is, so it can't attach "${session}" for you — set the Termix host id in Settings to make this one click.`
  };
}

// Decorates a listSessions() payload in place-by-copy: every session gains a
// `termix` field (the object above) or none at all when Termix is unconfigured,
// so a client that predates this feature sees exactly what it saw before.
export function decorateSessionsWithTermix(payload, termix) {
  if (!payload || !Array.isArray(payload.sessions)) return payload;
  if (!termix?.baseUrl) return payload;
  return {
    ...payload,
    sessions: payload.sessions.map((s) => {
      const link = termixLinkFor(termix, s?.name);
      return link ? { ...s, termix: link } : s;
    })
  };
}

// --- the one outbound call --------------------------------------------------

// Termix's GET /host/db/host lists the caller's hosts. The OpenAPI spec
// documents the request thoroughly and the 200 body only in prose ("A list of
// SSH hosts"), so the shape is NOT a confirmed contract — hence the tolerant
// unwrapping below rather than a strict schema. Pure; fixture-testable.
export function normalizeTermixHosts(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.hosts) ? payload.hosts
      : (Array.isArray(payload?.data) ? payload.data : []));
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id < 1) continue;
    out.push({
      id,
      name: typeof row.name === 'string' ? row.name : '',
      ip: typeof row.ip === 'string' ? row.ip : '',
      port: Number.isFinite(Number(row.port)) ? Number(row.port) : null,
      username: typeof row.username === 'string' ? row.username : '',
      folder: typeof row.folder === 'string' ? row.folder : '',
      // Only a terminal-enabled host can serve the deep link we compose; the
      // picker still lists the others, marked, rather than hiding machines the
      // user can plainly see in Termix.
      enableTerminal: row.enableTerminal !== false
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

// Turns whatever went wrong into something a settings page can print without
// the user opening devtools — and, for the two auth statuses, into the actual
// remedy rather than a bare number.
export function describeTermixFailure(status, bodyText) {
  if (status === 401 || status === 403) {
    return 'Termix rejected the credential (HTTP ' + status + '). Create an API key in Termix under Admin Settings → API Keys and paste the whole "tmx_…" value here.';
  }
  if (status === 404) {
    return 'Termix returned 404 for GET /host/db/host. Check the base URL points at the port your Termix nginx serves (the single published port, e.g. 8080) and not at an internal service port.';
  }
  const trimmed = String(bodyText ?? '').trim().slice(0, 200);
  return `Termix returned HTTP ${status}${trimmed ? `: ${trimmed}` : ''}`;
}

// THE outbound request. Never called on a page load, a poll, or a settings
// save — only from GET /api/termix/hosts, which a user reaches by clicking
// "Look up hosts" on the Settings page. Resolves {ok:false, error} for every
// failure mode (including a dead host or DNS failure) rather than throwing, so
// the route can render the reason instead of a 500.
export async function fetchTermixHosts({ baseUrl, token, timeoutMs = 8000 } = {}) {
  if (!baseUrl) return { ok: false, error: 'Termix base URL is not set' };
  if (!token) return { ok: false, error: 'Termix API token is not set' };

  let res;
  try {
    res = await fetch(termixHostsUrl(baseUrl), {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? `no response within ${timeoutMs}ms` : (e?.message || String(e));
    return { ok: false, error: `Could not reach Termix at ${baseUrl} (${reason})` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: describeTermixFailure(res.status, body) };
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    // An HTML body here almost always means the base URL landed on a proxy or
    // login page rather than Termix's API — worth saying, since the status was
    // a 200 and "it worked but returned nothing" would be misleading.
    return { ok: false, error: 'Termix returned a non-JSON response — is the base URL pointing at the Termix web port?' };
  }
  return { ok: true, hosts: normalizeTermixHosts(payload) };
}
