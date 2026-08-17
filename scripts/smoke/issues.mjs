// smoke: issues, relationships and the pure derivations over them.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs issues
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

// Pure frontend derivation, importable in Node — see public/ui/relationships.js
import {
  blockersOf, blockedByIssue, dependenciesByType, relatedTo, linkSections,
  supersededBy, duplicateOf, supersedes, duplicatedBy, retiredState,
  LINK_TYPES as UI_LINK_TYPES,
  CONTAINER_TYPES, isContainer, isMolecule, containerGroups,
  moleculeRootOf, moleculeRollup,
} from '../../public/ui/relationships.js';
// Pure MapView edge-model derivation (docs/beads-coverage.md Phase 2) — see
// public/ui/console2/graphModel.js's header for why it's signal-free and
// therefore importable here exactly like relationships.js above.
import { buildGraph } from '../../public/ui/console2/graphModel.js';
import { LINK_TYPES as SERVER_LINK_TYPES } from '../../lib/bd.mjs';
import { openEventStream, sleep } from './sse.mjs';

export async function runIssues(ctx) {
  const { assert, run, trimLastLine, repoDir, p, projectId, port, fixtures } = ctx;

  // --- rich issue creation + epic targets (Feature 2) ------------------------
  // The "Smoke epic" is a shared fixture (harness.mjs) because the settings
  // domain's defaultEpics round-trip needs one too; it is still created by the
  // same POST /create, and asserted on here.
  const epicRes = await fixtures.smokeEpic();
  assert(epicRes.ok && epicRes.id, `create epic failed: ${JSON.stringify(epicRes)}`);
  assert(epicRes.issue && epicRes.issue.issue_type === 'epic', 'created epic issue_type mismatch');

  const childRes = await fetch(p('/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Smoke child bug',
      type: 'bug',
      priority: 1,
      labels: ['smoke', 'triage'],
      acceptance: 'it works',
      parent: epicRes.id
    })
  }).then((r) => r.json());
  assert(childRes.ok && childRes.id, `create child bug failed: ${JSON.stringify(childRes)}`);
  assert(childRes.issue.issue_type === 'bug', 'created child issue_type mismatch');
  assert(childRes.issue.priority === 1, 'created child priority mismatch');
  assert((childRes.issue.labels || []).includes('smoke') && (childRes.issue.labels || []).includes('triage'), 'created child labels mismatch');

  const epicsList = await fetch(p('/epics')).then((r) => r.json());
  assert(epicsList.epics.some((e) => e.id === epicRes.id), '/api/p/<id>/epics missing created epic');

  const badType = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'bad type', type: 'nonsense' })
  });
  assert(badType.status === 400, `bad type should 400, got ${badType.status}`);

  const badPriority = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'bad priority', priority: 9 })
  });
  assert(badPriority.status === 400, `bad priority should 400, got ${badPriority.status}`);

  const badParent = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'bad parent', parent: 'not a valid id!' })
  });
  assert(badParent.status === 400, `bad parent should 400, got ${badParent.status}`);

  // Create validates the assignee with the SAME ASSIGNEE_RE as the
  // set-assignee edit op — it must reject, not sanitize. This route used to
  // strip disallowed characters and keep the remains, so "alice smith" was
  // filed under "alicesmith": an assignee nobody typed and nobody can search
  // for. A 400 is the only honest answer.
  const badAssignee = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'bad assignee', assignee: 'alice smith' })
  });
  assert(badAssignee.status === 400, `create with a malformed assignee should 400, got ${badAssignee.status}`);
  const flagAssignee = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'flag assignee', assignee: '--json' })
  });
  assert(flagAssignee.status === 400, `create with a flag-shaped assignee should 400, got ${flagAssignee.status}`);
  const okAssignee = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'assigned at birth', assignee: 'ann-marie.o@example.com' })
  }).then((r) => r.json());
  assert(okAssignee.ok && okAssignee.issue.assignee === 'ann-marie.o@example.com',
    `create should keep a valid assignee verbatim, got ${JSON.stringify(okAssignee.issue && okAssignee.issue.assignee)}`);

  const noTitle = await fetch(p('/create'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '   ' })
  });
  assert(noTitle.status === 400, `empty title should 400, got ${noTitle.status}`);

  console.log(`smoke ok (create + epics): epic=${epicRes.id}, child=${childRes.id}`);

  // --- blocker DIRECTION regression guard -----------------------------------
  // `bd dep add A B` = "A depends on B" (B blocks A), stored as a row on A.
  // Reading that backwards inverted blocked/ready across the whole UI for
  // weeks (see docs/beads-coverage.md), so pin the invariant against a real
  // bd-created dependency rather than a hand-written fixture.
  const depA = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Dependent A'], { cwd: repoDir }));
  const depB = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Blocker B'], { cwd: repoDir }));
  run('bd', ['dep', 'add', depA, depB], { cwd: repoDir });
  run('bd', ['export', '-o', '.beads/issues.jsonl'], { cwd: repoDir });

  const relIssues = (await fetch(p('/issues')).then((r) => r.json())).issues;
  const issueA = relIssues.find((i) => i.id === depA);
  const issueB = relIssues.find((i) => i.id === depB);
  assert(issueA && issueB, 'dependency fixture issues missing from the export');
  assert(blockersOf(issueA).includes(depB),
    `blockersOf(A) must contain B (A depends on B); got ${JSON.stringify(blockersOf(issueA))}`);
  assert(blockersOf(issueB).length === 0,
    `blockersOf(B) must be empty (nothing blocks B); got ${JSON.stringify(blockersOf(issueB))}`);
  assert(blockedByIssue(depB, relIssues).includes(depA), 'blockedByIssue(B) must contain A');
  // parent-child must never count as a blocker
  assert(blockersOf(relIssues.find((i) => i.id === childRes.id) || {}).length === 0,
    'a parent-child row must not make a child look blocked');

  console.log(`smoke ok (blocker direction): ${depB} blocks ${depA}`);

  // --- link types: enum parity with the installed bd ------------------------
  // The frontend can't import lib/bd.mjs, so relationships.js mirrors its
  // LINK_TYPES. Pin BOTH copies to the enum the installed binary actually
  // prints, so a bd upgrade that changes the vocabulary fails loudly here
  // instead of producing a dropdown full of types bd will reject.
  const depAddHelp = run('bd', ['dep', 'add', '--help'], { cwd: repoDir });
  const enumMatch = depAddHelp.match(/Dependency type \(([^)]+)\)/);
  assert(enumMatch, 'could not parse the --type enum out of `bd dep add --help`');
  const cliLinkTypes = enumMatch[1].split('|').map((s) => s.trim()).filter(Boolean);
  assert(cliLinkTypes.length === 10, `expected 10 dep types from bd, got ${cliLinkTypes.length}: ${cliLinkTypes.join(',')}`);
  const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
  assert(sameSet(SERVER_LINK_TYPES, cliLinkTypes),
    `lib/bd.mjs LINK_TYPES drifted from \`bd dep add --help\`:\n  bd:  ${cliLinkTypes.join('|')}\n  lib: ${SERVER_LINK_TYPES.join('|')}`);
  assert(sameSet(UI_LINK_TYPES, SERVER_LINK_TYPES),
    `public/ui/relationships.js LINK_TYPES mirror drifted from lib/bd.mjs:\n  lib: ${SERVER_LINK_TYPES.join('|')}\n  ui:  ${UI_LINK_TYPES.join('|')}`);

  console.log(`smoke ok (link-type enum parity): ${cliLinkTypes.join('|')}`);

  // --- non-blocking link types must NOT read as blockers --------------------
  // The regression this pins: if `related`/`discovered-from` ever leak into
  // BLOCKING_DEP_TYPES (or blockersOf stops filtering by type), every issue
  // with a see-also link silently becomes phantom-blocked and drops out of
  // ready work. Created with the real CLI, not a hand-written fixture.
  const linkHub = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Link hub'], { cwd: repoDir }));
  const linkPeer = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Link peer'], { cwd: repoDir }));
  const linkOrigin = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Link origin'], { cwd: repoDir }));
  run('bd', ['dep', 'add', linkHub, linkPeer, '--type', 'related'], { cwd: repoDir });
  run('bd', ['dep', 'add', linkHub, linkOrigin, '--type', 'discovered-from'], { cwd: repoDir });
  run('bd', ['export', '-o', '.beads/issues.jsonl'], { cwd: repoDir });

  const linkIssues = (await fetch(p('/issues')).then((r) => r.json())).issues;
  const hubIssue = linkIssues.find((i) => i.id === linkHub);
  const peerIssue = linkIssues.find((i) => i.id === linkPeer);
  const originIssue = linkIssues.find((i) => i.id === linkOrigin);
  assert(hubIssue && peerIssue && originIssue, 'link fixture issues missing from the export');

  assert(dependenciesByType(hubIssue, 'related').includes(linkPeer),
    `dependenciesByType(hub,'related') must contain the peer; got ${JSON.stringify(dependenciesByType(hubIssue, 'related'))}`);
  assert(dependenciesByType(hubIssue, 'discovered-from').includes(linkOrigin),
    `dependenciesByType(hub,'discovered-from') must contain the origin; got ${JSON.stringify(dependenciesByType(hubIssue, 'discovered-from'))}`);

  // THE regression guard: neither link may make anything look blocked.
  assert(blockersOf(hubIssue).length === 0,
    `a related/discovered-from row must not make an issue blocked; blockersOf(hub) = ${JSON.stringify(blockersOf(hubIssue))}`);
  assert(blockersOf(peerIssue).length === 0, 'the related peer must not be blocked');
  assert(blockersOf(originIssue).length === 0, 'the discovered-from origin must not be blocked');
  assert(!blockedByIssue(linkPeer, linkIssues).includes(linkHub), 'a related row must not register as a blocks edge');

  // `related` is stored one-sided by `bd dep add --type related`, so the
  // bidirectional read has to find it from BOTH ends and dedupe.
  assert(relatedTo(hubIssue, linkIssues).includes(linkPeer), 'relatedTo(hub) must contain the peer (row lives on hub)');
  assert(relatedTo(peerIssue, linkIssues).includes(linkHub), 'relatedTo(peer) must contain the hub (row lives on the OTHER side)');
  assert(relatedTo(hubIssue, linkIssues).length === new Set(relatedTo(hubIssue, linkIssues)).size, 'relatedTo must dedupe');
  assert(!relatedTo(hubIssue, linkIssues).includes(linkHub), 'relatedTo must never include the issue itself');
  assert(!relatedTo(hubIssue, linkIssues).includes(linkOrigin), 'discovered-from must not be read as related');

  // Sections: outbound discovered-from on the hub, inbound on the origin.
  const hubSections = linkSections(hubIssue, linkIssues);
  assert(hubSections.some((s) => s.type === 'discovered-from' && s.dir === 'out' && s.ids.includes(linkOrigin)),
    `hub must expose an outbound discovered-from section; got ${JSON.stringify(hubSections.map((s) => s.key))}`);
  assert(!hubSections.some((s) => s.type === 'related'), 'related must not double-render as a generic section');
  const originSections = linkSections(originIssue, linkIssues);
  assert(originSections.some((s) => s.type === 'discovered-from' && s.dir === 'in' && s.ids.includes(linkHub)),
    `origin must expose an inbound discovered-from section; got ${JSON.stringify(originSections.map((s) => s.key))}`);
  assert(linkSections(peerIssue, linkIssues).length === 0, 'a peer with only a related edge needs no generic sections');

  console.log(`smoke ok (link types): related=${linkPeer}, discovered-from=${linkOrigin}, neither blocks ${linkHub}`);

  // --- add-link / remove-link over HTTP -------------------------------------
  const trackTarget = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Track target'], { cwd: repoDir }));
  const editJson = async (payload) => {
    const r = await fetch(p('/edit'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json() };
  };
  const issuesNow = async () => (await fetch(p('/issues')).then((r) => r.json())).issues;

  const addTracks = await editJson({ id: linkHub, op: 'add-link', other: trackTarget, type: 'tracks' });
  assert(addTracks.status === 200 && addTracks.body.ok, `add-link tracks failed: ${JSON.stringify(addTracks.body)}`);
  assert(addTracks.body.effect && addTracks.body.effect.kind === 'add-link' && addTracks.body.effect.type === 'tracks',
    `add-link must echo its effect; got ${JSON.stringify(addTracks.body.effect)}`);
  let hubAfter = (await issuesNow()).find((i) => i.id === linkHub);
  assert(dependenciesByType(hubAfter, 'tracks').includes(trackTarget), 'add-link tracks did not persist');
  assert(blockersOf(hubAfter).length === 0, 'a tracks link must not make the issue blocked');

  const rmTracks = await editJson({ id: linkHub, op: 'remove-link', other: trackTarget, type: 'tracks' });
  assert(rmTracks.status === 200 && rmTracks.body.ok, `remove-link failed: ${JSON.stringify(rmTracks.body)}`);
  hubAfter = (await issuesNow()).find((i) => i.id === linkHub);
  assert(!dependenciesByType(hubAfter, 'tracks').includes(trackTarget), 'remove-link did not remove the tracks row');

  // Back-compat: add-blocker/remove-blocker still work, still mean `blocks`.
  const legacyAdd = await editJson({ id: linkHub, op: 'add-blocker', blocker: trackTarget });
  assert(legacyAdd.status === 200 && legacyAdd.body.ok, `add-blocker back-compat broke: ${JSON.stringify(legacyAdd.body)}`);
  hubAfter = (await issuesNow()).find((i) => i.id === linkHub);
  assert(blockersOf(hubAfter).includes(trackTarget), 'add-blocker must still create a blocks edge');
  const legacyRm = await editJson({ id: linkHub, op: 'remove-blocker', blocker: trackTarget });
  assert(legacyRm.status === 200 && legacyRm.body.ok, `remove-blocker back-compat broke: ${JSON.stringify(legacyRm.body)}`);
  hubAfter = (await issuesNow()).find((i) => i.id === linkHub);
  assert(!blockersOf(hubAfter).includes(trackTarget), 'remove-blocker must still remove the blocks edge');

  // Injection/validation surface: nothing user-typed reaches --type.
  assert((await editJson({ id: linkHub, op: 'add-link', other: trackTarget, type: 'duplicates' })).status === 400,
    'add-link must reject `duplicates` (bd duplicate owns that edge)');
  assert((await editJson({ id: linkHub, op: 'add-link', other: trackTarget, type: '--dry-run' })).status === 400,
    'add-link must reject a flag-shaped type');
  assert((await editJson({ id: linkHub, op: 'add-link', other: '; rm -rf /', type: 'related' })).status === 400,
    'add-link must reject a non-ID target');
  assert((await editJson({ id: linkHub, op: 'add-link', other: linkHub, type: 'related' })).status === 400,
    'add-link must reject a self-link');

  console.log('smoke ok (add-link/remove-link + back-compat + validation)');

  // --- supersede / mark-duplicate round-trip --------------------------------
  const oldSpec = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Old spec'], { cwd: repoDir }));
  const newSpec = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'New spec'], { cwd: repoDir }));
  const sup = await editJson({ id: oldSpec, op: 'supersede', with: newSpec });
  assert(sup.status === 200 && sup.body.ok, `supersede failed: ${JSON.stringify(sup.body)}`);
  assert(sup.body.effect && sup.body.effect.kind === 'supersede' && sup.body.effect.autoClosed === true,
    `supersede must report its auto-close side effect; got ${JSON.stringify(sup.body.effect)}`);
  assert(String(sup.body.effect.message || '').includes(newSpec), 'supersede effect.message must name the replacement');
  assert(sup.body.issue && sup.body.issue.status === 'closed', 'supersede must leave the superseded issue closed');

  const dupIssue = trimLastLine(run('bd', ['create', '--silent', '--type', 'bug', '-p', '2', '--title', 'Dupe report'], { cwd: repoDir }));
  const canonical = trimLastLine(run('bd', ['create', '--silent', '--type', 'bug', '-p', '2', '--title', 'Canonical report'], { cwd: repoDir }));
  const dup = await editJson({ id: dupIssue, op: 'mark-duplicate', of: canonical });
  assert(dup.status === 200 && dup.body.ok, `mark-duplicate failed: ${JSON.stringify(dup.body)}`);
  assert(dup.body.effect && dup.body.effect.kind === 'mark-duplicate' && dup.body.effect.autoClosed === true,
    `mark-duplicate must report its auto-close side effect; got ${JSON.stringify(dup.body.effect)}`);
  assert(dup.body.issue && dup.body.issue.status === 'closed', 'mark-duplicate must leave the duplicate closed');

  const retiredIssues = await issuesNow();
  const oldIssue = retiredIssues.find((i) => i.id === oldSpec);
  const dupeIssueRec = retiredIssues.find((i) => i.id === dupIssue);
  // Ground truth (bd v1.1.0): the edge hangs off the RETIRED issue and points
  // at the survivor — `supersedes`/`duplicates` rows read "…by/of".
  assert(supersededBy(oldIssue) === newSpec, `supersededBy(old) must be the replacement; got ${supersededBy(oldIssue)}`);
  assert(duplicateOf(dupeIssueRec) === canonical, `duplicateOf(dupe) must be the canonical; got ${duplicateOf(dupeIssueRec)}`);
  assert(supersedes(newSpec, retiredIssues).includes(oldSpec), 'supersedes(new) must contain the retired issue');
  assert(duplicatedBy(canonical, retiredIssues).includes(dupIssue), 'duplicatedBy(canonical) must contain the duplicate');
  // Retired state must OUTRANK blocked/ready (banner precedence) and must
  // never be mistaken for a blocking edge.
  assert(retiredState(oldIssue)?.kind === 'superseded', 'retiredState must classify a supersedes row');
  assert(retiredState(dupeIssueRec)?.kind === 'duplicate', 'retiredState must classify a duplicates row');
  assert(retiredState(retiredIssues.find((i) => i.id === newSpec)) === null, 'the replacement itself is not retired');
  assert(blockersOf(oldIssue).length === 0, 'a supersedes row must not read as a blocker');
  assert(blockersOf(dupeIssueRec).length === 0, 'a duplicates row must not read as a blocker');
  // The banner owns the outbound edge, so it must not ALSO be a chip section.
  assert(!linkSections(oldIssue, retiredIssues).some((s) => s.dir === 'out' && s.type === 'supersedes'),
    'the supersede banner must not double-render as a section');
  assert(linkSections(retiredIssues.find((i) => i.id === newSpec), retiredIssues).some((s) => s.dir === 'in' && s.type === 'supersedes'),
    'the replacement must expose an inbound "Supersedes" section');

  assert((await editJson({ id: oldSpec, op: 'supersede', with: 'not a valid id!' })).status === 400, 'supersede must reject a bad replacement id');
  assert((await editJson({ id: oldSpec, op: 'supersede', with: oldSpec })).status === 400, 'supersede must reject superseding itself');
  assert((await editJson({ id: dupIssue, op: 'mark-duplicate', of: dupIssue })).status === 400, 'mark-duplicate must reject itself');

  console.log(`smoke ok (supersede/duplicate): ${oldSpec}→${newSpec}, ${dupIssue}→${canonical}`);

  // --- set-assignee: reassign AND clear -------------------------------------
  // The clear is the half that's easy to get wrong, so it is pinned against
  // the real binary: `bd update <id> --assignee ""` REMOVES the field (the key
  // disappears from the JSONL export) rather than setting it to "". If a
  // future bd changes that, this fails loudly instead of leaving a UI whose
  // "Clear" button silently does nothing.
  const owned = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Owned work', '-a', 'alice'], { cwd: repoDir }));
  const assigneeOf = async (issueId) => (await issuesNow()).find((i) => i.id === issueId)?.assignee;
  assert(await assigneeOf(owned) === 'alice', `fixture should start assigned to alice; got ${await assigneeOf(owned)}`);

  const reassign = await editJson({ id: owned, op: 'set-assignee', assignee: 'bob' });
  assert(reassign.status === 200 && reassign.body.ok, `set-assignee failed: ${JSON.stringify(reassign.body)}`);
  assert(await assigneeOf(owned) === 'bob', `reassign did not persist; got ${await assigneeOf(owned)}`);
  assert(reassign.body.issue && reassign.body.issue.assignee === 'bob', 'set-assignee must echo the updated issue');

  const unassign = await editJson({ id: owned, op: 'set-assignee', assignee: '' });
  assert(unassign.status === 200 && unassign.body.ok, `set-assignee (clear) failed: ${JSON.stringify(unassign.body)}`);
  const clearedAssignee = await assigneeOf(owned);
  assert(!clearedAssignee, `clearing must leave no assignee; got ${JSON.stringify(clearedAssignee)}`);
  assert(clearedAssignee !== '', 'bd must REMOVE the assignee, not set it to an empty string');

  // Clearing an already-unassigned issue is a no-op, not an error.
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: '' })).status === 200, 'clearing an unassigned issue should be idempotent');
  // An omitted `assignee` is the same as an explicit clear (String(undefined ?? '')).
  assert((await editJson({ id: owned, op: 'set-assignee' })).status === 200, 'set-assignee with no assignee field should clear, not 500');

  // Validation: nothing user-typed reaches the CLI unchecked. `--json` here is
  // the interesting one — bd's flag parser accepts it as a literal VALUE
  // (verified on v1.1.0), so without ASSIGNEE_RE it would become an assignee.
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: 'alice smith' })).status === 400, 'set-assignee must reject whitespace in a name');
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: '; rm -rf /' })).status === 400, 'set-assignee must reject shell metacharacters');
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: '--json' })).status === 400, 'set-assignee must reject a flag-shaped value');
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: '-a' })).status === 400, 'set-assignee must reject a short-flag-shaped value');
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: '-bob' })).status === 400, 'set-assignee must reject any leading hyphen');
  assert((await editJson({ id: owned, op: 'set-assignee', assignee: 'a'.repeat(129) })).status === 400, 'set-assignee must reject an over-long name');
  assert((await editJson({ id: 'not a valid id!', op: 'set-assignee', assignee: 'bob' })).status === 400, 'set-assignee must reject a bad issue id');
  // The forms a real handle takes must all survive — including a hyphen in
  // the MIDDLE, which is the whole reason the rule is "no leading '-'" rather
  // than "no '-'".
  for (const who of ['bob', 'bob.smith', 'bob_smith-2', 'ann-marie', 'bob@example.com']) {
    assert((await editJson({ id: owned, op: 'set-assignee', assignee: who })).status === 200, `set-assignee must accept ${who}`);
    assert(await assigneeOf(owned) === who, `set-assignee did not persist ${who}`);
  }
  await editJson({ id: owned, op: 'set-assignee', assignee: '' });

  console.log(`smoke ok (set-assignee: reassign + clear removes the field + validation): ${owned}`);

  // --- Phase 2: MapView edge-model split (layoutEdges vs overlayEdges) -----
  // Pure, fixture-driven — buildGraph() is signal/store-free (a plain issues
  // array in, a plain object out — see public/ui/console2/graphModel.js), so
  // this pins the load-bearing constraint from docs/beads-coverage.md Phase 2
  // directly, with no server/daemon/bd involved: non-blocking link types
  // must NEVER reach layoutEdges (the layering/critical-chain input) — every
  // other present type must be routed to overlayEdges instead, tagged with
  // its type, deduped for the bidirectional related/relates-to pair, and
  // restricted to endpoints buildGraph actually placed (closed issues never
  // become nodes, so an edge touching one must not leak into either set).
  {
    const gmIssues = [
      { id: 'g-a', status: 'open', priority: 2, dependencies: [] },
      { id: 'g-b', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-b', depends_on_id: 'g-a', type: 'blocks' }] },
      { id: 'g-c', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-c', depends_on_id: 'g-b', type: 'blocks' }] },
      { id: 'g-d', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-d', depends_on_id: 'g-a', type: 'related' }] },
      { id: 'g-e', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-e', depends_on_id: 'g-d', type: 'relates-to' }] },
      { id: 'g-f', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-f', depends_on_id: 'g-a', type: 'discovered-from' }] },
      { id: 'g-g', status: 'open', priority: 2, dependencies: [{ issue_id: 'g-g', depends_on_id: 'g-a', type: 'tracks' }] },
      // closed: its outbound related row must not leak into either edge set
      // (buildGraph/graphLayout only ever place non-closed issues as nodes).
      { id: 'g-h', status: 'closed', priority: 2, dependencies: [{ issue_id: 'g-h', depends_on_id: 'g-a', type: 'related' }] },
    ];
    const graph = buildGraph(gmIssues);

    assert(graph.nodes.every((n) => n.issue.status !== 'closed'), 'buildGraph must never place a closed issue as a node');
    assert(!graph.nodes.some((n) => n.id === 'g-h'), 'a closed issue must not appear as a node');

    const layoutPairs = graph.layoutEdges.map((e) => e.from + '->' + e.to).sort();
    assert(JSON.stringify(layoutPairs) === JSON.stringify(['g-a->g-b', 'g-b->g-c']),
      `layoutEdges must contain ONLY the blocking chain; got ${JSON.stringify(layoutPairs)}`);
    // THE regression this pins: a non-blocking-typed edge must never reach layoutEdges.
    const nonBlockingIds = ['g-d', 'g-e', 'g-f', 'g-g'];
    assert(!graph.layoutEdges.some((e) => nonBlockingIds.includes(e.from) || nonBlockingIds.includes(e.to)),
      `a non-blocking-typed issue must never appear on a layoutEdges endpoint; got ${JSON.stringify(layoutPairs)}`);

    const overlayByType = {};
    for (const e of graph.overlayEdges) (overlayByType[e.type] || (overlayByType[e.type] = [])).push(e.from + '->' + e.to);
    assert((overlayByType.related || []).length === 2, `expected 2 deduped related overlay edges, got ${JSON.stringify(overlayByType.related)}`);
    assert((overlayByType.related || []).includes('g-a->g-d'), `related overlay edge g-a<->g-d missing; got ${JSON.stringify(overlayByType.related)}`);
    assert((overlayByType.related || []).includes('g-d->g-e'),
      `related/relates-to must fold into one deduped "related" overlay edge; got ${JSON.stringify(overlayByType.related)}`);
    assert((overlayByType['discovered-from'] || []).includes('g-f->g-a'), 'discovered-from overlay edge missing');
    assert((overlayByType['tracks'] || []).includes('g-g->g-a'), 'tracks overlay edge missing');
    assert(!('blocks' in overlayByType), 'overlayEdges must never contain a blocking-typed edge');
    assert(!graph.overlayEdges.some((e) => e.from === 'g-h' || e.to === 'g-h'), 'a closed issue must not appear on any overlay edge');

    console.log(`smoke ok (graph edge model: layoutEdges excludes non-blocking types, related deduped): ${layoutPairs.join(',')}`);
  }

  // --- Phase 3 / bd-console-6ag.4: molecules group like epics --------------
  // Pure, fixture-driven — containerGroups() is signal/store/bd-free. This
  // pins the bug the container-type refactor fixed: a poured molecule's root
  // bead has issue_type 'molecule', NOT 'epic' (confirmed against bd v1.1.0,
  // docs/molecules-design.md §3.2), and every grouping site used to test
  // `issue_type === 'epic'` literally — so the molecule rendered as a bare
  // ungrouped row with its four steps loose in the Standalone section.
  // The fixture below is a verbatim transcription of a real `bd mol pour`
  // export (root + 4 steps, parent-child root←step plus the blocks chain
  // derived from the formula's `needs`).
  {
    const molIssues = [
      { id: 'mf-mol-und', title: 'mol-feature', issue_type: 'molecule', status: 'open', priority: 2, dependencies: null },
      { id: 'mf-mol-v6u', title: 'Design auth', issue_type: 'task', status: 'closed', priority: 2, dependencies: [
        { issue_id: 'mf-mol-v6u', depends_on_id: 'mf-mol-und', type: 'parent-child' }] },
      { id: 'mf-mol-4yy', title: 'Implement auth', issue_type: 'task', status: 'in_progress', priority: 2, dependencies: [
        { issue_id: 'mf-mol-4yy', depends_on_id: 'mf-mol-und', type: 'parent-child' },
        { issue_id: 'mf-mol-4yy', depends_on_id: 'mf-mol-v6u', type: 'blocks' }] },
      { id: 'mf-mol-bku', title: 'Test auth', issue_type: 'task', status: 'open', priority: 2, dependencies: [
        { issue_id: 'mf-mol-bku', depends_on_id: 'mf-mol-und', type: 'parent-child' },
        { issue_id: 'mf-mol-bku', depends_on_id: 'mf-mol-4yy', type: 'blocks' }] },
      { id: 'mf-mol-9zm', title: 'Review auth', issue_type: 'task', status: 'open', priority: 2, dependencies: [
        { issue_id: 'mf-mol-9zm', depends_on_id: 'mf-mol-und', type: 'parent-child' },
        { issue_id: 'mf-mol-9zm', depends_on_id: 'mf-mol-bku', type: 'blocks' }] },
      // A hand-made epic with one child — molecules must not displace epics.
      { id: 'mf-epic1', title: 'An epic', issue_type: 'epic', status: 'open', priority: 1, dependencies: null },
      { id: 'mf-kid1', title: 'Epic child', issue_type: 'task', status: 'open', priority: 2, dependencies: [
        { issue_id: 'mf-kid1', depends_on_id: 'mf-epic1', type: 'parent-child' }] },
      // A genuinely standalone bead — the only thing that may land in orphans.
      { id: 'mf-loose', title: 'Loose task', issue_type: 'task', status: 'open', priority: 3, dependencies: null },
    ];

    assert(CONTAINER_TYPES.includes('epic') && CONTAINER_TYPES.includes('molecule'),
      `CONTAINER_TYPES must cover epic AND molecule; got ${JSON.stringify(CONTAINER_TYPES)}`);
    assert(isContainer(molIssues[0]) && isMolecule(molIssues[0]), 'a molecule root must be a container');
    assert(isContainer(molIssues[5]) && !isMolecule(molIssues[5]), 'an epic must be a container but not a molecule');
    assert(!isContainer(molIssues[1]), 'a molecule STEP must not be treated as a container');

    const { groups, orphans } = containerGroups(molIssues);
    const molGroup = groups.find((g) => g.container.id === 'mf-mol-und');
    assert(molGroup, 'THE BUG: a molecule root produced no group — its steps would render un-nested');
    const stepIds = molGroup.children.map((c) => c.id).sort();
    assert(JSON.stringify(stepIds) === JSON.stringify(['mf-mol-4yy', 'mf-mol-9zm', 'mf-mol-bku', 'mf-mol-v6u']),
      `molecule group must contain all 4 poured steps; got ${JSON.stringify(stepIds)}`);
    assert(molGroup.total === 4 && molGroup.closed === 1,
      `molecule progress must count all children (expected 4 total / 1 closed); got ${molGroup.total}/${molGroup.closed}`);
    const epicGroup = groups.find((g) => g.container.id === 'mf-epic1');
    assert(epicGroup && epicGroup.children.length === 1, 'epic grouping must still work alongside molecules');
    // THE regression this pins: no molecule step (nor either container) may
    // fall through into the ungrouped "Standalone" bucket.
    assert(JSON.stringify(orphans.map((o) => o.id)) === JSON.stringify(['mf-loose']),
      `only the genuinely standalone bead may be an orphan; got ${JSON.stringify(orphans.map((o) => o.id))}`);

    // Step -> molecule root resolution (Detail's "part of molecule X" link).
    assert(moleculeRootOf(molIssues[1], molIssues)?.id === 'mf-mol-und', 'a step must resolve to its molecule root');
    assert(moleculeRootOf(molIssues[0], molIssues)?.id === 'mf-mol-und', 'a molecule root must resolve to itself');
    assert(moleculeRootOf(molIssues[6], molIssues) === null, 'an epic child must NOT resolve to a molecule root');
    assert(moleculeRootOf(molIssues[7], molIssues) === null, 'a standalone bead has no molecule root');

    const roll = moleculeRollup(molIssues[0], molIssues);
    assert(roll.total === 4 && roll.closed === 1 && roll.inProgress === 1 && roll.percent === 25,
      `molecule rollup mismatch: ${JSON.stringify({ t: roll.total, c: roll.closed, p: roll.inProgress, pct: roll.percent })}`);
    // "Test auth" is blocked by the in-progress "Implement auth"; "Review
    // auth" is blocked by "Test auth" — neither may count as plain open.
    assert(roll.blocked === 2 && roll.open === 0,
      `molecule rollup blocked/open mismatch: ${roll.blocked}/${roll.open}`);

    console.log('smoke ok (molecule containment: molecule root groups its 4 steps, rollup 1/4 closed 25%)');
  }

  // --- ETag / 304 on GET /api/p/<id>/issues (bd-console-974.3) --------------
  // The issue list is the largest thing the dashboard fetches and every open
  // tab re-fetches it on every change event, so "nothing moved" has to be
  // answerable without the body. The validator is the export file's mtime+size,
  // which means a WRITE must invalidate it — that second half is the one that
  // would rot silently (a constant ETag also passes a 304 test).
  {
    const first = await fetch(p('/issues'));
    const etag = first.headers.get('etag');
    assert(first.status === 200, `/issues should 200, got ${first.status}`);
    assert(etag && /^"\d+-\d+"$/.test(etag), `/issues must serve a strong mtime-size ETag, got ${JSON.stringify(etag)}`);
    // no-cache, not no-store: no-store forbids the stored copy a conditional
    // request revalidates, which would make the ETag decorative.
    assert(first.headers.get('cache-control') === 'no-cache',
      `/issues must be no-cache so the ETag can function, got ${first.headers.get('cache-control')}`);
    const body = await first.json();

    const conditional = await fetch(p('/issues'), { headers: { 'if-none-match': etag } });
    assert(conditional.status === 304, `a conditional GET with the current ETag must 304, got ${conditional.status}`);
    assert(conditional.headers.get('etag') === etag, '304 must echo the ETag');
    assert((await conditional.text()) === '', '304 must have an empty body');
    // Weak-prefixed and list-valued forms are legal on the wire.
    assert((await fetch(p('/issues'), { headers: { 'if-none-match': `W/${etag}` } })).status === 304,
      'a weak-prefixed If-None-Match must still match');
    assert((await fetch(p('/issues'), { headers: { 'if-none-match': `"nope-0", ${etag}` } })).status === 304,
      'If-None-Match is a LIST — a match anywhere in it must 304');
    assert((await fetch(p('/issues'), { headers: { 'if-none-match': '"0-0"' } })).status === 200,
      'a stale If-None-Match must serve the full 200');

    // A write must move the validator, or a client would sit on a 304 forever.
    const written = await fetch(p('/quick'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ETag invalidation probe' }),
    }).then((r) => r.json());
    assert(written.ok, `quick create failed: ${JSON.stringify(written)}`);
    const after = await fetch(p('/issues'), { headers: { 'if-none-match': etag } });
    assert(after.status === 200, `after a write the old ETag must NOT 304, got ${after.status}`);
    const newEtag = after.headers.get('etag');
    assert(newEtag && newEtag !== etag, `a write must produce a new ETag; still ${newEtag}`);
    const afterBody = await after.json();
    assert(afterBody.issues.length === body.issues.length + 1, 'the 200 after a write must carry the new issue');

    console.log(`smoke ok (issues ETag: ${etag} -> 304, write -> ${newEtag} -> 200)`);
  }

  // --- GET /api/p/<id>/stats (bd-console-974.3) ------------------------------
  // The hub used to download every issue of every project to render five counts
  // per card. This route does that arithmetic server-side, and the ONE thing
  // that matters about it is that its numbers match what the client derives
  // from the full list — so the expectation below is computed here from
  // /api/p/<id>/issues using the same pure blockersOf() the browser uses, not
  // from a transcription of the server's code.
  //
  // The fixture is whatever this domain has already created (blocked pairs, a
  // superseded issue, a closed duplicate, epics, molecules) plus a deliberately
  // deferred issue, which is the bucket most likely to be mishandled: `bd
  // update --defer` moves an issue OUT of open without closing it.
  {
    const deferId = trimLastLine(run('bd', ['create', '--silent', '--type', 'task', '-p', '2', '--title', 'Deferred work'], { cwd: repoDir }));
    const deferred = await fetch(p('/edit'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: deferId, op: 'set-defer', defer: '+30d' }),
    }).then((r) => r.json());
    assert(deferred.ok, `set-defer failed: ${JSON.stringify(deferred)}`);

    const issues = (await fetch(p('/issues')).then((r) => r.json())).issues;
    const stats = await fetch(p('/stats')).then((r) => r.json());

    // Independent tally, mirroring public/ui/store.js's loadProjectStats() +
    // the deferred lane from public/ui/console2/derive.js.
    const now = Date.now();
    const openIds = new Set(issues.filter((i) => i.status !== 'closed').map((i) => i.id));
    const expect = {
      open: 0, in_progress: 0, blocked: 0, closed: 0, deferred: 0,
      ready: 0, total: issues.length, openTotal: 0, triage: 0, closed7d: 0, openBugs: 0,
    };
    for (const i of issues) {
      if (i.status !== 'closed') {
        expect.openTotal++;
        if ((i.labels || []).includes('triage')) expect.triage++;
        if (i.issue_type === 'bug') expect.openBugs++;
      }
      const isBlocked = i.status === 'open' && blockersOf(i).some((b) => openIds.has(b));
      const isDeferred = i.status === 'deferred'
        || (i.status === 'open' && !isBlocked && !!i.defer_until && new Date(i.defer_until).getTime() > now);
      if (i.status === 'closed') {
        expect.closed++;
        const ts = i.closed_at ? new Date(i.closed_at).getTime() : (i.updated_at ? new Date(i.updated_at).getTime() : 0);
        if (ts && ts >= now - 7 * 86400000) expect.closed7d++;
      } else if (i.status === 'in_progress') expect.in_progress++;
      else if (isBlocked) expect.blocked++;
      else if (isDeferred) expect.deferred++;
      else if (i.status === 'open') { expect.open++; expect.ready++; }
    }
    for (const key of Object.keys(expect)) {
      assert(stats[key] === expect[key],
        `/stats ${key} disagrees with the client-side derivation over /issues: got ${stats[key]}, expected ${expect[key]}`);
    }

    // The fixture has to actually exercise the interesting buckets, or the
    // agreement above is agreement about zeroes.
    const deferRec = issues.find((i) => i.id === deferId);
    assert(deferRec, 'the deferred fixture is missing from the export');
    assert(deferRec.status === 'deferred' || (deferRec.defer_until && new Date(deferRec.defer_until).getTime() > now),
      `set-defer must produce a deferred issue; got status=${deferRec.status} defer_until=${deferRec.defer_until}`);
    assert(stats.deferred >= 1, 'the deferred fixture must land in the deferred bucket');
    assert(stats.blocked >= 1, 'this domain created a blocked issue — the blocked bucket must see it');
    assert(stats.closed >= 1 && stats.closed7d >= 1, 'this domain closed issues seconds ago — closed/closed7d must see them');
    assert(stats.in_progress >= 1, 'the baseline claimed the seed issue — in_progress must see it');
    assert(stats.openBugs >= 1, 'this domain created open bugs — openBugs must see them');
    // Deferred work is NOT pickable: the whole point of the bucket.
    assert(!blockersOf(deferRec).length, 'precondition: the deferred fixture has no blockers, so only the defer can exclude it');
    assert(stats.ready === stats.open,
      `ready must equal the open-and-unblocked count (${stats.open}), got ${stats.ready}`);
    assert(stats.total === issues.length && stats.openTotal + stats.closed === stats.total,
      `stats must partition the export: ${stats.openTotal} open + ${stats.closed} closed != ${stats.total}`);
    // Card numbers are exactly as old as the export they came from.
    assert(stats.generatedAt === stats.export.exportedAt && stats.generatedAt > 0,
      `generatedAt must be the export mtime, got ${stats.generatedAt} vs ${stats.export.exportedAt}`);

    console.log(`smoke ok (/stats: ${stats.total} total = ${stats.ready} ready + ${stats.in_progress} wip + ${stats.blocked} blocked + ${stats.deferred} deferred + ${stats.closed} closed, ${stats.closed7d} closed in 7d, ${stats.openBugs} open bugs)`);
  }

  // --- the change feed actually fires for issue writes (bd-console-974.3) ---
  // Both detectors are exercised, in the order that makes each one the ONLY
  // possible explanation for the event observed:
  //
  //   1. a write made OUTSIDE the daemon (`bd create` + `bd export` in a
  //      terminal, i.e. how most issues on this machine are really filed) —
  //      only the 2s mtime sweep can see that;
  //   2. a write through a route, after the sweeper's baseline has been
  //      re-seeded — and then a further 2.5s of silence, which is what pins the
  //      de-duplication: the route emits immediately AND the sweeper sees the
  //      same new mtime a moment later, so a broken dedupe shows up as two
  //      events for one write.
  {
    const stream = await openEventStream(`http://127.0.0.1:${port}/api/events`);
    try {
      const hello = await stream.waitFor((f) => f.event === 'hello', { timeoutMs: 3000 });
      assert(hello, 'no hello frame on the shared fixture server');

      // (1) filesystem detection. The sweeper seeds its baseline on connect, so
      // this write is unambiguously "changed since we started watching".
      run('bd', ['create', '--silent', '--type', 'task', '-p', '3', '--title', 'Filed from a terminal'], { cwd: repoDir });
      run('bd', ['export', '-o', '.beads/issues.jsonl'], { cwd: repoDir });
      const swept = await stream.waitFor((f) => f.event === 'change', { timeoutMs: 6000 });
      assert(swept, `a write made outside the daemon must be detected by the mtime sweeper; raw stream was ${JSON.stringify(stream.raw)}`);
      assert(swept.frame.data && swept.frame.data.kind === 'issues' && swept.frame.data.project === projectId,
        `change frame must name the project: got ${JSON.stringify(swept.frame.raw_data)}, expected project ${projectId}`);
      assert(typeof swept.frame.data.ts === 'number' && swept.frame.data.ts > 0,
        `change frame must carry a ts: ${JSON.stringify(swept.frame.raw_data)}`);
      assert(Object.keys(swept.frame.data).sort().join(',') === 'kind,project,ts',
        `an issues change frame carries exactly kind/project/ts, got ${JSON.stringify(swept.frame.raw_data)}`);

      // Clear the 2s debounce window (and let any trailing emit land) so the
      // next assertion counts events caused by the next write only.
      await sleep(2400);
      const mark = stream.frames.length;

      // (2) in-process detection, via a route that forces an export.
      const created = await fetch(p('/quick'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Filed through the API' }),
      }).then((r) => r.json());
      assert(created.ok, `quick create failed: ${JSON.stringify(created)}`);
      const emitted = await stream.waitFor((f) => f.event === 'change', { timeoutMs: 4000, from: mark });
      assert(emitted, `a write through a route must produce a change event; raw stream was ${JSON.stringify(stream.raw)}`);
      assert(emitted.frame.data.project === projectId, `route-emitted change named the wrong project: ${JSON.stringify(emitted.frame.raw_data)}`);

      await sleep(2600);
      const changes = stream.frames.slice(mark).filter((f) => f.event === 'change');
      assert(changes.length === 1,
        `one write must produce exactly ONE change event (the route emit re-stamps the file so the sweeper does not re-announce it); got ${changes.length}: ${JSON.stringify(changes.map((c) => c.raw_data))}`);

      console.log(`smoke ok (change feed: terminal write detected by the 2s sweeper, route write emitted once, no double-report)`);
    } finally {
      stream.close();
    }
  }
}
