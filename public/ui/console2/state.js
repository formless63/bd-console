// console2/state.js — local UI state for the Console 2.0 mission-control view.
// Kept separate from the global store so the classic app is untouched; issue
// data itself still lives in the shared store (store.issues, byId, …).
import { signal } from '@preact/signals';

export const c2 = {
  ready: signal(false),          // bootstrap complete for the active project
  bootError: signal(null),

  canvasMode: signal('flow'),    // 'flow' | 'map' | 'docs'
  pulseOpen: signal(false),      // pulse bar: details panel expanded
  epicGroup: signal(true),       // Flow: regroup lanes into epic rows (default ON — see loadEpicGroupPref)
  laneFocus: signal(null),       // Pulse click → focus a lane/status bucket

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
