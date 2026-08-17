// smoke: docs: reading, writing, creating, and navigating them.
//
// Sections moved verbatim out of the single-file scripts/smoke.mjs
// (bd-console-m90). Run just this domain with:
//     node scripts/smoke.mjs docs
// Shared fixtures, isolation and helpers come from ./harness.mjs via ctx.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
// Pure MapView/docs derivations (docs/beads-coverage.md Phase 2) — signal-free
// by design, so they can be asserted in Node instead of only in a browser.
import { mapScopeIssues } from '../../public/ui/console2/graphModel.js';
import { docGroup, groupDocs, starterDocs } from '../../public/ui/console2/docsModel.js';
// "New doc" derivations (bd-console-09n) — same import-free contract as
// relationships.js; docCreate.js's own header calls this out by name.
import { newDocName, newDocPath, docFolders, newDocProblem, newDocTemplate } from '../../public/ui/docCreate.js';
// DOM-free plain ESM (public/ui/markdown.js's own header calls this out) —
// importable and assertable straight in Node, same contract as the
// derivations above.
import { renderMarkdown, sanitizeUrl } from '../../public/ui/markdown.js';

export async function runDocs(ctx) {
  const { assert, tempRoot, p } = ctx;

  // --- doc editing ---------------------------------------------------------------
  const docSaveRes = await fetch(p('/doc'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'docs/plan.md', content: '# Plan\n\n- item\n- edited by smoke\n' })
  }).then((r) => r.json());
  assert(docSaveRes.ok && docSaveRes.path === 'docs/plan.md' && typeof docSaveRes.mtime === 'number', `doc save failed: ${JSON.stringify(docSaveRes)}`);

  const docReread = await fetch(p(`/doc?path=${encodeURIComponent('docs/plan.md')}`)).then((r) => r.json());
  assert(docReread.content.includes('edited by smoke'), 'doc save did not persist (re-read mismatch)');

  const docNewFile = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'docs/new-from-smoke.md', content: '# New\n' })
  }).then((r) => r.json());
  assert(docNewFile.ok, `doc create-new-file failed: ${JSON.stringify(docNewFile)}`);
  const docNewReread = await fetch(p(`/doc?path=${encodeURIComponent('docs/new-from-smoke.md')}`)).then((r) => r.json());
  assert(docNewReread.content === '# New\n', 'newly created doc content mismatch on re-read');

  const docTraversal = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '../outside.md', content: 'nope' })
  });
  assert(docTraversal.status >= 400 && docTraversal.status < 500, `doc traversal escape should 4xx, got ${docTraversal.status}`);

  const docNonMd = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'docs/notes.txt', content: 'nope' })
  });
  assert(docNonMd.status === 400, `doc non-.md path should 400, got ${docNonMd.status}`);

  console.log('smoke ok (doc editing: save/reread + new-file + traversal/non-md rejection)');

  // --- bd-console-09n: "New doc" pure derivations (docCreate.js) ------------
  // Signal-free like relationships.js/formulas.js, so assertable here
  // without a browser — see docCreate.js's own header for the contract.
  assert(newDocName('plan') === 'plan.md' && newDocName('plan.md') === 'plan.md',
    `newDocName must append .md exactly once; got ${JSON.stringify([newDocName('plan'), newDocName('plan.md')])}`);
  assert(newDocName('  ') === '', 'a blank name must yield no filename');

  assert(newDocPath('docs', 'plan') === 'docs/plan.md' && newDocPath('', 'plan') === 'plan.md',
    `newDocPath must join folder + name, and omit a leading slash for the root; got ${JSON.stringify([newDocPath('docs', 'plan'), newDocPath('', 'plan')])}`);
  assert(newDocPath('/docs/', 'plan') === 'docs/plan.md',
    'newDocPath must strip stray leading/trailing slashes from the folder');

  const newDocFixtureDocs = [{ path: 'README.md' }, { path: 'docs/plan.md' }, { path: 'notes/2026-07.md' }];
  const autoFolders = docFolders(newDocFixtureDocs);
  assert(autoFolders.includes('') && autoFolders.includes('docs') && autoFolders.includes('notes'),
    `docFolders (auto-discovery) should offer the project root plus every existing ancestor folder; got ${JSON.stringify(autoFolders)}`);
  const rootedFolders = docFolders(newDocFixtureDocs, ['docs']);
  assert(rootedFolders.includes('docs') && !rootedFolders.includes('notes') && !rootedFolders.includes(''),
    `THE BUG this guards: a configured docRoots must exclude folders outside it (and the bare root, unless it IS a root) — resolveDocPath() would reject a write there anyway; got ${JSON.stringify(rootedFolders)}`);

  assert(newDocProblem('docs', '', newDocFixtureDocs) === 'Give the document a name.',
    'an empty name must be refused with a name-specific reason');
  assert(newDocProblem('docs', 'sub/evil', newDocFixtureDocs) !== null,
    'a name containing a slash must be refused (the folder comes from the picker, not free text)');
  assert(/letters, numbers/.test(newDocProblem('docs', '$$$', newDocFixtureDocs) || ''),
    'a name with no usable characters must be refused');
  assert(/cannot contain "\.\."/.test(newDocProblem('docs', 'a..b', newDocFixtureDocs) || ''),
    'a name containing ".." must be refused even when it otherwise matches the character class');
  assert(/already exists/.test(newDocProblem('docs', 'plan', newDocFixtureDocs) || ''),
    'a name colliding with an existing doc must be refused, telling the author to open it instead');
  assert(newDocProblem('docs', 'brand-new', newDocFixtureDocs) === null,
    'a fresh, well-formed name must be accepted');

  assert(newDocTemplate('new') === '# New\n\n', `newDocTemplate should title-case a simple stem; got ${JSON.stringify(newDocTemplate('new'))}`);
  assert(newDocTemplate('release-notes.md') === '# Release notes\n\n',
    `newDocTemplate should strip .md and humanize dashes/underscores; got ${JSON.stringify(newDocTemplate('release-notes.md'))}`);
  assert(newDocTemplate('') === '# Untitled\n\n', 'newDocTemplate must fall back to Untitled for an empty stem');

  console.log('smoke ok (docCreate.js derivations: name/path joining, folder offering, save-gate reasons, starter template)');

  // --- bd-console-09n: create-only doc write route (`create: true`) --------
  // Same POST /api/doc route the editor uses; `create: true` is what lets the
  // "New doc" dialog land a file without ever risking an overwrite — see the
  // /api/doc POST handler in lib/routes.mjs.
  const docCreateNew = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'docs/created-by-smoke.md', content: '# Created\n\n', create: true })
  }).then((r) => r.json());
  assert(docCreateNew.ok && docCreateNew.path === 'docs/created-by-smoke.md',
    `create:true on a fresh path should succeed: ${JSON.stringify(docCreateNew)}`);
  const docCreateReread = await fetch(p(`/doc?path=${encodeURIComponent('docs/created-by-smoke.md')}`)).then((r) => r.json());
  assert(docCreateReread.content === '# Created\n\n', 'doc created with create:true did not persist');

  // THE BUG this guards: `create: true` must refuse to land on a path that
  // already has content, and must not have touched that content on the way
  // to refusing.
  const docCreateConflict = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'docs/created-by-smoke.md', content: '# Overwritten\n', create: true })
  });
  assert(docCreateConflict.status === 409, `create:true against an existing path should 409, got ${docCreateConflict.status}`);
  const docCreateConflictBody = await docCreateConflict.json();
  assert(/already exists/i.test(docCreateConflictBody.error || ''), `409 body should explain the conflict: ${JSON.stringify(docCreateConflictBody)}`);
  const docCreateUnchanged = await fetch(p(`/doc?path=${encodeURIComponent('docs/created-by-smoke.md')}`)).then((r) => r.json());
  assert(docCreateUnchanged.content === '# Created\n\n', 'a 409 create:true attempt must not have touched the existing content');

  // create:true does not bypass ordinary path validation — resolveDocPath()
  // rejects a traversal before the create/409 check ever runs, so this must
  // 400 like any other traversal attempt, not fall through as a "new" file.
  const docCreateTraversal = await fetch(p('/doc'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '../outside-create.md', content: 'nope', create: true })
  });
  assert(docCreateTraversal.status === 400, `create:true traversal escape should 400, got ${docCreateTraversal.status}`);
  assert(!existsSync(join(tempRoot, 'outside-create.md')), 'create:true traversal must not have written outside the workspace');

  console.log('smoke ok (create-only doc route: fresh-path success, existing-path 409 without overwrite, traversal still rejected)');

  // --- Large-project Map/Docs scopes (bd-console-7wn.6) -------------------
  {
    const scopeIssues = [
      { id: 's-epic', title: 'Checkout epic', issue_type: 'epic', status: 'open', priority: 2, dependencies: [] },
      { id: 's-active', title: 'Active checkout work', issue_type: 'task', status: 'in_progress', priority: 2, dependencies: [
        { issue_id: 's-active', depends_on_id: 's-epic', type: 'parent-child' },
        { issue_id: 's-active', depends_on_id: 's-blocker', type: 'blocks' }] },
      { id: 's-blocker', title: 'Required migration', issue_type: 'task', status: 'open', priority: 3, dependencies: [] },
      { id: 's-next', title: 'Follows active work', issue_type: 'task', status: 'open', priority: 3, dependencies: [
        { issue_id: 's-next', depends_on_id: 's-epic', type: 'parent-child' },
        { issue_id: 's-next', depends_on_id: 's-active', type: 'blocks' }] },
      { id: 's-urgent', title: 'Urgent independent work', issue_type: 'bug', status: 'open', priority: 1, dependencies: [] },
      { id: 's-noise', title: 'Unrelated backlog', issue_type: 'task', status: 'open', priority: 4, dependencies: [] },
      { id: 's-done', title: 'Closed history', issue_type: 'task', status: 'closed', priority: 0, dependencies: [] },
    ];
    const currentIds = mapScopeIssues(scopeIssues, 'current').map((i) => i.id);
    for (const id of ['s-active', 's-blocker', 's-next', 's-urgent', 's-epic']) {
      assert(currentIds.includes(id), `current map scope should preserve active/urgent context ${id}; got ${JSON.stringify(currentIds)}`);
    }
    assert(!currentIds.includes('s-noise') && !currentIds.includes('s-done'),
      `current map scope should omit unrelated backlog and closed history; got ${JSON.stringify(currentIds)}`);
    const epicIds = mapScopeIssues(scopeIssues, 'epic', 's-epic').map((i) => i.id);
    assert(epicIds.includes('s-epic') && epicIds.includes('s-active') && epicIds.includes('s-next') && epicIds.includes('s-blocker'),
      `epic map scope should include descendants and their external blocker; got ${JSON.stringify(epicIds)}`);
    assert(!epicIds.includes('s-urgent') && !epicIds.includes('s-noise'),
      `epic map scope should not include unrelated open work; got ${JSON.stringify(epicIds)}`);
    assert(mapScopeIssues(scopeIssues, 'all').length === 6, 'all-open map scope must preserve access to every non-closed issue');

    const docsFixture = [
      { path: 'README.md' }, { path: 'AGENTS.md' }, { path: 'docs/index.md' },
      { path: 'docs/operators/deploy.md' }, { path: 'notes/2026-07.md' },
    ];
    assert(docGroup('README.md') === 'Project root' && docGroup('docs/operators/deploy.md') === 'docs',
      'document groups should use the top-level folder and keep root files together');
    const grouped = groupDocs(docsFixture);
    assert(JSON.stringify(grouped.map((g) => [g.name, g.items.length])) === JSON.stringify([
      ['Project root', 2], ['docs', 2], ['notes', 1],
    ]), `document grouping should remain compact and deterministic; got ${JSON.stringify(grouped)}`);
    assert(groupDocs(docsFixture, 'deploy').flatMap((g) => g.items).map((d) => d.path).join() === 'docs/operators/deploy.md',
      'document search must still reach a file nested below grouped folders');
    assert(starterDocs(docsFixture, 3).map((d) => d.path).includes('README.md'),
      'document start page should prioritize a repository README');
    console.log('smoke ok (large-project map scopes + grouped/searchable docs navigation)');
  }

  // --- markdown link-scheme sanitization (bd-console-974.2) -----------------
  // Bead/doc text is agent-authored and renderMarkdown's output lands in
  // dangerouslySetInnerHTML (Docs2.js, Detail.js) — a javascript:/data: href
  // must never survive into that HTML.
  assert(sanitizeUrl('javascript:alert(1)') === null, 'javascript: URLs must be refused');
  assert(sanitizeUrl('  javascript:alert(1)') === null, 'a leading-whitespace javascript: URL must still be refused');
  assert(sanitizeUrl('java\tscript:alert(1)') === null, 'whitespace-obfuscated javascript: schemes must still be refused');
  assert(sanitizeUrl('data:text/html,<script>alert(1)</script>') === null, 'data: URLs must be refused');
  assert(sanitizeUrl('vbscript:msgbox(1)') === null, 'vbscript: URLs must be refused');
  assert(sanitizeUrl('https://example.com/x?a=1&b=2') === 'https://example.com/x?a=1&b=2', 'https: URLs must survive unchanged');
  assert(sanitizeUrl('http://example.com') === 'http://example.com', 'http: URLs must survive unchanged');
  assert(sanitizeUrl('mailto:a@b.com') === 'mailto:a@b.com', 'mailto: URLs must survive unchanged');
  assert(sanitizeUrl('//example.com/x') === '//example.com/x', 'protocol-relative URLs must survive unchanged');
  assert(sanitizeUrl('/docs/plan.md') === '/docs/plan.md', 'absolute paths must survive unchanged');
  assert(sanitizeUrl('docs/plan.md') === 'docs/plan.md', 'relative paths must survive unchanged');
  assert(sanitizeUrl('../plan.md') === '../plan.md', 'parent-relative paths must survive unchanged');
  assert(sanitizeUrl('#section') === '#section', 'fragments must survive unchanged');

  const jsLinkHtml = renderMarkdown('[click me](javascript:alert(1))');
  assert(!/javascript:/i.test(jsLinkHtml), `rendered markdown must not carry a javascript: href: ${jsLinkHtml}`);
  assert(!/<a /.test(jsLinkHtml) && /click me/.test(jsLinkHtml), `a refused-scheme link must fall back to plain text: ${jsLinkHtml}`);

  const dataLinkHtml = renderMarkdown('[x](data:text/html,evil)');
  assert(!/data:/i.test(dataLinkHtml), `rendered markdown must not carry a data: href: ${dataLinkHtml}`);

  const httpLinkHtml = renderMarkdown('[bd-console](https://example.com/repo)');
  assert(/<a href="https:\/\/example\.com\/repo" target="_blank" rel="noopener">bd-console<\/a>/.test(httpLinkHtml),
    `an ordinary http(s) link must render as a real, safe anchor: ${httpLinkHtml}`);

  console.log('smoke ok (markdown link-scheme sanitization: javascript:/data:/vbscript: neutralized, http(s)/mailto/relative/fragment links survive)');
}
