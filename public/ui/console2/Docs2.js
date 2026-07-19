// console2/Docs2.js — docs canvas: a file tree, a client-rendered Markdown
// pane, an inline textarea editor (Ctrl-S / Save, dirty indicator, preview
// toggle) and PROMOTE — select text in the rendered view to spin a new
// doc:<path>-labelled issue prefilled with the quoted selection.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, openDoc, loadDocs } from '../store.js';
import { c2 } from './state.js';
import { renderMarkdown } from '../markdown.js';
import { saveDoc, capturePromoted } from './actions.js';

function Tree() {
  const q = (store.docFilter.value || '').toLowerCase();
  const docs = store.docs.value.filter((d) => !q || d.path.toLowerCase().includes(q));
  const sel = store.selectedDocPath.value;
  const pick = (path) => { openDoc(path); c2.docTreeOpen.value = false; };
  return html`
    <aside class=${'c2-doctree' + (c2.docTreeOpen.value ? ' open' : '')}>
      <div class="c2-doctree-bar">
        <input class="c2-docfilter" type="search" placeholder="Filter docs…" value=${store.docFilter.value}
          onInput=${(e) => (store.docFilter.value = e.target.value)} />
        <button class="c2-doctree-close" aria-label="Close doc list" title="Close" onClick=${() => (c2.docTreeOpen.value = false)}>✕</button>
      </div>
      <div class="c2-doctree-list">
        ${docs.length === 0 ? html`<div class="c2-lane-empty">no docs</div>`
          : docs.map((d) => html`
            <button key=${d.path} class=${'c2-doc-item' + (sel === d.path ? ' active' : '')} title=${d.path}
              onClick=${() => pick(d.path)}>
              <span class="c2-doc-name">${d.path.split('/').pop()}</span>
              <span class="c2-doc-group">${d.group && d.group !== '(top level)' ? d.group : ''}</span>
            </button>`)}
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

export function Docs2() {
  const path = store.selectedDocPath.value;
  const content = store.docContent.value;
  const editing = c2.docEditing.value;

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
      ${Tree()}
      <section class="c2-doc-main">
        ${!path ? html`
            <div class="c2-map-empty">
              Select a document — then select any text to promote it to an issue.
              <div><button class="c2-mini c2-doctree-toggle" onClick=${() => (c2.docTreeOpen.value = true)}>Browse docs…</button></div>
            </div>`
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
