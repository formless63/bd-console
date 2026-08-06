// store.js — global application state as signals plus the actions that mutate
// it. Everything reactive lives here; components read signals and call actions.

import { signal, computed } from '@preact/signals';
import { apiGet, apiGetRaw, apiPost, apiPostRaw, AuthError } from './api.js';
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
const SCHED_UNAVAILABLE_MSG = 'scheduler requires Node >= 22';

const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

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
  if (localStorage.getItem(HUB_ATTRIB_MIGRATED_KEY) === '1') {
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
  localStorage.setItem(HUB_ATTRIB_MIGRATED_KEY, '1');
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

  // issues
  issues: signal([]),
  issuesLoading: signal(false),
  issuesError: signal(null),
  generatedAt: signal(null),

  // selection (Console 2.0's Flow/Map/Detail; the classic list's own
  // filter/sort/group signals retired with it — Console 2.0 keeps that state
  // in console2/state.js)
  selectedId: signal(null),

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
  tmuxSessions: signal([]),
  tmuxLoading: signal(false),

  // scheduler (hub-level)
  scheduleAvailable: signal(true),
  scheduleJobs: signal([]),
  scheduleLoading: signal(false),
  // set by TmuxView's "Schedule a prompt here" before navigating to
  // #/schedule; ScheduleView consumes it once on mount and clears it.
  scheduleSessionPreset: signal(null),

  // theme
  themePreset: signal(localStorage.getItem('bd_theme_preset') || 'synergy'),
  themeScheme: signal(localStorage.getItem('bd_theme_scheme') || 'auto'),

  // ui chrome
  toasts: signal([]),
  createOpen: signal(false),

  // settings (#/settings)
  settings: signal(null),
  settingsAvailable: signal(true),
  settingsLoading: signal(false),

  // saved prompts (hub-level, backs the schedule create form)
  prompts: signal([]),
  promptsAvailable: signal(true),

  // hub restyle: per-project git insights (GET /api/projects?git=1)
  projectsGit: signal({}),
  projectsGitAvailable: signal(true),

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
export function toast(message, kind = 'ok', timeout = 3200) {
  const id = ++toastSeq;
  store.toasts.value = [...store.toasts.value, { id, message, kind }];
  if (timeout) setTimeout(() => dismissToast(id), timeout);
  return id;
}
export function dismissToast(id) {
  store.toasts.value = store.toasts.value.filter((t) => t.id !== id);
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
// Data loading
// ---------------------------------------------------------------------------
export async function loadBootMeta() {
  try {
    const m = await apiGetRaw('/api/meta');
    store.mode.value = m.mode || 'hub';
    store.meta.value = m;
  } catch (e) { /* server unreachable */ }
}

export async function loadHub() {
  try {
    const data = await apiGetRaw('/api/projects');
    store.projects.value = data.projects || {};
  } catch (e) { toast('Failed to load projects: ' + e.message, 'err'); }
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
  } catch (e) {
    store.projectsGitAvailable.value = false;
    store.projectsGit.value = {};
    console.warn('Project git insights unavailable: ' + e.message);
  }
}

// Per-project card stats for the hub. `open` here means "open and unblocked"
// (i.e. ready) — blocked opens are bucketed separately, matching effStatus()
// semantics used elsewhere. Also folds in the small extra metrics the hub
// restyle wants: closed7d (a velocity signal) and openBugs.
export async function loadProjectStats(id) {
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

export async function loadProjectMeta() {
  try {
    const m = await apiGet('/api/meta');
    store.meta.value = m;
  } catch (e) { /* keep prior meta */ }
}

export async function loadIssues({ force = false } = {}) {
  store.issuesLoading.value = true;
  store.issuesError.value = null;
  try {
    const data = await apiGet('/api/issues' + (force ? '?refresh=1' : ''));
    store.issues.value = data.issues || [];
    store.generatedAt.value = data.generatedAt;
    if (store.meta.value) store.meta.value = { ...store.meta.value, export: data.export };
  } catch (e) {
    store.issuesError.value = e.message;
    toast(e.message, 'err');
  } finally {
    store.issuesLoading.value = false;
  }
}

export async function loadDocs() {
  store.docsLoading.value = true;
  try {
    const data = await apiGet('/api/docs');
    store.docs.value = data.docs || [];
  } catch (e) { toast('Failed to load docs: ' + e.message, 'err'); }
  finally { store.docsLoading.value = false; }
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
    store.tmuxSessions.value = data.sessions || [];
  } catch (e) { toast('Failed to load tmux sessions: ' + e.message, 'err'); }
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
    store.scheduleJobs.value = data.jobs || [];
  } catch (e) {
    if (e.message === SCHED_UNAVAILABLE_MSG) { store.scheduleAvailable.value = false; store.scheduleJobs.value = []; }
    else toast('Failed to load schedule: ' + e.message, 'err');
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
  } catch (e) {
    store.promptsAvailable.value = false;
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
  } catch (e) {
    store.usageHistoryAvailable.value = false;
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
  } catch (e) {
    store.settingsAvailable.value = false;
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
