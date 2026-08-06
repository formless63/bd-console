// smoke: hash routing, route contracts, and the learn layer hung off them.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs routing
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LINK_TYPES as UI_LINK_TYPES } from '../../public/ui/relationships.js';
// Progressive-discoverability engine (public/ui/learn.js) — same import-free
// contract as relationships.js, precisely so its lifecycle rules ("shows
// once, dismissal is permanent, doing the thing retires the hint") are
// assertable here rather than only observable by clicking around a browser.
import {
  createLearnStore, learnContext, CONCEPTS, CONCEPT_GROUPS, HINTS, concept,
  conceptHref, isLearnHash, learnAnchorFromHash, LEARN_KEY,
} from '../../public/ui/learn.js';
// Hash router (public/ui/routing.js) — pure and import-free for the same
// reason relationships.js is: store.js's parseHash() is signal-bound and can't
// be loaded in Node, but the retired-route redirect it wraps has to be
// asserted somewhere other than a browser.
import { legacyProjectHash, parseRoute } from '../../public/ui/routing.js';

export async function runRouting(ctx) {
  const { assert } = ctx;

  // --- progressive discoverability: learn.js lifecycle (pure) --------------
  // The whole promise of this layer is "never nags": a nudge appears in ONE
  // session, a dismissal is permanent across reloads, and doing the thing the
  // nudge was about retires it whether or not it was ever seen. Those are
  // storage-shaped promises, which is exactly the kind that rot silently — so
  // they're asserted against a fake localStorage here, with no browser.
  {
    // A fake localStorage. `dump` is the persisted bytes, so "survives a
    // reload" can be tested honestly: a second store instance reading the same
    // bytes IS a reload.
    const fakeStorage = () => {
      const m = new Map();
      return {
        map: m,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    };

    // Every concept the UI links to must exist, and every hint must point at a
    // real concept — a dead "Read more" is worse than no tooltip at all.
    const requiredConcepts = [
      'bead', 'epic', 'molecule', 'formula', 'ready', 'blocked', 'triage',
      'blocks', 'related', 'discovered-from', 'tracks', 'until', 'caused-by',
      'validates', 'relates-to', 'supersedes', 'parent-child',
    ];
    for (const key of requiredConcepts) {
      const c = concept(key);
      assert(c, `learn.js is missing a definition for "${key}"`);
      assert(c.short && c.when && c.body, `concept "${key}" must define short/when/body`);
    }
    // Every one of bd's 10 link types is explained, by its own bd name.
    for (const t of UI_LINK_TYPES) assert(concept(t), `link type "${t}" has no plain-language definition`);
    for (const c of CONCEPTS) {
      assert(CONCEPT_GROUPS.some((g) => g.id === c.group), `concept "${c.key}" is in unknown group "${c.group}"`);
    }
    for (const h of HINTS) assert(!h.concept || concept(h.concept), `hint "${h.id}" points at a missing concept`);
    assert(isLearnHash('#/learn') && isLearnHash('#/learn/blocks'), '#/learn must be recognised as the learn route');
    assert(!isLearnHash('#/p2/x') && !isLearnHash('#/learnedstuff'), 'only #/learn is the learn route');
    assert(learnAnchorFromHash(conceptHref('blocks')) === 'blocks', 'concept deep links must round-trip');
    assert(learnAnchorFromHash('#/learn/not-a-concept') === null, 'unknown anchors must not resolve');

    // Context derivation: parent-child is containment, not a link the user had
    // to reason about, so an epic-with-children project still reads as "has
    // never used a link" and still gets taught what links are.
    const now = Date.UTC(2026, 0, 30);
    const fresh = new Date(now - 2 * 86400000).toISOString();
    const ancient = new Date(now - 40 * 86400000).toISOString();
    const issues = [
      { id: 'a-1', issue_type: 'epic', status: 'open', updated_at: fresh, dependencies: [] },
      { id: 'a-2', issue_type: 'task', status: 'open', updated_at: fresh, dependencies: [{ depends_on_id: 'a-1', type: 'parent-child' }] },
      { id: 'a-3', issue_type: 'task', status: 'open', updated_at: ancient, dependencies: [] },
      { id: 'a-4', issue_type: 'task', status: 'closed', updated_at: ancient, dependencies: [] },
      // Padding to clear the "links-none" hint's 6-issue floor — a project
      // with three beads in it is not one that needs a lecture about graphs.
      { id: 'a-5', issue_type: 'task', status: 'open', updated_at: fresh, dependencies: [] },
      { id: 'a-6', issue_type: 'bug', status: 'open', updated_at: fresh, dependencies: [] },
      { id: 'a-7', issue_type: 'chore', status: 'open', updated_at: fresh, dependencies: [] },
    ];
    const ctx = learnContext(issues, { now, formulas: 2 });
    assert(ctx.issues === 7 && ctx.open === 6, `learnContext counts: ${JSON.stringify(ctx)}`);
    assert(ctx.links === 0, 'parent-child alone must not count as "this project uses links"');
    assert(ctx.containers === 1 && ctx.molecules === 0, 'epic counts as a container, not a molecule');
    assert(ctx.staleOpen === 1, 'only the open 40-day-old issue is stale (the closed one is not)');
    assert(learnContext([{ id: 'b', dependencies: [{ depends_on_id: 'c', type: 'blocks' }] }]).links === 1,
      'a blocks row is a link');

    const ctxLinked = learnContext([...issues, { id: 'a-8', issue_type: 'task', status: 'open', updated_at: fresh, dependencies: [{ depends_on_id: 'a-3', type: 'blocks' }] }], { now, formulas: 2 });

    // A hint shows ONCE. Not once per page load — once, full stop.
    {
      const storage = fakeStorage();
      const s = createLearnStore(storage);
      assert(s.shouldShow('links-none', ctx), 'a 6+ issue project with no links should be taught what links are');
      assert(s.noteShown('links-none') === true, 'the single permitted appearance retires the hint');
      assert(!s.shouldShow('links-none', ctx), 'a shown hint must not show again');
      // Same persisted bytes, new instance == a page reload.
      const reloaded = createLearnStore(storage);
      assert(!reloaded.shouldShow('links-none', ctx), 'a shown hint must not come back after a reload');
      // noteShown is idempotent within a session so a remount can't double-count.
      const s2 = createLearnStore(fakeStorage());
      s2.noteShown('links-none'); s2.noteShown('links-none'); s2.noteShown('links-none');
      assert(s2.snapshot().hints['links-none'].shows === 1, 'a remount must not spend more than one appearance');
    }

    // Dismissal is permanent, and survives a reload.
    {
      const storage = fakeStorage();
      const s = createLearnStore(storage);
      assert(s.shouldShow('links-none', ctx), 'precondition: hint is showable');
      s.dismiss('links-none');
      assert(!s.shouldShow('links-none', ctx), 'a dismissed hint is gone immediately');
      assert(storage.getItem(LEARN_KEY), 'dismissal must be written to storage, not just memory');
      const reloaded = createLearnStore(storage);
      assert(reloaded.status('links-none') === 'dismissed', 'dismissal must survive a reload');
      assert(!reloaded.shouldShow('links-none', ctx), 'a dismissed hint must not return after a reload');
      assert(reloaded.pickNudge(ctx)?.id !== 'links-none', 'a dismissed hint must not be picked');
    }

    // Retirement, both ways: by doing the thing (recordAction, fired from the
    // write path itself) and by the data showing it was already done.
    {
      const s = createLearnStore(fakeStorage());
      assert(s.shouldShow('links-none', ctx), 'precondition');
      assert(s.recordAction('link') === true, 'creating a link retires the "no links" hint');
      assert(s.status('links-none') === 'retired', 'retired, not merely hidden');
      assert(!s.shouldShow('links-none', ctx), 'a retired hint never shows, even though its condition still holds');
      assert(s.recordAction('link') === false, 'a second link changes nothing');

      const s2 = createLearnStore(fakeStorage());
      assert(!s2.shouldShow('links-none', ctxLinked), 'a project that already has links is never taught about links');
      s2.evaluate(ctxLinked);
      assert(s2.status('links-none') === 'retired', 'an already-outgrown hint retires silently, so it can never surface later');

      // Molecules: pouring one retires the "you have recipes you never use" hint.
      const s3 = createLearnStore(fakeStorage());
      assert(s3.shouldShow('formulas-unused', ctx), 'formulas present + no molecules poured should nudge');
      s3.recordAction('pour');
      assert(!s3.shouldShow('formulas-unused', ctx), 'pouring retires the molecules nudge');
      assert(!createLearnStore(fakeStorage()).shouldShow('formulas-unused', learnContext(issues, { now, formulas: 0 })),
        'no formulas, no molecule nudge');
    }

    // Exactly one nudge is ever offered, and it is the highest-priority one.
    {
      const s = createLearnStore(fakeStorage());
      const busy = learnContext(
        Array.from({ length: 14 }, (_, n) => ({ id: 'z-' + n, issue_type: 'task', status: 'open', updated_at: ancient, dependencies: [] })),
        { now, formulas: 3 },
      );
      assert(busy.issues === 14 && busy.links === 0 && busy.containers === 0 && busy.staleOpen === 14,
        `context for the all-hints-true case: ${JSON.stringify(busy)}`);
      const showable = HINTS.filter((h) => s.shouldShow(h.id, busy));
      assert(showable.length === 4, `all four hints are individually true here, got ${showable.length}`);
      const picked = s.pickNudge(busy);
      assert(picked && picked.id === 'links-none', `pickNudge must return exactly the top-priority hint, got ${picked?.id}`);
    }

    // The master switch: off suppresses every nudge, and nothing else. The
    // glossary is reference, not a tutorial, and stays available forever.
    {
      const storage = fakeStorage();
      const s = createLearnStore(storage);
      s.setEnabled(false);
      assert(!s.isEnabled(), 'master switch off');
      for (const h of HINTS) assert(!s.shouldShow(h.id, ctx), `hint "${h.id}" must be suppressed while hints are off`);
      assert(s.pickNudge(ctx) === null, 'no nudge is ever picked while hints are off');
      // Tooltips/#/learn read CONCEPTS directly and never consult the store —
      // asserted structurally: the glossary is a module constant, not state.
      assert(concept('molecule').short.length > 0 && CONCEPTS.length >= 25,
        'the concept glossary must remain fully available with hints off');
      assert(createLearnStore(storage).isEnabled() === false, 'the master switch persists across a reload');
      // ...and back on, with a clean slate.
      const s2 = createLearnStore(storage);
      s2.dismiss('stale-open');
      s2.reset();
      assert(s2.isEnabled() && s2.status('stale-open') === 'new', 'reset re-enables hints and un-dismisses everything');
      assert(createLearnStore(storage).status('stale-open') === 'new', 'reset persists');
    }

    // Corrupt/foreign storage must degrade to defaults, never throw: this runs
    // on every page load in every browser, including ones with junk under the key.
    {
      const storage = fakeStorage();
      storage.setItem(LEARN_KEY, '{not json');
      assert(createLearnStore(storage).isEnabled(), 'unparseable state falls back to defaults');
      storage.setItem(LEARN_KEY, JSON.stringify({ v: 99, enabled: false }));
      assert(createLearnStore(storage).isEnabled(), 'a future schema version is ignored, not obeyed');
    }

    console.log(`smoke ok (learn.js: ${CONCEPTS.length} concepts, ${HINTS.length} hints, one-shot + dismissal + retirement + master switch)`);
  }

  // --- bd-console-0nd: the retired classic route must REDIRECT ------------
  // #/p/<id> and #/p/<id>/docs were the classic per-project view. It is gone;
  // Console 2.0 (#/p2/<id>) is the only per-project view. Bookmarks and links
  // to the old hashes have to land on the project, NOT 404 and NOT fall back
  // to the hub — that's the whole point of retiring it as a route rather than
  // deleting it. store.js's parseHash() wraps these two pure functions with
  // the browser-only half (history.replaceState), which is why they live in
  // an import-free module: this is assertable here.
  {
    assert(legacyProjectHash('#/p/bd-console') === '#/p2/bd-console', '#/p/<id> must redirect to #/p2/<id>');
    assert(legacyProjectHash('#/p/bd-console/docs') === '#/p2/bd-console', "the classic Docs tab must redirect to the project's Console 2.0 view");
    assert(legacyProjectHash('#/p/my%20repo/docs') === '#/p2/my%20repo', 'the project segment must pass through still-encoded');
    // Nothing else may be rewritten — a redirect that fires on #/p2 would be
    // an infinite loop, and one that fires on a hub-level route would strand
    // it.
    for (const h of ['#/p2/bd-console', '#/', '', '#/tmux', '#/schedule', '#/settings', '#/learn', '#/p']) {
      assert(legacyProjectHash(h) === null, `${h || '(empty)'} must not be treated as a retired classic route`);
    }

    // Belt and braces: even if the URL rewrite can't run, the retired hash
    // still resolves to the project, never to the hub.
    assert(parseRoute('#/p/bd-console').view === 'console2', '#/p/<id> must parse as the console2 view');
    assert(parseRoute('#/p/bd-console').projectId === 'bd-console', '#/p/<id> must keep its project id');
    assert(parseRoute('#/p/bd-console/docs').projectId === 'bd-console', 'the docs tab suffix must not change the project');
    assert(parseRoute('#/p2/my%20repo').projectId === 'my repo', 'the project id must be decoded once');
    // Hub-level routes still route — they no longer have a per-project top bar
    // linking to them, so a regression here would strand them.
    assert(parseRoute('#/tmux').view === 'tmux', '#/tmux must still route');
    assert(parseRoute('#/schedule').view === 'schedule', '#/schedule must still route');
    assert(parseRoute('#/settings').view === 'settings', '#/settings must still route');
    assert(parseRoute('#/').view === 'hub' && parseRoute('').view === 'hub' && parseRoute('#/nope').view === 'hub',
      'anything unrecognised falls back to the hub');

    // The classic components must be gone, not merely unlinked.
    for (const f of ['ProjectView.js', 'DocsView.js', 'IssueList.js', 'IssueDetail.js', 'FiltersPane.js']) {
      assert(!existsSync(resolve(join(process.cwd(), 'public', 'ui', 'components', f))),
        `public/ui/components/${f} is a retired classic-view component and must not come back`);
    }
    const routedSrc = readFileSync(resolve(join(process.cwd(), 'public', 'app.js')), 'utf8')
      + readFileSync(resolve(join(process.cwd(), 'public', 'ui', 'components', 'App.js')), 'utf8')
      + readFileSync(resolve(join(process.cwd(), 'public', 'ui', 'console2', 'Console2.js')), 'utf8');
    assert(!/['"`]#\/p\/|view === 'project'/.test(routedSrc),
      "nothing may link to #/p/<id> or branch on the retired 'project' view any more");
    console.log('smoke ok (bd-console-0nd: classic view retired — #/p/<id> and #/p/<id>/docs redirect to #/p2/<id>, hub routes intact)');
  }

  // --- hub-route contract: public/ui/api.js HUB_PATHS vs lib/routes.mjs ------
  // bd-console-xsv: lib/routes.mjs matches hub-level routes on the UNPREFIXED
  // path, so calling one through the prefixing apiGet/apiPost 404s in a way
  // that most of these endpoints already treat as "feature unavailable" — i.e.
  // silently. api.js now throws on that instead, but only for paths it KNOWS
  // are hub-level, which makes the list itself the thing that can rot. This
  // asserts it can't: a new hub route has to be declared, and a retired one
  // has to be removed. Source-level on purpose — api.js imports store.js
  // (signals, bare specifiers) and so isn't importable in plain Node.
  {
    const routesSrc = readFileSync(resolve(join(process.cwd(), 'lib', 'routes.mjs')), 'utf8');
    const apiSrc = readFileSync(resolve(join(process.cwd(), 'public', 'ui', 'api.js')), 'utf8');
    const served = new Set([...routesSrc.matchAll(/originalPath === '(\/api\/[^']+)'/g)].map((m) => m[1]));
    const block = apiSrc.match(/export const HUB_PATHS = new Set\(\[([\s\S]*?)\]\)/);
    assert(block, 'public/ui/api.js must export a HUB_PATHS set');
    const declared = new Set([...block[1].matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1]));
    assert(served.size > 0 && declared.size > 0, 'hub-route contract check found nothing to compare — the source scrape has drifted');
    const undeclared = [...served].filter((x) => !declared.has(x));
    const stale = [...declared].filter((x) => !served.has(x));
    assert(undeclared.length === 0,
      `lib/routes.mjs serves ${undeclared.join(', ')} on the unprefixed path, but HUB_PATHS in public/ui/api.js doesn't list it — add it there, or the first project-scoped view that calls it through apiGet/apiPost will 404 silently (bd-console-xsv)`);
    assert(stale.length === 0,
      `HUB_PATHS in public/ui/api.js lists ${stale.join(', ')}, which lib/routes.mjs no longer serves hub-level — remove it, or apiGet/apiPost will throw on a path that is now project-scoped`);
    console.log(`smoke ok (hub-route contract: ${declared.size} hub-level routes declared in api.js match lib/routes.mjs)`);
  }
}
