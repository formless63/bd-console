// console2/ThemeSwitch.js — Console 2.0's header/pulse-drawer theme control
// (bd-console-974.7: unified with components/ThemeSwitch.js, which now owns
// both looks behind a `variant` prop — see its header comment for the full
// rationale). Kept as its own module, pinned to variant="c2", purely so
// Console2.js/Pulse.js's existing `import { ThemeSwitch } from
// './ThemeSwitch.js'` + `<${ThemeSwitch} />` call sites need no changes.
import { html } from 'htm/preact';
import { ThemeSwitch as SharedThemeSwitch } from '../components/ThemeSwitch.js';

export function ThemeSwitch() {
  return html`<${SharedThemeSwitch} variant="c2" />`;
}
