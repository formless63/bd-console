// console2/Detail.js — the right slide-over. Full rendered issue, clickable
// relationship chips, comments timeline + composer, the complete inline edit
// set, and DELEGATE (prefilled compose → live tmux session picker → Send now /
// Schedule). Every mutation echoes its bd / tmux equivalent via flashCli.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import {
  store, byId, parentOf, blockersOf, openBlockersOf, childrenOf, blocksList,
  effStatus, isReady, selectIssue, addComment, loadTmux,
} from '../store.js';
import { renderMarkdown } from '../markdown.js';
import {
  actClaim, actStart, actClose, actReopen, actPriority, actDefer,
  actAddLabel, actRemoveLabel, actSetParent, actAddBlocker, actRemoveBlocker,
  delegateNow, delegateSchedule,
} from './actions.js';
import { TypeGlyph, Pip, PRI_LABEL } from './ui.js';

function timeAgo(s) {
  if (!s) return '';
  const m = Math.round((Date.now() - new Date(s)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  return new Date(s).toLocaleDateString();
}

function RelChip(id) {
  const i = byId.value.get(id);
  if (!i) return html`<button class="c2-rel unknown" disabled>${id}</button>`;
  return html`<button class=${'c2-rel st-' + effStatus(i)} onClick=${() => selectIssue(id)} title=${i.title}>
    ${TypeGlyph(i.issue_type)}<span class="c2-rel-id">${id}</span><span class="c2-rel-t">${i.title}</span>
  </button>`;
}

function Field(title, body) {
  return html`<div class="c2-field"><span class="c2-hud-label">${title}</span>${body}</div>`;
}

function Edit({ issue }) {
  const id = issue.id;
  const [label, setLabel] = useState('');
  const [parent, setParent] = useState(parentOf(issue) || '');
  const [blk, setBlk] = useState('');
  const [defer, setDefer] = useState(issue.deferred_until || '');
  const run = (fn) => () => { fn().catch(() => {}); };

  return html`
    <div class="c2-edit">
      <div class="c2-edit-row">
        ${issue.status !== 'in_progress' && html`<button class="c2-mini" onClick=${run(() => actClaim(id))}>claim</button>`}
        ${issue.status !== 'in_progress' && html`<button class="c2-mini" onClick=${run(() => actStart(id))}>start</button>`}
        ${issue.status !== 'closed'
          ? html`<button class="c2-mini" onClick=${run(() => actClose(id, prompt('Close reason (optional):', '') || ''))}>close</button>`
          : html`<button class="c2-mini" onClick=${run(() => actReopen(id, prompt('Reopen reason (optional):', '') || ''))}>reopen</button>`}
      </div>

      <div class="c2-edit-row">
        <span class="c2-edit-k">Priority</span>
        ${[0, 1, 2, 3, 4].map((p) => html`<button key=${p} class=${'c2-mini' + (issue.priority === p ? ' on' : '')} onClick=${run(() => actPriority(id, p))}>${PRI_LABEL[p]}</button>`)}
      </div>

      <div class="c2-edit-row wrap">
        <span class="c2-edit-k">Labels</span>
        ${(issue.labels || []).map((l) => html`<button key=${l} class="c2-chip removable" title="Remove" onClick=${run(() => actRemoveLabel(id, l))}>${l} ✕</button>`)}
        <input class="c2-edit-input" placeholder="add-label" value=${label} onInput=${(e) => setLabel(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && label.trim()) run(() => actAddLabel(id, label.trim()).then(() => setLabel('')))(); }} />
      </div>

      <div class="c2-edit-row">
        <span class="c2-edit-k">Parent</span>
        <input class="c2-edit-input" placeholder="issue-id" value=${parent} onInput=${(e) => setParent(e.target.value)} />
        <button class="c2-mini" onClick=${run(() => actSetParent(id, parent.trim()))}>set</button>
        <button class="c2-mini" onClick=${run(() => { setParent(''); return actSetParent(id, ''); })}>clear</button>
      </div>

      <div class="c2-edit-row wrap">
        <span class="c2-edit-k">Blocked by</span>
        ${blockersOf(issue).map((b) => html`<button key=${b} class="c2-chip removable" onClick=${run(() => actRemoveBlocker(id, b))}>${b} ✕</button>`)}
        <input class="c2-edit-input" placeholder="issue-id" value=${blk} onInput=${(e) => setBlk(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && blk.trim()) run(() => actAddBlocker(id, blk.trim()).then(() => setBlk('')))(); }} />
      </div>

      <div class="c2-edit-row">
        <span class="c2-edit-k">Defer</span>
        <input class="c2-edit-input" placeholder="+2d or 2026-08-01" value=${defer} onInput=${(e) => setDefer(e.target.value)} />
        <button class="c2-mini" onClick=${run(() => actDefer(id, defer.trim()))}>set</button>
        <button class="c2-mini" onClick=${run(() => { setDefer(''); return actDefer(id, ''); })}>clear</button>
      </div>
    </div>`;
}

function Comments({ id }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const comments = store.comments.value;
  const loading = store.commentsLoading.value;
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await addComment(id, text.trim()); setText(''); } catch {} finally { setBusy(false); }
  };
  return html`
    <div class="c2-comments">
      ${loading ? html`<div class="c2-lane-empty">loading…</div>`
        : comments.length === 0 ? html`<div class="c2-lane-empty">No comments yet.</div>`
          : comments.map((c, n) => html`
            <div key=${n} class="c2-comment">
              <div class="c2-comment-meta"><b>${c.author || 'someone'}</b><span>${timeAgo(c.created_at)}</span></div>
              <div class="c2-comment-text">${c.text}</div>
            </div>`)}
      <div class="c2-comment-add">
        <textarea placeholder="Add a comment…  (⌘/Ctrl+Enter)" value=${text}
          onInput=${(e) => setText(e.target.value)}
          onKeyDown=${(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}></textarea>
        <button class="c2-mini accent" disabled=${busy} onClick=${submit}>comment</button>
      </div>
    </div>`;
}

function Delegate({ issue }) {
  const id = issue.id;
  const [text, setText] = useState('');
  const [session, setSession] = useState('');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const sessions = store.tmuxSessions.value;
  const available = store.tmuxAvailable.value;

  useEffect(() => {
    loadTmux();
    setText(`Work on ${id}: ${issue.title}\n\nRun \`bd show ${id}\` for full context.`);
  }, [id]);
  // Deliberately NOT auto-selecting a session: the picker lists real host
  // sessions, so defaulting to one risks an accidental Send to a live agent.
  // The user must consciously choose a target; Send now stays disabled until then.

  const sendNow = async () => { setBusy(true); try { await delegateNow(session, text); } catch {} finally { setBusy(false); } };
  const schedule = async () => {
    if (!when) return;
    const runAt = new Date(when).getTime();
    if (!Number.isFinite(runAt)) return;
    setBusy(true); try { await delegateSchedule(session, text, runAt); } catch {} finally { setBusy(false); }
  };

  return html`
    <div class="c2-delegate">
      ${!available ? html`<div class="c2-lane-empty">tmux unavailable on this host.</div>`
        : sessions.length === 0 ? html`<div class="c2-lane-empty">No tmux sessions running.</div>`
          : html`
            <textarea class="c2-delegate-text" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
            <div class="c2-edit-row">
              <span class="c2-edit-k">Session</span>
              <select class="c2-edit-input" value=${session} onChange=${(e) => setSession(e.target.value)}>
                <option value="">Select a session…</option>
                ${sessions.map((s) => html`<option key=${s.name} value=${s.name}>${s.name}${s.attached ? ' (attached)' : ''}</option>`)}
              </select>
              <button class="c2-mini accent" disabled=${busy || !session} onClick=${sendNow}>Send now</button>
            </div>
            <div class="c2-edit-row">
              <span class="c2-edit-k">Schedule</span>
              <input class="c2-edit-input" type="datetime-local" value=${when} onInput=${(e) => setWhen(e.target.value)} />
              <button class="c2-mini" disabled=${busy || !session || !when} onClick=${schedule}>Schedule…</button>
            </div>
            <div class="c2-cli-hint">$ tmux send-keys -t ${session || '<session>'} … Enter</div>`}
    </div>`;
}

export function Detail() {
  const id = store.selectedId.value;
  const issue = id ? byId.value.get(id) : null;
  const open = !!issue;

  return html`
    <div class=${'c2-detail' + (open ? ' open' : '')} role="dialog" aria-hidden=${!open}>
      ${open && html`
        <div class="c2-detail-inner" key=${id}>
          <div class="c2-detail-head">
            <div class="c2-detail-badges">${TypeGlyph(issue.issue_type)} ${Pip(issue.priority)}
              <span class=${'c2-detail-status st-' + effStatus(issue)}>${effStatus(issue).replace('_', ' ')}</span>
              <span class="c2-rel-id">${issue.id}</span>
            </div>
            <button class="c2-detail-close" title="Close" onClick=${() => selectIssue(null)}>✕</button>
          </div>
          <h2 class="c2-detail-title">${issue.title}</h2>
          ${(issue.labels || []).length > 0 && html`<div class="c2-detail-labels">${(issue.labels || []).map((l) => html`<span key=${l} class=${'c2-chip' + (l === 'triage' ? ' triage' : '')}>${l}</span>`)}</div>`}

          ${issue.status !== 'closed' && openBlockersOf(issue).length > 0
            ? html`<div class="c2-banner blocked">⛔ Blocked by ${openBlockersOf(issue).length} open ${openBlockersOf(issue).length === 1 ? 'issue' : 'issues'}</div>`
            : isReady(issue) && issue.issue_type !== 'epic' ? html`<div class="c2-banner ready">✓ Ready — no open blockers</div>` : null}

          ${issue.description && Field('Description', html`<div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(issue.description) }}></div>`)}
          ${issue.status === 'closed' && issue.close_reason && Field('Close reason', html`<div class="c2-md">${issue.close_reason}</div>`)}
          ${issue.design && Field('Design', html`<div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(issue.design) }}></div>`)}
          ${issue.notes && Field('Notes', html`<div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(issue.notes) }}></div>`)}
          ${issue.acceptance_criteria && Field('Acceptance', html`<div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(issue.acceptance_criteria) }}></div>`)}

          ${(() => { const p = parentOf(issue); return p ? Field('Parent', RelChip(p)) : null; })()}
          ${(() => { const b = blockersOf(issue); return b.length ? Field('Blocked by', html`<div class="c2-rels">${b.map(RelChip)}</div>`) : null; })()}
          ${(() => { const b = blocksList(id); return b.length ? Field('Blocks', html`<div class="c2-rels">${b.map((x) => RelChip(x.id))}</div>`) : null; })()}
          ${(() => { const c = childrenOf(id); return c.length ? Field('Children', html`<div class="c2-rels">${c.map((x) => RelChip(x.id))}</div>`) : null; })()}

          ${Field('Edit', html`<${Edit} issue=${issue} />`)}
          ${Field('Delegate', html`<${Delegate} issue=${issue} />`)}
          ${Field('Comments', html`<${Comments} id=${id} />`)}
          ${Field('Meta', html`<div class="c2-meta">
            <span>Assignee</span><span>${issue.assignee || '—'}</span>
            <span>Created</span><span>${new Date(issue.created_at).toLocaleString()}</span>
            <span>Updated</span><span>${new Date(issue.updated_at).toLocaleString()}</span>
            ${issue.closed_at ? html`<span>Closed</span><span>${new Date(issue.closed_at).toLocaleString()}</span>` : ''}
          </div>`)}
        </div>`}
    </div>`;
}
