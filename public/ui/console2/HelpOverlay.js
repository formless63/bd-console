// console2/HelpOverlay.js — the ? keyboard-shortcut reference (bd-console-974.6).
// Opened by keyboardNav.js's `?` binding (or the header's Guide-area button);
// a native <dialog> so it gets Escape-to-close and the top-layer stacking
// contract for free, same as MoleculeDialog.
//
// Every row here is a shortcut that ACTUALLY EXISTS after this change — the
// Space/x row is feature-detected (hasSelectionApi()) and simply doesn't
// render until a selection API lands in store.js, rather than advertising
// something that currently no-ops.
import { html } from 'htm/preact';
import { useEffect, useRef } from 'preact/hooks';
import { helpOpen, closeHelp, hasSelectionApi } from './keyboardNav.js';

function row(label, keys) {
  return html`
    <div class="c2-help-row" key=${label}>
      <span>${label}</span>
      <span class="c2-help-keys">${keys.map((k) => html`<span key=${k} class="c2-help-key">${k}</span>`)}</span>
    </div>`;
}

function group(title, rows) {
  return html`
    <div class="c2-help-group" key=${title}>
      <h3>${title}</h3>
      <div class="c2-help-rows">${rows.map(([label, keys]) => row(label, keys))}</div>
    </div>`;
}

function buildGroups() {
  const flowRows = [
    ['Move focus between cards', ['j', '↓']],
    ['Move focus (reverse)', ['k', '↑']],
    ['Jump to next lane', [']']],
    ['Jump to previous lane', ['[']],
    ['Open the focused card', ['Enter']],
    ['Clear card focus', ['Esc']],
  ];
  if (hasSelectionApi()) flowRows.splice(4, 0, ['Toggle selection', ['Space', 'x']]);

  return [
    {
      title: 'Global',
      rows: [
        ['New issue', ['i']],
        ['This help', ['?']],
      ],
    },
    {
      title: 'Omnibar',
      rows: [
        ['Focus / open', ['/', '⌘K']],
        ['Move selection', ['↑', '↓']],
        ['Run selected', ['Enter']],
        ['Close', ['Esc']],
      ],
    },
    { title: 'Flow navigation', rows: flowRows },
    {
      title: 'Detail panel',
      rows: [
        ['Close', ['Esc']],
        ['Cycle controls', ['Tab']],
        ['Submit comment', ['⌘', 'Enter']],
      ],
    },
    {
      title: 'Workspace views',
      rows: [
        ['Switch Flow / Map / Docs', ['←', '→']],
      ],
    },
  ];
}

export function HelpOverlay() {
  const ref = useRef(null);
  const open = helpOpen.value;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Rebuilt on every open (cheap, tiny list) so a Space/x row that starts
  // existing mid-session — a parallel agent's selection API landing — shows
  // up without a reload.
  const groups = open ? buildGroups() : [];

  return html`
    <dialog class="dialog dialog-lg c2-help-dialog" ref=${ref}
      onCancel=${(e) => { e.preventDefault(); closeHelp(); }} onClose=${closeHelp}>
      <div class="dialog-body">
        <div class="dialog-head">
          <span aria-hidden="true">⌨</span> Keyboard shortcuts
          <button class="c2-detail-close" title="Close" onClick=${closeHelp}>✕</button>
        </div>
        <div class="c2-help-groups">
          ${groups.map((g) => group(g.title, g.rows))}
        </div>
        <div class="dialog-actions">
          <button class="c2-mini" onClick=${closeHelp}>Close</button>
        </div>
      </div>
    </dialog>`;
}
