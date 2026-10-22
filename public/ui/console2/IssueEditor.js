import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { editIssue, loadIssues, registerDraftGuard } from '../store.js';
import { CONTENT_FIELDS, REVIEW_FIELDS, REVIEW_DECISIONS, contentOf, reviewDraft, reviewOf, safeEvidenceUrl } from '../issueContent.js';

export function IssueEditor({ issue, review = false }) {
  const read = review ? reviewDraft : contentOf;
  const fields = review ? REVIEW_FIELDS : CONTENT_FIELDS;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => read(issue));
  const [base, setBase] = useState(() => read(issue));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(base);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const busyRef = useRef(false);
  busyRef.current = busy;
  useEffect(() => {
    const remove = registerDraftGuard({
      busy: () => busyRef.current,
      dirty: () => dirtyRef.current,
      discard: () => { dirtyRef.current = false; setEditing(false); },
    });
    const unload = e => { if (dirtyRef.current || busyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { remove(); window.removeEventListener('beforeunload', unload); };
  }, []);
  const begin = () => { const value = read(issue); setBase(value); setDraft(value); setError(''); setEditing(true); };
  const change = (key, value) => setDraft(old => ({ ...old, [key]: value }));
  const save = async e => {
    e.preventDefault();
    if (busy || (!review && !draft.title.trim())) return;
    setBusy(true); setError('');
    try {
      await editIssue({ id: issue.id, op: review ? 'set-review' : 'set-content', fields: draft, expected: base }, review ? 'Review evidence saved' : 'Issue content saved');
      dirtyRef.current = false; setEditing(false);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const recorded = reviewOf(issue);
  if (!editing) return html`<section class="issue-editor">
    ${review && html`<h3>Review & evidence</h3><p class="muted small">Explicit records from a person or agent. These do not verify a build, merge, or deployment.</p>
      ${recorded ? html`<p><strong>${REVIEW_DECISIONS[recorded.decision] || 'Review recorded'}</strong>${recorded.reviewer ? ` · ${recorded.reviewer}` : ''}</p>
        <dl class="evidence-list">${Object.entries(REVIEW_FIELDS).filter(([k]) => recorded[k]).map(([k, label]) => html`
          <dt>${label}</dt><dd>${k === 'url' && safeEvidenceUrl(recorded[k]) ? html`<a href=${safeEvidenceUrl(recorded[k])} target="_blank" rel="noopener noreferrer">${recorded[k]}</a>` : recorded[k]}</dd>`)}</dl>
        ${recorded.recorded_at && html`<p class="muted small">Recorded ${new Date(recorded.recorded_at).toLocaleString()}</p>`}`
        : html`<p class="muted small">No review evidence recorded.</p>`}`}
    <button class="btn btn-sm" type="button" onClick=${begin}>${review ? 'Record review evidence' : 'Edit title & content'}</button>
  </section>`;
  return html`<form class="issue-editor" onSubmit=${save} data-issue-editor=${review ? 'review' : 'content'}>
    <h3>${review ? 'Review & evidence' : 'Edit issue content'}</h3>
    ${Object.entries(fields).map(([key, label]) => html`<label class="issue-editor-field">${label}
      ${['title', 'branch', 'commit', 'url', 'reviewer'].includes(key)
        ? html`<input class="field" name=${key} value=${draft[key]} required=${key === 'title'} maxlength=${key === 'title' ? 500 : 50000} disabled=${busy} onInput=${e => change(key, e.target.value)} />`
        : html`<textarea class="field" name=${key} rows="4" value=${draft[key]} maxlength="50000" disabled=${busy} onInput=${e => change(key, e.target.value)}></textarea>`}
    </label>`)}
    ${review && html`<label class="issue-editor-field">Review decision<select class="field" name="decision" value=${draft.decision} disabled=${busy} onChange=${e => change('decision', e.target.value)}>
      ${Object.entries(REVIEW_DECISIONS).map(([value, label]) => html`<option value=${value}>${label}</option>`)}</select></label>`}
    ${error && html`<p role="alert" class="form-error">${error}</p><button type="button" class="btn btn-sm" disabled=${busy} onClick=${async () => {
      if (dirty && !confirm('Discard this draft and reload current issue content?')) return;
      await loadIssues({ force: true }); setEditing(false);
    }}>Discard draft & reload</button>`}
    <div class="issue-editor-actions"><button class="btn btn-accent" disabled=${busy || (!review && !draft.title.trim())}>${busy ? 'Saving…' : 'Save'}</button>
      <button type="button" class="btn" disabled=${busy} onClick=${() => { if (!dirty || confirm('Discard unsaved issue changes?')) setEditing(false); }}>Cancel</button></div>
  </form>`;
}
