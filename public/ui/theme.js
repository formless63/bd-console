// theme.js — named theme presets, each with a light and dark variant, plus an
// "auto" scheme that follows prefers-color-scheme. Applying a theme sets
// data-theme + data-scheme on <html> (driving the token sets in styles.css) and
// toggles Shoelace's sl-theme-dark class so its components track the scheme.

import { effect } from '@preact/signals';
import { store } from './store.js';

export const THEME_PRESETS = [
  { id: 'synergy', name: 'Synergy' },
  { id: 'default', name: 'Default' },
  { id: 'dracula', name: 'Dracula' },
  { id: 'nord', name: 'Nord' },
  { id: 'gruvbox', name: 'Gruvbox' },
  { id: 'tokyo-night', name: 'Tokyo Night' },
];
export const SCHEMES = [
  { id: 'auto', name: 'Auto' },
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
];

const mq = matchMedia('(prefers-color-scheme: dark)');

export function resolveScheme(scheme) {
  if (scheme === 'light' || scheme === 'dark') return scheme;
  return mq.matches ? 'dark' : 'light';
}

export function applyTheme() {
  const preset = store.themePreset.value;
  const scheme = store.themeScheme.value;
  const resolved = resolveScheme(scheme);
  const root = document.documentElement;
  root.setAttribute('data-theme', preset);
  root.setAttribute('data-scheme', resolved);
  root.classList.toggle('sl-theme-dark', resolved === 'dark');
  root.classList.toggle('sl-theme-light', resolved !== 'dark');
}

export function setPreset(id) {
  store.themePreset.value = id;
  localStorage.setItem('bd_theme_preset', id);
}
export function setScheme(id) {
  store.themeScheme.value = id;
  localStorage.setItem('bd_theme_scheme', id);
}

export function initTheme() {
  applyTheme();
  effect(applyTheme);                    // re-apply whenever preset/scheme signals change
  mq.addEventListener('change', () => { if (store.themeScheme.value === 'auto') applyTheme(); });
}
