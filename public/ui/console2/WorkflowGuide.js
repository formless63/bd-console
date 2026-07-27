// console2/WorkflowGuide.js — a permanent, state-aware project-management
// path. The glossary explains words and nudges teach one feature once; this
// rail answers a different question every day: "what should I do next?"
import { html } from 'htm/preact';
import { store } from '../store.js';
import { c2, setWorkflowCollapsed } from './state.js';
import { pulse } from './derive.js';

const STAGES = [
  ['capture', 'Capture', 'add work'],
  ['triage', 'Sort inbox', 'triage'],
  ['plan', 'Plan links', 'epics + blockers'],
  ['work', 'Work ready', 'claim + close'],
  ['review', 'Review', 'blocked + stale'],
];

function inspectProject(issues, p) {
  const open = issues.filter((i) => i.status !== 'closed');
  const triage = open.filter((i) => (i.labels || []).includes('triage')).length;
  const containers = issues.filter((i) => i.issue_type === 'epic' || i.issue_type === 'molecule').length;
  let links = 0;
  for (const i of issues) for (const d of i.dependencies || []) if (d?.type && d.type !== 'parent-child') links++;

  if (issues.length === 0) return { stage: 'capture', title: 'Capture the first piece of work', detail: 'Write it in the box above; it lands safely in the inbox.', action: 'Capture something' };
  if (triage > 0) return { stage: 'triage', title: `Sort ${triage} inbox item${triage === 1 ? '' : 's'}`, detail: 'Give each one a useful priority, initiative, or next step.', action: 'Open inbox' };
  if (open.length >= 8 && containers === 0) {
    return { stage: 'plan', title: 'Group work into the first initiative', detail: 'Create an epic, then put related issues inside it so the plan stays readable.', action: 'Create an epic', actionKind: 'create-epic' };
  }
  if (open.length >= 4 && links === 0) {
    return { stage: 'plan', title: 'Connect the work into a plan', detail: 'Record what waits on what so Ready becomes trustworthy.', action: 'Open work map' };
  }
  if (p.inProgress.length > 0) return { stage: 'work', title: `${p.inProgress.length} item${p.inProgress.length === 1 ? '' : 's'} in progress`, detail: 'Keep active work moving, or close it so the next work becomes Ready.', action: 'Show active' };
  if (p.ready > 0) return { stage: 'work', title: `${p.ready} ready to start`, detail: 'These have no open blockers. Pick one and claim it.', action: 'Show ready' };
  if (p.blocked.length > 0) return { stage: 'review', title: `${p.blocked.length} waiting on blockers`, detail: 'Review the blocker chain and decide what can be freed next.', action: 'Show blocked' };
  if (p.stale > 0) return { stage: 'review', title: `${p.stale} items need a decision`, detail: 'Close, defer, or reconnect work that has gone quiet.', action: 'Show stale' };
  return { stage: 'capture', title: 'The current queue is clear', detail: 'Capture the next outcome when it appears.', action: 'Capture something' };
}

function runStage(stage) {
  if (stage === 'capture') {
    const el = document.querySelector('.c2-omni-input');
    el?.focus(); el?.select(); c2.omniOpen.value = true;
    return;
  }
  if (stage === 'triage') { c2.canvasMode.value = 'flow'; c2.laneFocus.value = 'triage'; return; }
  if (stage === 'plan') { c2.canvasMode.value = 'map'; c2.laneFocus.value = null; return; }
  if (stage === 'work') {
    c2.canvasMode.value = 'flow';
    c2.laneFocus.value = pulse.value.inProgress.length ? 'in_progress' : 'ready';
    return;
  }
  c2.canvasMode.value = 'flow';
  c2.laneFocus.value = pulse.value.blocked.length ? 'blocked' : 'stale';
}

function runNext(next) {
  if (next.actionKind === 'create-epic') {
    store.createOpen.value = true;
    return;
  }
  runStage(next.stage);
}

export function WorkflowGuide() {
  if (!c2.ready.value) return null;
  const next = inspectProject(store.issues.value, pulse.value);
  const collapsed = c2.workflowCollapsed.value;
  return html`
    <section class=${'c2-workflow' + (collapsed ? ' collapsed' : '')} aria-label="Project workflow">
      <button type="button" class="c2-workflow-summary" aria-expanded=${!collapsed}
        onClick=${() => setWorkflowCollapsed(!collapsed)}>
        <span class="c2-hud-label">Your path</span>
        <span class="c2-workflow-next"><b>Next:</b> ${next.title}</span>
        <span aria-hidden="true">${collapsed ? '▾' : '▴'}</span>
      </button>
      ${!collapsed && html`
        <div class="c2-workflow-body">
          <ol class="c2-workflow-steps" aria-label="Capture, sort, plan, work, and review">
            ${STAGES.map(([id, label, sub], n) => html`
              <li key=${id} class=${id === next.stage ? 'current' : ''}>
                <button type="button" aria-current=${id === next.stage ? 'step' : undefined} onClick=${() => runStage(id)}>
                  <span class="c2-workflow-n">${n + 1}</span>
                  <span><b>${label}</b><small>${sub}</small></span>
                </button>
              </li>`)}
          </ol>
          <div class="c2-workflow-callout">
            <span><b>${next.title}</b><small>${next.detail}</small></span>
            <button type="button" class="c2-mini accent" onClick=${() => runNext(next)}>${next.action}</button>
          </div>
        </div>`}
    </section>`;
}
