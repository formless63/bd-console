// console2/Omnibar.js — the centerpiece command input. Three auto-detected
// intent modes: (1) plain text → capture a triage bead on Enter; (2) `>`/`/`
// prefix → command palette over bd verbs; (3) fuzzy match → jump to an issue.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, selectIssue } from '../store.js';
import { c2 } from './state.js';
import {
  captureTriage, actClaim, actStart, actClose, actDefer, actPriority,
} from './actions.js';
import { TypeGlyph, Pip, StatusGlyph } from './ui.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.\d+)*$/;

// View + action commands. `arity` = required positional args beyond the verb.
function buildCommands() {
  const setMode = (m) => { c2.canvasMode.value = m; };
  const focus = (lane) => { c2.canvasMode.value = 'flow'; c2.laneFocus.value = lane; };
  return [
    { name: 'ready', hint: 'show ready work', kind: 'view', run: () => focus('ready') },
    { name: 'blocked', hint: 'show blocked issues', kind: 'view', run: () => focus('blocked') },
    { name: 'triage', hint: 'show the triage inbox', kind: 'view', run: () => focus('triage') },
    { name: 'stale', hint: 'highlight stale issues', kind: 'view', run: () => focus('stale') },
    { name: 'progress', hint: 'show in-progress', kind: 'view', run: () => focus('in_progress') },
    { name: 'flow', hint: 'flow lanes', kind: 'view', run: () => { c2.laneFocus.value = null; setMode('flow'); } },
    { name: 'map', hint: 'dependency map', kind: 'view', run: () => setMode('map') },
    { name: 'docs', hint: 'docs + promote', kind: 'view', run: () => setMode('docs') },
    { name: 'stats', hint: 'focus the pulse rail', kind: 'view', run: () => { c2.laneFocus.value = null; document.querySelector('.c2-pulse')?.scrollIntoView({ behavior: 'smooth' }); } },
    { name: 'claim', arg: '<id>', arity: 1, hint: 'claim an issue', kind: 'action', run: (a) => actClaim(a[0]) },
    { name: 'start', arg: '<id>', arity: 1, hint: 'mark in progress', kind: 'action', run: (a) => actStart(a[0]) },
    { name: 'close', arg: '<id> [reason]', arity: 1, hint: 'close an issue', kind: 'action', run: (a) => actClose(a[0], a.slice(1).join(' ')) },
    { name: 'defer', arg: '<id> <when>', arity: 2, hint: 'defer until', kind: 'action', run: (a) => actDefer(a[0], a.slice(1).join(' ')) },
    { name: 'prio', arg: '<id> <0-4>', arity: 2, hint: 'set priority', kind: 'action', run: (a) => actPriority(a[0], a[1]) },
    { name: 'open', arg: '<id>', arity: 1, hint: 'open detail', kind: 'action', run: (a) => selectIssue(a[0]) },
  ];
}
const COMMANDS = buildCommands();

function scoreIssue(issue, q) {
  const id = issue.id.toLowerCase(), t = (issue.title || '').toLowerCase();
  if (id === q) return 100;
  if (id.startsWith(q)) return 80;
  if (id.includes(q)) return 60;
  if (t.startsWith(q)) return 50;
  if (t.includes(q)) return 30;
  // subsequence match on title
  let qi = 0; for (const ch of t) { if (ch === q[qi]) qi++; if (qi === q.length) return 15; }
  return 0;
}

function buildItems(raw) {
  const isCmd = /^[>/]/.test(raw);
  if (isCmd) {
    const body = raw.replace(/^[>/]\s?/, '');
    const [verb = '', ...rest] = body.trim().split(/\s+/).filter(Boolean);
    const matches = COMMANDS
      .filter((c) => !verb || c.name.startsWith(verb) || c.name.includes(verb))
      .map((c) => ({ type: 'cmd', cmd: c, rest }));
    return { mode: 'cmd', items: matches, verb, rest };
  }
  const q = raw.trim().toLowerCase();
  if (!q) {
    // Empty-but-focused IS the palette: `/` or Ctrl-K should land the user in
    // a browsable command list immediately, not an empty box that needs a
    // second `/` typed into it before anything appears.
    return { mode: 'cmd', items: COMMANDS.map((c) => ({ type: 'cmd', cmd: c, rest: [] })), verb: '', rest: [] };
  }
  const jumps = store.issues.value
    .map((i) => ({ i, s: scoreIssue(i, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i.priority - b.i.priority)
    .slice(0, 6)
    .map((x) => ({ type: 'jump', issue: x.i }));
  return { mode: 'capture', items: [{ type: 'capture', title: raw.trim() }, ...jumps] };
}

export function Omnibar() {
  const inputRef = useRef(null);
  const [sel, setSel] = useState(0);
  const raw = c2.omniValue.value;
  const { mode, items, verb, rest } = buildItems(raw);
  const open = c2.omniOpen.value && (items.length > 0 || mode === 'capture');

  // focus hotkeys: `/` (when not typing) and Ctrl/Cmd-K
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
        || document.activeElement?.isContentEditable;
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); focusOmni();
      } else if (e.key === '/' && !typing) {
        e.preventDefault(); focusOmni();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const focusOmni = () => { inputRef.current?.focus(); inputRef.current?.select(); c2.omniOpen.value = true; };

  useEffect(() => { setSel(mode === 'capture' ? 0 : 0); }, [raw, mode]);

  const run = async (item) => {
    if (!item) {
      // Enter with no item in command/empty mode → nothing
      return;
    }
    if (item.type === 'capture') {
      const title = item.title;
      try {
        await captureTriage(title);
        c2.omniValue.value = '';
        store.selectedId.value = null; // stay in capture flow, don't pop detail
        setTimeout(() => inputRef.current?.focus(), 0);
      } catch { /* toasted upstream */ }
      return;
    }
    if (item.type === 'jump') {
      selectIssue(item.issue.id);
      c2.omniValue.value = '';
      c2.omniOpen.value = false;
      inputRef.current?.blur();
      return;
    }
    if (item.type === 'cmd') {
      const { cmd, rest: args } = item;
      const need = cmd.arity || 0;
      if (need > 0 && args.length < need) {
        // autocomplete the verb, wait for args
        c2.omniValue.value = '>' + cmd.name + ' ';
        setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
      if (cmd.kind === 'action' && !ID_RE.test(args[0] || '')) {
        store.toasts.value = [...store.toasts.value, { id: Date.now(), message: 'Not a valid issue id: ' + (args[0] || ''), kind: 'err' }];
        return;
      }
      try { await cmd.run(args); } catch { /* toasted */ }
      c2.omniValue.value = '';
      c2.omniOpen.value = false;
      return;
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { c2.omniOpen.value = false; inputRef.current?.blur(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      run(items[sel] || (mode === 'capture' ? items[0] : null));
    }
  };

  const modeTag = mode === 'cmd' ? 'COMMAND' : mode === 'capture' ? 'CAPTURE' : 'READY';

  return html`
    <div class=${'c2-omni' + (open ? ' open' : '')}>
      <div class="c2-omni-field">
        <span class="c2-omni-glyph" aria-hidden="true">⌘</span>
        <input
          ref=${inputRef}
          class="c2-omni-input issue-search"
          type="text"
          placeholder="Capture a thought, > for commands, or search issues…   ( / or ⌘K )"
          value=${raw}
          spellcheck="false"
          autocomplete="off"
          onInput=${(e) => { c2.omniValue.value = e.target.value; c2.omniOpen.value = true; }}
          onFocus=${() => { c2.omniOpen.value = true; }}
          onKeyDown=${onKeyDown}
        />
        <span class=${'c2-omni-mode mode-' + mode}>${modeTag}</span>
      </div>
      ${open && html`
        <div class="c2-omni-drop" role="listbox">
          ${mode === 'cmd' && items.length === 0 && html`<div class="c2-omni-empty">No command matches “${verb}”.</div>`}
          ${items.map((item, n) => {
            const active = n === sel;
            if (item.type === 'capture') {
              return html`<button key="cap" role="option" class=${'c2-omni-row cap' + (active ? ' active' : '')} onMouseEnter=${() => setSel(n)} onClick=${() => run(item)}>
                <span class="c2-omni-verb">⏎ capture</span>
                <span class="c2-omni-desc">“${item.title}” → new triage bead</span>
              </button>`;
            }
            if (item.type === 'jump') {
              return html`<button key=${item.issue.id} role="option" class=${'c2-omni-row jump' + (active ? ' active' : '')} onMouseEnter=${() => setSel(n)} onClick=${() => run(item)}>
                ${StatusGlyph(item.issue)}
                ${TypeGlyph(item.issue.issue_type)}
                <span class="c2-omni-desc">${item.issue.title}</span>
                <span class="c2-omni-id">${item.issue.id}</span>
                ${Pip(item.issue.priority)}
              </button>`;
            }
            const c = item.cmd;
            return html`<button key=${c.name} role="option" class=${'c2-omni-row cmd' + (active ? ' active' : '')} onMouseEnter=${() => setSel(n)} onClick=${() => run(item)}>
              <span class="c2-omni-verb">${c.name}${c.arg ? html` <span class="c2-omni-arg">${c.arg}</span>` : ''}</span>
              <span class="c2-omni-desc">${c.hint}</span>
              <span class=${'c2-omni-kind k-' + c.kind}>${c.kind}</span>
            </button>`;
          })}
        </div>`}
    </div>`;
}
