// console2/Docs2.js — docs canvas: a file tree, a client-rendered Markdown
// pane, an inline textarea editor (Ctrl-S / Save, dirty indicator, preview
// toggle) and PROMOTE — select text in the rendered view to spin a new
// doc:<path>-labelled issue prefilled with the quoted selection.
import { html } from 'htm/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, openDoc, loadDocs } from '../store.js';
import { c2 } from './state.js';
import { renderMarkdown } from '../markdown.js';
import { saveDoc, capturePromoted } from './actions.js';
import { LearnEmpty } from '../components/ConceptTip.js';
import { docGroup, groupDocs, starterDocs } from './docsModel.js';

const RECENT_DOCS_KEY = 'bd_c2_recent_docs';
function loadRecentDocs(projectId) {
  try { return (JSON.parse(localStorage.getItem(RECENT_DOCS_KEY)) || {})[projectId] || []; } catch { return []; }
}
function saveRecentDoc(projectId, path) {
  if (!projectId || !path) return [];
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_DOCS_KEY)) || {};
    all[projectId] = [path, ...(all[projectId] || []).filter((p) => p !== path)].slice(0, 8);
    localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(all));
    return all[projectId];
  } catch { return [path]; }
}

function Tree({ pick }) {
  const q = (store.docFilter.value || '').toLowerCase();
  const groups = useMemo(() => groupDocs(store.docs.value, q), [store.docs.value, q]);
  const matchCount = groups.reduce((n, group) => n + group.items.length, 0);
  const sel = store.selectedDocPath.value;
  const [openGroups, setOpenGroups] = useState(new Set(['Project root']));
  const toggle = (name) => setOpenGroups((old) => {
    const next = new Set(old);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });
  useEffect(() => {
    if (!sel) return;
    const group = docGroup(sel);
    setOpenGroups((old) => new Set([...old, group]));
  }, [sel]);
  useEffect(() => { setOpenGroups(new Set(['Project root'])); }, [store.projectId.value]);
  const choose = (path) => { pick(path); c2.docTreeOpen.value = false; };
  return html`
    <aside class=${'c2-doctree' + (c2.docTreeOpen.value ? ' open' : '')}>
      <div class="c2-doctree-bar">
        <input class="c2-docfilter" type="search" aria-label="Search all project documents" placeholder="Search ${store.docs.value.length} docs…" value=${store.docFilter.value}
          onInput=${(e) => (store.docFilter.value = e.target.value)} />
        <button class="c2-doctree-close" aria-label="Close doc list" title="Close" onClick=${() => (c2.docTreeOpen.value = false)}>✕</button>
      </div>
      <div class="c2-doctree-summary">${q ? `${matchCount} matches` : `${store.docs.value.length} documents · grouped by folder`}</div>
      <div class="c2-doctree-list" aria-label="Project document folders">
        ${groups.length === 0 ? html`<div class="c2-lane-empty">${q ? 'No documents match' : 'No documents'}</div>`
          : groups.map((group) => {
            const expanded = !!q || openGroups.has(group.name);
            return html`
              <section class="c2-doc-folder" key=${group.name}>
                <button class="c2-doc-folder-head" aria-expanded=${expanded} onClick=${() => toggle(group.name)}>
                  <span aria-hidden="true">${expanded ? '▾' : '▸'}</span>
                  <strong>${group.name}</strong><span>${group.items.length}</span>
                </button>
                ${expanded ? html`<div class="c2-doc-folder-items">
                  ${group.items.map((d) => html`
                    <button key=${d.path} class=${'c2-doc-item' + (sel === d.path ? ' active' : '')} title=${d.path}
                      aria-current=${sel === d.path ? 'page' : undefined} onClick=${() => choose(d.path)}>
                      <span class="c2-doc-name">${d.path.split('/').pop()}</span>
                      <span class="c2-doc-group">${d.path}</span>
                    </button>`)}
                </div>` : ''}
              </section>`;
          })}
      </div>
    </aside>`;
}

// Manual promote fallback: text-selection promote (mouseup/touchend below)
// works well with a mouse but selection handles are fiddly on touch, so this
// form lets a phone user paste/type the excerpt directly instead. Always in
// the DOM; the trigger button that opens it is mobile-only (CSS-gated) so
// desktop's promote flow (still selection-driven) is pixel-unchanged.
function PromoteForm({ path }) {
  const [title, setTitle] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const submit = async () => {
    const t = (title || excerpt.split('\n')[0] || '').slice(0, 80).trim();
    if (!t) return;
    const description = '> ' + excerpt.trim().replace(/\n/g, '\n> ') + `\n\n_Promoted from ${path}_`;
    try { await capturePromoted(t, description, path); } catch { /* toasted */ }
    setTitle(''); setExcerpt('');
    c2.promoteOpen.value = false;
  };
  return html`
    <div class="c2-promote-form">
      <div class="c2-edit-row">
        <span class="c2-hud-label">Promote excerpt</span>
        <button class="c2-doctree-close" aria-label="Cancel promote" onClick=${() => (c2.promoteOpen.value = false)}>✕</button>
      </div>
      <input class="c2-edit-input" placeholder="Title (optional, uses first line otherwise)" value=${title} onInput=${(e) => setTitle(e.target.value)} />
      <textarea class="c2-delegate-text" placeholder="Paste or type the excerpt to promote…" value=${excerpt} onInput=${(e) => setExcerpt(e.target.value)}></textarea>
      <button class="c2-mini accent" disabled=${!excerpt.trim()} onClick=${submit}>✦ Promote to issue</button>
    </div>`;
}

function Reader({ path, content }) {
  const [promo, setPromo] = useState(null); // {x,y,text}
  const ref = useRef(null);

  const onSelectionEnd = () => {
    const s = window.getSelection();
    const text = s && String(s).trim();
    if (!text || text.length < 3) { setPromo(null); return; }
    try {
      const rect = s.getRangeAt(0).getBoundingClientRect();
      const host = ref.current.getBoundingClientRect();
      setPromo({ text, x: rect.left - host.left + rect.width / 2, y: rect.top - host.top - 8 });
    } catch { setPromo(null); }
  };

  const promote = async () => {
    const text = promo.text;
    const title = text.split('\n')[0].slice(0, 80);
    const description = '> ' + text.replace(/\n/g, '\n> ') + `\n\n_Promoted from ${path}_`;
    try { await capturePromoted(title, description, path); } catch { /* toasted */ }
    setPromo(null);
    window.getSelection()?.removeAllRanges();
  };

  return html`
    <div class="c2-doc-reader" ref=${ref} onMouseUp=${onSelectionEnd} onTouchEnd=${onSelectionEnd}>
      <div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(content) }}></div>
      ${promo && html`
        <button class="c2-promote" style=${`left:${promo.x}px; top:${promo.y}px`} onClick=${promote}>
          ✦ Promote to issue
        </button>`}
      ${c2.promoteOpen.value && html`<${PromoteForm} path=${path} />`}
    </div>`;
}

function Editor({ path }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault(); doSave();
      }
    };
    const el = ref.current;
    el?.addEventListener('keydown', onKey);
    return () => el?.removeEventListener('keydown', onKey);
  });
  const doSave = async () => {
    try {
      await saveDoc(path, c2.docDraft.value);
      c2.docDirty.value = false;
      store.docContent.value = c2.docDraft.value;
      loadDocs();
    } catch { /* toasted */ }
  };
  return html`
    <div class="c2-doc-editor">
      <textarea ref=${ref} class="c2-doc-textarea" spellcheck="false" value=${c2.docDraft.value}
        onInput=${(e) => { c2.docDraft.value = e.target.value; c2.docDirty.value = true; }}></textarea>
      ${c2.docPreview.value && html`<div class="markdown c2-md c2-doc-livepreview" dangerouslySetInnerHTML=${{ __html: renderMarkdown(c2.docDraft.value) }}></div>`}
    </div>`;
}

function DocsLanding({ pick, recentPaths }) {
  const docs = store.docs.value;
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const recent = recentPaths.map((path) => byPath.get(path)).filter(Boolean).slice(0, 5);
  const recentSet = new Set(recent.map((d) => d.path));
  const starters = starterDocs(docs, 6).filter((d) => !recentSet.has(d.path)).slice(0, 5);
  const groups = groupDocs(docs);
  const docButton = (doc) => html`
    <button key=${doc.path} class="c2-doc-entry" title=${doc.path} onClick=${() => pick(doc.path)}>
      <span class="c2-doc-entry-icon" aria-hidden="true">❐</span>
      <span><strong>${doc.path.split('/').pop()}</strong><small>${doc.path}</small></span>
      <span aria-hidden="true">→</span>
    </button>`;
  return html`
    <div class="c2-doc-home">
      <header class="c2-doc-home-head">
        <div><span class="c2-kicker">Project knowledge</span><h2>Documents</h2>
          <p>${docs.length} markdown files, grouped by folder so plans and reference material stay findable.</p></div>
        <button class="c2-mini accent" onClick=${() => (c2.docTreeOpen.value = true)}>Browse all ${docs.length}</button>
      </header>
      <div class="c2-doc-home-grid">
        ${recent.length ? html`<section class="c2-doc-home-section"><h3>Recently opened</h3><div>${recent.map(docButton)}</div></section>` : ''}
        <section class="c2-doc-home-section"><h3>${recent.length ? 'Useful entry points' : 'Start here'}</h3><div>${starters.map(docButton)}</div></section>
      </div>
      <section class="c2-doc-areas">
        <h3>Browse by folder</h3>
        <div>${groups.slice(0, 12).map((group) => html`
          <button key=${group.name} onClick=${() => {
            store.docFilter.value = group.name === 'Project root' ? '' : group.name + '/';
            c2.docTreeOpen.value = true;
          }}><span>▰</span><strong>${group.name}</strong><small>${group.items.length} files</small></button>`)}
        </div>
      </section>
    </div>`;
}

export function Docs2() {
  const path = store.selectedDocPath.value;
  const content = store.docContent.value;
  const editing = c2.docEditing.value;
  const hasDocs = store.docs.value.length > 0;
  const loadingDocs = store.docsLoading.value;
  const [recentPaths, setRecentPaths] = useState(() => loadRecentDocs(store.projectId.value));

  useEffect(() => { setRecentPaths(loadRecentDocs(store.projectId.value)); }, [store.projectId.value]);
  const pick = (nextPath) => {
    setRecentPaths(saveRecentDoc(store.projectId.value, nextPath));
    openDoc(nextPath);
  };

  // reset editor state when switching docs
  useEffect(() => {
    c2.docEditing.value = false;
    c2.docDirty.value = false;
    c2.docPreview.value = false;
    c2.promoteOpen.value = false;
    if (content != null) c2.docDraft.value = content;
  }, [path]);
  useEffect(() => { if (content != null && !c2.docDirty.value) c2.docDraft.value = content; }, [content]);

  const startEdit = () => { c2.docDraft.value = content || ''; c2.docEditing.value = true; };

  return html`
    <div class="c2-docs">
      <${Tree} pick=${pick} />
      <section class="c2-doc-main">
        ${!path ? (hasDocs
          ? html`<${DocsLanding} pick=${pick} recentPaths=${recentPaths} />`
          : html`
            <div class="c2-map-emptywrap">
              <${LearnEmpty} icon="❐" title="No documents here"
                what=${'This project has no markdown files for bd-console to show' + (loadingDocs ? ' yet…' : '.')}
                why="Add a README.md or a docs/ folder to the project and they will appear here — with the ability to turn any paragraph you select straight into an issue." />
            </div>`)
          : html`
            <div class="c2-doc-bar">
              <button class="c2-mini c2-doctree-toggle" title="Browse docs" onClick=${() => (c2.docTreeOpen.value = true)}>☰ docs</button>
              <span class="c2-doc-path">${path}${c2.docDirty.value ? html`<span class="c2-dirty" title="Unsaved changes">●</span>` : ''}</span>
              <span class="c2-doc-bar-actions">
                ${editing
                  ? html`
                    <button class="c2-mini" onClick=${() => (c2.docPreview.value = !c2.docPreview.value)}>${c2.docPreview.value ? 'hide preview' : 'preview'}</button>
                    <button class="c2-mini" onClick=${async () => { try { await saveDoc(path, c2.docDraft.value); c2.docDirty.value = false; store.docContent.value = c2.docDraft.value; loadDocs(); } catch {} }}>save ⌘S</button>
                    <button class="c2-mini" onClick=${() => { c2.docEditing.value = false; c2.docDirty.value = false; c2.docDraft.value = content || ''; }}>done</button>`
                  : html`
                    <button class="c2-mini c2-promote-toggle" onClick=${() => (c2.promoteOpen.value = !c2.promoteOpen.value)}>promote…</button>
                    <button class="c2-mini" onClick=${startEdit}>edit</button>`}
              </span>
            </div>
            ${content == null ? html`<div class="c2-map-empty">Loading…</div>`
              : editing ? html`<${Editor} path=${path} />` : html`<${Reader} path=${path} content=${content} />`}
          `}
      </section>
    </div>`;
}
