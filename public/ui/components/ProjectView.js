// ProjectView.js — per-project shell: Beads/Docs tabs and the responsive
// three-pane layout (filters · list · detail). On narrow screens the filters
// collapse into a Shoelace drawer and the detail slides over the list.
import { html } from 'htm/preact';
import { store, navigate, selectIssue } from '../store.js';
import { FiltersPane } from './FiltersPane.js';
import { IssueList } from './IssueList.js';
import { IssueDetail } from './IssueDetail.js';
import { DocsView } from './DocsView.js';

function Tabs() {
  const tab = store.route.value.tab;
  const pid = store.route.value.projectId;
  const go = (e) => {
    const name = e.detail?.name;
    if (name === 'docs') navigate('#/p/' + encodeURIComponent(pid) + '/docs');
    else navigate('#/p/' + encodeURIComponent(pid));
  };
  return html`
    <sl-tab-group class="project-tabs" onsl-tab-show=${go}>
      <sl-tab slot="nav" panel="issues" active=${tab === 'issues'}>Beads</sl-tab>
      <sl-tab slot="nav" panel="docs" active=${tab === 'docs'}>Docs</sl-tab>
    </sl-tab-group>`;
}

function IssuesLayout() {
  const detailOpen = !!store.selectedId.value;
  return html`
    <div class="mobile-bar">
      <button class="btn btn-ghost" onClick=${() => (store.mobileFiltersOpen.value = true)}>☰ Filters</button>
      ${detailOpen && html`<button class="btn btn-ghost" onClick=${() => selectIssue(null)}>← List</button>`}
      <span class="mb-title muted">${store.selectedId.value || ''}</span>
    </div>
    <div class=${'project-panes issues-layout' + (detailOpen ? ' show-detail' : '')}>
      ${FiltersPane()}
      ${IssueList()}
      ${IssueDetail()}
    </div>`;
}

function DocsLayout() {
  const detailOpen = !!store.selectedDocPath.value;
  return html`
    <div class=${'mobile-bar' + (detailOpen ? '' : ' mobile-bar-empty')}>
      ${detailOpen && html`<button class="btn btn-ghost" onClick=${() => (store.selectedDocPath.value = null)}>← Docs</button>`}
      <span class="mb-title muted">${(store.selectedDocPath.value || '').split('/').pop() || ''}</span>
    </div>
    ${DocsView()}`;
}

export function ProjectView() {
  const tab = store.route.value.tab;
  return html`
    <main class="project-view">
      ${Tabs()}
      ${tab === 'docs' ? DocsLayout() : IssuesLayout()}
      <sl-drawer
        class="mobile-drawer"
        placement="start"
        label="Filters"
        open=${store.mobileFiltersOpen.value}
        onsl-after-hide=${() => (store.mobileFiltersOpen.value = false)}
      >
        ${tab === 'docs' ? null : FiltersPane()}
      </sl-drawer>
    </main>`;
}
