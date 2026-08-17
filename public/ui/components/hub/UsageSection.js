// components/hub/UsageSection.js — the hub's provider-usage surfaces: the
// live quota gauges (Claude Code / Codex / Kimi / Gemini), the terminal-
// sessions half of the same row, and the usage-attribution history band
// below it. Split out of HubView.js (bd-console-974.7) as a mechanical move
// — see hub/ProjectGrid.js and hub/shared.js for the rest of that split.
import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import {
  store, navigate, loadUsage, loadUsageHistory, loadCliVersions, toggleHubSection, toast,
} from '../../store.js';
import { useVisiblePoll } from '../../poll.js';
import { timeAgo } from '../common.js';
import { SessionRowCompact, HubTmuxHead } from '../TmuxView.js';
import { ProviderAttribution, formatTokens } from '../UsageCharts.js';
import { ChevronIcon, copyUpdateCommand } from './shared.js';

// ---------------------------------------------------------------------------
// Usage section — Claude Code / Codex quota gauges (GET /api/usage, polled
// every 5 min while the hub is mounted AND visible). Placed near the ops
// strip since it's the same kind of hub-wide, not-project-scoped glanceable
// status.
//
// 5 minutes, not the original 60s: the server's cache is what actually meters
// the upstream Claude OAuth call, but a 60s client poll against a 60s server
// TTL meant an open hub sustained ~1 OAuth call/minute forever and tripped the
// provider's rate limit (bd-console-0fg). These gauges track 5h/7d windows —
// minute resolution buys nothing. The ↻ button is the fast path when someone
// actually wants "now" (see refreshUsageAll).
// ---------------------------------------------------------------------------
const USAGE_POLL_MS = 5 * 60000;
// History (attribution) is a heavier fetch than the live-quota gauges above
// — refresh it on its own cadence (5 min) plus on mount / manual refresh /
// range switch. It reads local session logs only, so it never touches a
// provider's rate limit; it lands on the same 5 min as the quota poll purely
// because that is the right cadence for both, not because they share a timer.
const USAGE_HISTORY_POLL_MS = 5 * 60000;
// 'Gemini (Antigravity)' matches AGENT_LABEL in lib/tmux.mjs exactly — the same
// CLI shows up in the Terminal-sessions card under that name, and two different
// names for one tool on one screen is a bug.
const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', gemini: 'Gemini (Antigravity)' };
const HISTORY_RANGE_OPTIONS = [7, 30, 90];

// "resets in Xh Ym" / "resets in Ym" — deliberately not timeAgo/relTime
// (both round to a single unit), since a countdown reading "resets in 1h"
// when it's actually 1h 55m away is misleading for scheduling decisions.
function formatResetIn(resetsAt) {
  if (!resetsAt) return null;
  const diffMin = Math.round((resetsAt - Date.now()) / 60000);
  if (diffMin <= 0) return 'resets soon';
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function gaugeColorClass(percent) {
  if (typeof percent !== 'number') return 'gauge-ok';
  if (percent > 85) return 'gauge-crit';
  if (percent >= 60) return 'gauge-warn';
  return 'gauge-ok';
}

// Scoped limits carry their own authoritative severity from the server
// (normal/warning/critical) — map it directly to the same status classes
// the percent-derived gauges use, rather than re-deriving it from percent.
function severityGaugeClass(severity) {
  if (severity === 'critical') return 'gauge-crit';
  if (severity === 'warning') return 'gauge-warn';
  return 'gauge-ok';
}

// Shared shell for both gauge rows below (bd-console-974.7 dedupe) — a
// label, a percent, an optional badge (only ScopedLimitRow's "throttled"
// marker uses it), an optional reset countdown, and the track/fill bar
// itself. UsageGauge and ScopedLimitRow differ only in WHICH class(es) ride
// on the row/label and which color-class function picks the fill — never in
// structure, so that's the only thing left forked below.
function GaugeRow({ label, labelClass = '', labelTitle, pct, colorClass, resetsAt, rowClass = '', badge = null }) {
  return html`
    <div class=${'usage-gauge-row' + (rowClass ? ' ' + rowClass : '')}>
      <span class=${'usage-gauge-label' + (labelClass ? ' ' + labelClass : '')} title=${labelTitle}>${label}</span>
      <span class="usage-gauge-pct">${pct != null ? Math.round(pct) + '%' : '—'}</span>
      ${badge}
      ${resetsAt && html`<span class="usage-gauge-reset muted small">${formatResetIn(resetsAt)}</span>`}
      <div class="usage-gauge-track" role="progressbar" aria-valuenow=${pct ?? 0} aria-valuemin="0" aria-valuemax="100">
        <div class=${'usage-gauge-fill ' + colorClass} style=${'width:' + (pct ?? 0) + '%'}></div>
      </div>
    </div>`;
}

function UsageGauge({ w }) {
  const pct = typeof w.percent === 'number' ? Math.max(0, Math.min(100, w.percent)) : null;
  return html`<${GaugeRow} label=${w.label} pct=${pct} colorClass=${gaugeColorClass(pct)} resetsAt=${w.resetsAt} />`;
}

// A single per-model scoped limit row (GET /api/usage's dynamic
// scopedLimits[] — only currently-capped models appear). A critical + active
// entry means the model is actually throttled right now, so it gets a loud
// treatment (icon + text label, never color alone) in addition to the red
// fill everything else already gets from severityGaugeClass.
function ScopedLimitRow({ lim }) {
  const pct = typeof lim.percent === 'number' ? Math.max(0, Math.min(100, lim.percent)) : null;
  const loud = lim.severity === 'critical' && lim.active;
  return html`<${GaugeRow}
    label=${lim.model} labelClass="usage-scoped-limit-label" labelTitle=${lim.model}
    pct=${pct} colorClass=${severityGaugeClass(lim.severity)} resetsAt=${lim.resetsAt}
    rowClass=${'usage-scoped-limit' + (loud ? ' critical-active' : '')}
    badge=${loud ? html`<span class="usage-throttled-badge" title="Currently rate-limited">⛔ throttled</span>` : null}
  />`;
}

function summarizeUsage(data) {
  if (!data) return '…';
  if (data.status === 'ok') {
    const pcts = (data.windows || []).map((w) => w.percent).filter((p) => typeof p === 'number');
    return pcts.length ? Math.round(Math.max(...pcts)) + '%' : 'ok';
  }
  if (data.status === 'token-expired') return 'expired';
  return 'not detected';
}

// Kimi's contribution to the collapsed-section summary — a server state, not a
// percentage, because there is no quota to summarize. Returns null when Kimi
// isn't installed so the summary string stays untouched on machines without it.
function summarizeKimi(data) {
  if (!data || data.status === 'not-installed') return null;
  if (data.status === 'error') return 'unavailable';
  if (!data.server) return 'not running';
  return KIMI_STATE_LABEL[data.server.state] || data.server.state || 'unknown';
}

// Same contract as summarizeKimi: a state word, never a percentage, and null on
// machines without the Antigravity CLI so the summary string is untouched there.
function summarizeGemini(data) {
  if (!data || data.status === 'not-installed') return null;
  if (data.status === 'error') return 'unavailable';
  if (data.auth && data.auth.state === 'signed-out') return 'signed out';
  if (!data.server) return 'not running';
  return KIMI_STATE_LABEL[data.server.state] || data.server.state || 'unknown';
}

// Version + "update available" chips for the Claude Code / Codex CLIs,
// mirroring the bd-version chips in OpsStrip but sized down to match
// .usage-plan-chip (this row is ~1/3-width, not the full-bleed ops strip —
// see the .usage-version-chip / .usage-update-chip comment in styles.css).
// Reads store.cliVersions (GET /api/cli-versions, one-shot fetch — see the
// QuotaSessionsRow effect below) and renders nothing at all when the tool
// isn't installed, its info is missing, or the endpoint never came back —
// exactly like a machine without Codex looks today.
//
// multipleBinaries (a shadowed second install of the same CLI on PATH) is
// folded INTO the version chip rather than given a fourth sibling chip. At
// this card's real width — ~350px, one 1fr column of .hub-qs-grid — the codex
// row already runs name + version + update + plan edge to edge, and a
// standalone "⚠️ multiple on PATH" chip pushed the head from one line to
// three and became the widest, loudest thing on a card whose entire job is
// quota (measured, not guessed). Folding it in also matches what the warning
// actually says: it is a statement ABOUT which binary produced that version
// string, not an independent fact. The glyph vocabulary from the ops strip is
// preserved exactly — 🏷️ still means "version", ⚠️ still means "multiple on
// PATH"; only the packaging changes, because there is no room for two chips.
// The full binary list (active first) lives in the title, and the chip is
// never emoji-alone: it carries the version text, a dashed border, and
// cursor:help, the same "hover me, I'm not a button" language .hub-chip-warn
// uses in the ops strip.
function CliVersionChips({ name }) {
  const info = store.cliVersions.value[name];
  if (!info || !info.installed) return null;
  const behind = info.behind === true && info.latest;
  const bins = info.binaries || [];
  const multi = info.multipleBinaries === true && bins.length > 1;
  const checkTitle = `Installed — from \`${name} --version\`` + (info.checkedAt ? ' · checked ' + timeAgo(info.checkedAt) : '');
  const multiTitle = multi
    ? `⚠ ${bins.length} \`${name}\` binaries on PATH — the first one is what actually runs:\n`
      + bins.map((b, i) => `${i + 1}. ${b}${i === 0 ? '  (active)' : '  (shadowed)'}`).join('\n')
      + '\n\nThe version above is the active one. A shadowed install can update without anything here changing.'
    : '';
  return html`
    <span class="usage-cli-chips">
      ${/* No newline between the tag and the closing brace: htm would keep
            the indentation as leading text inside the pill. */ ''}
      <span class=${'usage-version-chip' + (multi ? ' has-multi' : '')}
        title=${multi ? checkTitle + '\n\n' + multiTitle : checkTitle}
      >🏷️ ${info.installed}${multi && html`<span class="usage-multi-mark" aria-hidden="true">⚠️</span>`}</span>
      ${behind && (info.updateHint
        ? html`<button type="button" class="usage-update-chip" title=${`Update available: ${info.latest} — copy: ${info.updateHint}`}
            onClick=${() => copyUpdateCommand(info.updateHint)}>⬆️ ${info.latest}</button>`
        : html`<span class="usage-update-chip" title=${`A newer release (${info.latest}) is available`}>⬆️ ${info.latest}</span>`)}
    </span>`;
}

// Shared shell for every provider row's "nothing to show but a reason" state
// (bd-console-974.7 dedupe) — ProviderUsageRow (3 of its 4 branches),
// KimiUsageRow and GeminiUsageRow all rendered this exact
// name-chip-plus-muted-note shape independently. `extra` is the optional
// version-chips node; only ProviderUsageRow's Claude/Codex rows pass one —
// Kimi/Gemini's version chips ride in their OWN head row instead (see
// KimiServerChip/GeminiServerChip), not this quiet fallback.
function UsageRowQuiet({ label, extra = null, note, noteTitle }) {
  return html`
    <div class="usage-row usage-row-quiet">
      <span class="usage-row-quiet-name">
        <span class="usage-provider-name">${label}</span>
        ${extra}
      </span>
      <span class="muted small" title=${noteTitle}>${note}</span>
    </div>`;
}

function ProviderUsageRow({ name, data }) {
  const label = PROVIDER_LABEL[name] || name;
  const versionChips = html`<${CliVersionChips} name=${name} />`;

  if (!data || data.status === 'no-creds' || data.status === 'no-data') {
    return html`<${UsageRowQuiet} label=${label} extra=${versionChips} note="not detected" />`;
  }
  if (data.status === 'token-expired') {
    return html`<${UsageRowQuiet} label=${label} extra=${versionChips} note=${data.message || 'open Claude Code to refresh'} />`;
  }
  if (data.status === 'error' || data.status === 'rate-limited') {
    // Rate-limited is not the same failure as "usage unavailable": the server
    // is deliberately holding off, and ↻ will not change that until the
    // backoff lifts. Say when, so a refresh that returns the same numbers
    // reads as expected rather than broken.
    const retryIn = data.status === 'rate-limited' ? retryInText(data.retryAt) : null;
    const note = data.status === 'rate-limited'
      ? (data.message || 'rate-limited; backing off') + (retryIn ? ' · retrying ' + retryIn : '')
      : 'usage unavailable';
    const noteTitle = data.status === 'rate-limited'
      ? 'The provider rate-limited the usage endpoint. Showing the last cached answer; refresh is intentionally ignored until the backoff lifts.'
      : '';
    return html`<${UsageRowQuiet} label=${label} extra=${versionChips} note=${note} noteTitle=${noteTitle} />`;
  }

  return html`
    <div class="usage-row">
      <div class="usage-row-head">
        <span class="usage-provider-name">${label}</span>
        <${CliVersionChips} name=${name} />
        ${data.plan && html`<span class="usage-plan-chip"
          title=${name === 'claude'
            ? 'Plan as recorded at your last Claude Code login — run /login in Claude Code to refresh (usage percentages are computed server-side against your real limits either way)'
            : 'Plan reported live by the provider'}>${data.plan}</span>`}
        ${name === 'codex' && data.asOf && html`<span class="muted small usage-asof">as of ${timeAgo(data.asOf)}</span>`}
      </div>
      <div class="usage-gauges">
        ${(data.windows || []).length === 0
          ? html`<span class="muted small">no quota data</span>`
          : data.windows.map((w) => html`<${UsageGauge} key=${w.id} w=${w} />`)}
        ${(data.scopedLimits || []).length > 0 && html`
          <div class="usage-scoped-limits">
            ${data.scopedLimits.map((lim) => html`<${ScopedLimitRow} key=${lim.model} lim=${lim} />`)}
          </div>`}
      </div>
    </div>`;
}

// Kimi Code (`kimi web`) — GET /api/usage's `kimi` block. Deliberately NOT
// rendered through ProviderUsageRow: Kimi publishes no quota anywhere (see the
// Kimi section in lib/usage.mjs), so a gauge here would be invented. What it
// does have is stack info — is the server beating, which version, where it
// listens, how many sessions/workspaces, and what the newest session spent —
// so this row carries chips + facts instead of bars, in the same card language.
//
// Renders NOTHING when Kimi isn't installed (status 'not-installed', or the
// block missing entirely on an older server), exactly like a machine without
// Codex looks in the rows above.
const KIMI_STATE_LABEL = { running: 'running', stale: 'stale', stopped: 'stopped' };

// Last "/"-separated segment — "kimi-code/k3" -> "k3" for model ids (the
// provider prefix is identical on every Kimi model and just eats width in a
// ~350px card), and "/home/me/code/thing" -> "thing" for the fallback
// workspace name when workspaces.json didn't name it.
function lastSegment(value) {
  if (!value) return null;
  const trimmed = value.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function KimiServerChip({ server }) {
  if (!server) {
    return html`<span class="usage-state-chip state-stopped"
      title=${'No `kimi web` server record in ~/.kimi-code/server/instances'}>○ not running</span>`;
  }
  const state = KIMI_STATE_LABEL[server.state] || server.state || 'unknown';
  const age = typeof server.heartbeatAgeMs === 'number' ? Math.max(0, Math.round(server.heartbeatAgeMs / 1000)) : null;
  const staleAfter = typeof server.staleAfterMs === 'number' ? Math.round(server.staleAfterMs / 1000) : null;
  // Never state-by-color-alone: the glyph and the word both change with state.
  const glyph = server.state === 'running' ? '●' : server.state === 'stale' ? '◐' : '○';
  const title = [
    age != null ? `Heartbeat ${age}s ago` : 'No heartbeat recorded',
    staleAfter != null ? `the server rewrites it every 15s; treated as stale after ${staleAfter}s` : null,
    server.state === 'stale' ? 'the process still exists but stopped beating' : null,
    server.instances > 1 ? `${server.instances} instance records on disk (newest shown)` : null
  ].filter(Boolean).join(' — ');
  return html`<span class=${'usage-state-chip state-' + (server.state || 'stopped')} title=${title}>${glyph} ${state}</span>`;
}

function KimiUsageRow({ data }) {
  if (!data || data.status === 'not-installed') return null;

  const label = PROVIDER_LABEL.kimi;
  if (data.status === 'error' || data.status === 'no-data') {
    return html`<${UsageRowQuiet} label=${label} note=${data.status === 'no-data' ? 'installed · no sessions yet' : 'stack info unavailable'} />`;
  }

  const server = data.server;
  const sessions = data.sessions || { total: 0, workspaces: [] };
  const workspaces = sessions.workspaces || [];
  const latest = data.latestSession;
  const endpoint = server && server.port ? `${server.host || '127.0.0.1'}:${server.port}` : null;
  const tokens = latest && latest.tokens ? latest.tokens : null;

  return html`
    <div class="usage-row">
      <div class="usage-row-head">
        <span class="usage-provider-name">${label}</span>
        ${server && server.version && html`<span class="usage-version-chip"
          title=${'`kimi web` host version, as recorded by the server itself'}>🏷️ ${server.version}</span>`}
        <${KimiServerChip} server=${server} />
        ${data.asOf && html`<span class="muted small usage-asof">as of ${timeAgo(data.asOf)}</span>`}
      </div>
      <div class="usage-kimi-facts">
        ${endpoint && html`<span class="usage-kimi-endpoint" title="Address the kimi web server recorded for itself">${endpoint}</span>`}
        <span>${sessions.total} session${sessions.total === 1 ? '' : 's'}${workspaces.length
          ? ` · ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`
          : ''}</span>
      </div>
      ${latest && html`
        <div class="usage-kimi-latest" title=${[
          latest.title || null,
          latest.workDir || null,
          tokens ? `${tokens.input.toLocaleString()} in · ${tokens.output.toLocaleString()} out · ${tokens.cacheRead.toLocaleString()} cache read` : null,
          tokens && tokens.truncated ? 'token totals partial — session logs exceeded the read budget' : null
        ].filter(Boolean).join('\n')}>
          <span class="usage-kimi-latest-label">latest</span>
          <span class="usage-kimi-latest-name">${latest.workspaceName || lastSegment(latest.workDir) || latest.title || latest.id}</span>
          ${latest.model && html`<span class="usage-kimi-model">${lastSegment(latest.model)}</span>`}
          ${tokens && tokens.total > 0 && html`<span class="muted small">${formatTokens(tokens.total)} tokens${tokens.truncated ? '+' : ''}</span>`}
          ${tokens && tokens.turns > 0 && html`<span class="muted small">· ${tokens.turns} turn${tokens.turns === 1 ? '' : 's'}</span>`}
        </div>`}
    </div>`;
}

// Gemini / Antigravity CLI (`agy`) — GET /api/usage's `gemini` block. Same
// treatment and same reason as KimiUsageRow above: the provider publishes no
// limit, no utilization and no reset instant anywhere the CLI writes down (see
// the Gemini section in lib/usage.mjs), so a gauge here would be fabricated.
// Chips + facts instead of bars.
//
// The ONE quota fact that is real is `quota.lastExhaustedAt` — not "how much is
// left" but "the API answered 429 RESOURCE_EXHAUSTED, at this instant". It gets
// an amber chip, and only when it actually happened, so a healthy machine sees
// nothing. Renders NOTHING at all when the CLI isn't installed, exactly like
// the Codex and Kimi rows on a machine without them.
//
// That chip is deliberately understated (bd-console-a2h). The server now counts
// INCIDENTS rather than log lines — the CLI logs one 429 up to three times as it
// propagates — and says when the request that hit the limit was the CLI's own
// background cache refresh. "background quota hit" is the honest wording for a
// poller tripping a limit while the user hasn't touched the CLI in weeks; the
// chip must never read as "you burned your quota" when nobody did.
function GeminiServerChip({ server, auth }) {
  if (!server) {
    return html`<span class="usage-state-chip state-stopped"
      title="No language-server log in ~/.gemini/antigravity-cli/log">○ not running</span>`;
  }
  const state = KIMI_STATE_LABEL[server.state] || server.state || 'unknown';
  const idle = typeof server.logIdleMs === 'number' ? Math.max(0, Math.round(server.logIdleMs / 1000)) : null;
  const idleAfter = typeof server.idleAfterMs === 'number' ? Math.round(server.idleAfterMs / 1000) : null;
  const glyph = server.state === 'running' ? '●' : server.state === 'stale' ? '◐' : '○';
  const title = [
    idle != null ? `Language server last wrote to its log ${idle}s ago` : 'No log activity recorded',
    idleAfter != null ? `a live CLI refreshes every ~6 min; treated as gone quiet after ${idleAfter}s` : null,
    server.state === 'stale' ? `pid ${server.pid} still exists but the log went quiet` : null,
    auth && auth.state === 'signed-out' ? 'not signed in to Antigravity' : null
  ].filter(Boolean).join(' — ');
  return html`<span class=${'usage-state-chip state-' + (server.state || 'stopped')} title=${title}>${glyph} ${state}</span>`;
}

function GeminiUsageRow({ data }) {
  if (!data || data.status === 'not-installed') return null;

  const label = PROVIDER_LABEL.gemini;
  if (data.status === 'error' || data.status === 'no-data') {
    return html`<${UsageRowQuiet} label=${label} note=${data.status === 'no-data' ? 'installed · no sessions yet' : 'stack info unavailable'} />`;
  }

  const server = data.server;
  const auth = data.auth || { state: 'unknown', method: null };
  const convos = data.conversations || { total: 0, workspaces: [], latest: null };
  const workspaces = convos.workspaces || [];
  const latest = convos.latest;
  const quota = data.quota || {};
  const exhaustedAt = typeof quota.lastExhaustedAt === 'number' ? quota.lastExhaustedAt : null;
  const httpPort = (server && (server.ports || []).find((p) => p.protocol === 'http')) || null;

  return html`
    <div class="usage-row">
      <div class="usage-row-head">
        <span class="usage-provider-name">${label}</span>
        ${server && server.version && html`<span class="usage-version-chip"
          title="Antigravity language-server version, as the CLI logged it at startup">🏷️ ${server.version}</span>`}
        <${GeminiServerChip} server=${server} auth=${auth} />
        ${auth.state === 'signed-out' && html`<span class="usage-state-chip"
          title="The CLI's log says it is not signed in to Antigravity">○ signed out</span>`}
        ${data.asOf && html`<span class="muted small usage-asof">as of ${timeAgo(data.asOf)}</span>`}
      </div>
      <div class="usage-gemini-facts">
        ${httpPort && html`<span class="usage-gemini-endpoint" title="Local language-server HTTP port the CLI bound at startup">127.0.0.1:${httpPort.port}</span>`}
        <span>${convos.total} conversation${convos.total === 1 ? '' : 's'}${workspaces.length
          ? ` · ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`
          : ''}</span>
        <span title=${'Gemini/Antigravity publishes no quota numbers anywhere on disk — '
          + 'the only quota fact available is whether the API returned 429 RESOURCE_EXHAUSTED'}>no quota published</span>
        ${exhaustedAt && html`<span class="usage-gemini-throttle" title=${[
          `${quota.exhaustedEvents} RESOURCE_EXHAUSTED (429) incident${quota.exhaustedEvents === 1 ? '' : 's'} in the scanned log tail`,
          quota.exhaustedLogLines > quota.exhaustedEvents
            ? `${quota.exhaustedLogLines} log lines — the CLI logs one failure up to three times as it propagates`
            : null,
          quota.lastExhaustedOrigin === 'background'
            ? 'logged by the CLI\'s own background cache refresh, not by anything you asked it to do'
            : null
        ].filter(Boolean).join('\n')}>⚠️ ${quota.lastExhaustedOrigin === 'background' ? 'background quota hit' : 'quota hit'} ${timeAgo(exhaustedAt)}</span>`}
      </div>
      ${latest && html`
        <div class="usage-gemini-latest" title=${[
          latest.title || null,
          latest.workspace || null,
          latest.app ? `recorded under ~/.gemini/${latest.app}` : null
        ].filter(Boolean).join('\n')}>
          <span class="usage-gemini-latest-label">latest</span>
          <span class="usage-gemini-latest-name">${lastSegment(latest.workspace) || latest.title || latest.id}</span>
          ${latest.steps > 0 && html`<span class="muted small">${latest.steps} step${latest.steps === 1 ? '' : 's'}</span>`}
          ${latest.updatedAt && html`<span class="muted small">· ${timeAgo(latest.updatedAt)}</span>`}
        </div>`}
    </div>`;
}

// Manual "↻ refresh" — reloads both the live-quota gauges and the (heavier)
// attribution history at whatever range is currently selected.
//
// This is the human fast path, so the quota call asks the server to bypass its
// own 5-minute OK-cache (?fresh=1). The server can still legitimately answer
// from cache — during a 429 backoff, or when ↻ was clicked seconds ago — and
// says so with `cached: true`. A button that silently does nothing is worse
// than one that explains itself, so toast the reason in that case; a genuinely
// fresh answer just re-renders the gauges and stays quiet.
async function refreshUsageAll() {
  loadUsageHistory();
  const providers = await loadUsage({ fresh: true });
  const claude = providers && providers.claude;
  if (!claude || !claude.cached) return;
  if (claude.status === 'rate-limited') {
    const when = retryInText(claude.retryAt);
    toast(`Claude usage is rate-limited — showing cached data${when ? ', retrying ' + when : ''}`, 'warn', 6000);
  } else {
    toast('Claude usage was just refreshed — showing cached data', 'info', 3200);
  }
}

// "in Xm" / "in Xh Ym" for a server-supplied retryAt (when a 429 backoff
// lifts), or null when there's nothing useful to say.
function retryInText(retryAt) {
  if (!retryAt) return null;
  const mins = Math.round((retryAt - Date.now()) / 60000);
  if (mins <= 0) return 'shortly';
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function HistoryRangePicker({ days, onChange }) {
  return html`
    <div class="usage-range-picker" role="group" aria-label="History range">
      ${HISTORY_RANGE_OPTIONS.map((d) => html`
        <button key=${d} type="button" class=${'usage-range-btn' + (d === days ? ' active' : '')}
          aria-pressed=${d === days} onClick=${() => onChange(d)}>${d}d</button>`)}
      <button type="button" class="icon-btn usage-refresh-btn" title="Refresh usage" onClick=${refreshUsageAll}>↻</button>
    </div>`;
}

// Attribution band — GET /api/usage/history. Clearly headed as historical/
// estimated (NOT quota) since it comes from parsing local session logs
// rather than the provider's own usage endpoint. Degrades to nothing when
// the route itself is unavailable (older server, or backend still landing);
// individual providers degrade to a "gathering usage…" note via
// ProviderAttribution when the route works but has no data yet.
//
// Its own collapse toggle (id 'attrib'), separate from the live-quota
// section's 'usage' id — and unlike every other hub-section toggle, this one
// collapses at EVERY viewport, not just <=768px (see .usage-attrib-head /
// .usage-attrib-body.collapsed in styles.css, deliberately not gated by the
// mobile media query). Defaults to collapsed (store.js) so project cards sit
// higher on the page without the heavier chart content pushing them down;
// still fully expandable, and the choice persists like every other hub
// section's collapse state.
// One-line "worth opening" teaser shown next to the collapsed head — total
// tokens across both providers over the current range, so the collapsed
// state still communicates there's real content underneath instead of
// reading as an empty/optional section.
function attribTeaser(history, days) {
  const total = (history?.claude?.totalTokens || 0) + (history?.codex?.totalTokens || 0);
  if (!total) return null;
  return `${formatTokens(total)} tokens · last ${days}d`;
}

export function AttributionBand() {
  const days = store.usageHistoryDays.value;
  useEffect(() => { loadUsageHistory(days); }, []);
  // Skips ticks while the tab is hidden and catches up on return — see
  // public/ui/poll.js. Reads the range signal fresh on every tick rather
  // than closing over `days`, so a range change while this poll is already
  // running keeps polling the newly selected range instead of the one that
  // was active when the effect first mounted.
  useVisiblePoll(() => loadUsageHistory(store.usageHistoryDays.value), USAGE_HISTORY_POLL_MS);

  // Previously rendered nothing at all on any failure (404/401/500/network),
  // indistinguishable from "this server predates the route". A muted
  // one-liner at least says whether it's worth a reload.
  if (!store.usageHistoryAvailable.value) {
    return html`<p class="muted small">Usage attribution unavailable${store.usageHistoryAvailableReason.value ? `: ${store.usageHistoryAvailableReason.value}` : ''}.</p>`;
  }
  const collapsed = store.collapsedHubSections.value.has('attrib');
  const history = store.usageHistory.value;

  // The heading is styled to match its siblings exactly ("Live quota",
  // "Terminal sessions", "Tracked Projects" — all .hub-section-head h2): this
  // band is one section among several, and a heading that shouts louder than
  // the others just reads as inconsistent. What carries the weight instead is
  // the expand affordance, which is a real .hub-chip — the same chip treatment
  // as the ops strip — rather than a quiet word that could be mistaken for a
  // label. The chip is a <span>, not a <button>: the whole head IS the button,
  // and a nested button would be invalid markup and a second tab stop for one
  // action. The teaser (token total over the range) stays on the heading line
  // so the collapsed state still says there's something underneath.
  const head = (summary, teaser) => html`
    <button type="button" class="usage-attrib-head" aria-expanded=${!collapsed} onClick=${() => toggleHubSection('attrib')}>
      <span class="usage-band-label">
        Usage attribution
        <span class="muted small">· ${summary}${teaser ? ' · ' + teaser : ''}</span>
      </span>
      <span class="hub-chip usage-attrib-chip" data-attrib-toggle>${collapsed ? 'Show more' : 'Show less'}</span>
      <${ChevronIcon} open=${!collapsed} alwaysVisible=${true} />
    </button>`;

  if (!history) {
    return html`
      <div class="usage-band usage-attrib-band">
        ${head('estimated, not quota')}
        <div class=${'usage-attrib-body' + (collapsed ? ' collapsed' : '')}>
          <p class="muted small usage-empty">${store.usageHistoryLoading.value ? 'Gathering usage…' : 'No usage history yet.'}</p>
        </div>
      </div>`;
  }

  const claude = history.claude ? { ...history.claude, _days: days } : null;
  const codex = history.codex ? { ...history.codex, _days: days } : null;

  return html`
    <div class="usage-band usage-attrib-band">
      ${head('estimated from local session logs, not quota', attribTeaser(history, days))}
      <div class=${'usage-attrib-body' + (collapsed ? ' collapsed' : '')}>
        <div class="usage-band-head usage-attrib-controls">
          <${HistoryRangePicker} days=${days} onChange=${(d) => loadUsageHistory(d)} />
        </div>
        <${ProviderAttribution} label="Claude Code" data=${claude} showProjectCharts=${true} />
        <${ProviderAttribution} label="Codex" data=${codex} showProjectCharts=${false} />
      </div>
    </div>`;
}

// Live quota (left, ~1/3) + terminal sessions (right, ~2/3), side by side at
// equal height — see .hub-qs-grid in styles.css. Both halves keep their own
// pre-existing collapse id ('usage' for quota, 'tmux' for sessions) and the
// same hub-section-toggle-inline/hub-section-body markup every other hub
// section uses, so the existing <=768px mobile-collapse behavior (and the
// "desktop is unaffected" CSS gating that comes with it) is untouched — at
// that breakpoint the grid also drops to a single column (styles.css) so the
// two halves simply stack full-width in the same top-to-bottom order as
// before this change (quota above sessions).
//
// This function owns the live-quota poll effect and is always called
// unconditionally from HubView (never short-circuited by `&&`) so that hook
// stays at a stable position across renders even though either half — or
// both — can independently render nothing.
export function QuotaSessionsRow() {
  useEffect(() => {
    loadUsage();
    // One-shot, NOT part of the poll below — the server caches the CLI
    // registry lookup for hours (same reasoning as loadBdVersion() in
    // OpsStrip), so polling it on USAGE_POLL_MS would just re-read the same
    // cached value for no benefit.
    loadCliVersions();
  }, []);
  // Skips ticks while the tab is hidden and catches up on return — see
  // public/ui/poll.js, which is where this behavior now lives so that
  // ScheduleView's usage poll gets it too instead of a copy.
  useVisiblePoll(() => loadUsage(), USAGE_POLL_MS);

  const projects = store.projects.value;
  const hasProjects = Object.keys(projects).length > 0;
  const showQuota = store.usageAvailable.value;
  // Preserves the old TmuxSection's "hide entirely with zero registered
  // projects" behavior in addition to the tmux-unavailable case.
  const showSessions = hasProjects && store.tmuxAvailable.value;
  if (!showQuota && !showSessions) return null;

  const usage = store.usage.value || {};
  const usageCollapsed = store.collapsedHubSections.value.has('usage');
  // Kimi joins the collapsed-state summary only when it's actually installed —
  // on a machine without it the summary reads exactly as it did before.
  const usageSummary = `Claude ${summarizeUsage(usage.claude)} · Codex ${summarizeUsage(usage.codex)}`
    + (summarizeKimi(usage.kimi) ? ` · Kimi ${summarizeKimi(usage.kimi)}` : '')
    + (summarizeGemini(usage.gemini) ? ` · Gemini ${summarizeGemini(usage.gemini)}` : '');

  const sessions = store.tmuxSessions.value;
  const tmuxCollapsed = store.collapsedHubSections.value.has('tmux');
  const attached = sessions.filter((s) => s.attached).length;
  const unattended = sessions.filter((s) => s && s.idle).length;
  const hotSessions = sessions.filter((s) => s && s.memory && s.memory.level !== 'ok').length;
  const tmuxSummary = `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${attached} attached`
    + (hotSessions > 0 ? ` · ${hotSessions} high memory` : '')
    + (unattended > 0 ? ` · ${unattended} unattended` : '');

  return html`
    <div class=${'hub-qs-grid' + (showQuota && showSessions ? '' : ' single-col')}>
      ${showQuota && html`
        <section class="hub-section hub-qs-quota">
          <div
            class="hub-section-head hub-section-toggle-inline"
            role="button"
            tabIndex="0"
            aria-expanded=${!usageCollapsed}
            onClick=${() => toggleHubSection('usage')}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHubSection('usage'); } }}
          >
            <h2>Live quota</h2>
            <span class="hub-section-toggle-summary">${usageSummary}</span>
            <${ChevronIcon} open=${!usageCollapsed} />
          </div>
          <div class=${'hub-section-body' + (usageCollapsed ? ' collapsed' : '')}>
            <div class="usage-rows">
              <${ProviderUsageRow} name="claude" data=${usage.claude} />
              <${ProviderUsageRow} name="codex" data=${usage.codex} />
              <${KimiUsageRow} data=${usage.kimi} />
              <${GeminiUsageRow} data=${usage.gemini} />
            </div>
          </div>
        </section>`}
      ${showSessions && html`
        <section class="hub-section hub-qs-sessions">
          <div
            class="hub-section-head hub-section-toggle-inline"
            role="button"
            tabIndex="0"
            aria-expanded=${!tmuxCollapsed}
            onClick=${() => toggleHubSection('tmux')}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHubSection('tmux'); } }}
          >
            <h2>Terminal sessions</h2>
            <span class="hub-section-toggle-summary">${tmuxSummary}</span>
            ${sessions.length > 0 && html`<button class="btn btn-ghost btn-xs" onClick=${(e) => { e.stopPropagation(); navigate('#/tmux'); }}>View all →</button>`}
            <${ChevronIcon} open=${!tmuxCollapsed} />
          </div>
          <div class=${'hub-section-body' + (tmuxCollapsed ? ' collapsed' : '')}>
            ${sessions.length === 0
              ? html`<p class="muted small hub-section-empty">No tmux sessions running.</p>`
              : html`<div class="hub-sessions-scroll"><div class="hub-tmux-rows">
                  <${HubTmuxHead} />
                  ${sessions.map((s) => html`<${SessionRowCompact} key=${s.name} session=${s} projects=${projects} onClick=${() => navigate('#/tmux')} />`)}
                </div></div>`}
          </div>
        </section>`}
    </div>`;
}
