# AGENTS.md — bd-console

Context for any coding agent working on **bd-console**. Read this first.

## What this is

A standalone, **project-agnostic** web tool to view and lightly edit
[beads](https://github.com/gastownhall/beads) (`bd`) issues and a project's
markdown docs. It runs locally against *any* repo that has beads installed.
It started as an in-repo console and was then generalized into its own public
repository.

**Hard constraints (do not break these):**
- **Zero npm dependencies.** Node built-ins only (`http`, `fs`, `child_process`,
  `path`, `url`). No framework, no bundler, **no build step**. Keep it that way —
  the whole point is "drop in and run."
- **Writes shell out to `bd` via `execFile` with an args array — never a shell
  string.** This is the injection defense (verified: a comment containing
  `$(touch /tmp/PWNED)` is stored as literal text). Any new write must follow
  this pattern and validate the issue id against `ID_RE`.
- Frontend is **vanilla JS, no transpile.** `node --check public/app.js` is the
  syntax gate; there's no tsc.

## Run

```bash
node serve.mjs start              # starts in background, auto-detects .beads/ from cwd, port 4180
node serve.mjs start --repo ~/proj --port 4181 --host 127.0.0.1
node scripts/init.mjs --repo ~/proj --apply-agent-docs
```
`package.json` exposes a `bd-console` bin, so once published it's `npx bd-console`.
The repo also ships `bd-console-init` for first-run setup.

## Layout

```
serve.mjs              zero-dep Node server (the only backend)
public/
  index.html           shell + topbar + quick-capture modal + theme <head> script
  app.js               all client logic (state, render, comments, quick, themes, md)
  styles.css           CSS custom-property theme tokens + components
package.json           bin: bd-console -> serve.mjs ; "files" whitelist
bd-console.json.example optional per-project config
README.md              user-facing docs
```

## Server (serve.mjs)

- **Workspace detection:** `--repo` / `$BD_CONSOLE_REPO` / walk up from cwd to the
  nearest `.beads/`. Exits if none found.
- **Config:** optional `bd-console.json` at the workspace root —
  `{ port, host, docRoots, token }`. Default host is `127.0.0.1`. Env overrides:
  `BD_CONSOLE_{PORT,HOST,TOKEN,REPO}`.
- **Endpoints:**
  - `GET /api/meta` → `{ workspace, name, writable, tokenRequired }`
  - `GET /api/issues` → parses `.beads/issues.jsonl` (full records **incl.
    dependencies** — that's why we read the JSONL, not `bd list --json` which
    omits deps).
  - `GET /api/docs` → discovered markdown (see below).
  - `GET /api/doc?path=` → raw markdown; path validated against traversal + allowed roots.
  - `GET /api/comments?id=` → `bd comments <id> --json`.
  - `POST /api/comment {id,text}` → `bd comment <id> <text>`, returns refreshed comments.
  - `POST /api/quick {title,description?,label?,priority?}` → `bd create --silent …`,
    then **`bd export -o .beads/issues.jsonl`** to refresh the list (the bare
    `bd export` goes to stdout — must pass `-o`).
- **Docs discovery:** if `docRoots` is configured, use it; else auto-discover all
  `*.md` under the workspace, grouped by top-level dir (skipping `node_modules`,
  `.git`, `.next`, `db`, etc.). The `.planning` dir is allowed despite the leading dot.
- **Security:** writes are token-gated **only when** a `token` is configured (env or
  config); otherwise open. Default host is `127.0.0.1`; opening it to LAN/tailnet
  should be explicit and should usually be paired with a token. Static responses
  send `cache-control: no-cache` so edits show on refresh.

## Frontend (public/app.js)

- Reads the three GET endpoints; renders the **Beads** view (filter/sort by
  status/priority/type/label, search, group-by-epic, ready-only) and **Docs** view.
- **Derived issue state** is computed client-side from `dependencies[]`:
  `parent-child` → parent/children; other types → blocked-by/blocks; an open issue
  with unresolved blockers shows as **blocked**; open + none = **ready**.
- **Comments + quick capture** call the POST endpoints (`apiPost`, token-aware via
  `localStorage` `bd_token`). Quick capture is bound to the `i` key.
- **Themes:** 10 palettes via `[data-theme]` (Dark default + Light, GitHub Light,
  Solarized L/D, Nord, Dracula, Gruvbox, Tokyo Night, Catppuccin). A `<head>`
  script applies the saved/`prefers-color-scheme` theme before paint. Badges derive
  fills from theme hues via `color-mix()` so they adapt to light + dark — **do not
  reintroduce hardcoded badge hex.**
- **Docs tree:** plain block list (single scroll container = `.filters`; a nested
  flex+overflow collapsed it before — keep it block). Root-level docs render bare at
  the top; other folders are collapsible (`state.collapsedGroups`, persisted).
- Compact inline markdown renderer (headings/code/lists/tables/blockquote/inline) —
  no external markdown lib (keeps zero-dep).
- Responsive: below 820px the multi-pane layout collapses to one pane with an
  off-canvas filters drawer and back buttons.

## Current state (2026-06-13)

Shipped: viewer + relationships, comments (read/add), quick capture, 10-theme
engine + switcher, collapsible/top-anchored docs tree, responsive, injection-safe
writes, optional token. Verified against real beads-backed repos.

## Natural next steps (not built)

- **Inline edits** from the detail panel: status (claim/close/reopen/defer),
  priority, labels, dependencies — via `bd update`/`dep`/`label`. This is the
  highest-value next feature (turns it into full triage).
- **Planning board** (kanban by status/epic, add child issues).
- **Doc-anchored ideas** (select text in a doc → `bd q` with a `doc:<path>` label).
- **Distribution:** publish to npm / a public GitHub repo; optional Docker image
  (would need `bd` in the image + the target repo mounted).
- A reboot-durable service wrapper (systemd / compose) — currently a backgrounded
  process.

## Gotchas

- `bd export` defaults to **stdout**; use `-o <file>` to write `issues.jsonl`.
- Comments are read **live** via `bd comments --json` (always fresh); the issue
  list is the JSONL export (refreshed after quick-capture).
- This tool is the successor to an earlier in-repo console (unthemed, no
  interactivity); this standalone repo is now the maintained version.
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
- For setup work, prefer localhost binding and explicit tokens before telling
  users to expose the dashboard to a network.
- Before telling a user the tool is ready, verify both:
  - `bd-console` starts against the intended repo
  - `http://localhost:<port>` or the configured host/port actually loads
- If you update install or agent conventions here, mirror the same operational
  guidance in `README.md`, `AGENTS.md`, and `CLAUDE.md` together.
- Keep the beginner path working: clone or global install, run `bd-console-init`,
  then start `bd-console start` without requiring the user to infer missing steps.

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
