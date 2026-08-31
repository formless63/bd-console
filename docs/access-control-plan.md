# Access-control model

Status: **approved for implementation** (2026-08-31; `bd-console-hwu` and
`bd-console-4kt`). This replaces the earlier pairing proposal.

## Deployment contract

`bd-console` is a trusted-LAN tool, not an internet authentication service.
Its normal path stays deliberately frictionless:

- bind `0.0.0.0:4180` by default
- require no login, pairing step, API key, or remembered token
- allow reads and writes from devices on a trusted LAN
- keep the built-in token optional, as defense in depth for installations that
  already use it

If the hub is reachable from the internet, an authenticating gateway such as
Pangolin must sit in front of it. The gateway is the public authentication
boundary; bd-console will not grow a second login or device-pairing system
behind it.

This is the deployment used by the maintainer: Cloudflare -> Pangolin auth ->
newt tunnel -> bd-console, alongside direct LAN and localhost access.

## Protections that do not add user friction

Open LAN access does not mean accepting every browser-shaped request. The
server should enforce boundaries that require no user interaction:

1. Mutating browser API requests must use the expected JSON content type.
   This prevents a normal cross-origin form or `text/plain` request from
   reaching a write handler.
2. Browser `Origin` and request `Host` must be consistent. Host validation must
   reject DNS-rebinding requests while continuing to accept direct LAN names,
   local addresses, and traffic arriving through the local trusted gateway.
3. CLI and other non-browser clients, which ordinarily send no `Origin`, keep
   working without credentials.
4. Paths supplied to file, document, formula, and session-creation operations
   remain confined to registered project workspaces. Symlinks must not turn a
   lexically safe path into an out-of-workspace read or write.
5. When an optional token is configured, sensitive host reads and all writes
   remain gated consistently. With no token, they remain available on the
   trusted LAN by design.
6. Credentials must not be returned as prefixes or accepted in query strings;
   configuration and scheduler state containing secrets or prompts must use
   private filesystem modes.

These checks address browser CSRF, DNS rebinding, accidental path escape, and
local information leakage. They do **not** claim to isolate mutually hostile
people or compromised machines on the same LAN. Deployments needing that
boundary must segment the network or put every access path behind an
authenticating gateway.

## Owner decisions

The four questions in the earlier proposal are resolved:

| Question | Decision |
|---|---|
| Read exposure | Reads stay open on tokenless trusted-LAN deployments. |
| Trusted proxy | Pangolin or an equivalent authenticating gateway is the public tier. No browser pairing follows it. |
| Pairing strictness | Not applicable; pairing is not being implemented. |
| Bind default | Keep `0.0.0.0`. |

## Upgrade behavior

Existing LAN deployments must continue to work after upgrade without a config
change. Existing optional tokens continue to work. Public deployments should
already be behind an authenticating gateway; the README and first-run guidance
must say this plainly.

Request-integrity failures should be explicit API errors, not redirects to an
auth screen. Any new trusted-host configuration must be optional and should be
needed only for unusual proxy/network topologies, never for ordinary LAN use.
