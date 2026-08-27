// components/hub/NewSessionDialog.js — "New code session" (bd-console-cox /
// cox.1 + cox.3): pick or create a folder, name a tmux session, optionally
// attach files and a starter prompt, then POST /api/tmux/create launches
// `claude --remote-control <name>` there in one detached tmux session — the
// UI equivalent of the hand-run
//   tmux new -d -s NAME -c DIR 'claude --remote-control NAME; exec $SHELL'
// this feature is modeled on. Backed by a native <dialog>, same pattern as
// CreateIssueDialog.js.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, navigate, toast, requireToken, loadTmux } from '../../store.js';
import { apiPostRaw, AuthError } from '../../api.js';
import { filesToUploadPayload } from '../common.js';

// Mirrors lib/tmux.mjs's SESSION_NAME_RE exactly — the server is the
// authority (this only lets the UI fail fast instead of round-tripping an
// invalid name), so keep the two in sync if either changes.
const SESSION_NAME_CLIENT_RE = /^[A-Za-z0-9_.:@-]+$/;

function suggestName(dir) {
  const base = (dir || '').split('/').filter(Boolean).pop() || '';
  return base.replace(/[^A-Za-z0-9_.:@-]/g, '-').replace(/^-+/, '');
}

export function NewSessionDialog({ open, onClose }) {
  const ref = useRef(null);
  const returnFocus = useRef(null);
  const projects = store.projects.value;
  const entries = Object.entries(projects);

  const [folderMode, setFolderMode] = useState(entries.length ? 'existing' : 'new');
  const [projectId, setProjectId] = useState(entries[0]?.[0] || '');
  const [newDir, setNewDir] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const dir = folderMode === 'existing' ? (projects[projectId]?.path || '') : newDir.trim();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnFocus.current = document.activeElement;
      d.showModal();
      setErr('');
      setTimeout(() => d.querySelector('#new-session-name')?.focus(), 30);
    }
    if (!open && d.open) {
      d.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      returnFocus.current = null;
    }
  }, [open]);

  // Autosuggest from the chosen folder's basename — but only until the user
  // types into the name field themselves; a manual edit is sticky even if
  // they then switch project/folder, exactly like CreateIssueDialog's
  // epicManual flag protects a deliberate epic pick from being overwritten.
  useEffect(() => {
    if (nameEdited || !dir) return;
    const suggested = suggestName(dir);
    if (suggested) setName(suggested);
  }, [dir, nameEdited]);

  const close = () => onClose();
  const reset = () => {
    setFolderMode(entries.length ? 'existing' : 'new');
    setProjectId(entries[0]?.[0] || '');
    setNewDir(''); setName(''); setNameEdited(false); setPrompt(''); setFiles([]); setErr('');
  };

  const submit = async () => {
    if (busy) return;
    const trimmedName = name.trim();
    if (!SESSION_NAME_CLIENT_RE.test(trimmedName)) {
      setErr('Session name must contain only letters, numbers, and . _ : @ -');
      return;
    }
    if (!dir) { setErr(folderMode === 'existing' ? 'Pick a project' : 'Enter a folder path'); return; }

    setBusy(true); setErr('');
    try {
      const filePayload = files.length ? await filesToUploadPayload(files) : undefined;
      const data = await apiPostRaw('/api/tmux/create', {
        name: trimmedName,
        dir,
        createDir: folderMode === 'new',
        ...(filePayload ? { files: filePayload } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      const skippedNote = data.skipped && data.skipped.length
        ? ` — ${data.skipped.length} file${data.skipped.length === 1 ? '' : 's'} already existed and were skipped`
        : '';
      if (data.promptSent === false) {
        toast(`Session "${data.name}" is up, but the starter prompt didn't land: ${data.promptError || 'unknown reason'}. Check the session and send it by hand.`, 'warn', 9000);
      } else {
        toast(`Session "${data.name}" is live${skippedNote}`);
      }
      await loadTmux();
      reset();
      onClose();
      navigate('#/tmux');
    } catch (e) {
      if (e instanceof AuthError) requireToken('A write token is required to start a new code session.');
      else setErr(e.message || 'Could not create the session.');
    } finally {
      setBusy(false);
    }
  };

  return html`
    <dialog class="dialog dialog-lg" ref=${ref} aria-labelledby="new-session-title"
      onCancel=${(e) => { e.preventDefault(); close(); }}
      onClose=${close} onClick=${(e) => { if (e.target === ref.current) close(); }}>
      <div class="dialog-body" onKeyDown=${(e) => { if (e.key === 'Escape') close(); }}>
        <h2 class="dialog-head" id="new-session-title">New code session</h2>
        <p class="muted small">
          Launches a detached tmux session on this machine running <code>claude --remote-control</code> —
          attach to it from the tmux view or Termix once it's up.
        </p>

        <div class="intent-chips" role="group" aria-label="Folder source">
          ${entries.length > 0 && html`
            <button type="button" class=${'intent-chip' + (folderMode === 'existing' ? ' on' : '')}
              aria-pressed=${folderMode === 'existing'} onClick=${() => { setFolderMode('existing'); setNameEdited(false); }}>
              Existing project
            </button>`}
          <button type="button" class=${'intent-chip' + (folderMode === 'new' ? ' on' : '')}
            aria-pressed=${folderMode === 'new'} onClick=${() => { setFolderMode('new'); setNameEdited(false); }}>
            New folder
          </button>
        </div>

        ${folderMode === 'existing'
          ? html`
            <label class="dialog-field"><span>project</span>
              <select class="field" aria-label="Project folder" value=${projectId}
                onChange=${(e) => { setProjectId(e.target.value); setNameEdited(false); }}>
                ${entries.map(([id, p]) => html`<option key=${id} value=${id}>${id} — ${p.path}</option>`)}
              </select>
            </label>`
          : html`
            <label class="dialog-field"><span>folder</span>
              <input class="field" placeholder="/home/you/code/new-project" value=${newDir}
                aria-label="New project folder on this machine"
                spellcheck="false" autocapitalize="off" autocorrect="off"
                onInput=${(e) => { setNewDir(e.target.value); setNameEdited(false); }} />
              <span class="muted small">Created if it doesn't already exist — <code>~</code> works, and it doesn't need a <code>.beads/</code> yet; this is for starting a brand-new project.</span>
            </label>`}

        <label class="dialog-field"><span>session name</span>
          <input id="new-session-name" class="field" placeholder="my-project" value=${name}
            aria-label="tmux session name" spellcheck="false" autocapitalize="off" autocorrect="off"
            onInput=${(e) => { setName(e.target.value); setNameEdited(true); }} />
        </label>

        <label class="dialog-field"><span>starter prompt (optional)</span>
          <textarea class="field" rows="3" placeholder="Sent to Claude once the session is up…" value=${prompt}
            aria-label="Starter prompt" onInput=${(e) => setPrompt(e.target.value)}></textarea>
        </label>

        <label class="dialog-field"><span>attach files (optional)</span>
          <input type="file" multiple aria-label="Files to drop into the folder before launch"
            onChange=${(e) => setFiles(Array.from(e.target.files || []))} />
          ${files.length > 0 && html`
            <div class="edit-chiprow">
              ${files.map((f, i) => html`
                <button key=${f.name + i} type="button" class="chip removable" title="Remove"
                  onClick=${() => setFiles(files.filter((_, j) => j !== i))}>${f.name} <span class="chip-x">×</span></button>`)}
            </div>`}
          <span class="muted small">Dropped into the folder before the session launches — a spec, AGENTS.md, whatever you're starting from.</span>
        </label>

        <div class="dialog-actions">
          ${err && html`<span class="form-err" role="alert">${err}</span>`}
          <button type="button" class="btn btn-ghost" onClick=${close}>Cancel</button>
          <button type="button" class="btn btn-accent" disabled=${busy || !name.trim() || !dir} onClick=${submit}>
            ${busy ? 'Launching…' : 'Launch session'}
          </button>
        </div>
      </div>
    </dialog>`;
}
