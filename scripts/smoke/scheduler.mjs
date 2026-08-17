// smoke: the prompt scheduler and saved prompts.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs scheduler
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openEventStream } from './sse.mjs';

export async function runScheduler(ctx) {
  const { assert, run, trimLastLine, tempRoot, port } = ctx;

  // --- prompt scheduler (hub-level, not project-scoped) -----------------------
  const schedRes = await fetch(`http://127.0.0.1:${port}/api/schedule`);
  assert(schedRes.status === 200 || schedRes.status === 501, `/api/schedule GET unexpected status ${schedRes.status}`);
  const schedAvailable = schedRes.status === 200;

  if (!schedAvailable) {
    const body = await schedRes.json();
    assert(/node/i.test(body.error || ''), '/api/schedule 501 should explain the Node version requirement');
    console.log('smoke ok (scheduler: node:sqlite unavailable -> 501, skipping CRUD checks)');
  } else {
    const fakeSession = `smoke-fake-${Date.now()}`;
    const nearFuture = Date.now() + 5 * 60 * 1000;

    const createFuture = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'echo smoke', session: fakeSession, runAt: nearFuture })
    }).then((r) => r.json());
    assert(createFuture.ok && createFuture.job && createFuture.job.id, `schedule create (future) failed: ${JSON.stringify(createFuture)}`);
    assert(createFuture.job.status === 'pending', 'newly created schedule job should be pending');
    const futureJobId = createFuture.job.id;

    const listAfterCreate = await fetch(`http://127.0.0.1:${port}/api/schedule`).then((r) => r.json());
    assert(listAfterCreate.jobs.some((j) => j.id === futureJobId && j.status === 'pending'), 'schedule list missing the pending future job');

    const cancelRes = await fetch(`http://127.0.0.1:${port}/api/schedule/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: futureJobId })
    }).then((r) => r.json());
    assert(cancelRes.ok, `schedule cancel failed: ${JSON.stringify(cancelRes)}`);

    const listAfterCancel = await fetch(`http://127.0.0.1:${port}/api/schedule`).then((r) => r.json());
    const cancelledJob = listAfterCancel.jobs.find((j) => j.id === futureJobId);
    assert(cancelledJob && cancelledJob.status === 'cancelled', 'cancelled job did not transition to status "cancelled"');

    // A second cancel on an already-cancelled (non-pending) job must fail.
    const doubleCancel = await fetch(`http://127.0.0.1:${port}/api/schedule/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: futureJobId })
    });
    assert(doubleCancel.status === 400, `cancelling an already-cancelled job should 400, got ${doubleCancel.status}`);

    // Validation: bad session name, empty prompt, non-integer runAt.
    const badSessionCreate = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', session: 'bad name!', runAt: Date.now() })
    });
    assert(badSessionCreate.status === 400, `schedule create with a bad session name should 400, got ${badSessionCreate.status}`);

    const emptyPromptCreate = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '  ', session: fakeSession, runAt: Date.now() })
    });
    assert(emptyPromptCreate.status === 400, `schedule create with an empty prompt should 400, got ${emptyPromptCreate.status}`);

    // A job scheduled for "now" against a session that (deliberately) does
    // not exist must fail on the next scheduler tick, never send anywhere.
    const nonexistentSession = `smoke-nonexistent-${Date.now()}`;
    const createDue = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'this must never be sent', session: nonexistentSession, runAt: Date.now() })
    }).then((r) => r.json());
    assert(createDue.ok && createDue.job && createDue.job.id, `schedule create (due now) failed: ${JSON.stringify(createDue)}`);
    const dueJobId = createDue.job.id;

    let finalJob = null;
    for (let i = 0; i < 30; i++) {
      const list = await fetch(`http://127.0.0.1:${port}/api/schedule`).then((r) => r.json());
      const job = list.jobs.find((j) => j.id === dueJobId);
      if (job && job.status !== 'pending') { finalJob = job; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(finalJob, 'scheduler did not process the due job within the expected window');
    assert(finalJob.status === 'failed', `due job against a nonexistent session should end up "failed", got "${finalJob.status}"`);
    assert(/not found/i.test(finalJob.error || ''), `due job error should mention "not found", got: ${finalJob.error}`);

    console.log(`smoke ok (scheduler CRUD + tick-driven failure): future=${futureJobId}, due=${dueJobId}`);

    // --- requeue a failed job -----------------------------------------------
    // dueJobId is a GENUINELY failed job (its session never existed), which is
    // exactly the state the retry feature exists for. Nothing below creates a
    // tmux session; a requeue re-arms send-keys against a session that may or
    // may not be there, and the response says which.
    const retryPost = (body) => fetch(`http://127.0.0.1:${port}/api/schedule/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const jobById = async (jobId) => (await fetch(`http://127.0.0.1:${port}/api/schedule`).then((r) => r.json())).jobs.find((j) => j.id === jobId);

    const failedBefore = await jobById(dueJobId);
    const retargetSession = `smoke-retarget-${Date.now()}`;
    const retryRes = await retryPost({ id: dueJobId, runAt: Date.now() + 5 * 60 * 1000, session: retargetSession });
    assert(retryRes.status === 200, `retry of a failed job should 200, got ${retryRes.status}`);
    const retryBody = await retryRes.json();
    assert(retryBody.ok && retryBody.job, `retry failed: ${JSON.stringify(retryBody)}`);
    // The SAME row is re-armed — not cloned into a second job.
    assert(retryBody.job.id === dueJobId, 'retry must re-arm the same job row, not create a new one');
    assert(retryBody.job.status === 'pending', `a requeued job must be pending, got ${retryBody.job.status}`);
    assert(retryBody.job.session === retargetSession, 'retry must honour a session retarget');
    assert(retryBody.job.error === null, 'retry must clear the stale error');
    assert(retryBody.job.fired_at === null, 'retry must clear the stale fired_at');
    assert(retryBody.job.retry_count === 1, `retry_count should be 1, got ${retryBody.job.retry_count}`);
    assert(retryBody.job.last_error === failedBefore.error, 'retry must preserve the failure it is retrying in last_error');
    assert(retryBody.sessionLive === false, 'a fabricated session name must report sessionLive:false, never be created');
    const jobCount = (await fetch(`http://127.0.0.1:${port}/api/schedule`).then((r) => r.json())).jobs.filter((j) => j.id === dueJobId).length;
    assert(jobCount === 1, 'requeue must not leave a duplicate row behind');

    // runAt is REQUIRED: the old run_at is in the past, so silently reusing it
    // would fire the prompt on the very next tick.
    assert((await retryPost({ id: dueJobId })).status === 400, 'retry without runAt must 400 rather than reuse the stale time');
    assert((await retryPost({ id: dueJobId, runAt: 'soon' })).status === 400, 'retry with a non-integer runAt must 400');
    assert((await retryPost({ id: dueJobId, runAt: Date.now(), session: 'bad name!' })).status === 400, 'retry with a bad session name must 400');
    assert((await retryPost({ id: 999999, runAt: Date.now() })).status === 400, 'retry of an unknown job must 400');
    // Already pending: nothing to retry.
    assert((await retryPost({ id: dueJobId, runAt: Date.now() })).status === 400, 'retry of a pending job must 400');

    // Cancelled IS retryable (the user is undoing their own withdrawal), and
    // a requeue that fires against a still-missing session must fail again
    // cleanly rather than resurrect anything.
    await fetch(`http://127.0.0.1:${port}/api/schedule/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: dueJobId }),
    });
    const retryCancelled = await retryPost({ id: dueJobId, runAt: Date.now() }).then((r) => r.json());
    assert(retryCancelled.ok, `retry of a cancelled job should be allowed: ${JSON.stringify(retryCancelled)}`);
    assert(retryCancelled.job.retry_count === 2, `retry_count should accumulate, got ${retryCancelled.job.retry_count}`);

    let refailed = null;
    for (let i = 0; i < 30; i++) {
      const job = await jobById(dueJobId);
      if (job && job.status !== 'pending') { refailed = job; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(refailed, 'the requeued job was never processed by the scheduler');
    assert(refailed.status === 'failed', `a requeue aimed at a missing session must fail again, got "${refailed.status}"`);
    assert(/not found/i.test(refailed.error || ''), `re-failure should still name the missing session; got: ${refailed.error}`);

    console.log(`smoke ok (schedule retry: same row re-armed, retarget, explicit runAt required, refires cleanly): job=${dueJobId}`);

    // --- schedule.db migration onto a PRE-EXISTING database ------------------
    // retry_count/last_error were added after the jobs table shipped, so every
    // existing install has a schedule.db without them. The tests above only
    // ever exercise a database this run created, which would pass forever even
    // if the ALTERs were wrong. This one builds the ORIGINAL schema, drops a
    // failed job in it, and then opens it through the real openScheduleDb():
    // if the migration breaks, an upgrading user's scheduler view breaks with
    // it, and that has to fail here rather than on their machine.
    //
    // It runs in a child process on its own BD_CONSOLE_CONFIG_DIR because
    // CONFIG_DIR is resolved at module load — importing lib/schedule.mjs into
    // this process would open the developer's REAL ~/.config/bd-console.
    const migrateDir = join(tempRoot, 'sched-migrate');
    const migrateScript = join(tempRoot, 'sched-migrate.mjs');
    writeFileSync(migrateScript, `
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = process.env.BD_CONSOLE_CONFIG_DIR;
mkdirSync(dir, { recursive: true });

// The jobs table EXACTLY as it shipped before retry_count/last_error existed.
const seed = new DatabaseSync(join(dir, 'schedule.db'));
seed.exec(\`
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL,
    session TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    fired_at INTEGER,
    error TEXT
  )
\`);
seed.prepare('INSERT INTO jobs (prompt, session, run_at, status, created_at, fired_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('legacy prompt', 'legacy-session', 1000, 'failed', 900, 1001, 'tmux session not found');
seed.close();

const { listJobs, retryJob } = await import(process.argv[2]);
const before = (await listJobs())[0];
const retried = await retryJob(before.id, { runAt: Date.now() + 60 * 60 * 1000 });
console.log(JSON.stringify({ before, retried }));
`);
    const migrateOut = JSON.parse(trimLastLine(run(process.execPath, [migrateScript, resolve(join(process.cwd(), 'lib', 'schedule.mjs'))], {
      env: { ...process.env, BD_CONSOLE_CONFIG_DIR: migrateDir },
    })));
    // The pre-existing row survives untouched, and the new columns arrive with
    // usable defaults rather than as missing keys.
    assert(migrateOut.before.prompt === 'legacy prompt', 'migration must preserve pre-existing job rows');
    assert(migrateOut.before.error === 'tmux session not found', 'migration must preserve the stored error');
    assert(migrateOut.before.retry_count === 0, `retry_count should default to 0 on a migrated row, got ${migrateOut.before.retry_count}`);
    assert(migrateOut.before.last_error === null, `last_error should default to NULL on a migrated row, got ${JSON.stringify(migrateOut.before.last_error)}`);
    // And a job that predates the feature is immediately retryable.
    assert(migrateOut.retried.ok, `retrying a pre-migration job failed: ${JSON.stringify(migrateOut.retried)}`);
    assert(migrateOut.retried.job.retry_count === 1, 'retry_count must increment on a migrated row');
    assert(migrateOut.retried.job.last_error === 'tmux session not found', 'retry must move the migrated row\'s error into last_error');
    assert(migrateOut.retried.job.status === 'pending' && migrateOut.retried.job.error === null, 'a retried migrated row must be pending with a cleared error');

    console.log('smoke ok (schedule.db migration: additive ALTERs on a pre-existing db, legacy job retryable)');

    // --- the change feed fires for schedule writes (bd-console-974.3) -------
    // Scheduler jobs are hub-level, so their events carry NO project — a client
    // that keyed off `project` would silently ignore them. Create then cancel,
    // because the two land inside the same 2s debounce window: the second event
    // proves the coalescing is trailing-edge (the last change in a burst is
    // still announced) rather than "drop everything after the first".
    const stream = await openEventStream(`http://127.0.0.1:${port}/api/events`);
    try {
      assert(await stream.waitFor((f) => f.event === 'hello', { timeoutMs: 3000 }), 'no hello frame');
      const mark = stream.frames.length;

      const created = await fetch(`http://127.0.0.1:${port}/api/schedule`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'feed probe', session: `smoke-feed-${Date.now()}`, runAt: Date.now() + 5 * 60 * 1000 }),
      }).then((r) => r.json());
      assert(created.ok, `schedule create failed: ${JSON.stringify(created)}`);

      const onCreate = await stream.waitFor((f) => f.event === 'change', { timeoutMs: 4000, from: mark });
      assert(onCreate, `creating a job must announce a schedule change; raw stream was ${JSON.stringify(stream.raw)}`);
      assert(onCreate.frame.data.kind === 'schedule', `expected kind "schedule", got ${JSON.stringify(onCreate.frame.raw_data)}`);
      assert(Object.keys(onCreate.frame.data).sort().join(',') === 'kind,ts',
        `a schedule change frame carries exactly kind/ts (no project), got ${JSON.stringify(onCreate.frame.raw_data)}`);

      const cancelled = await fetch(`http://127.0.0.1:${port}/api/schedule/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: created.job.id }),
      }).then((r) => r.json());
      assert(cancelled.ok, `schedule cancel failed: ${JSON.stringify(cancelled)}`);
      const onCancel = await stream.waitFor((f) => f.event === 'change' && f.data && f.data.kind === 'schedule',
        { timeoutMs: 4000, from: onCreate.index + 1 });
      assert(onCancel, `a cancel inside the debounce window must still be announced (trailing edge); raw stream was ${JSON.stringify(stream.raw)}`);

      console.log(`smoke ok (change feed: schedule create + cancel both announced, no project field): job=${created.job.id}`);
    } finally {
      stream.close();
    }
  }

  // --- saved prompts API ---------------------------------------------------------
  const promptsGet0 = await fetch(`http://127.0.0.1:${port}/api/prompts`);
  assert(promptsGet0.status === 200 || promptsGet0.status === 501, `/api/prompts GET unexpected status ${promptsGet0.status}`);
  const promptsAvailable = promptsGet0.status === 200;
  assert(promptsAvailable === schedAvailable, 'prompts availability should match scheduler (node:sqlite) availability');

  if (!promptsAvailable) {
    const body = await promptsGet0.json();
    assert(/node/i.test(body.error || ''), '/api/prompts 501 should explain the Node version requirement');
    console.log('smoke ok (prompts: node:sqlite unavailable -> 501, skipping CRUD checks)');
  } else {
    const createP1 = await fetch(`http://127.0.0.1:${port}/api/prompts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Prompt 1', prompt: 'do the first thing' })
    }).then((r) => r.json());
    assert(createP1.ok && createP1.id, `create prompt 1 failed: ${JSON.stringify(createP1)}`);

    const createP2 = await fetch(`http://127.0.0.1:${port}/api/prompts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Prompt 2', prompt: 'do the second thing' })
    }).then((r) => r.json());
    assert(createP2.ok && createP2.id, `create prompt 2 failed: ${JSON.stringify(createP2)}`);

    const listP0 = await fetch(`http://127.0.0.1:${port}/api/prompts`).then((r) => r.json());
    const p1 = listP0.prompts.find((x) => x.id === createP1.id);
    const p2 = listP0.prompts.find((x) => x.id === createP2.id);
    assert(p1 && p1.name === 'Smoke Prompt 1' && p1.prompt === 'do the first thing' && p1.last_used_at == null, 'prompt 1 shape mismatch');
    assert(p2 && p2.last_used_at == null, 'prompt 2 shape mismatch');
    // Both unused so far: most-recently-created (p2) should sort first.
    assert(
      listP0.prompts.findIndex((x) => x.id === createP2.id) < listP0.prompts.findIndex((x) => x.id === createP1.id),
      'prompts list should order newest-created first when unused'
    );

    const useP1 = await fetch(`http://127.0.0.1:${port}/api/prompts/used`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: createP1.id })
    }).then((r) => r.json());
    assert(useP1.ok, `prompt used-stamping failed: ${JSON.stringify(useP1)}`);

    const listP1 = await fetch(`http://127.0.0.1:${port}/api/prompts`).then((r) => r.json());
    const p1After = listP1.prompts.find((x) => x.id === createP1.id);
    assert(typeof p1After.last_used_at === 'number', 'prompt last_used_at was not stamped');
    assert(
      listP1.prompts.findIndex((x) => x.id === createP1.id) < listP1.prompts.findIndex((x) => x.id === createP2.id),
      'a just-used prompt should sort before an unused, older-created one'
    );

    const badCreate = await fetch(`http://127.0.0.1:${port}/api/prompts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  ', prompt: 'x' })
    });
    assert(badCreate.status === 400, `prompt create with an empty name should 400, got ${badCreate.status}`);

    const deleteP2 = await fetch(`http://127.0.0.1:${port}/api/prompts/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: createP2.id })
    }).then((r) => r.json());
    assert(deleteP2.ok, `prompt delete failed: ${JSON.stringify(deleteP2)}`);

    const listP2 = await fetch(`http://127.0.0.1:${port}/api/prompts`).then((r) => r.json());
    assert(!listP2.prompts.some((x) => x.id === createP2.id), 'deleted prompt still present in list');

    console.log(`smoke ok (prompts CRUD + used-stamping + delete): ${createP1.id}, ${createP2.id}`);
  }
}
