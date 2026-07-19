// TmuxView.js — hub-level #/tmux route: a grid of live tmux sessions (from
// GET /api/tmux), each pane mapped against the registered project list so a
// "repo" chip can jump straight to that project. Clicking a session opens a
// polling preview drawer (GET /api/tmux/preview, ANSI stripped).
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, navigate, loadTmux, loadTmuxPreview } from '../store.js';
import { timeAgo, cwdTail, stripAnsi, matchProject } from './common.js';

const SESSION_POLL_MS = 8000;
const PREVIEW_POLL_MS = 3000;

// Compact single-line session row shared with the hub's "Terminal sessions"
// section — name, attached badge, first pane's command, and a repo chip when
// the pane's cwd resolves to a registered project.
export function SessionRowCompact({ session, projects, onClick }) {
  const first = session.panes[0];
  const match = first ? matchProject(first.cwd, projects) : null;
  return html`
    <button type="button" class="hub-tmux-row" onClick=${onClick}>
      <span class="tmux-name">${session.name}</span>
      <span class=${'badge tmux-attach' + (session.attached ? ' on' : '')}>${session.attached ? 'attached' : 'detached'}</span>
      <span class="pane-cmd hub-tmux-cmd">${first?.command || '—'}</span>
      ${match && html`<span class="chip repo-chip hub-tmux-repo">${match[0]}</span>`}
    </button>`;
}

function Pane({ pane, projects }) {
  const match = matchProject(pane.cwd, projects);
  return html`
    <div class="tmux-pane">
      <span class="pane-cmd">${pane.command || '—'}</span>
      <sl-tooltip content=${pane.cwd || '(unknown cwd)'}>
        <span class="pane-cwd">${cwdTail(pane.cwd)}</span>
      </sl-tooltip>
      ${match && html`
        <button class="chip repo-chip" onClick=${() => navigate('#/p/' + encodeURIComponent(match[0]))}>
          ${match[0]}
        </button>`}
    </div>`;
}

function SessionCard({ session, projects, onPreview, onSchedule }) {
  return html`
    <div class="tmux-card">
      <div class="tmux-card-head">
        <span class="tmux-name">${session.name}</span>
        <span class=${'badge tmux-attach' + (session.attached ? ' on' : '')}>${session.attached ? 'attached' : 'detached'}</span>
      </div>
      <div class="tmux-meta muted small">
        ${session.windows} window${session.windows === 1 ? '' : 's'} · created ${timeAgo(session.created ? session.created * 1000 : null)}
      </div>
      <div class="tmux-panes">
        ${session.panes.length === 0
          ? html`<div class="muted small">No panes.</div>`
          : session.panes.map((p, n) => html`<${Pane} key=${n} pane=${p} projects=${projects} />`)}
      </div>
      <div class="tmux-card-actions">
        <button class="btn btn-xs" onClick=${onPreview}>Preview</button>
        <button class="btn btn-xs btn-ghost" onClick=${onSchedule}>Schedule a prompt here</button>
      </div>
    </div>`;
}

export function TmuxView() {
  const [previewSession, setPreviewSession] = useState(null);
  const [previewText, setPreviewText] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const preRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => {
    loadTmux();
    const t = setInterval(loadTmux, SESSION_POLL_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [previewText]);

  const refreshPreview = async (session) => {
    setPreviewLoading(true);
    try {
      const text = await loadTmuxPreview(session, 500);
      setPreviewText(text);
    } catch (e) {
      // A 401 already opened the token dialog and toasted — stop polling
      // rather than repeatedly hammering an endpoint we can't read.
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    } finally {
      setPreviewLoading(false);
    }
  };

  const openPreview = (session) => {
    setPreviewSession(session);
    setPreviewText('');
    refreshPreview(session);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => refreshPreview(session), PREVIEW_POLL_MS);
  };
  const closePreview = () => {
    setPreviewSession(null);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const scheduleHere = (session) => {
    store.scheduleSessionPreset.value = session;
    navigate('#/schedule');
  };

  const sessions = store.tmuxSessions.value;
  const loading = store.tmuxLoading.value && sessions.length === 0;
  const projects = store.projects.value;

  return html`
    <main class="strip-view">
      <div class="view-header">
        <h1>Terminal sessions</h1>
        <button class="btn btn-ghost" onClick=${loadTmux}>Refresh</button>
      </div>

      ${!store.tmuxAvailable.value
        ? html`<div class="empty-state">
            <div class="empty-icon">⌁</div>
            <p>tmux isn't available on this host.</p>
            <p class="muted small">Install tmux and start a session to see it here.</p>
          </div>`
        : loading
          ? html`<div class="tmux-grid">${Array.from({ length: 3 }).map((_, n) => html`<div key=${n} class="tmux-card skeleton-card"></div>`)}</div>`
          : sessions.length === 0
            ? html`<div class="empty-state">
                <div class="empty-icon">⌁</div>
                <p>No tmux sessions running.</p>
                <p class="muted small">Start one on this host (<code>tmux new -s name</code>) and it'll show up here.</p>
              </div>`
            : html`<div class="tmux-grid">
                ${sessions.map((s) => html`<${SessionCard}
                  key=${s.name} session=${s} projects=${projects}
                  onPreview=${() => openPreview(s.name)}
                  onSchedule=${() => scheduleHere(s.name)}
                />`)}
              </div>`}

      <sl-drawer
        class="tmux-drawer"
        placement="end"
        label=${previewSession || 'Preview'}
        open=${!!previewSession}
        onsl-after-hide=${closePreview}
      >
        <div class="tmux-preview-actions">
          <button class="btn btn-ghost btn-xs" disabled=${previewLoading} onClick=${() => refreshPreview(previewSession)}>
            ${previewLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <pre class="tmux-pre" ref=${preRef}>${stripAnsi(previewText) || (previewLoading ? 'Loading…' : '(empty pane)')}</pre>
      </sl-drawer>
    </main>`;
}
