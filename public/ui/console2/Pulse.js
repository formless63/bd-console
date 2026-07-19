// console2/Pulse.js — the Pulse bar: a horizontal strip of live, client-computed
// stats directly under the header, plus a collapsible details panel (active
// ages, unblock hint, priority mix, this-repo sessions). Every number is a
// control: clicking focuses the matching flow lane or opens an issue.
//
// Deliberately NO drawers, scrims, or z-index layering here: the bar and its
// expanded panel are normal document flow on every viewport, so they can never
// paint under (or eat taps meant for) other content — the drawer version
// produced exactly those bugs twice.
import { html } from 'htm/preact';
import { store, selectIssue, toast } from '../store.js';
import { c2 } from './state.js';
import { pulse, AGE_AMBER_H, AGE_RED_H, ageMs } from './derive.js';
import { Corners, PRI_LABEL, StatusGlyph } from './ui.js';
import { matchProject, cwdTail } from '../components/common.js';
import { ThemeSwitch } from './ThemeSwitch.js';

function focus(lane) { c2.canvasMode.value = 'flow'; c2.laneFocus.value = lane; }

function Tile({ label, value, tone, onClick, sub }) {
  return html`
    <button class=${'c2-pb-item tone-' + (tone || 'default')} onClick=${onClick}>
      <span class="c2-pb-v">${value}</span>
      <span class="c2-pb-k">${label}</span>
      ${sub && html`<span class="c2-pb-sub">${sub}</span>`}
    </button>`;
}

function Sparkline({ data }) {
  const w = 132, h = 30, max = Math.max(1, ...data);
  const n = data.length;
  const step = n > 1 ? w / (n - 1) : w;
  const pts = data.map((v, i) => [i * step, h - (v / max) * (h - 4) - 2]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L ${w} ${h} L 0 ${h} Z`;
  const last = pts[pts.length - 1];
  const total = data.reduce((a, b) => a + b, 0);
  return html`
    <div class="c2-spark" title=${`${total} closed across ${n} weeks`}>
      <svg viewBox=${`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <path d=${area} class="c2-spark-area" />
        <path d=${line} class="c2-spark-line" fill="none" />
        ${last && html`<circle cx=${last[0].toFixed(1)} cy=${last[1].toFixed(1)} r="2.4" class="c2-spark-dot" />`}
      </svg>
      <span class="c2-spark-cap">velocity · ${total}/8wk</span>
    </div>`;
}

function PriorityBars({ dist }) {
  const max = Math.max(1, ...dist);
  return html`
    <div class="c2-pribars">
      ${dist.map((v, p) => html`
        <button key=${p} class="c2-pribar" title=${`${v} open at ${PRI_LABEL[p]}`} onClick=${() => { c2.canvasMode.value = 'flow'; c2.laneFocus.value = null; }}>
          <span class="c2-pribar-k">${PRI_LABEL[p]}</span>
          <span class="c2-pribar-track"><span class=${'c2-pribar-fill pf-' + p} style=${`width:${(v / max) * 100}%`}></span></span>
          <span class="c2-pribar-v">${v}</span>
        </button>`)}
    </div>`;
}

export function PulseBar() {
  const p = pulse.value;
  const open = c2.pulseOpen.value;
  const activeAging = p.inProgress.filter((i) => ageMs(i) / 3600000 > AGE_AMBER_H).length;

  return html`
    <section class="c2-pulsebar-wrap">
      <div class="c2-pulsebar">
        <div class="c2-pb-tiles">
          ${Tile({ label: 'Ready', value: p.ready, tone: 'green', onClick: () => focus('ready') })}
          ${Tile({ label: 'Active', value: p.inProgress.length, tone: 'accent',
            sub: activeAging ? `${activeAging} aging` : null, onClick: () => focus('in_progress') })}
          ${Tile({ label: 'Blocked', value: p.blocked.length, tone: 'red', onClick: () => focus('blocked') })}
          ${Tile({ label: 'Triage', value: p.triage, tone: 'purple', onClick: () => focus('triage') })}
          ${Tile({ label: 'Stale', value: p.stale, tone: 'amber', sub: '21d+', onClick: () => focus('stale') })}
        </div>
        <div class="c2-pb-side">
          <${Sparkline} data=${p.velocity} />
          <button class=${'c2-pb-more' + (open ? ' on' : '')} aria-expanded=${open}
            onClick=${() => (c2.pulseOpen.value = !open)}>
            details <span aria-hidden="true">${open ? '▴' : '▾'}</span>
          </button>
        </div>
      </div>

      ${open && html`
        <div class="c2-pulsex">
          ${p.inProgress.length > 0 && html`
            <div class="c2-pulse-block">
              <span class="c2-hud-label">Active · ages</span>
              <div class="c2-age-list">
                ${p.inProgress.map((i) => {
                  const h = ageMs(i) / 3600000;
                  const tone = h > AGE_RED_H ? 'red' : h > AGE_AMBER_H ? 'amber' : 'ok';
                  const label = h < 24 ? Math.max(1, Math.round(h)) + 'h' : Math.round(h / 24) + 'd';
                  return html`<button key=${i.id} class="c2-age-row" onClick=${() => selectIssue(i.id)}>
                    ${StatusGlyph(i)}
                    <span class="c2-age-title">${i.title}</span>
                    <span class=${'c2-age c2-age-' + tone}>${label}</span>
                  </button>`;
                })}
              </div>
            </div>`}

          ${p.unblock && html`
            <div class="c2-pulse-block">
              <span class="c2-hud-label">Unblock hint</span>
              <button class="c2-unblock" onClick=${() => selectIssue(p.unblock.id)}>
                ${Corners()}
                <span class="c2-unblock-body">${p.unblock.issue && StatusGlyph(p.unblock.issue)} Closing <b>${p.unblock.id}</b> frees <b>${p.unblock.count}</b> issue${p.unblock.count === 1 ? '' : 's'}</span>
                <span class="c2-unblock-title">${p.unblock.issue?.title || ''}</span>
              </button>
            </div>`}

          <div class="c2-pulse-block">
            <span class="c2-hud-label">Priority mix</span>
            <${PriorityBars} dist=${p.priority} />
          </div>

          <${SessionsBlock} />

          <div class="c2-pulse-block c2-themesw-pulse">
            <span class="c2-hud-label">Theme</span>
            <${ThemeSwitch} />
          </div>
        </div>`}
    </section>`;
}

// ---------------------------------------------------------------------------
// Sessions — the tmux sessions whose active pane cwd is inside THIS project's
// working directory, reusing the hub's own cwd-matching logic (matchProject,
// from components/common.js) verbatim rather than re-deriving the prefix
// check here. tmux itself is host-wide (GET /api/tmux lists every session on
// the machine), so this is purely a client-side filter over the already-
// loaded store.tmuxSessions against the active project's path (store.meta's
// per-project `workspace` field).
// ---------------------------------------------------------------------------
function projectSessions() {
  const path = store.meta.value?.workspace;
  if (!path) return [];
  const fake = { __c2_project__: { path } };
  return store.tmuxSessions.value.filter((s) => (s.panes || []).some((p) => matchProject(p.cwd, fake)));
}

// Delegate-here is explicit-selection-only, same "no silent default" rule the
// hub's Delegate composer already enforces: it only preselects a session when
// the user has an issue open (Detail visible) to delegate — tapping it with
// nothing selected can't guess an issue, so it just tells the user what to do
// instead of silently no-opping.
function delegateHere(sessionName) {
  if (!store.selectedId.value) { toast('Open an issue first, then delegate to ' + sessionName, 'err'); return; }
  c2.delegatePreset.value = sessionName;
}

function SessionsBlock() {
  if (!store.tmuxAvailable.value) return null;
  const sessions = projectSessions();
  return html`
    <div class="c2-pulse-block c2-sessions">
      <span class="c2-hud-label">Sessions · this repo</span>
      ${sessions.length === 0
        ? html`<div class="c2-lane-empty">No sessions here.</div>`
        : sessions.map((s) => {
          const first = s.panes && s.panes[0];
          return html`
            <div key=${s.name} class="c2-session-row">
              <span class="c2-session-name" title=${cwdTail(first?.cwd)}>${s.name}</span>
              <span class=${'badge tmux-attach' + (s.attached ? ' on' : '')}>${s.attached ? 'attached' : 'detached'}</span>
              <span class="c2-session-cmd">${first?.command || '—'}</span>
              <button class="c2-mini" title="Delegate here" onClick=${() => delegateHere(s.name)}>delegate here</button>
            </div>`;
        })}
    </div>`;
}
