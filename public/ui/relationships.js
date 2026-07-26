// relationships.js — pure derivations over a beads issue's dependencies[].
//
// Deliberately dependency-free (no signals, no imports) so it can be imported
// unchanged by the browser AND by Node in scripts/smoke.mjs, which is what
// makes the direction invariant below actually testable.
//
// DIRECTION INVARIANT — the thing that was wrong for weeks:
//   `bd dep add A B` means "A depends on B" (A is blocked by B) and beads
//   stores that row on A: { issue_id: A, depends_on_id: B, type: 'blocks' }.
//   So an entry in an issue's own dependencies[] names something that must
//   finish FIRST — a blocker OF that issue. Scanning other issues for rows
//   pointing at this one yields the exact opposite set.
//
//   The same invariant generalizes to every other link type: a row on X
//   pointing at Y is read "X <verb> Y", where the verb is the OUTBOUND label
//   in LINK_LABEL below. Verified against bd v1.1.0 for each type by
//   creating the edge with the real CLI and re-reading the export.

// The exact `bd dep add --type` enum for bd v1.1.0 — a MIRROR of LINK_TYPES in
// lib/bd.mjs. This module is loaded by the browser, which cannot import from
// lib/, so the list is duplicated rather than shared; scripts/smoke.mjs
// asserts the two copies are identical AND that both match the enum printed by
// `bd dep add --help`, so a future bd upgrade that changes the vocabulary
// fails the suite instead of silently producing dead UI.
export const LINK_TYPES = Object.freeze([
  'blocks',
  'tracks',
  'related',
  'parent-child',
  'discovered-from',
  'until',
  'caused-by',
  'validates',
  'relates-to',
  'supersedes',
]);

// Types that gate readiness. parent-child / related / discovered-from /
// tracks / caused-by / validates / relates-to / supersedes are relationships,
// not blockers, and must not make an issue look blocked.
export const BLOCKING_DEP_TYPES = new Set(['blocks', 'depends', 'depends-on', 'until']);

// `related` (from `bd dep add --type related`) and `relates-to` (from
// `bd dep relate`, which writes a row on BOTH sides, and from
// `bd dep add --type relates-to`, which writes only one) are the same
// human-level "see also" edge. Treated as one bidirectional set so a link
// renders once on both issues no matter which side created it.
export const RELATED_DEP_TYPES = new Set(['related', 'relates-to']);

// State-transition edges. Both hang off the SUBJECT issue and point at the
// survivor, mirroring `bd supersede <id> --with <new>` / `bd duplicate <id>
// --of <canonical>`. Note `duplicates` is NOT a `bd dep add --type` value —
// it only ever appears in the export because `bd duplicate` wrote it.
export const SUPERSEDE_DEP_TYPE = 'supersedes';
export const DUPLICATE_DEP_TYPE = 'duplicates';

// Human labels per type and direction. `out` describes a row found on the
// issue itself; `in` describes a row on some other issue pointing back.
export const LINK_LABEL = {
  'blocks': { out: 'Blocked by', in: 'Blocks' },
  'until': { out: 'Blocked until', in: 'Gates' },
  'parent-child': { out: 'Parent', in: 'Children' },
  'related': { out: 'Related', in: 'Related' },
  'relates-to': { out: 'Related', in: 'Related' },
  'tracks': { out: 'Tracks', in: 'Tracked by' },
  'discovered-from': { out: 'Discovered from', in: 'Discovered' },
  'caused-by': { out: 'Caused by', in: 'Caused' },
  'validates': { out: 'Validates', in: 'Validated by' },
  'supersedes': { out: 'Superseded by', in: 'Supersedes' },
  'duplicates': { out: 'Duplicate of', in: 'Duplicated by' },
};

export function linkLabel(type, dir) {
  return LINK_LABEL[type]?.[dir] || `${type} (${dir})`;
}

// Types the generic link sections must NOT re-render because a dedicated
// surface already owns them: blockers have their own panel + banner,
// parent-child has Parent/Children, related has its own bidirectional chip
// row, and an outbound supersedes/duplicates row is rendered as the
// superseded/duplicate BANNER rather than a chip row.
const RENDERED_ELSEWHERE = new Set([...BLOCKING_DEP_TYPES, 'parent-child', ...RELATED_DEP_TYPES]);
const SKIP_OUT = new Set([...RENDERED_ELSEWHERE, SUPERSEDE_DEP_TYPE, DUPLICATE_DEP_TYPE]);
const SKIP_IN = RENDERED_ELSEWHERE;

const deps = (issue) => (issue && issue.dependencies) || [];
const uniq = (ids) => [...new Set(ids)];

// Ids of the issues blocking `issue`.
export function blockersOf(issue) {
  const out = new Set();
  for (const d of deps(issue)) {
    if (BLOCKING_DEP_TYPES.has(d.type)) out.add(d.depends_on_id);
  }
  return [...out];
}

// Ids of the issues that `id` blocks (the inverse edge), given all issues.
export function blockedByIssue(id, issues) {
  return (issues || [])
    .filter((i) => blockersOf(i).includes(id))
    .map((i) => i.id);
}

// The parent epic/issue id, or null.
export function parentOfIssue(issue) {
  const p = deps(issue).find((d) => d.type === 'parent-child');
  return p ? p.depends_on_id : null;
}

// --- container types (epic | molecule) --------------------------------------
//
// A "container" is an issue whose job is to HOLD other issues rather than to
// be worked itself. bd has exactly two: `epic` (hand-made) and `molecule`
// (created by `bd mol pour`, which spawns a root bead plus one bead per
// formula step, wired root←parent-child←step — see docs/molecules-design.md
// §3.2, re-confirmed against bd v1.1.0).
//
// The distinction matters because the two are structurally IDENTICAL from the
// UI's point of view — a molecule's steps are ordinary beads carrying the
// exact same `parent-child` row an epic's children carry — but their
// `issue_type` strings differ. Every grouping/containment site used to test
// `issue_type === 'epic'` literally, so a poured molecule rendered as a bare
// ungrouped row with its steps un-nested in BOTH views. The predicate lives
// here, once, so a future third container type is a one-line change and can
// never be half-applied again.
export const MOLECULE_TYPE = 'molecule';
export const CONTAINER_TYPES = Object.freeze(['epic', MOLECULE_TYPE]);
const CONTAINER_TYPE_SET = new Set(CONTAINER_TYPES);

export function isContainerType(type) { return CONTAINER_TYPE_SET.has(type); }
export function isContainer(issue) { return !!issue && isContainerType(issue.issue_type); }
export function isMolecule(issue) { return !!issue && issue.issue_type === MOLECULE_TYPE; }

// Children of `id` over an explicit issues array (the store-free twin of
// store.js's signal-bound childrenOf).
export function childrenOfIssue(id, issues) {
  return (issues || []).filter((i) => parentOfIssue(i) === id);
}

// The single grouping pass both views render: one group per container, in
// input order, plus the leftover top-level issues. Pure — an issues array in,
// a plain object out — so scripts/smoke.mjs can assert "a molecule root groups
// its children" with no browser, no signals and no bd involved.
//
// `closed`/`total` count ALL children, not a filtered subset, so a caller
// narrowing `children` for a focus/filter can still render honest progress.
// -> { groups: [{ container, children, closed, total }], orphans: [...] }
export function containerGroups(issues) {
  const list = issues || [];
  const groups = [];
  const grouped = new Set();
  for (const container of list) {
    if (!isContainer(container)) continue;
    const children = childrenOfIssue(container.id, list);
    for (const c of children) grouped.add(c.id);
    groups.push({
      container,
      children,
      closed: children.filter((c) => c.status === 'closed').length,
      total: children.length,
    });
  }
  const orphans = list.filter((i) => !isContainer(i) && !grouped.has(i.id) && !parentOfIssue(i));
  return { groups, orphans };
}

// The molecule an issue belongs to: itself when it IS a molecule root, its
// parent when it's a step of one, else null. Steps are only ever one level
// deep under the root (pour never nests), so a single parent hop is exact.
export function moleculeRootOf(issue, issues) {
  if (!issue) return null;
  if (isMolecule(issue)) return issue;
  const pid = parentOfIssue(issue);
  if (!pid) return null;
  const parent = (issues || []).find((i) => i.id === pid);
  return isMolecule(parent) ? parent : null;
}

// Status rollup over a molecule root's steps, computed entirely client-side
// from the already-loaded issues list. `bd mol progress --json` reports the
// same completed/total/percent server-side; this is the offline equivalent so
// Detail can render a molecule the instant it opens (and still render it when
// the live route is unavailable). `blocked` uses the same open-blocker rule
// effStatus() does, so the numbers can't drift from the lanes.
// -> { root, steps, total, closed, inProgress, blocked, open, percent }
export function moleculeRollup(root, issues) {
  const list = issues || [];
  const steps = childrenOfIssue(root ? root.id : null, list);
  const openIds = new Set(list.filter((i) => i.status !== 'closed').map((i) => i.id));
  let closed = 0, inProgress = 0, blocked = 0, open = 0;
  for (const s of steps) {
    if (s.status === 'closed') { closed++; continue; }
    if (s.status === 'in_progress') { inProgress++; continue; }
    if (blockersOf(s).some((b) => openIds.has(b))) blocked++;
    else open++;
  }
  return {
    root: root || null,
    steps,
    total: steps.length,
    closed,
    inProgress,
    blocked,
    open,
    percent: steps.length ? Math.round((closed / steps.length) * 100) : 0,
  };
}

// --- generic link-type derivations -----------------------------------------

// Ids named by `issue`'s OWN rows of `type` — i.e. the outbound direction.
// Per the direction invariant this reads "issue <out-label> <returned ids>".
export function dependenciesByType(issue, type) {
  return uniq(deps(issue).filter((d) => d.type === type).map((d) => d.depends_on_id));
}

// The inverse scan: ids of issues carrying a `type` row that points at `id`.
export function inboundByType(id, issues, type) {
  const out = [];
  for (const other of issues || []) {
    if (!other || other.id === id) continue;
    if (deps(other).some((d) => d.type === type && d.depends_on_id === id)) out.push(other.id);
  }
  return uniq(out);
}

// Every distinct dependency type present on `issue`'s own rows.
export function linkTypesPresent(issue) {
  return uniq(deps(issue).map((d) => d.type));
}

// Bidirectional "see also". `bd dep relate` writes a row on both sides but
// `bd dep add --type related` writes only one, so both directions are scanned
// and the union deduped — the link renders once regardless of which side
// created it, and regardless of which of the two related-ish types was used.
export function relatedTo(issue, issues) {
  if (!issue) return [];
  const out = new Set();
  for (const d of deps(issue)) {
    if (RELATED_DEP_TYPES.has(d.type)) out.add(d.depends_on_id);
  }
  for (const other of issues || []) {
    if (!other || other.id === issue.id) continue;
    for (const d of deps(other)) {
      if (RELATED_DEP_TYPES.has(d.type) && d.depends_on_id === issue.id) out.add(other.id);
    }
  }
  out.delete(issue.id);
  return [...out];
}

// Provenance: "this issue came out of investigating those".
export function discoveredFrom(issue) { return dependenciesByType(issue, 'discovered-from'); }
// Convoy tracking: "this issue tracks those".
export function tracksOf(issue) { return dependenciesByType(issue, 'tracks'); }

// The replacement this issue was superseded BY, or null. Ground truth: `bd
// supersede E --with F` stores {issue_id: E, depends_on_id: F, type:
// 'supersedes'} on E and closes E — so the row lives on the retired issue.
export function supersededBy(issue) {
  return dependenciesByType(issue, SUPERSEDE_DEP_TYPE)[0] || null;
}
// The canonical issue this one duplicates, or null (`bd duplicate G --of H`).
export function duplicateOf(issue) {
  return dependenciesByType(issue, DUPLICATE_DEP_TYPE)[0] || null;
}
// Inverse of the two above: what this issue replaced / absorbed.
export function supersedes(id, issues) { return inboundByType(id, issues, SUPERSEDE_DEP_TYPE); }
export function duplicatedBy(id, issues) { return inboundByType(id, issues, DUPLICATE_DEP_TYPE); }

// The single "this issue has been retired" state, or null. Drives the banner
// that OUTRANKS blocked/ready in both Detail views (per docs/beads-coverage.md
// Phase 1: a superseding/duplicate state outranks open/blocked).
export function retiredState(issue) {
  const sup = supersededBy(issue);
  if (sup) return { kind: 'superseded', other: sup, label: 'Superseded by' };
  const dup = duplicateOf(issue);
  if (dup) return { kind: 'duplicate', other: dup, label: 'Duplicate of' };
  return null;
}

// Every link section worth rendering for `issue`, in both directions, for the
// types that don't already have a dedicated surface. Only non-empty groups are
// returned, so a Detail panel renders a heading only when that type has
// members and doesn't bloat with ten empty rows.
// -> [{ key, type, dir: 'out'|'in', label, ids: [...] }]
export function linkSections(issue, issues) {
  if (!issue) return [];
  const sections = [];
  // Only the retired-state type the banner actually claimed is suppressed —
  // an issue carrying BOTH a supersedes and a duplicates row (pathological,
  // since either one auto-closes it) still shows the loser as a chip row
  // rather than dropping it on the floor.
  const claimed = retiredState(issue)?.kind === 'duplicate' ? DUPLICATE_DEP_TYPE : SUPERSEDE_DEP_TYPE;
  for (const type of linkTypesPresent(issue)) {
    if (SKIP_OUT.has(type) && !((type === SUPERSEDE_DEP_TYPE || type === DUPLICATE_DEP_TYPE) && type !== claimed)) continue;
    const ids = dependenciesByType(issue, type);
    if (ids.length) sections.push({ key: `out:${type}`, type, dir: 'out', label: linkLabel(type, 'out'), ids });
  }
  const inboundTypes = new Set();
  for (const other of issues || []) {
    if (!other || other.id === issue.id) continue;
    for (const d of deps(other)) {
      if (!SKIP_IN.has(d.type) && d.depends_on_id === issue.id) inboundTypes.add(d.type);
    }
  }
  for (const type of inboundTypes) {
    const ids = inboundByType(issue.id, issues, type);
    if (ids.length) sections.push({ key: `in:${type}`, type, dir: 'in', label: linkLabel(type, 'in'), ids });
  }
  return sections;
}
