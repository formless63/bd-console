// store.js — global application state as signals plus the actions that mutate
// it. Everything reactive lives here; components read signals and call actions.

import { signal, computed } from '@preact/signals';
import { apiGet, apiGetRaw, apiPost, apiPostRaw, AuthError, isNetworkError } from './api.js';
import {
  blockersOf, BLOCKING_DEP_TYPES, LINK_TYPES, LINK_LABEL, linkLabel,
  RELATED_DEP_TYPES, SUPERSEDE_DEP_TYPE, DUPLICATE_DEP_TYPE,
  dependenciesByType, inboundByType, linkTypesPresent, relatedTo,
  discoveredFrom, tracksOf, supersededBy, duplicateOf, supersedes,
  duplicatedBy, retiredState, linkSections, blockedByIssue, parentOfIssue,
  MOLECULE_TYPE, CONTAINER_TYPES, isContainerType, isContainer, isMolecule,
  childrenOfIssue, containerGroups, moleculeRootOf, moleculeRollup,
} from './relationships.js';
import { legacyProjectHash, parseRoute } from './routing.js';

// Server text for the 501 the scheduler routes return when node:sqlite isn't
// available (Node < 22) — used to tell "feature unavailable" apart from a
// real network/server error without threading HTTP status through apiGetRaw.
export const SCHED_UNAVAILABLE_MSG = 'scheduler requires Node >= 22';

const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
// Raw (non-JSON) counterparts — for the handful of keys stored as plain
// strings (theme preset/scheme, the attrib-migration marker) rather than
// JSON. A storage-blocked browser (private mode with storage disabled, quota
// exceeded, some enterprise policies) throws on ANY localStorage access —
// including a plain getItem() — and this module reads/writes localStorage at
// import time (the signal initializers below), before any UI has rendered,
// so an unguarded call here white-screens the whole app on load. Exported so
// theme.js can use the same guard instead of calling localStorage directly
// (theme.js already imports from here, so this adds no new import cycle).
export const lsGetRaw = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSetRaw = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

// ---------------------------------------------------------------------------
// Hub section collapse state — with a one-time migration for the 'attrib'
// (usage attribution) default.
//
// 'attrib' collapses-by-default is a policy introduced after this key
// already existed for plenty of users (anyone who'd ever toggled ops/usage/
// tmux). A plain `lsGet(KEY, ['attrib'])` only seeds that default when the
// key is completely ABSENT — an existing user's already-persisted `[]` (or
// any set that predates 'attrib') would win over the default forever, so
// they'd keep seeing attribution expanded with no way for the new default to
// ever reach them. HUB_ATTRIB_MIGRATED_KEY marks "the one-time seed has run
// on this browser" so it fires exactly once (adding 'attrib' to whatever set
// already existed, existing choices untouched) and never fires again — once
// migrated, a deliberate re-expand (removing 'attrib' from the set) persists
// across reloads exactly like every other section's collapse choice.
// ---------------------------------------------------------------------------
const HUB_SECTIONS_KEY = 'bd_hub_sections_collapsed';
const HUB_ATTRIB_MIGRATED_KEY = 'bd_hub_attrib_migrated_v1';

function initCollapsedHubSections() {
  if (lsGetRaw(HUB_ATTRIB_MIGRATED_KEY) === '1') {
    // Migration already ran on this browser — respect exactly what's
    // persisted (falling back to the 'attrib'-collapsed default only if the
    // key somehow got cleared entirely since), including a deliberate
    // re-expand of 'attrib'.
    return new Set(lsGet(HUB_SECTIONS_KEY, ['attrib']));
  }
  // First read ever on this browser (fresh profile, or pre-migration
  // existing user): seed 'attrib' into whatever's already there — [] for a
  // fresh profile — persist it, and mark the migration done so this branch
  // never runs again.
  const set = new Set(lsGet(HUB_SECTIONS_KEY, []));
  set.add('attrib');
  lsSet(HUB_SECTIONS_KEY, [...set]);
  // Plain (non-JSON) marker, read back above via a raw getItem — lsSet
  // would JSON-encode it (producing the 3-char string `"1"`), which would
  // never match the raw `=== '1'` check above and make this branch (and the
  // re-add of 'attrib' it does) run again on every single reload.
  lsSetRaw(HUB_ATTRIB_MIGRATED_KEY, '1');
  return set;
}

export const store = {
  // routing
  route: signal(parseHash()),

  // meta / mode
  mode: signal('hub'),
  meta: signal(null),            // hub-root or project meta
  projects: signal({}),          // hub registry
  projectId: signal(null),

  // True when the most recent loadHub()/loadBootMeta() call failed with a
  // NETWORK-ish error (the daemon didn't answer at all — see
  // api.js's isNetworkError) rather than an HTTP error status. Distinct from
  // "no projects registered": that's projects === {} with this flag false,
  // and gets the onboarding empty state; this is projects === {} (or stale)
  // with the daemon unreachable, and gets a "can't reach the server" state
  // instead (see HubView.js) plus the app-level banner (app.js) once the SSE
  // stream also isn't confirmed live. Cleared by any response that actually
  // reaches the server, success or not.
  hubUnreachable: signal(false),

  // issues
  issues: signal([]),
  issuesLoading: signal(false),
  issuesError: signal(null),
  generatedAt: signal(null),

  // selection (Console 2.0's Flow/Map/Detail; the classic list's own
  // filter/sort/group signals retired with it — Console 2.0 keeps that state
  // in console2/state.js)
  selectedId: signal(null),

  // MULTI-selection for bulk operations (bd-console-974.5) — a Set of issue
  // ids, distinct from selectedId (which is "the one issue the Detail
  // slide-over is showing"). Lives here rather than in a Flow-local useState
  // for one reason: Flow re-renders on every live data refresh (SSE `change`
  // → loadIssues), and a selection the user spent time building must survive
  // that. loadIssues() prunes ids that left the list; nothing else touches it
  // implicitly. Always REPLACED, never mutated in place — a signal holding a
  // Set only notifies on identity change.
  selection: signal(new Set()),

  // comments (per selected issue)
  comments: signal([]),
  commentsLoading: signal(false),

  // docs
  docs: signal([]),
  docsLoading: signal(false),
  docFilter: signal(''),
  selectedDocPath: signal(null),
  docContent: signal(null),
  docLoading: signal(false),

  // epics (for the create-issue dialog's "target epic" picker)
  epics: signal([]),

  // tmux (hub-level)
  tmuxAvailable: signal(true),
  // WHY the last /api/tmux call didn't produce sessions — set on a fetch
  // failure (network/401/500/older-route-missing; see unavailableReason()
  // below) even though tmuxAvailable itself is left alone in that case (a
  // transient error shouldn't relabel a host that DOES have tmux as one that
  // doesn't — see loadTmux()'s comment). null once a call succeeds.
  tmuxAvailableReason: signal(null),
  tmuxSessions: signal([]),
  tmuxLoading: signal(false),
  // Host memory + OOM headroom (bd-console-oic), served alongside the session
  // list by GET /api/tmux. null whenever the server can't measure it
  // (non-Linux, unreadable /proc, a server predating the feature) — every
  // consumer must treat null as "don't render", never as zero.
  tmuxHost: signal(null),

  // scheduler (hub-level)
  scheduleAvailable: signal(true),
  scheduleAvailableReason: signal(null),
  scheduleJobs: signal([]),
  scheduleLoading: signal(false),
  // set by TmuxView's "Schedule a prompt here" before navigating to
  // #/schedule; ScheduleView consumes it once on mount and clears it.
  scheduleSessionPreset: signal(null),

  // theme
  themePreset: signal(lsGetRaw('bd_theme_preset') || 'synergy'),
  themeScheme: signal(lsGetRaw('bd_theme_scheme') || 'auto'),

  // ui chrome
  toasts: signal([]),
  createOpen: signal(false),

  // settings (#/settings)
  settings: signal(null),
  settingsAvailable: signal(true),
  settingsAvailableReason: signal(null),
  settingsLoading: signal(false),

  // saved prompts (hub-level, backs the schedule create form)
  prompts: signal([]),
  promptsAvailable: signal(true),
  promptsAvailableReason: signal(null),

  // hub restyle: per-project git insights (GET /api/projects?git=1)
  projectsGit: signal({}),
  projectsGitAvailable: signal(true),
  projectsGitAvailableReason: signal(null),

  // provider usage (hub-level; GET /api/usage — Claude Code + Codex quotas,
  // plus Kimi Code stack info: server up/down, version, sessions, tokens —
  // Kimi publishes no quota, so its entry carries no gauges)
  usage: signal({ claude: null, codex: null, kimi: null }),
  usageAvailable: signal(true),

  // provider usage HISTORY (hub-level; GET /api/usage/history?days=N — token
  // attribution by model/project over a trailing window). A separate,
  // heavier fetch from /api/usage's live quota gauges above — see
  // loadUsageHistory(). Distinct signals so the hub can degrade attribution
  // charts independently of the live-quota band.
  usageHistory: signal(null),
  usageHistoryAvailable: signal(true),
  usageHistoryAvailableReason: signal(null),
  usageHistoryLoading: signal(false),
  usageHistoryDays: signal(30),

  // installed vs. latest `bd` (beads CLI) version (hub-level; GET
  // /api/bd-version — see lib/bdversion.mjs). Degrades to unavailable on an
  // older server (404) exactly like the other hub-level "…Available" signals.
  bdVersion: signal(null),
  bdVersionAvailable: signal(true),

  // installed vs. latest Claude Code / Codex CLI versions (hub-level; GET
  // /api/cli-versions). Keyed by tool name ('claude'/'codex') so a single
  // signal backs both chips rendered inline in the Live quota rows — see
  // loadCliVersions() below. Same "…Available" degrade convention as
  // bdVersionAvailable above: unavailable on 401/404/network, never breaks
  // the hub.
  cliVersions: signal({}),
  cliVersionsAvailable: signal(false),

  // hub sections (ops strip, tmux strip, …) collapsed on mobile — collapsed
  // state is a set of section ids, persisted per-browser. Only meaningful at
  // the <=768px breakpoint (see .hub-section-body.collapsed in styles.css);
  // desktop always renders sections expanded regardless of this set.
  // Default (nothing persisted yet) is "collapsed" for every known section
  // so a first mobile visit shows project cards without scrolling.
  // Default: nothing collapsed — hub sections (esp. tmux) stay visible on
  // every viewport; collapsing is a per-user opt-in via the mobile toggles.
  // 'attrib' (usage attribution band) is an exception to the "nothing
  // collapsed by default" rule above: it collapses at every viewport (not
  // just mobile — see .usage-attrib-body.collapsed in styles.css) and
  // defaults to collapsed so project cards are visible sooner on first
  // load. Once a user has toggled anything, their persisted set wins over
  // this default, including for users who re-expand 'attrib'.
  collapsedHubSections: signal(initCollapsedHubSections()),
};

// ---------------------------------------------------------------------------
// Derived issue graph helpers (pure over the current issues list)
// ---------------------------------------------------------------------------
export const byId = computed(() => {
  const m = new Map();
  for (const i of store.issues.value) m.set(i.id, i);
  return m;
});

export function parentOf(issue) {
  const p = (issue.dependencies || []).find((d) => d.type === 'parent-child');
  return p ? p.depends_on_id : null;
}
// Direction invariant, blocking-type set and every link-type derivation live
// in relationships.js (pure and import-free, so smoke.mjs can assert them in
// Node). Imported above for local use AND re-exported here so every existing
// import site keeps working.
//
// NOTE: these must be imported, not just `export … from`-ed — a bare
// re-export creates no local binding, so openBlockersOf/blocksList below
// would throw ReferenceError on the first call.
export {
  blockersOf, BLOCKING_DEP_TYPES, LINK_TYPES, LINK_LABEL, linkLabel,
  RELATED_DEP_TYPES, SUPERSEDE_DEP_TYPE, DUPLICATE_DEP_TYPE,
  dependenciesByType, inboundByType, linkTypesPresent, relatedTo,
  discoveredFrom, tracksOf, supersededBy, duplicateOf, supersedes,
  duplicatedBy, retiredState, linkSections, blockedByIssue, parentOfIssue,
  MOLECULE_TYPE, CONTAINER_TYPES, isContainerType, isContainer, isMolecule,
  childrenOfIssue, containerGroups, moleculeRootOf, moleculeRollup,
};
export function openBlockersOf(issue) {
  const m = byId.value;
  return blockersOf(issue).filter((id) => { const b = m.get(id); return b && b.status !== 'closed'; });
}
export function effStatus(issue) {
  if (issue.status === 'open' && openBlockersOf(issue).length > 0) return 'blocked';
  return issue.status;
}
export function isReady(issue) {
  return issue.status === 'open' && openBlockersOf(issue).length === 0;
}
export function childrenOf(id) {
  return store.issues.value.filter((i) => parentOf(i) === id);
}
export function blocksList(id) {
  return store.issues.value.filter((i) => blockersOf(i).includes(id));
}

// Signal-bound molecule helpers — the pure versions live in relationships.js.
export function moleculeRootFor(issue) { return moleculeRootOf(issue, store.issues.value); }
export function moleculeRollupFor(root) { return moleculeRollup(root, store.issues.value); }

// Signal-bound conveniences over the pure helpers above — components get the
// "…against the currently loaded issue list" variant without repeating
// store.issues.value at every call site.
export function relatedOf(issue) { return relatedTo(issue, store.issues.value); }
export function linkSectionsOf(issue) { return linkSections(issue, store.issues.value); }
export function supersedesOf(id) { return supersedes(id, store.issues.value); }
export function duplicatedByOf(id) { return duplicatedBy(id, store.issues.value); }

export const PRI_LABEL = ['P0', 'P1', 'P2', 'P3', 'P4'];
// Filtering / sorting / grouping / facet counts, and the flat list-row model
// they fed, retired with the classic view's three-pane layout — Console 2.0
// derives its lanes, counts and search from console2/derive.js over the same
// store.issues signal.

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
// The parsing itself lives in routing.js (pure, import-free, smoke-tested in
// Node). This wrapper adds the one browser-only behaviour: a retired classic
// hash (`#/p/<id>`, `#/p/<id>/docs`) is rewritten in place to its Console 2.0
// equivalent. replaceState, not `location.hash = …`, on purpose — it leaves no
// history entry (so Back doesn't bounce off the redirect) and fires no
// hashchange (so this call can't re-enter), and the route we return is already
// the target's.
export function parseHash() {
  const target = legacyProjectHash(location.hash);
  if (target) {
    try { history.replaceState(null, '', target); } catch { /* keep the old URL; the route below is still right */ }
    return parseRoute(target);
  }
  return parseRoute(location.hash);
}
export function navigate(hash) { if (location.hash !== hash) location.hash = hash; }

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
let toastSeq = 0;
// `action`, when given, is { label, run } — Toasts.js renders it as a button
// inside the alert. Used by offerUndo() below; nothing else needs it.
export function toast(message, kind = 'ok', timeout = 3200, action = null) {
  const id = ++toastSeq;
  store.toasts.value = [...store.toasts.value, { id, message, kind, ...(action ? { action } : {}) }];
  if (timeout) setTimeout(() => dismissToast(id), timeout);
  return id;
}
export function dismissToast(id) {
  store.toasts.value = store.toasts.value.filter((t) => t.id !== id);
}

// ---------------------------------------------------------------------------
// Multi-selection (bd-console-974.5)
// ---------------------------------------------------------------------------
export const selectionCount = computed(() => store.selection.value.size);
export const selectionActive = computed(() => store.selection.value.size > 0);
export function isSelected(id) { return store.selection.value.has(id); }

// The anchor for shift-click range selection. Module-level rather than a
// signal: nothing renders from it, and a re-render caused by it would be
// noise. Reset by clearSelection() so a fresh selection can't extend a range
// from an id the user no longer has selected.
let selectionAnchor = null;

// `ids` is the ORDERED list of ids the click happened within — Flow passes the
// lane's (or epic row's) currently visible ids, which is what makes a range
// select mean "everything between these two cards in THIS lane" rather than
// "everything between these two ids in some global order the user can't see".
export function toggleSelection(id, { ids = null, shift = false } = {}) {
  const next = new Set(store.selection.value);
  const canRange = shift && selectionAnchor && selectionAnchor !== id
    && Array.isArray(ids) && ids.includes(id) && ids.includes(selectionAnchor);
  if (canRange) {
    const a = ids.indexOf(selectionAnchor);
    const b = ids.indexOf(id);
    // A range ADDS; it never toggles individual members off, which is what
    // makes shift-clicking twice in a row idempotent instead of a flicker.
    for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
  } else {
    if (next.has(id)) next.delete(id); else next.add(id);
    selectionAnchor = id;
  }
  store.selection.value = next;
}

export function selectIds(ids) {
  const next = new Set(store.selection.value);
  for (const id of ids) next.add(id);
  store.selection.value = next;
}
export function deselectIds(ids) {
  const next = new Set(store.selection.value);
  for (const id of ids) next.delete(id);
  store.selection.value = next;
}
export function clearSelection() {
  selectionAnchor = null;
  if (store.selection.value.size) store.selection.value = new Set();
}

// Drop selected ids that are no longer in the loaded issue list. Called from
// loadIssues() — a live refresh (or a project switch) must not leave the bulk
// bar holding ids that no longer exist, because every op it would send for
// them is a guaranteed per-op failure the user cannot explain.
function pruneSelection(issues) {
  const sel = store.selection.value;
  if (sel.size === 0) return;
  const live = new Set(issues.map((i) => i.id));
  let dropped = false;
  const next = new Set();
  for (const id of sel) { if (live.has(id)) next.add(id); else dropped = true; }
  if (dropped) {
    if (selectionAnchor && !next.has(selectionAnchor)) selectionAnchor = null;
    store.selection.value = next;
  }
}

// ---------------------------------------------------------------------------
// Collapse actions
// ---------------------------------------------------------------------------
export function toggleHubSection(id) {
  const set = new Set(store.collapsedHubSections.value);
  set.has(id) ? set.delete(id) : set.add(id);
  store.collapsedHubSections.value = set;
  lsSet(HUB_SECTIONS_KEY, [...set]);
}

// ---------------------------------------------------------------------------
// "Why is this feature hiding?" (bd-console-974.7)
// ---------------------------------------------------------------------------
// A human-readable reason for the ~6 hub-level "…Available" degrade signals
// below (settings/prompts/projectsGit/schedule/tmux/usageHistory) — a 500, an
// expired/incorrect write token, and a server too old for the route were all
// previously indistinguishable (every one just meant "don't render this").
// AuthError gets its own copy per bd-console-974.7's spec — "feature
// unsupported" is actively wrong for a 401, which means the feature exists
// and is simply locked. A network-ish failure (isNetworkError — the fetch
// itself never got a response) also gets its own wording, distinct from an
// HTTP error status the server actually returned.
export function unavailableReason(e) {
  if (e instanceof AuthError) return 'write token required/incorrect — see Settings';
  if (isNetworkError(e)) return 'server unreachable';
  if (e && e.status === 404) return "not supported by this server yet";
  return (e && e.message) || 'unknown error';
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
export async function loadBootMeta() {
  try {
    const m = await apiGetRaw('/api/meta');
    store.mode.value = m.mode || 'hub';
    store.meta.value = m;
    store.hubUnreachable.value = false;
  } catch (e) {
    // A response that just isn't JSON/ok still means the server answered —
    // only a network-ish failure (no response at all) marks the hub
    // unreachable; see store.hubUnreachable's own doc and app.js's banner.
    store.hubUnreachable.value = isNetworkError(e);
  }
}

export async function loadHub() {
  try {
    const data = await apiGetRaw('/api/projects');
    store.projects.value = data.projects || {};
    store.hubUnreachable.value = false;
  } catch (e) {
    if (isNetworkError(e)) {
      store.hubUnreachable.value = true;
    } else {
      store.hubUnreachable.value = false;
      toast('Failed to load projects: ' + e.message, 'err');
    }
  }
}

// Per-project git insights for hub cards (branch, last commit, ahead/behind,
// dirty state). Optional endpoint form (?git=1) — degrade silently (whole
// hub still renders plain cards) if the server doesn't support it yet.
export async function loadProjectsGit() {
  try {
    const data = await apiGetRaw('/api/projects?git=1');
    const projects = data.projects || {};
    const git = {};
    for (const [id, p] of Object.entries(projects)) git[id] = p.git ?? null;
    store.projectsGit.value = git;
    store.projectsGitAvailable.value = true;
    store.projectsGitAvailableReason.value = null;
  } catch (e) {
    store.projectsGitAvailable.value = false;
    store.projectsGitAvailableReason.value = unavailableReason(e);
    store.projectsGit.value = {};
    console.warn('Project git insights unavailable: ' + e.message);
  }
}

// Per-project card stats for the hub. `open` here means "open and unblocked"
// (i.e. ready) — blocked opens are bucketed separately, matching effStatus()
// semantics used elsewhere. Also folds in the small extra metrics the hub
// restyle wants: closed7d (a velocity signal) and openBugs.
export async function loadProjectStats(id) {
  // Server-computed shortcut, if this server has it: same shape this
  // function returns (open/in_progress/blocked/closed/total/openTotal/
  // triage/closed7d/openBugs), computed without shipping every issue in the
  // project down to the browser just to fold it into eight numbers. 404 on
  // an older server (or any other failure) falls straight through to the
  // full-fetch path below — the same "…Available" degrade every other
  // optional route in this file uses, just without a persistent signal
  // since callers already retry this per project on every hub load.
  try {
    const stats = await apiGetRaw('/api/p/' + encodeURIComponent(id) + '/stats');
    if (stats && typeof stats === 'object') {
      return {
        open: 0, in_progress: 0, blocked: 0, closed: 0, total: 0,
        openTotal: 0, triage: 0, closed7d: 0, openBugs: 0,
        ...stats,
      };
    }
  } catch (e) { /* older server without the route — fall back below */ }
  const data = await apiGetRaw('/api/p/' + encodeURIComponent(id) + '/issues');
  const issues = data.issues || [];
  const t = { open: 0, in_progress: 0, blocked: 0, closed: 0, total: issues.length, openTotal: 0, triage: 0, closed7d: 0, openBugs: 0 };
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  // Hub cards used to re-derive "blocked" inline, in the inverted direction
  // and with a `depends` type that bd never writes. Delegate to the shared
  // blockersOf() so the card tally, effStatus() and Console 2.0's lanes can't
  // drift — and so a non-blocking link type (related, tracks, …) can never
  // inflate this count.
  const openIds = new Set(issues.filter((x) => x.status !== 'closed').map((x) => x.id));
  for (const i of issues) {
    if (i.status !== 'closed') {
      t.openTotal++;
      if ((i.labels || []).includes('triage')) t.triage++;
    }
    let s = i.status;
    if (s === 'open' && blockersOf(i).some((b) => openIds.has(b))) s = 'blocked';
    if (t[s] != null) t[s]++;
    if (s === 'closed') {
      const ts = i.closed_at ? new Date(i.closed_at).getTime() : (i.updated_at ? new Date(i.updated_at).getTime() : 0);
      if (ts && ts >= sevenDaysAgo) t.closed7d++;
    }
    if (i.issue_type === 'bug' && i.status !== 'closed') t.openBugs++;
  }
  return t;
}

// projectMetaSeq/issuesSeq/docsSeq below all follow the same monotonic
// sequence-number pattern as console2/molecules.js's previewSeq: every write
// action in the app awaits loadIssues() before it's considered done, so two
// actions fired in quick succession (e.g. a double-tap slipping past a
// missing busy guard, or claim-then-close) issue two concurrent GETs — and
// nothing otherwise guarantees they RESOLVE in request order. Without a
// guard, a slower older response landing after a faster newer one silently
// overwrites the newer state with stale data. Bumping the sequence on entry
// and checking "am I still the latest request" before applying a response
// makes only the newest request's result ever land, regardless of resolve
// order.
let projectMetaSeq = 0;
export async function loadProjectMeta() {
  const seq = ++projectMetaSeq;
  try {
    const m = await apiGet('/api/meta');
    if (seq !== projectMetaSeq) return; // a newer request already won
    store.meta.value = m;
  } catch (e) { /* keep prior meta */ }
}

// For loadIssues specifically, overlap is no longer the rare case: every SSE
// `change` event calls it again, and the most dangerous overlap is across a
// PROJECT SWITCH, where a slow response for the OLD project landing late
// would splice one project's issues into another's.
let issuesSeq = 0;
export async function loadIssues({ force = false } = {}) {
  const seq = ++issuesSeq;
  store.issuesLoading.value = true;
  store.issuesError.value = null;
  try {
    const data = await apiGet('/api/issues' + (force ? '?refresh=1' : ''));
    if (seq !== issuesSeq) return; // a newer request already won
    // Swap in place, never through []: a live refresh must not blank the
    // list (and therefore every card/lane mid-interaction) for even one
    // frame while the new data is in flight.
    store.issues.value = data.issues || [];
    // A multi-selection outlives data refreshes (that is why it lives in the
    // store) — but only for ids that are still there.
    pruneSelection(store.issues.value);
    store.generatedAt.value = data.generatedAt;
    if (store.meta.value) store.meta.value = { ...store.meta.value, export: data.export };
  } catch (e) {
    if (seq !== issuesSeq) return;
    store.issuesError.value = e.message;
    toast(e.message, 'err');
  } finally {
    if (seq === issuesSeq) store.issuesLoading.value = false;
  }
}

let docsSeq = 0;
export async function loadDocs() {
  const seq = ++docsSeq;
  store.docsLoading.value = true;
  try {
    const data = await apiGet('/api/docs');
    if (seq !== docsSeq) return; // a newer request already won
    store.docs.value = data.docs || [];
  } catch (e) {
    if (seq !== docsSeq) return;
    toast('Failed to load docs: ' + e.message, 'err');
  } finally {
    if (seq === docsSeq) store.docsLoading.value = false;
  }
}

export async function openDoc(path) {
  store.selectedDocPath.value = path;
  store.docLoading.value = true;
  store.docContent.value = null;
  try {
    const data = await apiGet('/api/doc?path=' + encodeURIComponent(path));
    store.docContent.value = data.content || '';
  } catch (e) { store.docContent.value = null; toast('Could not load doc', 'err'); }
  finally { store.docLoading.value = false; }
}

// Open (non-closed) epics for the active project — feeds the create-issue
// dialog's epic-target picker. No-op outside a project context.
export async function loadEpics() {
  if (!store.projectId.value) { store.epics.value = []; return; }
  try {
    const data = await apiGet('/api/epics');
    store.epics.value = data.epics || [];
  } catch (e) { store.epics.value = []; }
}

// Open epics for an ARBITRARY project id, independent of store.projectId —
// used by the Settings page's "Default epics" card, which lets the user
// pick any registered project while store.projectId itself stays null on
// #/settings. Returns [] on any failure rather than throwing (mirrors
// loadEpics()'s degrade-quietly behavior).
export async function loadEpicsForProject(projectId) {
  if (!projectId) return [];
  try {
    const data = await apiGetRaw('/api/p/' + encodeURIComponent(projectId) + '/epics');
    return data.epics || [];
  } catch (e) { return []; }
}

// Creates an epic in an arbitrary project (not necessarily the active one) —
// backs the Settings page's "Create the 5 standard epics" button. Returns
// the raw /api/p/<id>/create response ({ ok, id, issue, export }).
export async function createEpicForProject(projectId, { title, priority = 2 }) {
  return withAuth(() => apiPostRaw('/api/p/' + encodeURIComponent(projectId) + '/create', { title, type: 'epic', priority }));
}

// Creates an epic in the CURRENTLY ACTIVE project — backs the "+ new epic"
// inline row in CreateIssueDialog's epic picker. Deliberately does not call
// loadIssues()/selectIssue() (unlike createIssue() below): it must not steal
// focus from whatever issue is currently selected behind the still-open
// create-issue dialog. Refreshes the epic list so the new epic is
// immediately selectable, and toasts on success (errors are surfaced inline
// by the caller instead, so the dialog's in-progress state is never lost).
export async function createEpicInline({ title, priority = 2 }) {
  const data = await withAuth(() => apiPost('/api/create', { title, type: 'epic', priority }));
  await loadEpics();
  toast('Created epic ' + data.id);
  return data.id;
}

// ---------------------------------------------------------------------------
// tmux sessions (hub-level — always fetched unprefixed via apiGetRaw)
// ---------------------------------------------------------------------------
export async function loadTmux() {
  store.tmuxLoading.value = true;
  try {
    const data = await apiGetRaw('/api/tmux');
    store.tmuxAvailable.value = !!data.available;
    // A real "no tmux binary on this host" answer carries no reason beyond
    // that fact itself — TmuxView's own copy says so. Only a FAILED call
    // (below) gets a reason string.
    store.tmuxAvailableReason.value = null;
    store.tmuxSessions.value = data.sessions || [];
    store.tmuxHost.value = (data.host && data.host.memory) || null;
  } catch (e) {
    // Deliberately does NOT flip tmuxAvailable here: a transient 500/network
    // blip on a host that DOES have tmux must not relabel it as "tmux isn't
    // available on this host" (wrong advice — that copy tells the user to
    // install tmux). The reason alone lets TmuxView show a small "last
    // refresh failed" note beside the still-stale-but-real session list
    // instead of replacing it with a misleading empty state.
    store.tmuxAvailableReason.value = unavailableReason(e);
    toast('Failed to load tmux sessions: ' + e.message, 'err');
  }
  finally { store.tmuxLoading.value = false; }
}

// Pane preview text (ANSI intact — stripped for display by the caller).
// Throws AuthError on 401 so callers can open the token dialog.
export async function loadTmuxPreview(session, lines = 400) {
  try {
    const data = await apiGetRaw('/api/tmux/preview?session=' + encodeURIComponent(session) + '&lines=' + lines);
    return data.text || '';
  } catch (e) {
    if (e instanceof AuthError) requireToken('A write token is required to view pane output.');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Prompt scheduler (hub-level)
// ---------------------------------------------------------------------------
export async function loadSchedule() {
  store.scheduleLoading.value = true;
  try {
    const data = await apiGetRaw('/api/schedule');
    store.scheduleAvailable.value = true;
    store.scheduleAvailableReason.value = null;
    store.scheduleJobs.value = data.jobs || [];
  } catch (e) {
    if (e.message === SCHED_UNAVAILABLE_MSG) {
      store.scheduleAvailable.value = false;
      store.scheduleAvailableReason.value = SCHED_UNAVAILABLE_MSG;
      store.scheduleJobs.value = [];
    } else {
      // Same reasoning as loadTmux(): a transient failure doesn't mean the
      // scheduler stopped existing, so scheduleAvailable itself is untouched
      // — only the reason is recorded, for ScheduleView to note beside the
      // (possibly stale) job list it still has.
      store.scheduleAvailableReason.value = unavailableReason(e);
      toast('Failed to load schedule: ' + e.message, 'err');
    }
  } finally {
    store.scheduleLoading.value = false;
  }
}

// Both writes below are hub-level, so they must use apiPostRaw: apiPost would
// rewrite /api/schedule… into /api/p/<id>/api/schedule… whenever a project is
// active, and lib/routes.mjs only matches the unprefixed form (bd-console-xsv).
// apiUrl() now throws on that mistake rather than 404ing quietly, but the
// right call is still the raw one.
export async function scheduleCreate(body) {
  const data = await withAuth(() => apiPostRaw('/api/schedule', body));
  await loadSchedule();
  toast('Scheduled for ' + body.session);
  return data.job;
}

export async function scheduleCancel(id) {
  await withAuth(() => apiPostRaw('/api/schedule/cancel', { id }));
  await loadSchedule();
  toast('Cancelled scheduled prompt #' + id);
}

// ---------------------------------------------------------------------------
// Saved prompts (hub-level) — backs the schedule create form's picker.
// Endpoints may not exist yet on an older server; degrade to "unavailable"
// on any failure (404/501/network) rather than erroring the whole view.
// ---------------------------------------------------------------------------
export async function loadPrompts() {
  try {
    const data = await apiGetRaw('/api/prompts');
    store.prompts.value = data.prompts || [];
    store.promptsAvailable.value = true;
    store.promptsAvailableReason.value = null;
  } catch (e) {
    store.promptsAvailable.value = false;
    store.promptsAvailableReason.value = unavailableReason(e);
    store.prompts.value = [];
    console.warn('Saved prompts unavailable: ' + e.message);
  }
}

// Hub-level writes — apiPostRaw, never apiPost (see scheduleCreate above).
export async function savePrompt(name, prompt) {
  const data = await withAuth(() => apiPostRaw('/api/prompts', { name, prompt }));
  await loadPrompts();
  toast('Saved prompt "' + name + '"');
  return data.id;
}

export async function deletePrompt(id) {
  await withAuth(() => apiPostRaw('/api/prompts/delete', { id }));
  await loadPrompts();
  toast('Deleted saved prompt');
}

// Best-effort "last used" ping — never surfaces an error to the user. The
// swallowed error is exactly why this one had to be audited by hand: a
// prefixed 404 here could never have shown up as anything at all.
export async function markPromptUsed(id) {
  try { await apiPostRaw('/api/prompts/used', { id }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Provider usage (hub-level) — Claude Code / Codex quota tracking.
// GET /api/usage is gated the same way /api/tmux/preview is (token-gated
// when a token is configured); like the other hub-level "…Available"
// signals, any failure (401, network, older server without the route)
// degrades to "unavailable" rather than erroring the whole hub.
// ---------------------------------------------------------------------------
// `fresh` (the hub's ↻ button) asks the server to bypass its own OK-cache —
// the poll path never sets it. The server still refuses to make an upstream
// call during a 429 backoff or within its minimum fresh interval, and flags
// any cache-served provider with `cached: true`; returns the providers object
// so callers can tell the user which of those happened.
export async function loadUsage({ fresh = false } = {}) {
  try {
    const data = await apiGetRaw('/api/usage' + (fresh ? '?fresh=1' : ''));
    store.usage.value = data.providers || { claude: null, codex: null, kimi: null };
    store.usageAvailable.value = true;
    return store.usage.value;
  } catch (e) {
    store.usageAvailable.value = false;
    console.warn('Usage endpoint unavailable: ' + e.message);
    return null;
  }
}

// Usage/attribution history — GET /api/usage/history?days=N. Distinct from
// loadUsage() above: this is the heavier, "estimated from local session
// logs" attribution data (by-model/by-project/daily breakdowns), not the
// authoritative live-quota gauges. Degrades silently on 404/501/network
// (older server, or the backend route not landed yet / mid-development)
// exactly like loadProjectsGit — the attribution band just doesn't render.
export async function loadUsageHistory(days = store.usageHistoryDays.value) {
  store.usageHistoryDays.value = days;
  store.usageHistoryLoading.value = true;
  try {
    const data = await apiGetRaw('/api/usage/history?days=' + encodeURIComponent(days));
    store.usageHistory.value = data;
    store.usageHistoryAvailable.value = true;
    store.usageHistoryAvailableReason.value = null;
  } catch (e) {
    store.usageHistoryAvailable.value = false;
    store.usageHistoryAvailableReason.value = unavailableReason(e);
    store.usageHistory.value = null;
    console.warn('Usage history unavailable: ' + e.message);
  } finally {
    store.usageHistoryLoading.value = false;
  }
}

// ---------------------------------------------------------------------------
// bd (beads CLI) version check (hub-level) — GET /api/bd-version.
// `force` re-checks GitHub past the server's own cache TTL (manual refresh);
// degrades to unavailable on 401/404/network exactly like loadUsage().
// ---------------------------------------------------------------------------
export async function loadBdVersion({ force = false } = {}) {
  try {
    const data = await apiGetRaw('/api/bd-version' + (force ? '?refresh=1' : ''));
    store.bdVersion.value = data;
    store.bdVersionAvailable.value = true;
  } catch (e) {
    store.bdVersionAvailable.value = false;
    console.warn('bd version check unavailable: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Claude Code / Codex CLI version check (hub-level) — GET /api/cli-versions.
// Same shape and same reasoning as loadBdVersion() above: `force` re-checks
// past the server's own cache TTL, and this is a brand-new route (may 401 on
// an unconfigured token or 404 on a server whose backend half hasn't landed
// yet) so any failure just leaves the version/update chips off the Live quota
// rows rather than surfacing anywhere — a machine that can't determine a
// version looks exactly like one that never asked.
// ---------------------------------------------------------------------------
export async function loadCliVersions({ force = false } = {}) {
  try {
    const data = await apiGetRaw('/api/cli-versions' + (force ? '?refresh=1' : ''));
    store.cliVersions.value = data.tools || {};
    store.cliVersionsAvailable.value = true;
  } catch (e) {
    store.cliVersionsAvailable.value = false;
    console.warn('CLI version check unavailable: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Settings (#/settings) — hub-level server configuration + tokens.
// ---------------------------------------------------------------------------
export async function loadSettings() {
  store.settingsLoading.value = true;
  try {
    const data = await apiGetRaw('/api/settings');
    store.settings.value = data;
    store.settingsAvailable.value = true;
    store.settingsAvailableReason.value = null;
  } catch (e) {
    store.settingsAvailable.value = false;
    store.settingsAvailableReason.value = unavailableReason(e);
    store.settings.value = null;
    console.warn('Settings endpoint unavailable: ' + e.message);
  } finally {
    store.settingsLoading.value = false;
  }
}

// token: a non-empty string to set the server write token, or null to clear it.
// Hub-level — apiPostRaw (see scheduleCreate above).
export async function saveServerToken(token) {
  const data = await withAuth(() => apiPostRaw('/api/settings', { token }));
  await loadSettings();
  return data;
}

// ---------------------------------------------------------------------------
// Per-project default epics (opt-in — see Settings' "Default epics" card and
// CreateIssueDialog's preselect-on-intent-change behavior). Server-side this
// is one global-config map keyed by project id -> intent -> epic bead id;
// see POST /api/settings' `defaultEpics` handling in lib/routes.mjs.
// ---------------------------------------------------------------------------
export const DEFAULT_EPIC_INTENTS = ['bug', 'feature', 'task', 'idea', 'chore'];
const STANDARD_EPIC_TITLES = { bug: 'Bugs', feature: 'Features', task: 'Tasks', idea: 'Ideas', chore: 'Chores' };

// map: { <projectId>: { bug|feature|task|idea|chore: <epicId|null> } } — merged
// server-side into the stored map (other projects' entries are untouched).
export async function saveDefaultEpics(map) {
  const data = await withAuth(() => apiPostRaw('/api/settings', { defaultEpics: map }));
  await loadSettings();
  return data;
}

// Creates the five standard epics (Bugs / Features / Tasks / Ideas / Chores)
// in `projectId` and maps them to the five create-dialog intents in one
// action. Idempotent-ish: an existing OPEN epic whose title case-insensitively
// matches is reused instead of creating a duplicate, so a second click
// creates zero new epics. Returns { map, created, reused } — `map` is ready
// to hand straight to saveDefaultEpics({ [projectId]: map }).
export async function createStandardEpics(projectId) {
  const existing = await loadEpicsForProject(projectId);
  const map = {};
  let created = 0;
  for (const intent of DEFAULT_EPIC_INTENTS) {
    const title = STANDARD_EPIC_TITLES[intent];
    const match = existing.find((e) => e.title.trim().toLowerCase() === title.toLowerCase());
    if (match) { map[intent] = match.id; continue; }
    const result = await createEpicForProject(projectId, { title, priority: 2 });
    map[intent] = result.id;
    created++;
  }
  await saveDefaultEpics({ [projectId]: map });
  return { map, created, reused: DEFAULT_EPIC_INTENTS.length - created };
}

// ---------------------------------------------------------------------------
// Issue selection + comments
// ---------------------------------------------------------------------------
export async function selectIssue(id) {
  store.selectedId.value = id;
  if (!id) return;
  store.comments.value = [];
  store.commentsLoading.value = true;
  try {
    const data = await apiGet('/api/comments?id=' + encodeURIComponent(id));
    if (store.selectedId.value === id) store.comments.value = data.comments || [];
  } catch { /* ignore */ }
  finally { store.commentsLoading.value = false; }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
// A 401 means the server wants a write token this browser doesn't have (or
// has the wrong one) — send the user to #/settings to fix it, with a toast
// explaining why, instead of a modal dialog.
export function requireToken(message = 'A write token is required.') {
  toast(message, 'err');
  if (store.route.value.view !== 'settings') navigate('#/settings');
}

function withAuth(fn) {
  return fn().catch((e) => {
    if (e instanceof AuthError) requireToken('A write token is required.');
    throw e;
  });
}

export async function addComment(id, text) {
  const data = await withAuth(() => apiPost('/api/comment', { id, text }));
  store.comments.value = data.comments || [];
  toast('Comment added to ' + id);
}

export async function quickCapture(body) {
  const data = await withAuth(() => apiPost('/api/quick', body));
  await loadIssues();
  if (data.id) await selectIssue(data.id);
  toast('Captured ' + data.id);
  return data.id;
}

// Full-featured issue creation (type, priority, labels, description,
// acceptance, epic parent, assignee) — backs the "New issue" dialog.
export async function createIssue(body) {
  const data = await withAuth(() => apiPost('/api/create', body));
  await loadIssues();
  if (data.id) await selectIssue(data.id);
  toast('Created ' + data.id);
  return data.id;
}

// ---------------------------------------------------------------------------
// Batch edit (bd-console-974.5) — POST /api/p/<id>/batch
// ---------------------------------------------------------------------------
// Server-side cap; mirrored here only so callers can chunk/refuse BEFORE
// spending a round trip. lib/bd.mjs's BATCH_MAX_OPS is the authority.
export const BATCH_MAX_OPS = 100;

// Resolves to the server's { ok, results, failed, applied } even when some ops
// failed — a partial failure is a 200, not a throw, because the ops that DID
// land are real and the caller has to report them. Only a whole-request
// failure (401, cap exceeded, malformed ops, export failure) throws.
//
// One loadIssues() for the whole batch, matching the server's one export.
export async function batchEdit(ops) {
  const data = await withAuth(() => apiPost('/api/batch', { ops }));
  await loadIssues();
  return data;
}

// ---------------------------------------------------------------------------
// One-level undo (bd-console-974.5)
// ---------------------------------------------------------------------------
// Deliberately NOT an undo stack. One level, most recent action only, a 10s
// window, and the reverse is always expressed as a list of ordinary edit ops
// so undoing a bulk action is exactly one more batch call. Actions whose
// reverse is not obvious (reopen, burn, supersede, mark-duplicate, create)
// offer no undo at all rather than a lie — see reverseOpsFor() in
// console2/actions.js, which is where the "what is the opposite of this"
// knowledge lives and where the previous values are captured BEFORE the write.
export const UNDO_WINDOW_MS = 10000;

// The single outstanding offer. Superseded by the next one, consumed by its
// own Undo button, and expired by its own timer — all three paths null it out,
// so a stale toast that somehow survives can never fire a second reversal.
let pendingUndo = null;

export function offerUndo(message, ops, { kind = 'ok', window = UNDO_WINDOW_MS } = {}) {
  // Most recent only: retire the previous offer (and its toast) outright
  // rather than leaving two Undo buttons on screen meaning different things.
  if (pendingUndo) { dismissToast(pendingUndo.toastId); pendingUndo = null; }
  if (!Array.isArray(ops) || ops.length === 0) return toast(message, kind, window);

  const entry = { ops };
  entry.toastId = toast(message, kind, window, { label: 'Undo', run: () => runUndo(entry) });
  pendingUndo = entry;
  // The toast's own auto-dismiss removes it from the stack but says nothing
  // about the offer, so expire the offer on the same clock.
  setTimeout(() => { if (pendingUndo === entry) pendingUndo = null; }, window);
  return entry.toastId;
}

async function runUndo(entry) {
  if (pendingUndo !== entry) return; // already used, superseded or expired
  pendingUndo = null;
  dismissToast(entry.toastId);
  const n = entry.ops.length;
  try {
    const data = await batchEdit(entry.ops);
    const failed = data.failed || 0;
    toast(
      failed
        ? `Undone — ${n - failed} of ${n} reversed, ${failed} failed`
        : `Undone (${n} ${n === 1 ? 'change' : 'changes'} reversed)`,
      failed ? 'warn' : 'ok',
    );
  } catch (e) {
    // withAuth already routed a 401 to #/settings with its own toast.
    if (!(e instanceof AuthError)) toast('Undo failed: ' + e.message, 'err');
  }
}

export async function editIssue(payload, successMessage) {
  const id = payload.id;
  const data = await withAuth(() => apiPost('/api/edit', payload));
  await loadIssues();
  if (id) await selectIssue(id);
  if (successMessage) toast(successMessage);
  // Returned so link/supersede callers can read the server's `effect` (see
  // lib/bd.mjs's runIssueEdit) — existing callers ignore it.
  return data;
}

// ---------------------------------------------------------------------------
// Link types (docs/beads-coverage.md Phase 1)
// ---------------------------------------------------------------------------
// Generic dependency edge of any of the 10 `bd dep add --type` values. The
// type is re-validated server-side against the same hardcoded enum, so a
// tampered client can't smuggle text into --type.
export async function addLink(id, other, type) {
  return editIssue({ id, op: 'add-link', other, type }, `Linked ${id} → ${other} (${type})`);
}
export async function removeLink(id, other, type) {
  return editIssue({ id, op: 'remove-link', other, type }, `Unlinked ${id} → ${other}`);
}

// State transitions, NOT plain links: bd closes `id` as a side effect. The
// toast quotes the server's own `effect.message` so the close is never
// silent.
export async function supersedeIssue(id, replacement) {
  const data = await editIssue({ id, op: 'supersede', with: replacement });
  toast(data?.effect?.message || `${id} superseded by ${replacement}`);
  return data;
}
export async function markDuplicate(id, canonical) {
  const data = await editIssue({ id, op: 'mark-duplicate', of: canonical });
  toast(data?.effect?.message || `${id} marked duplicate of ${canonical}`);
  return data;
}
