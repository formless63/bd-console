// SettingsView.js — hub-level #/settings route. Replaces the old modal token
// dialog: a read-only enumeration of server settings (GET /api/settings),
// plus two writable token controls — the browser's own localStorage token,
// and (token-gated) the server's write token via POST /api/settings.
// Degrades gracefully if /api/settings 404s (server hasn't landed it yet):
// the read-only panel is hidden but the browser-token control still works.
import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import {
  store, loadSettings, saveServerToken, toast, loadHub, loadBdVersion,
  loadEpicsForProject, saveDefaultEpics, createStandardEpics, DEFAULT_EPIC_INTENTS,
} from '../store.js';
import { getToken, setToken } from '../api.js';
import { THEME_PRESETS, SCHEMES, setPreset, setScheme } from '../theme.js';
import { EpicCombobox, timeAgo, copyToClipboard, CopyIcon } from './common.js';

const FLAVOR_LABEL = { brew: 'Homebrew', npm: 'npm', script: 'install script', unknown: 'unknown' };
// Shown when installFlavor can't be determined (or there's no updateHint) —
// per bd-console-ht3: "when unsure, show the options rather than guessing
// wrong" instead of picking a command that might not match how bd got here.
const ALL_UPDATE_OPTIONS = [
  ['Homebrew', 'brew upgrade beads'],
  ['install script', 'curl -sSL https://raw.githubusercontent.com/gastownhall/beads/main/scripts/install.sh | bash'],
  ['npm', 'npm i -g @beads/bd@latest'],
];

async function copyCommand(cmd) {
  const ok = await copyToClipboard(cmd);
  toast(ok ? `Copied "${cmd}"` : cmd, ok ? 'ok' : 'warn', ok ? 3200 : 8000);
}

function CopyCommandButton({ cmd }) {
  return html`
    <button type="button" class="icon-btn icon-btn-xs bd-version-copy-btn" title="Copy update command"
      aria-label="Copy update command" onClick=${() => copyCommand(cmd)}><${CopyIcon} /></button>`;
}

// Fuller "Beads CLI" card: installed/latest/checked-at/flavor, the update
// command (with a copy button) when one can be determined, and a warning
// listing every `bd` found on PATH when more than one exists — the exact
// trap that motivated this feature (see lib/bdversion.mjs's module doc): an
// `npm i -g @beads/bd@latest` can "succeed" and change nothing if a
// different `bd` earlier on PATH shadows it.
function BdVersionPanel() {
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadBdVersion(); }, []);
  const available = store.bdVersionAvailable.value;
  const v = store.bdVersion.value;

  const recheck = async () => {
    setBusy(true);
    try { await loadBdVersion({ force: true }); } finally { setBusy(false); }
  };

  return html`
    <section class="settings-card">
      <h2 class="settings-card-title">Beads CLI</h2>
      ${!available
        ? html`<p class="muted small">Version-check endpoint isn't available on this server yet (<code>GET /api/bd-version</code> 404s).</p>`
        : !v
          ? html`<p class="muted small">Checking…</p>`
          : html`
            <div class="settings-kv">
              <div class="settings-row">
                <span class="settings-k">Installed</span>
                <span class="settings-v">${v.installed ? html`<code>${v.installed}</code>` : html`<span class="muted">${v.error || 'not detected'}</span>`}</span>
              </div>
              <div class="settings-row">
                <span class="settings-k">Latest</span>
                <span class="settings-v">
                  ${v.latest
                    ? html`<code>${v.latest}</code>`
                    : html`<span class="muted">unknown${v.latestSource == null ? ' (offline or rate-limited)' : ''}</span>`}
                  ${v.behind === true && html`<span class="badge bd-behind-badge">update available</span>`}
                  ${v.behind === false && v.latest && html`<span class="badge bd-uptodate-badge">up to date</span>`}
                </span>
              </div>
              <div class="settings-row">
                <span class="settings-k">Checked</span>
                <span class="settings-v muted small">${v.checkedAt ? timeAgo(v.checkedAt) : '—'} <span class="muted">(${v.latestSource || 'no data'})</span></span>
              </div>
              <div class="settings-row">
                <span class="settings-k">Install</span>
                <span class="settings-v">${FLAVOR_LABEL[v.installFlavor] || v.installFlavor || 'unknown'}</span>
              </div>
            </div>

            ${v.updateHint
              ? html`
                <div class="bd-update-cmd-row">
                  <code class="bd-update-cmd">${v.updateHint}</code>
                  <${CopyCommandButton} cmd=${v.updateHint} />
                </div>`
              : v.installed && html`
                <div class="bd-update-options">
                  <p class="muted small">Install method unclear — pick the one that matches how <code>bd</code> got here:</p>
                  ${ALL_UPDATE_OPTIONS.map(([label, cmd]) => html`
                    <div key=${label} class="bd-update-cmd-row">
                      <span class="bd-update-cmd-label muted small">${label}</span>
                      <code class="bd-update-cmd">${cmd}</code>
                      <${CopyCommandButton} cmd=${cmd} />
                    </div>`)}
                </div>`}

            ${v.multipleBinaries && html`
              <div class="form-warn bd-multi-warn">
                <p class="bd-multi-warn-title">⚠ Multiple <code>bd</code> binaries found on PATH — the first one is what actually runs:</p>
                <ul class="bd-multi-warn-list">
                  ${v.binaries.map((b, i) => html`<li key=${b}><code>${b}</code>${i === 0 ? ' (active)' : ''}</li>`)}
                </ul>
                <p class="muted small">Remove the duplicate(s) to avoid updating the wrong one.</p>
              </div>`}

            ${v.error && !v.installed && html`<p class="form-warn">${v.error}</p>`}
          `}
      <div class="settings-form-row">
        <button class="btn btn-ghost" disabled=${busy || !available} onClick=${recheck}>${busy ? 'Checking…' : 'Recheck'}</button>
      </div>
    </section>`;
}

const INTENT_CARD_LABEL = { bug: 'Bug', feature: 'Feature', task: 'Task', idea: 'Idea / triage', chore: 'Chore' };

const SOURCE_LABEL = { flag: 'flag', env: 'env', config: 'config', default: 'default' };

function SourceChip({ source }) {
  if (!source) return null;
  return html`<span class=${'source-chip src-' + source}>${SOURCE_LABEL[source] || source}</span>`;
}

function mask(t) {
  if (!t) return '';
  return t.length <= 4 ? '••••' : t.slice(0, 4) + '…';
}

function ServerSettingsPanel() {
  const s = store.settings.value;
  const settings = s?.settings || {};
  return html`
    <section class="settings-card">
      <h2 class="settings-card-title">Server settings</h2>
      <div class="settings-kv">
        <div class="settings-row">
          <span class="settings-k">Host</span>
          <span class="settings-v"><code>${settings.host?.value ?? '—'}</code></span>
          <${SourceChip} source=${settings.host?.source} />
        </div>
        <div class="settings-row">
          <span class="settings-k">Port</span>
          <span class="settings-v"><code>${settings.port?.value ?? '—'}</code></span>
          <${SourceChip} source=${settings.port?.source} />
        </div>
        <div class="settings-row">
          <span class="settings-k">Persist</span>
          <span class="settings-v"><code>${String(settings.persist?.value ?? '—')}</code></span>
          <${SourceChip} source=${settings.persist?.source} />
        </div>
        <div class="settings-row">
          <span class="settings-k">Write token</span>
          <span class="settings-v">${settings.token?.set ? html`<code>${settings.token.masked || 'set'}</code>` : html`<span class="muted">not set</span>`}</span>
          <${SourceChip} source=${settings.token?.source} />
        </div>
      </div>
      <p class="muted small settings-hint">
        Host, port, and persist are CLI-managed — change them with <code>bd-console settings</code> on the server host, then restart.
      </p>
      ${s?.configPath && html`<p class="muted small settings-path">Config file: <code>${s.configPath}</code></p>`}
      ${s?.note && html`<p class="muted small settings-note">${s.note}</p>`}
    </section>`;
}

// Appearance — themes are settings too, and this gives mobile a second
// discoverable path to them beyond the topbar's ◐ popover (components/
// ThemeSwitch.js). Reuses ../theme.js's setPreset/setScheme directly, same
// as every other theme control in the app, so there's nothing to keep in
// sync — this is just another view onto the same store signals.
function AppearancePanel() {
  const preset = store.themePreset.value;
  const scheme = store.themeScheme.value;
  return html`
    <section class="settings-card">
      <h2 class="settings-card-title">Appearance</h2>
      <p class="muted small">Theme preset and light/dark scheme — applies immediately and persists in this browser.</p>
      <div class="edit-block">
        <span class="edit-label">Preset</span>
        <select class="edit-input theme-switch-select" value=${preset} onChange=${(e) => setPreset(e.target.value)}>
          ${THEME_PRESETS.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
        </select>
      </div>
      <div class="edit-block">
        <span class="edit-label">Scheme</span>
        <div class="theme-switch-scheme">
          ${SCHEMES.map((s) => html`
            <button
              key=${s.id}
              type="button"
              class=${'theme-switch-mini' + (scheme === s.id ? ' on' : '')}
              aria-pressed=${scheme === s.id}
              onClick=${() => setScheme(s.id)}
            >${s.name}</button>`)}
        </div>
      </div>
    </section>`;
}

function BrowserTokenPanel() {
  const [value, setValue] = useState(getToken());
  const current = getToken();

  const save = () => {
    setToken(value.trim());
    toast(value.trim() ? 'Browser token saved' : 'Browser token cleared');
  };
  const clear = () => { setToken(''); setValue(''); toast('Browser token cleared'); };

  return html`
    <section class="settings-card">
      <h2 class="settings-card-title">Browser token</h2>
      <p class="muted small">
        The token this browser sends as <code>x-bd-token</code> on writes. Stored only in this browser's
        <code>localStorage</code> — never sent anywhere except this server.
      </p>
      ${current && html`<p class="settings-current">Currently: <code>${mask(current)}</code></p>`}
      <div class="settings-form-row">
        <input class="field" type="password" placeholder="paste write token…" value=${value}
          onInput=${(e) => setValue(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') save(); }} />
        <button class="btn btn-ghost" onClick=${clear}>Clear</button>
        <button class="btn btn-accent" onClick=${save}>Save</button>
      </div>
    </section>`;
}

function ServerTokenPanel() {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const available = store.settingsAvailable.value;

  const submit = async (nextToken) => {
    setBusy(true); setErr(''); setNotice('');
    try {
      const data = await saveServerToken(nextToken);
      setValue('');
      toast(nextToken ? 'Server write token updated' : 'Server write token cleared');
      setNotice(data?.restartRequired
        ? 'Restart bd-console for this change to take effect.'
        : 'Applied.');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return html`
    <section class="settings-card">
      <h2 class="settings-card-title">Server write token</h2>
      <p class="muted small">
        The token the <em>server</em> requires on writes (<code>POST /api/settings</code>). Setting this here is
        equivalent to <code>bd-console settings set token …</code> on the host.
      </p>
      ${!available && html`<p class="form-warn">Settings endpoint not available on this server yet — this control is disabled until it lands.</p>`}
      <div class="settings-form-row">
        <input class="field" type="password" placeholder="new server token…" value=${value} disabled=${!available}
          onInput=${(e) => setValue(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && value.trim()) submit(value.trim()); }} />
        <button class="btn btn-ghost" disabled=${busy || !available} onClick=${() => submit(null)}>Clear</button>
        <button class="btn btn-accent" disabled=${busy || !available || !value.trim()} onClick=${() => submit(value.trim())}>Save</button>
      </div>
      ${err && html`<span class="form-err">${err}</span>`}
      ${notice && html`<p class="muted small settings-notice">${notice}</p>`}
    </section>`;
}

// Opt-in per-project default epics: for each of the create dialog's five
// non-epic intents, an optional epic bead this project's stored mapping
// preselects in CreateIssueDialog (see its `defaultEpics` preselect effect).
// Nothing is created or persisted here until the user explicitly clicks
// Save or "Create the 5 standard epics" — this card only edits local state
// on every keystroke/selection.
function DefaultEpicsPanel() {
  const settings = store.settings.value;
  const storedMap = settings?.defaultEpics || {};
  const projects = store.projects.value;
  const projectIds = Object.keys(projects).sort((a, b) => a.localeCompare(b));

  const [projectId, setProjectId] = useState('');
  const [epics, setEpics] = useState([]);
  const [epicsLoading, setEpicsLoading] = useState(false);
  const [localMap, setLocalMap] = useState({});
  const [busy, setBusy] = useState(false);
  const [stdBusy, setStdBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => { loadHub(); }, []);

  // Default the project picker to the first registered project once the
  // registry has loaded, but never stomp a selection the user already made.
  useEffect(() => {
    if (!projectId && projectIds.length) setProjectId(projectIds[0]);
  }, [projectIds.join(',')]);

  useEffect(() => {
    setErr(''); setNotice('');
    if (!projectId) { setEpics([]); setLocalMap({}); return; }
    const stored = storedMap[projectId] || {};
    setLocalMap(Object.fromEntries(DEFAULT_EPIC_INTENTS.map((k) => [k, stored[k] || ''])));
    setEpicsLoading(true);
    loadEpicsForProject(projectId).then((list) => setEpics(list)).finally(() => setEpicsLoading(false));
    // storedMap is derived from store.settings.value every render; only
    // re-run this sync when the selected project itself changes, not on
    // every settings refresh (which would clobber in-progress local edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const setIntentEpic = (intent, id) => setLocalMap((m) => ({ ...m, [intent]: id }));

  const save = async () => {
    if (!projectId) return;
    setBusy(true); setErr(''); setNotice('');
    try {
      await saveDefaultEpics({ [projectId]: localMap });
      setNotice('Saved.');
      toast(`Default epics saved for ${projectId}`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const createStandard = async () => {
    if (!projectId) return;
    setStdBusy(true); setErr(''); setNotice('');
    try {
      const { map, created, reused } = await createStandardEpics(projectId);
      setLocalMap(map);
      setEpicsLoading(true);
      loadEpicsForProject(projectId).then((list) => setEpics(list)).finally(() => setEpicsLoading(false));
      toast(created
        ? `Created ${created} epic${created === 1 ? '' : 's'}${reused ? ` (reused ${reused} existing)` : ''} and mapped them`
        : `All 5 standard epics already existed — reused them, mapped them`);
    } catch (e) { setErr(e.message); }
    finally { setStdBusy(false); }
  };

  return html`
    <section class="settings-card">
      <h2 class="settings-card-title">Default epics</h2>
      <p class="muted small">
        Opt-in per-project defaults. When a mapping is set, the create-issue dialog preselects that epic for
        matching issue types (you can always change it before creating). Nothing here takes effect until you
        click Save.
      </p>
      ${projectIds.length === 0
        ? html`<p class="muted small">No registered projects yet.</p>`
        : html`
          <div class="edit-block">
            <span class="edit-label">Project</span>
            <select class="edit-input full-width" value=${projectId} onChange=${(e) => setProjectId(e.target.value)}>
              ${projectIds.map((id) => html`<option key=${id} value=${id}>${id}</option>`)}
            </select>
          </div>
          <div class="default-epics-grid">
            ${DEFAULT_EPIC_INTENTS.map((intent) => html`
              <label key=${intent} class="dialog-field"><span>${INTENT_CARD_LABEL[intent]}</span>
                <${EpicCombobox} epics=${epics} value=${localMap[intent] || ''}
                  onChange=${(id) => setIntentEpic(intent, id)} placeholder="None" />
              </label>`)}
          </div>
          ${epicsLoading && html`<p class="muted small">Loading epics…</p>`}
          <div class="settings-form-row">
            <button class="btn btn-ghost" disabled=${stdBusy} onClick=${createStandard}>
              ${stdBusy ? 'Creating…' : 'Create the 5 standard epics'}
            </button>
            <button class="btn btn-accent" disabled=${busy} onClick=${save}>Save</button>
          </div>
          ${err && html`<span class="form-err">${err}</span>`}
          ${notice && html`<p class="muted small settings-notice">${notice}</p>`}
          <p class="muted small">
            "Create the 5 standard epics" creates 5 new beads (Bugs / Features / Tasks / Ideas / Chores) in the
            selected project and maps them to the five intents above in one action — an existing open epic with a
            matching title is reused instead of duplicated, so clicking it again creates nothing new.
          </p>`}
    </section>`;
}

export function SettingsView() {
  useEffect(() => { loadSettings(); }, []);
  const loading = store.settingsLoading.value;
  const available = store.settingsAvailable.value;

  return html`
    <main class="strip-view settings-view">
      <div class="view-header">
        <h1>Settings</h1>
        <button class="btn btn-ghost" onClick=${loadSettings}>Refresh</button>
      </div>

      <div class="settings-grid">
        ${available
          ? html`<${ServerSettingsPanel} />`
          : loading
            ? html`<section class="settings-card"><p class="muted small">Loading…</p></section>`
            : html`<section class="settings-card"><p class="muted small">Server settings endpoint isn't available on this server yet (<code>GET /api/settings</code> 404s). Showing browser-only controls below.</p></section>`}
        <${AppearancePanel} />
        <${BdVersionPanel} />
        <${BrowserTokenPanel} />
        <${ServerTokenPanel} />
        <${DefaultEpicsPanel} />
      </div>
    </main>`;
}
