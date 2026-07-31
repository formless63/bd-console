// DocsView.js — docs browser: a filterable, grouped tree on the left and a
// client-rendered Markdown pane on the right, plus a "New doc" form so the
// tree is something you can add to and not only read from.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { store, toggleDocGroup, openDoc, loadDocs, toast, requireToken } from '../store.js';
import { AuthError } from '../api.js';
import { createDoc, docFolders, newDocPath, newDocProblem, newDocTemplate } from '../docCreate.js';
import { renderMarkdown } from '../markdown.js';

// The folder comes from a picker of folders that already exist rather than a
// free-text path: it keeps the server's "parent directory does not exist"
// precondition satisfied by construction, and it means the ordinary way to
// use this dialog can't even express a traversal. (The server still checks —
// see resolveDocPath() — this is just what makes the common case pleasant.)
function NewDocForm({ onDone }) {
  const docs = store.docs.value;
  const folders = docFolders(docs, store.meta.value?.docRoots ?? null);
  const [folder, setFolder] = useState(folders[0] ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const path = newDocPath(folder, name);
  const problem = name.trim() ? newDocProblem(folder, name, docs) : null;

  const submit = async (e) => {
    e.preventDefault();
    const p = newDocProblem(folder, name, docs);
    if (p) { setError(p); return; }
    setBusy(true);
    setError(null);
    try {
      await createDoc(path, newDocTemplate(name));
      await loadDocs();
      await openDoc(path);
      toast('Created ' + path);
      onDone();
    } catch (err) {
      if (err instanceof AuthError) requireToken('A write token is required to create a document.');
      setError(err.message || 'Could not create the document.');
    } finally {
      setBusy(false);
    }
  };

  return html`
    <form class="doc-new" onSubmit=${submit}>
      <div class="doc-new-row">
        <select class="doc-new-folder" aria-label="Folder" value=${folder} onChange=${(e) => setFolder(e.target.value)}>
          ${folders.map((f) => html`<option key=${f} value=${f}>${f === '' ? '(project root)' : f + '/'}</option>`)}
        </select>
        <input class="doc-new-name" aria-label="File name" placeholder="new-doc.md" autofocus
          value=${name} onInput=${(e) => { setName(e.target.value); setError(null); }} />
      </div>
      <div class="doc-new-preview muted small">${path ? 'Creates ' + path : 'Creates …'}</div>
      ${(error || problem) && html`<div class="doc-new-error">${error || problem}</div>`}
      <div class="doc-new-actions">
        <button type="button" class="btn btn-ghost btn-xs" onClick=${onDone}>Cancel</button>
        <button type="submit" class="btn btn-xs" disabled=${busy || !name.trim()}>${busy ? 'Creating…' : 'Create'}</button>
      </div>
    </form>`;
}

function DocTree() {
  // DocTree() is invoked as a plain call from DocsView (not as a component),
  // so this hook belongs to DocsView — fine, and stable: the call is
  // unconditional and DocContent() below uses no hooks at all.
  const [newOpen, setNewOpen] = useState(false);
  const q = store.docFilter.value.toLowerCase();
  const filtered = store.docs.value.filter((d) => !q || d.path.toLowerCase().includes(q));
  const searching = !!q;
  const selected = store.selectedDocPath.value;
  const collapsed = store.collapsedDocGroups.value;

  const topLevel = filtered.filter((d) => d.group === '(top level)');
  const groups = new Map();
  for (const d of filtered) { if (d.group === '(top level)') continue; if (!groups.has(d.group)) groups.set(d.group, []); groups.get(d.group).push(d); }

  const item = (d) => html`
    <button key=${d.path} class=${'tree-item' + (selected === d.path ? ' active' : '')} title=${d.path} onClick=${() => openDoc(d.path)}>
      ${d.path.split('/').pop()}
    </button>`;

  return html`
    <aside class="filters docs-filters">
      <div class="doc-tree-head">
        <span class="doc-tree-head-label">Documents</span>
        <button type="button" class="btn btn-xs" onClick=${() => setNewOpen(!newOpen)}>
          ${newOpen ? 'Cancel' : '+ New doc'}
        </button>
      </div>
      ${newOpen && html`<${NewDocForm} onDone=${() => setNewOpen(false)} />`}
      <div class="search-wrap">
        <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M11.7 10.3a6 6 0 10-1.4 1.4l3 3 1.4-1.4-3-3zM3 7a4 4 0 118 0 4 4 0 01-8 0z"/></svg>
        <input class="search" type="search" placeholder="Filter docs…" value=${store.docFilter.value} onInput=${(e) => (store.docFilter.value = e.target.value)} />
      </div>
      <div class="doc-tree">
        ${store.docsLoading.value && store.docs.value.length === 0
          ? Array.from({ length: 6 }).map((_, n) => html`<span key=${n} class="skeleton-bar tree-skel"></span>`)
          : html`
            ${topLevel.map(item)}
            ${[...groups.keys()].sort().map((name) => {
              const docs = groups.get(name);
              const isCollapsed = !searching && collapsed.has(name);
              return html`
                <div key=${name} class=${'tree-group' + (isCollapsed ? ' collapsed' : '')}>
                  <button class="tree-group-title" onClick=${() => toggleDocGroup(name)}>
                    <span class="tree-chev">▾</span><span class="gname">${name}</span><span class="gct">${docs.length}</span>
                  </button>
                  ${!isCollapsed && html`<div class="tree-items">${docs.map(item)}</div>`}
                </div>`;
            })}
            ${filtered.length === 0 && html`<div class="pane-empty muted">No docs match.</div>`}
          `}
      </div>
    </aside>`;
}

function DocContent() {
  const path = store.selectedDocPath.value;
  if (!path) return html`<section class="doc-pane"><div class="pane-empty muted"><div class="empty-icon">◇</div>Select a document.</div></section>`;
  if (store.docLoading.value) return html`<section class="doc-pane"><div class="doc-loading"><sl-spinner></sl-spinner></div></section>`;
  const content = store.docContent.value;
  if (content == null) return html`<section class="doc-pane"><div class="pane-empty muted">Could not load document.</div></section>`;
  return html`
    <section class="doc-pane">
      <div class="doc-pathline">${path}</div>
      <div class="markdown" dangerouslySetInnerHTML=${{ __html: renderMarkdown(content) }}></div>
    </section>`;
}

export function DocsView() {
  const detailOpen = !!store.selectedDocPath.value;
  return html`
    <div class=${'project-panes docs-layout' + (detailOpen ? ' show-detail' : '')}>
      ${DocTree()}
      ${DocContent()}
    </div>`;
}
