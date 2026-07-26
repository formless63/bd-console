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

// Types that gate readiness. parent-child / related / discovered-from /
// tracks / caused-by / validates / relates-to / supersedes are relationships,
// not blockers, and must not make an issue look blocked.
export const BLOCKING_DEP_TYPES = new Set(['blocks', 'depends', 'depends-on', 'until']);

// Ids of the issues blocking `issue`.
export function blockersOf(issue) {
  const out = new Set();
  for (const d of (issue && issue.dependencies) || []) {
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
  const p = ((issue && issue.dependencies) || []).find((d) => d.type === 'parent-child');
  return p ? p.depends_on_id : null;
}
