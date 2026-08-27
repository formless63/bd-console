// components/AddFilesDialog.js — "Add files" (bd-console-cox.4): drop files
// into an already-registered project's directory at any time, not just at
// session-creation time (that's NewSessionDialog.js / cox.3's job — see
// components/hub/NewSessionDialog.js). Shares the same POST
// /api/files/upload endpoint and the same filesToUploadPayload base64
// helper; the dialog shape mirrors NewSessionDialog.js's file-attach field
// and CreateIssueDialog.js's native <dialog> pattern.
//
// Unlike NewSessionDialog (which fires once, reports `skipped` in a toast,
// and moves on to the new session), this dialog is a standalone "attach a
// file" action with nothing after it to navigate to — so a non-overwrite
// response with `skipped` entries keeps the dialog OPEN with the skipped
// names listed and an "overwrite" checkbox already in reach, instead of
// just toasting the count and closing. That's the retry path the spec asks
// for: flip overwrite, submit again, done.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { toast, requireToken } from '../store.js';
import { apiPostRaw, AuthError } from '../api.js';
import { filesToUploadPayload } from './common.js';

export function AddFilesDialog({ open, onClose, dir, label }) {
  const ref = useRef(null);
  const returnFocus = useRef(null);
  const [files, setFiles] = useState([]);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [skipped, setSkipped] = useState([]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnFocus.current = document.activeElement;
      d.showModal();
      setErr(''); setSkipped([]);
      setTimeout(() => d.querySelector('#add-files-input')?.focus(), 30);
    }
    if (!open && d.open) {
      d.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      returnFocus.current = null;
    }
  }, [open]);

  const close = () => onClose();
  const reset = () => { setFiles([]); setOverwrite(false); setErr(''); setSkipped([]); };

  const submit = async () => {
    if (busy || !files.length || !dir) return;
    setBusy(true); setErr('');
    try {
      const payload = await filesToUploadPayload(files);
      const data = await apiPostRaw('/api/files/upload', { dir, files: payload, overwrite });
      const skippedList = data.skipped || [];
      const writtenN = (data.written || []).length;
      if (writtenN) {
        toast(`${writtenN} file${writtenN === 1 ? '' : 's'} added to ${label || dir}`);
      }
      if (skippedList.length) {
        // Leave the dialog open, pre-loaded with the skipped names, so
        // flipping "overwrite" and hitting Add files again is a one-step
        // retry rather than a re-pick of the same files.
        setSkipped(skippedList);
        setErr(`${skippedList.length} file${skippedList.length === 1 ? '' : 's'} already existed and ${skippedList.length === 1 ? 'was' : 'were'} skipped — check "overwrite" and try again to replace ${skippedList.length === 1 ? 'it' : 'them'}.`);
        return;
      }
      reset();
      onClose();
    } catch (e) {
      if (e instanceof AuthError) requireToken('A write token is required to add files to this project.');
      else setErr(e.message || 'Could not upload files.');
    } finally {
      setBusy(false);
    }
  };

  return html`
    <dialog class="dialog" ref=${ref} aria-labelledby="add-files-title"
      onCancel=${(e) => { e.preventDefault(); close(); }}
      onClose=${close}
      onClick=${(e) => {
        // This dialog gets mounted straight inside a clickable ProjectCard
        // (hub) as well as in a plain header (Console 2.0) — unlike
        // NewSessionDialog, which only ever lives in the hub's top-level
        // layout. A native <dialog> is a real DOM descendant of wherever it's
        // mounted (no portal), so without this stop, any click inside it —
        // the Add-files button, the overwrite checkbox — would bubble past
        // the dialog into the card's own onClick and navigate into the
        // project mid-upload. Stop unconditionally, then handle
        // backdrop-click-to-close same as every other dialog in this app.
        e.stopPropagation();
        if (e.target === ref.current) close();
      }}>
      <div class="dialog-body" onKeyDown=${(e) => { if (e.key === 'Escape') close(); }}>
        <h2 class="dialog-head" id="add-files-title">Add files${label ? ` — ${label}` : ''}</h2>
        <p class="muted small">Dropped straight into <code>${dir}</code> — a spec, <code>AGENTS.md</code>, whatever this project needs next.</p>

        <label class="dialog-field"><span>files</span>
          <input id="add-files-input" type="file" multiple aria-label="Files to add to this project"
            onChange=${(e) => { setFiles(Array.from(e.target.files || [])); setSkipped([]); setErr(''); }} />
          ${files.length > 0 && html`
            <div class="edit-chiprow">
              ${files.map((f, i) => html`
                <button key=${f.name + i} type="button" class="chip removable" title="Remove"
                  onClick=${() => setFiles(files.filter((_, j) => j !== i))}>${f.name} <span class="chip-x">×</span></button>`)}
            </div>`}
        </label>

        <label class="dialog-field dialog-check-row">
          <input type="checkbox" checked=${overwrite} onChange=${(e) => setOverwrite(e.target.checked)} />
          <span>Overwrite files that already exist</span>
        </label>

        ${skipped.length > 0 && html`
          <p class="muted small" role="status">Skipped (already exist): ${skipped.map((s) => s.name).join(', ')}</p>`}

        <div class="dialog-actions">
          ${err && html`<span class="form-err" role="alert">${err}</span>`}
          <button type="button" class="btn btn-ghost" onClick=${close}>Cancel</button>
          <button type="button" class="btn btn-accent" disabled=${busy || !files.length || !dir} onClick=${submit}>
            ${busy ? 'Adding…' : 'Add files'}
          </button>
        </div>
      </div>
    </dialog>`;
}
