// smoke: the baseline read/write contract of a freshly registered project.
//
// This is the bootstrap the whole suite stands on — hub mode, the project
// listing, issues/docs/comments reads, the edit ops, quick capture, and the
// 404 for an unregistered project. It always runs, even for a single-domain
// run, because everything else assumes the fixture repo is actually being
// served (bd-console-m90).

export async function runBaseline(ctx) {
  const { assert, port, projectId, repoDir, p, seedId, state } = ctx;

  const hubMeta = await fetch(`http://127.0.0.1:${port}/api/meta`).then((r) => r.json());
  assert(hubMeta.mode === 'hub', 'root /api/meta should report hub mode');

  const projects = await fetch(`http://127.0.0.1:${port}/api/projects`).then((r) => r.json());
  assert(projects.projects && projects.projects[projectId] && projects.projects[projectId].path === repoDir, '/api/projects missing registered repo');

  const meta = await fetch(p('/meta')).then((r) => r.json());
  assert(meta.name === 'repo', 'per-project meta name mismatch');

  const issues0 = await fetch(p('/issues')).then((r) => r.json());
  assert(Array.isArray(issues0.issues) && issues0.issues.some((i) => i.id === seedId), 'seed issue missing from /api/p/<id>/issues');

  const docs = await fetch(p('/docs')).then((r) => r.json());
  assert(docs.docs.some((d) => d.path === 'README.md'), 'top-level README missing from /api/p/<id>/docs');
  assert(docs.docs.some((d) => d.path === 'docs/plan.md'), 'nested doc missing from /api/p/<id>/docs');

  const doc = await fetch(p(`/doc?path=${encodeURIComponent('docs/plan.md')}`)).then((r) => r.json());
  assert(doc.content.includes('Plan'), '/api/p/<id>/doc returned unexpected content');

  const comments0 = await fetch(p(`/comments?id=${encodeURIComponent(seedId)}`)).then((r) => r.json());
  assert(Array.isArray(comments0.comments), '/api/p/<id>/comments did not return an array');

  const commentRes = await fetch(p('/comment'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, text: 'smoke comment' })
  }).then((r) => r.json());
  assert(commentRes.comments.some((c) => c.text === 'smoke comment'), 'comment write path failed');

  await fetch(p('/edit'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, op: 'claim' })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `edit claim failed (${r.status})`);
  });

  await fetch(p('/edit'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, op: 'set-priority', priority: '1' })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `edit priority failed (${r.status})`);
  });

  await fetch(p('/edit'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: seedId, op: 'add-label', label: 'smoke' })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `edit label failed (${r.status})`);
  });

  const issuesAfterEdit = await fetch(p('/issues')).then((r) => r.json());
  const edited = issuesAfterEdit.issues.find((i) => i.id === seedId);
  assert(edited && edited.priority === 1, 'priority edit did not persist');
  assert(edited && edited.status === 'in_progress', 'claim action did not persist');
  assert(edited && (edited.labels || []).includes('smoke'), 'label edit did not persist');

  const quickRes = await fetch(p('/quick'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Quick smoke issue', description: 'created by smoke', label: 'triage', priority: '3' })
  }).then((r) => r.json());
  assert(quickRes.id, 'quick capture did not return an issue id');
  state.quickRes = quickRes;

  const issues1 = await fetch(p('/issues')).then((r) => r.json());
  assert(issues1.issues.some((i) => i.id === quickRes.id), 'quick-captured issue missing after export refresh');

  // A request for an unregistered project should 404, not fall through.
  const unknown = await fetch(`http://127.0.0.1:${port}/api/p/does-not-exist/issues`);
  assert(unknown.status === 404, 'unknown project id should 404');
}
