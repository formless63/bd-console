# Access-control plan (design only — nothing here is implemented yet)

Status: **proposal for discussion** (bd-console-974.9, 2026-08-17). No code in
this program changes how the hub is reached or authenticated. This document
exists so that when we do change it, the whole model lands at once instead of
one route at a time.

## Why this needs a plan at all

The 2026-08-17 audit found that the hub's security posture assumes a trusted
network, while its default bind (`0.0.0.0:4180`) assumes the opposite:

| # | Finding | Where |
|---|---|---|
| 1 | With no token configured, `authed()` returns `true` for everyone — any LAN client can **install their own write token** via `POST /api/settings` (locking the owner out at next restart), register projects, and write `.md` files into registered repos | `lib/routes.mjs:200,320` |
| 2 | No `Origin`/`Host`/`Content-Type` validation → CSRF from any web page in a LAN browser, and DNS rebinding defeats "it's only the LAN" entirely | `lib/routes.mjs:238-241` |
| 3 | Unauthenticated reads leak: 4-char prefixes of the write token and Termix key (`/api/settings`), every scheduled prompt body (`/api/schedule`), absolute host paths + pane titles for every tmux pane (`/api/tmux`) | `routes.mjs:293,308,586`; `tmux.mjs:470-513` |
| 4 | Token accepted in `?token=` (lands in proxy logs/history/Referer); comparison is not constant-time | `routes.mjs:201` |

Current real deployment (recorded 2026-07): public access via Cloudflare →
Pangolin auth → newt tunnel → this box `:4180`; plus direct LAN access; plus
localhost. Any design must keep all three working without a config scramble
on upgrade day.

## Owner constraints (verbatim intent)

1. **Very simple to set up and use.** Nobody should ever have to *remember*
   a token. Copy-pasting a one-time thing during setup is acceptable;
   retyping a secret per browser per month is not.
2. Origins/binds must be *controllable* — we need to decide the mechanism
   (first-run flow? a `bd-console` command? Settings UI?) before building.
3. Existing deployments must not break on upgrade.

## Proposed model: trust tiers + device pairing

### 1. The server always has a secret — the user never sees it

On first run (or first run after upgrade), the server generates a random
token and stores it in `~/.config/bd-console/config.json` itself. It is an
internal credential, not something the user is told to save. All the UX
below exists so no human ever types or remembers it.

### 2. Three trust tiers, checked in order

| Tier | Who | Auth required? |
|---|---|---|
| **Localhost** | Requests from `127.0.0.1/::1` (verified by socket address, not Host header) | None — always trusted. `bd-console` CLI and a browser on the same box just work, forever. |
| **Paired devices** | Any browser that has completed pairing (below) | Long-lived credential a cookie/localStorage holds automatically |
| **Trusted proxy** (optional, off by default) | Requests arriving from a configured proxy address (the newt tunnel endpoint) that already passed Pangolin auth | Configured once: `trusted_proxies: [<addr>]`. Pangolin *is* the auth for this tier. |

Everything else: reads of non-sensitive data could stay open or not (see
open questions); writes and sensitive reads require a paired device.

### 3. Pairing — the "no remembering" mechanism

- A new, unpaired browser hitting the hub sees a single **"Pair this
  device"** screen instead of a 401.
- Pairing works either direction, whichever is closer to hand:
  - **From the terminal:** `bd-console pair` prints a short-lived (2 min,
    single-use) URL like `http://hub:4180/#pair=483920`. Open it on the
    device → it's paired. The QR-code rendering of the same URL costs ~40
    lines with no dependency and makes phone pairing one camera tap.
  - **From the browser:** the pairing screen shows a 6-digit code; the owner
    confirms it with `bd-console pair --approve 483920` (or one click in an
    already-paired browser's Settings). This is the "I'm on the phone in
    another room" path.
- Once paired, the device stores a per-device credential (HttpOnly cookie
  preferred; localStorage fallback for the file:// edge case). Devices are
  listed and revocable in Settings ("Kitchen laptop · paired 2026-08-17 ·
  revoke").
- Pairing is the *only* flow. There is no login form, no password, and the
  master token never travels except inside the one-time pairing exchange.

### 4. Origin / Host control

- The allowlist is **learned, not typed**: whatever `Origin`/`Host` a
  successful pairing used is added automatically. `beads.aevros.dev` gets
  allowlisted the first time a device pairs through it.
- Manual control exists for completeness: `bd-console settings origins
  [add|remove|list]` and a write-gated Settings section — but the expected
  path is that nobody ever runs it.
- Enforcement once the list exists: reject POSTs whose `Origin` is present
  and not allowlisted; require `Content-Type: application/json` on JSON
  routes; check `Host` against the allowlist to kill DNS rebinding.

### 5. First-run and upgrade story

- **Fresh install:** the existing interactive first-run (LAN vs WAN
  question) gains one step — it prints the pairing URL for the first
  browser. Setup is: start, click link, done.
- **Existing deployments upgrade in "open" mode**: everything keeps working
  exactly as today, but the UI shows a persistent, dismissable-per-session
  banner — "This hub accepts writes from anyone on your network. Run
  `bd-console secure` to require device pairing." `bd-console secure` flips
  the tier model on and immediately prints a pairing URL so the current
  browser doesn't get locked out.
- **Lockout recovery is always localhost:** anyone with a shell on the box
  can `bd-console pair` again. No secret to lose.

### 6. Independent fixes with zero access-behavior change

These can ship any time without discussion (they change what *leaks*, not
who gets in): constant-time token comparison; stop accepting `?token=` once
no first-party caller uses it (grep first); `/api/settings` returns
`set: true` instead of secret prefixes; strip `cwd`/pane titles from the
unauthenticated `/api/tmux` payload or gate it like pane captures already
are; gate `/api/schedule` prompt bodies the same way. Note: the last two do
change what an *unauthenticated* client sees — on a tokenless deployment
today that's everyone, so they're batched here rather than in the bugfix
waves, per the owner's instruction.

## Open questions for the owner

1. **Read exposure default:** once pairing exists, should *reads* (issue
   lists, hub) require pairing too, or stay open with only writes+sensitive
   reads gated? (Proposal: everything gated by default; `bd-console
   settings set open_reads true` for the kiosk/status-screen case.)
2. **Trusted-proxy tier:** wanted at all, or should Pangolin-fronted
   browsers just pair like any other device? (Pairing-only is simpler and
   works today; the proxy tier saves each family member/device one
   pairing step but adds a config knob and a spoofing surface if the proxy
   address is wrong.)
3. **Pairing approval strictness:** should a terminal-printed URL pair
   silently (current proposal), or always require a confirm on an
   already-trusted surface? Silent is simpler; confirm is safer if the URL
   ever leaks within its 2-minute window.
4. **Bind default:** keep `0.0.0.0` (with pairing making it safe) or flip
   the default to localhost and make LAN exposure the explicit choice?
   Keeping `0.0.0.0` + pairing preserves the current "works from my phone
   immediately after pairing" experience.

## Sizing (when approved)

Tier model + pairing + device list + banner + `secure`/`pair` commands: M-L
(a few days). Origin/Host enforcement: S on top of it. §6 leak fixes: S,
independent. No new dependencies required for any of it.
