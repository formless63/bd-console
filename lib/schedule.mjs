// lib/schedule.mjs — prompt scheduler: queue prompts to be typed into an
// EXISTING tmux session at a scheduled time. Never creates tmux sessions,
// never runs `claude -p`; it only re-uses lib/tmux.mjs's literal send-keys
// injection against a session the caller named.
//
// Storage: node:sqlite (DatabaseSync) at <CONFIG_DIR>/schedule.db. node:sqlite
// landed in Node 22; on older Node the dynamic import below fails and every
// exported function here reports unavailability instead of throwing, so the
// server can still boot (routes.mjs turns that into a 501).
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './paths.mjs';
import { SESSION_NAME_RE, hasSession, sendPrompt } from './tmux.mjs';

let DatabaseSyncCtor = null;
let probed = false;

async function probe() {
  if (probed) return;
  probed = true;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  } catch {
    DatabaseSyncCtor = null;
  }
}

export async function isSchedulerAvailable() {
  await probe();
  return !!DatabaseSyncCtor;
}

let dbInstance = null;

// openScheduleDb(): probes node:sqlite (if not already probed) and lazily
// opens/creates <CONFIG_DIR>/schedule.db + the jobs table. Returns the
// DatabaseSync handle, or null if node:sqlite is unavailable.
export async function openScheduleDb() {
  await probe();
  if (!DatabaseSyncCtor) return null;
  if (dbInstance) return dbInstance;

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const dbPath = join(CONFIG_DIR, 'schedule.db');
  dbInstance = new DatabaseSyncCtor(dbPath);
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt TEXT NOT NULL,
      session TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      fired_at INTEGER,
      error TEXT
    )
  `);
  return dbInstance;
}

function getJobById(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
}

// createJob({prompt, session, runAt}): validates prompt (non-empty),
// session (must pass the tmux name regex), and runAt (integer epoch ms —
// past times are allowed; they simply fire on the next tick). Returns
// {ok:true, job} or {ok:false, error}.
export async function createJob({ prompt, session, runAt } = {}) {
  const p = typeof prompt === 'string' ? prompt : String(prompt ?? '');
  if (!p.trim()) return { ok: false, error: 'prompt is required' };

  const s = typeof session === 'string' ? session : String(session ?? '');
  if (!SESSION_NAME_RE.test(s)) return { ok: false, error: 'bad session name' };

  const runAtNum = Number(runAt);
  if (!Number.isInteger(runAtNum)) return { ok: false, error: 'runAt must be an integer epoch-ms timestamp' };

  const db = await openScheduleDb();
  if (!db) return { ok: false, error: 'scheduler requires Node >= 22' };

  const now = Date.now();
  const info = db
    .prepare('INSERT INTO jobs (prompt, session, run_at, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(p, s, runAtNum, 'pending', now);
  return { ok: true, job: getJobById(db, Number(info.lastInsertRowid)) };
}

// listJobs({includeDone=true}): newest first. includeDone=false restricts to
// pending jobs only.
export async function listJobs({ includeDone = true } = {}) {
  const db = await openScheduleDb();
  if (!db) return [];
  const sql = includeDone
    ? 'SELECT * FROM jobs ORDER BY id DESC'
    : "SELECT * FROM jobs WHERE status = 'pending' ORDER BY id DESC";
  return db.prepare(sql).all();
}

// cancelJob(id): only a still-pending job can be cancelled.
export async function cancelJob(id) {
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) return { ok: false, error: 'bad id' };

  const db = await openScheduleDb();
  if (!db) return { ok: false, error: 'scheduler requires Node >= 22' };

  const existing = getJobById(db, idNum);
  if (!existing) return { ok: false, error: 'job not found' };
  if (existing.status !== 'pending') return { ok: false, error: `cannot cancel a job with status '${existing.status}'` };

  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(idNum);
  return { ok: true, job: getJobById(db, idNum) };
}

let ticking = false;

async function tick() {
  if (ticking) return; // guard against overlapping ticks
  ticking = true;
  try {
    const db = await openScheduleDb();
    if (!db) return;

    const now = Date.now();
    const due = db.prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ?").all(now);

    for (const job of due) {
      // sendPrompt() itself does the hasSession() check first and returns
      // {ok:false, error:'tmux session not found'} when it's missing, so a
      // single call covers both the "no such session" and "tmux error" cases.
      const result = await sendPrompt(job.session, job.prompt);
      const firedAt = Date.now();
      if (result.ok) {
        db.prepare("UPDATE jobs SET status = 'sent', fired_at = ? WHERE id = ?").run(firedAt, job.id);
      } else {
        db.prepare("UPDATE jobs SET status = 'failed', fired_at = ?, error = ? WHERE id = ?")
          .run(firedAt, result.error || 'tmux error', job.id);
      }
    }
  } finally {
    ticking = false;
  }
}

// startSchedulerLoop({intervalMs=15000}): starts the polling loop. Must only
// be called from the foreground-serving path in serve.mjs (never for CLI
// commands like add/remove/list/settings/update, and never from a `start`
// invocation that's about to exec a detached child and exit). No-ops (returns
// null) when node:sqlite isn't available. Returns the interval handle
// (unref'd so it never keeps the process alive on its own).
export async function startSchedulerLoop({ intervalMs = 15000 } = {}) {
  const available = await isSchedulerAvailable();
  if (!available) return null;
  await openScheduleDb();

  const handle = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}
