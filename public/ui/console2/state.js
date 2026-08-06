// console2/state.js — local UI state for the Console 2.0 mission-control view.
// Kept separate from the global store, which owns the shared/hub-level state;
// issue data itself still lives there (store.issues, byId, …).
import { signal } from '@preact/signals';

export const c2 = {
  ready: signal(false),          // bootstrap complete for the active project
  bootError: signal(null),

  canvasMode: signal('flow'),    // 'flow' | 'map' | 'docs'
  pulseOpen: signal(false),      // pulse bar: details panel expanded
  // Mobile-only collapse of the whole pulse bar (CSS ignores it >768px).
  // Default collapsed so the canvas is the first thing on a phone; the
  // collapsed summary row keeps the headline numbers visible. Persisted.
  pulseBarCollapsed: signal((() => { try { return localStorage.getItem('bd_c2_pulsebar') !== 'open'; } catch { return true; } })()),
  epicGroup: signal(true),       // Flow: regroup lanes into epic rows (default ON — see loadEpicGroupPref)
  laneFocus: signal(null),       // Pulse click → focus a lane/status bucket

  // Persistent workflow rail: unlike one-shot learning nudges this remains a
  // dependable "where am I / what next?" path for people learning beads from
  // the UI. Experienced users can collapse it to a compact summary.
  workflowCollapsed: signal((() => { try { return localStorage.getItem('bd_c2_workflow') === 'closed'; } catch { return false; } })()),

  // Map: which OVERLAY link types (everything but blocking, which is always
  // on) are currently drawn — a Set of display type strings, e.g. {'related'}.
  // Default/persistence: see loadMapOverlayPref/setMapOverlayPref below.
  mapOverlayTypes: signal(new Set(['related'])),

  delegatePreset: signal(null),  // Pulse "delegate here" → session name Detail's Delegate composer should preselect once

  docTreeOpen: signal(false),    // mobile: doc tree shown as a drawer
  promoteOpen: signal(false),    // mobile: manual "promote…" excerpt form visible

  omniOpen: signal(false),       // command palette / omnibar dropdown visible
  omniValue: signal(''),
  lastCli: signal(null),         // { cmd, label } — teaches the terminal equivalent

  // Docs editing
  docEditing: signal(false),
  docDraft: signal(''),
  docDirty: signal(false),
  docPreview: signal(false),
  promote: signal(null),         // { text, path } selection promoted from a doc
};

export function flashCli(cmd, label) {
  c2.lastCli.value = { cmd, label: label || '', at: Date.now() };
}

export function setPulseBarCollapsed(v) {
  c2.pulseBarCollapsed.value = v;
  try { localStorage.setItem('bd_c2_pulsebar', v ? 'closed' : 'open'); } catch { /* ignore */ }
}

export function setWorkflowCollapsed(v) {
  c2.workflowCollapsed.value = v;
  try { localStorage.setItem('bd_c2_workflow', v ? 'closed' : 'open'); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Epic-grouping preference — Flow groups by epic by default; an explicit
// "Ungroup" click should stick per-project (a user working an epic-heavy
// project shouldn't have to re-toggle every visit). Stored as a single JSON
// map keyed by project id so switching projects doesn't bleed one project's
// choice into another's.
// ---------------------------------------------------------------------------
const EPIC_GROUP_KEY = 'bd_c2_epicgroup';
function readEpicGroupMap() {
  try { return JSON.parse(localStorage.getItem(EPIC_GROUP_KEY)) || {}; } catch { return {}; }
}
export function loadEpicGroupPref(pid) {
  if (!pid) return true;
  const v = readEpicGroupMap()[pid];
  return typeof v === 'boolean' ? v : true; // default: grouped
}
export function setEpicGroup(pid, val) {
  c2.epicGroup.value = val;
  if (!pid) return;
  try {
    const map = readEpicGroupMap();
    map[pid] = val;
    localStorage.setItem(EPIC_GROUP_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Map overlay-edge toggles (docs/beads-coverage.md Phase 2) — which non-
// blocking link types MapView draws, persisted per-project the same way
// epicGroup is above. Blocking edges are never part of this set (they always
// render — they define the layout). Default is {'related'} only: the doc's
// own rationale is that rendering all ~7 overlay types at once on top of the
// blocking DAG is unreadable, and `related` is the one the owner specifically
// flagged as useful, so it's the one non-blocking type on by default.
// ---------------------------------------------------------------------------
const MAP_OVERLAY_KEY = 'bd_c2_map_overlay';
const DEFAULT_MAP_OVERLAY_TYPES = ['related'];
function readMapOverlayMap() {
  try { return JSON.parse(localStorage.getItem(MAP_OVERLAY_KEY)) || {}; } catch { return {}; }
}
export function loadMapOverlayPref(pid) {
  if (!pid) return new Set(DEFAULT_MAP_OVERLAY_TYPES);
  const v = readMapOverlayMap()[pid];
  return new Set(Array.isArray(v) ? v : DEFAULT_MAP_OVERLAY_TYPES);
}
export function setMapOverlayPref(pid, set) {
  c2.mapOverlayTypes.value = set;
  if (!pid) return;
  try {
    const map = readMapOverlayMap();
    map[pid] = [...set];
    localStorage.setItem(MAP_OVERLAY_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}
