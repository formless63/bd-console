// smoke: the prompt scheduler and saved prompts.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs scheduler
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

import { mkdirSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join, resolve } from 'node:path';

// Statuses that mean "the scheduler has not finished with this row yet":
// 'pending' (not claimed) and 'firing' (claimed, send in flight).
const PENDING_OR_FIRING = new Set(['pending', 'firing']);

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
      // 'firing' is the transient claimed-but-not-yet-reported state (see the
      // claim test below) — an outcome, not a status to settle on.
      if (job && !PENDING_OR_FIRING.has(job.status)) { finalJob = job; break; }
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
      if (job && !PENDING_OR_FIRING.has(job.status)) { refailed = job; break; }
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

    // --- the claim is EXCLUSIVE (bd-console-974.1) ---------------------------
    // The tick loop was SELECT-then-send-then-UPDATE behind a process-local
    // `ticking` flag, which serializes nothing across processes: two
    // bd-consoles on one schedule.db (a leftover daemon plus a foreground run)
    // both saw the same due row and both typed the prompt into the live tmux
    // session someone was watching. Two claims on one row must now produce one
    // winner — asserted directly rather than by racing two tick loops, so the
    // test can't pass by luck.
    //
    // Its own child process on its own BD_CONSOLE_CONFIG_DIR for the same
    // reason as the migration test above: CONFIG_DIR is resolved at module
    // load, so importing lib/schedule.mjs here would open the developer's real
    // ~/.config/bd-console.
    const claimDir = join(tempRoot, 'sched-claim');
    const claimScript = join(tempRoot, 'sched-claim.mjs');
    writeFileSync(claimScript, `
import { mkdirSync } from 'node:fs';
mkdirSync(process.env.BD_CONSOLE_CONFIG_DIR, { recursive: true });

const sched = await import(process.argv[2]);
const created = await sched.createJob({ prompt: 'claimed exactly once', session: 'claim-smoke', runAt: Date.now() + 60 * 60 * 1000 });
const first = await sched.claimJobForFiring(created.job.id);
const second = await sched.claimJobForFiring(created.job.id);
const claimed = (await sched.listJobs()).find((j) => j.id === created.job.id);

// A row that is being sent RIGHT NOW must survive the reaper's real window...
const reapedFresh = await sched.reapStaleFiringJobs();
// ...while one whose sender died is put back as 'failed' (the retryable state).
await new Promise((r) => setTimeout(r, 10));
const reapedStale = await sched.reapStaleFiringJobs({ olderThanMs: 5 });
const after = (await sched.listJobs()).find((j) => j.id === created.job.id);

console.log(JSON.stringify({ created, first, second, claimed, reapedFresh, reapedStale, after }));
`);
    const claimOut = JSON.parse(trimLastLine(run(process.execPath, [claimScript, resolve(join(process.cwd(), 'lib', 'schedule.mjs'))], {
      env: { ...process.env, BD_CONSOLE_CONFIG_DIR: claimDir },
    })));
    assert(claimOut.created.ok, `claim fixture job creation failed: ${JSON.stringify(claimOut.created)}`);
    assert(claimOut.first.ok === true, `the first claim must win: ${JSON.stringify(claimOut.first)}`);
    assert(claimOut.second.ok === false, `the second claim on the same row must LOSE — this is the double-send bug: ${JSON.stringify(claimOut.second)}`);
    assert(/not pending/.test(claimOut.second.error || ''), `a lost claim should say why, got: ${claimOut.second.error}`);
    assert(claimOut.claimed.status === 'firing', `a claimed row should be 'firing' while the send is in flight, got '${claimOut.claimed.status}'`);
    assert(typeof claimOut.claimed.fired_at === 'number', 'the claim must stamp fired_at, which is what the reaper ages');
    assert(claimOut.reapedFresh.reaped === 0, `the reaper must not touch a send that is still in flight: ${JSON.stringify(claimOut.reapedFresh)}`);
    assert(claimOut.reapedStale.reaped === 1, `a stranded 'firing' row must be reaped: ${JSON.stringify(claimOut.reapedStale)}`);
    assert(claimOut.after.status === 'failed', `a reaped row must land in 'failed' (the retryable state), got '${claimOut.after.status}'`);
    assert(/being sent/.test(claimOut.after.error || ''), `a reaped row must record why it is failed, got: ${claimOut.after.error}`);

    console.log('smoke ok (schedule claim: exclusive pending->firing, stranded firing rows reaped to failed)');
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

    // --- a multi-byte body split across chunk boundaries --------------------
    // readBody() used to decode each socket chunk on its own (`data += c`), so
    // a UTF-8 sequence straddling a boundary became U+FFFD on both sides — the
    // boundary is wherever the socket happened to fill, not where a character
    // ends. Saved prompts are the cheapest round-trip that stores request text
    // verbatim and hands it straight back.
    //
    // fetch() gives no control over chunk boundaries, so this writes the
    // request over a raw socket and deliberately splits it two bytes into an
    // emoji, with a body big enough (>64KB) to span several socket reads on
    // its own.
    const chunkMarker = '😀';
    const chunkPrompt = `${'x'.repeat(70000)}${chunkMarker}tail`;
    const chunkBody = Buffer.from(JSON.stringify({ name: 'chunk-boundary', prompt: chunkPrompt }), 'utf8');
    const splitAt = chunkBody.indexOf(Buffer.from(chunkMarker, 'utf8')) + 2;
    assert(splitAt > 2, 'fixture error: the emoji should be findable in the encoded body');

    const chunkStatus = await new Promise((resolveP, reject) => {
      const socket = netConnect(port, '127.0.0.1', () => {
        socket.write(
          `POST /api/prompts HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
          + `Content-Type: application/json\r\nContent-Length: ${chunkBody.length}\r\n`
          + 'Connection: close\r\n\r\n'
        );
        socket.write(chunkBody.subarray(0, splitAt));
        // Second write a tick later so it is a separate segment (and so the
        // server has already consumed the first half): the boundary lands
        // inside the emoji rather than wherever the kernel felt like.
        setTimeout(() => socket.end(chunkBody.subarray(splitAt)), 25);
      });
      let raw = '';
      socket.setEncoding('utf8');
      socket.on('data', (c) => { raw += c; });
      socket.on('error', reject);
      socket.on('end', () => resolveP(Number(raw.split(' ')[1] || 0)));
    });
    assert(chunkStatus === 200, `a chunk-split body should still be accepted, got HTTP ${chunkStatus}`);

    const chunkStored = (await fetch(`http://127.0.0.1:${port}/api/prompts`).then((r) => r.json()))
      .prompts.find((x) => x.name === 'chunk-boundary');
    assert(chunkStored, 'the chunk-split prompt was not stored at all');
    assert(!chunkStored.prompt.includes('�'), 'the body was decoded per-chunk: a multi-byte character came back as U+FFFD');
    assert(chunkStored.prompt === chunkPrompt, `the stored prompt must be byte-identical to what was sent (length ${chunkStored.prompt.length} vs ${chunkPrompt.length})`);

    console.log('smoke ok (readBody: a 70KB body with a multi-byte character split across chunks round-trips intact)');

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
