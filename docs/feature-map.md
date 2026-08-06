# Feature map

What's actually in the UI, where to find it, and what shipped recently. This
is a map of the *product*, not the code — see `docs/beads-coverage.md` and
`docs/molecules-design.md` for the design rationale behind the relationship
model and molecules, and the main `README.md` for install/CLI/config.

Every claim below was checked against the source (file:function references
given) or the live server (`curl` against a running hub). If something isn't
verifiable in the code, it isn't in this document.

## 1. Start here

**One hub server per machine.** You run `bd-console start` once per box, then
`bd-console add <path>` for every repo you want on the dashboard — each repo
needs its own `.beads/` (a `bd init`'d beads database). The hub (`#/`) is a
landing page listing every registered project as a card; clicking a card
opens that project.

**Console 2.0 is the primary project view.** Hub cards route straight to it
(`#/p2/<id>`) — a full-viewport "mission control" screen (omnibar, pulse
stats, a three-mode canvas, a relationship-rich Detail slide-over). There is
also an older **classic view** (`#/p/<id>`), still fully functional, reachable
via Console 2.0's own "classic view →" header link, but no longer a hub
destination — see [Recently added](#recently-added) for what that means in
practice, and the caveats under each feature below for what classic view is
missing relative to Console 2.0.

## 2. Every page/route

Routing is hash-based (`public/ui/store.js`'s `parseHash()`), so every one of
these is a shareable/bookmarkable URL as well as a click path.

| Route | How you get there | What it's for |
|---|---|---|
| `#/` | Default landing page; the ⌂ icon in Console 2.0's header; the "Hub" back button in classic view's top bar | Global Hub: project cards, live tmux/scheduler summary, bd-version status, usage gauges |
| `#/p2/<id>` | Click a project card on the hub (the *only* click-through the cards offer) | Console 2.0 — the primary per-project view (§4) |
| `#/p/<id>` | Console 2.0's "classic view →" header link; a bookmarked/typed URL | Classic project view: three-pane issues layout (filters · list · detail) |
| `#/p/<id>/docs` | The "Docs" tab inside classic view | Classic docs browser (read + open a markdown file; no inline editor or promote-to-issue — those are Console 2.0's Docs mode only) |
| `#/tmux` | Hub's "Overview" ops-strip chip; hub's "Terminal sessions" section "View all →"; classic top bar's Terminal nav icon; a tmux session card's own click | Grid of every tmux session/pane on the hub's host, with a live scrollback preview drawer |
| `#/schedule` | Hub's "Overview" ops-strip chip; classic top bar's Schedule nav icon; a tmux session card's "Schedule a prompt here" button (preloads that session) | Create/list/cancel scheduled prompts (queued keystrokes into a named tmux session at a future time) |
| `#/settings` | Classic top bar's gear icon; an automatic redirect whenever a write is rejected for a missing/wrong token (`requireToken()` in `store.js`) | Server settings (read-only), Appearance, Beads CLI version/update, browser + server write tokens, Default epics |
| anything unrecognized | — | Falls back to the hub (`#/`) |

**Caveat:** Console 2.0's own header has no Settings link. From Console 2.0
you reach `#/settings` only by clicking "classic view →" first and then the
gear icon, or by hitting a 401 on a write (which auto-navigates you there with
a toast). This is easy to miss the first time you need it.

## 3. The hub (`#/`)

Top to bottom, `public/ui/components/HubView.js`:

- **Header** — "Global Hub" + the **Overview** strip: two chips ("N tmux
  sessions" / "unavailable", "N scheduled prompts"), each a shortcut to
  `#/tmux` / `#/schedule`. Collapsible on mobile only.
- **bd version row** — a compact chip showing the installed `bd` (beads CLI)
  version; if a newer release exists, an "update available" chip that copies
  the update command to your clipboard (or, if the command can't be
  determined, sends you to Settings); a warning chip if more than one `bd`
  binary is on `PATH` (the exact trap where an update can silently target
  the wrong binary). Fetched once per hub visit (`GET /api/bd-version`,
  server-cached for hours) — Settings has the fuller version card with a
  manual recheck.
- **Usage section** — two bands:
  - **Live quota**: Claude Code and Codex quota gauges (session/weekly
    windows, percent + "resets in Xh Ym", color-coded ok/warn/crit), plus
    per-model "scoped limits" with a loud "⛔ throttled" badge when a model is
    actively rate-limited. Polls every 5 minutes (paused while the tab is
    hidden, caught up on return) and the server caches the Claude call for
    the same 5 minutes, so an open hub can't sustain the provider's rate
    limit; the ↻ button asks for a genuinely fresh read
    (`GET /api/usage?fresh=1`), which the server still refuses during a 429
    backoff (15 min) or within ~20s of the previous manual refresh — those
    answers come back marked as cached and say so in the UI. Degrades to
    "not detected" per provider rather than erroring the whole hub. Kimi Code
    joins this band as a third row when `~/.kimi-code` exists (and renders
    nothing at all when it doesn't): stack info, not quota — server state from
    the `kimi web` heartbeat (`running`/`stale`/`stopped`, stale after 90s of
    silence), host version, host:port, session/workspace counts, and the
    newest session's model + token total. Kimi publishes no rate-limit data
    anywhere, so it deliberately gets no gauge.
  - **Usage attribution**: a separate, explicitly-labeled "estimated from
    local session logs, not quota" band — a 7/30/90-day range picker and a
    manual refresh. This is parsed from local session logs on the hub host,
    *not* the providers' own usage APIs, and is presented that way in the UI
    so it's never confused with the authoritative gauges above it.
- **Terminal sessions** — a compact table (session name/attached badge, repo
  chip if a pane's cwd matches a registered project, command, age, last
  activity, copy-attach button) for up to 6 sessions, "View all →" to
  `#/tmux`. Hidden entirely if no projects are registered yet.
- **Project grid** — one card per registered project: issue count, git
  insights if available (branch, ahead/behind, dirty-file count, commits/week,
  a labeled repo chip linking to GitHub/GitLab/etc.), status stat pills
  (Ready/Active/Blocked), a velocity pill (closed in the last 7 days) and an
  open-bugs pill when non-zero. **The entire card is one click-through to
  Console 2.0** (`#/p2/<id>`) — there is no separate control to land on the
  classic view from here.
- **Empty state**: "No projects registered. Run `bd-console add` inside a
  project to register it."

## 4. Console 2.0 (`#/p2/<id>`)

`public/ui/console2/Console2.js`. A full-viewport view with no classic top
bar — its own header, a persistent **Pulse** stats bar, a segmented **Canvas**
(Flow / Map / Docs), and a right-hand **Detail** slide-over for the selected
issue.

### Header

- **⌂** — back to the hub.
- **Brand** — project name/id, "CONSOLE 2.0 · MISSION CONTROL".
- **Omnibar** — the centerpiece command input (§5).
- **+ New** — opens the same full-featured `CreateIssueDialog` classic view
  uses (type/priority/labels/description/acceptance/epic/assignee) — the
  omnibar's own plain-text mode only does quick triage capture, not this.
- **Theme switch** — preset + light/dark/auto popover.
- **Sync chip** — `synced` / `stale` / `error` / `unknown`, reflecting the
  freshness of the `.beads/issues.jsonl` export this view is reading from.
- **classic view →** — the *only* way back to `#/p/<id>` from here.
- **CLI-flash strip** (directly under the header) — every write you make
  through Console 2.0 echoes the literal `bd`/`tmux` command it just ran
  ("✓ ran `$ bd update … --claim`"), with copy/dismiss — this is Console
  2.0's explicit "teach you the CLI" mechanism, not a suggestion to run
  something yourself.

### The Pulse bar

A row of clickable stat tiles under the header, always visible (collapsible
on mobile only — desktop always shows it):

- **Ready / Active / Blocked / Triage / Stale** tiles — each click focuses
  the matching Flow lane (or highlights stale issues). Active shows an
  "N aging" sub-label once an in-progress issue passes 24h.
- A **velocity sparkline** — issues closed per week, 8-week trailing window.
- A **"details ▾" expand** revealing:
  - **Active · ages** — every in-progress issue with an age chip
    (amber past 24h, red past 72h), click to open its Detail.
  - **Unblock hint** — "Closing **X** frees **N** issues" for the single
    open issue that, if closed, would unblock the most currently-blocked
    work. A thing you'd likely never think to compute yourself.
  - **Priority mix** — a P0–P4 bar chart of open issues.
  - **Sessions · this repo** — tmux sessions whose active pane's cwd is
    inside *this* project, each with a "delegate here" button (only enabled
    once an issue is open in Detail — see §6.5).
  - A duplicate theme switch (for narrow layouts where the header's isn't
    reachable).

### Canvas — three modes (segmented control)

- **Flow** (default) — five swim lanes: Triage · Ready · In progress ·
  Blocked · Done·7d. A "Group by epic" toggle (persisted per project)
  replaces the lanes with one row per container (epics *and* poured
  molecule roots — both group identically) showing a closed/total progress
  track. Cards carry inline quick actions (claim/start/defer/close/open).
- **Map** — a client-drawn SVG dependency graph of open issues: blocking
  edges lay out the DAG (roots left, dependents right), the longest blocking
  chain is always highlighted as the "critical chain," and hovering a node
  lights its full up/downstream blocking chain. **Non-blocking overlay
  edges** (related / tracks / discovered-from / caused-by / validates /
  supersedes / duplicates) draw as bowed curves on top, each independently
  toggleable via checkboxes in a toolbar (only types actually present in the
  current graph get a checkbox), default **related only** — all ~7 at once
  is unreadable, per `docs/beads-coverage.md`'s own rationale. Pan by drag,
  zoom by scroll/pinch/±buttons, click a node to open its Detail. A thing you
  would never discover on your own: overlay-edge toggles are per-project and
  persist in `localStorage`, so a choice you made last week is still applied.
- **Docs** — file tree (filterable), a markdown reader with **select-text-
  to-promote** (select any text in the rendered doc → a floating "✦ Promote
  to issue" button appears, prefilling a new `task`/`triage` issue with the
  quoted excerpt and a `doc:<path>` provenance label — §6.9), and an inline
  editor (Ctrl/Cmd+S to save, a dirty dot, a live preview toggle). On mobile,
  where text-selection handles are unreliable, a manual "promote…" form lets
  you paste/type the excerpt instead of selecting it.

### Detail slide-over

Opens when any issue is selected (`selectIssue()`), in this order — every
section only renders if it has content, so a plain task shows far less than
a molecule root does:

1. Badges (type/priority/status/id) + close button.
2. Title, labels.
3. **Molecule badge** — "⚗ molecule · N steps" if this issue IS a poured
   molecule's root, or "⚗ step of <root>" (click to jump to the root) if
   it's one of that molecule's steps.
4. **Retired-state banner** — "Superseded by / Duplicate of `<other>`" —
   this **outranks** the blocked/ready banner below it (an issue bd already
   closed as a duplicate has no meaningful "ready to work" story).
5. Blocked banner ("⛔ Blocked by N open issues") or ready banner
   ("✓ Ready — no open blockers") — whichever applies, never both.
6. Description / Close reason / Design / Notes / Acceptance (all rendered as
   markdown).
7. **Steps** (molecule roots only) — a progress bar, then a parallel-group-
   aware step list: each step is a relationship chip plus (when the live
   `bd ready --mol` call succeeds) its parallel-group label and a "ready"
   pip. Falls back to a locally-derived (non-parallel-aware) step list if
   the live call fails — it never blocks rendering on that call.
8. Parent · Blocked by · Blocks · Children (Children is suppressed for
   molecule roots — already covered by Steps above).
9. Related (bidirectional — renders once regardless of which issue created
   the edge) and one section per other link type actually present on this
   issue, both directions (tracks/discovered-from/caused-by/validates/
   supersedes/duplicates) — only non-empty sections show, so the panel never
   grows ten empty headings.
10. **Undo** (molecule roots only) — "Burn this molecule…": a dry-run
    preview (verbatim `bd mol burn --dry-run` text) then a confirm button
    labeled with the real bead count. **Caveat, stated plainly in the UI
    itself**: burn deletes *everything* parented under the root, including
    beads you added by hand after pouring — not just what the pour created —
    and it silently drops (does not archive) dependency links from issues
    outside the molecule. This is a real, git-synced deletion, not a
    soft-delete.
11. **Edit** — claim/start/close/reopen; priority P0–P4; labels
    add/remove; parent set/clear; blocked-by add/remove; a generic **Link**
    row (pick any of the 10 `bd dep add --type` values + an issue id — see
    §5's link-type table); a **Retire** row — Supersede (closes *this*
    issue, needs a replacement id) and Duplicate (closes *this* issue, needs
    a canonical id), explicitly labeled as state transitions, not links;
    Defer set/clear.
12. **Delegate** — compose a prefilled tmux prompt ("Work on `<id>`: `<title>`
    … Run `bd show <id>` for full context."), pick a *live* tmux session (no
    default preselected — you must choose, a deliberate anti-footgun after an
    earlier stray-prompt incident), then "Send now" or pick a datetime and
    "Schedule…". **This section, and the Pulse rail's "delegate here", exist
    only in Console 2.0** — the classic view has no equivalent.
13. **Comments** — live via `bd comments --json` (never stale), ⌘/Ctrl+Enter
    to submit.
14. **Meta** — assignee, created/updated/closed timestamps.

## 5. The omnibar

`public/ui/console2/Omnibar.js` — the single input in Console 2.0's header.
Focus it with `/` (when not already typing) or **Ctrl/Cmd+K** from anywhere
in Console 2.0; Escape or a click outside closes it.

Three auto-detected modes, based on what you type:

1. **Capture** (plain text, no prefix) — Enter creates a triage bead: `task`,
   priority 3, label `triage`, title = what you typed
   (`bd create --type task -p 3 --labels triage --title "…"`). While typing,
   up to 6 fuzzy-matched existing issues (by id or title) also appear below
   the capture row — clicking one **jumps** to its Detail instead of
   capturing a new issue.
2. **Jump** — a fuzzy match selected from the capture-mode dropdown; opens
   that issue's Detail directly.
3. **Command** (`>` or `/` prefix, or focusing the omnibar empty) — the full
   command palette:

| Command | Arguments | What it does |
|---|---|---|
| `ready` | — | Switch to Flow, focus the Ready lane |
| `blocked` | — | Switch to Flow, focus the Blocked lane |
| `triage` | — | Switch to Flow, focus the Triage lane |
| `stale` | — | Switch to Flow, highlight stale issues (21d+ no update) |
| `progress` | — | Switch to Flow, focus the In-progress lane |
| `flow` | — | Switch to Flow, clear any focus |
| `map` | — | Switch to Map |
| `docs` | — | Switch to Docs |
| `stats` | — | Scroll to / focus the Pulse rail |
| `claim` | `<id>` | Claim an issue |
| `start` | `<id>` | Mark in progress |
| `close` | `<id> [reason]` | Close an issue |
| `defer` | `<id> <when>` | Defer until (e.g. `+2d`, a date) |
| `prio` | `<id> <0-4>` | Set priority |
| `open` | `<id>` | Open an issue's Detail |
| `mol` | `[formula]` | Pour a molecule — see below |

**`mol` is the one exception to "commands act immediately."** Every other
action command runs its write on Enter. `mol` instead **opens the Molecule
dialog** (browse → fill variables → preview → confirm → pour) — pouring
creates many beads at once, so it always routes through a dry-run preview
first rather than firing on the spot. An optional argument (`> mol
mol-feature`) preselects that formula in the browser.

**Link types**, for reference (the 10 values `bd dep add --type` accepts,
used by Detail's Link row and by everything above that reads/creates
relationships — `public/ui/relationships.js`):

| Type | Meaning (outbound / inbound) |
|---|---|
| `blocks` | Blocked by / Blocks — the only type that affects readiness and the Map's layout |
| `parent-child` | Parent / Children — epic/molecule containment |
| `related` / `relates-to` | Related / Related — a bidirectional "see also," rendered once regardless of which side created it |
| `tracks` | Tracks / Tracked by — convoy tracking |
| `discovered-from` | Discovered from / Discovered — provenance ("this idea came from investigating that") |
| `until` | Blocked until / Gates |
| `caused-by` | Caused by / Caused |
| `validates` | Validates / Validated by |
| `supersedes` | Superseded by / Supersedes — a state transition (auto-closes the subject), not a plain link |

`duplicates` (from `bd duplicate --of`) behaves the same way as `supersedes`
but isn't a `dep add --type` value — it only appears because `bd duplicate`
wrote it.

## 6. Workflows, end to end

**1. Capture a thought.**
Console 2.0: type into the omnibar, Enter. Anywhere else (or via the `i`
shortcut): the full "+ New issue" dialog, intent chip "Idea / triage".

**2. File a full issue with an epic.**
Press `i` (or click "+ New" in Console 2.0 / "New issue" in classic view) →
`CreateIssueDialog`: pick an intent chip (Log a bug / New feature / Task /
Idea·triage / Epic / Chore — each maps to a `bd create` type plus default
labels), enter a title (the only required field), optionally add a
description, priority, labels, acceptance criteria, epic parent, assignee.
The epic picker has an inline "+ new epic" so you never have to leave the
dialog to create one first. If the project's Settings → Default epics has a
mapping for the chosen intent, the epic field preselects automatically until
you touch it by hand.

**3. Link two issues.**
Open either issue's Detail → Edit → Link: pick a type from the table in §5,
enter the other issue's id, click "link". Any non-blocking/non-parent link
you created can be removed from the same row.

**4. See what's blocking what.**
Detail's "Blocked by" / "Blocks" chip rows and the blocked/ready banner on
any single issue; Console 2.0's Map mode for the whole project at once
(critical-chain highlight, hover a node to light its blocking chain).

**5. Delegate an issue to a tmux session.**
Console 2.0 only: open the issue's Detail → Delegate → the compose box is
prefilled, pick a live session from the dropdown (no default), "Send now" —
or set a datetime and "Schedule…" instead (equivalent to workflow 6 below,
scoped to this issue). Also reachable from the Pulse rail's Sessions block
("delegate here") once an issue is already open in Detail.

**6. Schedule a prompt for later.**
`#/schedule` → fill in the prompt text, pick a target session (a live
combobox over currently-running tmux sessions, or type a name), pick a run
time (manual datetime, or presets: +1h…+5h, next 2am/4am, and — when usage
data is available — "next Claude reset" / "next Codex reset"). Saved
prompts (optional feature, degrades to hidden on an older server) let you
name and reuse a prompt. A job whose target session isn't running when it
fires ends up `failed`, not silently dropped.

**7. Pour a molecule from a formula.**
Console 2.0 omnibar: `> mol` (optionally `> mol <formula-name>`) → pick a
formula from the browse list → fill in its variables (a live preview of the
resolved step titles updates as you type) → "Preview spawn →" runs the real
`bd mol pour --dry-run` and shows its output verbatim (see caveat below) →
"Pour N issues" performs the write and jumps straight to the new molecule's
Detail. **Formulas themselves have no authoring UI** — they're hand-written
`.formula.json` files under a project's `.beads/formulas/`; the dialog only
browses and pours what's already there.

**8. Edit a doc and promote a selection to an issue.**
Console 2.0 → Docs mode → open a file → either click "edit" (inline
textarea, ⌘/Ctrl+S to save, "preview" toggles a live rendered pane) or, in
read mode, select any text in the rendered markdown to get a floating
"✦ Promote to issue" button — click it to create a `task`/`triage` issue
whose description quotes the selection and carries a `doc:<path>` label back
to the source. On mobile, use the "promote…" button to paste/type the
excerpt instead of selecting it.

**9. Check your usage/limits.**
Hub → Usage section: the "Live quota" band is the authoritative Claude
Code/Codex gauges (percent used, reset countdown, per-model throttled
badges). The "Usage attribution" band below it is a separate, explicitly-
labeled *estimate* derived from parsing local session logs — useful for "how
much of my usage went to which project/model," not for "am I about to hit a
limit" (that's the Live quota band's job).

**10. Update beads (the `bd` CLI).**
Hub's bd-version row, or Settings → "Beads CLI" card for the fuller view:
shows installed vs. latest (checked against GitHub, cached for hours — "↻
Recheck" forces a fresh check), a copyable update command when the install
method is known, or all three candidate commands (Homebrew/install-
script/npm) when it isn't so you can pick the one that matches how `bd` got
onto this machine. Warns if more than one `bd` binary shadows another on
`PATH` — the scenario that motivated this feature in the first place.

## 7. Keyboard shortcuts

Global (both classic project view and Console 2.0, ignored while typing in a
field — `public/app.js`'s `onKeyDown`):

| Shortcut | Action | Where |
|---|---|---|
| `i` | Open the full "New issue" dialog | Classic project view and Console 2.0 |
| `j` / `k` | Select the next/previous issue in the list | Classic project view only |
| `/` | Focus the issue search field | Classic project view (and, redundantly, Console 2.0 — the omnibar shares the same `.issue-search` class, so this and the omnibar's own `/` handler both target it) |
| `c` | Focus the "Add a comment" box | Classic project view only (Console 2.0's comment box isn't wired to this shortcut) |
| `Esc` | Close the open dialog / mobile filters drawer | Both |

Console 2.0's omnibar (`public/ui/console2/Omnibar.js`), independent of the
above:

| Shortcut | Action |
|---|---|
| `/` (not already typing) or `Ctrl/Cmd+K` | Focus the omnibar from anywhere |
| `↑` / `↓` | Move through suggestions/commands |
| `Enter` | Run the selected (or first) item |
| `Esc` | Close the omnibar dropdown |

Elsewhere:

| Shortcut | Action | Where |
|---|---|---|
| `⌘/Ctrl+Enter` | Submit a comment | Comment composer, both views |
| `⌘/Ctrl+S` | Save the current doc | Console 2.0's Docs editor |

## 8. CLI reference

`bd-console`'s own command line (`serve.mjs`) — see `README.md` for full
detail on each:

```
bd-console                  run the hub in the foreground
bd-console start            (re)start as a supervised background process
bd-console stop             stop it, however it's currently supervised
bd-console status           pid + port-reachability + supervision report
bd-console add <path>       register a project with the hub
bd-console remove <id>      unregister a project
bd-console list             list registered projects
bd-console settings         view/edit host, port, token, persist
bd-console update [--dry-run]   self-upgrade in place
```

## Recently added

For anyone who last looked at bd-console before its relationship model,
graph, and molecule support existed:

- **Link types** — all 10 of `bd`'s `dep add --type` values are now
  creatable, visible, and removable (Detail's Link row), not just `blocks`
  and `parent-child`. Supersede/Duplicate are wired as dedicated state
  transitions (they close the source issue), not generic links.
- **Graph-links in Map** — Console 2.0's Map mode now overlays non-blocking
  link types (related/tracks/discovered-from/caused-by/validates/
  supersedes/duplicates) on top of the blocking DAG, with per-type toggles
  and a legend; default is `related` only.
- **Molecules v1** — pour a molecule from a formula via the omnibar's `> mol`
  command (browse → variables with live preview → dry-run confirm → pour),
  a molecule-aware Detail (progress + parallel-group-aware steps), epic-style
  grouping in Flow, and a "Burn this molecule" undo path. `bd mol bond`,
  `bd mol distill`, wisps, and `bd mol squash` are deliberately **not**
  built — see the caveats below.
- **Usage analytics** — the hub's Usage section: live Claude Code/Codex
  quota gauges plus a separate "estimated, not quota" attribution band.
- **bd version surfacing** — the hub's compact bd-version row and Settings'
  fuller Beads CLI card (installed/latest/update command/multiple-binaries
  warning).
- **Default epics** — Settings lets you map each create-dialog intent to a
  default epic per project, plus a one-click "create the 5 standard epics"
  action.
- **Global Hub + Console 2.0 architecture** — the umbrella change behind all
  of the above: one hub server registering many projects, with Console 2.0 as
  the primary per-project view. The older classic view (`#/p/<id>`) still
  works but is no longer a hub destination — see the caveat below.

### Caveats worth knowing

- **Classic view is being phased out as a hub destination**, not removed:
  hub project cards go straight to Console 2.0; classic view survives as
  Console 2.0's own "classic view →" escape hatch. Some newer features exist
  **only** in Console 2.0 — Delegate-to-tmux, the dependency Map, and the
  molecule Steps/Burn sections have no classic-view equivalent.
- **Molecule dry-run previews are opaque text, not structured data.**
  `bd mol pour/distill/burn --dry-run` silently ignores `--json` even when
  it's passed — bd-console renders the raw stdout verbatim rather than
  pretending it's parseable. (Confirmed in `docs/molecules-design.md` §1/§4.)
- **Burning a molecule deletes more than the pour created** — everything
  parented under the root, including beads added by hand afterward — and it
  is a real deletion (syncs to remotes), not an archive.
- **Wisps, `bd mol bond`, `bd mol distill`, and `bd mol squash` are out of
  scope, not just unbuilt.** Wisps are excluded from `bd export` entirely, so
  they're invisible to bd-console's normal read path without a second,
  always-live polling path that doesn't exist yet; `bond`'s formula-name
  resolution was found to be unreliable on the installed CLI version during
  design research. See `docs/molecules-design.md` §2/§8 for the full
  reasoning.
- **Settings has no direct link from Console 2.0** — reach it via
  "classic view →" then the gear icon, or via the automatic redirect on a
  rejected write.
- **Formula authoring has no UI anywhere** — formulas are files on disk; the
  Molecule dialog only ever reads them.
