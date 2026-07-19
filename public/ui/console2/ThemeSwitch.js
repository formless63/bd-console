// console2/ThemeSwitch.js — compact preset + scheme control for the Console
// 2.0 header (and, at the mobile breakpoint, the pulse drawer — see the
// .c2-themesw-header / .c2-themesw-pulse visibility split in console2.css).
// Deliberately thin: all persistence and DOM side effects (data-theme /
// data-scheme attributes, localStorage) live in ../theme.js already and are
// reused verbatim here rather than forked — this file is only the popover
// presentation + its own open/close state.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store } from '../store.js';
import { THEME_PRESETS, SCHEMES, setPreset, setScheme } from '../theme.js';

export function ThemeSwitch() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const preset = store.themePreset.value;
  const scheme = store.themeScheme.value;

  // Same outside-click-closes pattern used by the hub's session combobox
  // (components/ScheduleView.js) — kept consistent rather than reinvented.
  useEffect(() => {
    function onDocClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    function onKeyDown(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onKeyDown); };
  }, []);

  return html`
    <div class="c2-themesw" ref=${wrapRef}>
      <button class="c2-themesw-btn" aria-label="Theme settings" title="Theme" aria-expanded=${open} onClick=${() => setOpen((o) => !o)}>
        <span class="c2-icon" aria-hidden="true">◐</span>
      </button>
      ${open && html`
        <div class="c2-themesw-pop" role="menu">
          <label class="c2-hud-label" for="c2-themesw-preset">Preset</label>
          <select id="c2-themesw-preset" class="c2-edit-input" value=${preset} onChange=${(e) => setPreset(e.target.value)}>
            ${THEME_PRESETS.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
          </select>
          <span class="c2-hud-label" style="margin-top:8px">Scheme</span>
          <div class="c2-themesw-scheme">
            ${SCHEMES.map((s) => html`
              <button key=${s.id} class=${'c2-mini' + (scheme === s.id ? ' on' : '')} aria-pressed=${scheme === s.id} onClick=${() => setScheme(s.id)}>${s.name}</button>`)}
          </div>
        </div>`}
    </div>`;
}
