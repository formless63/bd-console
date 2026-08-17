// console2/Detail.js — the right slide-over. Full rendered issue, clickable
// relationship chips, comments timeline + composer, the complete inline edit
// set, and DELEGATE (prefilled compose → live tmux session picker → Send now /
// Schedule). Every mutation echoes its bd / tmux equivalent via flashCli.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  store, byId, parentOf, blockersOf, openBlockersOf, childrenOf, blocksList,
  effStatus, isReady, selectIssue, addComment, loadTmux, loadIssues,
  LINK_TYPES, relatedOf, linkSectionsOf, retiredState,
  addLink, removeLink, supersedeIssue, markDuplicate,
  isContainer, isMolecule, moleculeRootFor, moleculeRollupFor,
} from '../store.js';
import { burnIssueCount } from '../formulas.js';
import {
  molDetail, loadMoleculeDetail, requestBurnPreview, cancelBurn, confirmBurn,
  openDistillDialog,
} from './molecules.js';
import { renderMarkdown } from '../markdown.js';
import {
  actClaim, actStart, actClose, actReopen, actPriority, actDefer,
  actAddLabel, actRemoveLabel, actSetParent, actAddBlocker, actRemoveBlocker,
  actSetAssignee,
  delegateNow, delegateSchedule,
} from './actions.js';
import { TypeGlyph, Pip, PRI_LABEL, StatusGlyph, glyphStatus } from './ui.js';
import { c2, flashCli } from './state.js';
import { LearnEmpty, ConceptDot } from '../components/ConceptTip.js';
import { agentName, isServerMode, promptTip } from '../components/common.js';
import { learn, concept } from '../learn.js';

// Link/supersede/duplicate writes live in store.js (with the other shared
// write paths) rather than actions.js; wrap them here so Console 2.0 flashes
// the bd equivalent — and only ever AFTER the write resolved, matching
// actions.js's contract.
const actAddLink = async (id, other, type) => {
  await addLink(id, other, type);
  flashCli(`bd dep add ${id} ${other} --type ${type}`, 'link');
  // The user has demonstrably learned what links are for — retire the hint
  // that would have taught them, permanently, right now rather than at the
  // next data refresh. See public/ui/learn.js on retirement.
  learn.recordAction('link');
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

// `k` optionally names a concept from public/ui/learn.js, which puts a small
// "?" next to the section heading. Section headings are exactly the right
// place for it: they are where the jargon actually lands on a beginner
// ("Blocked by", "Discovered from", "Steps"), and a heading is quiet enough
// that an extra 14px dot next to it costs a fluent user nothing.
function Field(title, body, k) {
  return html`<div class="c2-field">
    <span class="c2-hud-label">${title}${k ? html`<${ConceptDot} k=${k} />` : ''}</span>${body}</div>`;
}

// Narrative fields are often where imported or long-running issues become
// unwieldy. Keep the full markdown in the DOM, but start genuinely long
// fields collapsed so they cannot bury blockers and controls. Native details
// also gives keyboard and screen-reader users a familiar disclosure control.
function NarrativeField({ title, value, plain = false }) {
  if (!value) return null;
  const text = String(value);
  const isLong = text.length > 560 || text.split('\n').length > 8;
  const body = plain
    ? html`<div class="c2-md">${text}</div>`
    : html`<div class="markdown c2-md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }}></div>`;
  return html`
    <details class=${'c2-narrative' + (isLong ? ' long' : '')} open=${!isLong}>
      <summary>
        <span>${title}</span>
        ${isLong && html`<span class="c2-narrative-size">${text.length.toLocaleString()} characters</span>`}
      </summary>
      <div class="c2-narrative-body">${body}</div>
    </details>`;
}

function PrimaryActions({ issue }) {
  const id = issue.id;
  const run = (fn) => () => { fn().catch(() => {}); };
  const askClose = () => actClose(id, prompt('Close reason (optional):', '') || '');
  const askReopen = () => actReopen(id, prompt('Reopen reason (optional):', '') || '');
  const askDefer = () => {
    const when = prompt('Defer until (+2d or 2026-08-01):', issue.defer_until || '+2d');
    return when == null || !when.trim() ? Promise.resolve() : actDefer(id, when.trim());
  };

  return html`<div class="c2-primary-actions" aria-label="Issue actions">
    ${issue.status === 'closed'
      ? html`<button class="c2-mini accent" onClick=${run(askReopen)}>Reopen</button>`
      : html`
        ${issue.status !== 'in_progress' && html`<button class="c2-mini" onClick=${run(() => actClaim(id))}>Claim</button>`}
        ${issue.status !== 'in_progress' && html`<button class="c2-mini accent" onClick=${run(() => actStart(id))}>Start</button>`}
        <button class="c2-mini" onClick=${run(askClose)}>Close</button>
        ${issue.defer_until
          ? html`<button class="c2-mini" onClick=${run(() => actDefer(id, ''))}>Resume now</button>`
          : html`<button class="c2-mini" onClick=${run(askDefer)}>Defer…</button>`}
      `}
  </div>`;
}

// The concept behind each generic link section, keyed by the section key
// linkSectionsOf() produces ("out:tracks", "in:caused-by", …). Both directions
// of a type point at the same definition — the definition explains both ends.
function conceptForLinkSection(key) {
  const type = String(key).split(':')[1];
  return concept(type) ? type : null;
}

// True when ANY relationship surface would render something for this issue —
// the exact union of the sections below, so the "no connections yet" block and
// the real sections can never both appear.
function hasAnyRelationship(issue) {
  if (!issue) return true;
  if (isMolecule(issue)) return true; // Steps is its relationship section
  return !!parentOf(issue)
    || blockersOf(issue).length > 0
    || blocksList(issue.id).length > 0
    || childrenOf(issue.id).length > 0
    || relatedOf(issue).length > 0
    || linkSectionsOf(issue).length > 0
    || !!retiredState(issue);
}

function Edit({ issue }) {
  const id = issue.id;
  const [label, setLabel] = useState('');
  const [assignee, setAssignee] = useState(issue.assignee || '');
  const [parent, setParent] = useState(parentOf(issue) || '');
  const [blk, setBlk] = useState('');
  const [defer, setDefer] = useState(issue.defer_until || '');
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
        <span class="c2-edit-k">Priority</span>
        ${[0, 1, 2, 3, 4].map((p) => html`<button key=${p} class=${'c2-mini' + (issue.priority === p ? ' on' : '')} onClick=${run(() => actPriority(id, p))}>${PRI_LABEL[p]}</button>`)}
      </div>

      ${/* Claim sets the assignee to you and nothing here could change it
            afterwards — reassigning or handing an issue back meant editing it
            from a terminal. `clear` is its own control for the same reason
            Parent's is: unassigning is an intent, not an empty save. */ ''}
      <div class="c2-edit-row">
        <span class="c2-edit-k">Assignee</span>
        <input class="c2-edit-input" placeholder="unassigned" value=${assignee} onInput=${(e) => setAssignee(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') run(() => actSetAssignee(id, assignee.trim()))(); }} />
        <button class="c2-mini" disabled=${assignee.trim() === (issue.assignee || '')} onClick=${run(() => actSetAssignee(id, assignee.trim()))}>set</button>
        <button class="c2-mini" disabled=${!issue.assignee} onClick=${run(() => { setAssignee(''); return actSetAssignee(id, ''); })}>clear</button>
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
        <span class="c2-edit-k">Link<${ConceptDot} k=${linkType} /></span>
        <select class="c2-edit-input c2-linktype" value=${linkType} onChange=${(e) => setLinkType(e.target.value)} aria-label="Link type">
          ${LINK_TYPES.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}
        </select>
        <input class="c2-edit-input" id="c2-link-id" placeholder="issue-id" value=${linkId} onInput=${(e) => setLinkId(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && linkId.trim()) run(() => actAddLink(id, linkId.trim(), linkType).then(() => setLinkId('')))(); }} />
        <button class="c2-mini" disabled=${!linkId.trim()} onClick=${run(() => actAddLink(id, linkId.trim(), linkType).then(() => setLinkId('')))}>link</button>
      </div>
      ${/* The ten link-type names are the single most opaque control in the
            app — `discovered-from` and `validates` mean nothing to someone
            who hasn't read the beads docs, and even a fluent user has to stop
            and think about which DIRECTION a type reads in. One muted line
            that restates the selected value in plain English, right under the
            picker, at the exact moment it's being chosen. Reference, not a
            hint: it isn't dismissible and doesn't age out, because the
            question it answers doesn't either. */ ''}
      ${concept(linkType) && html`
        <div class="c2-linktype-gloss">
          <b>${concept(linkType).term}</b> — ${concept(linkType).short}
          ${concept(linkType).direction && html`<span class="c2-linktype-dir">${concept(linkType).direction}</span>`}
        </div>`}

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
        <span class="c2-progress-track" aria-hidden="true">
          <span class="c2-progress-fill" style=${`width:${pct}%`}></span>
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

// Save-as-template — the "you built this once, save it as a recipe" half of
// bd-console-9it, and the reason molecules stopped being a dead end: `bd
// formula` has no create verb, so before this button the only way to get a
// formula was to hand-write a file outside the app. It appears on any
// container that actually HAS children (an epic OR a poured molecule — a
// molecule that grew extra steps is itself worth re-templating), because a
// distill of a childless bead writes a zero-step formula that pours nothing.
function TemplateBox({ issue }) {
  const kids = childrenOf(issue.id).length;
  const kind = isMolecule(issue) ? 'molecule' : 'epic';
  return html`
    <div class="c2-mol-distill">
      <button class="c2-mini accent" data-mol-distill-btn onClick=${() => openDistillDialog(issue)}>
        ⚗ Save as reusable template…
      </button>
      <p class="c2-mol-note muted">
        Saves this ${kind}'s shape — ${kids} step${kids === 1 ? '' : 's'} and the order they run in — as a
        formula. Next time, pour it instead of retyping it. Nothing here changes.
      </p>
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

  // The picker still LISTS server-mode sessions (marked), because hiding them
  // makes the host look wrong; what it won't do is let Send/Schedule aim at
  // one. The server refuses those sends too (409) — this just stops the user
  // from finding that out the hard way.
  const target = sessions.find((s) => s.name === session) || null;
  const targetServer = isServerMode(target);

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
                ${sessions.map((s) => {
                  const tags = [agentName(s), s.attached ? 'attached' : null, isServerMode(s) ? 'server mode' : null].filter(Boolean);
                  return html`<option key=${s.name} value=${s.name}>${s.name}${tags.length ? ` (${tags.join(' · ')})` : ''}</option>`;
                })}
              </select>
              <button class="c2-mini accent" disabled=${busy || !session || targetServer}
                title=${targetServer ? promptTip(target) : ''} onClick=${sendNow}>Send now</button>
            </div>
            ${targetServer && html`<div class="c2-delegate-warn">${promptTip(target)}</div>`}
            <div class="c2-edit-row">
              <span class="c2-edit-k">Schedule</span>
              <input class="c2-edit-input" type="datetime-local" value=${when} onInput=${(e) => setWhen(e.target.value)} />
              <button class="c2-mini" disabled=${busy || !session || !when || targetServer}
                title=${targetServer ? promptTip(target) : ''} onClick=${schedule}>Schedule…</button>
            </div>
            <div class="c2-cli-hint">$ tmux send-keys -t ${session || '<session>'} … Enter</div>`}
    </div>`;
}

export function Detail() {
  const id = store.selectedId.value;
  const liveIssue = id ? byId.value.get(id) : null;

  // Last-known-good snapshot of the selected issue. A live refresh (SSE
  // change event, the fallback poll, or any write elsewhere) that drops this
  // id out of store.issues — closed and aged out of the export, deleted by
  // another agent, or just a slow/partial re-export — must never unmount
  // this panel out from under whatever the user is doing in it: a comment
  // being typed, an in-progress Edit field, mid-scroll through Connections.
  // The snapshot resets ONLY when the SELECTION itself changes (a different
  // id, or none); a refresh that still resolves the same id just updates it
  // in place, which is also what keeps the read-only sections (title,
  // labels, description, …) current without touching anything the user is
  // mid-edit on — Edit/Comments/Delegate below hold their own local state
  // that is never re-derived from this prop on a re-render, only on mount.
  const snapshotRef = useRef({ id: null, issue: null });
  if (snapshotRef.current.id !== id) {
    snapshotRef.current = { id, issue: liveIssue || null };
  } else if (liveIssue) {
    snapshotRef.current = { id, issue: liveIssue };
  }
  const issue = snapshotRef.current.issue;
  // True once this selection resolved a real issue and a later refresh no
  // longer carries it — as opposed to `id` simply never resolving at all
  // (e.g. a stale deep link), which stays un-open exactly as before.
  const vanished = !!id && !liveIssue && !!issue;
  const open = !!issue;
  const [section, setSection] = useState('overview');
  const dialogRef = useRef(null);
  const returnFocus = useRef(null);
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

  useEffect(() => { setSection('overview'); }, [id]);

  // This is a custom slide-over rather than a native <dialog>, so it must
  // supply the modal keyboard contract itself: move focus inside, keep Tab
  // within the panel, close on Escape, and return to the card/control that
  // opened it. The background regions are inert while it is open so pointer
  // and assistive-technology navigation agree with aria-modal.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    returnFocus.current = document.activeElement;
    const background = document.querySelectorAll('.c2-header, .c2-pulsebar-wrap, .c2-nudgeslot, .c2-body');
    background.forEach((el) => { el.inert = true; });
    const focusable = () => [...dialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])',
    )].filter((el) => !el.hidden && el.getClientRects().length > 0);
    // preventScroll: this fires on the next tick, while the panel is still
    // animating in from translateX(102%), so the control we focus is briefly
    // off to the right of the viewport. Without it the browser "helpfully"
    // scrolls the ancestor to reveal it and the whole app ends up shifted
    // (bd-console-clb). Focus placement is what we want here; scrolling to it
    // never is — the panel puts itself in view on its own.
    const focusTimer = setTimeout(() => (focusable()[0] || dialog).focus({ preventScroll: true }), 0);
    const onKeyDown = (e) => {
      // A native dialog opened from this panel owns focus until it closes.
      if (e.target.closest?.('dialog[open]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        selectIssue(null);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { e.preventDefault(); dialog.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown, true);
      background.forEach((el) => { el.inert = false; });
      const target = returnFocus.current;
      returnFocus.current = null;
      // Same reasoning as the open-focus above: restore focus to whatever
      // opened the panel, but never let that restoration scroll anything.
      if (target?.isConnected) setTimeout(() => target.focus({ preventScroll: true }), 0);
    };
  }, [open]);

  const tabs = [
    ['overview', 'Overview'],
    ['connections', 'Connections'],
    ['activity', 'Activity'],
    ['manage', 'Manage'],
  ];

  return html`
    <div ref=${dialogRef} class=${'c2-detail' + (open ? ' open' : '')} role="dialog" aria-modal="true"
      aria-labelledby="c2-detail-title" aria-hidden=${!open} tabIndex="-1">
      ${open && html`
        <div class="c2-detail-inner" key=${id}>
          <div class="c2-detail-head">
            <div class="c2-detail-badges">${TypeGlyph(issue.issue_type)} ${Pip(issue.priority)}
              <span class=${'c2-detail-status st-' + glyphStatus(issue)}>${StatusGlyph(issue)} ${effStatus(issue).replace('_', ' ')}</span>
              <span class="c2-rel-id">${issue.id}</span>
            </div>
            <button class="c2-detail-close" title="Close" aria-label="Close issue details" onClick=${() => selectIssue(null)}>✕</button>
          </div>
          <h2 class="c2-detail-title" id="c2-detail-title">${issue.title}</h2>
          ${(issue.labels || []).length > 0 && html`<div class="c2-detail-labels">${(issue.labels || []).map((l) => html`<span key=${l} class=${'c2-chip' + (l === 'triage' ? ' triage' : '')}>${l}</span>`)}</div>`}

          ${/* Data went stale under the user's feet — say so, but keep
                rendering the last snapshot rather than unmounting; see
                `vanished` above. Sits above every other banner because it is
                about whether the REST of this panel can be trusted, not
                about the issue's own state. */ ''}
          ${vanished && html`
            <div class="c2-banner vanished" role="status">
              <span>⟳ ${id} no longer appears in the latest export — it may have changed or been removed elsewhere.</span>
              <button class="c2-mini" onClick=${() => loadIssues({ force: true })}>refresh</button>
            </div>`}

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

          ${(() => {
            const b = openBlockersOf(issue);
            return b.length ? html`<div class="c2-blocker-summary">
              <span class="c2-hud-label">Resolve first</span>
              <div class="c2-rels">${b.map(RelChip)}</div>
            </div>` : null;
          })()}

          <div class="c2-detail-workbar">
            <${PrimaryActions} issue=${issue} />
            <nav class="c2-detail-tabs" aria-label="Issue detail sections" role="tablist">
              ${tabs.map(([key, label]) => html`<button key=${key} class=${section === key ? 'on' : ''}
                id=${'c2-detail-tab-' + key} role="tab" aria-controls=${'c2-detail-panel-' + key}
                aria-selected=${section === key} tabIndex=${section === key ? '0' : '-1'}
                onClick=${() => setSection(key)}
                onKeyDown=${(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                  e.preventDefault();
                  const at = tabs.findIndex(([tabKey]) => tabKey === key);
                  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
                    : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                  setSection(tabs[next][0]);
                  setTimeout(() => document.querySelector('#c2-detail-tab-' + tabs[next][0])?.focus(), 0);
                }}>${label}</button>`)}
            </nav>
          </div>

          <div class="c2-detail-sections">
            <section class="c2-detail-section" id="c2-detail-panel-overview" role="tabpanel" tabIndex="0" aria-labelledby="c2-detail-tab-overview"
              data-section="overview" hidden=${section !== 'overview'}>
              ${issue.description || issue.close_reason || issue.design || issue.notes || issue.acceptance_criteria
                ? html`
                  <${NarrativeField} title="Description" value=${issue.description} />
                  ${issue.status === 'closed' && html`<${NarrativeField} title="Close reason" value=${issue.close_reason} plain />`}
                  <${NarrativeField} title="Design" value=${issue.design} />
                  <${NarrativeField} title="Notes" value=${issue.notes} />
                  <${NarrativeField} title="Acceptance" value=${issue.acceptance_criteria} />`
                : html`<div class="c2-lane-empty">No description, notes, design, or acceptance criteria yet.</div>`}
            </section>

            <section class="c2-detail-section" id="c2-detail-panel-connections" role="tabpanel" tabIndex="0" aria-labelledby="c2-detail-tab-connections"
              data-section="connections" hidden=${section !== 'connections'}>
              ${/* A molecule root's children ARE its steps — rendered here as
                    the richer section and suppressed from Children. */ ''}
              ${isMolecule(issue) && Field('Steps', html`<${MoleculeSteps} root=${issue} />`, 'molecule')}
              ${(() => { const p = parentOf(issue); return p ? Field('Parent', RelChip(p), 'parent-child') : null; })()}
              ${(() => { const b = blockersOf(issue); return b.length ? Field('Blocked by', html`<div class="c2-rels">${b.map(RelChip)}</div>`, 'blocks') : null; })()}
              ${(() => { const b = blocksList(id); return b.length ? Field('Blocks', html`<div class="c2-rels">${b.map((x) => RelChip(x.id))}</div>`, 'blocks') : null; })()}
              ${(() => {
                if (isMolecule(issue)) return null;
                const c = childrenOf(id);
                return c.length ? Field('Children', html`<div class="c2-rels">${c.map((x) => RelChip(x.id))}</div>`, 'parent-child') : null;
              })()}
              ${(() => { const r = relatedOf(issue); return r.length ? Field('Related', html`<div class="c2-rels c2-rels-chips">${r.map(RelChip)}</div>`, 'related') : null; })()}
              ${linkSectionsOf(issue).map((s) => html`<div key=${s.key}>${Field(s.label, html`<div class="c2-rels">${s.ids.map(RelChip)}</div>`, conceptForLinkSection(s.key))}</div>`)}
              ${!hasAnyRelationship(issue) && Field('Connections', html`
                <${LearnEmpty} compact k="blocks"
                  what="Nothing is connected to this yet."
                  why="Saying that this waits on another issue is what makes the Ready lane and the Map work — and a “related” or “discovered from” link is how anyone reading this in six months finds out why it exists."
                  actionLabel="Add a connection"
                  onAction=${() => {
                    setSection('manage');
                    setTimeout(() => {
                      const el = document.querySelector('#c2-link-id');
                      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                      el?.focus();
                    }, 80);
                  }} />`)}
            </section>

            <section class="c2-detail-section" id="c2-detail-panel-activity" role="tabpanel" tabIndex="0" aria-labelledby="c2-detail-tab-activity"
              data-section="activity" hidden=${section !== 'activity'}>
              ${Field('Comments', html`<${Comments} id=${id} />`)}
              ${Field('Delegate', html`<${Delegate} issue=${issue} />`)}
              ${Field('Meta', html`<div class="c2-meta">
                <span>Assignee</span><span>${issue.assignee || '—'}</span>
                <span>Created</span><span>${new Date(issue.created_at).toLocaleString()}</span>
                <span>Updated</span><span>${new Date(issue.updated_at).toLocaleString()}</span>
                ${issue.closed_at ? html`<span>Closed</span><span>${new Date(issue.closed_at).toLocaleString()}</span>` : ''}
              </div>`)}
            </section>

            <section class="c2-detail-section" id="c2-detail-panel-manage" role="tabpanel" tabIndex="0" aria-labelledby="c2-detail-tab-manage"
              data-section="manage" hidden=${section !== 'manage'}>
              ${Field('Edit issue', html`<${Edit} issue=${issue} />`)}
              ${isContainer(issue) && childrenOf(id).length > 0
                && Field('Reuse workflow', html`<${TemplateBox} issue=${issue} />`, 'formula')}
              ${isMolecule(issue) && Field('Undo molecule', html`<${BurnBox} root=${issue} />`)}
            </section>
          </div>
        </div>`}
    </div>`;
}
