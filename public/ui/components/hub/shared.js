// components/hub/shared.js — the handful of presentational bits that cross
// the OpsStrip / UsageSection boundary (bd-console-974.7 HubView.js split:
// see hub/ProjectGrid.js and hub/UsageSection.js). Kept tiny and dependency-
// light on purpose — anything with just one caller stayed where it's used.
import { html } from 'htm/preact';
import { toast } from '../../store.js';
import { copyToClipboard } from '../common.js';

// Chevron used by the mobile collapsible-section headers (ops strip, tmux
// strip, usage/quota) — see .hub-section-toggle / .hub-section-body in
// styles.css. Only visible at <=768px; on desktop the toggle header itself
// is hidden so this never renders there. Pass alwaysVisible for a section
// that collapses at every viewport (currently just the usage attribution
// band), which needs the chevron on desktop too.
export function ChevronIcon({ open, alwaysVisible }) {
  return html`<svg class=${'hub-section-chevron' + (alwaysVisible ? ' chevron-visible' : '')} width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"
    style=${'transform:rotate(' + (open ? '0' : '-90') + 'deg)'}><path fill="currentColor" d="M4 6l4 4 4-4"/></svg>`;
}

// Unmistakable external-link glyph (box + escaping arrow) — used by the bd
// version link and the docs chip so both read as "leaves the app" even
// without relying on target="_blank" alone (which isn't visually apparent).
export function ExternalLinkIcon() {
  return html`<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" class="external-link-icon">
    <path fill="currentColor" d="M6.5 2a.5.5 0 000 1H11.3L5.15 9.15a.5.5 0 10.7.7L12 3.7V8.5a.5.5 0 001 0v-6a.5.5 0 00-.5-.5h-6z"/>
    <path fill="currentColor" d="M4 4a2 2 0 00-2 2v6a2 2 0 002 2h6a2 2 0 002-2V9a.5.5 0 00-1 0v3a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1h3a.5.5 0 000-1H4z"/>
  </svg>`;
}

// Shared by OpsStrip's "update available" chip (bd version) AND
// UsageSection's CliVersionChips (Claude Code / Codex version) — both copy an
// upgrade command and toast the outcome, or the raw text if the clipboard
// write itself failed.
export async function copyUpdateCommand(cmd) {
  const ok = await copyToClipboard(cmd);
  toast(ok ? `Copied "${cmd}"` : cmd, ok ? 'ok' : 'warn', ok ? 3200 : 8000);
}
