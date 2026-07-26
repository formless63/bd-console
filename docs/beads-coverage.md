# beads coverage audit & roadmap

Scope: what beads (the `bd` CLI + Dolt-backed issue graph) can do, what
bd-console currently surfaces, and a prioritized plan to close the gap —
with special attention to link types, subtask/parent-child depth,
graph-links, and molecules/workflow templates.

Sources: the installed `bd` binary's own `--help` output (authoritative for
this machine), the docs site at `https://beads.gascity.com`, and the
bd-console source tree (`lib/*.mjs`, `public/ui/**`). Every claim below is
either a direct CLI transcript, a doc quote with URL, or a file:line
reference the owner can re-open.

---

## Executive summary

bd-console is a very competent front end for the *basic issue lifecycle*
(create/claim/close/comment/label/priority/defer) plus one blocking
dependency type, rendered across a classic list view and a slicker
"Console 2.0" mission-control view. That's maybe 15–20% of what the
installed `bd` (v1.0.4) actually does. Large, coherent subsystems are
**entirely absent** from the UI: molecules/formulas/wisps (the workflow-template
engine), gates (async wait conditions), swarms, `bd query`'s expression
language, duplicate/supersede management, `history`/`diff` (audit trail),
federation, and backup. Of the CLI's ~50 top-level commands (7 groups),
bd-console's write vocabulary (`lib/bd.mjs`'s `runIssueEdit`) covers **8
operations**, all built on 6 underlying `bd` invocations (`update`, `close`,
`reopen`, `label`, `dep add/remove`).

The single most consequential finding, though, isn't a missing feature —
it's a **correctness bug in the relationship model that ships today**: the
client-side "what blocks this issue" derivation
(`public/ui/store.js:129-143`, `blockersOf`/`blocksList`) computes the
dependency-graph edges **backwards** relative to bd's own documented and
verified semantics. This affects `effStatus`, `isReady`, the "Blocked
by"/"Blocks" panels in both views, Console 2.0's MapView layout and
critical-chain highlight, the pulse "blocked" count, and the hub project
cards. See [§ The blocker-direction bug](#the-blocker-direction-bug-highest-priority-fix) for
the reproduction and evidence — this should be phase 0, ahead of any new
feature.

Beyond that: the owner's three flagged interests (richer link types,
graph-links, molecules) are each **essentially greenfield**. bd-console
understands exactly two dependency types client-side (`blocks`,
`parent-child`); the other eight the installed CLI supports
(`discovered-from`, `related`/`relates-to`, `tracks`, `until`, `caused-by`,
`validates`, `supersedes`, plus `external:` refs) are silently invisible —
not broken, just never rendered, filtered, or creatable. Molecules, formulas,
wisps, gates, and swarms have zero backend routes and zero UI surface.

---

## Installed version & CLI-vs-docs divergence

```
$ bd --version
bd version 1.0.4 (ce242a879)
```

The docs site (`beads.gascity.com`) and the installed binary mostly agree,
but there are real divergences worth flagging so the roadmap targets what
this machine can actually do:

| Topic | Docs say | Installed CLI (`bd <cmd> --help`) says | Verdict |
|---|---|---|---|
| Dependency/link **types** | `core-concepts` lists: `blocks`, `parent-child`, `discovered-from`, `related`, `conditional-blocks`, `waits-for`; `graph-links` documents `replies-to`, `relates-to`, `duplicate_of`, `superseded_by` | `bd dep add --type` accepts: `blocks\|tracks\|related\|parent-child\|discovered-from\|until\|caused-by\|validates\|relates-to\|supersedes` (10 values) | **Divergent both ways.** The installed flag help never lists `conditional-blocks`, `waits-for`, `replies-to`, or `duplicate_of` as `--type` values — those appear to be produced by *other* commands (`bd create --waits-for`, `bd duplicate`, `bd supersede`, orchestrator mail-reply plumbing) rather than being general `dep add --type` values. Conversely `tracks`, `until`, `caused-by`, and `validates` are real, installed, and undocumented on the public docs pages fetched. **Build against the CLI's 10-value list**, not the docs' list. |
| `duplicate_of` / `superseded_by` | Named as graph-link *types* | Implemented as **dedicated commands** (`bd duplicate --of`, `bd supersede --with`), not `dep add --type` values, and they have a side effect (auto-close) the docs undersell | Docs slightly mis-model these as symmetric with `relates-to`; they're closer to state-transition commands. |
| Ready-work semantics | "Open beads with no open blockers" | `bd ready --help`: excludes `in_progress`, `blocked`, `deferred`, ephemeral (wisps) by default, plus `--gated` for molecule gate-resume and `--mol` for molecule-scoped ready work | Docs summary is directionally right but the installed CLI has materially more flags (`--parent`, `--mol-type`, `--exclude-type`, `--metadata-field`, `--claim`) than the docs page conveys. |
| Molecules/formulas | Solid high-level narrative (formula → proto → molecule → wisp) | Matches closely; installed CLI additionally exposes `bd mol bond` (with `sequential\|parallel\|conditional` types and the "Christmas Ornament" `--ref` dynamic-child pattern), `bd mol distill` (reverse-engineer a formula from an ad-hoc epic), and `bd cook --mode compile\|runtime` | Docs under-describe `bond`/`distill`/`cook` — all three are real, installed, and none are in bd-console. |
| Gates | Docs list gate types `human, timer, gh:run, gh:pr, bead` | `bd gate create --help` lists `human, timer, gh:run, gh:pr` only (no `bead` in the create flag's own type list, though `bd gate --help`'s top-level text still describes bead gates as "Phase 4") | `bead` gates (cross-rig/federation gates) look like a documented-but-not-fully-wired feature on this version — treat as aspirational, not installed-and-ready. |
| Statuses | Docs imply a fixed `open/in_progress/blocked/closed` set | `bd statuses --help`: statuses are **configurable** via `status.custom`, with category semantics (`active/wip/done/frozen`) governing `bd ready` inclusion; `blocked` is described as a *derived* label, not a stored status in some contexts (`bd query`'s field docs: "dependency-blocked issues stay open; use `bd blocked`") | This is subtle and important: **`status` in the JSONL export is not the same thing as "effectively blocked."** bd-console's own effStatus() derivation (client-side "blocked" reconstruction) is doing exactly the job `bd blocked`/`bd ready` do server-side — which is correct in spirit, but see the bug below. |

---

## The blocker-direction bug (highest-priority fix)

**Claim:** `blockersOf()`/`blocksList()` in `public/ui/store.js:129-143` (and
the identical pattern re-derived in `loadProjectStats()` at
`public/ui/store.js:360-366` for hub cards) compute blocking-dependency
edges in the **wrong direction**. The same shape of bug was introduced
earlier in the pre-refactor `public/app.js` by commit `20f1a444` ("fix:
correct project-level blocker tally...", 2026-06-30) — that commit replaced
a *correct* one-line implementation with the current backwards one; the
UI-overhaul refactor (`d33d6b2`) then carried the bug into `store.js`
largely unchanged. `public/ui/console2/derive.js` and `Detail.js` re-export
and consume the same broken helpers, so **both the classic view and Console
2.0 inherit it identically.**

**Ground truth, from the installed CLI itself** (read-only, no writes):

```
$ bd dep list bd-console-fsq.2 --json      # direction=down (default): "what this issue depends on"
[ ... {"id":"bd-console-fsq.1", ..., "dependency_type":"blocks"} ]

$ bd dep list bd-console-fsq.1 --direction=up --json   # "what depends on this issue"
[ {"id":"bd-console-fsq.2", ..., "dependency_type":"blocks"} ]
```

This confirms: for issue **X**, an entry in `X.dependencies` shaped
`{issue_id: X, depends_on_id: Y, type: "blocks"}` means **Y blocks X** — the
array hangs off the *blocked* issue and lists its own blockers directly. No
graph inversion is needed to compute "what blocks X": it's `X.dependencies
.filter(type==='blocks').map(depends_on_id)`.

**What the code does instead** (`public/ui/store.js:129-139`):

```js
export function blockersOf(issue) {
  const out = new Set();
  for (const b of store.issues.value) {
    if (b.id === issue.id) continue;
    if ((b.dependencies || []).some((d) => d.type === 'blocks' && d.depends_on_id === issue.id)) out.add(b.id);
  }
  for (const d of issue.dependencies || []) {
    if (d.type === 'depends') out.add(d.depends_on_id);   // 'depends' never appears in real exports
  }
  return [...out];
}
```

The first loop scans *every other issue* for a `blocks` edge pointing *at*
`issue` — which, per the ground truth above, means "issues that depend on
`issue`" (i.e. issues **`issue` itself blocks** — its dependents), not its
blockers. The second loop checks for `type === 'depends'`, a type that does
not exist anywhere in `bd dep add --type`'s real vocabulary (it's `blocks`),
so it is dead code that never fires.

**Reproduction** (synthetic, using the exact real-world JSONL shape,
`node`, no server/daemon involved):

```
issue A: open, dependencies: []
issue B: open, dependencies: [{issue_id:'B', depends_on_id:'A', type:'blocks'}]   // B depends on A ⇒ A blocks B

blockersOf(A) → ['B']   effStatus(A) → 'blocked'   ❌ (A is the blocker; nothing blocks A)
blockersOf(B) → []      effStatus(B) → 'open'       ❌ (B depends on open A; B should read 'blocked')

blocksList(A) → []       ❌ (should be ['B'] — A blocks B)
blocksList(B) → ['A']    ❌ (should be [] — B blocks nothing)
```

**Blast radius** — every one of these reads `blockersOf`/`blocksList`/
`effStatus`/`isReady` and is therefore showing inverted blocked/ready state
today for any issue pair that isn't already closed on one side:
- `public/ui/store.js` — `effStatus`, `isReady`, `listRows` grouping, `tally`, `facets.status`
- `public/ui/components/IssueDetail.js:155-159,170-174,182-185` — "Blocked by (N)" / "Blocks (N)" panels and the ready/blocked banner
- `public/ui/components/FiltersPane.js` (status chips, "Ready only" toggle — via `facets`/`isReady`)
- `public/ui/console2/derive.js` — `lanes` (Ready/Blocked lane membership), `pulse` (blocked count, unblock hint), `graphLayout`'s edges (MapView draws edges/critical-chain in the wrong direction)
- `public/ui/console2/Detail.js:196-198,206-209` — same banner + relationship chips
- `public/ui/console2/Flow.js` — lane cards, epic-row progress
- `public/ui/store.js:360-373` (`loadProjectStats`, hub cards) — the exact same inverted pattern, independently re-implemented

**Why it hasn't been obviously wrong in daily use:** most real-world
sequential work in this project's own `.beads/issues.jsonl` was staged and
closed roughly in dependency order, so by the time anyone looks, the
blocker side is usually already closed and `openBlockersOf` returns `[]`
either way — the bug only manifests visibly while a blocker is still open,
which is exactly the situation "ready/blocked" exists to flag correctly.

**Fix sketch:** replace `blockersOf(issue)` with the direct one-liner
(`issue.dependencies.filter(d => d.type === 'blocks').map(d => d.depends_on_id)`)
— which is, notably, *exactly* what the pre-`20f1a444` code already did —
and re-derive `blocksList(id)` as the reverse-scan (today's *first* loop of
`blockersOf`, unchanged, just relabeled to the function it actually
implements). Both are O(1) and O(n) respectively with no behavior change
needed beyond swapping which function owns which loop. This is a pure
bugfix, not a new feature — but given it inverts the single most-viewed
signal in the product, it should land before any of the roadmap below.

---

## Capability → coverage matrix

Legend: **Covered** = has a backend route/mechanism and UI surface · **Partial**
= backend and/or UI exists but is limited, silent, or read-only · **Not
covered** = no route, no UI, would require new work end-to-end.

| beads capability | Coverage | Where / mechanism | What's missing (if Partial) |
|---|---|---|---|
| Create issue (title/type/priority/labels/desc/acceptance/parent/assignee) | **Covered** | `POST /api/create` → `bd create --silent --type=… -p … --labels … --title …` (`lib/routes.mjs:540-594`); `CreateIssueDialog.js` | Only 5 of `create`'s ~25 flags used: no `--due`, `--estimate`, `--external-ref`, `--spec-id`, `--metadata`, `--skills`, `--context` |
| Quick capture | **Covered** | `POST /api/quick` → `bd create --silent --type=task -p … --labels …` (`lib/routes.mjs:526-538`); Omnibar plain-text mode |  |
| Claim / start / close / reopen | **Covered** | `runIssueEdit` ops `claim`/`set-status` → `bd update --claim`, `bd close`, `bd reopen`, `bd update --status` (`lib/bd.mjs:83-131`) | No `--claim-next`, `--suggest-next`, `--continue` (molecule auto-advance), `--session` |
| Priority | **Covered** | `set-priority` op → `bd update -p` |  |
| Labels (add/remove) | **Covered** | `add-label`/`remove-label` → `bd label add/remove` | No `--set-labels` (replace-all), no `bd label list-all` / `propagate`, no label glob/regex filtering in UI (CLI has `--label-pattern`/`--label-regex`) |
| Comments | **Covered** | `GET/POST /api/comments`, `/api/comment` → `bd comments --json`, `bd comment` (`lib/routes.mjs:461-468,514-524`) | No comment editing/deletion (CLI itself may not support this either) |
| Defer / undefer | **Partial** | `set-defer` op → `bd update --defer` | No dedicated `bd defer --until` semantics surfaced distinctly from generic defer date; no undefer button distinct from clearing the field; no "deferred" filter chip |
| **Blocking dependency (`blocks`)** | **Partial — and currently inverted, see above** | `add-blocker`/`remove-blocker` → `bd dep add/remove` (default type); rendered in both Detail views | Direction bug (critical); no bulk/`--file` wiring; no cycle-check surfacing (`bd dep cycles`) |
| **Parent-child hierarchy** | **Partial** | `set-parent` op → `bd update --parent`; `parentOf`/`childrenOf` in `store.js`; epic-grouped list/Flow rows | Only **one level** rendered — a child's own children (grandchildren, i.e. `bd-x.1.1`) are not shown nested; no `bd children` tree view; no `--parent` filter in `bd ready`/`bd list` surfaced (deep-descendant filtering) |
| **Other dependency/link types** (`discovered-from`, `related`/`relates-to`, `tracks`, `until`, `caused-by`, `validates`, `supersedes`, `external:` refs) | **Not covered** | None — `store.js`'s `parentOf`/`blockersOf` only ever check for `'parent-child'` and `'blocks'` | Any dependency record with another `type` is **silently invisible**: not rendered in Detail's relationship chips, not filterable, not creatable from the UI. It doesn't break anything (arrays are filtered, not asserted-equal), but the data is present in the export and simply dropped on the floor. `bd link --type` / `bd dep add --type` cannot be reached from any UI action. |
| `conditional-blocks`, `waits-for` (docs-named types) | **Not covered** | Not created by any installed `dep add --type` value; produced only via `bd create --waits-for`/`--waits-for-gate` and molecule bonding (`--type conditional`) | Not applicable to bd-console today since these aren't general-purpose dep types on this version — see divergence table |
| **Graph visualization** (`bd graph`) | **Partial (reinvented, not wrapped)** | Console 2.0's `MapView.js` is a bespoke SVG DAG over `blocks` edges only, computed client-side in `derive.js:graphLayout` | Doesn't call `bd graph` at all (no `--dot`/`--html`/`--all` passthrough); ignores non-`blocks` edges entirely; edges are backwards per the bug above; no per-epic scoping (`bd graph <epic-id>`), no layer/DAG legend beyond critical chain |
| Ready work computation | **Partial (reimplemented, not delegated)** | `isReady()` in `store.js` reimplements "open + no open blockers" client-side from the full issue list | Never calls `bd ready`/`bd ready --json` server-side, so it can drift from bd's authoritative semantics (status categories, deferred/ephemeral exclusion, `--mol`/`--gated` scoping) — and currently *does* drift, per the bug above |
| Query language (`bd query`) | **Not covered** | FiltersPane is chip-based faceting over the already-loaded issue list; no free-form query string, no date-relative filters, no boolean AND/OR/NOT | Full feature absent: no UI or API route calls `bd query` |
| Search (`bd search`) | **Partial** | Omnibar/FiltersPane search is a client-side substring match over id/title/description | `bd search`'s server-side flags (`--desc-contains`, `--external-contains`, `--metadata-field`, date-range filters, `--sort`) all unused; scales poorly vs. large id sets client-side |
| Duplicate detection (`find-duplicates`, `duplicates`) | **Not covered** | No route, no UI | Entire feature (mechanical/AI similarity, exact-content grouping, `--auto-merge`) absent |
| `bd duplicate` / `bd supersede` | **Not covered** | No route, no UI | Both are one-shot, high-value, low-cost commands (see roadmap) |
| Epics — status/progress | **Partial** | Epic grouping (list view + Flow's `EpicRows`) computes closed/total client-side from children | Never calls `bd epic status`/`bd epic close-eligible`; no bulk "close eligible epics" action |
| Swarms | **Not covered** | No route, no UI | `bd swarm create/list/status/validate` entirely absent — no way to spin up or observe multi-agent epic coordination from the dashboard |
| **Gates** (`bd gate`) | **Not covered** | No route, no UI; JSONL export's gate-type issues (if any) would render as generic issues with no special glyph | Async coordination (human/timer/gh:run/gh:pr) invisible; no way to resolve or inspect a gate from the browser |
| **Molecules / formulas / wisps** (`bd mol`, `bd formula`, `bd cook`) | **Not covered** | No route, no UI | Entire workflow-template subsystem absent: no formula browser, no "spawn/pour a molecule" action, no wisp lifecycle (create/squash/burn/promote), no bonding, no distill. This is the owner's flagged "workflows/molecules" interest and is 100% greenfield. |
| `bd promote` (wisp → permanent) | **Not covered** | No route, no UI | Small, standalone, cheap to add |
| History / diff (`bd history`, `bd diff`) | **Not covered** | No route, no UI | No audit trail view per issue, no branch/commit comparison |
| Rename (`bd rename`) | **Not covered** | No route, no UI |  |
| Lint (`bd lint`) | **Not covered** | No route, no UI | Cheap, high-signal "which open issues are missing Acceptance Criteria" nudge |
| Stale issues (`bd stale`) | **Partial (reinvented)** | `isStale()` in `derive.js` reimplements ">21 days since update" client-side | Doesn't call `bd stale`, doesn't expose its `--days`/`--status` flags |
| Orphans (`bd orphans`) | **Not covered** | No route, no UI |  |
| Count/statistics (`bd count`, `bd status`) | **Partial (reinvented)** | `tally`/`pulse` computed client-side over the full issue array | Never calls `bd count --by-*` or `bd status`; fine at current scale, would not scale to very large trackers |
| Batch operations (`bd batch`) | **Not covered** | No route, no UI | Relevant for a future bulk-edit UI (multi-select + apply) |
| Assignee (`bd assign`) | **Covered** (via `create`'s `-a` and `update`'s `-a`, not a dedicated op) | `POST /api/create`'s `assignee` field only; no `runIssueEdit` op to *re*assign an existing issue outside creation | Add an `op:'set-assignee'` — trivial, currently a gap |
| Estimate / due date / spec-id / external-ref / metadata | **Not covered** | Not in `create`'s body allowlist or `runIssueEdit`'s op list | All are plain `bd update` flags; low cost to add |
| Custom types/statuses (`types.custom`, `status.custom`) | **Not covered** | `CREATE_TYPES` is a hardcoded 5-value list (`lib/routes.mjs:20`); `bd types`/`bd statuses` never queried | A project with custom types/statuses configured server-side cannot create or filter on them from the UI |
| Sync/Dolt internals (`branch`, `vc`, `bootstrap`, `dolt`, `migrate`, `compact`, `flatten`, `gc`) | **Not covered** (by design) | N/A | Correctly out of scope for a lightweight dashboard — see "not recommended" |
| Federation (`bd federation`) | **Not covered** | No route, no UI | Cross-repo/org sync; plausible fit for the hub's multi-project model, but nontrivial |
| Backup (`bd backup`) | **Not covered** | No route, no UI | Ops task, arguably belongs in `bd-console` CLI, not the web UI |
| Import/export (`bd import`, `bd export`) | **Partial** | `bd export` invoked automatically as the read-refresh path (`lib/bd.mjs:66-81`); `bd import` never called | Export is the entire read path already; import (e.g. restoring/merging a JSONL) has no UI |
| Docs viewer/editor | **Covered** (adjacent, not bd-native) | `GET/POST /api/docs`, `/api/doc` (`lib/routes.mjs:453-460,490-512`); `DocsView.js`/`Docs2.js` | This is a bd-console-original feature, not a beads capability — noted for completeness only |
| tmux delegate / scheduler / usage analytics | **Covered** (adjacent, not bd-native) | `lib/tmux.mjs`, `lib/schedule.mjs`, `lib/usage.mjs`/`usage-history.mjs` | Same as above — genuinely useful, but not part of the beads coverage question |

---

## Gap analysis, grouped by theme

### 1. Relationship model & graph-links (the owner's #1 flagged interest)

Today: 2 of 10 installed dependency types are understood
(`blocks`, `parent-child`), and the one that matters most for correctness
(`blocks`) is computed backwards (see above). `related`/`relates-to` — the
type the owner specifically called "really neat" from the docs — has **zero**
representation: it can't be created, seen, or filtered on anywhere in
bd-console, even though it's a first-class, bidirectional, non-blocking
"see also" edge that the CLI supports via both `bd dep relate` and `bd dep
add --type relates-to`.

`discovered-from` (provenance — "this idea came from investigating that
bug") and `tracks` (convoy tracking, per `bd dep list --type tracks`
example) are similarly invisible; both are exactly the kind of soft
knowledge-graph edges an AI-agent-driven workflow accumulates constantly
and currently has nowhere to go in the UI except free-text mentions in a
description.

`supersedes`/`superseded_by` and `duplicate_of` are backed by dedicated,
already-installed one-shot commands (`bd supersede --with`, `bd duplicate
--of`) that auto-close the source issue — cheap to wire (a new
`runIssueEdit` op each) and immediately useful for cleanup.

### 2. Subtask / parent-child depth

Parent-child is understood, but only one level: `childrenOf(id)` in
`store.js` does a flat scan for direct children and is used identically in
both views. A grandchild (`bd-x.1.1`) shows up as a "child of bd-x.1" only
if you separately select `bd-x.1` — there is no recursive descendant view,
no `bd children --pretty`-style tree, and no depth indicator. `bd list
--parent <id>` / `bd ready --parent <id>` (filter to a whole subtree) are
never surfaced, meaning "show me everything under this epic, however
deep" isn't a first-class filter today even though the CLI already supports
it in one flag.

### 3. Molecules / formulas / workflow templates (the owner's #2 flagged interest)

Completely absent end-to-end: no `GET /api/formulas` (`bd formula list
--json`), no molecule detail route (`bd mol show --json`), no "pour a
proto" action, no wisp lifecycle. This is the single largest coherent
feature gap in the product, and also the one with the richest potential
Console-2.0-native UX (a formula picker + variable form is a very natural
Omnibar/dialog pattern — see roadmap Phase 3).

### 4. Gates & swarms

Both are async/multi-agent coordination primitives with no representation.
Gates in particular are cheap to expose read-only (list + resolve button)
and materially useful for anyone running molecules or CI-gated workflows,
even before molecules themselves are wired up.

### 5. Query, search, duplicates, lint, stale, orphans, history — "quality of life" CLI commands

A cluster of small, independent, already-installed commands with no
backend route at all. None are architecturally interesting (they're all
`bd <cmd> --json` → render), but collectively they're a lot of the CLI's
day-to-day value for a solo dev triaging a large backlog, and every one of
them is a single new route + a few lines of UI.

### 6. Reimplemented-not-delegated logic

`isReady`, `isStale`, `tally`/`pulse`, and the hub's per-project stat
computation all reimplement server-side `bd` semantics client-side over the
full issue array rather than calling `bd ready`/`bd stale`/`bd count`. This
was presumably done for snappy client-side filtering without a round-trip,
which is a reasonable trade at small scale — but it means bd-console's
notion of "ready"/"stale"/"blocked" can silently diverge from bd's own (as
demonstrated above), and it won't scale to a very large tracker. Worth
periodically validating client math against `bd ready --json`/`bd count
--json` outputs, or offering a "verify against bd" debug mode.

---

## Phased roadmap

Ordered by (value to a solo dev directing AI agents) ÷ (implementation
cost). Each phase notes size (S = hours, M = a day or two, L = multi-day),
dependencies, risk, and which surface(s) it touches.

### Phase 0 — Fix the blocker-direction bug — **S, do first**

- **Delivers:** correct `blockersOf`/`blocksList`/`effStatus`/`isReady`
  everywhere they're consumed.
- **Touches:** `public/ui/store.js` (`blockersOf`, `blocksList`,
  `loadProjectStats`'s inline duplicate of the same logic); no backend
  change, no new route.
- **Size:** S — it's a ~10-line swap (see fix sketch above) plus verifying
  `derive.js`/`Detail.js`/`IssueDetail.js`/`MapView.js`/`Flow.js` all still
  read sensibly (they consume the exported functions, not the buggy
  internals, so no call-site changes needed).
- **Dependencies:** none.
- **Risk:** low technically, but *behaviorally* every "blocked" count in
  the product will visibly change the moment this ships — flag it to the
  owner as "the blocked/ready numbers you see after this update are the
  corrected ones," not a new bug.
- **View:** both (shared `store.js`).

### Phase 1 — Wire the missing link types into the existing relationship UI

- **Delivers:** `related`/`relates-to`, `discovered-from`, `tracks`,
  `supersedes`, `duplicate_of` become visible, filterable, and creatable —
  turning "silently dropped" into "first-class," using UI real estate that
  already exists (Detail's relationship-chip rows).
- **Touches:**
  - Backend: extend `runIssueEdit` with `op: 'relate'/'unrelate'` (→ `bd dep
    relate`/`bd dep unrelate`), `op: 'supersede'` (→ `bd supersede --with`),
    `op: 'mark-duplicate'` (→ `bd duplicate --of`); extend `add-blocker`'s
    sibling to accept an arbitrary `--type` instead of hardcoding `blocks`
    (`lib/bd.mjs`'s `runIssueEdit`, new validated type enum matching the
    installed CLI's 10 values).
  - Frontend: `store.js`'s relationship helpers gain a generic
    `dependenciesByType(issue, type)` alongside the existing
    `parentOf`/`blockersOf`; `IssueDetail.js`/`Detail.js` add a "Related"
    section (bidirectional, so render once regardless of which side created
    it) and a "Superseded by / Duplicate of" banner (parallel to the
    existing blocked/ready banner); `CreateIssueDialog.js`/edit tools get a
    type dropdown next to the existing blocker-id input.
- **Size:** M.
- **Dependencies:** Phase 0 (don't build new relationship UI on top of
  broken derivation helpers).
- **Risk:** low — additive, no existing behavior changes except the new
  banner potentially competing for space with the blocked/ready banner
  (decide precedence: closed-superseding-state probably outranks
  open/blocked).
- **View:** both, but Console 2.0's Detail is the nicer home for the new
  chip rows (more vertical space); mirror to classic view for parity.

### Phase 2 — Graph-links in MapView + filtering (owner's flagged interest)

- **Delivers:** MapView (`console2/MapView.js`) renders `related`/
  `discovered-from`/`tracks` edges as visually distinct (dashed/thin,
  non-arrowed since most are non-directional-in-spirit) alongside the
  existing `blocks` DAG; FiltersPane/Omnibar gain a "filter by link type"
  facet (e.g. "show only issues with an open `related` edge to X").
- **Touches:**
  - `console2/derive.js`'s `graphLayout()` — currently builds `inEdges`/
    `outEdges` from `openBlockersOf` only (blocks-only, and inherits the
    Phase-0 bug until fixed); needs a second edge collection per link type,
    each with its own render style, and must **not** feed non-blocking
    edges into the DAG layering pass (layering should stay blocks-only, or
    the "layer 0 = can start now" semantic breaks) — overlay them as
    non-layout-affecting curves instead.
  - `MapView.js` — new edge-class CSS + a legend entry per type; toggle
    checkboxes to show/hide each type (a fully-connected graph with 10 edge
    types rendered at once would be unreadable).
- **Size:** M–L (the layout-vs-overlay separation is the fiddly part).
- **Dependencies:** Phase 1 (need the data flowing before you can visualize
  it), Phase 0.
- **Risk:** medium — dependency-graph visualization complexity grows
  nonlinearly with edge-type count; ship blocks+related first, add the
  rest only if it stays legible.
- **View:** Console 2.0 only (classic view has no graph visualization to
  extend).

### Phase 3 — Molecules & formulas: read-only browser + "spawn from proto" (owner's flagged interest)

- **Delivers:** a formula/proto browser (`bd formula list`/`bd formula show`,
  `bd mol show`) and a guided "pour a molecule" action from Console 2.0's
  Omnibar (`> mol <formula-name>` → variable-substitution form → `bd mol
  pour <proto> --var k=v ...` → jump straight to the new molecule's Detail).
- **Touches:**
  - Backend: `GET /api/formulas` (`bd formula list --json`), `GET
    /api/formulas/:name` (`bd formula show <name> --json` — this is where
    variable names/defaults come from for the form), `GET
    /api/molecules/:id` (`bd mol show <id> --json`), `POST
    /api/molecules/pour` (validated `execFile('bd', ['mol','pour', proto,
    '--var', 'k=v', ...])`, id/label validation reused from
    `lib/bd.mjs`'s existing `ID_RE`).
  - Frontend: new Omnibar command (`mol`, arity 1, opens a dialog rather
    than running immediately — the only Omnibar command so far that isn't
    a one-shot); a `MoleculeView` (new component) showing step DAG +
    per-step ready/claimed/done state (`bd mol show --parallel`'s data is
    almost exactly Console 2.0's existing card format); a "current step"
    indicator using `bd mol current --for <agent>` for "what am I supposed
    to be doing right now" — genuinely high value for a solo dev directing
    multiple agent sessions via the existing tmux delegate feature.
- **Size:** L.
- **Dependencies:** none technically (molecules are independent of
  Phases 0–2), but sequencing it after the relationship-type work means
  the new Detail/relationship-chip components it'll reuse already exist.
- **Risk:** medium-high. Molecules are the most conceptually complex part
  of beads (formula → proto → pour/wisp → bond → squash/burn, plus
  conditional/waits-for semantics inside a molecule that don't map onto
  plain `blocks`). Scope the first cut to **pour + show + current** only —
  skip bond/distill/squash/wisp entirely in v1 (see "not recommended"
  below for wisps specifically).
- **View:** Console 2.0 — this is squarely mission-control territory; no
  classic-view equivalent needed.

### Phase 4 — Gates: read + resolve

- **Delivers:** a gates list (`bd gate list --json`) surfaced probably as a
  filter/badge on blocked issues ("blocked by gate: human · reason: …")
  plus a one-click "resolve" button (`bd gate resolve <id>`) for `human`-type
  gates specifically (the only type meant for manual resolution).
- **Touches:** `GET /api/gates` (`bd gate list --json`), `POST
  /api/gates/resolve` (`bd gate resolve <id> --reason`); Detail's
  blocked-banner gains a gate-aware variant when the blocker is
  `issue_type === 'gate'`.
- **Size:** S–M.
- **Dependencies:** none.
- **Risk:** low.
- **View:** both (it's a variant of the existing blocked banner).

### Phase 5 — Small, independent CLI-command wrappers (do opportunistically, any time)

Each of these is a standalone S-sized addition (one route, minimal UI) with
no dependency on anything else in this roadmap. Bundle a few per sprint:

| Command | Route | UI surface | Note |
|---|---|---|---|
| `bd query` | `GET /api/query?q=...` | An "advanced" toggle in FiltersPane that swaps chips for a query string input | Biggest quality-of-life win in this tier — the boolean/date-relative expression language is materially more powerful than chip faceting |
| `bd lint` | `GET /api/lint` | A small "N issues missing Acceptance Criteria" nudge, maybe in the health card | |
| `bd stale` | replace `derive.js`'s `isStale` with a call, or validate against it | none new — internal correctness | Low glamour, real correctness value |
| `bd find-duplicates` / `bd duplicates` | `GET /api/duplicates` | A "possible duplicates" panel, each pair with quick "mark duplicate" (wires to Phase 1's new op) | |
| `bd history` | `GET /api/history/:id` | A collapsible "History" section in Detail | |
| `bd count --by-*` | `GET /api/count` | Could replace some client-side `tally` computation for large trackers | |
| `bd promote` (wisp→permanent) | `POST /api/promote` | A button on any ephemeral-flagged issue | Trivial once ephemeral issues are visible at all (today they're excluded from the export path by default; needs `getIssues()`/export flag review) |
| `bd rename` | `POST /api/rename` | An "advanced" action in Detail's overflow menu | Low priority, rarely needed interactively |
| `bd orphans` | `GET /api/orphans` | A hub-level or project-level "N issues referenced in commits but still open" banner | Nice pairing with the existing git-insights feature (`lib/git.mjs`) |
| Missing `update` flags (`--due`, `--estimate`, `--external-ref`, `--spec-id`, `--metadata`, `assignee` re-set) | extend `runIssueEdit`'s op list | small additions to `EditTools`/`Edit` forms | |

**Size:** S each. **Dependencies:** none. **Risk:** low across the board —
this tier is "more `bd` commands wrapped," not new architecture.

### Phase 6 — Multi-level hierarchy + subtree filtering

- **Delivers:** a real descendant tree (not just one level) in both views;
  `--parent <id>` subtree filtering surfaced as a first-class filter
  (equivalent to `bd list --parent`/`bd ready --parent`).
- **Touches:** `store.js`'s `childrenOf` → recursive variant; a new
  collapsible tree renderer (classic view's existing epic-grouping list
  rows are the closest precedent — generalize that rendering to N levels
  instead of hardcoding epic→child); Console 2.0's `EpicRows` similarly.
- **Size:** M.
- **Dependencies:** Phase 0 (tree correctness depends on correct
  blocked-status coloring within it).
- **Risk:** low-medium — mostly a rendering/recursion problem, not a data
  problem (the JSONL already carries full parent chains via dotted ids).
- **View:** both.

### Phase 7 — Swarms & federation (speculative, low priority)

- **Delivers:** swarm status view (`bd swarm status --json`) for anyone
  running multi-agent epics; federation peer status for cross-repo setups.
- **Touches:** new routes, new views.
- **Size:** L for federation, M for swarm-status-only.
- **Dependencies:** Phase 3 (swarms are conceptually adjacent to
  molecules — a swarm *is* a molecule variant, `mol_type=swarm`).
- **Risk:** medium — genuinely useful only if the owner is actually running
  multi-agent swarms day to day; validate demand before building. Given
  the project's own usage pattern (solo dev + delegated tmux agent
  sessions, not a swarm coordinator), this is speculative — **do not build
  ahead of confirmed need.**

---

## Not recommended / poor fit for a web UI

Stated plainly, per the brief, rather than proposed and hedged:

- **`bd sql` (raw SQL against the Dolt database).** A web text field that
  shells out to arbitrary SQL is a real injection/safety surface no amount
  of `execFile`-array discipline fixes — the *argument itself* is
  attacker-controlled SQL. Do not expose this over HTTP under any
  token-gating scheme. If ad-hoc queries are needed, `bd query`'s
  constrained expression language (Phase 5) is the right power level for a
  browser.
- **`bd dolt`, `bd bootstrap`, `bd migrate`, `bd compact`, `bd flatten`,
  `bd gc`, `bd doctor`, `bd worktree`, `bd rules`, `bd admin`.** These are
  local database-maintenance and installation-health commands meant to be
  run once, interactively, by a human sitting at the machine, often with
  destructive potential (compaction, GC, migration). A web button that
  fires `bd gc` or `bd migrate` against a live Dolt database is exactly the
  kind of action that should require a terminal and full attention, not a
  click from a browser tab that might be a stale cached page. Keep these
  CLI-only.
- **`bd backup` (init/sync/restore).** Backup/restore is an infra concern
  with real "did this actually work" stakes; a misfire (restoring the wrong
  snapshot over a live DB) is not something to gate behind a web token.
  Better done from `bd-console`'s own CLI wrapper or a cron job, not the
  dashboard.
- **`bd federation` peer credential management** (as opposed to *read-only*
  federation status, which is fine per Phase 7). Adding/removing peers can
  carry SQL credentials (`--sql-*` flags implied by "optional SQL
  credentials" in the command's own description) — don't build a form that
  collects and forwards database credentials through the dashboard's write
  path.
- **`bd batch`'s raw grammar as a literal textarea.** The command's own
  help text says it plainly: "this is a narrow subset... not accepted" for
  most operations, and it's designed for shell-script consumption
  (`awk`/`printf` piping), not interactive use. A bulk-edit UI (Phase-5-and
  -beyond material) should synthesize the batch script from structured
  multi-select + a small set of UI-offered bulk actions, never expose the
  batch mini-language as free text to type into a browser.
- **`bd mol wisp`/`bd mol squash`/`bd mol burn` as a first cut.** Wisps are
  explicitly the ephemeral, non-git-synced, "operational loop" half of the
  molecule system (heartbeats, health checks, release automation) — they
  are *designed* to be invisible/short-lived and are excluded from the
  JSONL export path bd-console reads from. Building UI for them means
  either (a) adding a whole parallel read path just for wisp visibility, or
  (b) building UI for data the dashboard structurally can't see yet. Ship
  `pour`/persistent molecules first (Phase 3); revisit wisps only if a
  concrete operational-workflow use case shows up.
- **`bd upgrade` / self-update of the `bd` binary from the web UI.**
  Updating the CLI binary the server itself shells out to, from inside a
  request handler, is asking for a mid-request version mismatch or a
  broken daemon. Binary upgrades belong in `bd-console`'s own update
  tooling (`lib/update.mjs` already exists for *bd-console's* self-update —
  don't extend that pattern to `bd` itself).
- **Interactive terminal-form commands** (`bd create-form`,
  `create-form`'s keyboard-navigation TUI). These are Cobra/terminal UX
  patterns with no web equivalent worth building — `CreateIssueDialog.js`
  already *is* the web-native version of the same idea; don't try to
  literally port the TUI.

---

## Appendix: what "adjacent, not bd-native" features already cover

For completeness, these bd-console features are real and valuable but are
not part of the beads-capability question this audit was scoped to — noted
so the roadmap above isn't read as ignoring them:

- Docs viewer/editor (`lib/docs.mjs`, `DocsView.js`/`Docs2.js`) — a
  bd-console-original feature over arbitrary project docRoots, not a `bd`
  command.
- tmux session listing/preview/delegate (`lib/tmux.mjs`) and the prompt
  scheduler (`lib/schedule.mjs`) — orchestration conveniences layered on
  top of, not part of, beads itself.
- Claude Code / Codex usage analytics (`lib/usage.mjs`,
  `lib/usage-history.mjs`) — reads provider OAuth/session files, entirely
  unrelated to the `bd` binary.
