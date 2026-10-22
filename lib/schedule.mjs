// lib/schedule.mjs — prompt scheduler: queue prompts to be typed into an
// EXISTING tmux session at a scheduled time. Never creates tmux sessions,
// never runs `claude -p`; it only re-uses lib/tmux.mjs's literal send-keys
// injection against a session the caller named.
//
// Storage: node:sqlite (DatabaseSync) at <CONFIG_DIR>/schedule.db. node:sqlite
// landed in Node 22; on older Node the dynamic import below fails and every
// exported function here reports unavailability instead of throwing, so the
// server can still boot (routes.mjs turns that into a 501).
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './paths.mjs';
import { SESSION_NAME_RE, hasSession, sendPrompt } from './tmux.mjs';
import { emit as emitChange } from './events.mjs';

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

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  if (lstatSync(CONFIG_DIR).isSymbolicLink()) throw new Error('refusing symlinked scheduler config directory');
  try { chmodSync(CONFIG_DIR, 0o700); } catch {}
  const dbPath = join(CONFIG_DIR, 'schedule.db');
  const privateDbPaths = [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`];
  for (const path of privateDbPaths) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing symlinked scheduler state file ${path}`);
      chmodSync(path, 0o600);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
  dbInstance = new DatabaseSyncCtor(dbPath);
  // Scheduler prompts are sensitive (they may contain credentials or private
  // instructions). Tighten both the existing directory and the newly-created
  // database regardless of the process umask.
  try { chmodSync(dbPath, 0o600); } catch {}
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
  for (const path of privateDbPaths) {
    try { chmodSync(path, 0o600); } catch { /* sidecar may not exist yet */ }
  }
  // Requeue bookkeeping, added after the table shipped — schedule.db files
  // already exist on users' disks, so these are additive ALTERs guarded by
  // PRAGMA table_info (SQLite has no ADD COLUMN IF NOT EXISTS) rather than a
  // change to the CREATE above, which only runs on a fresh database.
  //   retry_count — how many times this row has been re-armed, so a job that
  //     keeps failing reads as a pattern instead of a fresh surprise.
  //   last_error  — the failure being retried, preserved when `error` is
  //     cleared on requeue. Without it a re-armed job shows as a plain pending
  //     job with no trace of why it is here for a second time.
  const jobCols = new Set(dbInstance.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  if (!jobCols.has('retry_count')) dbInstance.exec('ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
  if (!jobCols.has('last_error')) dbInstance.exec('ALTER TABLE jobs ADD COLUMN last_error TEXT');
  // Delivery attempts survive retries. Legacy rows retain only the last known
  // result; never invent a start time or earlier retry history.
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS job_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      session TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      legacy INTEGER NOT NULL DEFAULT 0,
      UNIQUE(job_id, attempt)
    );
    INSERT OR IGNORE INTO job_attempts
      (job_id, attempt, session, scheduled_at, finished_at, status, error, legacy)
      SELECT id, COALESCE(retry_count, 0) + 1, session, run_at, fired_at, status, error, 1
      FROM jobs WHERE fired_at IS NOT NULL AND status IN ('sent', 'failed')
        AND NOT EXISTS (SELECT 1 FROM job_attempts WHERE job_attempts.job_id = jobs.id);
  `);
  // Saved prompts — reusable prompt text the UI can pick from when scheduling
  // or sending to tmux. Same schedule.db, same node:sqlite availability gate.
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )
  `);
  return dbInstance;
}

function getJobById(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
}

function parseRunAt(value) {
  // JSON null/false/[] and blank strings otherwise coerce to zero and send
  // on the next tick. Accept numbers and nonblank numeric strings only, and
  // require a timestamp the browser can render as a valid Date.
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && Number.isFinite(new Date(timestamp).getTime())
    ? timestamp : null;
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

  const runAtNum = parseRunAt(runAt);
  if (runAtNum === null) return { ok: false, error: 'runAt must be a valid integer epoch-ms timestamp' };

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

export async function listJobAttempts(id) {
  const idNum = Number(id);
  if (!Number.isSafeInteger(idNum) || idNum < 1) return { ok: false, status: 400, error: 'bad id' };
  const db = await openScheduleDb();
  if (!db) return { ok: false, status: 501, error: 'scheduler requires Node >= 22' };
  if (!getJobById(db, idNum)) return { ok: false, status: 404, error: 'job not found' };
  return { ok: true, attempts: db.prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt DESC').all(idNum) };
}

// Keep the job result and its receipt atomic, including crash recovery.
function finishAttempt(db, id, status, error, finishedAt) {
  db.prepare("UPDATE jobs SET status = ?, fired_at = ?, error = ? WHERE id = ? AND status = 'firing'").run(status, finishedAt, error, id);
  db.prepare("UPDATE job_attempts SET status = ?, finished_at = ?, error = ? WHERE job_id = ? AND status = 'firing'").run(status, finishedAt, error, id);
}
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
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

  // The status can change after the read above (the poller may claim the row,
  // or another cancel request may win). Report that lost race instead of
  // returning a false success that makes the UI believe a prompt was stopped.
  const changed = db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(idNum);
  if (changed.changes !== 1) {
    const latest = getJobById(db, idNum);
    return { ok: false, error: latest
      ? `cannot cancel a job with status '${latest.status}'`
      : 'job not found' };
  }
  return { ok: true, job: getJobById(db, idNum) };
}

// Statuses a job can be re-armed FROM.
//
// `sent` is deliberately excluded. A sent prompt was already typed into a live
// interactive agent; re-sending it is how you get duplicated work in a session
// someone is watching, and this codebase has already been bitten once by a
// stray prompt (see SessionCombobox's note in ScheduleView.js on why nothing
// here targets a session by default). "Send that again" is a NEW job, made
// deliberately, not a button next to a green success row.
//
// `cancelled` IS retryable: the user withdrew it themselves, so putting it
// back is undoing their own action, not overriding a safety outcome.
const RETRYABLE = new Set(['failed', 'cancelled']);

// retryJob(id, {runAt, session}): re-arms an existing job row.
//
// Two design calls, both deliberate:
//
// 1. It re-arms the SAME ROW rather than cloning into a new pending job. A
//    clone leaves the failed original sitting in the list looking equally
//    retryable, and the list is the user's only view of "what is queued" —
//    doubling every retry turns it into noise. job_attempts keeps delivery
//    history; retry_count and last_error summarize the current row.
//
// 2. runAt is REQUIRED, and the job's old run_at is never silently reused. A
//    failed job's run_at is in the past by definition, so re-arming it as-is
//    would fire on the very next tick — a prompt landing in a live session
//    seconds after a click the user read as "queue it again". The caller must
//    say when, every time; "now" is a legitimate answer, but it has to be one
//    the user actually gave.
//
// `session` optionally RETARGETS the job. The overwhelmingly common failure is
// "the tmux session was gone by the time it fired", and the fix for that is to
// point the prompt at a session that exists — not to hope the old name comes
// back. Nothing here ever creates a session: `sessionLive` just reports whether
// the target exists right now so the caller can warn, exactly as the create
// form warns about a vanished session. A job aimed at a session that isn't
// running is still allowed (it may well be back before run_at) — it simply
// fails again on the tick, the same way it did the first time.
export async function retryJob(id, { runAt, session } = {}) {
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) return { ok: false, error: 'bad id' };

  const runAtNum = parseRunAt(runAt);
  if (runAtNum === null) return { ok: false, error: 'runAt must be a valid integer epoch-ms timestamp' };

  const db = await openScheduleDb();
  if (!db) return { ok: false, error: 'scheduler requires Node >= 22' };

  const existing = getJobById(db, idNum);
  if (!existing) return { ok: false, error: 'job not found' };
  if (!RETRYABLE.has(existing.status)) {
    return existing.status === 'sent'
      ? { ok: false, error: 'that prompt was already delivered — schedule a new one rather than sending it twice' }
      : { ok: false, error: `cannot retry a job with status '${existing.status}'` };
  }

  let target = existing.session;
  if (session != null && String(session) !== '') {
    const s = String(session);
    if (!SESSION_NAME_RE.test(s)) return { ok: false, error: 'bad session name' };
    target = s;
  }

  const rearmed = db.prepare(
    "UPDATE jobs SET status = 'pending', run_at = ?, session = ?, fired_at = NULL, error = NULL, "
    + 'last_error = ?, retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ? AND status = ? AND retry_count = ?',
  ).run(runAtNum, target, existing.error ?? existing.last_error ?? null, idNum, existing.status, existing.retry_count);
  if (rearmed.changes !== 1) return { ok: false, error: 'job changed while requeueing; reload before retrying' };

  return { ok: true, job: getJobById(db, idNum), sessionLive: await hasSession(target) };
}

let ticking = false;

// How long a row may sit in 'firing' before a later tick declares the sender
// dead. Generous by design: 'firing' means "send-keys is in flight", which is
// milliseconds of work, so anything at this age is a process that died between
// the claim and the outcome — never a slow send being stolen out from under
// itself.
const STALE_FIRING_MS = 5 * 60 * 1000;

// Reap rows stranded mid-send. Without this, a crash (or a kill -9) between the
// claim below and the sent/failed write leaves the row 'firing' forever: not
// pending, so nothing retries it, and not failed, so the UI offers no requeue.
// Reaped to 'failed' — the state that IS retryable, with the reason recorded.
function reapStaleFiring(db, olderThanMs = STALE_FIRING_MS) {
  return transaction(db, () => {
    const now = Date.now();
    const stale = db.prepare("SELECT id FROM jobs WHERE status = 'firing' AND COALESCE(fired_at, 0) < ?").all(now - olderThanMs);
    for (const job of stale) finishAttempt(db, job.id, 'failed', 'bd-console stopped while this prompt was being sent — it may or may not have been delivered', now);
    return stale.length;
  });
}

// The atomic claim: 'pending' -> 'firing' for ONE row, conditional on the row
// still being pending. The process-local `ticking` flag only ever serialized
// ticks WITHIN one process; two bd-console processes sharing a schedule.db (a
// leftover daemon plus a foreground run, a systemd unit plus a manual start)
// both SELECTed the same due row and both typed the prompt into the live tmux
// session. SQLite settles it instead: exactly one UPDATE reports changes === 1,
// and only that caller is allowed to send.
function claimForFiring(db, id, now = Date.now()) {
  return transaction(db, () => {
    const info = db.prepare("UPDATE jobs SET status = 'firing', fired_at = ? WHERE id = ? AND status = 'pending'").run(now, id);
    if (info.changes !== 1) return false;
    const job = getJobById(db, id);
    const number = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM job_attempts WHERE job_id = ?').get(id).n;
    db.prepare(`INSERT INTO job_attempts (job_id, attempt, session, scheduled_at, started_at, status)
      VALUES (?, ?, ?, ?, ?, 'firing')`).run(id, number, job.session, job.run_at, now);
    return true;
  });
}

// Exported so the smoke suite can prove the claim is exclusive (two attempts on
// one row, one winner) without racing two real tick loops against a live tmux.
// Not routed: nothing over HTTP claims a job.
export async function claimJobForFiring(id) {
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) return { ok: false, error: 'bad id' };
  const db = await openScheduleDb();
  if (!db) return { ok: false, error: 'scheduler requires Node >= 22' };
  if (!claimForFiring(db, idNum)) {
    const existing = getJobById(db, idNum);
    return { ok: false, error: existing ? `job is not pending (status '${existing.status}')` : 'job not found' };
  }
  return { ok: true, job: getJobById(db, idNum) };
}

// Exported for the same reason: a test needs to reach the reaper without
// waiting out STALE_FIRING_MS.
export async function reapStaleFiringJobs({ olderThanMs = STALE_FIRING_MS } = {}) {
  const db = await openScheduleDb();
  if (!db) return { ok: false, error: 'scheduler requires Node >= 22' };
  return { ok: true, reaped: reapStaleFiring(db, olderThanMs) };
}

async function tick() {
  if (ticking) return; // guard against overlapping ticks IN THIS process
  ticking = true;
  try {
    const db = await openScheduleDb();
    if (!db) return;

    const reaped = reapStaleFiring(db);

    const now = Date.now();
    const due = db.prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ?").all(now);
    // Whether this tick moved anything. A tick with nothing due must stay
    // completely silent — the change feed exists so nobody polls, and a
    // heartbeat-shaped event every interval would just be polling inverted.
    let changed = reaped > 0;

    for (const job of due) {
      // Claimed before anything is sent: a row this process loses (cancelled
      // between the SELECT and here, or taken by another process) is skipped
      // entirely rather than double-delivered.
      if (!claimForFiring(db, job.id)) continue;

      // sendPrompt() itself does the hasSession() check first and returns
      // {ok:false, error:'tmux session not found'} when it's missing, so a
      // single call covers both the "no such session" and "tmux error" cases.
      // It also refuses a target it can PROVE is in server mode (`claude rc`,
      // a `kimi web` server, …) — deliberately not forced here: a job whose
      // target can't be prompted should land in the failed list with that
      // reason (retryable/retargetable from the UI) rather than report "sent"
      // for text nothing ever read.
      let result;
      try { result = await sendPrompt(job.session, job.prompt); }
      catch (error) { result = { ok: false, error: error.message || 'Unexpected terminal delivery error' }; }
      transaction(db, () => finishAttempt(db, job.id, result.ok ? 'sent' : 'failed', result.ok ? null : result.error || 'tmux error', Date.now()));
      changed = true;
    }
    // One event per tick, not one per job: a client's response to any of them is
    // the same single re-GET of /api/schedule.
    if (changed) emitChange('schedule');
  } finally {
    ticking = false;
  }
}

// --- saved prompts -----------------------------------------------------
// Reusable prompt text, stored alongside scheduler jobs in the same
// schedule.db. Prepared statements only; same node:sqlite availability gate
// as the job functions above (callers get {ok:false, error} rather than a
// thrown exception when node:sqlite is unavailable).

function getPromptById(db, id) {
  return db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) || null;
}

// createPrompt({name, prompt}): both must be non-empty. Returns
// {ok:true, id} or {ok:false, error}.
export async function createPrompt({ name, prompt } = {}) {
  const n = typeof name === 'string' ? name.trim() : String(name ?? '').trim();
  if (!n) return { ok: false, error: 'name is required' };

  const p = typeof prompt === 'string' ? prompt : String(prompt ?? '');
  if (!p.trim()) return { ok: false, error: 'prompt is required' };

  const db = await openScheduleDb();
  if (!db) return { ok: false, error: 'scheduler requires Node >= 22' };

  const now = Date.now();
  const info = db
    .prepare('INSERT INTO prompts (name, prompt, created_at, last_used_at) VALUES (?, ?, ?, NULL)')
    .run(n, p, now);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

// listPrompts(): most recently used (or, absent that, most recently
// created) first.
export async function listPrompts() {
  const db = await openScheduleDb();
  if (!db) return [];
  return db.prepare('SELECT * FROM prompts ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC').all();
}

// deletePrompt(id): returns {ok:true} or {ok:false, error}.
export async function deletePrompt(id) {
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) return { ok: false, error: 'bad id' };

  const db = await openScheduleDb();
  if (!db) return { ok: false, error: 'scheduler requires Node >= 22' };

  const existing = getPromptById(db, idNum);
  if (!existing) return { ok: false, error: 'prompt not found' };

  db.prepare('DELETE FROM prompts WHERE id = ?').run(idNum);
  return { ok: true };
}

// markPromptUsed(id): stamps last_used_at = now. Returns {ok:true} or
// {ok:false, error}.
export async function markPromptUsed(id) {
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) return { ok: false, error: 'bad id' };

  const db = await openScheduleDb();
  if (!db) return { ok: false, error: 'scheduler requires Node >= 22' };

  const existing = getPromptById(db, idNum);
  if (!existing) return { ok: false, error: 'prompt not found' };

  db.prepare('UPDATE prompts SET last_used_at = ? WHERE id = ?').run(Date.now(), idNum);
  return { ok: true };
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

// stopScheduler(handle): stops the polling loop and closes the sqlite handle.
// Called from serve.mjs's SIGTERM/SIGINT path — an interrupted process that
// never closes the database leaves schedule.db's WAL/journal sidecar files
// behind for the next start to recover. Idempotent, and safe to call when the
// scheduler never opened (node:sqlite unavailable).
export function stopScheduler(handle = null) {
  if (handle) clearInterval(handle);
  if (!dbInstance) return false;
  try { dbInstance.close(); } catch { /* already closed, or closed under us */ }
  dbInstance = null;
  return true;
}
