// ThemeSwitch.js — compact ◐ trigger + popover for switching theme preset /
// scheme from cramped chrome (currently: the topbar at <=768px, in place of
// the two Shoelace selects that don't work well on a phone — see
// styles.css's .theme-picker / .theme-switch-mobile visibility split).
// Modeled on console2/ThemeSwitch.js's interaction pattern (same outside-
// click-closes popover, same preset-select + scheme-row layout) but is its
// own module styled with this app's own tokens — console2 owns its file and
// isn't touched here. Both reuse ../theme.js's setPreset/setScheme verbatim
// for all persistence and DOM side effects, so there's no forked state.
//
// Positioning: fixed (computed from the trigger button's rect on open)
// rather than the absolute-under-the-button placement console2's version
// uses. The trigger lives inside .topbar-right, which carries
// overflow-x: auto below 900px (a pre-existing rule so the old two-select
// layout could scroll instead of squeezing the brand) — an absolutely
// positioned popover there gets clipped by that ancestor's overflow, so it
// paints but stops being hit-testable/visible past the topbar's edge.
// position: fixed escapes that (its containing block is the viewport, not
// .topbar-right, since nothing in between establishes one) without having
// to touch the topbar's own overflow rule.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store } from '../store.js';
import { THEME_PRESETS, SCHEMES, setPreset, setScheme } from '../theme.js';

export function ThemeSwitch({ className = '' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const preset = store.themePreset.value;
  const scheme = store.themeScheme.value;

  useEffect(() => {
    function onDocClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    function onKeyDown(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onKeyDown); };
  }, []);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next && btnRef.current) {
        const r = btnRef.current.getBoundingClientRect();
        setPos({ top: Math.round(r.bottom + 8), right: Math.max(8, Math.round(window.innerWidth - r.right)) });
      }
      return next;
    });
  };

  return html`
    <div class=${'theme-switch ' + className} ref=${wrapRef}>
      <button
        ref=${btnRef}
        type="button"
        class="theme-switch-btn"
        aria-label="Theme settings"
        title="Theme"
        aria-expanded=${open}
        onClick=${toggle}
      ><span aria-hidden="true">◐</span></button>
      ${open && pos && html`
        <div class="theme-switch-pop" style=${`top:${pos.top}px; right:${pos.right}px;`} role="menu">
          <label class="theme-switch-label" for="theme-switch-preset">Preset</label>
          <select id="theme-switch-preset" class="edit-input theme-switch-select" value=${preset} onChange=${(e) => setPreset(e.target.value)}>
            ${THEME_PRESETS.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
          </select>
          <span class="theme-switch-label theme-switch-scheme-label">Scheme</span>
          <div class="theme-switch-scheme">
            ${SCHEMES.map((s) => html`
              <button
                key=${s.id}
                type="button"
                class=${'theme-switch-mini' + (scheme === s.id ? ' on' : '')}
                aria-pressed=${scheme === s.id}
                onClick=${() => setScheme(s.id)}
              >${s.name}</button>`)}
          </div>
        </div>`}
    </div>`;
}
