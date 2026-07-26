// LearnView.js — the #/learn reference page.
//
// Explicitly NOT a walkthrough. There are no steps, no "next", no progress,
// nothing to complete and nothing that knows or cares whether you have read
// it. It is a glossary with a mental model at the front and a "where things
// live" map at the back, written for someone who has never used an issue
// tracker. You land here from a tooltip's "Read more", from Settings, or from
// the ? in Console 2.0's header, and you leave when you have your answer.
//
// Every definition is rendered from ../learn.js's CONCEPTS so the tooltips and
// this page can never drift apart.
import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { CONCEPTS, CONCEPT_GROUPS, conceptsInGroup, learnAnchorFromHash } from '../learn.js';

const anchorId = (key) => 'c-' + key;

function ConceptCard({ c }) {
  return html`
    <article class="learn-card" id=${anchorId(c.key)} data-concept-card=${c.key}>
      <h3 class="learn-card-term">
        ${c.term}
        ${c.direction && html`<span class="learn-card-dir" title="How it reads from each end">${c.direction}</span>`}
      </h3>
      <p class="learn-card-short">${c.short}</p>
      <p class="learn-card-body">${c.body}</p>
      ${c.when && html`<p class="learn-card-when"><b>Use it when</b> ${c.when.charAt(0).toLowerCase() + c.when.slice(1)}</p>`}
      ${c.example && html`<p class="learn-card-eg"><span class="learn-eg-k">e.g.</span> ${c.example}</p>`}
    </article>`;
}

function Toc() {
  return html`
    <nav class="learn-toc" aria-label="On this page">
      <a class="learn-toc-link" href="#/learn/bead">Mental model</a>
      ${CONCEPT_GROUPS.map((g) => html`
        <a key=${g.id} class="learn-toc-link" href=${'#/learn/' + (conceptsInGroup(g.id)[0]?.key || 'bead')}>${g.title}</a>`)}
      <a class="learn-toc-link" href="#/learn/pour">Where things live</a>
    </nav>`;
}

export function LearnView() {
  // Deep links (#/learn/blocks) come from tooltips' "Read more" and from
  // nudges. Scrolling is done here rather than relying on native fragment
  // behaviour because the hash is a route, not a fragment.
  useEffect(() => {
    const jump = () => {
      const key = learnAnchorFromHash(location.hash);
      if (!key) { window.scrollTo({ top: 0 }); return; }
      const el = document.getElementById(anchorId(key));
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    };
    const t = setTimeout(jump, 30);
    window.addEventListener('hashchange', jump);
    return () => { clearTimeout(t); window.removeEventListener('hashchange', jump); };
  }, []);

  return html`
    <main class="strip-view learn-view" data-learn-view>
      <div class="view-header">
        <h1>Concepts</h1>
        <span class="learn-sub">A reference, not a tutorial — read the bit you need and go back to work.</span>
      </div>

      <${Toc} />

      <section class="learn-section" id="learn-model">
        <h2 class="learn-h2">The mental model</h2>
        <p class="learn-lede">
          beads is a to-do list that understands the word <em>because</em>.
        </p>
        <p>
          Every piece of work is a <b>bead</b> (this app also calls it an issue — same thing). On its own that is
          just a list. What makes beads different is that you can record how beads relate to each other: this one
          cannot start until that one is finished; this bug was caused by that change; this idea came out of doing
          that job.
        </p>
        <p>
          Once those connections exist, the tool answers questions a flat list cannot. <b>What can I actually
          work on right now?</b> — that is the Ready lane, and it is computed, not maintained by hand. <b>What is
          everything waiting on?</b> — that is the Map. <b>Why does this exist?</b> — that is the links section on
          any issue, still readable a year after everyone has forgotten.
        </p>
        <p>
          You never set "blocked" or "ready" yourself. You record the facts; the states follow. That is the whole
          trick, and everything below is vocabulary for it.
        </p>
      </section>

      ${CONCEPT_GROUPS.map((g) => html`
        <section key=${g.id} class="learn-section" id=${'learn-' + g.id}>
          <h2 class="learn-h2">${g.title}</h2>
          <p class="learn-group-blurb">${g.blurb}</p>
          <div class="learn-cards">
            ${conceptsInGroup(g.id).map((c) => html`<${ConceptCard} key=${c.key} c=${c} />`)}
          </div>
        </section>`)}

      <section class="learn-section" id="learn-where">
        <h2 class="learn-h2">Where things live in this app</h2>
        <div class="learn-where">
          <div class="learn-where-row">
            <span class="learn-where-k">The hub</span>
            <span class="learn-where-v">The first page: one card per project on this machine. Click a card to open that project.</span>
          </div>
          <div class="learn-where-row">
            <span class="learn-where-k">Flow</span>
            <span class="learn-where-v">Your work in five lanes — Triage, Ready, In progress, Blocked, Done this week — or grouped into one row per epic. This is the day-to-day screen.</span>
          </div>
          <div class="learn-where-row">
            <span class="learn-where-k">Map</span>
            <span class="learn-where-v">The same work drawn as a picture of what waits on what. Things that block others are on the left. The brightest path is the longest chain — the thing that decides how long everything takes.</span>
          </div>
          <div class="learn-where-row">
            <span class="learn-where-k">Docs</span>
            <span class="learn-where-v">The project's markdown files, readable and editable here. Select any sentence in a document and you can turn it straight into an issue that remembers where it came from.</span>
          </div>
          <div class="learn-where-row">
            <span class="learn-where-k">The omnibar</span>
            <span class="learn-where-v">The box at the top. Type a thought and press Enter to capture it. Type <code>&gt;</code> for a list of commands. Type part of a title to jump to it. Press <kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>K</kbd> from anywhere to get to it.</span>
          </div>
          <div class="learn-where-row">
            <span class="learn-where-k">The detail panel</span>
            <span class="learn-where-v">Click any card. Everything about one issue: its description, its connections, its comments, and every control for changing it.</span>
          </div>
          <div class="learn-where-row">
            <span class="learn-where-k">The green ✓ ran strip</span>
            <span class="learn-where-v">Under the header, after anything you change. It shows the terminal command that just ran on your behalf — <code>bd close abc-1</code> and so on. You never have to type these. It is there so that the day you want to, you already know them.</span>
          </div>
        </div>
      </section>

      <section class="learn-section" id="learn-hints">
        <h2 class="learn-h2">About the hints</h2>
        <p>
          Occasionally a one-line suggestion appears above your work — never more than one, never blocking
          anything, and never twice. Dismissing one retires it for good, and any hint you have already outgrown
          retires itself. If you would rather have none of them, <a href="#/settings">Settings</a> has a switch
          (and a way to bring them all back).
        </p>
        <p class="muted small">
          The <span class="learn-inline-dot" aria-hidden="true">?</span> markers next to words are not hints and
          are never turned off — looking a word up is something you might do on day one or in year three.
        </p>
      </section>

      <p class="learn-count muted small">${CONCEPTS.length} terms defined.</p>
    </main>`;
}
