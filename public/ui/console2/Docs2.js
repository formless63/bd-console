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
  return html`
    <aside class="c2-doctree">
      <input class="c2-docfilter" type="search" placeholder="Filter docs…" value=${store.docFilter.value}
        onInput=${(e) => (store.docFilter.value = e.target.value)} />
      <div class="c2-doctree-list">
        ${docs.length === 0 ? html`<div class="c2-lane-empty">no docs</div>`
          : docs.map((d) => html`
            <button key=${d.path} class=${'c2-doc-item' + (sel === d.path ? ' active' : '')} title=${d.path}
              onClick=${() => openDoc(d.path)}>
              <span class="c2-doc-name">${d.path.split('/').pop()}</span>
              <span class="c2-doc-group">${d.group && d.group !== '(top level)' ? d.group : ''}</span>
            </button>`)}
      </div>
    </aside>`;
}

function Reader({ path, content }) {
  const [promo, setPromo] = useState(null); // {x,y,text}
  const ref = useRef(null);

  const onMouseUp = () => {
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
    <div class="c2-doc-reader" ref=${ref} onMouseUp=${onMouseUp}>
      <div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(content) }}></div>
      ${promo && html`
        <button class="c2-promote" style=${`left:${promo.x}px; top:${promo.y}px`} onClick=${promote}>
          ✦ Promote to issue
        </button>`}
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
    if (content != null) c2.docDraft.value = content;
  }, [path]);
  useEffect(() => { if (content != null && !c2.docDirty.value) c2.docDraft.value = content; }, [content]);

  const startEdit = () => { c2.docDraft.value = content || ''; c2.docEditing.value = true; };

  return html`
    <div class="c2-docs">
      ${Tree()}
      <section class="c2-doc-main">
        ${!path ? html`<div class="c2-map-empty">Select a document — then select any text to promote it to an issue.</div>`
          : html`
            <div class="c2-doc-bar">
              <span class="c2-doc-path">${path}${c2.docDirty.value ? html`<span class="c2-dirty" title="Unsaved changes">●</span>` : ''}</span>
              <span class="c2-doc-bar-actions">
                ${editing
                  ? html`
                    <button class="c2-mini" onClick=${() => (c2.docPreview.value = !c2.docPreview.value)}>${c2.docPreview.value ? 'hide preview' : 'preview'}</button>
                    <button class="c2-mini" onClick=${async () => { try { await saveDoc(path, c2.docDraft.value); c2.docDirty.value = false; store.docContent.value = c2.docDraft.value; loadDocs(); } catch {} }}>save ⌘S</button>
                    <button class="c2-mini" onClick=${() => { c2.docEditing.value = false; c2.docDirty.value = false; c2.docDraft.value = content || ''; }}>done</button>`
                  : html`<button class="c2-mini" onClick=${startEdit}>edit</button>`}
              </span>
            </div>
            ${content == null ? html`<div class="c2-map-empty">Loading…</div>`
              : editing ? html`<${Editor} path=${path} />` : html`<${Reader} path=${path} content=${content} />`}
          `}
      </section>
    </div>`;
}
