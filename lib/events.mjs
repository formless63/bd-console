// lib/events.mjs — the /api/events SSE change feed (bd-console-974.3).
//
// WHY: every view in the dashboard used to learn about a change by polling, so
// a write made in a terminal (`bd close x`, an agent's `bd create`) took a
// manual reload to show up, and a write made in one browser tab was invisible
// in another. This module is the one place that says "something changed";
// clients subscribe once and refetch what they care about.
//
// The feed carries NOTIFICATIONS, never data. An event says "project X's issues
// moved" — the client then re-GETs /api/p/X/issues (or /stats) through the
// normal, ETag-aware route. That keeps this module tiny, keeps a slow/absent
// consumer from holding issue payloads in memory, and means a missed event
// costs a stale card until the next one rather than a corrupted view.
//
// Two detectors, deliberately both:
//   * in-process — routes.mjs calls emit() after a write route's forced export
//     lands. Instant, and it knows exactly which project moved.
//   * filesystem — one coarse 2s interval stat()s each registered project's
//     .beads/issues.jsonl. Catches every write bd-console did not make itself
//     (a terminal, an agent, `bd sync`), which is the majority of them on a
//     machine where agents are the ones filing issues.
// Both funnel through the same debounced publish(), so a write that trips both
// (the common case: routes.mjs emits, then the sweeper sees the new mtime)
// still produces exactly one event — see stamps below.
//
// COST WHEN NOBODY IS LISTENING: zero. The sweeper only runs while at least one
// client is connected, and it is stopped again on the last disconnect.
//
// ACCESS: none of its own. The endpoint is gated exactly like the other read
// routes in lib/routes.mjs (i.e. not at all when no token is configured), and
// the payload is strictly {kind, project, ts} — no titles, no paths, nothing
// that isn't already on /api/projects.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { loadRegistry } from './registry.mjs';

// A comment line every 25s. Proxies (nginx, Cloudflare, Pangolin — all three
// are in this project's deployment story) idle-kill a stream that says nothing
// for 30-60s, and a killed stream is indistinguishable from a quiet one.
// BD_CONSOLE_SSE_HEARTBEAT overrides it in ms — same escape hatch (and same
// reason) as BD_CONSOLE_SCHED_INTERVAL: scripts/smoke/ asserts that a real
// heartbeat arrives on the wire, and it is not waiting 25s to find out.
const HEARTBEAT_MS = Number(process.env.BD_CONSOLE_SSE_HEARTBEAT) || 25_000;
// One sweep for ALL projects, not one timer per project: a hub with a dozen
// repos should cost a dozen stat()s every 2s, which is nothing, and never a
// dozen timers.
const SWEEP_MS = 2_000;
// At most one event per project per window. Coalescing is trailing-edge (see
// publish): a burst of writes emits immediately, then once more at the end of
// the window, so the last write in a burst is never the one that goes unsaid.
const DEBOUNCE_MS = 2_000;

const clients = new Set();       // { res, hb }
const stamps = new Map();        // projectId -> "<mtimeMs>:<size>" | '' (absent file)
const lastPublishedAt = new Map(); // debounce key -> ms
const trailing = new Map();      // debounce key -> timer
let sweeper = null;

// The identity of an export file for change-detection purposes. mtime alone is
// not enough (a same-millisecond rewrite is possible on a fast box), size alone
// is not enough (an edit that keeps the byte count) — together they are as good
// as it gets without hashing the file on every sweep.
async function stampOf(workspace) {
  try {
    const st = await stat(join(workspace, '.beads', 'issues.jsonl'));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return ''; // missing export — a real, distinguishable state
  }
}

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeToAll(text) {
  for (const client of clients) {
    // A dead socket surfaces here rather than on 'close' sometimes (an aborted
    // request whose cleanup hasn't run yet) — drop it and keep going; one
    // broken consumer must never stop the others being told.
    try { client.res.write(text); } catch { drop(client); }
  }
}

function send(kind, project) {
  // `project` is present for per-project kinds only: the wire shapes are
  // {"kind":"issues","project":"<id>","ts":<ms>} and {"kind":"schedule","ts":<ms>}.
  const ts = Date.now();
  writeToAll(frame('change', kind === 'issues' ? { kind, project, ts } : { kind, ts }));
}

function debounceKey(kind, project) {
  return kind === 'issues' ? `issues:${project}` : kind;
}

function publish(kind, project) {
  if (!clients.size) return; // nothing to tell, and no timers worth arming
  const key = debounceKey(kind, project);
  const now = Date.now();
  const wait = DEBOUNCE_MS - (now - (lastPublishedAt.get(key) || 0));
  if (wait <= 0) {
    lastPublishedAt.set(key, now);
    send(kind, project);
    return;
  }
  if (trailing.has(key)) return; // one trailing emit already covers this burst
  const timer = setTimeout(() => {
    trailing.delete(key);
    lastPublishedAt.set(key, Date.now());
    send(kind, project);
  }, wait);
  if (typeof timer.unref === 'function') timer.unref();
  trailing.set(key, timer);
}

// emit(kind, project): the ONE way anything announces a change.
//   emit('issues', projectId) — that project's issue export moved.
//   emit('schedule')          — a scheduler job was created/cancelled/retried,
//                               or fired and changed state.
// Never throws and never awaits anything the caller cares about: a write route
// must not fail, or slow down, because a listener's socket is unhappy.
export function emit(kind, project = null) {
  if (kind !== 'issues' && kind !== 'schedule') return;
  // Nobody listening: no stat, no registry read, no timer. This is what makes
  // the feed genuinely free on a hub whose dashboard isn't open — and it is
  // safe because the sweeper drops its baselines when the last client leaves,
  // so there is no stale stamp for the next connection to inherit.
  if (!clients.size) return;
  if (kind === 'issues') {
    if (!project) return;
    // Re-stamp the file we are announcing so the sweeper doesn't announce the
    // same write again 2s later. Fire-and-forget: the sweep that could
    // double-report is at least SWEEP_MS away, and if the stat loses that race
    // the debounce above still collapses the pair.
    const entry = loadRegistry().projects[project];
    if (entry && entry.path) {
      stampOf(entry.path).then((s) => stamps.set(project, s)).catch(() => {});
    }
  }
  publish(kind, project);
}

// --- the filesystem sweeper --------------------------------------------------
// Re-reads the registry every sweep (loadRegistry is a small JSON file read)
// rather than caching it, because `bd-console add` / POST /api/register can
// register a project while a client is connected, and a feed that only knows
// the projects that existed when the first tab opened is a feed that silently
// stops working after a registration.
async function sweep() {
  const projects = loadRegistry().projects || {};
  const seen = new Set();
  for (const [id, entry] of Object.entries(projects)) {
    if (!entry || !entry.path) continue;
    seen.add(id);
    const stamp = await stampOf(entry.path);
    if (!stamps.has(id)) { stamps.set(id, stamp); continue; } // first sight: baseline, no event
    if (stamps.get(id) === stamp) continue;
    stamps.set(id, stamp);
    publish('issues', id);
  }
  for (const id of [...stamps.keys()]) {
    if (!seen.has(id)) stamps.delete(id); // unregistered — forget it
  }
}

async function startSweeper() {
  if (sweeper) return;
  // Seed baselines BEFORE the first tick: without this, a fresh connection
  // would report every registered project as "changed" two seconds later.
  await sweep().catch(() => {});
  if (!clients.size) return; // the client left while we were seeding
  sweeper = setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();
}

function stopSweeper() {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
  // Baselines are dropped with the sweeper: the next connection re-seeds them,
  // which is both correct (the world moved while nobody was watching) and the
  // reason nothing accumulates here across a long uptime.
  stamps.clear();
}

function drop(client) {
  if (!clients.delete(client)) return;
  clearInterval(client.hb);
  try { client.res.end(); } catch { /* already gone */ }
  if (!clients.size) stopSweeper();
}

// subscribe(req, res): takes over the response for the lifetime of the stream.
// The caller must not write to or end `res` afterwards.
export function subscribe(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // nginx buffers proxied responses by default, which turns a change feed
    // into a batch delivered whenever the buffer happens to flush.
    'x-accel-buffering': 'no',
  });
  // Small frames, sent rarely: Nagle would add up to 40ms of nothing, and the
  // default socket timeout would eventually kill an idle-but-healthy stream.
  if (req.socket) {
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
  }

  const client = { res, hb: null };
  client.hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch { drop(client); }
  }, HEARTBEAT_MS);
  if (typeof client.hb.unref === 'function') client.hb.unref();
  clients.add(client);

  // Immediately, so the client can tell "connected" from "connecting" without
  // waiting up to 25s for the first heartbeat.
  try { res.write(frame('hello', { ts: Date.now() })); } catch { drop(client); return; }

  res.on('close', () => drop(client));
  res.on('error', () => drop(client));

  startSweeper().catch(() => {});
}

// How many streams are open. Exported for smoke coverage and for anything that
// wants to skip work nobody is listening for.
export function clientCount() {
  return clients.size;
}

// shutdownEvents(): stop the timers and close every stream. Wired into
// serve.mjs's signal handler — an open SSE response is a live socket, so
// without this a graceful server.close() would wait for browsers that have no
// reason to ever hang up.
export function shutdownEvents() {
  for (const timer of trailing.values()) clearTimeout(timer);
  trailing.clear();
  lastPublishedAt.clear();
  for (const client of [...clients]) drop(client);
  stopSweeper();
}
