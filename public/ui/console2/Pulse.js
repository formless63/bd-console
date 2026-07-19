// console2/Pulse.js — left rail of live, client-computed stats. Every number is
// a control: clicking focuses the matching flow lane or opens an issue.
import { html } from 'htm/preact';
import { store, selectIssue } from '../store.js';
import { c2 } from './state.js';
import { pulse, AGE_AMBER_H, AGE_RED_H, ageMs } from './derive.js';
import { Corners, PRI_LABEL } from './ui.js';

function focus(lane) { c2.canvasMode.value = 'flow'; c2.laneFocus.value = lane; }

function Sparkline({ data }) {
  const w = 132, h = 34, max = Math.max(1, ...data);
  const n = data.length;
  const step = n > 1 ? w / (n - 1) : w;
  const pts = data.map((v, i) => [i * step, h - (v / max) * (h - 4) - 2]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L ${w} ${h} L 0 ${h} Z`;
  const last = pts[pts.length - 1];
  const total = data.reduce((a, b) => a + b, 0);
  return html`
    <div class="c2-spark" title=${`${total} closed across ${n} weeks`}>
      <svg viewBox=${`0 0 ${w} ${h}`} width=${w} height=${h} preserveAspectRatio="none">
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

function Stat({ label, value, tone, onClick, sub }) {
  return html`
    <button class=${'c2-stat tone-' + (tone || 'default')} onClick=${onClick}>
      ${Corners()}
      <span class="c2-stat-k">${label}</span>
      <span class="c2-stat-v">${value}</span>
      ${sub && html`<span class="c2-stat-sub">${sub}</span>`}
    </button>`;
}

export function Pulse() {
  const p = pulse.value;
  const activeAging = p.inProgress.filter((i) => ageMs(i) / 3600000 > AGE_AMBER_H).length;

  return html`
    <aside class="c2-pulse">
      <div class="c2-pulse-head"><span class="c2-hud-label">Pulse</span></div>

      <div class="c2-stat-grid">
        ${Stat({ label: 'Ready', value: p.ready, tone: 'green', onClick: () => focus('ready') })}
        ${Stat({ label: 'In progress', value: p.inProgress.length, tone: 'accent',
          sub: activeAging ? `${activeAging} aging` : null, onClick: () => focus('in_progress') })}
        ${Stat({ label: 'Blocked', value: p.blocked.length, tone: 'red', onClick: () => focus('blocked') })}
        ${Stat({ label: 'Triage', value: p.triage, tone: 'purple', onClick: () => focus('triage') })}
        ${Stat({ label: 'Stale', value: p.stale, tone: 'amber',
          sub: '21d+', onClick: () => focus('stale') })}
      </div>

      ${p.inProgress.length > 0 && html`
        <div class="c2-pulse-block">
          <span class="c2-hud-label">Active · ages</span>
          <div class="c2-age-list">
            ${p.inProgress.map((i) => {
              const h = ageMs(i) / 3600000;
              const tone = h > AGE_RED_H ? 'red' : h > AGE_AMBER_H ? 'amber' : 'ok';
              const label = h < 24 ? Math.max(1, Math.round(h)) + 'h' : Math.round(h / 24) + 'd';
              return html`<button key=${i.id} class="c2-age-row" onClick=${() => selectIssue(i.id)}>
                <span class="c2-age-title">${i.title}</span>
                <span class=${'c2-age c2-age-' + tone}>${label}</span>
              </button>`;
            })}
          </div>
        </div>`}

      ${p.unblock && html`
        <button class="c2-unblock" onClick=${() => selectIssue(p.unblock.id)}>
          ${Corners()}
          <span class="c2-hud-label">Unblock hint</span>
          <span class="c2-unblock-body">Closing <b>${p.unblock.id}</b> frees <b>${p.unblock.count}</b> issue${p.unblock.count === 1 ? '' : 's'}</span>
          <span class="c2-unblock-title">${p.unblock.issue?.title || ''}</span>
        </button>`}

      <div class="c2-pulse-block">
        <span class="c2-hud-label">Velocity</span>
        <${Sparkline} data=${p.velocity} />
      </div>

      <div class="c2-pulse-block">
        <span class="c2-hud-label">Priority mix</span>
        <${PriorityBars} dist=${p.priority} />
      </div>
    </aside>`;
}
