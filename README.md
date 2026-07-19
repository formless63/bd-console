# bd-console

A **Global Hub dashboard** for [beads](https://github.com/gastownhall/beads)
(`bd`) issues, project docs, and your agent tmux sessions. Install it once per
machine, register the repos you work in, and get one web UI for triage,
docs, live tmux sessions, and scheduled prompts. Zero npm dependencies on the
server: just Node (>=22) and the `bd` CLI. The frontend is a no-build
Preact app with vendored dependencies — still no bundler, no build step.

## What it does

- **Global Hub**: one long-running server, many registered projects. Switch
  between repos from a single dashboard instead of running one server per
  repo.
- **Beads triage**: every issue from `.beads/issues.jsonl`, including
  dependencies, with filter/sort by status, priority, type, label, search,
  group-by-epic, and "ready only". Claim, close, reopen, re-prioritize, label,
  and re-parent issues inline.
- **Rich issue creation**: type, priority, labels, acceptance criteria,
  parent epic, and assignee — not just quick one-line captures.
- **Comments**: read and add comments on any issue through `bd comment`
  (always read live, never stale).
- **Docs**: browse project markdown, either auto-discovered or pinned via a
  per-project `docRoots` list.
- **tmux sessions**: see every tmux session and pane on the host the hub
  runs on — what's running, where, and a live scrollback preview.
- **Prompt scheduler**: queue a literal prompt to be typed into an existing,
  named tmux session at a future time (see [Scheduler](#scheduler) below).
- **Themes**: six presets (Synergy — the default, Default, Dracula, Nord,
  Gruvbox, Tokyo Night), each with light, dark, and auto (follows
  `prefers-color-scheme`) variants.
- **Keyboard shortcuts**: vim/Gmail-like navigation for fast, hands-on-keyboard
  triage (see [Keyboard shortcuts](#keyboard-shortcuts)).

## Install

You need:

- Node >=22 (required — the scheduler uses `node:sqlite`, which landed in
  Node 22)
- the `bd` CLI on your `PATH`
- optionally, `tmux` on the same host, if you want the tmux/scheduler
  features (the hub degrades gracefully without it — see
  [Scheduler](#scheduler))

### Option A: clone this repo

No `npm install` step is required because `bd-console` has no npm
dependencies.

```bash
git clone https://github.com/formless63/bd-console.git ~/code/bd-console
cd ~/code/bd-console
node serve.mjs start
```

### Option B: install the CLI globally from GitHub

```bash
npm install -g git+https://github.com/formless63/bd-console.git
bd-console start
```

Either path gives you the `bd-console` command (and `bd-console-init`, an
optional guided per-repo setup helper — see
[Guided per-repo setup](#guided-per-repo-setup)).

## Quick start

```bash
# 1. install (see above), then start the hub — installed once per machine
bd-console start

# 2. first run on a TTY walks you through a LAN vs VPS setup prompt (see
#    Security posture below); non-interactive first runs apply safe-ish
#    defaults and log what they picked

# 3. register the repos you want on the dashboard
bd-console add ~/code/my-project
bd-console add .          # registers the repo at (or above) the cwd

# 4. open the dashboard
bd-console status         # prints the URL, e.g. http://localhost:4180
```

Each registered project needs a working beads database (`.beads/`) at its
root. If a target repo doesn't have one yet:

```bash
cd ~/code/my-project
bd init
bd export -o .beads/issues.jsonl
```

There is no single-repo server mode anymore — `bd-console` always runs as
one Global Hub, and every project it can see is something you explicitly
registered with `add`.

## CLI reference

```
bd-console                  run the hub in the foreground (Ctrl-C to stop)
bd-console start            (re)start the hub as a supervised background process
bd-console stop             stop it, however it's currently supervised
bd-console status           pid + port-reachability + supervision report
bd-console add <path>       register a project with the hub (defaults to cwd,
                             walking up to the nearest .beads/)
bd-console remove <id>      unregister a project
bd-console list             list registered projects
bd-console settings         interactive settings walkthrough
bd-console settings list    print effective host/port/token/persist + source
bd-console settings set <key> <value>
bd-console settings unset <key>
bd-console update           self-upgrade in place (see below)
bd-console update --dry-run print the detected install flavor + planned
                             command(s) without running them
```

Global flags (`--port <n>`, `--host <h>`) work on the bare run and on
`start`/`stop`/`status`, and take precedence over everything else (see
[Configuration](#configuration)). A bare trailing number is accepted as a
back-compat shorthand for `--port` on those same commands.

### `start` semantics

`start` **always supersedes** any existing deployment rather than silently
no-oping:

1. stops a previous plain-daemon process (tracked by pid file), if any
2. stops an active systemd `--user` unit, if any
3. as a final catch-all, checks whether *something* is still answering on
   the configured port and, if it identifies itself as `bd-console` via
   `/api/meta`, takes over the port too

It refuses to kill a process on the port that does **not** look like
`bd-console` (you'll get a "port already in use" error instead — free it
manually or pick a different `--port`). Once the old deployment is torn
down, `start` brings up a fresh one and polls `/api/meta` until the
replacement actually answers, then prints the dashboard URL and how it's
supervised. If the new instance never becomes ready, it prints the tail of
the log (systemd journal or the plain log file) and exits nonzero.

### `status` semantics

Reports three independent things: whether a pid is alive, whether the
configured port is *actually* reachable (a live `/api/meta` fetch, not just
"process exists"), and how the running instance is supervised —
`systemd`, `plain` (pid-file daemon), `foreground` (answering the port but
not tracked by either, e.g. you ran bare `bd-console` yourself), or `none`.

### `update` semantics

`bd-console update` detects how it's installed and upgrades in place:

- **git-clone install** (the package root is inside a git work tree) →
  `git pull --ff-only`. A dirty working tree is never touched — no stash,
  no reset. `update` aborts with instructions to commit or stash yourself,
  then retry.
- **npm-global install** (anything else) →
  `npm install -g git+https://github.com/formless63/bd-console.git`

If `bd-console` was running before the update, it's restarted afterward
through the same superseding `start` path, so the new code goes live
immediately. `--dry-run` prints the detected flavor and exact command(s)
without running them.

### Persistence (systemd)

On Linux, when `systemctl --user` is usable, `start` installs/refreshes a
systemd `--user` unit (`bd-console.service`) and runs
`loginctl enable-linger` so the hub survives logout and reboot — this is the
default (`persist: true`) whenever that probe succeeds. Manage the unit
directly if you want to:

```bash
systemctl --user status bd-console.service
systemctl --user stop bd-console.service
systemctl --user restart bd-console.service
```

Opt out with `bd-console settings set persist false` (or the
`BD_CONSOLE_PERSIST=0` env var), which makes `start` use a plain detached
background process (pid-file tracked) instead. On non-Linux platforms, or
when `systemctl --user` isn't usable, `persist` defaults to `false`
automatically.

## Configuration

Global settings (host, port, token, persist) live in
`~/.config/bd-console/config.json` (override the directory with
`BD_CONSOLE_CONFIG_DIR`). Precedence, highest wins:

```
CLI flags (--port, --host) > env vars > config.json > built-in defaults
```

Built-in defaults: `0.0.0.0:4180`, no token, `persist` auto-detected.

Inspect and edit with `bd-console settings`:

```bash
bd-console settings list         # effective value + source (flag/env/config/default) per key
bd-console settings set host 0.0.0.0
bd-console settings set port 4180
bd-console settings set token a-shared-secret
bd-console settings unset token
bd-console settings set persist false
bd-console settings                # interactive walkthrough of all four keys
```

`config.json` looks like:

```json
{
  "host": "0.0.0.0",
  "port": 4180,
  "token": "a-shared-secret",
  "persist": true
}
```

All keys are optional; omit any you want left at its default.

### Environment overrides

```bash
BD_CONSOLE_HOST             # overrides host
BD_CONSOLE_PORT             # overrides port
BD_CONSOLE_TOKEN            # overrides token
BD_CONSOLE_PERSIST=0|1      # overrides persist
BD_CONSOLE_CONFIG_DIR       # relocates ~/.config/bd-console entirely
BD_CONSOLE_SCHED_INTERVAL   # scheduler poll interval in ms (default 15000)
```

### Per-project `bd-console.json`

A registered workspace may still have a `bd-console.json` at its root, but
its job has shrunk: **only `docRoots` is honored now.** `host`, `port`, and
`token` keys in a per-project file are inert — those all come from the
global `config.json` / env / flags described above. See
`bd-console.json.example`.

```json
{
  "docRoots": ["docs", ".planning"]
}
```

- `docRoots`: limits and orders which markdown folders the Docs view shows
  for that project. Omit it to auto-discover every `*.md` under the
  workspace (skipping `node_modules`, `.git`, `.next`, `dist`, `.beads`, and
  similar).

### Guided per-repo setup

`bd-console-init` (or `node scripts/init.mjs` from a clone) is an optional
helper for onboarding a single repo: it confirms `.beads/` exists,
refreshes `.beads/issues.jsonl`, registers the repo with the hub (the same
as running `bd-console add`), writes `bd-console.json` if one doesn't exist
yet, and can update `AGENTS.md` / `CLAUDE.md` with `bd-console` guidance.

```bash
bd-console-init --repo ~/code/my-project --apply-agent-docs
bd-console-init --repo ~/code/my-project --apply-agent-docs --create-missing-agent-docs
```

`--repo` here is a `bd-console-init` flag only — it picks which repo to
initialize/register. It has no equivalent on `bd-console`/`bd-console start`
(see [docs/upgrading.md](docs/upgrading.md) if you're coming from the old
per-repo `--repo` server flag). *(Linux users)*: add `--install-service` to
install and start the shared hub's systemd user unit as part of the same
step.

## Security posture

`bd-console`'s first run on a TTY (bare `bd-console`, or `bd-console start`
before any `config.json` exists) asks where you'll access the dashboard
from, because the fallback default bind is `0.0.0.0` — not `127.0.0.1` —
and that shouldn't be applied silently:

- **This machine / home LAN** → bind `0.0.0.0`, open writes recommended.
  This is the common case for a box you trust everyone on your LAN to reach.
- **VPS / internet-exposed** → bind to a private or tailnet interface first
  (the prompt lists your non-loopback IPv4 addresses, plus `127.0.0.1`); a
  random write-gating token is generated only as a last resort if you choose
  to bind `0.0.0.0` anyway on a box like this.

**If a box is ever exposed publicly, put an authenticating reverse proxy in
front of it (e.g. [Pangolin](https://github.com/fosrl/pangolin)'s auth)
rather than relying on the token alone.** The token gates *write* endpoints
against casual/accidental use; it is not a substitute for real
authentication on an internet-facing host.

Non-interactive first runs (no TTY — systemd, scripts, CI) skip the prompt,
apply the `0.0.0.0:4180`/no-token defaults, and log one line saying so.
Change any of this later with `bd-console settings`.

Other invariants, unchanged from the original design:

- Writes go through `bd` via `execFile` with an args array — no shell
  interpolation, ever.
- Issue IDs and labels are format-validated before every write.
- Doc reads are restricted to the workspace root and validated against path
  traversal.
- tmux pane previews (`/api/tmux/preview`) are token-gated the same as
  writes, since pane contents can contain secrets.
- `?token=` works for API calls; the browser UI itself stores the token in
  `localStorage` and sends it via the `x-bd-token` header.

## Scheduler

The scheduler queues a prompt to be typed into an **already-running,
named tmux session** at a scheduled time — think "wake this agent up and
give it its next instruction at 7am" or "resume this session after my
laptop sleeps through the night."

What it does *not* do, by design:

- it never creates or attaches a tmux session for you — the session named
  in the job must already exist when the job fires
- it never runs a command like `claude -p` directly; it only re-uses the
  same literal `tmux send-keys` injection the tmux pane preview/UI uses, so
  the "prompt" always lands as literal keystrokes in an interactive session,
  never as something the scheduler interprets or executes itself

A job that fires against a session that no longer exists (or never existed)
ends up `failed`, not silently dropped — check `GET /api/schedule` for job
status (`pending` / `sent` / `failed` / `cancelled`) and `error`.

API surface, hub-level (not project-scoped):

```
GET  /api/tmux                    list tmux sessions/panes on the hub's host
GET  /api/tmux/preview?session=&lines=   scrollback preview (token-gated)
GET  /api/schedule                 list jobs
POST /api/schedule                 create a job: {prompt, session, runAt}
POST /api/schedule/cancel          cancel a still-pending job: {id}
```

The scheduler polls for due jobs every `BD_CONSOLE_SCHED_INTERVAL`
milliseconds (default 15000). It requires `node:sqlite` (bundled with Node
22+); if it's ever unavailable, the endpoints above return `501` instead of
erroring, and the rest of the hub keeps working normally. Likewise, if
`tmux` isn't installed on the host, `/api/tmux` reports
`{ available: false, sessions: [] }` rather than failing.

## Themes and keyboard shortcuts

Six theme presets — Synergy, Default, Dracula, Nord, Gruvbox, Tokyo Night —
each with light, dark, and an "auto" mode that follows
`prefers-color-scheme`. **Synergy is the default** for first-time visitors
(a void-black/near-white neon green + electric purple theme, with Space
Grotesk/Manrope typography); anyone who has already picked a preset keeps
their existing choice untouched. Pick one from the theme switcher in the
top bar; your choice is remembered in `localStorage` and applied before
first paint (no flash of the wrong theme).

| Shortcut | Action |
| --- | --- |
| `j` | Select the next issue in the list |
| `k` | Select the previous issue in the list |
| `/` | Focus the issue search field |
| `c` | Focus the "Add a comment" input area |
| `i` | Open the New issue dialog |
| `Esc` | Close the open modal dialog or remove focus |

These are ignored while you're typing into a form field or text input.

The dashboard is hash-routed (`#/`, `#/p/<projectId>`,
`#/p/<projectId>/docs`, plus tmux and scheduler views), so deep links work
even served as static files.

## Verification

Local checks:

```bash
npm run check
npm run smoke
npm_config_cache=/tmp/bd-console-npm-cache npm pack --dry-run
```

- `npm run check` runs `node --check` over every server, script, and
  frontend module.
- `npm run smoke` spins up a temporary beads repo and a temporary
  `BD_CONSOLE_CONFIG_DIR`, starts `bd-console` against them, and exercises
  the hub end to end: registry add/list, issues/docs/comments,
  inline edits, quick capture, rich issue creation + epics, the tmux API,
  the scheduler (create/list/cancel + a tick-driven failure case), daemon
  `start` supersede behavior, systemd unit-file generation, `update
  --dry-run`, `settings` set/list/unset, and the non-TTY first-run defaults
  path. It never touches your real `~/.config/bd-console` or a real
  systemd user session.
- `npm pack --dry-run` confirms the published tarball contains the expected
  files.

## Documentation site

This repo also includes a no-build static docs site in `site/`.

```bash
npm run docs:serve
```

For deployment details, see [`docs/docs-site.md`](docs/docs-site.md). If
you're upgrading from an older single-repo install of `bd-console`, see
[`docs/upgrading.md`](docs/upgrading.md).

## Export freshness

Comments are always read live via `bd comments --json`, so they never go
stale. The issue list comes from `.beads/issues.jsonl`; the server
auto-refreshes that export whenever it's missing or older than
`.beads/last-touched`, and the dashboard shows the current sync state in
the top bar.

If you mutate issues outside the dashboard — `bd create`, `bd update`,
`bd close`, `bd dep`, `bd label`, or similar — and want the change to show
up before the next auto-refresh, run:

```bash
bd export -o .beads/issues.jsonl
```

## Ideas and triage conventions

Quick capture and rich issue creation both default new issues into the
`triage` label if you don't set one. Treat `triage` as an inbox, not a
final classification:

- Use `triage` for raw captured work that still needs sorting.
- Add focused labels after review.
- For doc-originated ideas, use a `doc:<path>` label so the source document
  stays recoverable, until doc-anchored capture becomes a first-class UI
  flow.

## Agent integration

`bd-console-init --apply-agent-docs` inserts a short `bd-console` block into
`AGENTS.md` / `CLAUDE.md` covering how to start the hub, that
`.beads/issues.jsonl` should be refreshed after non-UI beads mutations, the
`triage` / `doc:<path>` conventions, and how to verify the dashboard is
reachable. This repo's own `AGENTS.md` and `CLAUDE.md` show the intended
shape.

## Troubleshooting

- **`no .beads/ found at <path>`** when running `bd-console add`
  The path (or nothing above it, walking up from cwd) has a `.beads/`
  directory. Run `bd init` there first, or point `add` at the right path.
- **`Port <n> is already in use by a process that does not look like
  bd-console`**
  `start` refuses to kill unknown processes on the configured port. Free it
  manually, or run with a different `--port`.
- **`start` says it started, but the dashboard doesn't load**
  Run `bd-console status` — it checks real port reachability, not just
  whether a pid is alive. If it's not reachable, check the log
  (`~/.config/bd-console/console.log`, or `journalctl --user -u
  bd-console.service` under systemd supervision) — `start` also tails this
  automatically on failure.
- **A project I registered doesn't show up / 404s**
  Confirm it's actually registered: `bd-console list`. Re-add it with
  `bd-console add <path>` if not.
- **Issue list looks stale**
  Run `bd export -o .beads/issues.jsonl` inside that project (see
  [Export freshness](#export-freshness)); the server also auto-refreshes it
  on access when stale.
- **Comments show up but new issues or status changes don't**
  Comments are always live; the issue list comes from the JSONL export.
- **Docs list is noisy in a large repo**
  Set `docRoots` in that project's `bd-console.json`.
- **The scheduler / tmux API returns `501`**
  You're on Node <22 (`node:sqlite` isn't available). Upgrade Node — the
  rest of the hub still works without it.
- **A scheduled job shows status `failed`**
  Check its `error` — almost always "tmux session not found": the named
  session wasn't running when the job's `runAt` arrived. The scheduler
  never creates sessions for you.
