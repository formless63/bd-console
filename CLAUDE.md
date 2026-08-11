# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

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


## Build & Test

Use the simplest checks that match the zero-dependency stack:

```bash
npm run check
npm run smoke
npm_config_cache=/tmp/bd-console-npm-cache npm pack --dry-run
```

The smoke suite is split by domain under `scripts/smoke/` (issues, tmux,
scheduler, settings, registry, docs, cli, usage, versions, routing, formulas)
behind the single `scripts/smoke.mjs` entry point. `npm run smoke` runs all of
them; while iterating on one area, run just that domain:

```bash
npm run smoke -- usage          # or: node scripts/smoke.mjs usage
node scripts/smoke.mjs --list   # the domain names
```

Add new coverage to the domain module it belongs to, not to a new tail on one
file. Shared fixtures, the scratch-port server, and the `BD_CONSOLE_*_DIR`
isolation live in `scripts/smoke/harness.mjs` — use `ctx`, never the real
`~/.config/bd-console` or a real provider directory.

**`browser` is an opt-in domain and is NOT in `npm run smoke`.** Run it by
name whenever you touch layout, `overflow`, `position`, `z-index`, or the
Detail slide-over:

```bash
node scripts/smoke.mjs browser
```

It boots a real headless Chrome (~19s, versus well under a minute for the
whole default suite — which is why it is opt-in) and drives it over the
DevTools Protocol with Node's built-in `WebSocket`. **Do not reach for
puppeteer here**: the zero-dependency, no-install-step property is
load-bearing, and this domain deliberately implements the small slice of CDP
it needs instead. Chrome itself is resolved at run time — `BD_CONSOLE_CHROME`
first, then PATH, well-known install paths, and any puppeteer-managed
download — and its absence is a clean `smoke skip (...)`, so the suite behaves
identically on a machine without a browser.

Its scope is layout, stacking, scroll and hit-testing invariants only —
things Node structurally cannot observe. Business logic belongs in the other
domains, which test it faster and more reliably. `bd-console-clb` (the Detail
slide-over stranding the app off-viewport) is pinned there as a named
regression across all three close paths.

For beginner setup work, also verify the guided init path:

```bash
node scripts/init.mjs --repo /path/to/beads-repo --dry-run --apply-agent-docs --create-missing-agent-docs
```

If you change beads data outside the dashboard flow, refresh the exported issue
list too:

```bash
bd export -o .beads/issues.jsonl
```

## Architecture Overview

- Backend: `serve.mjs` (CLI entry + daemon commands) plus `lib/*.mjs`
  (registry, config, settings, daemon lifecycle, systemd, update, bd wrapper,
  docs, tmux, scheduler, HTTP routes) — Node built-in modules only.
- `bd-console` is a **Global Hub**: one server per machine, with repos
  registered into it via `bd-console add`. There is no more per-repo
  `--repo`/`BD_CONSOLE_REPO` single-server mode — see `docs/upgrading.md` if
  you're touching anything that still assumes it.
- Frontend: `public/index.html` (import map + theme-before-paint script),
  `public/app.js` (entry point), `public/ui/` (state/routing/components), and
  `public/styles.css`. No-build Preact + `@preact/signals` + `htm`, with all
  dependencies vendored under `public/vendor/` — no npm install, no bundler.
- Data model:
  - issues come from `.beads/issues.jsonl` (per registered project)
  - comments are fetched live through `bd comments --json`
  - writes shell out to `bd` (and, for the scheduler, `tmux`) with `execFile`
    and an args array
- Project constraint: no npm dependencies (no `npm install` step), no
  bundler, no build step. Node >=22 is required (the scheduler uses
  `node:sqlite`).

## Conventions & Patterns

- Keep all new write paths injection-safe:
  - use `execFile`
  - pass an args array
  - validate issue IDs (and, for tmux, session names) against the existing
    server regexes
- If a new feature changes issue metadata, make sure export freshness is handled
  deliberately.
- Use `triage` as the default inbox label for quick ideas unless the user asks
  for a different convention.
- Preserve doc provenance with `doc:<path>` labels when creating doc-derived
  ideas outside a future first-class UI flow.
- Global settings (host/port/token/persist) belong in
  `~/.config/bd-console/config.json` / env vars, not per-project
  `bd-console.json` — that file is `docRoots`-only now. When documenting
  setup, follow the LAN-vs-VPS guidance from the first-run flow rather than
  defaulting to "always bind localhost" (the tool's own default bind is now
  `0.0.0.0`).
- Keep install docs explicit: clone or install path, init step, then run step.
