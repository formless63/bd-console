// UsageCharts.js — the "attribution" half of the hub's Usage section: charts
// built from GET /api/usage/history (by-model, by-project, project×model,
// daily trend, period-over-period delta). Deliberately separate from the
// "live quota" gauges in HubView.js's UsageSection/ProviderUsageRow — those
// come from GET /api/usage and are authoritative; everything in this file is
// estimated from local session logs and is presented that way.
//
// Palette per the dataviz skill: color is assigned by the job it does.
//   - Ranking/magnitude (by-model bars, by-project bars, the project×model
//     heat table) uses a SEQUENTIAL single hue (var(--accent)) — the skill's
//     safe default ("reach for it unless the job is specifically identity").
//     This also sidesteps a real limitation of this app's theme system: it
//     ships one accent/green/amber/red/purple set per preset, tuned for
//     badges/status chips, not validated as an 8-slot CVD-safe categorical
//     ramp. Running scripts/validate_palette.js from the dataviz skill
//     against all 6 presets' [accent, purple, green] confirms most combinations
//     fail the normal-vision-floor or lightness-band checks in at least one
//     scheme (only dracula/light clears every check) — a pre-existing
//     property of the design system, not something a chart-level fix can
//     resolve without expanding the token set app-wide (out of scope here).
//   - Identity (the daily trend's stacked-by-model bars) is the one place
//     categorical color is structurally necessary. It uses the fixed order
//     [--accent, --purple, --green] capped at 3 named series + a muted
//     "Other" bucket (--text-faint) — within the skill's "1-3 comfortable"
//     ladder — and ALWAYS pairs color with a text legend + a focus/hover
//     readout, so identity never depends on hue discrimination alone.
//   - Severity (scoped-limit gauges, in HubView.js) uses the status palette
//     (--green/--amber/--red), never reused here for "series N".
import { html } from 'htm/preact';
import { useState } from 'preact/hooks';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function trimZero(s) { return s.replace(/\.0$/, ''); }

// Compact human token counts: 640, 12.4K, 2.1M, 1.8B.
export function formatTokens(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e9) return sign + trimZero((abs / 1e9).toFixed(1)) + 'B';
  if (abs >= 1e6) return sign + trimZero((abs / 1e6).toFixed(1)) + 'M';
  if (abs >= 1e3) return sign + trimZero((abs / 1e3).toFixed(1)) + 'K';
  return sign + String(Math.round(abs));
}

function formatCount(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// By-model / by-project horizontal bars — sequential single-hue (--accent),
// capped to a top-N + "Other" bucket. Track reuses .usage-gauge-track's
// visual language (border/pill/bg) so the attribution band still reads as
// the same system as the live-quota gauges above it.
// ---------------------------------------------------------------------------
function topNWithOther(list, n, valueKey, labelFn) {
  const sorted = (list || []).slice().sort((a, b) => (b[valueKey] || 0) - (a[valueKey] || 0));
  const head = sorted.slice(0, n).map((it) => ({ key: labelFn(it), label: labelFn(it), value: it[valueKey] || 0 }));
  const rest = sorted.slice(n);
  const otherTotal = rest.reduce((s, it) => s + (it[valueKey] || 0), 0);
  if (otherTotal > 0) head.push({ key: '__other', label: `Other (${rest.length})`, value: otherTotal, muted: true });
  return head;
}

function HBarList({ items, totalTokens }) {
  if (!items || items.length === 0) return null;
  const max = Math.max(1, ...items.map((i) => i.value));
  return html`
    <div class="usage-hbars">
      ${items.map((it) => html`
        <div class="usage-hbar-row" key=${it.key}>
          <span class="usage-hbar-label" title=${it.label}>${it.label}</span>
          <svg class="usage-gauge-track usage-hbar-track" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
            <rect x="0" y="0" width=${Math.max(2, (it.value / max) * 100)} height="10" rx="4"
              fill=${it.muted ? 'var(--text-faint)' : 'var(--accent)'} />
          </svg>
          <span class="usage-hbar-value">
            ${formatTokens(it.value)}
            ${totalTokens > 0 && html`<span class="muted small"> · ${Math.round((it.value / totalTokens) * 100)}%</span>`}
          </span>
        </div>`)}
    </div>`;
}

export function ByModelChart({ byModel, totalTokens }) {
  const items = topNWithOther(byModel, 6, 'tokens', (m) => m.model);
  if (!items.length) return null;
  return html`
    <div class="usage-chart-block">
      <h4 class="usage-chart-title">By model</h4>
      <${HBarList} items=${items} totalTokens=${totalTokens} />
    </div>`;
}

export function ByProjectChart({ byProject, totalTokens }) {
  const items = topNWithOther(byProject, 6, 'tokens', (p) => p.name || p.project);
  if (!items.length) return null;
  return html`
    <div class="usage-chart-block">
      <h4 class="usage-chart-title">By project</h4>
      <${HBarList} items=${items} totalTokens=${totalTokens} />
    </div>`;
}

// ---------------------------------------------------------------------------
// Project × model — a compact heat table. Sequential single-hue wash
// (color-mix of --accent over --surface, capped at moderate opacity so the
// on-cell text token stays legible without per-cell luminance math) plus the
// exact token count as always-visible text, never color alone.
// ---------------------------------------------------------------------------
export function ProjectModelTable({ byProject, byModel, byProjectModel }) {
  const projects = (byProject || []).slice().sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, 6);
  const models = (byModel || []).slice().sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, 4);
  if (!projects.length || !models.length) return null;
  const cell = new Map();
  for (const r of byProjectModel || []) cell.set(r.project + '|' + r.model, r.tokens || 0);
  const max = Math.max(1, ...(byProjectModel || []).map((r) => r.tokens || 0));
  return html`
    <div class="usage-chart-block">
      <h4 class="usage-chart-title">Project × model</h4>
      <div class="usage-matrix-wrap">
        <table class="usage-matrix">
          <thead>
            <tr>
              <th scope="col">Project</th>
              ${models.map((m) => html`<th scope="col" key=${m.model} title=${m.model}>${m.model}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${projects.map((p) => html`
              <tr key=${p.project}>
                <th scope="row" title=${p.name || p.project}>${p.name || p.project}</th>
                ${models.map((m) => {
                  const v = cell.get(p.project + '|' + m.model) || 0;
                  const alpha = v ? Math.max(12, Math.min(50, Math.round((v / max) * 50))) : 0;
                  const style = v ? `background:color-mix(in srgb, var(--accent) ${alpha}%, var(--surface))` : '';
                  return html`<td key=${m.model} style=${style}>${v ? formatTokens(v) : html`<span class="muted">–</span>`}</td>`;
                })}
              </tr>`)}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Daily trend — stacked bars by model over the selected range. The one chart
// where color carries IDENTITY (which model), so it's capped at 3 named
// series (fixed order: accent, purple, green) + a muted "Other" bucket, and
// every series is always both legend-labeled and reachable via a
// hover/focus readout (never color-alone, never gated behind hover).
// ---------------------------------------------------------------------------
const TREND_COLORS = ['var(--accent)', 'var(--purple)', 'var(--green)'];

export function DailyTrend({ daily, byModel, providerLabel }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  if (!daily || daily.length === 0) return null;

  const topModels = (byModel || []).slice().sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, 3).map((m) => m.model);
  const rows = daily.map((d) => {
    const byM = d.byModel || {};
    const segs = topModels.map((m) => byM[m] || 0);
    const total = Object.values(byM).reduce((a, b) => a + b, 0);
    const other = Math.max(0, total - segs.reduce((a, b) => a + b, 0));
    return { date: d.date, segs, other, total };
  });
  const max = Math.max(1, ...rows.map((r) => r.total));
  const activeIdx = hoverIdx != null ? hoverIdx : rows.length - 1;
  const active = rows[activeIdx];

  const W = 600, H = 130, GAP = 1.5;
  const barW = Math.max(0.6, W / rows.length - GAP);

  return html`
    <div class="usage-chart-block">
      <h4 class="usage-chart-title">Daily trend</h4>
      <div class="usage-trend">
        <svg class="usage-trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
          aria-label=${`${providerLabel} daily token usage by model, ${rows.length} days`}>
          ${rows.map((r, i) => {
            const x = i * (barW + GAP);
            const segments = [...r.segs, r.other];
            let y = H;
            const parts = [];
            segments.forEach((v, si) => {
              if (v <= 0) return;
              const h = (v / max) * (H - 4);
              y -= h;
              parts.push(html`<rect key=${si} x=${x} y=${y} width=${barW} height=${h}
                fill=${si < topModels.length ? TREND_COLORS[si] : 'var(--text-faint)'} opacity=${activeIdx === i ? 1 : 0.88} />`);
              y -= 1;
            });
            return html`<g key=${r.date}
              tabIndex="0" role="button" aria-label=${`${r.date}: ${formatTokens(r.total)} tokens`}
              onPointerEnter=${() => setHoverIdx(i)} onFocus=${() => setHoverIdx(i)} onClick=${() => setHoverIdx(i)}>
              <rect x=${x} y="0" width=${Math.max(barW, 3)} height=${H} fill="transparent" />
              ${parts}
              ${activeIdx === i && html`<rect x=${x} y="0" width=${barW} height=${H} fill="none" stroke="var(--text-dim)" stroke-width="0.6" opacity="0.5" />`}
            </g>`;
          })}
        </svg>
        <div class="usage-trend-legend">
          ${topModels.map((m, i) => html`<span class="usage-trend-legend-item" key=${m}><span class="usage-trend-swatch" style=${'background:' + TREND_COLORS[i]}></span>${m}</span>`)}
          ${rows.some((r) => r.other > 0) && html`<span class="usage-trend-legend-item"><span class="usage-trend-swatch" style="background:var(--text-faint)"></span>Other</span>`}
        </div>
        ${active && html`
          <div class="usage-trend-readout" aria-live="polite">
            <strong>${active.date}</strong>
            <span class="muted small">${formatTokens(active.total)} tokens</span>
            ${topModels.map((m, i) => active.segs[i] > 0 && html`
              <span class="usage-trend-readout-item" key=${m}>
                <span class="usage-trend-swatch" style=${'background:' + TREND_COLORS[i]}></span>${m}: ${formatTokens(active.segs[i])}
              </span>`)}
            ${active.other > 0 && html`
              <span class="usage-trend-readout-item">
                <span class="usage-trend-swatch" style="background:var(--text-faint)"></span>Other: ${formatTokens(active.other)}
              </span>`}
          </div>`}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Period-over-period delta stat tile. Deliberately NOT colored by direction
// (green=up/red=down) — more tokens isn't inherently good or bad, so the
// delta reads in plain text ink with a directional glyph in --accent, never
// borrowing the status palette for a value that isn't actually a status.
// ---------------------------------------------------------------------------
export function PeriodDelta({ days, current, previous }) {
  if (!current || !current.tokens) return null;
  const curTok = current.tokens || 0;
  const prevTok = previous ? previous.tokens || 0 : 0;
  let deltaText = null;
  if (previous && prevTok > 0) {
    const pct = Math.round(((curTok - prevTok) / prevTok) * 100);
    const glyph = pct > 0 ? '▲' : pct < 0 ? '▼' : '–';
    deltaText = `${glyph} ${Math.abs(pct)}% vs prior ${days}d`;
  }
  return html`
    <div class="usage-stat-tile">
      <span class="usage-stat-label">${days}d tokens</span>
      <span class="usage-stat-value">${formatTokens(curTok)}</span>
      ${current.messages != null && html`<span class="muted small">${formatCount(current.messages)} messages</span>`}
      ${deltaText && html`<span class="usage-stat-delta">${deltaText}</span>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// Per-provider attribution block — composes the pieces above, degrading
// gracefully when a provider's history is unavailable/empty.
// ---------------------------------------------------------------------------
export function ProviderAttribution({ label, data, showProjectCharts }) {
  if (!data || !data.available) {
    return html`
      <div class="usage-attrib-provider">
        <h3 class="usage-attrib-provider-title">${label}</h3>
        <p class="muted small usage-empty">No local session data found for ${label}.</p>
      </div>`;
  }
  const hasDaily = (data.daily || []).length > 0;
  const hasModels = (data.byModel || []).length > 0;
  if (!hasDaily && !hasModels) {
    return html`
      <div class="usage-attrib-provider">
        <h3 class="usage-attrib-provider-title">${label}</h3>
        <p class="muted small usage-empty">Gathering usage… check back after a session or two.</p>
      </div>`;
  }
  return html`
    <div class="usage-attrib-provider">
      <h3 class="usage-attrib-provider-title">${label}</h3>
      ${data.periods && html`<${PeriodDelta} days=${data._days} current=${data.periods.current} previous=${data.periods.previous} />`}
      <div class="usage-attrib-grid">
        <${ByModelChart} byModel=${data.byModel} totalTokens=${data.totalTokens} />
        ${showProjectCharts && html`<${ByProjectChart} byProject=${data.byProject} totalTokens=${data.totalTokens} />`}
      </div>
      ${showProjectCharts && html`<${ProjectModelTable} byProject=${data.byProject} byModel=${data.byModel} byProjectModel=${data.byProjectModel} />`}
      <${DailyTrend} daily=${data.daily} byModel=${data.byModel} providerLabel=${label} />
    </div>`;
}
