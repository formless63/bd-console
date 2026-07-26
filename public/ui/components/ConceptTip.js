// ConceptTip.js — the presentational half of the learning layer: the concept
// tooltip, the one-at-a-time nudge, and the rich empty-state block. The engine
// (registry, persistence, predicates) is ../learn.js, which is framework-free
// so smoke can assert it in plain Node; everything here is the preact skin.
//
// Three rules the components below exist to enforce:
//
//   * NOTHING TRAPS FOCUS. The tooltip is a plain non-modal disclosure: the
//     trigger keeps focus on open, the panel is the next thing in DOM order so
//     Tab walks into it and straight back out, Escape closes it and returns
//     focus to the trigger, and clicking or tabbing away closes it. There is no
//     focus loop, no inert backdrop, no "you must dismiss this to continue".
//   * NOTHING IS MODAL OR BLOCKING. A nudge is a strip you can ignore forever.
//   * NOTHING SURVIVES BEING OUTGROWN. Every nudge is one-shot and permanently
//     dismissible; see ../learn.js for the retirement rules.
import { html } from 'htm/preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { learn, concept, conceptHref } from '../learn.js';

// ---------------------------------------------------------------------------
// Reactivity bridge: ../learn.js deliberately has no signals, so components
// that must re-render when a hint is dismissed subscribe by hand.
// ---------------------------------------------------------------------------
export function useLearn() {
  const [, bump] = useState(0);
  useEffect(() => learn.subscribe(() => bump((n) => n + 1)), []);
  return learn;
}

// ---------------------------------------------------------------------------
// Concept tooltip — layer 1 (reference; never decays, never gated by the
// master switch).
// ---------------------------------------------------------------------------

const POP_W = 320;

/** The affordance on its own, for placing next to a label you already render. */
export function ConceptDot({ k, className }) {
  const c = concept(k);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);

  // Fixed positioning (not absolute) so the panel is never clipped by the
  // scroll containers these terms live in — the Detail slide-over, a flow
  // lane, the molecule dialog. Verified there is no transformed ancestor that
  // would turn `fixed` back into `absolute`.
  const place = () => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(POP_W, vw - 16);
    let left = Math.round(r.left + r.width / 2 - w / 2);
    left = Math.max(8, Math.min(left, vw - w - 8));
    const below = vh - r.bottom;
    const up = below < 190 && r.top > below;
    setPos({ left, w, top: up ? null : Math.round(r.bottom + 8), bottom: up ? Math.round(vh - r.top + 8) : null });
  };

  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  if (!c) return null;
  const id = 'concept-pop-' + k;

  // Escape is handled here rather than at the window so it can be stopped from
  // reaching the native <dialog> this tooltip might be inside (Escape on a
  // dialog is a default action of the keydown, hence preventDefault too) or
  // the app-level Escape handler in app.js. Closing a tooltip must never also
  // close the dialog the user was reading.
  const onKeyDown = (e) => {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    btnRef.current?.focus();
  };
  // Tab out of the panel (or the trigger) closes it — no loop, no trap.
  const onFocusOut = (e) => {
    if (!open) return;
    const next = e.relatedTarget;
    if (next && rootRef.current && rootRef.current.contains(next)) return;
    if (!next) return; // focus left the document entirely; leave it be
    setOpen(false);
  };

  return html`
    <span class=${'learn-tip' + (className ? ' ' + className : '')} ref=${rootRef} onKeyDown=${onKeyDown} onFocusOut=${onFocusOut}>
      <button type="button" class="learn-dot" ref=${btnRef}
        aria-expanded=${open ? 'true' : 'false'} aria-controls=${id}
        aria-label=${'What does "' + c.term + '" mean?'}
        data-concept=${k}
        onClick=${(e) => { e.stopPropagation(); e.preventDefault(); setOpen((o) => !o); }}>?</button>
      ${open && html`
        <span class="learn-pop" id=${id} ref=${popRef} data-concept-pop=${k}
          style=${pos ? `left:${pos.left}px;width:${pos.w}px;` + (pos.top != null ? `top:${pos.top}px;` : `bottom:${pos.bottom}px;`) : 'visibility:hidden;'}>
          <span class="learn-pop-term">${c.term}</span>
          <span class="learn-pop-short">${c.short}</span>
          ${c.when && html`<span class="learn-pop-when"><b>Use it when</b> ${c.when.charAt(0).toLowerCase() + c.when.slice(1)}</span>`}
          <a class="learn-pop-more" href=${conceptHref(k)} onClick=${() => setOpen(false)}>Read more →</a>
        </span>`}
    </span>`;
}

/** A term rendered together with its affordance. `label` overrides the wording. */
export function ConceptTip({ k, label, className }) {
  const c = concept(k);
  if (!c) return null;
  return html`<span class=${'learn-term' + (className ? ' ' + className : '')}>${label || c.term}<${ConceptDot} k=${k} /></span>`;
}

// ---------------------------------------------------------------------------
// Empty state — layer 2 (self-retiring: replaced by the user's own content).
//
// The contract, per section: one sentence on what belongs here, one on why it
// is worth having, and — where there is an obvious next move — one button.
// ---------------------------------------------------------------------------
export function LearnEmpty({ icon, title, what, why, actionLabel, onAction, k, compact }) {
  return html`
    <div class=${'learn-empty' + (compact ? ' compact' : '')}>
      ${icon && html`<span class="learn-empty-icon" aria-hidden="true">${icon}</span>`}
      <div class="learn-empty-body">
        ${title && html`<div class="learn-empty-title">${title}${k ? html` <${ConceptDot} k=${k} />` : ''}</div>`}
        <p class="learn-empty-what">${what}</p>
        ${why && html`<p class="learn-empty-why">${why}</p>`}
        ${actionLabel && onAction && html`
          <button type="button" class="learn-empty-cta" onClick=${onAction}>${actionLabel}</button>`}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Nudge — layer 3. At most one anywhere, at most one session each, permanently
// dismissible, auto-retired the moment the user does the thing.
// ---------------------------------------------------------------------------

// A nudge only spends its single appearance once it has actually been on
// screen long enough to read. Without this, a hint could be burned by a
// 200ms flash during a data load that the user never even saw.
const SHOW_DWELL_MS = 4000;

export function Nudge({ hint, onAction }) {
  const l = useLearn();
  const id = hint?.id;
  useEffect(() => {
    if (!id) return undefined;
    const t = setTimeout(() => learn.noteShown(id), SHOW_DWELL_MS);
    return () => clearTimeout(t);
  }, [id]);
  if (!hint) return null;
  return html`
    <div class="learn-nudge" role="status" data-nudge=${hint.id}>
      <span class="learn-nudge-mark" aria-hidden="true">◆</span>
      <div class="learn-nudge-body">
        <div class="learn-nudge-title">${hint.title}${hint.concept ? html` <${ConceptDot} k=${hint.concept} />` : ''}</div>
        <p class="learn-nudge-text">${hint.body}</p>
      </div>
      <div class="learn-nudge-actions">
        ${hint.ctaLabel && html`
          <button type="button" class="learn-nudge-cta" data-nudge-cta
            onClick=${() => { onAction?.(hint); l.dismiss(hint.id); }}>${hint.ctaLabel}</button>`}
        <button type="button" class="learn-nudge-x" data-nudge-dismiss
          title="Dismiss — this won't come back" aria-label="Dismiss this hint permanently"
          onClick=${() => l.dismiss(hint.id)}>✕</button>
      </div>
    </div>`;
}

/**
 * The single mount point for nudges. Given a context (see learnContext in
 * ../learn.js) it renders the one best hint, or nothing at all — which is what
 * it renders for the overwhelming majority of the app's life.
 */
export function NudgeRail({ ctx, onAction }) {
  const l = useLearn();
  if (!ctx || !l.isEnabled()) return null;
  const hint = l.pickNudge(ctx);
  if (!hint) return null;
  return html`<div class="learn-nudge-rail"><${Nudge} hint=${hint} onAction=${onAction} /></div>`;
}
