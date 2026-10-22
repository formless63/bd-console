import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectWork, collectWork, searchWork, activitySince, workSnapshot, issueLink } from '../../public/ui/work.js';
import { parseRoute } from '../../public/ui/routing.js';
import { contentOf, reviewDraft, reviewOf } from '../../public/ui/issueContent.js';

export async function runWorkflows(ctx) {
  const { assert, p, run, repoDir } = ctx;
  const post = (path, body) => fetch(p(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const created = await (await post('/quick', { title: 'Workflow editor fixture' })).json();
  const read = async () => (await fetch(p('/issues')).then(r => r.json())).issues.find(i => i.id === created.id);
  let issue = await read();
  const original = contentOf(issue);
  const fields = { title: 'Edited fixture', description: 'Literal $(echo do-not-run) and `code`\nSecond line', design: 'Design', notes: 'Notes', acceptance_criteria: 'Checks pass' };
  const edited = await post('/edit', { id: issue.id, op: 'set-content', fields, expected: original });
  assert(edited.status === 200, `content edit failed: ${await edited.text()}`);
  issue = await read();
  assert(JSON.stringify(contentOf(issue)) === JSON.stringify(fields), 'all narrative fields must round-trip');
  const stale = await post('/edit', { id: issue.id, op: 'set-content', fields: { title: 'stale title' }, expected: original });
  assert(stale.status === 409, 'stale content must conflict, not overwrite');
  for (const fields of [{ title: ' ' }, { status: 'closed' }, { notes: 3 }, { title: 'x'.repeat(501) }, { notes: '界'.repeat(40000) }]) {
    assert((await post('/edit', { id: issue.id, op: 'set-content', fields, expected: contentOf(issue) })).status === 400, 'invalid content must be rejected');
  }
  const cleared = await post('/edit', { id: issue.id, op: 'set-content', fields: { notes: '', description: '' }, expected: contentOf(issue) });
  assert(cleared.status === 200, 'empty narrative fields must clear');
  issue = await read();
  assert(!issue.notes && !issue.description, 'narrative clearing must persist');
  run('bd', ['update', issue.id, '--set-metadata', 'unrelated=keep'], { cwd: repoDir });
  const review = { ...reviewDraft(issue), branch: 'feature/example', commit: 'abc1234', url: 'https://example.test/pr/12', tests: 'Fixture checks passed', reviewer: 'reviewer', decision: 'approved' };
  const reviewed = await post('/edit', { id: issue.id, op: 'set-review', fields: review, expected: reviewDraft(issue) });
  assert(reviewed.status === 200, `review edit failed: ${await reviewed.text()}`);
  const after = await read();
  assert(reviewOf(after)?.decision === 'approved' && reviewOf(after)?.tests === review.tests, `structured review must persist: ${JSON.stringify(after.metadata)}`);
  const metadata = typeof after.metadata === 'string' ? JSON.parse(after.metadata) : after.metadata;
  assert(metadata.unrelated === 'keep', 'review writes must preserve unrelated metadata');
  assert((await post('/edit', { id: issue.id, op: 'set-review', fields: { ...review, tests: 'x'.repeat(50000), summary: 'x'.repeat(50000) }, expected: reviewDraft(after) })).status === 400, 'oversized combined evidence must fail before reaching execFile');
  assert((await post('/edit', { id: issue.id, op: 'set-review', fields: { ...review, url: 'javascript:alert(1)' }, expected: reviewDraft(after) })).status === 400, 'unsafe evidence URL must be rejected');
  assert((await post('/edit', { id: issue.id, op: 'set-review', fields: review, expected: reviewDraft(issue) })).status === 409, 'stale reviews must conflict');
  const now = Date.now();
  const fixture = [
    { id: 'same-id', title: 'Review the widget', status: 'open', priority: 2, metadata: { bd_console_review: JSON.stringify({ decision: 'pending' }) } },
    { id: 'g', title: 'Approve deployment', issue_type: 'gate', await_type: 'human', status: 'open' },
    { id: 'b', title: 'Unblock release', status: 'in_progress', updated_at: new Date(now - 2 * 86400000).toISOString() },
    { id: 'c', title: 'Blocked task', status: 'open', priority: 0, dependencies: [{ type: 'blocks', depends_on_id: 'b' }] },
    { id: 'd', title: 'Ready now', status: 'open', priority: 1 },
    { id: 'e', title: 'Deferred urgent task', status: 'open', priority: 0, defer_until: new Date(now + 86400000).toISOString() },
  ];
  const rows = projectWork('one', { name: 'First' }, fixture, now);
  assert(rows[0].reasons.includes('Needs review'), 'review metadata should drive attention');
  assert(rows[1].reasons.includes('Human approval needed'), 'human gates should drive attention');
  assert(rows[2].reasons.length === 2 && !rows[3].ready && rows[4].ready && !rows[5].reasons.length, 'blocker direction, stale work, priority and defer must be respected');
  const all = [...rows, ...projectWork('two', { name: 'Second' }, [{ id: 'same-id', title: 'Other project', status: 'closed', notes: 'hidden needle' }])];
  assert(searchWork(all, 'needle')[0].projectId === 'two', 'global search must include narrative fields');
  assert(searchWork(all, 'same-id', { project: 'one' }).length === 1, 'identical issue ids must stay project scoped');
  assert(searchWork(all, '', { status: 'closed' }).length === 1, 'status filter must work');
  const baseline = { one: { issues: workSnapshot(rows) } };
  assert(!activitySince(all, baseline).length, 'unchanged issues and first visits must not create activity');
  const changed = projectWork('one', {}, fixture.map(i => i.id === 'b' ? { ...i, status: 'closed' } : i), now);
  const activity = activitySince(changed, baseline);
  assert(activity.some(r => r.issue.id === 'c' && r.reasons[0] === 'Newly ready') && activity.some(r => r.issue.id === 'b' && r.reasons[0] === 'Closed'), 'closing a blocker should produce newly-ready activity');
  const result = await collectWork({ one: {}, two: {} }, async id => { if (id === 'two') throw new Error('offline'); return { issues: fixture }; });
  assert(result.one.rows.length === fixture.length && result.two.error === 'offline', 'one failed project must not hide successful results');
  const route = parseRoute(issueLink('project with spaces', 'same-id'));
  assert(route.projectId === 'project with spaces' && route.issueId === 'same-id', 'issue links must round-trip through routing');
  assert(parseRoute('#/p2/%broken').view === 'hub', 'malformed URL escaping must not crash routing');
  const fakeBin = join(ctx.tempRoot, 'health-cache-bin');
  mkdirSync(fakeBin);
  const marker = join(fakeBin, 'first-lint-failed');
  writeFileSync(join(fakeBin, 'bd'), `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'lint') {
  if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(1); }
  console.log(JSON.stringify({ issues: 3 }));
} else { console.log('null'); }
`, { mode: 0o755 });
  // Mark the extensionless stub as ESM without changing the repository.
  writeFileSync(join(fakeBin, 'package.json'), JSON.stringify({ type: 'module' }));
  const retryScript = join(fakeBin, 'probe.mjs');
  writeFileSync(retryScript, `
import { getCachedLintOrphanCounts } from ${JSON.stringify('file://' + resolve('lib/bd.mjs'))};
const context = { workspace: ${JSON.stringify(ctx.repoDir)} };
getCachedLintOrphanCounts(context);
await new Promise(r => setTimeout(r, 700));
const unknown = getCachedLintOrphanCounts(context);
let recovered;
for (let i = 0; i < 90; i++) {
  recovered = getCachedLintOrphanCounts(context);
  if (recovered?.lintCount === 3) break;
  await new Promise(r => setTimeout(r, 100));
}
console.log(JSON.stringify({ unknown, recovered }));
`);
  const recovery = JSON.parse(ctx.trimLastLine(run(process.execPath, [retryScript], { env: { ...process.env, PATH: fakeBin + ':' + process.env.PATH } })));
  assert(recovery.unknown?.lintCount === null && recovery.recovered?.lintCount === 3, 'transient health failures must retry instead of caching unknown for five minutes');
  console.log('smoke ok (issue content and review: literal round-trip, clear, validation, stale conflicts, unrelated metadata preserved)');
}
