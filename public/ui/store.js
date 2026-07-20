// store.js — global application state as signals plus the actions that mutate
// it. Everything reactive lives here; components read signals and call actions.

import { signal, computed } from '@preact/signals';
import { apiGet, apiGetRaw, apiPost, AuthError } from './api.js';

// Server text for the 501 the scheduler routes return when node:sqlite isn't
// available (Node < 22) — used to tell "feature unavailable" apart from a
// real network/server error without threading HTTP status through apiGetRaw.
const SCHED_UNAVAILABLE_MSG = 'scheduler requires Node >= 22';

const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

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

  // filters + view controls
  filters: signal({ status: [], priority: [], type: [], label: [] }),
  search: signal(''),
  groupEpic: signal(true),
  readyOnly: signal(false),
  sort: signal({ key: 'priority', dir: 1 }),
  selectedId: signal(null),
  collapsedIssueGroups: signal(new Set(lsGet('bd_issue_groups_collapsed', []))),

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
  collapsedDocGroups: signal(new Set(lsGet('bd_docs_collapsed', []))),

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
  mobileFiltersOpen: signal(false),

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

  // provider usage (hub-level; GET /api/usage — Claude Code + Codex quotas)
  usage: signal({ claude: null, codex: null }),
  usageAvailable: signal(true),

  // hub sections (ops strip, tmux strip, …) collapsed on mobile — collapsed
  // state is a set of section ids, persisted per-browser. Only meaningful at
  // the <=768px breakpoint (see .hub-section-body.collapsed in styles.css);
  // desktop always renders sections expanded regardless of this set.
  // Default (nothing persisted yet) is "collapsed" for every known section
  // so a first mobile visit shows project cards without scrolling.
  // Default: nothing collapsed — hub sections (esp. tmux) stay visible on
  // every viewport; collapsing is a per-user opt-in via the mobile toggles.
  collapsedHubSections: signal(new Set(lsGet('bd_hub_sections_collapsed', []))),
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
export function blockersOf(issue) {
  const out = new Set();
  for (const b of store.issues.value) {
    if (b.id === issue.id) continue;
    if ((b.dependencies || []).some((d) => d.type === 'blocks' && d.depends_on_id === issue.id)) out.add(b.id);
  }
  for (const d of issue.dependencies || []) {
    if (d.type === 'depends') out.add(d.depends_on_id);
  }
  return [...out];
}
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

export const PRI_LABEL = ['P0', 'P1', 'P2', 'P3', 'P4'];
const STATUS_ORDER = { in_progress: 0, blocked: 1, open: 2, closed: 3 };

// ---------------------------------------------------------------------------
// Filtering / sorting / grouping — a single computed feeding the list.
// ---------------------------------------------------------------------------
function passesFilters(i) {
  const f = store.filters.value;
  if (f.status.length && !f.status.includes(effStatus(i))) return false;
  if (f.priority.length && !f.priority.includes(i.priority)) return false;
  if (f.type.length && !f.type.includes(i.issue_type)) return false;
  if (f.label.length && !(i.labels || []).some((l) => f.label.includes(l))) return false;
  if (store.readyOnly.value && !isReady(i)) return false;
  const q = store.search.value.trim().toLowerCase();
  if (q && !(`${i.id} ${i.title} ${i.description || ''}`.toLowerCase().includes(q))) return false;
  return true;
}
function sortIssues(list) {
  const { key, dir } = store.sort.value;
  return list.slice().sort((a, b) => {
    let av, bv;
    if (key === 'status') { av = STATUS_ORDER[effStatus(a)]; bv = STATUS_ORDER[effStatus(b)]; }
    else if (key === 'priority') { av = a.priority; bv = b.priority; }
    else { av = a[key] || ''; bv = b[key] || ''; }
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return a.id.localeCompare(b.id);
  });
}

// Produces a flat list of render rows: {kind:'group'|'issue', ...}
export const listRows = computed(() => {
  const shown = store.issues.value.filter(passesFilters);
  if (!store.groupEpic.value) {
    return sortIssues(shown).map((i) => ({ kind: 'issue', issue: i }));
  }
  const rows = [];
  const collapsed = store.collapsedIssueGroups.value;
  const childMap = new Map();
  for (const i of shown) {
    const p = parentOf(i);
    if (p) { if (!childMap.has(p)) childMap.set(p, []); childMap.get(p).push(i); }
  }
  const rendered = new Set();
  const epics = sortIssues(shown.filter((i) => i.issue_type === 'epic'));
  for (const e of epics) {
    const kids = sortIssues(childMap.get(e.id) || []);
    const key = 'epic:' + e.id;
    rows.push({ kind: 'group', key, title: e.title, epic: e, count: kids.length });
    rendered.add(e.id);
    if (!collapsed.has(key)) for (const k of kids) { rows.push({ kind: 'issue', issue: k, indent: true }); rendered.add(k.id); }
  }
  const orphans = sortIssues(shown.filter((i) => !rendered.has(i.id) && !parentOf(i) && i.issue_type !== 'epic'));
  if (orphans.length) {
    const key = 'standalone';
    rows.push({ kind: 'group', key, title: 'Standalone', count: orphans.length });
    if (!collapsed.has(key)) for (const o of orphans) { rows.push({ kind: 'issue', issue: o }); rendered.add(o.id); }
  }
  const leftover = sortIssues(shown.filter((i) => !rendered.has(i.id)));
  for (const o of leftover) rows.push({ kind: 'issue', issue: o });
  return rows;
});

export const visibleIssues = computed(() => listRows.value.filter((r) => r.kind === 'issue').map((r) => r.issue));

// Facet counts for filter chips.
export const facets = computed(() => {
  const count = (fn) => {
    const m = new Map();
    for (const i of store.issues.value) for (const v of [].concat(fn(i))) { if (v == null) continue; m.set(v, (m.get(v) || 0) + 1); }
    return m;
  };
  return {
    status: count((i) => effStatus(i)),
    priority: count((i) => i.priority),
    type: count((i) => i.issue_type),
    label: count((i) => i.labels || []),
  };
});

export const tally = computed(() => {
  const t = { open: 0, in_progress: 0, blocked: 0, closed: 0 };
  for (const i of store.issues.value) { const s = effStatus(i); if (t[s] != null) t[s]++; }
  return t;
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
export function parseHash() {
  const h = (location.hash || '').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean); // ['p','id','docs']
  if (parts[0] === 'p' && parts[1]) {
    return { view: 'project', projectId: decodeURIComponent(parts[1]), tab: parts[2] === 'docs' ? 'docs' : 'issues' };
  }
  if (parts[0] === 'p2' && parts[1]) {
    return { view: 'console2', projectId: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'tmux') return { view: 'tmux' };
  if (parts[0] === 'schedule') return { view: 'schedule' };
  if (parts[0] === 'settings') return { view: 'settings' };
  return { view: 'hub' };
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
// Filter actions
// ---------------------------------------------------------------------------
export function toggleFilter(kind, value) {
  const f = store.filters.value;
  const has = f[kind].includes(value);
  store.filters.value = { ...f, [kind]: has ? f[kind].filter((v) => v !== value) : [...f[kind], value] };
}
export function clearFilters() {
  store.filters.value = { status: [], priority: [], type: [], label: [] };
  store.search.value = '';
  store.readyOnly.value = false;
}
export function setSort(key) {
  const s = store.sort.value;
  store.sort.value = { key, dir: s.key === key ? -s.dir : 1 };
}
export function toggleIssueGroup(key) {
  const set = new Set(store.collapsedIssueGroups.value);
  set.has(key) ? set.delete(key) : set.add(key);
  store.collapsedIssueGroups.value = set;
  lsSet('bd_issue_groups_collapsed', [...set]);
}
export function toggleDocGroup(name) {
  const set = new Set(store.collapsedDocGroups.value);
  set.has(name) ? set.delete(name) : set.add(name);
  store.collapsedDocGroups.value = set;
  lsSet('bd_docs_collapsed', [...set]);
}
export function toggleHubSection(id) {
  const set = new Set(store.collapsedHubSections.value);
  set.has(id) ? set.delete(id) : set.add(id);
  store.collapsedHubSections.value = set;
  lsSet('bd_hub_sections_collapsed', [...set]);
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
  const t = { open: 0, in_progress: 0, blocked: 0, closed: 0, total: issues.length, closed7d: 0, openBugs: 0 };
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  for (const i of issues) {
    let s = i.status;
    if (s === 'open') {
      const blocked = issues.some((b) => b.status !== 'closed' && (
        (b.dependencies || []).some((d) => d.type === 'blocks' && d.depends_on_id === i.id) ||
        (i.dependencies || []).some((d) => d.type === 'depends' && d.depends_on_id === b.id)
      ));
      if (blocked) s = 'blocked';
    }
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

export async function scheduleCreate(body) {
  const data = await withAuth(() => apiPost('/api/schedule', body));
  await loadSchedule();
  toast('Scheduled for ' + body.session);
  return data.job;
}

export async function scheduleCancel(id) {
  await withAuth(() => apiPost('/api/schedule/cancel', { id }));
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

export async function savePrompt(name, prompt) {
  const data = await withAuth(() => apiPost('/api/prompts', { name, prompt }));
  await loadPrompts();
  toast('Saved prompt "' + name + '"');
  return data.id;
}

export async function deletePrompt(id) {
  await withAuth(() => apiPost('/api/prompts/delete', { id }));
  await loadPrompts();
  toast('Deleted saved prompt');
}

// Best-effort "last used" ping — never surfaces an error to the user.
export async function markPromptUsed(id) {
  try { await apiPost('/api/prompts/used', { id }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Provider usage (hub-level) — Claude Code / Codex quota tracking.
// GET /api/usage is gated the same way /api/tmux/preview is (token-gated
// when a token is configured); like the other hub-level "…Available"
// signals, any failure (401, network, older server without the route)
// degrades to "unavailable" rather than erroring the whole hub.
// ---------------------------------------------------------------------------
export async function loadUsage() {
  try {
    const data = await apiGetRaw('/api/usage');
    store.usage.value = data.providers || { claude: null, codex: null };
    store.usageAvailable.value = true;
  } catch (e) {
    store.usageAvailable.value = false;
    console.warn('Usage endpoint unavailable: ' + e.message);
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
export async function saveServerToken(token) {
  const data = await withAuth(() => apiPost('/api/settings', { token }));
  await loadSettings();
  return data;
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
export function selectAdjacent(delta) {
  const list = visibleIssues.value;
  if (!list.length) return;
  const idx = list.findIndex((i) => i.id === store.selectedId.value);
  const next = idx === -1 ? 0 : Math.min(Math.max(idx + delta, 0), list.length - 1);
  selectIssue(list[next].id);
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
  await withAuth(() => apiPost('/api/edit', payload));
  await loadIssues();
  if (id) await selectIssue(id);
  if (successMessage) toast(successMessage);
}
