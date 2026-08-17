// console2/filters.js — FilterBar's filter state, saved views, and the
// filtered issue set every canvas-mode derivation reads instead of
// store.issues directly (bd-console-974.6).
//
// Filters combine AND across dimensions (assignee, label, priority, type,
// text, age) and OR within a multi-select dimension (e.g. two labels
// selected shows issues carrying EITHER one).
//
// Application point: derive.js's lanes/pulse/graphLayout (and MapView's own
// issue source) read `filteredIssues` below instead of store.issues.value,
// so every canvas mode narrows together rather than each canvas re-deriving
// its own notion of "the current issue set".
import { signal, computed } from '@preact/signals';
import { store, lsGetRaw, lsSetRaw } from '../store.js';

const DAY = 86400000;
const ts = (s) => (s ? new Date(s).getTime() : 0);
function ageMsOf(issue) { return Date.now() - ts(issue.updated_at || issue.created_at); }

// Sentinel for "assignee is empty" in the single-select assignee dropdown —
// distinct from '' (which means "no assignee filter applied at all").
export const UNASSIGNED = '__unassigned__';

export const AGE_OPTIONS = [
  ['any', 'Any age'],
  ['recent', 'Updated <24h'],
  ['aging', 'Updated 24h–21d'],
  ['stale', 'Stale · 21d+'],
];

export function emptyFilters() {
  return { assignee: '', labels: [], priorities: [], types: [], text: '', age: 'any' };
}

// The live filter combination. A plain object (not several signals) so
// saved-view apply/save is a single assignment/read.
export const filters = signal(emptyFilters());

export function isFilterActive(f = filters.value) {
  return !!(f.assignee || f.labels.length || f.priorities.length || f.types.length
    || f.text.trim() || (f.age && f.age !== 'any'));
}

function matchAge(issue, age) {
  if (!age || age === 'any') return true;
  const ms = ageMsOf(issue);
  if (age === 'recent') return ms < DAY;
  if (age === 'aging') return ms >= DAY && ms < 21 * DAY;
  if (age === 'stale') return issue.status !== 'closed' && ms >= 21 * DAY;
  return true;
}

function matchIssue(issue, f) {
  if (f.assignee) {
    if (f.assignee === UNASSIGNED) { if (issue.assignee) return false; }
    else if (issue.assignee !== f.assignee) return false;
  }
  if (f.labels.length) {
    const ls = issue.labels || [];
    if (!f.labels.some((l) => ls.includes(l))) return false;
  }
  if (f.priorities.length && !f.priorities.includes(issue.priority)) return false;
  if (f.types.length && !f.types.includes(issue.issue_type)) return false;
  if (f.text.trim()) {
    const q = f.text.trim().toLowerCase();
    const hay = `${issue.id} ${issue.title || ''} ${issue.description || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (!matchAge(issue, f.age)) return false;
  return true;
}

// The single source every canvas-mode derivation reads. Returns the SAME
// array reference (store.issues.value) when no filter is active, so an
// unfiltered project pays no extra allocation on every issues tick.
export const filteredIssues = computed(() => {
  const all = store.issues.value;
  const f = filters.value;
  if (!isFilterActive(f)) return all;
  return all.filter((i) => matchIssue(i, f));
});

// Dropdown/chip value sources — always computed from the FULL (unfiltered)
// list so a value doesn't vanish from its own control the moment it narrows
// the set down to just itself.
export const availableAssignees = computed(() => {
  const set = new Set();
  for (const i of store.issues.value) if (i.assignee) set.add(i.assignee);
  return [...set].sort();
});
export const availableLabels = computed(() => {
  const set = new Set();
  for (const i of store.issues.value) for (const l of (i.labels || [])) set.add(l);
  return [...set].sort();
});
export const availableTypes = computed(() => {
  const set = new Set();
  for (const i of store.issues.value) if (i.issue_type) set.add(i.issue_type);
  return [...set].sort();
});

export function clearFilters() { filters.value = emptyFilters(); }

// Number of ACTIVE dimensions (not total selected values) — what the
// collapsed FilterBar button's badge shows, mirroring the header's
// Molecules-button count convention.
export function activeFilterCount(f = filters.value) {
  let n = 0;
  if (f.assignee) n++;
  if (f.labels.length) n++;
  if (f.priorities.length) n++;
  if (f.types.length) n++;
  if (f.text.trim()) n++;
  if (f.age && f.age !== 'any') n++;
  return n;
}

function cloneFilters(f) {
  return { ...emptyFilters(), ...f, labels: [...(f.labels || [])], priorities: [...(f.priorities || [])], types: [...(f.types || [])] };
}

// ---------------------------------------------------------------------------
// Saved views — named filter combinations, persisted per project via the
// store's guarded raw localStorage helpers (lsGetRaw/lsSetRaw — the JSON-
// parsing lsGet/lsSet aren't exported from store.js, so this wraps the raw
// pair the same way console2/state.js's own per-project maps do).
// ---------------------------------------------------------------------------
const VIEWS_KEY = 'bd_c2_views';

function readViewsMap() {
  try { return JSON.parse(lsGetRaw(VIEWS_KEY) || '{}') || {}; } catch { return {}; }
}
function writeViewsMap(map) {
  lsSetRaw(VIEWS_KEY, JSON.stringify(map));
}

export function savedViewsFor(pid) {
  if (!pid) return [];
  const v = readViewsMap()[pid];
  return Array.isArray(v) ? v : [];
}

// Upserts by name (case-sensitive) so re-saving "default" updates it in place.
export function saveView(pid, name, f = filters.value) {
  if (!pid || !name) return;
  const map = readViewsMap();
  const list = (Array.isArray(map[pid]) ? map[pid] : []).filter((v) => v.name !== name);
  list.push({ name, filters: cloneFilters(f) });
  map[pid] = list;
  writeViewsMap(map);
}

export function deleteView(pid, name) {
  if (!pid) return;
  const map = readViewsMap();
  map[pid] = (Array.isArray(map[pid]) ? map[pid] : []).filter((v) => v.name !== name);
  writeViewsMap(map);
}

export function applyView(view) {
  if (!view) return;
  filters.value = cloneFilters(view.filters);
}

// Console2.js calls this on project bootstrap: apply the "default" saved
// view if one exists for this project, else start from a clean slate. Never
// carries a previous project's filter combination across a switch.
export function loadDefaultView(pid) {
  const def = savedViewsFor(pid).find((v) => v.name === 'default');
  filters.value = def ? cloneFilters(def.filters) : emptyFilters();
}
