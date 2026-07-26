// learn.js — the progressive-discoverability engine.
//
// The problem this solves: most people using bd-console are not professional
// developers and will learn beads FROM this UI. They don't know the commands,
// they don't know what "discovered-from" means, and they have never heard of a
// molecule. But they are also not students — after two weeks they know all of
// it, and anything that still explains itself at that point is noise.
//
// So teaching here is split into three layers that decay at three different
// rates, and only the third one is stateful:
//
//   1. REFERENCE  — the concept glossary below + the #/learn page. Always
//      available, never nagging, never retired. Looking a word up is a thing
//      you do in year three as well as day one, so this layer has no lifecycle
//      and is deliberately NOT gated by the master switch.
//   2. EMPTY STATES — a section with nothing in it explains what belongs there.
//      Self-retiring by construction: the explanation is literally replaced by
//      the user's own content the moment they have any. No persistence needed.
//   3. NUDGES — state-aware, at most ONE visible anywhere at a time, shown in
//      at most one session each, permanently dismissible, and auto-retired the
//      moment the user demonstrably does the thing (either because the data
//      now shows it, or because they performed the matching action anywhere in
//      the app). This is the only layer with storage, and the only layer the
//      "Show learning hints" master switch turns off.
//
// DEPENDENCY-FREE ON PURPOSE. No preact, no signals, no imports at all — the
// same contract relationships.js and console2/graphModel.js hold — so
// scripts/smoke.mjs can import this file in plain Node and assert the hint
// lifecycle without a browser. Reactivity is a hand-rolled subscribe/notify
// (see subscribe() below); the UI layer wraps it in a hook.

// ---------------------------------------------------------------------------
// Concept glossary — layer 1
//
// Written for someone who has never used an issue tracker, let alone beads.
// `short` is what the tooltip leads with (one sentence, no jargon); `when` is
// the part people actually need ("when would I use this?"); `example` makes it
// concrete. The #/learn page renders all of it; the tooltip renders short +
// when and links to the page for the rest.
// ---------------------------------------------------------------------------

export const CONCEPT_GROUPS = [
  { id: 'basics', title: 'The basics', blurb: 'What the things on screen are.' },
  { id: 'states', title: 'States', blurb: 'What a piece of work can be doing right now. Most of these are worked out for you — you never set them by hand.' },
  { id: 'links', title: 'Links between issues', blurb: 'A link says how two pieces of work relate. Only one kind (blocks) changes what you can work on; the rest are memory — they record why things are the way they are, so the reason survives after everyone forgets.' },
  { id: 'molecules', title: 'Molecules and formulas', blurb: 'A way to create a whole set of related issues at once instead of typing them out every time.' },
];

export const CONCEPTS = Object.freeze([
  {
    key: 'bead',
    term: 'bead',
    group: 'basics',
    short: 'One piece of work. "Bead" and "issue" mean exactly the same thing here.',
    body: 'A bead is a single thing to do, with a title, a description, a priority and a status. The tool is called beads because a project is a string of them, connected to each other. Everywhere this app says "issue", beads says "bead" — they are the same object, and you will see both words.',
    when: 'Anything you might otherwise write on a sticky note or a to-do list is a bead.',
    example: '"Fix the login button on mobile" is one bead.',
  },
  {
    key: 'type',
    term: 'issue type',
    group: 'basics',
    short: 'What kind of work this is: bug, feature, task, chore, epic or molecule.',
    body: 'The type is a label for the nature of the work, not its importance. bug = something is broken. feature = something new. task = a plain piece of work. chore = maintenance nobody will thank you for. epic and molecule are containers — they hold other beads rather than being work themselves.',
    when: 'Pick the one that reads truest. Nothing in the tool behaves differently because of it, except that epics and molecules group their children.',
    example: 'A "New feature" chip in the New-issue dialog creates a bead of type feature.',
  },
  {
    key: 'priority',
    term: 'priority',
    group: 'basics',
    short: 'How urgent this is, from P0 (drop everything) to P4 (someday).',
    body: 'P0 is an emergency, P1 is important, P2 is normal, P3 is the default for a quick capture, and P4 is "if there is ever time". Priority sorts lists and colours the little pip on each card. It does not stop you working on anything.',
    when: 'Set it honestly. If everything is P0, nothing is.',
    example: 'A typo on an internal page is a P4. The site being down is a P0.',
  },
  {
    key: 'label',
    term: 'label',
    group: 'basics',
    short: 'A free-form tag you stick on a bead so you can find it again.',
    body: 'Labels are just words. You invent them; nothing validates them. They are the cheapest way to slice your work — by area, by customer, by "needs a decision".',
    when: 'Use one when you will later want to ask "show me all the X ones".',
    example: 'docs, mobile, needs-design, doc:README.md (this app adds that last one for you when you promote a doc excerpt into an issue).',
  },
  {
    key: 'triage',
    term: 'triage',
    group: 'basics',
    short: 'The inbox. A label meaning "captured, not thought about yet".',
    body: 'Triage is not a status — it is a plain label this app puts on anything you capture quickly, so that half-formed thoughts land somewhere instead of being lost. The Triage lane is simply every open bead carrying that label. Sorting a bead out of triage means giving it a real priority, maybe a parent, and removing the label.',
    when: 'Capture first, think later. Type a thought into the omnibar and press Enter — it becomes a triage bead and you get back to what you were doing.',
    example: 'Typing "the export is slow on big repos" into the omnibar creates a P3 task labelled triage.',
  },
  {
    key: 'epic',
    term: 'epic',
    group: 'basics',
    short: 'A container bead that holds a group of related beads.',
    body: 'An epic is a bead whose job is to hold other beads rather than to be worked itself. Give it a name like a chapter heading, then set it as the parent of everything that belongs to it. The Flow view can then group your work into one row per epic with a progress bar, instead of one flat list.',
    when: 'Once you have more than a dozen beads, or as soon as several of them are obviously the same project.',
    example: 'An epic called "Mobile redesign" holding nine beads, three of them closed.',
  },
  {
    key: 'ready',
    term: 'ready',
    group: 'states',
    short: 'Nothing is standing in the way — you could start this right now.',
    body: 'Ready is worked out for you, not set by you. A bead is ready when it is open, nothing that blocks it is still open, and it is not a container (epics and molecules are never "ready" — their steps are). This is the answer to "what should I do next?", which is the single most useful thing the tool computes.',
    when: 'Look at the Ready lane when you finish something and want the next piece of real work.',
    example: 'Type ready in the omnibar to focus the Ready lane.',
  },
  {
    key: 'blocked',
    term: 'blocked',
    group: 'states',
    short: 'Something else has to finish first, so this cannot start yet.',
    body: 'Blocked is also worked out for you: a bead is blocked when at least one of the beads it depends on is still open. Close the blocker and this one becomes ready automatically — you never move it by hand. That is the whole point of recording a blocks link: the tool does the bookkeeping.',
    when: 'You do not set "blocked". You record what blocks what, and blocked follows.',
    example: '"Ship the new pricing page" is blocked by "Legal signs off on the copy".',
  },
  {
    key: 'in_progress',
    term: 'in progress',
    group: 'states',
    short: 'Someone is actively working on this right now.',
    body: 'Claiming a bead puts your name on it and marks it in progress. It is a courtesy to everyone else looking at the same board, and it is how the age chips work — an in-progress bead starts ageing, going amber after a day and red after three.',
    when: 'Claim it when you actually start, not when you plan to.',
    example: 'The claim button on a card runs bd update <id> --claim.',
  },
  {
    key: 'deferred',
    term: 'deferred',
    group: 'states',
    short: 'Parked until a date. It disappears from Ready until then, and comes back on its own.',
    body: 'Deferring is the honest alternative to leaving something rotting at the top of your list. You say "not before next Monday" and the bead stops being offered as ready work until that date passes, at which point it returns by itself.',
    when: 'When something is genuinely fine to ignore until a known date — you are waiting on a release, a season, a person coming back from leave.',
    example: 'Defer with +2d, next monday, or a date like 2026-08-01.',
  },
  {
    key: 'stale',
    term: 'stale',
    group: 'states',
    short: 'Open, but nobody has touched it in three weeks.',
    body: 'Stale is a warning, not a status. Anything still open and untouched for 21 days gets flagged. It usually means one of three things: it is actually done and nobody closed it, it is blocked by something nobody recorded, or it was never really going to happen.',
    when: 'Skim the stale list once in a while and be ruthless — close, defer, or record what is actually blocking it.',
    example: 'Type stale in the omnibar to highlight them.',
  },
  {
    key: 'closed',
    term: 'closed',
    group: 'states',
    short: 'Done, or decided against. Closed beads stay searchable forever.',
    body: 'Closing is not deleting. A closed bead keeps its history, its comments and its links, and can be reopened. You can also give a reason when you close, which is worth doing when the answer was "we decided not to" rather than "we did it".',
    when: 'Close it the moment it is finished. A board you trust is one where closed means closed.',
    example: 'bd close <id> --reason "shipped in 2.1"',
  },

  // --- links ---------------------------------------------------------------
  {
    key: 'blocks',
    term: 'blocks',
    group: 'links',
    linkType: 'blocks',
    direction: 'Blocked by ↔ Blocks',
    short: 'This cannot start until that one is finished.',
    body: 'The only link type that changes what you can work on. Recording it is what makes the Ready lane trustworthy and what draws the dependency Map: blockers on the left, the work that waits on them to the right.',
    when: 'Whenever you catch yourself thinking "we cannot do this one yet because of that one".',
    example: '"Launch the newsletter" is blocked by "Buy the mailing-list plan".',
  },
  {
    key: 'parent-child',
    term: 'parent-child',
    group: 'links',
    linkType: 'parent-child',
    direction: 'Parent ↔ Children',
    short: 'This belongs inside that. It is how an epic holds its work.',
    body: 'Containment, not order. Setting a parent puts a bead inside an epic (or inside a molecule, which is the same structure with a different name). It does not block anything and it does not imply a sequence — it just says which chapter this page is in.',
    when: 'When a bead is obviously part of a bigger named effort.',
    example: '"Fix the mobile nav" has the parent epic "Mobile redesign".',
  },
  {
    key: 'related',
    term: 'related',
    group: 'links',
    linkType: 'related',
    direction: 'Related ↔ Related (both ways)',
    short: 'See also. These two are worth reading together, in no particular order.',
    body: 'The weakest and most useful link. It carries no meaning beyond "if you are looking at one of these, you probably want to know about the other". It reads the same from both ends, so it only needs recording once.',
    when: 'Two beads touch the same area, or one will probably change the other, but neither blocks the other.',
    example: '"Rewrite the signup email" is related to "Change the signup form copy".',
  },
  {
    key: 'relates-to',
    term: 'relates-to',
    group: 'links',
    linkType: 'relates-to',
    direction: 'Related ↔ Related (both ways)',
    short: 'The same "see also" as related — a second spelling beads accepts.',
    body: 'beads has two names for the bidirectional see-also edge because two different commands create it. This app treats them as one thing and renders the link once, from whichever side it was recorded. Pick either; there is no behavioural difference.',
    when: 'Same as related. If you are choosing from the dropdown, related is the one to pick.',
    example: 'bd dep relate A B writes relates-to on both beads.',
  },
  {
    key: 'discovered-from',
    term: 'discovered-from',
    group: 'links',
    linkType: 'discovered-from',
    direction: 'Discovered from ↔ Discovered',
    short: 'This idea came out of working on that one.',
    body: 'Provenance. When you are doing one thing and notice a second thing, this records where the second thing came from. Six months later it answers "why on earth did we file this?" — which is a question that otherwise has no answer at all.',
    when: 'Every time a piece of work spawns a new one. It costs a click and it is the link people are most grateful for later.',
    example: '"Add a loading spinner" was discovered from "Investigate slow dashboard".',
  },
  {
    key: 'tracks',
    term: 'tracks',
    group: 'links',
    linkType: 'tracks',
    direction: 'Tracks ↔ Tracked by',
    short: 'This bead is keeping an eye on that one, usually on someone else\'s behalf.',
    body: 'A watching link. The tracking bead is your handle on work that lives somewhere else — another team, another project, an upstream release — so your board can show that you are waiting on it without pretending you own it.',
    when: 'When your work depends on something you do not control and you want it visible on your own board.',
    example: '"Ship our plugin for v3" tracks "Upstream v3 release".',
  },
  {
    key: 'until',
    term: 'until',
    group: 'links',
    linkType: 'until',
    direction: 'Blocked until ↔ Gates',
    short: 'A blocking link with a "not before" flavour — this waits on that, like a gate.',
    body: 'Behaves like blocks: while the other bead is open, this one is not ready. The different name is for the human reading it later — until reads as "held at a gate", where blocks reads as "obstructed". Both stop the work; pick the word that describes why.',
    when: 'When the wait is a checkpoint rather than an obstacle — an approval, a date-driven gate, a freeze lifting.',
    example: '"Publish the announcement" is blocked until "Launch day sign-off".',
  },
  {
    key: 'caused-by',
    term: 'caused-by',
    group: 'links',
    linkType: 'caused-by',
    direction: 'Caused by ↔ Caused',
    short: 'This problem was created by that change.',
    body: 'Blame, in the useful sense. It connects a bug to the work that introduced it, which makes the pattern visible: if one change caused four bugs, that is a fact worth having written down rather than half-remembered.',
    when: 'On a bug, once you know what broke it.',
    example: '"Avatars are square again" was caused by "Upgrade the image library".',
  },
  {
    key: 'validates',
    term: 'validates',
    group: 'links',
    linkType: 'validates',
    direction: 'Validates ↔ Validated by',
    short: 'This one proves that one actually worked.',
    body: 'Connects a check to the thing it checks — a test, a review, a measurement, a "watch the numbers for a week". It lets you see at a glance whether a piece of finished work was ever actually confirmed, as opposed to merely shipped.',
    when: 'When "done" and "confirmed working" are two separate pieces of work.',
    example: '"Measure checkout conversion for a week" validates "New checkout flow".',
  },
  {
    key: 'supersedes',
    term: 'supersedes',
    group: 'links',
    linkType: 'supersedes',
    direction: 'Superseded by ↔ Supersedes',
    short: 'A replacement. Recording it closes the old bead immediately.',
    body: 'This is not really a link, it is a state change: beads closes the superseded bead the moment you record it and leaves a pointer to the replacement, so the old discussion is not lost. Use the Retire row in an issue\'s Edit section, and expect the bead you are looking at to close.',
    when: 'When a bead has been rethought rather than done — the new one replaces it wholesale.',
    example: '"Add dark mode toggle" is superseded by "Follow the system theme".',
  },
  {
    key: 'duplicates',
    term: 'duplicates',
    group: 'links',
    linkType: 'duplicates',
    direction: 'Duplicate of ↔ Duplicated by',
    short: 'Same thing, filed twice. Recording it closes this copy and points at the original.',
    body: 'Like supersedes, this closes the bead you are looking at rather than adding a decoration to it. The survivor is the canonical one; the copy stays searchable and points at it, so anyone who remembers the duplicate\'s wording can still find their way home.',
    when: 'The moment you notice the same request filed twice.',
    example: '"Login is broken on iPhone" is a duplicate of "Login fails on Safari".',
  },

  // --- molecules -----------------------------------------------------------
  {
    key: 'molecule',
    term: 'molecule',
    group: 'molecules',
    short: 'A set of beads created together in one go, from a template, already wired up.',
    body: 'A molecule is what you get when you pour a formula: one container bead plus one bead per step, with the blocking links between the steps already recorded for you. It behaves exactly like an epic — it groups its children and shows progress — but it was stamped out rather than assembled by hand, so the sequence is right the first time.',
    when: 'When you find yourself creating the same five or ten beads in the same shape again and again.',
    example: 'Pouring a "release checklist" formula creates the root plus its steps, each blocked by the one before it.',
  },
  {
    key: 'formula',
    term: 'formula',
    group: 'molecules',
    short: 'The template a molecule is stamped out from. A recipe, saved as a file.',
    body: 'A formula lists the steps, what each one is called, which ones must wait for which, and any blanks to fill in (a version number, a customer name). Formulas live as .formula.json files in the project\'s .beads/formulas/ folder, so they are shared with everyone who has the repo. You can also capture an epic you already built by hand into a reusable formula.',
    when: 'Write one once you have done the same sequence twice.',
    example: 'A release formula with a {{version}} blank, so pouring it for 2.1 names every step after that version.',
  },
  {
    key: 'pour',
    term: 'pour',
    group: 'molecules',
    short: 'Creating the real beads from a formula. Always previewed before anything is written.',
    body: 'Pouring is the moment the template becomes actual work on your board. This app never pours without showing you exactly what will be created first — you fill in the blanks, watch a live preview, then see the real dry run and a button labelled with the exact number of beads it is about to make.',
    when: 'When you are starting the thing the formula describes, for real.',
    example: 'Pour 12 issues creates a molecule root plus eleven steps.',
  },
  {
    key: 'burn',
    term: 'burn',
    group: 'molecules',
    short: 'The undo for a pour: deletes the molecule and everything inside it, permanently.',
    body: 'Burn is genuinely destructive and wider than "undo the pour" — it deletes everything parented under the molecule root, including beads you added by hand afterwards, and it is not archived. The app shows a dry run and the real count before it will do it. Closing the molecule is almost always what you actually want instead.',
    when: 'Only when a pour was a mistake and nothing of value has been added to it since.',
    example: 'Poured the wrong formula by accident, noticed within the minute.',
  },
]);

const CONCEPT_BY_KEY = new Map(CONCEPTS.map((c) => [c.key, c]));
export function concept(key) { return CONCEPT_BY_KEY.get(key) || null; }
export function conceptsInGroup(groupId) { return CONCEPTS.filter((c) => c.group === groupId); }
/** Deep link into the reference page for a concept. */
export function conceptHref(key) { return '#/learn/' + key; }
/** The concept key a #/learn URL is asking to scroll to, or null. */
export function learnAnchorFromHash(hash) {
  const m = /^#\/learn\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return m && CONCEPT_BY_KEY.has(m[1]) ? m[1] : null;
}
export function isLearnHash(hash) { return /^#\/learn(\/|$)/.test(hash || ''); }

// ---------------------------------------------------------------------------
// Context — layer 3's inputs
//
// A pure reduction of the loaded issue list (plus a couple of externally-known
// numbers) into the handful of facts every hint predicate needs. Pure so the
// predicates below are testable with a literal array and no browser.
// ---------------------------------------------------------------------------

export const STALE_DAYS = 21;
const DAY = 86400000;

export function learnContext(issues, extra = {}) {
  const list = Array.isArray(issues) ? issues : [];
  const now = extra.now || Date.now();
  let links = 0, containers = 0, molecules = 0, open = 0, staleOpen = 0;
  for (const i of list) {
    if (!i) continue;
    if (i.status !== 'closed') {
      open++;
      const t = new Date(i.updated_at || i.created_at || 0).getTime();
      if (t && now - t > STALE_DAYS * DAY) staleOpen++;
    }
    if (i.issue_type === 'epic' || i.issue_type === 'molecule') containers++;
    if (i.issue_type === 'molecule') molecules++;
    for (const d of i.dependencies || []) {
      // parent-child is containment, not a relationship the user had to
      // reason about — an epic-and-children project with no other edges has
      // genuinely never used a link, and should still be told what they are.
      if (d && d.type && d.type !== 'parent-child') links++;
    }
  }
  return {
    issues: list.length,
    open,
    links,
    containers,
    molecules,
    staleOpen,
    formulas: extra.formulas || 0,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Hint registry — layer 3
//
// Every hint declares:
//   when(ctx)        — is this situation true right now?
//   retireWhen(ctx)  — has the user demonstrably already done this? (permanent)
//   retiredBy[]      — action keys that retire it the instant they happen
//                      anywhere in the app, without waiting for a data refresh
//   maxShows         — how many SESSIONS it may ever appear in. One.
//   priority         — lower wins; only the single best hint is ever rendered.
//
// Ordering is by teaching value to a beginner, not by urgency: a first-week
// user benefits far more from learning that links exist than from being told
// something has gone stale (which needs 21 days of use to even trigger).
// ---------------------------------------------------------------------------

export const HINTS = Object.freeze([
  {
    id: 'links-none',
    priority: 10,
    title: 'Nothing here is connected to anything yet',
    body: 'Right now this is a list. Recording that one bead blocks another is what turns it into a plan — the Ready lane starts telling you what you can actually pick up, and the Map draws the order things have to happen in.',
    ctaLabel: 'What links are',
    action: 'learn-links',
    concept: 'blocks',
    when: (c) => c.issues >= 6 && c.links === 0,
    retireWhen: (c) => c.links > 0,
    retiredBy: ['link'],
  },
  {
    id: 'epics-none',
    priority: 20,
    title: 'This list is getting long',
    body: 'An epic is a bead that holds other beads. Group related work under one and Flow can show it as a single row with a progress bar, instead of everything competing in one flat list.',
    ctaLabel: 'Create an epic',
    action: 'new-epic',
    concept: 'epic',
    when: (c) => c.issues >= 12 && c.containers === 0,
    retireWhen: (c) => c.containers > 0,
    retiredBy: ['parent', 'epic'],
  },
  {
    id: 'formulas-unused',
    priority: 30,
    title: 'This project has saved recipes you have never used',
    body: 'Someone has written formulas into this repo — templates that create a whole set of already-connected beads in one go. Pouring one shows you exactly what it will create before it creates anything.',
    ctaLabel: 'Have a look',
    action: 'open-molecules',
    concept: 'molecule',
    when: (c) => c.formulas >= 1 && c.molecules === 0,
    retireWhen: (c) => c.molecules > 0,
    retiredBy: ['pour'],
  },
  {
    id: 'stale-open',
    priority: 40,
    title: 'Some work has gone quiet',
    body: 'A few things have been open and untouched for three weeks. Usually that means they are secretly finished, secretly blocked, or were never really going to happen — all three are worth two minutes.',
    ctaLabel: 'Show me',
    action: 'focus-stale',
    concept: 'stale',
    when: (c) => c.staleOpen >= 3,
    retireWhen: (c) => c.staleOpen === 0,
    retiredBy: ['defer', 'close'],
  },
]);

const HINT_BY_ID = new Map(HINTS.map((h) => [h.id, h]));
export function hint(id) { return HINT_BY_ID.get(id) || null; }

// ---------------------------------------------------------------------------
// Store — persistence + lifecycle
// ---------------------------------------------------------------------------

export const LEARN_KEY = 'bd_learn_v1';
const NEW = 'new', DISMISSED = 'dismissed', RETIRED = 'retired';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

function defaultState() {
  return { v: 1, enabled: true, hints: {}, flags: {} };
}

/**
 * The engine. `storage` is any localStorage-shaped object; pass a fake one in
 * tests. Everything is synchronous and every mutation persists immediately —
 * a dismissal that only lived in memory would come back on reload, which is
 * exactly the nagging this whole module exists to prevent.
 */
export function createLearnStore(storage, options = {}) {
  const store = storage || memoryStorage();
  const registry = options.hints || HINTS;
  const byId = new Map(registry.map((h) => [h.id, h]));
  const listeners = new Set();
  // Shows are counted once per SESSION (per store instance / page load), so a
  // component remounting — switching canvas modes, opening a dialog — can't
  // burn a hint's single appearance five times over.
  const countedThisSession = new Set();
  let state = null;

  function read() {
    if (state) return state;
    let parsed = null;
    try { parsed = JSON.parse(store.getItem(LEARN_KEY) || 'null'); } catch { parsed = null; }
    state = (parsed && parsed.v === 1 && typeof parsed === 'object')
      ? { ...defaultState(), ...parsed, hints: parsed.hints || {}, flags: parsed.flags || {} }
      : defaultState();
    return state;
  }
  function write() {
    try { store.setItem(LEARN_KEY, JSON.stringify(state)); } catch { /* private mode, quota — in-memory is fine */ }
    for (const fn of listeners) { try { fn(state); } catch { /* a bad listener must not break persistence */ } }
  }
  function rec(id) {
    const s = read();
    if (!s.hints[id]) s.hints[id] = { state: NEW, shows: 0 };
    return s.hints[id];
  }

  const api = {
    /** Subscribe to any change. Returns an unsubscribe function. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** The master switch. Nudges only; tooltips and #/learn ignore it. */
    isEnabled() { return read().enabled !== false; },
    setEnabled(v) { read().enabled = !!v; write(); },

    /** 'new' | 'dismissed' | 'retired' */
    status(id) { return rec(id).state; },
    shows(id) { return rec(id).shows || 0; },

    /** Permanent, user-initiated. Never comes back. */
    dismiss(id) { const r = rec(id); r.state = DISMISSED; r.at = Date.now(); write(); },

    /**
     * Permanent, earned. The user did the thing, so the hint has no job left.
     * Distinct from dismiss only so "reset hints" and any future analytics can
     * tell "I turned this off" apart from "I outgrew this".
     */
    retire(id) { const r = rec(id); if (r.state === NEW) { r.state = RETIRED; r.at = Date.now(); write(); } },

    /**
     * Count one appearance, at most once per session. Returns true if this
     * appearance used up the hint's budget (it is now retired).
     */
    noteShown(id) {
      if (countedThisSession.has(id)) return rec(id).state !== NEW;
      countedThisSession.add(id);
      const r = rec(id);
      r.shows = (r.shows || 0) + 1;
      const max = byId.get(id)?.maxShows ?? 1;
      if (r.shows >= max && r.state === NEW) { r.state = RETIRED; r.at = Date.now(); }
      write();
      return r.state !== NEW;
    },

    /**
     * The moment the user does something, anywhere in the app, that proves a
     * hint is redundant. Called from the write actions themselves so retirement
     * doesn't have to wait for a data refresh — or for the user to happen to be
     * looking at the surface that would have re-evaluated the predicate.
     */
    recordAction(actionKey) {
      let changed = false;
      for (const h of registry) {
        if (!h.retiredBy || !h.retiredBy.includes(actionKey)) continue;
        const r = rec(h.id);
        if (r.state === NEW) { r.state = RETIRED; r.at = Date.now(); changed = true; }
      }
      if (changed) write();
      return changed;
    },

    /**
     * Data-driven retirement: anything whose retireWhen() is already true has
     * been outgrown before it was ever shown. Silently retire it so it can
     * never appear later during a temporary dip (a filter, a fresh clone).
     */
    evaluate(ctx) {
      let changed = false;
      for (const h of registry) {
        if (!h.retireWhen) continue;
        const r = rec(h.id);
        if (r.state === NEW && h.retireWhen(ctx)) { r.state = RETIRED; r.at = Date.now(); changed = true; }
      }
      if (changed) write();
      return changed;
    },

    /** The predicate. Pure apart from reading persisted state. */
    shouldShow(id, ctx) {
      if (!api.isEnabled()) return false;
      const h = byId.get(id);
      if (!h) return false;
      if (rec(id).state !== NEW) return false;
      if (h.retireWhen && h.retireWhen(ctx)) return false;
      return !!h.when(ctx);
    },

    /**
     * The single hint to render right now, or null. At most one is ever
     * visible anywhere in the app — a column of advice is a tutorial, and a
     * tutorial is the thing we are not building.
     */
    pickNudge(ctx) {
      api.evaluate(ctx);
      let best = null;
      for (const h of registry) {
        if (!api.shouldShow(h.id, ctx)) continue;
        if (!best || (h.priority ?? 100) < (best.priority ?? 100)) best = h;
      }
      return best;
    },

    /** Small remembered UI preferences that aren't hints (e.g. "I collapsed the molecule explainer"). */
    flag(key) { return !!read().flags[key]; },
    setFlag(key, v) { read().flags[key] = !!v; write(); },

    /** Start over: every hint new again, master switch back on. */
    reset() { state = defaultState(); countedThisSession.clear(); write(); },

    /** Test seam. */
    snapshot() { return JSON.parse(JSON.stringify(read())); },
  };
  return api;
}

// The app-wide instance. Falls back to memory when localStorage is missing
// (Node, private browsing) so importing this module never throws.
function browserStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.getItem(LEARN_KEY);
      return localStorage;
    }
  } catch { /* blocked — fall through */ }
  return memoryStorage();
}

export const learn = createLearnStore(browserStorage());
