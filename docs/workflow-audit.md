# Workflow audit — what a non-developer can actually finish in the UI

> **Status update (2026-08-17, bd-console-974.8).** Re-checked every item in
> the "Prioritized fix these first" list below against the current tree
> before writing this. **Shipped since this audit was written:**
> #1 the deferred-issue Flow-lane bug (`console2/derive.js` now buckets
> `s === 'deferred'` explicitly, :37/53/65); #2 `set-assignee`
> (`lib/bd.mjs`'s `set-assignee` op, `console2/actions.js`'s
> `actSetAssignee`); #3 retry/requeue for a failed scheduled prompt
> (`lib/schedule.mjs`'s `retryJob`, `POST /api/schedule/retry`,
> `ScheduleView.js`'s Requeue button); #4 a "+ New document" entry point
> (`console2/Docs2.js`, wired through `public/ui/docCreate.js`); #5
> `bd mol distill` wired to a "Save as reusable template…" button on any
> container (`console2/Detail.js`'s `TemplateBox`); and the registration
> half of #8 — a non-terminal path to register a project now exists
> (`POST /api/register`, `HubView.js`'s "Register a project" flow) —
> **though it shipped token-gated via the existing `authed()` check, not
> localhost-gated as this doc specifically proposed**; same non-terminal
> outcome reached by a different trust boundary. Separately, `bd gate`
> read-only surfacing (#7's first half) shipped **today**, in the same
> session as this note: `GET /api/p/<id>/gates`, a gate-aware "blocked by
> gate: human — …" banner, and a Resolve button for `human`-type gates. A
> real formula-authoring UI (#7's second half) also shipped
> (`console2/FormulaAuthor.js`, wired into `Console2.js`).
>
> **Checked and still open, contrary to an earlier draft of this note:**
> #6's "no-delete" copy near the Retire row was never added —
> `console2/Detail.js`'s `c2-edit-note` still only explains supersede/
> duplicate mechanics ("state transitions, not links: bd closes … immediately"),
> never states there's no delete or points at `bd delete` on the CLI. The
> companion half of #6 (an exact, copy-pasteable `bd-console add <cwd>` in
> the hub's empty state) is also still generic (`bd-console add
> /path/to/project`) — lower-stakes now that the #8 registration UI exists
> as the primary path, but the literal fix was never made.
>
> See `docs/beads-coverage.md`'s matching preamble for the blocker-direction
> bug this doc already flagged as fixed (§ Method, one correction, above).

Triggered by a real dead end: molecules require formulas, and nothing in the
UI can create a formula (`public/ui/console2/MoleculeDialog.js:93-95` tells
you so directly — "If you have already built an epic by hand that you would
do again, `bd mol distill` turns it into one," which is a CLI command). This
audit asks the same question of every other workflow the product advertises:
**can a non-developer complete it entirely in the UI, without dropping to a
terminal?**

## Method

Started from `docs/feature-map.md` §6 (ten workflows) and
`docs/beads-coverage.md`, then verified every claim against the current code
— `lib/routes.mjs` (routes), `lib/bd.mjs` (`runIssueEdit`'s real op
vocabulary), and every component under `public/ui/components/` and
`public/ui/console2/`. Where the write surface's actual runtime behavior was
in question (not just "is there a button"), I ran the real `bd` binary
(v1.1.0) against a disposable fixture at
`/tmp/claude-1000/.../scratchpad/audit-fixture` — no writes touched the live
daemon on 4180 or any real project. No application code was changed; this
file is the only one written.

One correction to `docs/beads-coverage.md` up front: its headline finding,
the "blocker-direction bug" in `blockersOf()`/`blocksList()`, is **already
fixed** in the current tree. `public/ui/relationships.js:90-95` has the
direct one-liner (`BLOCKING_DEP_TYPES.has(d.type)` over the issue's own
`dependencies`), and `store.js:223-225`'s `blocksList()` does the reverse
scan — exactly the fix the coverage doc prescribed. That doc was apparently
written against the commit the fix itself became (`20f1a44`, HEAD). Workflow
4 below is Complete, not Partial.

## Classification legend

- **Complete** — fully doable in the UI, no caveats worth flagging.
- **Partial** — doable, but with a missing step, an invisible entry point, or
  a real correctness gap once you're in it.
- **Dead end** — the UI actively points at a capability it cannot provide.
- **CLI-only by design** — deliberately not in the UI; verdict says whether
  that's still defensible.

---

## The ten documented workflows (`docs/feature-map.md` §6)

| # | Workflow | Class | Evidence | What's missing / proposed fix |
|---|---|---|---|---|
| 1 | Capture a thought | **Complete** | `Omnibar.js:146-154` (plain text → `POST /api/quick`); `i` shortcut → `CreateIssueDialog` | — |
| 2 | File a full issue with an epic | **Complete** | `CreateIssueDialog.js` full form + inline "+ new epic" (`:183-204`); `POST /api/create` (`routes.mjs:637-691`) | — |
| 3 | Link two issues (any of 10 types) | **Complete** | `lib/bd.mjs:479-496` (`add-link`/`remove-link`, arbitrary `--type` from the validated 10-value enum); wired in both `IssueDetail.js:109-121` and `Detail.js:151-166,181-185` | — |
| 4 | See what's blocking what | **Complete** (verified fixed — see above) | `public/ui/relationships.js:90-95`, `store.js:223-225` | — |
| 5 | Delegate an issue to a tmux session | **Complete**, one real edge case | `Detail.js:338-391` (`Delegate`) — deliberately no default session (anti-footgun, comment at `:352-361`); handles "tmux unavailable" and "no sessions" | If the *chosen* session dies between selecting it and hitting Send, `sendPrompt` will simply fail — `actions.js`'s `delegateNow` surfaces that as a generic toast, not "that session just vanished." S fix: check `SESSION_NAME_RE`-matched session is still in `store.tmuxSessions` right before sending and give a specific error. Low priority — same failure mode the scheduler already handles better (see #6). |
| 6 | Schedule a prompt for later | **Complete**, one real gap | `ScheduleView.js` — create (`CreateForm`), list (`JobRow`), cancel (`:328-331`) all present; a job whose session isn't running when it fires ends up `failed` with a visible error (`lib/schedule.mjs:148`) | **No recover-from-failed action.** `lib/schedule.mjs` only exports `createJob`/`listJobs`/`cancelJob` — there is no retry/requeue. A failed job's `JobRow` (`ScheduleView.js:287-309`) shows the error but the only action ever rendered is Cancel, and only while `status==='pending'`. Recovering means manually re-filling the form (Saved Prompts softens this if you saved the prompt first). **Fix, S:** a "Retry" button on `failed` rows that pre-fills `CreateForm` with the same prompt/session and a fresh run-at, same pattern as the existing session-preset handoff. |
| 7 | Pour a molecule from a formula | **Dead end** (by design, but worth restating plainly) | `MoleculeDialog.js:92-95`'s own empty state: *"This project has no formulas, so there is nothing to pour... `bd mol distill` turns it into one."* `lib/bd.mjs` has zero write path for formula *authoring* — only `listFormulas`/`showFormula`/`previewFormula`/`pourMolecule`/`burnMolecule`. | This is the reported dead end. Formulas are hand-authored `.formula.json` files; there is no `POST /api/formulas` create/edit route and no editor UI. **Fix, L:** a formula author view (JSON-schema-aware form or raw-JSON editor with `bd cook --json` live validation reusing the existing preview plumbing) — sized L because it needs its own validation UX, not just a route. **Cheaper interim, M:** since `bd mol distill <epic-id>` can reverse-engineer a formula from an existing epic, wire *that* single command into the UI (a "Save as formula…" button on any epic) before building a from-scratch author — it turns the dead end into "build it by hand once, then save it," which matches how the CLI docs themselves recommend starting. |
| 8 | Edit a doc and promote a selection to an issue | **Partial** | `Docs2.js` (Console 2.0): edit-existing (`Editor`, `:100-126`) and promote (`Reader`, `:65-98`) both work end-to-end. `DocsView.js` (classic view): **read-only**, no editor at all — confirmed, the component has no save path, only `DocContent()`'s render. | See dedicated finding below — **creating a new doc has no UI entry point in either view**, even though the backend allows it. |
| 9 | Check your usage/limits | **Complete** | `HubView.js` Usage section — live quota + attribution bands, both described accurately in the docs | — |
| 10 | Update beads (the `bd` CLI) | **Complete** | `SettingsView.js`'s `BdVersionPanel` (`:46-122`) — copy-command, multi-binary warning, recheck | — |

---

## Additional workflows probed (per the brief's specific suspicions)

| Workflow | Class | Evidence | What's missing / proposed fix |
|---|---|---|---|
| **Create a new doc** | **Partial — invisible entry point** | `lib/docs.mjs`'s `resolveDocPath()` (`:56-65`) validates path safety and the `.md` extension only — it does **not** check the file already exists. `routes.mjs`'s `POST /api/doc` (`:587-609`) will happily `writeFile` a brand-new path as long as its parent directory exists. But every UI path to `saveDoc()` starts from `store.selectedDocPath`, which is only ever set by `openDoc()` clicking an *existing* tree entry (`Docs2.js`'s `Tree()`, `:13-35`; `DocsView.js`'s `DocTree()`, same pattern). There is no "New doc" button, no free-text path field, anywhere. | The backend capability exists and is safe (same path-traversal guards as edit); the UI simply never offers it. **Fix, S:** a "+ New" affordance in `Docs2.js`'s doc-tree bar that prompts for a relative path (validated client-side against the same `.md`-only, no-traversal rule) and opens the editor pre-seeded with empty content in unsaved (`docDirty`) state. |
| **Delete an issue** (`bd delete`) | **Not exposed — looks deliberate, but never stated** | Exhaustive check of `lib/bd.mjs`'s `runIssueEdit` op list (`claim`, `set-status`, `set-priority`, `add-label`/`remove-label`, `set-parent`, `add-link`/`remove-link`/`add-blocker`/`remove-blocker`, `supersede`/`mark-duplicate`, `set-defer`) — no `delete`. No route in `routes.mjs`. No button anywhere in `IssueDetail.js`/`Detail.js`. | The retire-via-supersede/duplicate pattern (`Edit`'s "Retire" row) is very likely the intended substitute — bd-console gives you a soft, git-preserving way to retire an issue instead of a hard delete, which is a defensible product choice given every write here syncs to a shared Dolt remote. **The gap isn't the missing delete button — it's that this is never stated anywhere.** A user who created a test/junk issue has no visible way to remove it and no explanation of why, and might reach for `bd delete` on the CLI not realizing the UI's answer is "close it, or supersede/duplicate it, on purpose." **Fix, S:** one line of copy near the Retire row: "There's no delete — closing (or superseding/marking duplicate) keeps history intact. Use `bd delete` on the CLI if you really need to remove a bead." |
| **Gates** (`bd gate`) | **Confirmed: zero UI, zero backend route** | Grepped every real (non-`delegate`/`aggregate`/`navigate`-substring) occurrence of "gate" across `public/ui/**` and `lib/routes.mjs` — none. `docs/beads-coverage.md`'s claim stands. Nothing in the UI implies gates work — there's no gate-aware banner, no gate glyph, no mention. A blocked-by-gate issue would render as a perfectly ordinary blocked issue (generic "⛔ Blocked by N open issues" banner), silently missing the "waiting on a human/timer/CI run" context that's actually true. | Not misleading (nothing claims gates work), but silently incomplete for anyone whose blockers include gate beads. **Fix, S–M:** read-only first — `GET /api/gates` (`bd gate list --json`) plus a gate-aware variant of the blocked banner ("blocked by gate: human — waiting on your resolution") and a resolve button for `human`-type gates specifically. Matches `docs/beads-coverage.md`'s own Phase 4 sizing. |
| **Reassign / clear an assignee after creation** | **Partial → functionally a dead end today** | `CreateIssueDialog.js:226-228` sets assignee only at creation. `runIssueEdit`'s op list (above) has **no `set-assignee` op at all** — this isn't a UI gap layered on a working API, the backend write path genuinely does not exist. `IssueDetail.js:250` and `Detail.js:517` both render `issue.assignee` as **plain text**, no edit control. | A mis-assigned or now-stale assignee can never be changed or cleared from the UI, ever, for the life of the issue (short of editing the underlying bd data via CLI). Given this app's stated audience (a solo dev directing multiple AI agent sessions across tmux, per the Delegate feature's own framing), assignee is exactly the field that goes stale the moment a different session picks up an issue. **Fix, S:** `lib/bd.mjs` — add `op: 'set-assignee'` → `bd update <id> -a <value>` (mirrors `set-priority`'s pattern exactly, `ASSIGNEE_RE` already exists in `routes.mjs:24` for create-time validation and can be reused verbatim); `IssueDetail.js`/`Detail.js` — one more `edit-block`/`c2-edit-row`, same shape as Priority. |
| **Register a project with the hub** (`bd-console add`) | **CLI-only by design — defensible, but it's the very first wall a brand-new user hits** | `HubView.js:569-570`'s own empty state: *"No projects registered. Run `bd-console add` inside a project to register it."* Confirmed CLI-only in `README.md` (`bd-console add <path>`) and `scripts/init.mjs`'s guided wizard (also a terminal tool, `bd-console-init`). No `POST /api/projects` route exists in `routes.mjs` (only `GET`). | For the hub/daemon architecture this product ships (one server, filesystem paths, potentially remote via Cloudflare/Pangolin per `routes.mjs`'s cache-control comments), a web form that accepts an arbitrary server-side filesystem path is a legitimately bigger attack surface than editing a markdown file whose path is already constrained to a doc root — so CLI-only isn't unreasonable to *keep* as the primary path. But it means **the UI's own empty state tells a non-developer to open a terminal before anything else in this product works**, which directly undercuts a "no-terminal" pitch. **Fix, M (worth doing for the localhost/single-user case specifically):** a token-gated `POST /api/projects` that only accepts paths already reachable from the *same host* the daemon runs on (`isLocalOnlyHost` already exists in `routes.mjs:137-139` for exactly this kind of trust boundary) — i.e., safe when hub and browser are the same machine, which the docs describe as the primary deployment. Reject or hard-warn when the daemon isn't localhost-bound. |
| **Onboarding from zero** (brand-new repo, no `.beads/`) | **First thing that fails: no readable error path from the browser** | `scripts/init.mjs` and `bd-console add` (README `:458-460`) both require a terminal and both pre-suppose `bd init` has already run. If a user reaches the hub before any project is registered, the empty state above is the *only* signal — there is no in-UI explanation of what `.beads/` is, what `bd init` does, or a copy-pasteable command with the current path filled in. | Consistent with the CLI-only registration finding above — same fix track. **Fix, S, independent of the M-sized form above:** even without adding a write path, the empty state could show the exact command with the daemon's own detected `cwd`/host filled in (`bd-console add $(pwd)`), and link to the one paragraph of README that explains `.beads/` — cheap, and it turns "run some command" into "run this exact copy-pasteable line." |

---

## New finding: deferred issues render as Ready in Console 2.0's primary Flow view

Not previously documented in `docs/feature-map.md` or `docs/beads-coverage.md`
— found by exercising the defer workflow against a live `bd` v1.1.0 binary in
a disposable fixture, not by reading code alone.

**What I verified, mechanically, no live daemon involved:**

```
$ bd update <id> --defer '+2d'
✓ Updated issue: ...
$ bd show <id> --json
{ "status": "deferred", "defer_until": "2026-07-28T20:32:20Z", ... }   # bd's OWN status becomes "deferred", not "open"
$ bd export -o .beads/issues.jsonl   # the exact read path bd-console uses
# confirms the same: "status": "deferred" in the exported JSONL
```

bd v1.1.0's `--defer` doesn't just set a metadata field on an otherwise-open
issue — it flips the issue's actual `status` to the literal value
`"deferred"`, a status bd-console's Console 2.0 Flow view never accounts for:

```js
// public/ui/console2/derive.js:32-47 (lanes computed)
for (const i of issues) {
  const s = effStatus(i);
  if (s === 'closed') { ...; continue; }
  if (s === 'in_progress') { progress.push(i); continue; }
  if (s === 'blocked') { blocked.push(i); continue; }
  // open + unblocked  <-- 'deferred' falls through to here, unconditionally
  if (hasLabel(i, 'triage')) triage.push(i);
  else ready.push(i);
}
```

A deferred issue matches none of the three explicit branches, so it falls
into the same bucket as genuinely open, unblocked, pickable work — landing in
the **Ready** swim lane (or **Triage** if labeled `triage`) of the primary
Console 2.0 canvas, fully claim/start-able from its card
(`Flow.js:84-85`'s claim/start buttons only check `issue.status !==
'in_progress'`, which a deferred issue satisfies).

This directly contradicts the one thing deferring an issue is *for*.
Worse, it's internally inconsistent within the same screen: `pulse`'s Ready
count (`derive.js:62`, via `isPickup`/`isReady`, both of which check
`issue.status === 'open'` exactly) correctly **excludes** the deferred issue
— so the Pulse tile's "Ready: N" number and the number of cards actually
sitting in the Ready lane will visibly disagree the moment any issue is
deferred. The only tell in the lane itself is the status glyph
(`glyphStatus()` in `console2/ui.js:51-56` does correctly resolve to the
"deferred" ◔ glyph, since `effStatus()` passes bd's `"deferred"` status
straight through) — a small shape difference on an otherwise identically-
placed, identically-actionable card.

Classic view is **not** affected the same way: it has no swim lanes, and its
`isReady()`/`readyOnly` toggle (`store.js:217-219`) use the same exact-match
`status === 'open'` check the Pulse tile uses, so a deferred issue correctly
drops out of "Ready only" filtering there. It does, however, lose the
Status-filter chip for "deferred" specifically —
`FiltersPane.js`'s `STATUS_ORDER = ['in_progress', 'blocked', 'open',
'closed']` (`:7`) doesn't include it, and `Chips()`'s `order` param filters
the facet map down to only listed keys (`:13`) — so even though
`facets.value.status` counts deferred issues correctly, no chip ever appears
to filter by them.

A second, smaller, related bug: the "Defer until" edit field's pre-fill reads
the wrong property name in **three** places —
`IssueDetail.js:35`, `Detail.js:109`, and `console2/ui.js:54` all read
`issue.deferred_until`, but bd's real field (confirmed via `bd show --json`
and `bd export`) is `defer_until`. The `ui.js:54` occurrence is currently
dead code (harmless — `glyphStatus()` already returns at `:53` for any
non-`'open'` status before reaching the `deferred_until` check), but the
other two mean the Defer input in Edit tools **always renders blank**, even
when opening an already-deferred issue — you can clear it, but you can't see
what it's currently set to without leaving the app.

**Fix, S, do this one first:**
1. `console2/derive.js:32-47` — add an explicit `if (s === 'deferred') { deferred.push(i); continue; }` bucket (a real "Deferred" lane, or fold into an existing one deliberately rather than by omission) before the open/unblocked fallthrough.
2. `IssueDetail.js:35`, `Detail.js:109` — read `issue.defer_until`, not `issue.deferred_until`.
3. `FiltersPane.js:7` — add `'deferred'` to `STATUS_ORDER` so the facet chip appears.
4. (Cleanup) `console2/ui.js:54` — same field-name fix, currently inert but should still be correct in case `effStatus()`'s pass-through logic ever changes.

---

## Prioritized "fix these first" list

1. **S — Deferred-issue Flow-lane bug** (above). Silent, reproducible, undermines the one thing the defer feature exists to do, and it's in the primary (Console 2.0) view every new project lands on.
2. **S — `set-assignee` op.** One `runIssueEdit` case, reusing existing regex/validation; closes a real "can never fix this once created" hole in the app's own solo-dev-plus-agents use case.
3. **S — Retry a failed scheduled prompt.** Small UI addition on an existing row; removes a needless full re-fill for a failure mode the scheduler already surfaces cleanly.
4. **S — "+ New doc" entry point in Docs2.js.** Backend already supports it safely; this is purely a missing button plus a path-format hint.
5. **M — `bd mol distill` wired to a "Save as formula…" action on any epic.** Doesn't solve full formula authoring, but converts today's flat dead end into a real (if one-directional) path from "I built this by hand" to "I can pour it again" — closer to how the CLI's own docs suggest formulas get made in practice.
6. **S — State the no-delete design decision out loud** near the Retire row, and **S — fill in the exact `bd-console add` command** in the hub's empty state. Both are copy-only fixes that remove real first-session confusion for close to zero engineering cost.
7. **M–L — `bd gate` read-only surfacing**, then **L — a real formula-authoring UI**, in that order — both large, both already scoped in `docs/beads-coverage.md`'s Phase 3/4, neither changed by anything found here.
8. **M — Localhost-gated `POST /api/projects`** for the single-machine deployment case, so a brand-new non-developer user isn't required to open a terminal before the product does anything at all.

## Where things are already fine (said briefly, per the brief)

Capture, full-issue creation with inline epic authoring, all 10 link types
(create/view/remove), the blocking-dependency direction (verified fixed),
tmux delegate, prompt scheduling (create/list/cancel), usage/limits
reporting, and the bd-version/update surface are all genuinely complete,
end-to-end, no terminal required. Molecule *pouring* (as opposed to
authoring) is also complete and honestly caveated in its own UI copy about
what it can't do (dry-run text opacity, burn's real blast radius) — that
honesty is worth preserving as the formula-authoring gap gets closed, not
papered over.
