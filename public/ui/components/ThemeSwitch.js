// ThemeSwitch.js — compact ◐ trigger + popover for switching theme preset /
// scheme from cramped chrome. Two call sites, two looks, ONE component
// (bd-console-974.7 — this used to be forked with console2/ThemeSwitch.js,
// which stayed near-identical apart from styling/positioning and had drifted
// into two copies of the same outside-click/Escape-closes popover logic):
//
//   variant="default" (the default) — the hub topbar at <=768px, in place of
//     the two Shoelace selects that don't work well on a phone (see
//     styles.css's .theme-picker / .theme-switch-mobile split). Popover is
//     `position: fixed`, computed from the trigger's rect on open, because
//     the trigger lives inside .topbar-right, which carries
//     overflow-x: auto below 900px (so the old two-select row could scroll
//     instead of squeezing the brand) — an absolutely positioned popover
//     there gets clipped by that ancestor's overflow. `fixed` escapes it
//     without touching the topbar's own overflow rule.
//   variant="c2" — Console 2.0's header (and, at the mobile breakpoint, the
//     pulse drawer — see console2.css's .c2-themesw-* rules and the
//     .c2-themesw-header / .c2-themesw-pulse visibility split). No clipping
//     ancestor there, so its popover stays simple: CSS-positioned (absolute,
//     relative to the wrapper), no rect math needed.
//
// Both reuse ../theme.js's setPreset/setScheme verbatim for all persistence
// and DOM side effects — there is no forked state, only forked markup/CSS
// hooks. console2/ThemeSwitch.js re-exports this with variant="c2" pinned so
// Console2.js/Pulse.js's existing `<ThemeSwitch />` call sites (no props)
// keep working unchanged.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store } from '../store.js';
import { THEME_PRESETS, SCHEMES, setPreset, setScheme } from '../theme.js';

export function ThemeSwitch({ className = '', variant = 'default' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const preset = store.themePreset.value;
  const scheme = store.themeScheme.value;
  const c2 = variant === 'c2';

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
      // c2's popover is plain CSS-positioned — no clipping ancestor to
      // escape, so it never needs the fixed-position rect computation below.
      if (next && !c2 && btnRef.current) {
        const r = btnRef.current.getBoundingClientRect();
        setPos({ top: Math.round(r.bottom + 8), right: Math.max(8, Math.round(window.innerWidth - r.right)) });
      }
      return next;
    });
  };

  if (c2) {
    return html`
      <div class="c2-themesw" ref=${wrapRef}>
        <button class="c2-themesw-btn" aria-label="Theme settings" title="Theme" aria-expanded=${open} onClick=${toggle}>
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
