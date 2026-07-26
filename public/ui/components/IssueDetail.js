// IssueDetail.js — right pane: full issue view with derived relationships,
// inline edit tools and live comments.
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import {
  store, byId, PRI_LABEL, parentOf, blockersOf, openBlockersOf, childrenOf, blocksList,
  effStatus, isReady, selectIssue, editIssue, addComment,
  LINK_TYPES, relatedOf, linkSectionsOf, retiredState,
  supersedeIssue, markDuplicate, isContainer,
} from '../store.js';
import { PriBadge, StatusBadge, statusText, timeAgo } from './common.js';

function Section(title, body) {
  return html`<section class="detail-section"><h3>${title}</h3>${body}</section>`;
}

function RelRow(id) {
  const i = byId.value.get(id);
  if (!i) return html`<button class="rel-item" disabled><span class="it-id">${id}</span><span class="muted">(unknown)</span></button>`;
  return html`
    <button class="rel-item" onClick=${() => selectIssue(id)}>
      <span class=${'badge st st-' + effStatus(i)}>${statusText(effStatus(i))}</span>
      <span class="rel-title">${i.title}</span>
      <span class="it-id">${i.id}</span>
    </button>`;
}

function EditTools({ issue }) {
  const id = issue.id;
  const [err, setErr] = useState('');
  const [priority, setPriority] = useState(String(issue.priority));
  const [labelAdd, setLabelAdd] = useState('');
  const [parent, setParent] = useState(parentOf(issue) || '');
  const [blocker, setBlocker] = useState('');
  const [defer, setDefer] = useState(issue.deferred_until || '');
  const [linkType, setLinkType] = useState('related');
  const [linkId, setLinkId] = useState('');
  const [supersedeId, setSupersedeId] = useState('');
  const [dupeId, setDupeId] = useState('');

  const run = async (payload, msg) => {
    setErr('');
    try { await editIssue({ id, ...payload }, msg); }
    catch (e) { setErr(e.message); }
  };
  // Direct store actions (not editIssue) — they own the "…and closed it"
  // toast derived from the server's `effect`.
  const runAct = async (fn) => {
    setErr('');
    try { await fn(); }
    catch (e) { setErr(e.message); }
  };
  const blockers = blockersOf(issue);
  const outLinks = (issue.dependencies || [])
    .filter((d) => d.type !== 'blocks' && d.type !== 'parent-child')
    .map((d) => ({ other: d.depends_on_id, type: d.type }));

  return html`
    <div class="edit-tools">
      <div class="edit-row btn-row">
        ${issue.status !== 'closed' && html`<button class="btn" onClick=${() => run({ op: 'claim' }, 'Claimed ' + id)}>Claim</button>`}
        ${issue.status !== 'in_progress' && html`<button class="btn" onClick=${() => run({ op: 'set-status', status: 'in_progress' }, 'Marked ' + id + ' in progress')}>In progress</button>`}
        ${issue.status !== 'closed'
          ? html`<button class="btn" onClick=${() => run({ op: 'set-status', status: 'closed', reason: prompt('Close reason (optional):', '') || '' }, 'Closed ' + id)}>Close</button>`
          : html`<button class="btn" onClick=${() => run({ op: 'set-status', status: 'open', reason: prompt('Reopen reason (optional):', '') || '' }, 'Reopened ' + id)}>Reopen</button>`}
      </div>

      <div class="edit-block">
        <label class="edit-label">Priority</label>
        <div class="edit-row">
          <select class="edit-input" value=${priority} onChange=${(e) => setPriority(e.target.value)}>
            ${[0, 1, 2, 3, 4].map((p) => html`<option key=${p} value=${p}>${PRI_LABEL[p]}</option>`)}
          </select>
          <button class="btn" onClick=${() => run({ op: 'set-priority', priority }, 'Updated priority for ' + id)}>Apply</button>
        </div>
      </div>

      <div class="edit-block">
        <label class="edit-label">Labels</label>
        <div class="edit-chiprow">
          ${(issue.labels || []).map((l) => html`<button key=${l} class="chip removable" title="Remove label" onClick=${() => run({ op: 'remove-label', label: l }, 'Removed label from ' + id)}>${l} <span class="chip-x">×</span></button>`)}
        </div>
        <div class="edit-row">
          <input class="edit-input" placeholder="new-label" value=${labelAdd} onInput=${(e) => setLabelAdd(e.target.value)} />
          <button class="btn" onClick=${() => { if (labelAdd.trim()) run({ op: 'add-label', label: labelAdd.trim() }, 'Added label to ' + id).then(() => setLabelAdd('')); }}>Add</button>
        </div>
      </div>

      <div class="edit-block">
        <label class="edit-label">Parent</label>
        <div class="edit-row">
          <input class="edit-input" placeholder="issue-id" value=${parent} onInput=${(e) => setParent(e.target.value)} />
          <button class="btn" onClick=${() => run({ op: 'set-parent', parent: parent.trim() }, 'Updated parent for ' + id)}>Save</button>
          <button class="btn btn-ghost" onClick=${() => { setParent(''); run({ op: 'set-parent', parent: '' }, 'Cleared parent for ' + id); }}>Clear</button>
        </div>
      </div>

      <div class="edit-block">
        <label class="edit-label">Blocked by</label>
        <div class="edit-chiprow">
          ${blockers.map((b) => html`<button key=${b} class="chip removable" title="Remove blocker" onClick=${() => run({ op: 'remove-blocker', blocker: b }, 'Removed blocker from ' + id)}>${b} <span class="chip-x">×</span></button>`)}
        </div>
        <div class="edit-row">
          <input class="edit-input" placeholder="issue-id" value=${blocker} onInput=${(e) => setBlocker(e.target.value)} />
          <button class="btn" onClick=${() => { if (blocker.trim()) run({ op: 'add-blocker', blocker: blocker.trim() }, 'Added blocker to ' + id).then(() => setBlocker('')); }}>Add</button>
        </div>
      </div>

      <div class="edit-block">
        <label class="edit-label">Link</label>
        ${outLinks.length > 0 && html`<div class="edit-chiprow">
          ${outLinks.map((l) => html`<button key=${l.type + ':' + l.other} class="chip removable" title=${'Remove ' + l.type + ' link'} onClick=${() => run({ op: 'remove-link', other: l.other, type: l.type }, 'Removed ' + l.type + ' link from ' + id)}>${l.type} · ${l.other} <span class="chip-x">×</span></button>`)}
        </div>`}
        <div class="edit-row">
          <select class="edit-input link-type" value=${linkType} onChange=${(e) => setLinkType(e.target.value)} aria-label="Link type">
            ${LINK_TYPES.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}
          </select>
          <input class="edit-input" placeholder="issue-id" value=${linkId} onInput=${(e) => setLinkId(e.target.value)} />
          <button class="btn" disabled=${!linkId.trim()} onClick=${() => { if (linkId.trim()) run({ op: 'add-link', other: linkId.trim(), type: linkType }, 'Linked ' + id + ' → ' + linkId.trim() + ' (' + linkType + ')').then(() => setLinkId('')); }}>Link</button>
        </div>
      </div>

      <div class="edit-block">
        <label class="edit-label">Retire this issue</label>
        <p class="edit-hint">Supersede and duplicate are state transitions, not links — bd closes ${id} immediately.</p>
        <div class="edit-row">
          <input class="edit-input" placeholder="replacement id" value=${supersedeId} onInput=${(e) => setSupersedeId(e.target.value)} />
          <button class="btn btn-danger" disabled=${!supersedeId.trim()} title=${'bd supersede ' + id + ' --with … — closes ' + id}
            onClick=${() => runAct(() => supersedeIssue(id, supersedeId.trim()).then(() => setSupersedeId('')))}>Supersede → closes ${id}</button>
        </div>
        <div class="edit-row">
          <input class="edit-input" placeholder="canonical id" value=${dupeId} onInput=${(e) => setDupeId(e.target.value)} />
          <button class="btn btn-danger" disabled=${!dupeId.trim()} title=${'bd duplicate ' + id + ' --of … — closes ' + id}
            onClick=${() => runAct(() => markDuplicate(id, dupeId.trim()).then(() => setDupeId('')))}>Duplicate → closes ${id}</button>
        </div>
      </div>

      <div class="edit-block">
        <label class="edit-label">Defer until</label>
        <div class="edit-row">
          <input class="edit-input" placeholder="+1d or 2026-06-20" value=${defer} onInput=${(e) => setDefer(e.target.value)} />
          <button class="btn" onClick=${() => run({ op: 'set-defer', defer: defer.trim() }, 'Updated defer for ' + id)}>Save</button>
          <button class="btn btn-ghost" onClick=${() => { setDefer(''); run({ op: 'set-defer', defer: '' }, 'Cleared defer for ' + id); }}>Clear</button>
        </div>
      </div>
      ${err && html`<div class="form-err">${err}</div>`}
    </div>`;
}

function Comments({ id }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const comments = store.comments.value;
  const loading = store.commentsLoading.value;

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try { await addComment(id, text.trim()); setText(''); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return html`
    <div class="comments">
      ${loading
        ? html`<div class="comments-empty">loading…</div>`
        : comments.length === 0
          ? html`<div class="comments-empty">No comments yet.</div>`
          : comments.map((c, n) => html`
              <div key=${n} class="comment">
                <div class="comment-meta"><span class="author">${c.author || 'someone'}</span><span>${timeAgo(c.created_at)}</span></div>
                <div class="comment-text">${c.text}</div>
              </div>`)}
    </div>
    <div class="comment-add">
      <textarea
        id="comment-input"
        placeholder="Add a comment…  (⌘/Ctrl+Enter to send)"
        value=${text}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
      ></textarea>
      <div class="row">
        ${err && html`<span class="form-err">${err}</span>`}
        <button class="btn btn-accent" disabled=${busy} onClick=${submit}>Comment</button>
      </div>
    </div>`;
}

export function IssueDetail() {
  const id = store.selectedId.value;
  const issue = id ? byId.value.get(id) : null;
  if (!issue) {
    return html`<section class="detail-pane"><div class="pane-empty muted">
      <div class="empty-icon">◦</div>Select an issue to see details.
    </div></section>`;
  }

  const parent = parentOf(issue);
  const blockers = blockersOf(issue);
  const openBlockers = openBlockersOf(issue);
  const children = childrenOf(id);
  const blocks = blocksList(id);
  const related = relatedOf(issue);
  const sections = linkSectionsOf(issue);
  const retired = retiredState(issue);

  return html`
    <section class="detail-pane" key=${id}>
      <div class="detail-inner">
        <div class="detail-head">
          <div class="detail-meta">${PriBadge(issue.priority)}${StatusBadge(issue)}<span class="badge type-tag">${issue.issue_type}</span><span class="it-id">${issue.id}</span></div>
          <h2>${issue.title}</h2>
          ${(issue.labels || []).length > 0 && html`<div class="detail-meta">${(issue.labels || []).map((l) => html`<span key=${l} class="lbl">${l}</span>`)}</div>`}
        </div>

        ${/* Banner precedence (docs/beads-coverage.md Phase 1): a retired
              state — superseded by / duplicate of — OUTRANKS blocked/ready. */ ''}
        ${retired
          ? html`<div class=${'banner banner-retired banner-' + retired.kind}>
              <span>${retired.kind === 'duplicate' ? '⧉' : '↷'} ${retired.label}</span>
              <button class="banner-link" onClick=${() => selectIssue(retired.other)}>${retired.other}</button>
            </div>`
          : issue.status !== 'closed' && openBlockers.length > 0
            ? html`<div class="banner banner-blocked">⛔ Blocked by ${openBlockers.length} open ${openBlockers.length === 1 ? 'issue' : 'issues'}</div>`
            : isReady(issue) && !isContainer(issue)
              ? html`<div class="banner banner-ready">✓ Ready to work — no open blockers</div>`
              : null}

        ${issue.description && Section('Description', html`<div class="field-text">${issue.description}</div>`)}
        ${issue.status === 'closed' && issue.close_reason && Section('Close reason', html`<div class="field-text close-reason">${issue.close_reason}</div>`)}
        ${issue.design && Section('Design', html`<div class="field-text">${issue.design}</div>`)}
        ${issue.notes && Section('Notes', html`<div class="field-text">${issue.notes}</div>`)}
        ${issue.acceptance_criteria && Section('Acceptance', html`<div class="field-text">${issue.acceptance_criteria}</div>`)}

        ${parent && Section('Parent', html`<div class="rel">${RelRow(parent)}</div>`)}
        ${blockers.length > 0 && Section('Blocked by (' + blockers.length + ')', html`<div class="rel">${blockers.map((b) => RelRow(b))}</div>`)}
        ${blocks.length > 0 && Section('Blocks (' + blocks.length + ')', html`<div class="rel">${blocks.map((b) => RelRow(b.id))}</div>`)}
        ${children.length > 0 && Section('Children (' + children.length + ')', html`<div class="rel">${children.map((c) => RelRow(c.id))}</div>`)}
        ${/* Bidirectional: rendered once whichever side created the row. */ ''}
        ${related.length > 0 && Section('Related (' + related.length + ')', html`<div class="rel">${related.map((r) => RelRow(r))}</div>`)}
        ${/* One section per link type that actually has members, both
              directions — so the panel doesn't bloat with empty headings. */ ''}
        ${sections.map((s) => html`<div key=${s.key}>${Section(s.label + ' (' + s.ids.length + ')', html`<div class="rel">${s.ids.map((x) => RelRow(x))}</div>`)}</div>`)}

        ${Section('Edit', html`<${EditTools} issue=${issue} />`)}
        ${Section('Comments', html`<${Comments} id=${id} />`)}
        ${Section('Details', html`<div class="kv">
          <span class="k">Assignee</span><span class="v">${issue.assignee || '—'}</span>
          <span class="k">Created</span><span class="v">${new Date(issue.created_at).toLocaleString()}</span>
          <span class="k">Updated</span><span class="v">${new Date(issue.updated_at).toLocaleString()}</span>
          ${issue.closed_at ? html`<span class="k">Closed</span><span class="v">${new Date(issue.closed_at).toLocaleString()}</span>` : ''}
        </div>`)}
      </div>
    </section>`;
}
