# bd-console

A **Global Hub and viewer + light editor** for
[beads](https://github.com/gastownhall/beads) (`bd`) issues and a project's
markdown docs. One responsive web UI for desktop and mobile. Zero npm
dependencies: just Node (>=18) and the `bd` CLI on your `PATH`.

It reads `.beads/issues.jsonl` for the issue list and shells out to `bd` for
live comments and quick capture, so it works in **any** repo that has beads
installed.

## What it does

- **Modern Visual Design**: Sleek dark and light themes (10 visual presets including Dracula, Nord, Gruvbox, and Tokyo Night) utilizing smooth CSS transitions and a responsive fluid grid layout.
- **Native View Transitions**: Fluid page and detail morphing animations when navigating views or selecting issues, leveraging native browser transition APIs.
- **Beads**: every issue from `.beads/issues.jsonl`, including dependencies,
  with filter/sort by status, priority, type, label, search, group-by-epic,
  and "ready only".
- **Relationships**: derived parent / children / blocked-by / blocks state,
  computed client-side from `dependencies[]`.
- **Comments**: read and add comments on any issue through `bd comment`.
- **Quick capture**: Uses a native, accessible HTML5 `<dialog>` modal to easily capture ideas without leaving your context.
- **Keyboard Shortcuts**: Vim/Gmail-like keyboard shortcuts for fast, hands-on-keyboard triage.
- **Docs**: browse project markdown, either auto-discovered or pinned through
  config.

## Install

You need:

- Node 18+
- the `bd` CLI on your `PATH`
- a target repo that already has `.beads/`

If the target repo does not have beads yet:

```bash
cd ~/code/my-project
bd init
bd export -o .beads/issues.jsonl
```

### Option A: clone this repo

No `npm install` step is required because `bd-console` has no npm dependencies.

```bash
git clone https://github.com/formless63/bd-console.git ~/code/bd-console
cd ~/code/bd-console
```

### Option B: install the CLI globally from GitHub

```bash
npm install -g git+https://github.com/formless63/bd-console.git
```

That gives you:

- `bd-console`
- `bd-console-init`

## Quick start

### Guided setup

Point the init script at the repo you want to use with `bd-console`:

```bash
# if you cloned this repo
node ~/code/bd-console/scripts/init.mjs --repo ~/code/my-project --apply-agent-docs

# if you installed the CLI globally
bd-console-init --repo ~/code/my-project --apply-agent-docs
```

What that does:

- confirms the repo has `.beads/`
- refreshes `.beads/issues.jsonl`
- writes `bd-console.json` if it does not exist yet
- detects likely markdown doc roots
- optionally updates `AGENTS.md` / `CLAUDE.md` with `bd-console` guidance

*(Linux Users)*: You can add `--install-service` to automatically configure and start a `systemd` user service that persists across system reboots.

If the target repo does not already have `AGENTS.md` or `CLAUDE.md`, rerun with:

```bash
bd-console-init --repo ~/code/my-project --apply-agent-docs --create-missing-agent-docs
```

### Hub Mode (Default)

`bd-console` now runs as a **Global Hub**. You start one instance of the server, and then add your repositories to it.

Start the daemon:
```bash
bd-console start
```
Then open `http://localhost:4180` to view the Hub Dashboard.

Register your projects with the Hub:
```bash
bd-console add ~/code/my-project
bd-console add .
```
The Hub Dashboard will now display live metrics for all registered projects and let you navigate between them seamlessly.

bd-console always runs as a single Global Hub — there is no single-project
server mode. `--repo` is only used by `bd-console-init` to choose which repo
to initialize/register; it is not a `bd-console`/`bd-console start` flag.

You can manage the daemon with:
```bash
bd-console status
bd-console stop
```

*(Note: If you run `bd-console` without `start`, it will run in the foreground.)*

## Verification

Local checks:

```bash
npm run check
npm run smoke
npm_config_cache=/tmp/bd-console-npm-cache npm pack --dry-run
```

- `npm run check` verifies server and frontend syntax.
- `npm run smoke` creates a temporary beads repo, starts `bd-console` against
  it, and exercises the core HTTP paths including comments and quick capture.
- `npm pack --dry-run` confirms the published tarball contains the expected
  files.

## Documentation site

This repo also includes a no-build static docs site in `site/`.

```bash
npm run docs:serve
```

For deployment details, see `docs/docs-site.md`.

## Setup expectations

`bd-console` assumes the target repo already has a working beads database.

Useful commands:

```bash
bd where
bd export -o .beads/issues.jsonl
```

- `bd where` confirms which workspace `bd` resolves.
- `bd export -o .beads/issues.jsonl` refreshes the exported issue list that the
  dashboard reads.
- The server now auto-refreshes the export when it is missing or older than
  `.beads/last-touched`, and the top bar shows the current sync state.

If you mutate issues outside the dashboard with commands like `bd create`,
`bd update`, `bd close`, `bd dep`, or `bd label`, refresh the export afterward
so the UI stays accurate:

```bash
bd export -o .beads/issues.jsonl
```

Comments are different: they are read live via `bd comments --json`, so they do
not depend on the JSONL export.

## Configuration

Drop a `bd-console.json` at the project root (see `bd-console.json.example`):

```json
{
  "port": 4180,
  "host": "127.0.0.1",
  "docRoots": ["docs", ".planning"],
  "token": "a-shared-secret"
}
```

- `host`: bind address. Prefer `127.0.0.1` unless you intentionally want LAN or
  tailnet access.
- `port`: HTTP port, default `4180`.
- `docRoots`: limit and order markdown folders. Omit to auto-discover `*.md`
  under the workspace.
- `token`: when set, write actions require `x-bd-token`. Reads remain open.

Environment overrides:

```bash
BD_CONSOLE_HOST
BD_CONSOLE_PORT
BD_CONSOLE_TOKEN
BD_CONSOLE_CONFIG_DIR
```

The init script writes this file for you unless one already exists. Use
`--force-config` if you want it to overwrite an existing config.

## Security notes

- Writes go through `bd` via `execFile` with an args array. There is no shell
  interpolation.
- Issue IDs are format-validated before writes.
- Doc reads are restricted to the workspace and validated against traversal.
- If you expose the server off localhost, set a token.
- `?token=` works for API calls, but the browser UI stores the token in
  `localStorage` and sends it via `x-bd-token`.

## Ideas and triage conventions

Right now the quick-capture path creates a `task` with a default `triage`
label. Treat that as an inbox, not a final classification.

Suggested conventions for repos using `bd-console`:

- Use `triage` for raw captured work that still needs sorting.
- Add focused labels after review.
- For doc-originated ideas, use a `doc:<path>` label so the source document is
  recoverable even before doc-anchored creation is implemented in the UI.

## Keyboard Navigation

To speed up issue triage, the dashboard supports vim-like keyboard navigation shortcuts directly inside the app:

| Shortcut | Action |
| --- | --- |
| `j` | Select the next issue in the list |
| `k` | Select the previous issue in the list |
| `/` | Focus the issue search field |
| `c` | Focus the "Add a comment" input area |
| `i` | Open the Quick Capture modal dialog |
| `Esc` | Close the open modal dialog or remove focus |

Note: These keys are ignored when you are typing into a form field or text input element.

## Agent integration

The init script can update `AGENTS.md` and `CLAUDE.md` for you:

```bash
bd-console-init --repo ~/code/my-project --apply-agent-docs
```

The inserted guidance covers:

- how to start `bd-console`
- that `.beads/issues.jsonl` must be refreshed after non-UI beads mutations
- how ideas should be labeled and triaged
- how to verify the dashboard is reachable

This repo's own `AGENTS.md` and `CLAUDE.md` show the intended shape.

## Troubleshooting

- `Error: no beads database found`
  Register the repo with `bd-console add <path>` (or run `bd-console-init --repo <path>`), or inspect `bd where`.
- Issue list is stale
  Run `bd export -o .beads/issues.jsonl`.
- Comments work but new issues or status changes do not appear
  Refresh the export; comments are live, issues are from JSONL.
- Docs list is noisy in a large repo
  Set `docRoots` explicitly.

## Roadmap

Current focus areas:

- automatic export freshness and health reporting
- safer default network posture and setup guidance
- inline issue edits from the detail panel
- doc-anchored idea capture
- packaging and release guardrails
