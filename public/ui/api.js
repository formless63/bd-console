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
    if (r.status === 401) throw new AuthError(data.error || 'token required');
    throw new Error(data.error || `HTTP ${r.status}`);
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
