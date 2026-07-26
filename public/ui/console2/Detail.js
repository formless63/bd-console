// console2/Detail.js — the right slide-over. Full rendered issue, clickable
// relationship chips, comments timeline + composer, the complete inline edit
// set, and DELEGATE (prefilled compose → live tmux session picker → Send now /
// Schedule). Every mutation echoes its bd / tmux equivalent via flashCli.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import {
  store, byId, parentOf, blockersOf, openBlockersOf, childrenOf, blocksList,
  effStatus, isReady, selectIssue, addComment, loadTmux,
  LINK_TYPES, relatedOf, linkSectionsOf, retiredState,
  addLink, removeLink, supersedeIssue, markDuplicate,
  isContainer, isMolecule, moleculeRootFor, moleculeRollupFor,
} from '../store.js';
import { burnIssueCount } from '../formulas.js';
import {
  molDetail, loadMoleculeDetail, requestBurnPreview, cancelBurn, confirmBurn,
} from './molecules.js';
import { renderMarkdown } from '../markdown.js';
import {
  actClaim, actStart, actClose, actReopen, actPriority, actDefer,
  actAddLabel, actRemoveLabel, actSetParent, actAddBlocker, actRemoveBlocker,
  delegateNow, delegateSchedule,
} from './actions.js';
import { TypeGlyph, Pip, PRI_LABEL, StatusGlyph, glyphStatus } from './ui.js';
import { c2, flashCli } from './state.js';

// Link/supersede/duplicate writes live in store.js (shared with the classic
// view) rather than actions.js; wrap them here so Console 2.0 still flashes
// the bd equivalent — and only ever AFTER the write resolved, matching
// actions.js's contract.
const actAddLink = async (id, other, type) => {
  await addLink(id, other, type);
  flashCli(`bd dep add ${id} ${other} --type ${type}`, 'link');
};
const actRemoveLink = async (id, other) => {
  await removeLink(id, other);
  flashCli(`bd dep remove ${id} ${other}`, 'link');
};
const actSupersede = async (id, replacement) => {
  await supersedeIssue(id, replacement);
  flashCli(`bd supersede ${id} --with ${replacement}`, 'supersede');
};
const actDuplicate = async (id, canonical) => {
  await markDuplicate(id, canonical);
  flashCli(`bd duplicate ${id} --of ${canonical}`, 'duplicate');
};

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
  return html`<button class=${'c2-rel st-' + glyphStatus(i)} onClick=${() => selectIssue(id)} title=${i.title}>
    ${StatusGlyph(i)}${TypeGlyph(i.issue_type)}<span class="c2-rel-id">${id}</span><span class="c2-rel-t">${i.title}</span>
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
  const [linkType, setLinkType] = useState('related');
  const [linkId, setLinkId] = useState('');
  const [supersedeId, setSupersedeId] = useState('');
  const [dupeId, setDupeId] = useState('');
  const run = (fn) => () => { fn().catch(() => {}); };
  // Every non-blocking outbound row, so any link created here can also be
  // removed here (bd stores at most one row per issue pair, so the target id
  // alone identifies the edge to `bd dep remove`).
  const outLinks = (issue.dependencies || [])
    .filter((d) => d.type !== 'blocks' && d.type !== 'parent-child')
    .map((d) => ({ other: d.depends_on_id, type: d.type }));

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

      <div class="c2-edit-row wrap">
        <span class="c2-edit-k">Link</span>
        <select class="c2-edit-input c2-linktype" value=${linkType} onChange=${(e) => setLinkType(e.target.value)} aria-label="Link type">
          ${LINK_TYPES.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}
        </select>
        <input class="c2-edit-input" placeholder="issue-id" value=${linkId} onInput=${(e) => setLinkId(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && linkId.trim()) run(() => actAddLink(id, linkId.trim(), linkType).then(() => setLinkId('')))(); }} />
        <button class="c2-mini" disabled=${!linkId.trim()} onClick=${run(() => actAddLink(id, linkId.trim(), linkType).then(() => setLinkId('')))}>link</button>
      </div>

      ${outLinks.length > 0 && html`
        <div class="c2-edit-row wrap">
          <span class="c2-edit-k">Links</span>
          ${outLinks.map((l) => html`<button key=${l.type + ':' + l.other} class="c2-chip removable" title=${'Remove ' + l.type + ' link'} onClick=${run(() => actRemoveLink(id, l.other))}>${l.type} · ${l.other} ✕</button>`)}
        </div>`}

      <div class="c2-edit-row wrap">
        <span class="c2-edit-k">Retire</span>
        <input class="c2-edit-input" placeholder="replacement id" value=${supersedeId} onInput=${(e) => setSupersedeId(e.target.value)} />
        <button class="c2-mini danger" disabled=${!supersedeId.trim()} title=${'bd supersede ' + id + ' --with … — closes ' + id}
          onClick=${run(() => actSupersede(id, supersedeId.trim()).then(() => setSupersedeId('')))}>supersede → closes ${id}</button>
      </div>
      <div class="c2-edit-row wrap">
        <span class="c2-edit-k"></span>
        <input class="c2-edit-input" placeholder="canonical id" value=${dupeId} onInput=${(e) => setDupeId(e.target.value)} />
        <button class="c2-mini danger" disabled=${!dupeId.trim()} title=${'bd duplicate ' + id + ' --of … — closes ' + id}
          onClick=${run(() => actDuplicate(id, dupeId.trim()).then(() => setDupeId('')))}>duplicate → closes ${id}</button>
      </div>
      <div class="c2-edit-note">Supersede and duplicate are state transitions, not links: bd closes ${id} immediately.</div>

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

// ---------------------------------------------------------------------------
// Molecule section (docs/molecules-design.md §5.4)
//
// Shown whenever the selected issue IS a molecule root or is a step INSIDE
// one. Everything structural comes from the already-loaded issues list via
// relationships.js — a molecule's steps are ordinary beads carrying the exact
// same `parent-child` row an epic's children carry, so this reuses RelChip and
// the existing relationship machinery rather than inventing a parallel one.
// The live `GET /api/molecules/:id` call only ADDS what the client genuinely
// can't derive: bd's authoritative parallel-group / current-step computation.
// If it fails, the section still renders from local data.
// ---------------------------------------------------------------------------
function MoleculeSteps({ root }) {
  const roll = moleculeRollupFor(root);
  const live = molDetail.data.value;
  const liveOk = live && live.molecule?.root?.id === root.id;
  // Progress numbers come from the LOCAL rollup, not bd's `mol progress`,
  // even when the live call succeeded: the local one is derived from
  // store.issues, so closing a step anywhere in the app updates it
  // immediately, whereas the fetched copy is a snapshot that would sit stale
  // until the next refetch. The two agree by construction (same closed-child
  // count) — this just picks the one that can't lag.
  const done = roll.closed;
  const total = roll.total;
  const pct = roll.percent;
  // The live call is used ONLY for what the client genuinely cannot derive:
  // bd's parallel-group assignment and its DAG-aware ready flags.
  const groups = liveOk && live.parallel ? live.parallel.parallel_groups : null;
  const groupOf = (id) => {
    if (!groups) return null;
    for (const [name, ids] of Object.entries(groups)) if (ids.includes(id)) return name;
    return null;
  };
  const readyIds = new Set(
    liveOk && live.parallel
      ? (live.parallel.steps || []).filter((s) => s.parallel_info?.is_ready).map((s) => s.issue?.id)
      : [],
  );

  return html`
    <div class="c2-mol">
      <div class="c2-mol-progress" data-mol-progress>
        <span class="c2-progress-track">
          ${Array.from({ length: Math.max(total, 1) }).map((_, n) => html`<span key=${n} class=${'c2-progress-cell' + (n < done ? ' on' : '')}></span>`)}
        </span>
        <span class="c2-progress-num">${done}/${total} steps (${pct}%)</span>
      </div>
      ${roll.steps.length === 0
        ? html`<div class="c2-lane-empty">This molecule has no steps.</div>`
        : html`<div class="c2-rels c2-mol-steps" data-mol-steps-list>
            ${roll.steps.map((s) => html`
              <div class="c2-mol-step" key=${s.id}>
                ${RelChip(s.id)}
                ${groupOf(s.id) && html`<span class="c2-chip c2-mol-group" title="Parallel group (bd ready --mol)">${groupOf(s.id)}</span>`}
                ${readyIds.has(s.id) && s.status !== 'closed' && html`<span class="c2-chip c2-mol-ready">ready</span>`}
              </div>`)}
          </div>`}
      ${molDetail.loading.value && html`<div class="c2-mol-note muted">loading live molecule state…</div>`}
      ${molDetail.error.value && html`<div class="c2-mol-note muted">Live molecule state unavailable (${molDetail.error.value}) — showing locally derived steps.</div>`}
    </div>`;
}

// Burn — the undo for a bad pour. Same dry-run → confirm → write shape as the
// pour dialog, and the copy is explicit about burn's real blast radius, which
// is WIDER than "the beads pour created" (verified in a fixture; see
// lib/bd.mjs's burnMolecule).
function BurnBox({ root }) {
  const pending = molDetail.burnPreview.value;
  const count = pending ? burnIssueCount(pending.preview) : null;
  return html`
    <div class="c2-mol-burn">
      ${!pending && html`
        <button class="c2-mini danger" data-mol-burn-btn disabled=${molDetail.burnLoading.value}
          onClick=${() => requestBurnPreview(root.id)}>
          ${molDetail.burnLoading.value ? 'checking…' : 'Burn this molecule…'}
        </button>`}
      ${molDetail.burnError.value && html`<div class="mol-err">${molDetail.burnError.value}</div>`}
      ${pending && html`
        <div class="c2-mol-burnconfirm">
          <div class="mol-warn">
            ⚠ Deletes ${count != null ? html`<b>${count}</b>` : 'every'} issue${count === 1 ? '' : 's'} in this molecule, permanently.
          </div>
          <ul class="c2-mol-burnfacts">
            <li>Everything parented under the root goes — <b>including beads you added by hand</b>, not just the steps the pour created.</li>
            <li>Dependency links from issues <i>outside</i> the molecule are removed; those issues survive but silently lose the edge.</li>
            <li>Nothing is archived. <code>bd mol squash</code> makes digests; <code>burn</code> does not.</li>
            <li>This molecule is persistent, so the deletions sync to remotes.</li>
          </ul>
          <pre class="mol-dry-text" data-mol-burn-dryrun>${pending.preview}</pre>
          <div class="c2-edit-row">
            <button class="c2-mini" disabled=${molDetail.burning.value} onClick=${cancelBurn}>Cancel</button>
            <button class="c2-mini danger" data-mol-burn-confirm disabled=${molDetail.burning.value}
              onClick=${() => confirmBurn(root.id)}>
              ${molDetail.burning.value ? 'burning…' : `Burn ${count != null ? count + ' issues' : 'this molecule'}`}
            </button>
          </div>
        </div>`}
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
  const preset = c2.delegatePreset.value;

  useEffect(() => {
    loadTmux();
    setText(`Work on ${id}: ${issue.title}\n\nRun \`bd show ${id}\` for full context.`);
  }, [id]);
  // Deliberately NOT auto-selecting a session on mount: the picker lists real
  // host sessions, so defaulting to one risks an accidental Send to a live
  // agent. The user must consciously choose a target — EXCEPT when they just
  // tapped a named session's "delegate here" in the pulse rail's Sessions
  // block, which is itself the explicit choice (c2.delegatePreset). Consumed
  // once, same pattern as store.scheduleSessionPreset.
  useEffect(() => {
    if (preset) { setSession(preset); c2.delegatePreset.value = null; }
  }, [preset]);

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
  // The molecule this selection belongs to: itself when it IS a root, its
  // parent when it's a step of one, null otherwise.
  const molRoot = issue ? moleculeRootFor(issue) : null;
  const isStep = !!molRoot && molRoot.id !== issue?.id;

  // Live molecule state is fetched for the ROOT (bd's `mol show` on a step id
  // just echoes the step back as its own root — confirmed — so resolving
  // step→root client-side first is required, not an optimization).
  //
  // Re-keyed on generatedAt as well as the root id: every write in the app
  // refreshes the issues export, and bd's parallel/ready computation for this
  // molecule may well have changed with it. Without this, claiming a step
  // would leave the ready chips describing the pre-claim state.
  const issuesGen = store.generatedAt.value;
  useEffect(() => {
    if (molRoot) loadMoleculeDetail(molRoot.id, { force: true });
    else { molDetail.id.value = null; molDetail.data.value = null; }
  }, [molRoot?.id, issuesGen]);

  return html`
    <div class=${'c2-detail' + (open ? ' open' : '')} role="dialog" aria-hidden=${!open}>
      ${open && html`
        <div class="c2-detail-inner" key=${id}>
          <div class="c2-detail-head">
            <div class="c2-detail-badges">${TypeGlyph(issue.issue_type)} ${Pip(issue.priority)}
              <span class=${'c2-detail-status st-' + glyphStatus(issue)}>${StatusGlyph(issue)} ${effStatus(issue).replace('_', ' ')}</span>
              <span class="c2-rel-id">${issue.id}</span>
            </div>
            <button class="c2-detail-close" title="Close" onClick=${() => selectIssue(null)}>✕</button>
          </div>
          <h2 class="c2-detail-title">${issue.title}</h2>
          ${(issue.labels || []).length > 0 && html`<div class="c2-detail-labels">${(issue.labels || []).map((l) => html`<span key=${l} class=${'c2-chip' + (l === 'triage' ? ' triage' : '')}>${l}</span>`)}</div>`}

          ${/* Molecule identity, above everything else: what this thing IS
                comes before what state it's in. */ ''}
          ${isMolecule(issue) && html`
            <div class="c2-molbadge" data-mol-badge="root">
              <span aria-hidden="true">⚗</span> molecule
              <span class="muted">· poured workflow · ${moleculeRollupFor(issue).total} steps</span>
            </div>`}
          ${isStep && html`
            <div class="c2-molbadge step" data-mol-badge="step">
              <span aria-hidden="true">⚗</span> step of
              <button class="c2-molbadge-link" onClick=${() => selectIssue(molRoot.id)} title=${molRoot.title}>${molRoot.title}</button>
              <span class="c2-rel-id">${molRoot.id}</span>
            </div>`}

          ${(() => {
            // Banner precedence (docs/beads-coverage.md Phase 1): a retired
            // state — superseded by / duplicate of — OUTRANKS blocked/ready.
            // An issue bd already closed as a duplicate has no meaningful
            // "ready to work" story, so never show both.
            const retired = retiredState(issue);
            if (retired) {
              return html`<div class=${'c2-banner retired ' + retired.kind}>
                <span>${retired.kind === 'duplicate' ? '⧉' : '↷'} ${retired.label}</span>
                ${RelChip(retired.other)}
              </div>`;
            }
            const ob = openBlockersOf(issue);
            if (issue.status !== 'closed' && ob.length > 0) {
              return html`<div class="c2-banner blocked">⛔ Blocked by ${ob.length} open ${ob.length === 1 ? 'issue' : 'issues'}</div>`;
            }
            return isReady(issue) && !isContainer(issue) ? html`<div class="c2-banner ready">✓ Ready — no open blockers</div>` : null;
          })()}

          ${issue.description && Field('Description', html`<div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(issue.description) }}></div>`)}
          ${issue.status === 'closed' && issue.close_reason && Field('Close reason', html`<div class="c2-md">${issue.close_reason}</div>`)}
          ${issue.design && Field('Design', html`<div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(issue.design) }}></div>`)}
          ${issue.notes && Field('Notes', html`<div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(issue.notes) }}></div>`)}
          ${issue.acceptance_criteria && Field('Acceptance', html`<div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(issue.acceptance_criteria) }}></div>`)}

          ${/* A molecule root's children ARE its steps — rendered here as the
                richer, progress-and-parallel-group-aware Steps section, and
                suppressed from the generic Children row below so the same
                beads don't appear twice. */ ''}
          ${isMolecule(issue) && Field('Steps', html`<${MoleculeSteps} root=${issue} />`)}

          ${(() => { const p = parentOf(issue); return p ? Field('Parent', RelChip(p)) : null; })()}
          ${(() => { const b = blockersOf(issue); return b.length ? Field('Blocked by', html`<div class="c2-rels">${b.map(RelChip)}</div>`) : null; })()}
          ${(() => { const b = blocksList(id); return b.length ? Field('Blocks', html`<div class="c2-rels">${b.map((x) => RelChip(x.id))}</div>`) : null; })()}
          ${(() => {
            if (isMolecule(issue)) return null; // already rendered as Steps
            const c = childrenOf(id);
            return c.length ? Field('Children', html`<div class="c2-rels">${c.map((x) => RelChip(x.id))}</div>`) : null;
          })()}

          ${/* Bidirectional: rendered once whichever side created the row. */ ''}
          ${(() => { const r = relatedOf(issue); return r.length ? Field('Related', html`<div class="c2-rels c2-rels-chips">${r.map(RelChip)}</div>`) : null; })()}
          ${/* discovered-from / tracks / caused-by / validates / … — a section
                per type that actually has members, in both directions, so the
                panel never grows ten empty headings. */ ''}
          ${linkSectionsOf(issue).map((s) => html`<div key=${s.key}>${Field(s.label, html`<div class="c2-rels">${s.ids.map(RelChip)}</div>`)}</div>`)}

          ${isMolecule(issue) && Field('Undo', html`<${BurnBox} root=${issue} />`)}

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
