# Molecules & Formulas in bd-console — design spec

Status: design only, no code written. Target: `bd` v1.1.0 (installed on this
machine — `bd --version` → `bd version 1.1.0 (8e4e59d39)`). Every claim below
is either a CLI transcript captured in a throwaway fixture repo
(`bd init` under `/tmp`, never a real project), a `--help` quote, or a
file:line reference into this repo. Where the docs site
(`beads.gascity.com/workflows/{molecules,formulas,wisps}`) and the installed
binary disagree, both are shown.

This document assumes the reader has read
[`docs/beads-coverage.md`](./beads-coverage.md), especially its "Molecules /
formulas / workflow templates" section and the CLI-vs-docs divergence table —
it isn't repeated here except where this spec adds or corrects it.

---

## 1. Conceptual model, stated plainly

Five nouns, one verb-per-transition:

| Noun | What it is | Where it lives |
|---|---|---|
| **Formula** | A `.formula.json` (or `.toml`) file: variables + a step DAG + composition rules. Not a bead. Not in the issue database at all. | Disk, under a formula search path (below) |
| **Proto** | An *uninstantiated template* — either a formula that's been "cooked," or (rare) a persisted proto bead in the DB with the `template` label | Ephemeral in memory (the common path) or a labeled bead (legacy `--persist` path) |
| **Molecule** (a.k.a. "mol") | A **persistent** epic-like bead created by pouring a proto — its root bead has `issue_type: "molecule"` (not `"epic"` — see §3), its steps are ordinary beads linked by `parent-child` (root→step) and `blocks` (step→step, per `needs`) | Normal issues table, synced via git like any other bead |
| **Wisp** | An **ephemeral** molecule — same shape as a molecule, but every bead in it has `Ephemeral=true`, lives in a separate storage path, and is excluded from git sync | Local Dolt store, `dolt_ignore`d |
| **Compound** | The result of `bd mol bond`ing two protos/molecules together — either a bigger proto (proto+proto) or a bigger, joined molecule (mol+mol / proto+mol) | Same storage as whichever operand it produced |

Commands and what they *actually* do on this installed version:

- **`bd cook <formula>`** — resolves a formula file, optionally substitutes
  `--var k=v` (runtime mode) or leaves `{{placeholders}}` intact (default,
  compile mode), and prints the resolved JSON to stdout. With `--persist` it
  additionally writes a proto bead (labeled `template`) into the DB — this is
  explicitly called out as "legacy behavior" in `bd cook --help`; the
  recommended path is to let `pour`/`wisp` cook formulas inline and never
  persist a proto bead at all.
- **`bd mol pour <proto> --var k=v`** — the "solid → liquid" transition.
  Creates the *permanent* molecule: one root bead (`issue_type: molecule`)
  plus one bead per formula step, wired with `parent-child` (root→step) and
  `blocks` (step→step, derived from each step's `needs`). Confirmed real
  transcript (fixture repo, formula `mol-feature` with steps
  design→implement→test→review):
  ```
  $ bd mol pour mol-feature --var name=auth --var owner=alice --json
  {
    "attached": 0, "created": 5,
    "id_mapping": {
      "mol-feature": "mf-mol-pt6",
      "mol-feature.design": "mf-mol-756",
      "mol-feature.implement": "mf-mol-gpo",
      "mol-feature.test": "mf-mol-7q0",
      "mol-feature.review": "mf-mol-dig"
    },
    "new_epic_id": "mf-mol-pt6", "phase": "liquid", "schema_version": 1
  }
  ```
- **`bd mol wisp <proto> --var k=v`** — identical mechanics to `pour`, but
  every created bead gets `Ephemeral=true` and the phase reported is
  `"vapor"`. Confirmed: `bd mol wisp mol-feature --var name=beta --json` →
  `{"created":5,"phase":"vapor",...}`, and critically, **the resulting beads
  do not appear in `bd export`'s output** (verified: exported the fixture
  before and after wisp creation, issue count unchanged at 5; a subsequent
  `bd list --json` *does* show wisps mixed in with normal issues, but
  `bd export` does not). This is the mechanism behind the coverage doc's
  claim that wisps are excluded from the JSONL path bd-console reads.
- **`bd mol bond A B [--type sequential|parallel|conditional] [--pour|--ephemeral] [--ref tpl --var k=v] [--as title]`**
  — polymorphic per the help text's own table (formula+formula, formula+proto,
  formula+mol, proto+proto, proto+mol, mol+proto, mol+mol). Confirmed proto+proto
  dry-run:
  ```
  $ bd mol bond mol-feature mol-feature --as compound-test --dry-run --json
  Dry run: bond mol-feature + mol-feature
    A: mol-feature (formula → will cook as proto)
    B: mol-feature (formula → will cook as proto)
    Bond type: sequential
    Result: compound proto
    Custom title: compound-test
    Note: Cooked formulas are ephemeral and deleted after bonding.
  ```
  `--ref arm-{{worker_name}}` (the "Christmas Ornament" pattern) gives dynamic
  children readable ids like `bd-patrol.arm-ace` instead of random suffixes —
  useful for per-worker/per-item fan-out, not exercised live here but
  documented at length in `bd mol bond --help`.
  **See §8 for a reproducible resolution bug found while testing this
  command.**
- **`bd mol squash <mol-id> [--summary] [--keep-children]`** — finds the
  molecule's *ephemeral* children specifically (`Ephemeral=true`), rolls them
  into one permanent digest bead, and by default deletes the wisp children
  (or demotes them to persistent with `--keep-children`). On a molecule with
  zero ephemeral children (e.g. a plain `pour`ed molecule), it's a safe no-op:
  `{"deleted_count":0,"digest_id":"","squashed_count":0,...}` — confirmed.
- **`bd mol burn <mol-id...> [--force]`** — unconditional cascade delete, no
  digest. Confirmed dry-run output distinguishes phase:
  `"Note: Persistent mol - deletions sync to remotes."` for a `pour`ed
  molecule vs. (per `--help`) a direct local delete for a wisp. A real burn
  (`bd mol burn mf-wisp-7lm --force --json`) returned
  `{"deleted_count":4,"deleted_ids":[...]}`.
- **`bd mol distill <epic-id> [formula-name] --var concrete=placeholder`** —
  the reverse of pour: walks an existing epic's children and their `blocks`
  edges, writes a new `.formula.json` with concrete values swapped for
  `{{placeholders}}`. Confirmed real run against a poured molecule:
  ```
  $ bd mol distill mf-mol-pt6 distilled-feature --var auth=name --json
  {"formula_name":"distilled-feature","steps":4,"variables":["name"],
   "formula_path":".../.beads/formulas/distilled-feature.formula.json"}
  ```
  Output file had `{{name}}` substituted back into step titles
  ("Design {{name}}" etc.) — confirmed by re-`cook`ing it.
- **`bd promote <wisp-id> [--reason]`** — copies one wisp bead from the
  ephemeral store into the permanent issues table, same id preserved.
  Confirmed: before promotion the wisp is absent from `bd export`; immediately
  after, `bd export` includes it (`issue_type: "task"`, dependency to its
  former wisp-molecule parent retained even after that parent is later
  burned — see §8, "dangling parent after promote+burn").

**Docs-site vs. installed-CLI divergences found (beyond what
`beads-coverage.md` already lists):**

| Topic | Docs (`/workflows/molecules`, `/workflows/formulas`) | Installed CLI (v1.1.0) | Verdict |
|---|---|---|---|
| Formula file schema | Only shows fragment TOML examples (`[[steps]]`, `[[compose.bond_points]]`); no full schema | Full JSON schema is: `formula` (name), `description`, `version`, `type` (`workflow`\|`expansion`\|`aspect`), `vars` (map of `{description, required, default, pattern, enum}`), `steps` (array of `{id, title, type, needs[], gate?, description?}`) — reverse-engineered from `bd formula show --json` and a working fixture (below) | Build the variable-discovery and step-preview UI against the JSON shape captured here, not the docs' partial TOML fragments |
| `bd mol pour --dry-run --json` | Not discussed | **`--json` is silently ignored when `--dry-run` succeeds** — output is always the human-readable "Dry run: would pour N issues..." text block, never JSON, regardless of `--json`. Same for `bd mol distill --dry-run --json` and `bd mol burn --dry-run --json`. `bd mol squash --dry-run --json` is the one exception — it *does* return real JSON. | **Critical for API design (§4/§6): dry-run preview cannot be parsed as JSON for pour/distill/burn.** bd-console's route must treat the whole stdout block as opaque preview text (or parse the plain-text list format) rather than expecting structured JSON from a dry run. |
| Root molecule bead's `issue_type` | Not stated explicitly (docs talk about "epics with execution intent") | The poured/wisped root bead's `issue_type` is literally **`"molecule"`**, not `"epic"` — confirmed in `bd mol show`, `bd show`, and the JSONL export. | This is *good news* for detection (§3) but is a breaking assumption for existing UI: bd-console's epic-grouping logic checks `issue_type === 'epic'` exclusively (`public/ui/store.js:195`, `public/ui/console2/Flow.js:92`, `public/ui/console2/derive.js:24,44,48`) — a poured molecule today renders as a bare ungrouped row, its steps un-nested, in both views. |
| `bd mol bond <formula-name> <formula-name>` | Advertised as "formula + formula → cook both, compound proto" | **Unreliable on this install** — see §8. Some formula names resolve (one that happened to have also been `cook --persist`ed earlier in the session), most don't ("`'X' not found (not an issue ID or formula name)`") even though `bd formula list`, `bd formula show`, `bd cook`, and `bd mol seed` all successfully resolve the exact same name. | Flagged as an open risk, not silently worked around — see §8. |

**Fixture formula used for all transcripts above** (written to a throwaway
`bd init`'d repo under `/tmp`, never a real project):

```json
{
  "formula": "mol-feature",
  "description": "Standard feature workflow: design, implement, test, review",
  "version": 1,
  "type": "workflow",
  "vars": {
    "name": { "description": "Feature name", "required": true },
    "owner": { "description": "Assignee for the implement step", "default": "unassigned" }
  },
  "steps": [
    { "id": "design", "title": "Design {{name}}", "type": "task" },
    { "id": "implement", "title": "Implement {{name}}", "type": "task", "needs": ["design"] },
    { "id": "test", "title": "Test {{name}}", "type": "task", "needs": ["implement"] },
    { "id": "review", "title": "Review {{name}}", "type": "task", "needs": ["test"] }
  ]
}
```

---

## 2. What's worth surfacing, and what isn't

**In scope for v1 (opinionated):**

- **Formula browse** (`bd formula list`/`show`) — pure read, zero risk, this
  is the "menu" a spawn flow needs anyway.
- **Molecule browse + progress** (`bd mol show`, `bd mol progress`,
  `bd mol current`) — pure read, and it's the single highest-value screen for
  "what am I supposed to be doing right now across N poured molecules,"
  which is exactly the gap the owner flagged.
- **Pour, with mandatory dry-run preview first** — the actual spawn action.
  This is the one write path worth building because it's the one thing a
  human plausibly wants to trigger from a browser tab rather than a terminal
  (picking a formula and filling in a form is a web-native interaction; the
  rest of the mol surface is closer to "read the state of work already in
  flight," which a dashboard is also good at, or "CLI power-tool," which it
  isn't).
- **Promote** (wisp → permanent) — already scoped as trivial in
  `beads-coverage.md`'s Phase 5 table; it's a natural companion action once
  any wisp becomes visible at all (§below).

**Deliberately out of scope for v1, with reasons:**

- **`bd mol wisp` create/list/gc as first-class UI.** Reaffirming
  `beads-coverage.md`'s call: wisps are excluded from `bd export`
  (confirmed live in §1), so there is no passive way for bd-console's
  existing read model (`getIssues()` in `lib/bd.mjs:29-42`, which parses only
  `.beads/issues.jsonl`) to see them. Making wisps visible would require an
  entirely separate, always-live (never cached-from-export) read path —
  `bd mol wisp list --json` on every request, no JSONL fallback — for a
  feature class (heartbeats, release checklists, operational loops) that
  isn't what a solo dev directing agents via this dashboard spends their time
  on. **Verdict: wisps stay out of v1.** If a concrete use case shows up
  later, the read path is straightforward (§3 below spells it out) — it's a
  size-S add-on, not a redesign, whenever it's actually wanted.
- **`bd mol bond`.** Genuinely the most powerful compositional primitive in
  the system (dynamic Christmas-Ornament fan-out, formula+mol attachment,
  mol+mol joins) but also the most conceptually loaded, and per §8 its
  formula-name resolution is unreliable on the installed version. Building a
  UI on top of a command whose basic resolution behavior can't be trusted
  yet is a bad trade. Defer past v1; revisit once the CLI-level bug is
  understood or fixed.
- **`bd mol distill`.** High value ("capture the workflow I just did
  organically as a reusable formula") but it's an epic→formula extraction
  flow with its own variable-substitution UI (`--var concrete=placeholder`,
  bidirectional detection of which side is which) that deserves its own pass
  once pour/browse are solid and battle-tested. Phase it after pour, not
  alongside it (§7).
- **`bd mol squash`.** Only meaningful once wisps exist in a molecule to
  squash — gated on wisps being in scope, which they aren't yet.
- **`bd cook --persist`** (writing a proto bead to the DB). The CLI's own
  help calls this "legacy behavior" and the persisted proto bead is *also*
  excluded from `bd export` and from `bd list` (confirmed live: after
  `cook --persist`, the proto bead was invisible to both `bd list --json`
  and the exported JSONL, visible only via `bd show <proto-id>` directly).
  There is no reason for bd-console to ever call `--persist` — formulas
  should be read from disk (`bd formula list/show`), never round-tripped
  through a DB bead.

---

## 3. Read model

### 3.1 Formulas — file-backed, not beads

`bd formula list --json` (confirmed shape, one formula registered):

```json
[
  {
    "name": "mol-feature",
    "type": "workflow",
    "description": "Standard feature workflow: design, implement, test, review",
    "source": "/abs/path/.beads/formulas/mol-feature.formula.json",
    "steps": 4,
    "vars": 2
  }
]
```
(`bd formula list --json` with zero formulas registered returns the bare JSON
literal `null`, not `[]` — the route handler must treat `null` as an empty
list.)

`bd formula show <name> --json` (confirmed shape — this is where the
variable-substitution form gets its field list):

```json
{
  "description": "Standard feature workflow: design, implement, test, review",
  "formula": "mol-feature",
  "schema_version": 1,
  "source": "/abs/path/.beads/formulas/mol-feature.formula.json",
  "type": "workflow",
  "version": 1,
  "vars": {
    "name":  { "description": "Feature name", "required": true },
    "owner": { "description": "Assignee for the implement step", "default": "unassigned" }
  },
  "steps": [
    { "id": "design", "title": "Design {{name}}", "type": "task" },
    { "id": "implement", "title": "Implement {{name}}", "needs": ["design"], "type": "task" },
    { "id": "test", "title": "Test {{name}}", "needs": ["implement"], "type": "task" },
    { "id": "review", "title": "Review {{name}}", "needs": ["test"], "type": "task" }
  ]
}
```

Variable discovery for the pour form is exactly `Object.entries(vars)`, using
`required`/`default`/`description`/`pattern`/`enum` (per the docs page for
`/workflows/formulas`, `pattern` and `enum` are real schema fields for
constrained vars, not exercised live here but cheap to render as
regex-validated / `<select>` inputs respectively once encountered).
`{{key}}` occurrences inside step `title`/`description` are the substitution
targets — `bd cook <formula> --var k=v --json` (confirmed above, §1) is the
**preview-render** call: it returns the fully-substituted step list without
creating anything, and unlike `pour --dry-run`, `cook`'s `--json` flag is
honored (confirmed: `bd cook mol-feature --var name=auth --json` returned
real JSON, both in compile mode with defaults and runtime mode with
overrides). **This makes `bd cook <formula> --var k=v --json` the correct
call for live-typing variable preview** (§5), separate from `bd mol pour
--dry-run` which is the correct call for the final pre-spawn confirmation
screen (its text-only output is fine there since it's a one-shot review, not
something re-rendered on every keystroke).

Formulas need light caching: they're read from up to 4 search paths on every
`bd formula list`/`show` call (project → repo-local → user → `$GT_ROOT`), and
nothing in bd-console currently caches anything beyond the issues export.
Recommendation: no server-side cache at all for v1 — formula lists are small
(single digits to low tens) and the command is fast; just don't call it more
than once per page load. Revisit only if a project accumulates hundreds of
formulas.

### 3.2 Molecules — real beads, detectable directly from the JSONL export

**The detection rule is simply `issue.issue_type === 'molecule'`.** Confirmed
live: a poured molecule's root bead exports as
```json
{"_type":"issue","id":"mf-mol-pt6","title":"mol-feature","issue_type":"molecule", ...}
```
— no label, no metadata field, no special marker needed. This is materially
simpler than `beads-coverage.md`'s speculation ("epics grouped client-side by
some yet-unknown signal") assumed. **Caveat:** this only holds for the root
bead of a `pour`ed (persistent) molecule. A `cook --persist`ed proto bead
(which also happens to show `issue_type: "molecule"` — confirmed via
`bd show <proto-id> --json`, which additionally carries `"is_template": true`
and `"labels": ["template"]`) is *excluded from the export entirely*, so it
never reaches bd-console's `getIssues()` and this ambiguity never surfaces in
practice — every `issue_type === 'molecule'` record bd-console will ever see
via the JSONL path is a real, poured molecule root, not a proto.

Step beads (the molecule's children) are **ordinary beads with
`issue_type` set from the formula step's own `type` field** (`task` in the
fixture; could be `bug`/`feature`/`epic`/`chore` per `bd create --type`'s
enum) — nothing distinguishes "this task is a molecule step" from a
regular task at the bead level *except its relationship edges*:

- One `parent-child` dependency: `{issue_id: <step>, depends_on_id: <mol-root>, type: "parent-child"}` — same shape `store.js`'s existing `parentOf()` (`public/ui/store.js:125-128`) already understands, so `childrenOf(molRootId)` (`store.js:144-146`) **already works today, unmodified**, to enumerate a molecule's steps.
- Zero or more `blocks` dependencies to sibling steps, derived from the
  formula's `needs` array — again the exact shape `blockersOf`/`isReady`
  already understand.

Confirmed full dependency block from `bd mol show <id> --json`, formula
`design→implement→test→review`:
```
mf-mol-756 (design)   --parent-child--> mf-mol-pt6 (root)
mf-mol-gpo (implement)--parent-child--> mf-mol-pt6
mf-mol-gpo (implement)--blocks--(depends_on)--> mf-mol-756   // implement needs design
mf-mol-7q0 (test)     --parent-child--> mf-mol-pt6
mf-mol-7q0 (test)     --blocks-->        mf-mol-gpo           // test needs implement
mf-mol-dig (review)   --parent-child--> mf-mol-pt6
mf-mol-dig (review)   --blocks-->        mf-mol-7q0           // review needs test
```
**Practical consequence:** a molecule's step DAG is not a new relationship
type to teach the UI — it is exactly the existing `parent-child` +
`blocks` model, just densely populated in one shot by `pour`. The *only* new
concept the UI needs is "this parent is a molecule, not a plain epic" (so it
gets a molecule-specific glyph/section instead of the generic epic-grouping
treatment) — see §5 for why that distinction matters for Flow/MapView.

`bd mol show <id> --json` full shape (confirmed, abbreviated — see §1 for the
full transcript):
```json
{
  "root": { "id": "mf-mol-pt6", "issue_type": "molecule", "title": "mol-feature", ... },
  "issues": [ /* root + all steps, same fields as bd show */ ],
  "dependencies": [ /* parent-child + blocks edges, as above */ ],
  "is_compound": false,
  "bonded_from": null,
  "variables": null
}
```
`variables` is `null` here because pour's substituted values aren't retained
on the molecule bead itself (confirmed) — **if the UI wants to show "this
molecule was poured with name=auth, owner=alice" on the molecule's detail
page, that information does not round-trip through `bd mol show` and would
have to be captured client-side at pour time** (e.g. echoed into the
molecule's own description, or accepted as a gap — see §8, open question).

`bd mol progress <id> --json` (confirmed) — cheap, index-backed, good for a
list-of-molecules summary view without loading full step data:
```json
{"molecule_id":"mf-mol-pt6","molecule_title":"mol-feature","completed":0,"in_progress":0,"total":4,"percent":0,"current_step_id":""}
```

`bd ready --mol <id> --json` (confirmed) — the parallel-group-aware "what can
run right now" view, richer than plain `bd mol show`:
```json
{
  "molecule_id": "mf-mol-pt6", "molecule_title": "mol-feature",
  "total_steps": 5, "ready_steps": 2,
  "parallel_groups": { "group-1": ["mf-mol-pt6", "mf-mol-756"] },
  "steps": [ { "issue": {...}, "parallel_group": "group-1",
               "parallel_info": { "is_ready": true, "blocked_by": [], "blocks": ["mf-mol-gpo"], "can_parallel": ["mf-mol-756"] } }, ... ]
}
```

Caching: molecule state changes with every claim/close on any step, exactly
like any other issue — no special cache needed beyond bd-console's existing
issues-export-refresh-on-write pattern (`ensureIssuesExportFresh`,
`lib/bd.mjs:74-81`). `bd mol progress`/`bd mol show --json` should be called
live (not derived from the export) for the molecule detail screen specifically,
since a molecule's DAG-aware "ready"/"parallel group" semantics are
authoritative server-side computations bd-console has no client-side
equivalent for (unlike plain `blocks`, which `store.js` already reimplements
correctly).

### 3.3 Wisps (if ever brought into scope)

Not in v1 (§2), but for the record, since the task asks for the read plan:
`bd mol wisp list --json` is the only viable source (confirmed shape, §1) —
it must be polled live on every request a wisp view is open, with **no**
export/cache path, because `bd export` structurally excludes them. This is a
materially different read model from every other bd-console screen (which
all read from the cached JSONL) and is the main reason wisps are deferred
rather than "cheap to add later" — it's a second live-polling code path, not
a UI-only addition.

### 3.4 What needs a NEW route vs. reuses the issues list

| Data | Source | New route needed? |
|---|---|---|
| List of formulas | `bd formula list --json` | Yes — nothing today calls `bd formula` |
| One formula's vars/steps | `bd formula show <name> --json` | Yes |
| Live variable preview while typing | `bd cook <name> --var k=v --json` | Yes (or folded into the formula-show route with query params — see §4) |
| Molecule root + step beads | Already in `.beads/issues.jsonl` via existing `GET /api/issues` — filter client-side on `issue_type === 'molecule'` and `childrenOf()` | **No** — reuse `store.issues`, `childrenOf()` |
| Molecule DAG/parallel-group/dry-run preview | `bd mol show --json`, `bd ready --mol --json`, `bd mol pour --dry-run` | Yes |
| Pour (the write) | `bd mol pour <proto> --var k=v [...]` | Yes |
| Promote a wisp | `bd promote <id>` | Yes (small) |

---

## 4. API design

Following `lib/routes.mjs`'s exact conventions: project-scoped routes hang
off `getContext()`'s `ctx.routedPath` (so they're reachable as both
`/api/formulas` in single-project mode and `/api/p/<id>/formulas` in hub
mode, transparently, the same way `/api/issues` already works); reads are
ungated, writes require `authed(req, url)`; all `bd` invocations go through
the existing `bd(ctx, args)` helper (`lib/bd.mjs:12-26`) — args array, never
string concatenation; ids/labels are validated against the existing
`ID_RE`/`LABEL_RE` (`lib/bd.mjs:8-9`) before ever reaching `execFile`.

### `GET /api/formulas`
- → `bd formula list --json` (optionally `--type <t>` if a `?type=` query
  param is present — validate against the CLI's own 4-value enum
  `workflow|expansion|aspect|convoy`, reject anything else with 400).
- Response: `{ formulas: [...] }` — pass the array through as-is, but
  **normalize `bd`'s bare `null` to `[]`** (confirmed live behavior when zero
  formulas are registered) so the frontend never has to special-case it.
- No auth required (read-only).

### `GET /api/formulas/:name`
- Validate `:name` with a new, slightly looser regex than `ID_RE` (formula
  names are user-chosen file basenames, not bead ids — allow
  `[A-Za-z0-9_.-]+`, reject path separators explicitly since this interpolates
  into a CLI arg, not a filesystem path, but defense in depth costs nothing).
- → `bd formula show <name> --json`.
- On the CLI's plain-text-on-stderr not-found error (confirmed: `Error:
  formula "X" not found in search paths\n\nSearch paths:\n  ...`, not JSON,
  exit 1, message on stderr) → `404 { error: 'formula not found' }`. Don't
  leak the search-path listing to the client; log it server-side if useful.

### `GET /api/formulas/:name/preview?var.<key>=<value>...`
- → `bd cook <name> --var k=v [...repeat] --json` (runtime mode triggered by
  presence of any `--var`; omit `--var` entirely for the compile-mode
  preview showing raw `{{placeholders}}`, used when the form is empty).
- Response: pass through `bd cook`'s JSON as `{ preview: {...} }` — this is
  confirmed to honor `--json` reliably (§1), unlike pour/distill/burn
  dry-runs, so no special-casing needed here.
- Validate each `k` against a variable-name pattern (`^[A-Za-z0-9_]+$`) before
  building the args array; validate that `k` is one of the formula's declared
  `vars` keys (fetch-and-check, or just let `bd cook` be the validator and
  surface its error — simpler, and `bd cook` already errors clearly on
  missing required vars, confirmed: `"error": "missing required variables:
  name", "hint": "Provide them with: --var name=<value>"`).

### `GET /api/molecules/:id`
- Validate `:id` with the existing `ID_RE`.
- → `bd mol show <id> --json` (add `?parallel=1` → also fire `bd ready --mol
  <id> --json` and merge the `parallel_groups`/`ready_steps` fields into the
  response — two calls, but both are cheap, indexed, single-molecule
  lookups).
- On not-found (confirmed: this one *does* return proper JSON —
  `{"error": "molecule 'X' not found", "schema_version": 1}`, exit 1) → `404`
  passthrough of that error string.

### `POST /api/molecules/pour/preview`
- Body: `{ proto: string, vars: { [key]: string } }`.
- Validate `proto` loosely (formula-name or bead-id shaped — accept either,
  `bd mol pour` itself resolves which), validate each `vars` key as a bare
  identifier.
- → `bd mol pour <proto> --var k=v [...] --dry-run` (**no `--json`** — per
  §1's confirmed finding that `--dry-run --json` together still emit plain
  text, there is nothing to gain from passing `--json` here and it would be
  misleading to imply the output is structured).
- Response: `{ ok: true, preview: <raw stdout text> }`. **Do not attempt to
  parse the dry-run text into structured data** — the format
  (`Dry run: would pour N issues from proto X\n\nStorage: ...\n\n  - id
  (from source)\n  ...`) is a human-readable log line, not a documented
  contract, and parsing it is exactly the kind of implicit-schema coupling
  that breaks silently on a bd point release. Render it as preformatted text
  in the UI (§5) — it's already itemized one-per-line, which reads fine
  verbatim. If a future `bd` version fixes `--dry-run --json`, this route
  should upgrade to consuming structured output over the mtime the CLI's
  `--version` output can be inspected for.
- This is a read-only preview — **no `authed()` gate needed**, same
  reasoning as every other GET, even though the shape looks POST-like
  (chosen as POST purely because the variable map can be large / contain
  characters awkward for a query string, not because it's a write). Mark it
  clearly as safe-to-repeat in code comments so a future maintainer doesn't
  assume POST implies mutation here.

### `POST /api/molecules/pour`
- Body: `{ proto: string, vars: { [key]: string }, assignee?: string }`.
- **Token-gated** (`authed(req, url)`) — this is the one true write in this
  whole feature area, and it can create many beads in one call.
- Validation, mirroring `runIssueEdit`'s style (`lib/bd.mjs:83-132`):
  - `proto`: non-empty string, reject if it contains shell-meaningful
    characters beyond what a formula name / bead id can legitimately contain
    (`^[A-Za-z0-9][A-Za-z0-9_.-]*$`) — this is an args-array `execFile` call
    so injection isn't the risk, but a garbage value should 400 before
    shelling out, not surface as an opaque `bd` stderr blob.
  - `vars`: object, each key `^[A-Za-z0-9_]+$`, each value cast to `String()`
    (matching the CLI's own `--var key=value` flag shape) — reject if any
    value contains a literal `=` in a way that would make `key=value`
    ambiguous... actually not ambiguous, `--var` takes one flag per pair so
    embedded `=` in the value is fine; just don't allow newlines (defense
    against multi-line stdout confusion in logs, not an injection issue given
    the args array).
  - `assignee`: reuse the existing `ASSIGNEE_RE` (`lib/routes.mjs:21`).
- → `bd mol pour <proto> --var k=v [...] [--assignee <a>] --json`. Pour's
  success path **does** honor `--json` (confirmed, §1 — only the *dry-run*
  path silently drops it) so this is safe to parse directly.
- Response, passthrough of `bd mol pour`'s own JSON shape plus a refreshed
  export (same pattern as every other write route,
  `lib/routes.mjs:588-593`):
  ```json
  {
    "ok": true,
    "created": 5,
    "new_epic_id": "mf-mol-pt6",
    "id_mapping": { "mol-feature": "mf-mol-pt6", "mol-feature.design": "mf-mol-756", ... },
    "phase": "liquid",
    "export": { "ok": true, "refreshed": true, ... }
  }
  ```
- Error passthrough: pour's real-world error path is plain text on stderr,
  non-JSON, even with `--json` requested (confirmed: `Error: X not found as
  formula or proto ID`) — so this route must fall back to
  `(result.stderr || 'bd mol pour failed').trim()` exactly like every
  existing write route already does (`lib/bd.mjs:128`, `lib/routes.mjs:519`,
  etc.), **never** assume `bd mol pour`'s stdout is JSON-parseable on the
  error path even though it is on success.
- **Phase note:** this route always pours (persistent). There is
  deliberately no `wisp: true` option in v1 — wisping is out of scope (§2),
  and `bd mol pour`'s own help warns that pouring a `phase: "vapor"`-tagged
  formula produces a CLI warning; surface that warning (if present in
  stderr alongside a success exit) as a toast, don't suppress it.

### `POST /api/promote`
- Body: `{ id: string, reason?: string }`.
- Token-gated.
- Validate `id` with `ID_RE`.
- → `bd promote <id> [--reason <r>]`.
- This one is genuinely useful even without any other molecule UI — expose it
  as a generic action, not nested under `/api/molecules/`, matching how
  `bd promote` itself isn't a `bd mol` subcommand.

### Error-shape summary (applies to all four new routes)

Mirror the existing convention exactly (`sendJson(res, status, {error, ...})`,
`lib/routes.mjs:53-58`):
- `400` — client-side validation failure (bad id/name/var-key format),
  message says which field.
- `404` — `bd`-confirmed "not found" (formula or molecule), passthrough of
  bd's own error string where it's already clean JSON (`mol show`), or a
  generic `'formula not found'`/`'molecule not found'` where bd's error is
  plain text (`formula show`, `mol pour`) to avoid leaking search-path/stderr
  noise.
- `401` — missing/wrong token on the two write routes.
- `500` — anything else `bd` failed on, `result.stderr` passthrough per
  existing convention.

---

## 5. UX design

### 5.1 Where it lives

**A new Omnibar command family, not a new canvas mode.** Reasoning: Console
2.0's three canvas modes (Flow/Map/Docs, `Console2.js:33`) are each a
different *lens on the same issue list* — molecules aren't a different lens,
they're a different *action* (spawn work) plus a *browse* surface that's a
strict subset of what Flow/Detail can already show once the molecule's steps
are ordinary beads in `store.issues` (§3.2). Concretely:

- **Formula browse + pour** → new Omnibar command `mol` (arity 0, opens a
  dialog — like the existing `i`/`+New` shortcut opens `CreateIssueDialog`,
  not like the one-shot `claim`/`close` commands). Typing `> mol` or
  `> mol <formula-name>` (prefilling the picker) both work, matching the
  Omnibar's existing `verb`/`rest` parsing (`Omnibar.js:54-59`).
- **Molecule detail** → **an addition to the existing Detail slide-over**
  (`console2/Detail.js`), not a new panel. When `selectIssue()` opens a bead
  whose `issue_type === 'molecule'`, Detail renders a new "Molecule" section
  above the generic relationship chips: progress bar (`bd mol progress`),
  parallel-group-aware step list (`bd ready --mol`), each step a clickable
  `RelChip`-style row identical to today's blocker/blocks chips
  (`Detail.js:29-35`) — this reuses existing UI primitives almost verbatim.
- **Flow/epic-grouping fix (prerequisite, small):** `childrenOf()` already
  works for molecule steps (§3.2), so Flow's epic-row rendering
  (`Flow.js:92`, `derive.js:24,44,48`) needs exactly one additional
  condition — `i.issue_type === 'epic' || i.issue_type === 'molecule'` —
  everywhere it currently special-cases `'epic'`, to get molecules grouped
  into their own row instead of appearing as loose top-level cards. This is
  a one-line-per-site change, not a new component; call it out explicitly in
  phasing (§7) since it's easy to forget and silently breaks the "epic
  grouping" mental model for anyone who pours a molecule.
- **`TYPE_GLYPH`** (`console2/ui.js:8-9`) needs a `molecule: '⚗'` (or similar
  chemistry-flavored glyph, matching the metaphor bd itself uses) entry —
  today it falls through to the generic `'●'`, indistinguishable from a task.

### 5.2 Browse experience

Typing `> mol` with no argument shows the formula picker as an Omnibar
dropdown row set (same visual language as the existing command list,
`Omnibar.js:221-227`), one row per formula from `GET /api/formulas`:
```
> mol
┌─────────────────────────────────────────────────────────┐
│ 🧪 mol-feature      Standard feature workflow: design,… │  workflow · 2 vars
│ 🧪 mol-release      Release checklist for a version bump│  workflow · 3 vars
│ 🧪 security-audit   Structured security review pass     │  workflow · 1 var
└─────────────────────────────────────────────────────────┘
```
Selecting a row (click or arrow+Enter, matching existing Omnibar keyboard
nav, `Omnibar.js:171-179`) opens the **pour dialog** (a new modal component,
sibling to `CreateIssueDialog`, not another Omnibar-inline mode — this one
needs a real form, not a single input line).

### 5.3 The spawn/pour flow — the centerpiece

```
┌─ Pour: mol-feature ──────────────────────────────────────────── ✕ ┐
│ Standard feature workflow: design, implement, test, review        │
│                                                                     │
│  name *          [ auth______________________ ]  Feature name     │
│  owner           [ alice____________________ ]  (default:         │
│                                                   unassigned)      │
│  assignee        [ ______________________ ]  (optional — root     │
│                                                issue only)         │
│                                                                     │
│ ── Preview (live) ──────────────────────────────────────────────  │
│  design       Design auth                                         │
│  implement    Implement auth              needs: design           │
│  test         Test auth                   needs: implement        │
│  review       Review auth                 needs: test             │
│                                                                     │
│  5 issues will be created (1 molecule root + 4 steps)              │
│                                                                     │
│                              [ Cancel ]   [ Preview spawn → ]      │
└─────────────────────────────────────────────────────────────────── ┘
```
- The "Preview (live)" block updates on every keystroke via
  `GET /api/formulas/mol-feature/preview?var.name=auth&var.owner=alice`
  (debounced ~300ms, same pattern as any live-search input already in the
  Omnibar) — this is the `bd cook --var ... --json` call (§3.1, §4), chosen
  specifically *because* it reliably returns JSON, unlike a dry-run pour.
  Required vars with no value yet show their `{{placeholder}}` un-substituted
  and the "Preview spawn" button stays disabled with a "fill in: name" hint
  — mirrors `bd cook`'s own missing-required-variable error rather than
  guessing.
- Clicking **"Preview spawn →"** fires `POST /api/molecules/pour/preview`
  (the actual `bd mol pour --dry-run` call) and swaps the dialog to a
  **confirmation step**:

```
┌─ Pour: mol-feature — confirm ──────────────────────────────────── ✕ ┐
│ This will create 5 issues:                                          │
│                                                                       │
│  ⚗ mol-feature          (molecule root)                              │
│  ├─ ● Design auth                                                    │
│  ├─ ● Implement auth                                                 │
│  ├─ ● Test auth                                                      │
│  └─ ● Review auth                                                    │
│                                                                       │
│  Storage: permanent (.beads/) — synced via git, shows up in history  │
│                                                                       │
│  [Raw bd output ▾]   $ bd mol pour mol-feature --var name=auth       │
│                          --var owner=alice --dry-run                 │
│                                                                       │
│                                    [ ← Back ]   [ Pour 5 issues ]    │
└─────────────────────────────────────────────────────────────────────┘
```
  The "Raw bd output" disclosure exists specifically because §4 established
  that this preview is *unstructured text*, not JSON — showing it verbatim
  (collapsed by default, matching the existing `CliFlash` "teach the CLI"
  philosophy, `Console2.js:35-50`) keeps the UI honest about what it's
  actually previewing rather than pretending to a level of structure the CLI
  doesn't provide. The itemized list above it is a client-side re-render of
  the *same* dry-run text (it's already one-item-per-line, trivially
  splittable on `/^\s+- /`) — cosmetic, not a second source of truth.
- Clicking **"Pour 5 issues"** fires the real `POST /api/molecules/pour`,
  shows a spinner (multi-second is plausible for 5+ `bd create`-equivalent
  calls chained server-side inside one `bd` invocation), then:
  - On success: closes the dialog, `flashCli('bd mol pour mol-feature --var
    name=auth --var owner=alice', 'pour')` (matching every other action's CLI
    receipt, `actions.js:46-89`), toasts `"✓ Poured mf-mol-pt6 · mol-feature
    (5 issues)"`, and **navigates straight to the new molecule's Detail**
    (`selectIssue('mf-mol-pt6')`) — this is the single most important UX
    beat: the owner should land on the thing they just created, not back on
    a list they have to re-find it in.
  - On failure (partial or total): see §6.

### 5.4 Molecule detail (Detail slide-over addition)

```
┌─ mf-mol-pt6 ⚗ mol-feature ──────────────────────────────────── ✕ ┐
│  molecule · P2 · open                                              │
│                                                                     │
│  ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░  1/4 steps (25%)                    │
│                                                                     │
│  Steps (parallel-group aware):                                     │
│   ● [ready]   Design auth          mf-mol-756          group-1      │
│   ○ [blocked] Implement auth       mf-mol-gpo   needs: 756          │
│   ○ [blocked] Test auth            mf-mol-7q0   needs: gpo          │
│   ○ [blocked] Review auth          mf-mol-dig   needs: 7q0          │
│                                                                     │
│  [ + New wisp from this molecule ]   ← disabled/hidden in v1        │
│  ── relationship chips, comments, edit tools (existing) ──         │
└─────────────────────────────────────────────────────────────────── ┘
```
Data: `GET /api/molecules/mf-mol-pt6?parallel=1` on open (one round trip),
falling back to the already-loaded `store.issues`/`childrenOf()` for the
plain parent-child list if that call fails — degrade gracefully to "it's a
molecule, here are its children" rather than a hard error, since the
generic Detail machinery already renders that much for free.

### 5.5 Post-spawn navigation

Already covered in 5.3: land on the new molecule's Detail, not a list. If the
pour dialog was opened from a specific project context (always true — there's
no cross-project pour), no further navigation ambiguity exists.

---

## 6. Safety rails

- **Confirmation is structural, not a checkbox.** The two-step dialog (fill
  form → preview → confirm → pour) *is* the confirmation; there is no path
  from "open the mol command" to "beads created" without seeing the itemized
  preview first. This matches the brief's requirement and is stronger than a
  generic "are you sure?" modal because the preview is the actual content,
  not a generic warning.
- **Dry-run is mandatory, not optional,** specifically because
  `bd mol pour`'s only reliable pre-flight signal *is* `--dry-run`'s itemized
  text (confirmed, §1/§4) — there's no cheaper structured "would this
  succeed" check available. Never offer a "skip preview, just pour" shortcut
  in v1; the preview call is fast (single-digit-ms in testing) so there's no
  performance reason to skip it, and skipping it removes the one safety net
  available.
- **Rate/size sanity check before offering to pour:** if a formula's step
  count is large (the CLI's own docs mention molecules scaling to "millions
  of steps" for `bd mol progress`'s indexed-query design) the dialog should
  surface the step count prominently pre-confirm (already in the design
  above — "5 issues will be created") and consider a soft warning threshold
  (e.g., >25 steps) prompting "this is a big spawn, double-check the formula"
  — a client-side heuristic, no new `bd` flag needed.
- **Undo/cleanup story:** **`bd mol burn <id> --force`** is the correct
  cleanup primitive — confirmed it cascade-deletes the root and all steps in
  one call, confirmed dry-run text distinguishes "Persistent mol - deletions
  sync to remotes" so the UI can warn accordingly. Recommendation: **surface
  a "Burn this molecule" action on the molecule Detail view** (token-gated,
  same as pour, with its own confirmation — reuse the existing dry-run→confirm
  pattern: `bd mol burn <id> --dry-run` first, itemized list, then
  `bd mol burn <id> --force`). This is the direct answer to "what happens if
  I poured the wrong thing" — burn is *the* v1 undo path, not a new concept.
  **`bd mol squash`** is not a cleanup tool for accidental pours (it's for
  ephemeral/wisp children specifically, §1) — don't conflate the two in the
  UI copy.
- **Partial failure:** `bd mol pour` is (from the transcripts gathered) a
  single atomic-looking server-side operation — no evidence was found of it
  leaving a partial set of beads on failure (every failure case tested,
  §1/§8, failed *before* creating anything: missing required var, unknown
  proto). **Open question, flagged explicitly in §8:** whether a pour can
  fail *partway through* step creation (e.g. bead-id collision on step 3 of
  5) was not reproducible in the time available and isn't documented either
  way. Recommendation: bd-console's pour route should not assume atomicity —
  on any non-zero exit from the real (non-dry-run) `bd mol pour` call, treat
  the response as **possibly-partial** and immediately follow up with
  `bd mol show <proto-name-guess>` / a fresh export diff to detect and
  surface any beads that *did* get created before the failure, rather than
  reporting a clean "pour failed, nothing happened." This is a defensive
  posture recommendation, not a confirmed bug.
- **Token gating:** both write routes (`pour`, `promote`) go through the
  existing `authed()` gate exactly like every other write
  (`lib/routes.mjs:481-482` pattern) — no new gating concept, no exception
  for "it's just a preview" (the preview route is a separate, ungated GET/POST
  specifically because it performs no `bd` write, per §4).

---

## 7. Phasing

| Phase | Delivers | Size | Depends on | Notes |
|---|---|---|---|---|
| **P1 — Formula browse (read-only)** | `GET /api/formulas`, `GET /api/formulas/:name`; Omnibar `mol` command opens a read-only formula list + detail view (no pour yet) | **S** | none | Pure read, zero write-path risk; ships the "what workflows exist" half of the value on day one |
| **P2 — Molecule detection + Detail/Flow integration** | `issue_type === 'molecule'` glyph (`ui.js`), Flow/derive epic-grouping fix (`Flow.js:92`, `derive.js:24,44,48` — add `\|\| issue_type === 'molecule'`), Detail's new "Molecule" section reading `GET /api/molecules/:id` | **S–M** | none (independent of P1, but do together — same review pass) | This alone makes any *already-existing* poured molecule (created via CLI before bd-console had any mol UI) render correctly — valuable even before pour exists in the UI |
| **P3 — Variable preview** | `GET /api/formulas/:name/preview`, wired into the pour dialog's live-typing preview (`bd cook --var ... --json`) | **S** | P1 | Cheap: this is the one call in the whole feature area that reliably returns JSON on every path, so it's the least risky write-adjacent route to build first |
| **P4 — Dry-run preview + confirm screen** | `POST /api/molecules/pour/preview`, the confirm-step dialog UI (§5.3), raw-output disclosure | **M** | P3 | The `--dry-run --json` text-only quirk (§1/§4) is fully absorbed here — front-load dealing with it in the phase that's explicitly about preview, not the phase that also has to deal with real writes |
| **P5 — Actual pour + navigation** | `POST /api/molecules/pour`, post-spawn navigation to the new molecule's Detail, CLI-flash + toast, error-shape handling per §4/§6 | **M** | P2, P4 | The only phase that mutates anything; ships after both the display (P2) and the preview (P4) it depends on for a coherent flow already exist and have been used/trusted |
| **P6 — Promote** | `POST /api/promote`, a button surfaced generically (not molecule-specific) wherever an ephemeral-flagged bead might be shown | **S** | none | Genuinely independent — can land any time, even before P1, if it's wanted sooner; listed here for completeness since it's part of the same conceptual area |
| **P7 — Burn as cleanup action** | "Burn this molecule" button on molecule Detail (dry-run→confirm→`--force`, §6) | **S** | P2, P5 | The undo story for P5 — ship in the same release as P5 if at all possible, not as a later add-on, since "how do I undo a bad pour" is the first question anyone will ask after using P5 |
| **Not phased — explicitly deferred** | `bd mol bond`, `bd mol distill`, `bd mol wisp`/`squash` UI | — | — | §2/§8 — bond's resolution bug and wisps' export-exclusion are the blocking reasons, not scope/size; revisit if either is resolved or a concrete use case forces the issue |

Suggested sequencing for a single implementer: **P1 → P2 → P3 → P4 → P5 → P7**,
with P6 slotted in whenever convenient (it has no dependencies and touches no
code any other phase touches).

---

## 8. Open questions / risks

Flagged explicitly rather than guessed at:

1. **`bd mol bond`'s formula-name resolution is unreliable on v1.1.0.**
   Reproduced repeatedly: `bd mol bond distilled-feature distilled-feature
   --dry-run --json` and `bd mol bond molsimple molsimple --dry-run --json`
   (a freshly-written, never-before-referenced formula) both fail with
   `{"error": "'X' not found (not an issue ID or formula name)"}`, **despite**
   `bd formula list --json`, `bd formula show X`, `bd cook X`, and
   `bd mol seed X` all successfully resolving the exact same name in the same
   working directory, in the same shell session. One formula name
   (`mol-feature`) *did* resolve for `bond` — but only while it had *also*
   been `cook --persist`ed into a proto bead earlier in the session; after
   `bd mol burn`ing that persisted proto bead, **the same `mol-feature`
   formula name continued to resolve correctly for bond**, ruling out "needs
   a persisted proto bead" as the discriminator. No root cause was found in
   the time available (candidate theories: an internal formula-name cache
   that isn't refreshed by directory scans the way `list`/`show`/`cook`/`seed`
   are; some naming-convention heuristic tied to a `mol-` prefix specifically,
   since every docs-site example formula name happens to start with `mol-`).
   **Recommendation: do not build any bond UI in v1 (already reflected in
   §2/§7); if bond is revisited later, first confirm on the then-current `bd`
   version whether this reproduces, ideally by filing it upstream.**
2. **Pour partial-failure behavior is unconfirmed.** Every failure mode
   reproduced (missing required var, bad `--var` syntax, unknown proto) fails
   *before* any bead is created. Whether a pour can fail partway through
   (e.g., an id collision on step N of M after steps 1..N-1 already
   committed) was not reproducible in the available time. §6 gives a
   defensive recommendation (treat non-zero exit as possibly-partial and
   re-check via export diff) but this is unverified against real bd
   internals — worth a direct question to the bd maintainers or a deeper look
   at the Go source if/when this becomes a real incident rather than a
   hypothetical.
3. **Poured variable values don't round-trip.** `bd mol show <id> --json`
   reports `"variables": null` for a molecule that was demonstrably poured
   with `--var name=auth --var owner=alice` (confirmed). If the product wants
   to show "this molecule was poured with name=auth" on its detail page later,
   there is currently no `bd`-native way to retrieve that after the fact — it
   would have to be captured client-side at pour time (e.g., stashed into the
   pour request's own response handling, or written into the molecule's
   description as a side effect bd-console adds on top of the CLI's own
   output). Not blocking for v1 (the phased UI doesn't promise this) but
   worth flagging before anyone assumes it's retrievable.
4. **Formula schema fields `pattern`/`enum`/`gate` (variable constraints, step
   gates) were documented on the docs site but never exercised against a live
   formula** in the time available (the fixture formula used only
   `description`/`required`/`default`). If a real-world formula uses
   `pattern` (regex-constrained vars) or step-level `gate` blocks
   (`{type, approvers}`), the pour form's rendering of those fields (§5.3
   assumes plain text inputs) hasn't been validated against real output
   shapes. Recommend a quick pass with a `pattern`/`enum`/`gate`-bearing
   formula before P3 ships, not a blocker for P1/P2.
5. **`--attach`/`--attach-type` on `bd mol pour`** (attach another proto
   after spawning, in the same call) was read from `--help` but never
   exercised live — it's excluded from the P1–P7 phasing above entirely
   (the pour dialog in §5.3 doesn't expose it) and should stay excluded until
   there's a concrete need, given bond's already-flagged unreliability (risk
   #1) likely shares code paths with `--attach`'s proto-resolution logic.
6. **Custom issue types via `bd create --type` / formula step `type`.**
   `beads-coverage.md` notes bd-console's `CREATE_TYPES` is a hardcoded
   5-value list (`lib/routes.mjs:20`) that doesn't reflect `types.custom`
   config. A formula step's `type` field could reference a custom type not
   in that list — the pour flow doesn't validate step types client-side
   (validation is `bd`'s job at pour time, confirmed the CLI enforces its own
   type enum), so this should be a non-issue for pour specifically, but
   worth confirming a custom-typed step's resulting bead still renders
   sensibly in Detail/Flow (which do use `TYPE_GLYPH` lookups that fall back
   gracefully to `'●'`, so likely fine — not verified against a real custom
   type in the time available).

---

## Summary

**Recommended v1 scope:** formula browse (P1) + molecule detection/Detail
integration (P2) + variable preview (P3) + dry-run confirm (P4) + pour (P5) +
burn-as-undo (P7), in that order; promote (P6) can land any time independently.
Wisps, bond, distill, and squash are explicitly deferred — not for lack of
value, but because wisps need a whole second (always-live) read path the rest
of bd-console doesn't have, and bond has a reproduced, unexplained resolution
bug on the installed CLI version that makes it unsafe to build a UI on top of
yet.

**Single riskiest unknown:** whether `bd mol pour` can fail *partway through*
creating a molecule's beads, leaving an orphaned partial molecule behind —
every failure mode actually reproduced failed cleanly before creating
anything, but that's a sample of "obvious" failure modes (bad args, missing
vars), not an exhaustive test of the write path's atomicity under real-world
conditions (id collisions, concurrent writes, disk/DB errors mid-spawn). This
is the one place §6's safety-rail design leans on an assumption
("possibly-partial, re-check via export diff") rather than a confirmed CLI
guarantee.

**Phasing, one line:** P1 (formula browse, S) → P2 (molecule
detect+Detail/Flow fix, S–M) → P3 (variable preview, S) → P4 (dry-run
confirm screen, M) → P5 (real pour + navigation, M) → P7 (burn as undo, S),
with P6 (promote) droppable in anywhere since it has no dependencies.
