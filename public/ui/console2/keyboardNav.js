// console2/keyboardNav.js — Console 2.0's own j/k card cursor (bd-console-974.6).
//
// app.js retired j/k when Console 2.0 shipped (see its onKeyDown comment):
// "Console 2.0 drives selection through the omnibar and Flow lanes instead."
// This re-introduces it scoped ENTIRELY to console2/Flow, wired from
// Console2.js rather than app.js — the same ownership split app.js already
// uses for `/` (Omnibar owns it while mounted; app.js's global handler skips
// it on the console2 route).
//
// DOM-driven, not signal-driven: Flow.js and store.js are owned by a
// parallel agent for this change, so a focus cursor can't be threaded
// through Card as a prop or through a new store signal. Instead this moves
// REAL DOM focus onto each card's existing `.c2-card-open` button (every
// Card already renders one — see Flow.js), which gets two things for free:
// (1) the app's existing `:focus-visible` rule is already the entire
// "visible focus ring" contract, no bespoke styling needed; (2) it composes
// with mouse clicks and Tab for free, since "current" is read from
// document.activeElement rather than tracked in separate state that could
// drift from it. Enter is still handled explicitly below (see its case) —
// synthetic keyboard events don't reliably trigger a button's native
// activation, so leaning on that would silently drop Enter for exactly the
// automated/assistive contexts this exists for.
import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { store, selectIssue } from '../store.js';
// Feature-detection only — NOT a static named import of anything that may
// not exist. store.js is off-limits for this change; a parallel agent may
// add a selection API to it independently. Importing the whole namespace
// object and probing it at call time means this file loads cleanly whether
// or not that landed yet (a named `import { toggleIssueSelection }` would
// throw at module-evaluation time if the export doesn't exist).
import * as StoreNS from '../store.js';
import { c2 } from './state.js';

// Replicates app.js's isTyping() rather than importing it (app.js has no
// exports to import — it's the entry point) so j/k/[/]/Space/x never fight
// the omnibar or any other input, textarea, select or contenteditable.
function isTypingTarget() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || /^SL-(INPUT|SELECT|TEXTAREA)$/.test(tag);
}

// The ? help overlay's open state — owned here (not HelpOverlay.js) so this
// module never has to import back from its own consumer.
export const helpOpen = signal(false);
export function openHelp() { helpOpen.value = true; }
export function closeHelp() { helpOpen.value = false; }

// Space/x toggle a selection ONLY if a selection API has actually landed in
// store.js — checked by name at call time, never assumed. Two plausible
// shapes are probed since the exact name a parallel agent picks isn't known
// yet; extend this list rather than hard-depending on either.
export function hasSelectionApi() {
  return typeof StoreNS.toggleSelection === 'function'
    || typeof StoreNS.toggleIssueSelection === 'function'
    || typeof StoreNS.toggleSelected === 'function';
}
function toggleSelection(id) {
  if (!id) return;
  // bd-console-974.5 landed the API as toggleSelection — probed first.
  if (typeof StoreNS.toggleSelection === 'function') { StoreNS.toggleSelection(id); return; }
  if (typeof StoreNS.toggleIssueSelection === 'function') { StoreNS.toggleIssueSelection(id); return; }
  if (typeof StoreNS.toggleSelected === 'function') { StoreNS.toggleSelected(id); return; }
  // No selection API yet — Space/x still preventDefault (see below) so they
  // don't fall through to a card button's native space-bar click, but
  // otherwise no-op.
}

function cardsInOrder() {
  const root = document.querySelector('#c2-view-panel');
  return root ? [...root.querySelectorAll('.c2-card-open')] : [];
}
function currentCard() {
  return document.activeElement?.closest?.('.c2-card-open') || null;
}
function cardId(el) {
  const card = el?.closest?.('.c2-card');
  return card?.querySelector('.c2-card-id')?.textContent?.trim() || null;
}
function laneOf(el) {
  return el?.closest?.('.c2-lane, .c2-epicrow') || null;
}
function focusEl(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
}

function moveCursor(dir) {
  const cards = cardsInOrder();
  if (!cards.length) return;
  const cur = currentCard();
  const idx = cur ? cards.indexOf(cur) : -1;
  const next = idx === -1
    ? (dir > 0 ? cards[0] : cards[cards.length - 1])
    : cards[Math.min(cards.length - 1, Math.max(0, idx + dir))];
  focusEl(next);
}

// [ / ] jump to the first card of the next/previous lane (Flow's `.c2-lane`
// sections, or `.c2-epicrow` rows when grouped by epic — both render the
// same `.c2-card-open` buttons). Skips past empty lanes/rows in the chosen
// direction rather than stopping on one with nothing to focus.
function moveLane(dir) {
  const containers = [...document.querySelectorAll('#c2-view-panel .c2-lane, #c2-view-panel .c2-epicrow')];
  if (!containers.length) return;
  const cur = currentCard();
  const curContainer = laneOf(cur);
  const startIdx = curContainer ? containers.indexOf(curContainer) : (dir > 0 ? -1 : containers.length);
  let idx = startIdx;
  for (let tries = 0; tries < containers.length; tries++) {
    idx += dir;
    if (idx < 0 || idx >= containers.length) return; // ran off the end — stay put
    const card = containers[idx].querySelector('.c2-card-open');
    if (card) { focusEl(card); return; }
  }
}

// Wired from Console2.js (not app.js): mounts a single window keydown
// listener for exactly as long as the console2 route is on screen, mirroring
// Omnibar.js's own self-contained `/`-focus effect.
export function useConsole2Keyboard() {
  useEffect(() => {
    function onKeyDown(e) {
      if (isTypingTarget() || e.metaKey || e.ctrlKey || e.altKey) return;
      // Any open native <dialog> (Molecules, formula editor, distill, this
      // module's own Help overlay) owns the keyboard while shown.
      if (document.querySelector('dialog[open]')) return;

      if (e.key === '?') { e.preventDefault(); openHelp(); return; }

      // Card navigation only makes sense in Flow, and never while Detail is
      // open — Detail is a custom (non-<dialog>) slide-over with its own
      // capture-phase Escape/Tab contract (see Detail.js), so this defers to
      // it entirely rather than racing it.
      if (c2.canvasMode.value !== 'flow' || store.selectedId.value) return;

      switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); moveCursor(1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); moveCursor(-1); break;
        case '[': e.preventDefault(); moveLane(-1); break;
        case ']': e.preventDefault(); moveLane(1); break;
        // .c2-card-open is a real <button> whose own onClick already calls
        // selectIssue(id) (Flow.js), so a browser's native "Enter activates
        // the focused button" default action would open Detail for free.
        // Handled explicitly anyway (preventDefault + selectIssue directly)
        // rather than relying on it: synthetic keyboard events (this file's
        // own browser smoke check, and some AT/remap tooling) don't reliably
        // trigger that native activation, so depending on it silently drops
        // Enter in exactly the automated/assistive contexts this exists for.
        case 'Enter': {
          e.preventDefault();
          const id = cardId(currentCard());
          if (id) selectIssue(id);
          break;
        }
        case ' ': case 'x':
          // preventDefault regardless of hasSelectionApi(): Space's native
          // effect on a focused <button> is to click it (open Detail), which
          // is not what Space means here even before a selection API exists.
          e.preventDefault();
          toggleSelection(cardId(currentCard()));
          break;
        case 'Escape': {
          const el = document.activeElement;
          if (el?.closest?.('.c2-card-open')) el.blur();
          break;
        }
        default: break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
