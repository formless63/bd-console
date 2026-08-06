// smoke: formulas and molecules: derivations, routes, and authoring.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs formulas
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockersOf, containerGroups, moleculeRootOf } from '../../public/ui/relationships.js';
// Pure formula derivations (docs/molecules-design.md) — same import-free
// contract as relationships.js above.
import {
  formulaVars, pourBeadCount, missingVars, previewMode, previewVars,
  varViolations, previewIssueCount, burnIssueCount,
  stepNeeds, slugifyFormulaName, slugifyVarName, distillCandidates,
  newFormulaTemplate, formulaSaveProblem, formulaStem, formulaFileName,
} from '../../public/ui/formulas.js';

export async function runFormulas(ctx) {
  const { assert, repoDir, p, seedId } = ctx;

  // --- Phase 3: formula derivations (pure) --------------------------------
  // The two rules here are bd's, verified live, and neither is what the docs
  // imply: (1) ANY --var switches `bd cook` into runtime mode, which then
  // demands EVERY declared variable resolve — vars with a `default` resolve
  // themselves, vars without one must be supplied; (2) bd does NOT enforce a
  // var's `enum`/`pattern` (confirmed: an out-of-enum value substitutes
  // verbatim, exit 0), so those checks are ours to make.
  {
    const f = {
      formula: 'mol-audit',
      steps: [{ id: 'recon', title: 'Recon {{scope}}' }, { id: 'report', title: 'Report {{scope}}', needs: ['recon'] }],
      vars: {
        scope: { description: 'Audit scope', required: true, enum: ['api', 'ui', 'infra'] },
        ticket: { description: 'Ticket', required: true, pattern: '^[A-Z]+-[0-9]+$' },
        owner: { description: 'Owner', default: 'unassigned' },
      },
    };
    const specs = formulaVars(f);
    assert(specs.length === 3, `expected 3 declared vars, got ${specs.length}`);
    assert(specs.find((s) => s.key === 'owner').hasDefault, 'owner declares a default');
    assert(specs.find((s) => s.key === 'scope').enum.length === 3, 'enum must survive');

    assert(pourBeadCount(f) === 3, 'pour creates one root + one bead per step');

    // A var with a default is never "missing" — it self-resolves in runtime mode.
    assert(JSON.stringify(missingVars(f, {})) === JSON.stringify(['scope', 'ticket']),
      `missingVars mismatch: ${JSON.stringify(missingVars(f, {}))}`);
    assert(missingVars(f, { scope: 'api', ticket: 'SEC-1' }).length === 0, 'defaults must not block a pour');

    // Mode selection: empty OR partially-filled -> compile (placeholders);
    // fully resolvable -> runtime. Sending a partial --var set is an ERROR
    // exit from bd, not a partial render, so the mode has to be chosen here.
    assert(previewMode(f, {}) === 'compile', 'an empty form previews in compile mode');
    assert(previewMode(f, { scope: 'api' }) === 'compile', 'a partially-filled form must NOT ask bd for runtime mode');
    assert(previewMode(f, { scope: 'api', ticket: 'SEC-1' }) === 'runtime', 'a fully-resolvable form previews in runtime mode');
    assert(Object.keys(previewVars(f, { scope: 'api' })).length === 0, 'compile mode must send no --var at all');
    assert(previewVars(f, { scope: 'api', ticket: 'SEC-1' }).scope === 'api', 'runtime mode sends the filled vars');

    // enum/pattern — ours to enforce, because bd does not.
    assert(varViolations(f, { scope: 'api', ticket: 'SEC-1' }).length === 0, 'valid values must not flag');
    assert(varViolations(f, { scope: 'bogus' })[0]?.key === 'scope', 'an out-of-enum value must flag');
    assert(varViolations(f, { ticket: 'lowercase' })[0]?.key === 'ticket', 'a pattern-violating value must flag');
    assert(varViolations({ vars: { x: { pattern: '([' } } }, { x: 'anything' }).length === 0,
      'an unparseable pattern in the formula must not break the form');

    // The ONE number read out of each dry-run's opaque text. Verbatim
    // transcripts from bd v1.1.0; a shape change returns null (advisory), it
    // never throws or invents a count.
    assert(previewIssueCount('\nDry run: would pour 5 issues from proto mol-feature\n\n  - x (from y)\n') === 5,
      'pour dry-run count must be read from bd\'s own wording');
    assert(previewIssueCount('some other output entirely') === null, 'an unrecognized dry-run must yield null, not a guess');
    assert(burnIssueCount('Dry run: would burn mol X\n\nIssues to delete (4 total):\n  - [open] a (b) [ROOT]\n') === 4,
      'burn dry-run count must be read from bd\'s own wording');
    assert(burnIssueCount('') === null, 'an empty burn dry-run must yield null');

    console.log('smoke ok (formula derivations: runtime-vs-compile mode, defaults self-resolve, enum/pattern enforced client-side)');
  }

  // --- Phase 3: formula/molecule ROUTES, end to end -----------------------
  // Against the real `bd init`'d fixture repo above: author a formula, browse
  // it, preview variables, dry-run, pour (a real multi-bead write), verify the
  // beads landed with the right shapes, then burn them back out. This is the
  // one place the text-not-JSON dry-run quirk and the pour->burn round trip
  // are exercised against the actual installed bd rather than a fixture.
  {
    const formulaDir = join(repoDir, '.beads', 'formulas');
    mkdirSync(formulaDir, { recursive: true });
    writeFileSync(join(formulaDir, 'smoke-flow.formula.json'), JSON.stringify({
      formula: 'smoke-flow',
      description: 'Smoke workflow: design then ship',
      version: 1,
      type: 'workflow',
      vars: {
        thing: { description: 'What is being built', required: true },
        owner: { description: 'Owner', default: 'nobody' },
      },
      steps: [
        { id: 'design', title: 'Design {{thing}}', type: 'task' },
        { id: 'ship', title: 'Ship {{thing}} for {{owner}}', type: 'task', needs: ['design'] },
      ],
    }, null, 2));

    const list = await fetch(p('/formulas')).then((r) => r.json());
    assert(Array.isArray(list.formulas), '/api/formulas must always return an array (bd emits bare null when empty)');
    const listed = list.formulas.find((f) => f.name === 'smoke-flow');
    assert(listed && listed.steps === 2 && listed.vars === 2, `formula list entry mismatch: ${JSON.stringify(listed)}`);

    const shown = await fetch(p('/formulas/smoke-flow')).then((r) => r.json());
    assert(shown.formula?.formula === 'smoke-flow', 'formula show mismatch');
    assert(missingVars(shown.formula, {}).length === 1, 'only the default-less var should block (owner has a default)');

    const missingFormula = await fetch(p('/formulas/definitely-not-a-formula'));
    assert(missingFormula.status === 404, `unknown formula should 404, got ${missingFormula.status}`);
    const leak = await missingFormula.json();
    assert(!/\//.test(leak.error || ''), `formula-not-found must not leak search paths: ${leak.error}`);
    const badName = await fetch(p('/formulas/' + encodeURIComponent('../etc/passwd')));
    assert(badName.status === 400, `a path-ish formula name should 400, got ${badName.status}`);

    // Compile mode: no --var, placeholders intact.
    const compile = await fetch(p('/formulas/smoke-flow/preview')).then((r) => r.json());
    assert(compile.mode === 'compile' && compile.preview.steps[0].title === 'Design {{thing}}',
      `compile preview mismatch: ${JSON.stringify(compile.preview?.steps?.[0])}`);
    // Runtime mode: substituted, and the default filled itself in.
    const runtime = await fetch(p('/formulas/smoke-flow/preview?var.thing=widgets')).then((r) => r.json());
    assert(runtime.mode === 'runtime' && runtime.preview.steps[0].title === 'Design widgets',
      `runtime preview mismatch: ${JSON.stringify(runtime.preview?.steps?.[0])}`);
    assert(runtime.preview.steps[1].title === 'Ship widgets for nobody', 'a var default must self-resolve in runtime mode');
    // bd's missing-variable complaint is PLAIN TEXT on stderr, not JSON —
    // surfaced as a 400 with bd's own wording rather than parsed.
    const gap = await fetch(p('/formulas/smoke-flow/preview?var.owner=alice'));
    assert(gap.status === 400, `an unresolvable runtime preview should 400, got ${gap.status}`);
    assert(/thing/.test((await gap.json()).error || ''), 'the 400 should name the unfilled variable');

    // Dry run: OPAQUE TEXT. bd silently ignores --json here (v1.1.0), so the
    // route must not promise structure — it returns the block verbatim.
    const dry = await fetch(p('/molecules/pour-preview?proto=smoke-flow&var.thing=widgets')).then((r) => r.json());
    assert(dry.ok && typeof dry.preview === 'string', 'pour dry-run must return preview TEXT');
    assert(previewIssueCount(dry.preview) === 3, `dry-run should say 3 issues; got ${JSON.stringify(dry.preview)}`);
    assert(/Design widgets/.test(dry.preview), 'dry-run text should itemize the substituted steps');
    const dryMissing = await fetch(p('/molecules/pour-preview?proto=nope-not-here'));
    assert(dryMissing.status === 404, `dry-run of an unknown proto should 404, got ${dryMissing.status}`);
    assert(!/\/.+\//.test((await dryMissing.json()).error || ''), 'an unknown-proto error must not leak absolute paths');

    // THE write.
    const beforePour = (await fetch(p('/issues')).then((r) => r.json())).issues.length;
    const poured = await fetch(p('/molecules/pour'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proto: 'smoke-flow', vars: { thing: 'widgets' } }),
    }).then((r) => r.json());
    assert(poured.ok && poured.created === 3, `pour should create 3 beads: ${JSON.stringify(poured)}`);
    assert(poured.new_epic_id, 'pour must report the new molecule root id');
    assert(poured.missing.length === 0, `every mapped bead must be observable in the export; missing ${JSON.stringify(poured.missing)}`);

    const afterPour = (await fetch(p('/issues')).then((r) => r.json())).issues;
    assert(afterPour.length === beforePour + 3, `issue count should grow by 3; ${beforePour} -> ${afterPour.length}`);
    const root = afterPour.find((i) => i.id === poured.new_epic_id);
    // The whole reason bd-console-6ag.4 existed: this type is NOT 'epic'.
    assert(root && root.issue_type === 'molecule', `molecule root issue_type must be "molecule"; got ${root?.issue_type}`);
    // ...and the container-grouping pass must nest its steps under it.
    const grouped = containerGroups(afterPour).groups.find((g) => g.container.id === root.id);
    assert(grouped && grouped.children.length === 2, `poured molecule must group its 2 steps; got ${grouped?.children.length}`);
    assert(grouped.children.every((c) => moleculeRootOf(c, afterPour)?.id === root.id), 'each step must resolve back to its root');
    // The `needs` edge became a real `blocks` dependency.
    const ship = grouped.children.find((c) => /^Ship widgets/.test(c.title));
    const design = grouped.children.find((c) => /^Design widgets/.test(c.title));
    assert(ship && design && blockersOf(ship).includes(design.id), 'a formula `needs` must become a blocks dependency');

    const molRes = await fetch(p('/molecules/' + root.id + '?parallel=1')).then((r) => r.json());
    assert(molRes.molecule?.root?.id === root.id, 'GET /api/molecules/:id must return the molecule');
    assert(molRes.progress?.total === 2, `mol progress should report 2 steps; got ${molRes.progress?.total}`);
    assert(molRes.parallel && molRes.parallel.parallel_groups, 'parallel=1 must merge in bd ready --mol data');
    const molMissing = await fetch(p('/molecules/xx-nothere'));
    assert(molMissing.status === 404, `unknown molecule should 404, got ${molMissing.status}`);

    // Burn as undo — dry run first, then the real cascade delete.
    const burnDry = await fetch(p('/molecules/burn-preview?id=' + root.id)).then((r) => r.json());
    assert(burnDry.ok && burnIssueCount(burnDry.preview) === 3, `burn dry-run should list 3 issues; got ${JSON.stringify(burnDry.preview)}`);
    const burned = await fetch(p('/molecules/burn'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: root.id }),
    }).then((r) => r.json());
    assert(burned.ok && burned.deleted_count === 3, `burn should delete 3 beads: ${JSON.stringify(burned)}`);
    assert(burned.deleted.includes(root.id), 'burn response must list the deleted ids (field is `deleted`, not `deleted_ids`)');
    const afterBurn = (await fetch(p('/issues')).then((r) => r.json())).issues;
    assert(afterBurn.length === beforePour, `burn should return the repo to its pre-pour size; ${beforePour} -> ${afterBurn.length}`);
    assert(!afterBurn.some((i) => i.issue_type === 'molecule'), 'no molecule should survive the burn');

    // Validation: garbage never reaches execFile.
    const badProto = await fetch(p('/molecules/pour'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proto: 'a b; rm -rf /', vars: {} }),
    });
    assert(badProto.status === 400, `a shell-ish proto should 400, got ${badProto.status}`);
    const badVarKey = await fetch(p('/molecules/pour'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proto: 'smoke-flow', vars: { 'a b': 'x' } }),
    });
    assert(badVarKey.status === 400, `a non-identifier var key should 400, got ${badVarKey.status}`);

    console.log(`smoke ok (formulas/molecules routes: browse -> preview -> dry-run -> pour(3) -> burn(3)): ${poured.new_epic_id}`);
  }

  // --- bd-console-9it: formula AUTHORING, pure derivations ------------------
  // The naming and candidate rules that decide what the two authoring dialogs
  // put in front of the user. Pure, so they're asserted here rather than only
  // observable by clicking.
  {
    // A step's prerequisites are spelled `needs` by hand and `depends_on` by
    // `bd mol distill` — reading only the first is why every distilled recipe
    // used to preview as if its steps had no order at all.
    assert(stepNeeds({ needs: ['a'] }).join() === 'a', '`needs` must be read');
    assert(stepNeeds({ depends_on: ['b'] }).join() === 'b', 'THE BUG: distill writes `depends_on`, which must be read too');
    assert(stepNeeds({}).length === 0 && stepNeeds(null).length === 0, 'a step with no prerequisites yields []');

    assert(slugifyFormulaName('Release 2.1 hardening!') === 'release-2-1-hardening',
      `formula name slug mismatch: ${slugifyFormulaName('Release 2.1 hardening!')}`);
    assert(slugifyFormulaName('!!!') === '', 'an unusable title yields no name rather than one the server would reject');
    // A version-shaped value gets called `version`, not `v2_1`.
    assert(slugifyVarName('2.1') === 'version' && slugifyVarName('v3') === 'version', 'version-ish values name themselves `version`');
    assert(slugifyVarName('Acme Corp') === 'acme_corp', 'var names are snake_case identifiers');
    assert(/^[A-Za-z0-9_]+$/.test(slugifyVarName('9lives')), 'a var name must satisfy the server VAR_KEY_RE');

    assert(formulaStem('release.formula.json') === 'release' && formulaStem('release.toml') === 'release',
      'the formula stem is the identity bd loads by');
    assert(formulaFileName('release') === 'release.formula.json' && formulaFileName('a.toml') === 'a.toml',
      'a bare name gets the .formula.json bd itself writes');

    // Only strings that RECUR are offered — a variable appearing once is noise.
    const cands = distillCandidates(['Release 2.1', 'Write notes for 2.1', 'Tag version 2.1', 'Announce 2.1']);
    assert(cands.length > 0 && cands[0].value === '2.1' && cands[0].name === 'version',
      `distill candidates should lead with the recurring value: ${JSON.stringify(cands)}`);
    assert(!cands.some((c) => /^announce$/i.test(c.value)), 'a value appearing in exactly one title is not a candidate');
    assert(distillCandidates(['only one title']).length === 0, 'one title cannot establish a recurring value');

    // The local half of the save gate: the two mistakes that make a formula
    // unloadable, caught while typing.
    assert(formulaSaveProblem('starter.formula.json', newFormulaTemplate('starter')) === null,
      'the seeded example must pass the local save gate as-is');
    assert(/must be "starter"/.test(formulaSaveProblem('starter.formula.json', newFormulaTemplate('other')) || ''),
      'a formula whose name disagrees with its filename must be refused locally');
    assert(/JSON/.test(formulaSaveProblem('x.formula.json', '{ nope') || ''), 'unparseable JSON is reported before the round trip');
    assert(formulaSaveProblem('x.formula.json', '   ') !== null, 'an empty draft is refused');

    console.log('smoke ok (formula authoring derivations: needs/depends_on, name slugs, recurring-value candidates, save gate)');
  }

  // --- bd-console-9it: formula AUTHORING routes, end to end ----------------
  // THE dead end this closes: `bd formula` has list/show/convert and NO create
  // (re-verified on v1.1.0), so the pour flow's prerequisite could not be
  // produced anywhere in the product. Both authoring paths are exercised here
  // against the real bd, and both are proven to end in a formula that POURS.
  {
    const fmt = { method: 'POST', headers: { 'content-type': 'application/json' } };
    const postJson = (path, body) => fetch(p(path), { ...fmt, body: JSON.stringify(body) });

    // --- path safety, before anything is written -------------------------
    for (const bad of ['../../etc/passwd', '../evil.formula.json', 'sub/dir.formula.json', '.hidden.json', 'evil.sh', 'noext']) {
      const r = await fetch(p('/formula-file?name=' + encodeURIComponent(bad)));
      assert(r.status === 400, `reading "${bad}" must 400, got ${r.status}`);
      const w = await postJson('/formula-file', { name: bad, content: '{}' });
      assert(w.status === 400, `writing "${bad}" must 400, got ${w.status}`);
    }
    // ...and the same for the name distill would use as a FILENAME. bd itself
    // does not sanitize it — `bd mol distill <epic> ../evil` writes outside the
    // formulas directory (reproduced on v1.1.0) — so this check is the only
    // thing between a URL and that.
    const evilDistill = await fetch(p('/formula-distill-preview?epic=' + encodeURIComponent(seedId) + '&name=' + encodeURIComponent('../evil')));
    assert(evilDistill.status === 400, `a traversal formula name must 400, got ${evilDistill.status}`);

    // --- editor round trip: write -> read -> list -> pour -----------------
    const seeded = newFormulaTemplate('smoke-seed');
    const written = await postJson('/formula-file', { name: 'smoke-seed.formula.json', content: seeded });
    const writtenBody = await written.json();
    assert(written.status === 200, `writing the seeded example must succeed, got ${written.status}: ${JSON.stringify(writtenBody)}`);
    assert(writtenBody.formula === 'smoke-seed' && writtenBody.steps === 3,
      `write response mismatch: ${JSON.stringify(writtenBody)}`);

    const readBack = await fetch(p('/formula-file?name=smoke-seed.formula.json')).then((r) => r.json());
    assert(readBack.content === seeded, 'a formula must read back byte-for-byte');

    const fileList = await fetch(p('/formula-files')).then((r) => r.json());
    assert(fileList.dir && !fileList.dir.startsWith('/'), `the formulas dir must be reported project-relative, got ${fileList.dir}`);
    assert(fileList.files.some((f) => f.name === 'smoke-seed.formula.json' && f.formula === 'smoke-seed'),
      `formula-files must list what was just written: ${JSON.stringify(fileList.files)}`);

    // It reaches the Molecules dialog (which lists via `bd formula list`)...
    const listedAfterWrite = await fetch(p('/formulas')).then((r) => r.json());
    assert(listedAfterWrite.formulas.some((f) => f.name === 'smoke-seed'),
      'a formula written through the editor must appear in the pour dialog');
    // ...and it actually pours. This is the whole point of seeding a WORKING
    // example rather than an empty file: a beginner's first save validates and
    // their first pour succeeds.
    const seedPour = await postJson('/molecules/pour', { proto: 'smoke-seed', vars: { thing: 'onboarding' } }).then((r) => r.json());
    assert(seedPour.ok && seedPour.created === 4, `the seeded example must pour 4 beads: ${JSON.stringify(seedPour)}`);
    await postJson('/molecules/burn', { id: seedPour.new_epic_id });

    // --- validation happens BEFORE the write ------------------------------
    // A malformed formula file is silently SKIPPED by `bd formula list` rather
    // than reported (verified) — the recipe would just vanish — so a bad draft
    // must never reach the disk in the first place.
    const formulaDirPath = join(repoDir, '.beads', 'formulas');
    const malformed = await postJson('/formula-file', { name: 'smoke-bad.formula.json', content: '{ not json' });
    assert(malformed.status === 400, `malformed JSON must 400, got ${malformed.status}`);
    assert(/json|parse/i.test((await malformed.json()).error || ''), "the rejection should carry bd's own parse error");
    assert(!existsSync(join(formulaDirPath, 'smoke-bad.formula.json')), 'THE RULE: a rejected formula must not be written at all');

    // A dangling `needs` is caught by bd's own validator.
    const dangling = await postJson('/formula-file', {
      name: 'smoke-dangle.formula.json',
      content: JSON.stringify({ formula: 'smoke-dangle', version: 1, type: 'workflow', steps: [{ id: 'a', title: 'A', type: 'task', needs: ['ghost'] }] }),
    });
    assert(dangling.status === 400 && /unknown step/i.test((await dangling.json()).error || ''), 'a dangling `needs` must be refused');
    assert(!existsSync(join(formulaDirPath, 'smoke-dangle.formula.json')), 'a structurally invalid formula must not be written');

    // The trap that motivated the stem check: `bd formula list` reports the
    // name from the file CONTENT, but show/cook/pour resolve by FILE BASENAME.
    // A mismatch therefore lists under a name nothing can open.
    const mismatch = await postJson('/formula-file', {
      name: 'smoke-outer.formula.json',
      content: JSON.stringify({ formula: 'smoke-inner', version: 1, type: 'workflow', steps: [{ id: 'a', title: 'A', type: 'task' }] }),
    });
    assert(mismatch.status === 400, `a name/filename mismatch must 400, got ${mismatch.status}`);
    assert(!existsSync(join(formulaDirPath, 'smoke-outer.formula.json')), 'a name/filename mismatch must not be written');
    // An empty step list pours a molecule with nothing in it — bd allows it,
    // this doesn't.
    const stepless = await postJson('/formula-file', {
      name: 'smoke-empty.formula.json',
      content: JSON.stringify({ formula: 'smoke-empty', version: 1, type: 'workflow', steps: [] }),
    });
    assert(stepless.status === 400, `a step-less formula must 400, got ${stepless.status}`);

    // --- distill round trip: epic -> formula -> pour ----------------------
    const epicId = (await postJson('/create', { title: 'Ship release 4.2', type: 'epic', priority: 1 }).then((r) => r.json())).id;
    const kid1 = (await postJson('/create', { title: 'Write notes for 4.2', type: 'task', parent: epicId }).then((r) => r.json())).id;
    const kid2 = (await postJson('/create', { title: 'Tag version 4.2', type: 'task', parent: epicId }).then((r) => r.json())).id;
    await postJson('/edit', { id: kid2, op: 'add-blocker', blocker: kid1 });

    // A childless bead has no shape to save; bd would happily write a 0-step
    // formula for one (verified), which lists fine and pours nothing.
    const childless = await postJson('/formula-distill', { epic: kid1, name: 'smoke-nothing' });
    assert(childless.status === 400, `distilling a childless bead must 400, got ${childless.status}`);

    const distillVars = 'var.version=4.2';
    const distillDry = await fetch(p(`/formula-distill-preview?epic=${epicId}&name=smoke-release&${distillVars}`)).then((r) => r.json());
    // OPAQUE TEXT, exactly like the pour dry run: bd silently ignores --json on
    // every --dry-run path, re-verified for distill on v1.1.0.
    assert(distillDry.ok && typeof distillDry.preview === 'string', 'the distill dry run must return preview TEXT');
    assert(/\{\{version\}\}/.test(distillDry.preview), `the dry run must show the marked blanks: ${distillDry.preview}`);
    assert(!/\/[^\s]*\/[^\s]*formulas/.test(distillDry.preview), `the dry run must not leak absolute host paths: ${distillDry.preview}`);

    const distilled = await postJson('/formula-distill', { epic: epicId, name: 'smoke-release', vars: { version: '4.2' } }).then((r) => r.json());
    assert(distilled.ok && distilled.steps === 2, `distill should capture 2 steps: ${JSON.stringify(distilled)}`);
    assert(distilled.file === 'smoke-release.formula.json', `distill file mismatch: ${distilled.file}`);
    assert(distilled.variables.includes('version'), 'distill must report the variables it created');

    // Overwrite is opt-in — `bd mol distill` clobbers silently otherwise.
    const clobber = await postJson('/formula-distill', { epic: epicId, name: 'smoke-release', vars: {} });
    assert(clobber.status === 409, `re-distilling onto an existing name must 409 without overwrite, got ${clobber.status}`);

    // It shows up in the Molecules dialog...
    const listedAfterDistill = await fetch(p('/formulas')).then((r) => r.json());
    assert(listedAfterDistill.formulas.some((f) => f.name === 'smoke-release'),
      'a distilled formula must appear in the pour dialog');
    // ...its steps carry `depends_on` (not `needs`), which is why stepNeeds()
    // above has to read both...
    const distilledDoc = (await fetch(p('/formulas/smoke-release')).then((r) => r.json())).formula;
    const wired = distilledDoc.steps.find((s) => stepNeeds(s).length > 0);
    assert(wired && Array.isArray(wired.depends_on), `distill must emit depends_on, got ${JSON.stringify(distilledDoc.steps)}`);
    // ...and it pours, reproducing the original epic's shape for a new version.
    const rePour = await postJson('/molecules/pour', { proto: 'smoke-release', vars: { version: '5.0' } }).then((r) => r.json());
    assert(rePour.ok && rePour.created === 3, `the distilled formula must pour 3 beads: ${JSON.stringify(rePour)}`);
    const rePoured = (await fetch(p('/issues')).then((r) => r.json())).issues;
    const tagStep = rePoured.find((i) => i.title === 'Tag version 5.0');
    const notesStep = rePoured.find((i) => i.title === 'Write notes for 5.0');
    assert(tagStep && notesStep, `the distilled variable must substitute on pour: ${JSON.stringify(rePoured.map((i) => i.title))}`);
    assert(blockersOf(tagStep).includes(notesStep.id), 'the original epic\'s blocking order must survive the round trip');
    await postJson('/molecules/burn', { id: rePour.new_epic_id });

    console.log(`smoke ok (formula authoring routes: editor write->pour(4), traversal/extension/malformed rejected pre-write, distill ${epicId}->smoke-release->pour(3))`);
  }
}
