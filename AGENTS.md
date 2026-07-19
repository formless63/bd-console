# AGENTS.md — bd-console

Context for any coding agent working on **bd-console**. Read this first.

## What this is

A standalone, **project-agnostic** web tool to view and lightly edit
[beads](https://github.com/gastownhall/beads) (`bd`) issues and a project's
markdown docs. It runs locally against *any* repo that has beads installed.
It started as an in-repo console and was then generalized into its own public
repository.

**Hard constraints (do not break these):**
- **Zero npm dependencies.** No `npm install` step, no bundler, **no build
  step** — the server is Node built-ins only (`http`, `fs`, `child_process`,
  `path`, `url`, `node:sqlite`), and the frontend vendors its own copies of
  Preact/htm/signals/Shoelace under `public/vendor/` rather than pulling them
  from npm. Keep it that way — the whole point is "drop in and run." (This is
  looser than it used to be: the frontend now runs a small framework, just a
  self-hosted one — see [Frontend](#frontend-publicappjs--publicui) below.)
- **Writes shell out to `bd` via `execFile` with an args array — never a shell
  string.** This is the injection defense (verified: a comment containing
  `$(touch /tmp/PWNED)` is stored as literal text). Any new write must follow
  this pattern and validate the issue id against `ID_RE`.
- Same rule for `tmux`: `lib/tmux.mjs` always calls `execFile('tmux', [...args])`,
  never a shell string, and validates session names against `SESSION_NAME_RE`
  before they reach any tmux invocation (tmux's `-t` target syntax has its own
  mini-grammar, so this matters even with an args array).
- Frontend is **no-build, ES modules loaded via an import map** — no
  transpile, no JSX compile step. `npm run check` runs `node --check` over
  every `public/ui/**/*.js` file as the syntax gate.

## Run

`bd-console` is a **Global Hub**: one server per machine, with repos
registered into it — there is no more per-repo `--repo` server mode.

```bash
bd-console start                    # (re)start the hub, supervised in the background
bd-console add ~/code/some-project  # register a repo with the running hub
bd-console status                   # pid + port reachability + supervision mode
bd-console stop
node scripts/init.mjs --repo ~/proj --apply-agent-docs   # optional guided per-repo setup
```
`package.json` exposes `bd-console` (serve.mjs) and `bd-console-init`
(scripts/init.mjs) bins. `--repo` still exists as a flag, but only on
`bd-console-init`/`scripts/init.mjs` — it picks which repo to set up and
register, it is not accepted by `bd-console`/`bd-console start` itself. See
`docs/upgrading.md` for the full migration notes from the old per-repo
server mode.

## Layout

```
serve.mjs              CLI entry: arg parsing, daemon commands, foreground server boot
lib/
  paths.mjs            on-disk config locations (registry/config/pid/log/systemd dir)
  registry.mjs         hub project registry (~/.config/bd-console/registry.json)
  config.mjs           global config load + effective-settings resolution (precedence)
  settings.mjs         first-run interactive setup + `bd-console settings` UX
  daemon.mjs           start/stop/status lifecycle, supersede-on-start, log tailing
  systemd.mjs          systemd --user unit rendering + install/refresh/stop
  update.mjs           `bd-console update` (git-clone vs npm-global self-upgrade)
  bd.mjs               `bd` CLI wrapper, issue export helpers, issue-edit dispatcher
  docs.mjs             markdown doc discovery + safe path resolution
  tmux.mjs             tmux session introspection + literal prompt injection
  schedule.mjs         prompt scheduler (node:sqlite-backed job queue + poll loop)
  routes.mjs           the HTTP request handler: hub + per-project /api routes, static serving
public/
  index.html           shell, import map, theme-before-paint <head> script
  app.js               entry point: boots theme + Shoelace, routing, global keyboard shortcuts
  ui/                  store.js (signals-based state + routing), theme.js, api.js, markdown.js,
                        components/ (App, HubView, ProjectView, IssueList, IssueDetail,
                        FiltersPane, DocsView, CreateIssueDialog, TmuxView, ScheduleView, TopBar, TokenDialog, Toasts, ...)
  vendor/               self-hosted Preact, htm, @preact/signals, preact-iso, Open Props, Shoelace
  styles.css            CSS custom-property theme tokens + components
package.json            bin: bd-console -> serve.mjs, bd-console-init -> scripts/init.mjs
bd-console.json.example per-project config example (docRoots only)
README.md               user-facing docs
docs/upgrading.md        upgrade + single-repo-era migration guide
```

## Server (serve.mjs + lib/)

- **Hub routing:** every project-scoped request is `/api/p/<projectId>/...`;
  `getContext()` in `lib/routes.mjs` looks `projectId` up in the registry
  (`lib/registry.mjs`, backed by `~/.config/bd-console/registry.json`) to
  resolve the workspace path. Unknown project ids 404. Hub-level routes
  (`/api/meta` at the root, `/api/projects`, `/api/tmux`, `/api/tmux/preview`,
  `/api/schedule`, `/api/schedule/cancel`) are not project-scoped.
- **Config:** global host/port/token/persist come from `lib/config.mjs`
  (`resolveSettings`), precedence CLI flags > env vars
  (`BD_CONSOLE_{HOST,PORT,TOKEN,PERSIST}`) > `~/.config/bd-console/config.json`
  > defaults (`0.0.0.0:4180`, no token, persist auto-detected). A per-project
  `bd-console.json` at a registered workspace's root now **only** contributes
  `docRoots` (`lib/config.mjs` `loadWorkspaceConfig`) — host/port/token keys in
  it are inert.
- **Endpoints** (see `lib/routes.mjs` for the authoritative list):
  - `GET /api/meta` → hub root: `{ mode:'hub', host, port, hostname, pid,
    writable, tokenRequired }`; per-project (`/api/p/<id>/meta`): adds
    `projectId`, `workspace`, `name`, `export`, `health`.
  - `GET /api/projects` → the registry.
  - `GET /api/p/<id>/issues` → parses `.beads/issues.jsonl` (full records
    **incl. dependencies** — that's why we read the JSONL, not `bd list
    --json` which omits deps), auto-refreshing the export if stale.
  - `GET /api/p/<id>/docs`, `GET /api/p/<id>/doc?path=` → discovered/raw markdown.
  - `GET /api/p/<id>/comments?id=` → `bd comments <id> --json`.
  - `GET /api/p/<id>/epics` → open epics, for the create-issue parent picker.
  - `POST /api/p/<id>/comment {id,text}` → `bd comment`, returns refreshed comments.
  - `POST /api/p/<id>/quick {title,description?,label?,priority?}` → simple
    one-line capture via `bd create --silent`.
  - `POST /api/p/<id>/create {title,type?,priority?,labels?,acceptance?,
    design?,notes?,parent?,assignee?}` → rich issue creation.
  - `POST /api/p/<id>/edit {id,op,...}` → claim/set-status/set-priority/
    add-remove-label/set-parent/add-remove-blocker/set-defer, dispatched in
    `lib/bd.mjs` `runIssueEdit`.
  - `GET /api/tmux`, `GET /api/tmux/preview?session=&lines=` (token-gated —
    pane contents can hold secrets) → `lib/tmux.mjs`.
  - `GET /api/schedule`, `POST /api/schedule {prompt,session,runAt}`, `POST
    /api/schedule/cancel {id}` → `lib/schedule.mjs`; 501 when `node:sqlite`
    is unavailable.
  - All `POST` routes above refresh `.beads/issues.jsonl` are involved in
    issue-jsonl-affecting writes (comment does not, since comments are live).
- **Docs discovery:** unchanged in spirit — if `docRoots` is configured, use
  it; else auto-discover all `*.md` under the workspace, grouped by top-level
  dir (skipping `node_modules`, `.git`, `.next`, `db`, etc.). `.planning` is
  allowed despite the leading dot.
- **Security:** writes are token-gated **only when** a `token` is configured
  (global config/env/flag); otherwise open. Default host is now `0.0.0.0`
  (changed from `127.0.0.1`), which is why first run on a TTY walks through
  an interactive LAN-vs-VPS prompt (`lib/settings.mjs`
  `maybeFirstRunSetup`/`runFirstRunInteractive`) rather than silently
  applying that default. Static responses send `cache-control: no-cache` so
  edits show on refresh.

## Frontend (public/app.js + public/ui/)

- **Stack:** Preact + `@preact/signals` + `htm` (tagged-template JSX
  alternative, no build step) loaded through the import map in
  `public/index.html`, with all deps vendored into `public/vendor/` (Preact,
  htm, signals, preact-iso, Open Props tokens, a selective slice of
  Shoelace). Still zero npm install and no bundler — the framework is just
  self-hosted now instead of hand-rolled.
- `app.js` is the entry point: boots Shoelace (`ui/shoelace.js`) + theme
  (`ui/theme.js`), wires hash-based routing and global keyboard shortcuts,
  then renders `<App/>`. `ui/store.js` holds all state as signals
  (`store.*`) plus `parseHash`/`navigate` for routing.
- **Routing:** hash-based (`#/`, `#/p/<projectId>`, `#/p/<projectId>/docs`,
  plus tmux and scheduler views), parsed by `parseHash()` in `ui/store.js` —
  deep links work even served as static files.
- Renders the **Hub** view (`HubView.js`, project switcher) and, per
  project, the **Beads** view (`ProjectView.js`/`IssueList.js`/`IssueDetail.js`,
  filter/sort by status/priority/type/label, search, group-by-epic,
  ready-only, plus inline edit ops) and **Docs** view (`DocsView.js`).
- **Derived issue state** is computed client-side from `dependencies[]`:
  `parent-child` → parent/children; other types → blocked-by/blocks; an open issue
  with unresolved blockers shows as **blocked**; open + none = **ready**.
- **Comments + quick capture + rich create** call the POST endpoints
  (`ui/api.js`, token-aware via `localStorage` `bd_token`, prompted through
  `TokenDialog.js`). Quick capture is bound to the `i` key.
- **Themes:** 5 presets (Default, Dracula, Nord, Gruvbox, Tokyo Night) via
  `ui/theme.js`, each with light/dark/auto scheme — `data-theme` +
  `data-scheme` on `<html>`, applied before first paint by the `<head>`
  script in `index.html` (no flash of the wrong theme). Keep badge colors
  derived from theme hues rather than reintroducing hardcoded badge hex.
- Compact inline markdown renderer in `ui/markdown.js`
  (headings/code/lists/tables/blockquote/inline) — still no external
  markdown lib.
- Responsive: below the mobile breakpoint the multi-pane layout collapses to
  one pane with an off-canvas filters drawer and back buttons.

## Current state

Shipped: Global Hub architecture (registry, superseding `start`, systemd
persistence, self-`update`), rich issue creation + epics, inline issue edits,
tmux session introspection, the prompt scheduler, and the Preact/htm
frontend rewrite (5-preset theming, hash routing). Verified against real
beads-backed repos via `npm run smoke`.

## Natural next steps (not built)

- **Planning board** (kanban by status/epic, add child issues).
- **Doc-anchored ideas** (select text in a doc → capture with a `doc:<path>` label).
- **Distribution:** publish to npm proper (currently GitHub-install only);
  optional Docker image (would need `bd` and `tmux` in the image).
- Non-Linux persistence (systemd `--user` is Linux-only; other platforms
  fall back to a plain detached process with no reboot survival).

## Gotchas

- `bd export` defaults to **stdout**; use `-o <file>` to write `issues.jsonl`.
- Comments are read **live** via `bd comments --json` (always fresh); the issue
  list is the JSONL export (auto-refreshed when stale, and after any write).
- This tool is the successor to an earlier in-repo console (unthemed, no
  interactivity), then to a single-repo-server design (`--repo`/
  `BD_CONSOLE_REPO`) that's since been replaced by the Global Hub
  architecture — see `docs/upgrading.md` for the migration notes.
- For release or packaging work, run `npm run check`, `npm run smoke`, and
  `npm_config_cache=/tmp/bd-console-npm-cache npm pack --dry-run`.

## Agent workflow for bd-console

When working on this repo, assume other repos may eventually install and rely on
the patterns established here.

- If you change beads issue data through raw `bd` commands outside the
  dashboard, refresh the export with `bd export -o .beads/issues.jsonl`.
- The dashboard currently refreshes export after quick capture, but not every
  future write path exists yet. Keep export freshness explicit in any new beads
  mutation you add.
- Treat `triage` as the default inbox label for captured ideas.
- If an idea comes from a specific document, preserve provenance with a
  `doc:<path>` label until the UI grows first-class doc-anchored capture.
- For setup work, follow the same LAN-vs-VPS guidance the first-run flow
  gives (`lib/settings.mjs`): LAN → `0.0.0.0` with open writes is fine;
  anything internet-exposed → bind a private/tailnet interface and put an
  authenticating reverse proxy in front rather than relying on the token
  alone.
- Before telling a user the tool is ready, verify both:
  - `bd-console start` brings the hub up (`bd-console status` reports it
    reachable)
  - the repo in question is registered (`bd-console list`) and its
    dashboard tab actually loads
- If you update install or agent conventions here, mirror the same operational
  guidance in `README.md`, `AGENTS.md`, and `CLAUDE.md` together.
- Keep the beginner path working: clone or global install, run `bd-console-init`
  (which now also registers the repo with the hub), then `bd-console start`,
  without requiring the user to infer missing steps.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
