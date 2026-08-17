// events.js — live-refresh client for GET /api/events (text/event-stream).
//
// Contract (backend, landing alongside this): on connect, `event: hello`
// with `{"ts":<ms>}`; on a change, `event: change` with
// `{"kind":"issues","project":"<id>","ts":<ms>}` or
// `{"kind":"schedule","ts":<ms>}`; a bare `: hb` comment line every ~25s to
// keep the connection alive through proxies. This module may be running
// against a server that predates the route entirely (a clean 404) — that is
// the same "older server" case every other optional endpoint in store.js
// degrades on, and it is treated identically here: `eventsAvailable` flips
// to `false` and stays there, and callers (Console2's canvas) fall back to
// their own poll instead.
//
// Native EventSource is deliberately NOT used for the long-lived connection:
// it cannot see the HTTP status code, so a 404 and a transient network blip
// look identical to it, and this module needs to tell them apart (one is
// permanent — fall back to polling; the other should retry). A plain fetch()
// resolves as soon as headers arrive, before the body is consumed, so the
// status is available up front; the body is then read as a stream and parsed
// by hand, which is a small amount of code for the three frame shapes above
// and keeps this in the same "raw protocol over a built-in" style as
// scripts/smoke/browser.mjs's CDP client.
import { signal } from '@preact/signals';
import { store, loadIssues, loadSchedule } from './store.js';

// null = not yet known (still connecting for the first time); true = a
// `hello` has been received and the stream is live; false = the server
// returned 404 for /api/events (predates this feature) — permanent for this
// page load, since an older server cannot start supporting the route mid
// session. Consumers (Console2's poll fallback) read `.value` directly.
export const eventsAvailable = signal(null);

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

let backoff = BASE_BACKOFF_MS;
let reconnectTimer = null;
let abortController = null;
let started = false;
let hiddenSince = null;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

// A `change` event while the tab is hidden is deliberately a no-op — nobody
// is looking, so there is no rush, and calling loadIssues()/loadSchedule()
// for every change on a busy hidden tab would just be wasted work (the same
// reasoning poll.js documents for its own hidden-tab skip). The catch-up on
// visibilitychange below is what guarantees freshness once someone looks
// again, so nothing here needs to be remembered/queued.
function handleChange(evt) {
  if (!evt || document.hidden) return;
  if (evt.kind === 'issues') {
    if (evt.project && evt.project === store.projectId.value) loadIssues();
  } else if (evt.kind === 'schedule') {
    if (store.route.value.view === 'schedule') loadSchedule();
  }
}

// Mirrors poll.js's own "only catch up if a real interval elapsed" guard —
// a quick alt-tab shouldn't cost a reload, but coming back after any
// meaningful time away should, both because a `change` event could have
// been missed (the connection can be paused/dropped by the browser while
// the tab is backgrounded) and because it is cheap insurance regardless.
const CATCHUP_MIN_HIDDEN_MS = 3000;
function onVisibilityChange() {
  if (document.hidden) { hiddenSince = Date.now(); return; }
  const was = hiddenSince;
  hiddenSince = null;
  if (!was || (Date.now() - was) < CATCHUP_MIN_HIDDEN_MS) return;
  if (store.projectId.value) loadIssues();
  if (store.route.value.view === 'schedule') loadSchedule();
}

function parseFrame(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue; // blank / heartbeat comment
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (event === 'hello') {
    eventsAvailable.value = true;
    backoff = BASE_BACKOFF_MS; // a live server proved itself — drop back to the fast retry floor
    return;
  }
  if (event === 'change' && dataLines.length) {
    let data;
    try { data = JSON.parse(dataLines.join('\n')); } catch { return; }
    handleChange(data);
  }
}

async function readStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      parseFrame(raw);
    }
  }
}

async function connect() {
  if (abortController) abortController.abort();
  abortController = new AbortController();
  let res;
  try {
    res = await fetch('/api/events', {
      headers: { accept: 'text/event-stream' },
      signal: abortController.signal,
    });
  } catch (e) {
    if (abortController.signal.aborted) return; // superseded by a newer connect() — not a failure
    scheduleReconnect();
    return;
  }
  if (res.status === 404) {
    // Permanent: this server predates /api/events. Don't retry — Console2's
    // useVisiblePoll fallback takes over for the rest of this page load.
    eventsAvailable.value = false;
    try { res.body?.cancel(); } catch { /* ignore */ }
    return;
  }
  if (!res.ok || !res.body) {
    scheduleReconnect();
    return;
  }
  try {
    await readStream(res.body);
  } catch (e) {
    if (abortController.signal.aborted) return;
  }
  if (abortController.signal.aborted) return; // deliberate close, not a drop
  scheduleReconnect();
}

// Called once from App.js — the connection (and its fallback-vs-live
// determination) is app-lifetime, independent of route, so a project switch
// or navigating away from Console2 never tears it down and reconnects it.
export function startEventStream() {
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  connect();
}
