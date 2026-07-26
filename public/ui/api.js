// api.js — thin fetch layer over the bd-console hub HTTP API.
// All project-scoped calls go through apiUrl(), which prefixes /api/p/<id>/
// when a project is active (hub mode). Writes carry the x-bd-token header when
// the server reports a token is required.

import { store } from './store.js';

export function apiUrl(path) {
  const pid = store.projectId.value;
  if (pid && path.startsWith('/api/')) {
    return '/api/p/' + encodeURIComponent(pid) + '/' + path.substring(5);
  }
  return path;
}

export function getToken() {
  return localStorage.getItem('bd_token') || '';
}
export function setToken(t) {
  if (t) localStorage.setItem('bd_token', t);
  else localStorage.removeItem('bd_token');
}

// Raised on a 401 so the UI can surface the token prompt.
export class AuthError extends Error {}

async function parse(r) {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = r.status === 401
      ? new AuthError(data.error || 'token required')
      : new Error(data.error || `HTTP ${r.status}`);
    // The FULL error body, not just its message. Some routes attach
    // structured detail a caller needs to render honestly — notably
    // /api/molecules/pour's `partial` report, which says what (if anything) a
    // failed multi-bead pour actually left behind.
    err.status = r.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export async function apiGet(path) {
  const r = await fetch(apiUrl(path), { headers: { accept: 'application/json' } });
  return parse(r);
}

// Raw GET without project prefixing (hub-root endpoints).
export async function apiGetRaw(path) {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  return parse(r);
}

export async function apiPost(path, body) {
  const headers = { 'content-type': 'application/json' };
  const tokenRequired = store.meta.value?.tokenRequired;
  if (tokenRequired) headers['x-bd-token'] = getToken();
  const r = await fetch(apiUrl(path), { method: 'POST', headers, body: JSON.stringify(body) });
  return parse(r);
}

// Raw POST without project prefixing — for hub-level routes (/api/settings)
// and for calls that must target an explicit project id that may not match
// the currently-active store.projectId (e.g. the Settings page's "Default
// epics" card, which lets the user act on any registered project while
// store.projectId itself stays null on #/settings).
export async function apiPostRaw(path, body) {
  const headers = { 'content-type': 'application/json' };
  const tokenRequired = store.meta.value?.tokenRequired;
  if (tokenRequired) headers['x-bd-token'] = getToken();
  const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return parse(r);
}
