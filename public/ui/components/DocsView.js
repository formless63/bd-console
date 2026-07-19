// DocsView.js — docs browser: a filterable, grouped tree on the left and a
// client-rendered Markdown pane on the right.
import { html } from 'htm/preact';
import { store, toggleDocGroup, openDoc } from '../store.js';
import { renderMarkdown } from '../markdown.js';

function DocTree() {
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
