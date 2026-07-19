// console2/state.js — local UI state for the Console 2.0 mission-control view.
// Kept separate from the global store so the classic app is untouched; issue
// data itself still lives in the shared store (store.issues, byId, …).
import { signal } from '@preact/signals';

export const c2 = {
  ready: signal(false),          // bootstrap complete for the active project
  bootError: signal(null),

  canvasMode: signal('flow'),    // 'flow' | 'map' | 'docs'
  pulseOpen: signal(false),      // mobile: pulse rail shown as an overlay
  epicGroup: signal(false),      // Flow: regroup lanes into epic rows
  laneFocus: signal(null),       // Pulse click → focus a lane/status bucket

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
