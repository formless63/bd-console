'use strict';

// ---------------------------------------------------------------------------
// Hub Mode & Router State
// ---------------------------------------------------------------------------
let APP_MODE = 'single';
let PROJECT_ID = null;

function apiUrl(path) {
  if (APP_MODE === 'hub' && PROJECT_ID && path.startsWith('/api/')) {
    return '/api/p/' + PROJECT_ID + '/' + path.substring(5);
  }
  return path;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  issues: [],
  byId: new Map(),
  filters: { status: new Set(), priority: new Set(), type: new Set(), label: new Set() },
  search: '',
  groupEpic: true,
  readyOnly: false,
  sort: { key: 'priority', dir: 1 },
  selected: null,
  collapsedIssueGroups: new Set(JSON.parse(localStorage.getItem('bd_issue_groups_collapsed') || '[]')),
  docs: [],
  docFilter: '',
  selectedDoc: null,
  collapsedGroups: new Set(JSON.parse(localStorage.getItem('bd_docs_collapsed') || '[]'))
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- write helpers (token-aware) -------------------------------------------
let META = { writable: false, tokenRequired: false };
function getToken() {
  let t = localStorage.getItem('bd_token');
  if (!t && META.tokenRequired) { t = prompt('bd-console write token:') || ''; if (t) localStorage.setItem('bd_token', t); }
  return t || '';
}
async function apiPost(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (META.tokenRequired) headers['x-bd-token'] = getToken();
  const r = await fetch(apiUrl(path), { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
let toastTimer;
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}
function timeAgo(s) {
  const d = new Date(s), m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  return d.toLocaleDateString();
}
function fmtClock(ms) {
  return ms ? new Date(ms).toLocaleTimeString() : 'never';
}
function syncLabel(info) {
  if (!info) return 'sync unknown';
  if (info.error) return 'export error';
  if (!info.exists) return 'export missing';
  if (info.stale) return 'sync stale';
  if (info.refreshed) return 'sync refreshed';
  return 'sync ok';
}
function renderMeta(issuesCount, generatedAt, exportInfo) {
  const parts = [`${issuesCount} issues`, new Date(generatedAt).toLocaleTimeString()];
  if (exportInfo) {
    parts.push(`${syncLabel(exportInfo)} @ ${fmtClock(exportInfo.exportedAt)}`);
  }
  $('#meta').textContent = parts.join(' · ');
  $('#meta').dataset.state =
    exportInfo?.error ? 'err' :
    (!exportInfo?.exists || exportInfo?.stale) ? 'warn' :
    'ok';
}
function healthState(meta) {
  if (meta.health?.status) return meta.health.status;
  return 'ok';
}
function healthLabel(meta) {
  const state = healthState(meta);
  if (state === 'err') return 'attention needed';
  if (state === 'warn') return 'ready';
  return 'ready';
}
function bindLabel(meta) {
  return meta.hostname || 'unknown';
}
function exportStateLabel(info) {
  if (!info) return 'unknown';
  if (!info.exists) return 'missing';
  if (info.stale) return 'stale';
  return 'current';
}
function renderHealth() {
  const box = $('#health');
  if (!box) return;
  const exportInfo = META.export || {};
  const health = META.health || {};
  const errors = health.errors || [];
  box.innerHTML = `
    <div class="health-head">
      <span class="health-title">System</span>
      <span class="health-status ${esc(healthState(META))}">${esc(healthLabel(META))}</span>
    </div>
    <div class="health-kv">
      <span class="health-k">workspace</span><span class="health-v"><code>${esc(META.workspace || 'unknown')}</code></span>
      <span class="health-k">host</span><span class="health-v"><code>${esc(bindLabel(META))}</code></span>
      <span class="health-k">writes</span><span class="health-v">${META.tokenRequired ? 'token-gated' : 'open'}</span>
      <span class="health-k">export</span><span class="health-v">${esc(exportStateLabel(exportInfo))}${exportInfo.exportedAt ? ` @ ${esc(fmtClock(exportInfo.exportedAt))}` : ''}</span>
      <span class="health-k">docs</span><span class="health-v">${esc(health.docsMode || 'auto')}</span>
      <span class="health-k">bd</span><span class="health-v"><code>${esc(health.bdVersion || 'unknown')}</code></span>
    </div>
    ${errors.length ? `<div class="health-warnings">
      ${errors.map((msg) => `<div class="health-warning err">${esc(msg)}</div>`).join('')}
    </div>` : ''}`;
}

// ---------------------------------------------------------------------------
// Derived issue helpers
// ---------------------------------------------------------------------------
function blockersOf(issue) {
  const blockers = [];
  for (const b of state.issues) {
    if (b.id === issue.id) continue;
    // b blocks issue
    if (b.dependencies && b.dependencies.some(d => d.type === 'blocks' && d.depends_on_id === issue.id)) {
      blockers.push(b.id);
    }
    // issue depends on b
    if (issue.dependencies && issue.dependencies.some(d => d.type === 'depends' && d.depends_on_id === b.id)) {
      blockers.push(b.id);
    }
  }
  return blockers;
}
function parentOf(issue) {
  const p = (issue.dependencies || []).find((d) => d.type === 'parent-child');
  return p ? p.depends_on_id : null;
}
function openBlockersOf(issue) {
  return blockersOf(issue).filter((id) => {
    const b = state.byId.get(id);
    return b && b.status !== 'closed';
  });
}
// open + has unresolved blockers → "blocked"; open + none → effectively "open"(ready)
function effStatus(issue) {
  if (issue.status === 'open' && openBlockersOf(issue).length > 0) return 'blocked';
  return issue.status;
}
function isReady(issue) {
  return issue.status === 'open' && openBlockersOf(issue).length === 0;
}
function childrenOf(id) {
  return state.issues.filter((i) => parentOf(i) === id);
}
function blocksList(id) {
  // issues that depend on `id` (i.e., id blocks them)
  return state.issues.filter((i) => blockersOf(i).includes(id));
}

const PRI_LABEL = ['P0', 'P1', 'P2', 'P3', 'P4'];
const STATUS_ORDER = { in_progress: 0, blocked: 1, open: 2, closed: 3 };

// ---------------------------------------------------------------------------
// Data load
// ---------------------------------------------------------------------------
async function loadIssues() {
  const r = await fetch(apiUrl('/api/issues'));
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  const { issues, generatedAt, export: exportInfo } = data;
  state.issues = issues;
  state.byId = new Map(issues.map((i) => [i.id, i]));
  META.export = exportInfo;
  renderMeta(issues.length, generatedAt, exportInfo);
  renderHealth();
  buildFilterChips();
  renderIssues();
}
async function loadDocs() {
  const r = await fetch(apiUrl('/api/docs'));
  const { docs } = await r.json();
  state.docs = docs;
  renderDocTree();
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------
function buildFilterChips() {
  const counts = (fn) => {
    const m = new Map();
    for (const i of state.issues) {
      for (const v of [].concat(fn(i))) {
        if (v == null) continue;
        m.set(v, (m.get(v) || 0) + 1);
      }
    }
    return m;
  };
  renderChips('#f-status', counts((i) => effStatus(i)), 'status', ['in_progress', 'blocked', 'open', 'closed'], (v) => v.replace('_', ' '));
  renderChips('#f-priority', counts((i) => i.priority), 'priority', [0, 1, 2, 3, 4], (v) => PRI_LABEL[v]);
  renderChips('#f-type', counts((i) => i.issue_type), 'type', null, (v) => v);
  renderChips('#f-label', counts((i) => i.labels || []), 'label', null, (v) => v);
}
function renderChips(sel, countMap, kind, order, fmt) {
  const box = $(sel);
  box.innerHTML = '';
  let keys = [...countMap.keys()];
  if (order) keys = order.filter((k) => countMap.has(k));
  else keys.sort((a, b) => countMap.get(b) - countMap.get(a) || String(a).localeCompare(String(b)));
  for (const k of keys) {
    const chip = el('span', 'chip' + (state.filters[kind].has(k) ? ' on' : ''));
    if (kind === 'status') chip.classList.add('st', 'st-' + k);
    chip.innerHTML = `${esc(fmt(k))}<span class="ct">${countMap.get(k)}</span>`;
    chip.onclick = () => {
      state.filters[kind].has(k) ? state.filters[kind].delete(k) : state.filters[kind].add(k);
      buildFilterChips();
      renderIssues();
    };
    box.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Issue list
// ---------------------------------------------------------------------------
function passesFilters(i) {
  const f = state.filters;
  if (f.status.size && !f.status.has(effStatus(i))) return false;
  if (f.priority.size && !f.priority.has(i.priority)) return false;
  if (f.type.size && !f.type.has(i.issue_type)) return false;
  if (f.label.size && !(i.labels || []).some((l) => f.label.has(l))) return false;
  if (state.readyOnly && !isReady(i)) return false;
  if (state.search) {
    const q = state.search.toLowerCase();
    if (!(`${i.id} ${i.title} ${i.description || ''}`.toLowerCase().includes(q))) return false;
  }
  return true;
}


function priBadge(p) {
  return `<span class="badge pri pri-${p}">${PRI_LABEL[p] ?? p}</span>`;
}
function statusBadge(i) {
  const s = effStatus(i);
  return `<span class="badge st st-${s}">${s.replace('_', ' ')}</span>`;
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  const days = Math.round((Date.now() - d) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 14) return days + 'd ago';
  return d.toLocaleDateString();
}

function rowEl(i) {
  const row = el('div', 'issue-row' + (i.status === 'closed' ? ' closed' : '') + (state.selected === i.id ? ' sel' : ''));
  const isEpic = i.issue_type === 'epic';
  row.innerHTML = `
    <div class="it-main">
      <div class="it-title">${isEpic ? '◆ ' : ''}${esc(i.title)}</div>
      <div class="it-id">${esc(i.id)}${isEpic ? ' <span class="epic-mark">epic</span>' : ''}</div>
    </div>
    <div>${priBadge(i.priority)}</div>
    <div>${statusBadge(i)}</div>
    <div class="muted" style="font-size:12px">${fmtDate(i.updated_at)}</div>`;
  row.onclick = () => selectIssue(i.id);
  return row;
}

function sortIssues(list) {
  const { key, dir } = state.sort;
  return list.slice().sort((a, b) => {
    let av, bv;
    if (key === 'status') { av = STATUS_ORDER[effStatus(a)]; bv = STATUS_ORDER[effStatus(b)]; }
    else if (key === 'priority') { av = a.priority; bv = b.priority; }
    else { av = a[key] || ''; bv = b[key] || ''; }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return a.id.localeCompare(b.id);
  });
}

function getSortedFilteredIssues() {
  const shown = state.issues.filter(passesFilters);
  if (state.groupEpic) {
    const epics = sortIssues(shown.filter((i) => i.issue_type === 'epic' || !parentOf(i)));
    const childMap = new Map();
    for (const i of shown) {
      const p = parentOf(i);
      if (p) { if (!childMap.has(p)) childMap.set(p, []); childMap.get(p).push(i); }
    }
    const flattened = [];
    const rendered = new Set();
    const addGroup = (head) => {
      const kids = sortIssues(childMap.get(head.id) || []);
      const key = `epic:${head.id}`;
      flattened.push(head);
      rendered.add(head.id);
      if (!state.collapsedIssueGroups.has(key)) {
        for (const k of kids) { flattened.push(k); rendered.add(k.id); }
      }
    };
    for (const e of epics) if (e.issue_type === 'epic') addGroup(e);
    const orphans = sortIssues(shown.filter((i) => !rendered.has(i.id) && !parentOf(i) && i.issue_type !== 'epic'));
    if (orphans.length) {
      const key = 'standalone';
      if (!state.collapsedIssueGroups.has(key)) {
        for (const o of orphans) { flattened.push(o); rendered.add(o.id); }
      }
    }
    const leftover = sortIssues(shown.filter((i) => !rendered.has(i.id)));
    for (const o of leftover) flattened.push(o);
    return flattened.filter(i => i.id);
  } else {
    return sortIssues(shown);
  }
}

function selectNextIssue() {
  const list = getSortedFilteredIssues();
  if (!list.length) return;
  const idx = list.findIndex(i => i.id === state.selected);
  const nextIdx = idx === -1 ? 0 : Math.min(idx + 1, list.length - 1);
  selectIssue(list[nextIdx].id);
  setTimeout(() => {
    const activeRow = $('.issue-row.sel');
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
  }, 50);
}

function selectPrevIssue() {
  const list = getSortedFilteredIssues();
  if (!list.length) return;
  const idx = list.findIndex(i => i.id === state.selected);
  const prevIdx = idx === -1 ? 0 : Math.max(idx - 1, 0);
  selectIssue(list[prevIdx].id);
  setTimeout(() => {
    const activeRow = $('.issue-row.sel');
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
  }, 50);
}

function toggleIssueGroup(key) {
  if (state.collapsedIssueGroups.has(key)) state.collapsedIssueGroups.delete(key);
  else state.collapsedIssueGroups.add(key);
  localStorage.setItem('bd_issue_groups_collapsed', JSON.stringify([...state.collapsedIssueGroups]));
  renderIssues();
}

function issueGroupHead({ key, title, meta, count, selectId }) {
  const collapsed = state.collapsedIssueGroups.has(key);
  const head = el('div', 'group-head' + (collapsed ? ' collapsed' : ''));
  const chev = collapsed ? '▸' : '▾';
  head.innerHTML = `
    <button class="group-toggle" type="button" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? 'Expand group' : 'Collapse group'}">
      <span class="group-chev">${chev}</span>
      <span class="group-title">${esc(title)}</span>
      <span class="gh-id">${count != null ? `${count} · ` : ''}${meta || ''}</span>
    </button>
    ${selectId ? '<button class="group-open btn btn-ghost" type="button" title="Open group issue">View</button>' : ''}`;
  const toggle = head.querySelector('.group-toggle');
  toggle.onclick = () => toggleIssueGroup(key);
  const open = head.querySelector('.group-open');
  if (open) open.onclick = () => selectIssue(selectId);
  return head;
}

function renderIssues() {
  const list = $('#issue-list');
  list.innerHTML = '';
  const shown = state.issues.filter(passesFilters);

  if (state.groupEpic) {
    const epics = sortIssues(shown.filter((i) => i.issue_type === 'epic' || !parentOf(i)));
    const childMap = new Map();
    for (const i of shown) {
      const p = parentOf(i);
      if (p) { if (!childMap.has(p)) childMap.set(p, []); childMap.get(p).push(i); }
    }
    const rendered = new Set();
    const renderGroup = (head) => {
      const kids = sortIssues(childMap.get(head.id) || []);
      const key = `epic:${head.id}`;
      const gh = issueGroupHead({
        key,
        title: head.title,
        meta: `${esc(head.id)} · ${statusBadge(head)}`,
        count: kids.length,
        selectId: head.id
      });
      list.appendChild(gh);
      rendered.add(head.id);
      if (!state.collapsedIssueGroups.has(key)) {
        for (const k of kids) { list.appendChild(rowEl(k)); rendered.add(k.id); }
      }
    };
    for (const e of epics) if (e.issue_type === 'epic') renderGroup(e);
    // orphans (non-epic, no parent in shown set)
    const orphans = sortIssues(shown.filter((i) => !rendered.has(i.id) && !parentOf(i) && i.issue_type !== 'epic'));
    if (orphans.length) {
      const key = 'standalone';
      const gh = issueGroupHead({
        key,
        title: 'Standalone',
        meta: '',
        count: orphans.length,
        selectId: null
      });
      list.appendChild(gh);
      if (!state.collapsedIssueGroups.has(key)) {
        for (const o of orphans) { list.appendChild(rowEl(o)); rendered.add(o.id); }
      }
    }
    // any child whose parent was filtered out
    const leftover = sortIssues(shown.filter((i) => !rendered.has(i.id)));
    for (const o of leftover) list.appendChild(rowEl(o));
  } else {
    for (const i of sortIssues(shown)) list.appendChild(rowEl(i));
  }
  if (!shown.length) list.appendChild(el('div', 'detail-empty muted', 'No issues match.'));
}

// ---------------------------------------------------------------------------
// Issue detail
// ---------------------------------------------------------------------------
function relRow(id) {
  const i = state.byId.get(id);
  const r = el('div', 'rel-item');
  if (!i) { r.innerHTML = `<span class="it-id">${esc(id)}</span><span class="rt muted">(unknown)</span>`; return r; }
  r.innerHTML = `<span class="badge st st-${effStatus(i)}">${effStatus(i).replace('_', ' ')}</span><span class="rt">${esc(i.title)}</span><span class="it-id">${esc(i.id)}</span>`;
  r.onclick = () => selectIssue(id);
  return r;
}

function selectIssue(id) {
  const update = () => {
    state.selected = id;
    document.querySelectorAll('.issue-row').forEach((r) => r.classList.remove('sel'));
    renderIssues();
    const i = state.byId.get(id);
    // Mobile: switch to the detail pane.
    $('#view-issues').dataset.pane = 'detail';
    $('#mi-title').textContent = i ? i.id : '';
    closeDrawer();
    const d = $('#detail');
    if (!i) { d.innerHTML = '<div class="detail-empty muted">Not found.</div>'; return; }

    const blockers = blockersOf(i);
    const openBlockers = openBlockersOf(i);
    const children = childrenOf(id);
    const blocks = blocksList(id);
    const parent = parentOf(i);

    let html = `<div class="detail-head">
      <div class="detail-meta">${priBadge(i.priority)}${statusBadge(i)}<span class="badge type-tag">${esc(i.issue_type)}</span><span class="it-id">${esc(i.id)}</span></div>
      <h2>${esc(i.title)}</h2>
      <div class="detail-meta">${(i.labels || []).map((l) => `<span class="lab">${esc(l)}</span>`).join('')}</div>
    </div><div class="detail-body">`;

    if (i.status !== 'closed' && openBlockers.length) {
      html += `<div class="blocked-banner">⛔ Blocked by ${openBlockers.length} open ${openBlockers.length === 1 ? 'issue' : 'issues'}</div>`;
    } else if (isReady(i) && i.issue_type !== 'epic') {
      html += `<div class="ready-banner">✓ Ready to work — no open blockers</div>`;
    }

    if (i.description) html += section('Description', `<div class="field-text">${esc(i.description)}</div>`);
    if (i.status === 'closed' && i.close_reason) html += section('Close reason', `<div class="close-reason">${esc(i.close_reason)}</div>`);
    if (i.notes) html += section('Notes', `<div class="field-text">${esc(i.notes)}</div>`);
    if (i.design) html += section('Design', `<div class="field-text">${esc(i.design)}</div>`);
    if (i.acceptance_criteria) html += section('Acceptance', `<div class="field-text">${esc(i.acceptance_criteria)}</div>`);

    if (parent) html += section('Parent', `<div class="rel">${relRow(parent).outerHTML}</div>`);
    if (blockers.length) html += section(`Blocked by (${blockers.length})`, `<div class="rel">${blockers.map((b) => relRow(b).outerHTML).join('')}</div>`);
    if (blocks.length) html += section(`Blocks (${blocks.length})`, `<div class="rel">${blocks.map((b) => relRow(b.id).outerHTML).join('')}</div>`);
    if (children.length) html += section(`Children (${children.length})`, `<div class="rel">${children.map((c) => relRow(c.id).outerHTML).join('')}</div>`);

    html += section('Edit', `<div class="edit-tools">
      <div class="edit-row">
        ${i.status !== 'closed' ? '<button class="btn" id="act-claim">Claim</button>' : ''}
        ${i.status !== 'in_progress' ? '<button class="btn" id="act-progress">In progress</button>' : ''}
        ${i.status !== 'closed' ? '<button class="btn" id="act-close">Close</button>' : '<button class="btn" id="act-reopen">Reopen</button>'}
      </div>
      <div class="edit-block">
        <label class="edit-label" for="edit-priority">Priority</label>
        <div class="edit-row">
          <select id="edit-priority" class="edit-input">
            ${[0, 1, 2, 3, 4].map((p) => `<option value="${p}"${i.priority === p ? ' selected' : ''}>${PRI_LABEL[p]}</option>`).join('')}
          </select>
          <button class="btn" id="act-priority">Apply</button>
        </div>
      </div>
      <div class="edit-block">
        <label class="edit-label" for="edit-label-add">Labels</label>
        <div class="edit-chiprow">
          ${(i.labels || []).map((label) => `<button class="chip edit-chip-remove" data-label="${esc(label)}" title="Remove label">${esc(label)} ×</button>`).join('')}
        </div>
        <div class="edit-row">
          <input id="edit-label-add" class="edit-input" type="text" placeholder="new-label" />
          <button class="btn" id="act-label-add">Add</button>
        </div>
      </div>
      <div class="edit-block">
        <label class="edit-label" for="edit-parent">Parent</label>
        <div class="edit-row">
          <input id="edit-parent" class="edit-input" type="text" value="${esc(parent || '')}" placeholder="issue-id" />
          <button class="btn" id="act-parent-save">Save</button>
          <button class="btn btn-ghost" id="act-parent-clear">Clear</button>
        </div>
      </div>
      <div class="edit-block">
        <label class="edit-label" for="edit-blocker">Blocked by</label>
        <div class="edit-chiprow">
          ${blockers.map((blocker) => `<button class="chip edit-chip-remove" data-blocker="${esc(blocker)}" title="Remove blocker">${esc(blocker)} ×</button>`).join('')}
        </div>
        <div class="edit-row">
          <input id="edit-blocker" class="edit-input" type="text" placeholder="issue-id" />
          <button class="btn" id="act-blocker-add">Add</button>
        </div>
      </div>
      <div class="edit-block">
        <label class="edit-label" for="edit-defer">Defer until</label>
        <div class="edit-row">
          <input id="edit-defer" class="edit-input" type="text" value="${esc(i.deferred_until || '')}" placeholder="+1d or 2026-06-20" />
          <button class="btn" id="act-defer-save">Save</button>
          <button class="btn btn-ghost" id="act-defer-clear">Clear</button>
        </div>
      </div>
      <div id="edit-err" class="modal-err"></div>
    </div>`);

    html += section(`Comments`, `<div id="comments-mount" class="comments"><div class="comments-empty">loading…</div></div>
      <div class="comment-add">
        <textarea id="comment-input" placeholder="Add a comment…"></textarea>
        <div class="row"><span id="comment-err" class="modal-err"></span><button class="btn btn-accent" id="comment-send">Comment</button></div>
      </div>`);

    html += section('Details', `<div class="kv">
      <span class="k">Assignee</span><span class="v">${esc(i.assignee || '—')}</span>
      <span class="k">Created</span><span class="v">${new Date(i.created_at).toLocaleString()}</span>
      <span class="k">Updated</span><span class="v">${new Date(i.updated_at).toLocaleString()}</span>
      ${i.closed_at ? `<span class="k">Closed</span><span class="v">${new Date(i.closed_at).toLocaleString()}</span>` : ''}
    </div>`);

    html += '</div>';
    d.innerHTML = html;
    d.scrollTop = 0;
    wireIssueEdit(i);
    wireComments(id);
  };
  if (document.startViewTransition) {
    document.startViewTransition(update);
  } else {
    update();
  }
}

function section(title, body) {
  return `<div class="detail-section"><h3>${esc(title)}</h3>${body}</div>`;
}

// --- comments ---------------------------------------------------------------
function renderCommentsList(comments) {
  const mount = $('#comments-mount');
  if (!mount) return;
  if (!comments.length) { mount.innerHTML = '<div class="comments-empty">No comments yet.</div>'; return; }
  mount.innerHTML = comments
    .map((c) => `<div class="comment"><div class="comment-meta"><span class="author">${esc(c.author || 'someone')}</span><span>${esc(timeAgo(c.created_at))}</span></div><div class="comment-text">${esc(c.text)}</div></div>`)
    .join('');
}
async function wireComments(id) {
  try {
    const r = await fetch('/api/comments?id=' + encodeURIComponent(id));
    const { comments } = await r.json();
    if (state.selected === id) renderCommentsList(comments || []);
  } catch { /* ignore */ }
  const send = $('#comment-send');
  const input = $('#comment-input');
  if (!send || !input) return;
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    $('#comment-err').textContent = '';
    try {
      const { comments } = await apiPost('/api/comment', { id, text });
      input.value = '';
      renderCommentsList(comments || []);
      toast('Comment added to ' + id);
    } catch (e) {
      $('#comment-err').textContent = e.message;
    } finally {
      send.disabled = false;
    }
  };
  send.onclick = submit;
  input.onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); };
}

async function performIssueEdit(payload, successMessage, id) {
  await apiPost('/api/edit', payload);
  await loadIssues();
  if (id) selectIssue(id);
  toast(successMessage);
}

function issueEditError(msg) {
  const err = $('#edit-err');
  if (err) err.textContent = msg || '';
}

function wireIssueEdit(issue) {
  const id = issue.id;
  const on = (sel, fn) => {
    const node = $(sel);
    if (node) node.onclick = fn;
  };
  const run = async (payload, success) => {
    issueEditError('');
    try {
      await performIssueEdit({ id, ...payload }, success, id);
    } catch (e) {
      issueEditError(e.message);
    }
  };

  on('#act-claim', () => run({ op: 'claim' }, `Claimed ${id}`));
  on('#act-progress', () => run({ op: 'set-status', status: 'in_progress' }, `Marked ${id} in progress`));
  on('#act-close', () => {
    const reason = prompt('Close reason (optional):', '') || '';
    run({ op: 'set-status', status: 'closed', reason }, `Closed ${id}`);
  });
  on('#act-reopen', () => {
    const reason = prompt('Reopen reason (optional):', '') || '';
    run({ op: 'set-status', status: 'open', reason }, `Reopened ${id}`);
  });
  on('#act-priority', () => run({ op: 'set-priority', priority: $('#edit-priority').value }, `Updated priority for ${id}`));
  on('#act-label-add', () => {
    const label = $('#edit-label-add').value.trim();
    if (!label) return;
    run({ op: 'add-label', label }, `Added label to ${id}`);
  });
  on('#act-parent-save', () => run({ op: 'set-parent', parent: $('#edit-parent').value.trim() }, `Updated parent for ${id}`));
  on('#act-parent-clear', () => run({ op: 'set-parent', parent: '' }, `Cleared parent for ${id}`));
  on('#act-blocker-add', () => {
    const blocker = $('#edit-blocker').value.trim();
    if (!blocker) return;
    run({ op: 'add-blocker', blocker }, `Added blocker to ${id}`);
  });
  on('#act-defer-save', () => run({ op: 'set-defer', defer: $('#edit-defer').value.trim() }, `Updated defer for ${id}`));
  on('#act-defer-clear', () => run({ op: 'set-defer', defer: '' }, `Cleared defer for ${id}`));

  document.querySelectorAll('[data-label]').forEach((node) => {
    node.onclick = () => run({ op: 'remove-label', label: node.dataset.label }, `Removed label from ${id}`);
  });
  document.querySelectorAll('[data-blocker]').forEach((node) => {
    node.onclick = () => run({ op: 'remove-blocker', blocker: node.dataset.blocker }, `Removed blocker from ${id}`);
  });
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------
function docItemEl(doc) {
  const item = el('div', 'doc-item' + (state.selectedDoc === doc.path ? ' sel' : ''));
  item.textContent = doc.path.split('/').pop();
  item.title = doc.path;
  item.onclick = () => openDoc(doc.path);
  return item;
}
function toggleGroup(name) {
  state.collapsedGroups.has(name) ? state.collapsedGroups.delete(name) : state.collapsedGroups.add(name);
  localStorage.setItem('bd_docs_collapsed', JSON.stringify([...state.collapsedGroups]));
  renderDocTree();
}
function renderDocTree() {
  const box = $('#doc-tree');
  box.innerHTML = '';
  const q = state.docFilter.toLowerCase();
  const filtered = state.docs.filter((d) => !q || d.path.toLowerCase().includes(q));
  const searching = !!q;

  // Root-level docs float to the very top as bare items (no folder header).
  for (const doc of filtered.filter((d) => d.group === '(top level)')) box.appendChild(docItemEl(doc));

  // Everything else: collapsible folders, sorted by name.
  const groups = new Map();
  for (const doc of filtered) {
    if (doc.group === '(top level)') continue;
    if (!groups.has(doc.group)) groups.set(doc.group, []);
    groups.get(doc.group).push(doc);
  }
  for (const name of [...groups.keys()].sort()) {
    const docs = groups.get(name);
    const collapsed = !searching && state.collapsedGroups.has(name);
    const head = el('div', 'doc-group' + (collapsed ? ' collapsed' : ''));
    head.innerHTML = `<span class="chev">▾</span><span class="gname">${esc(name)}</span><span class="gct">${docs.length}</span>`;
    head.onclick = () => toggleGroup(name);
    box.appendChild(head);
    if (!collapsed) for (const doc of docs) box.appendChild(docItemEl(doc));
  }
  if (!box.children.length) box.appendChild(el('div', 'detail-empty muted', 'No docs match.'));
}

async function openDoc(path) {
  state.selectedDoc = path;
  renderDocTree();
  // Mobile: switch to the content pane.
  $('#view-docs').dataset.pane = 'content';
  $('#md-title').textContent = path.split('/').pop();
  const r = await fetch(apiUrl('/api/doc?path=' + encodeURIComponent(path)));
  const pane = $('#doc-content');
  if (!r.ok) { pane.innerHTML = '<div class="detail-empty muted">Could not load.</div>'; return; }
  const { content } = await r.json();
  pane.innerHTML = `<div class="doc-pathline">${esc(path)}</div>` + renderMarkdown(content);
  pane.scrollTop = 0;
}

// Compact markdown renderer (headings, code, lists, tables, blockquote, inline).
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) => `<a href="${esc(href)}" target="_blank" rel="noopener">${txt}</a>`);
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      let code = '';
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + '\n'; i++; }
      i++;
      html += `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { const lv = h[1].length; html += `<h${lv}>${inline(h[2])}</h${lv}>`; i++; continue; }
    if (/^\s*([-*_])\1{1,}\s*$/.test(line) || /^---+$/.test(line)) { html += '<hr>'; i++; continue; }
    if (/^>\s?/.test(line)) {
      let q = '';
      while (i < lines.length && /^>\s?/.test(lines[i])) { q += lines[i].replace(/^>\s?/, '') + ' '; i++; }
      html += `<blockquote>${inline(q.trim())}</blockquote>`;
      continue;
    }
    // table
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      let rows = '';
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) { rows += `<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`; i++; }
      html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      continue;
    }
    // lists
    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      let items = '';
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
        if (!m) break;
        let txt = m[3];
        const cb = txt.match(/^\[([ xX])\]\s+(.*)/);
        if (cb) txt = `<input type="checkbox" disabled ${cb[1] !== ' ' ? 'checked' : ''}>${inline(cb[2])}`;
        else txt = inline(txt);
        items += `<li>${txt}</li>`;
        i++;
      }
      html += ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    // paragraph (gather until blank)
    let para = line;
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])) { para += ' ' + lines[i]; i++; }
    html += `<p>${inline(para)}</p>`;
  }
  return html;
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Mobile drawer / pane navigation
// ---------------------------------------------------------------------------
function openDrawer() { $('.filters').classList.add('open'); $('#backdrop').classList.add('show'); }
function closeDrawer() { document.querySelectorAll('.filters.open').forEach((f) => f.classList.remove('open')); $('#backdrop').classList.remove('show'); }

// --- quick capture ----------------------------------------------------------
function openQuick() {
  const modal = $('#quick-modal');
  if (modal && modal.showModal) {
    modal.showModal();
  } else {
    modal.classList.add('show');
  }
  $('#quick-err').textContent = '';
  setTimeout(() => $('#quick-title').focus(), 30);
}
function closeQuick() {
  const modal = $('#quick-modal');
  if (modal && modal.close) {
    modal.close();
  } else {
    modal.classList.remove('show');
  }
}
async function submitQuick() {
  const title = $('#quick-title').value.trim();
  if (!title) { $('#quick-err').textContent = 'Title required'; return; }
  const body = {
    title,
    description: $('#quick-desc').value.trim() || undefined,
    label: $('#quick-label').value.trim() || 'triage',
    priority: $('#quick-priority').value
  };
  $('#quick-save').disabled = true;
  try {
    const { id } = await apiPost('/api/quick', body);
    $('#quick-title').value = ''; $('#quick-desc').value = '';
    closeQuick();
    toast('Captured ' + id);
    await loadIssues();
    if (id) selectIssue(id);
  } catch (e) {
    $('#quick-err').textContent = e.message;
  } finally {
    $('#quick-save').disabled = false;
  }
}

// --- theme ------------------------------------------------------------------
const THEMES = [
  ['dark', 'Dark'], ['light', 'Light'], ['github-light', 'GitHub Light'],
  ['solarized-light', 'Solarized Light'], ['solarized-dark', 'Solarized Dark'],
  ['nord', 'Nord'], ['dracula', 'Dracula'], ['gruvbox', 'Gruvbox'],
  ['tokyo-night', 'Tokyo Night'], ['catppuccin', 'Catppuccin']
];
function initTheme() {
  const sel = $('#theme-select');
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  sel.innerHTML = THEMES.map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${l}</option>`).join('');
  sel.onchange = () => {
    document.documentElement.setAttribute('data-theme', sel.value);
    localStorage.setItem('bd_theme', sel.value);
  };
}


function switchTab(viewName) {
  const t = document.querySelector(`.tab[data-view="${viewName}"]`);
  if (!t) return;
  const update = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('view-hub').classList.toggle('hidden', viewName !== 'hub');
    document.getElementById('view-issues').classList.toggle('hidden', viewName !== 'issues');
    document.getElementById('view-docs').classList.toggle('hidden', viewName !== 'docs');
    if (viewName === 'docs' && !state.docs.length) loadDocs();
  };
  if (document.startViewTransition) document.startViewTransition(update);
  else update();
}

async function loadMeta(useProjectUrl = false) {
  try {
    const url = useProjectUrl ? apiUrl('/api/meta') : '/api/meta';
    const r = await fetch(url);
    META = await r.json();
    document.getElementById('ws-name').textContent = META.name || (PROJECT_ID || 'bd-console');
    document.title = (META.name || 'bd') + ' · console';
    renderHealth();
  } catch { /* ignore */ }
}

async function loadHub() {
  const r = await fetch('/api/projects');
  const data = await r.json();
  const list = document.getElementById('project-list');
  list.innerHTML = '';
  if (!data.projects || Object.keys(data.projects).length === 0) {
    list.innerHTML = '<div class="muted" style="grid-column: 1/-1; text-align: center;">No projects registered. Run <code>bd-console add</code> inside a project to register it.</div>';
    return;
  }
  for (const [id, p] of Object.entries(data.projects)) {
    const card = el('div', 'hub-card');
    card.innerHTML = `
      <div class="hub-card-title">${esc(id)}</div>
      <div class="hub-card-path">${esc(p.path)}</div>
      <div class="hub-card-stats" id="stats-${id}">
        <span class="muted" style="font-size:12px;">Loading stats...</span>
      </div>
    `;
    card.onclick = () => { window.location.hash = '#/p/' + id; };
    list.appendChild(card);
    
    // Fetch stats async
    fetch('/api/p/' + id + '/issues')
      .then(res => res.json())
      .then(res => {
         const issues = res.issues || [];
         const tally = { open: 0, in_progress: 0, blocked: 0, closed: 0 };
         for (const i of issues) {
            const effStatus = () => {
              if (i.status !== 'open') return i.status;
              const isBlocked = issues.some(b => {
                 if (b.status === 'closed') return false;
                 if (b.dependencies && b.dependencies.some(d => d.type === 'blocks' && d.depends_on_id === i.id)) return true;
                 if (i.dependencies && i.dependencies.some(d => d.type === 'depends' && d.depends_on_id === b.id)) return true;
                 return false;
              });
              if (isBlocked) return 'blocked';
              return 'open';
            };
            const st = effStatus();
            if (st === 'open') tally.open++;
            else if (st === 'in_progress') tally.in_progress++;
            else if (st === 'blocked') tally.blocked++;
            else if (st === 'closed') tally.closed++;
         }
         const statsDiv = document.getElementById('stats-' + id);
         if (statsDiv) {
           statsDiv.innerHTML = `
             <div class="stat-pill"><span class="st-indicator st-open"></span> ${tally.open} Open</div>
             <div class="stat-pill"><span class="st-indicator st-in_progress"></span> ${tally.in_progress} Active</div>
             <div class="stat-pill"><span class="st-indicator st-blocked"></span> ${tally.blocked} Blocked</div>
             <div class="stat-pill"><span class="st-indicator st-closed"></span> ${tally.closed} Closed</div>
             <div class="stat-pill"><span class="st-indicator st-blocked"></span> ${tally.blocked} Blocked</div>
           `;
         }
      })
      .catch(() => {
         const statsDiv = document.getElementById('stats-' + id);
         if (statsDiv) statsDiv.innerHTML = '<span class="muted" style="font-size:12px;">Failed to load</span>';
      });
  }
}


async function handleRoute() {
  const hash = window.location.hash || '#/';
  if (APP_MODE === 'hub') {
    if (hash.startsWith('#/p/')) {
      PROJECT_ID = hash.substring(4);
      state.issues = [];
      state.docs = [];
      renderIssues();
      renderDocTree();
      
      // Update theme for this project
      const saved = localStorage.getItem('bd_theme_' + PROJECT_ID) || localStorage.getItem('bd_theme');
      const t = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', t);
      const ts = document.getElementById('theme-select');
      if (ts) ts.value = t;

      await loadMeta(true);
      
      switchTab('issues');
      document.querySelector('.tabs').style.display = '';
      document.getElementById('nav-hub').classList.remove('hidden');
      loadIssues().catch(e => toast(e.message, 'err'));
      loadDocs();
    } else {
      PROJECT_ID = null;
      document.getElementById('ws-name').textContent = 'bd-console';
      switchTab('hub');
      document.querySelector('.tabs').style.display = 'none';
      document.getElementById('nav-hub').classList.add('hidden');
      loadHub();
    }
  } else {
    // Single mode
    loadIssues().catch(e => toast(e.message, 'err'));
    loadDocs();
  }
}

function init() {
  // mobile nav
  $('#mi-filters').onclick = openDrawer;
  $('#mi-back').onclick = () => { $('#view-issues').dataset.pane = 'list'; };
  $('#md-tree').onclick = () => { $('#view-docs').dataset.pane = 'tree'; };
  $('#backdrop').onclick = closeDrawer;

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => switchTab(t.dataset.view);
  });
  
  const navHub = document.getElementById('nav-hub');
  if (navHub) navHub.onclick = () => { window.location.hash = '#/'; };

  $('#search').oninput = (e) => { state.search = e.target.value; renderIssues(); };
  $('#group-epic').onchange = (e) => { state.groupEpic = e.target.checked; renderIssues(); };
  $('#ready-only').onchange = (e) => { state.readyOnly = e.target.checked; renderIssues(); };
  $('#clear-filters').onclick = () => {
    for (const k of Object.keys(state.filters)) state.filters[k].clear();
    state.search = ''; state.readyOnly = false;
    $('#search').value = ''; $('#ready-only').checked = false;
    buildFilterChips(); renderIssues();
  };
  $('#refresh').onclick = async () => {
    try {
      if (APP_MODE === 'hub' && !PROJECT_ID) return loadHub();
      await loadIssues();
      if (state.docs.length) loadDocs();
      toast('Reloaded issues');
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  $('#doc-search').oninput = (e) => { state.docFilter = e.target.value; renderDocTree(); };
  document.querySelectorAll('.list-head .sort').forEach((h) => {
    h.onclick = () => {
      const k = h.dataset.sort;
      state.sort.dir = state.sort.key === k ? -state.sort.dir : 1;
      state.sort.key = k;
      renderIssues();
    };
  });

  // quick capture
  $('#quick-open').onclick = openQuick;
  $('#quick-cancel').onclick = closeQuick;
  $('#quick-save').onclick = submitQuick;
  $('#quick-modal').onclick = (e) => { if (e.target.id === 'quick-modal') closeQuick(); };
  $('#quick-title').onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitQuick(); };
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') closeQuick();
    if (!typing && !e.metaKey && !e.ctrlKey) {
      if (e.key === 'i') { e.preventDefault(); openQuick(); }
      else if (e.key === 'j') { e.preventDefault(); selectNextIssue(); }
      else if (e.key === 'k') { e.preventDefault(); selectPrevIssue(); }
      else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
      else if (e.key === 'c') {
        const commentBox = $('#comment-input');
        if (commentBox) { e.preventDefault(); commentBox.focus(); }
      }
    }
  });

  initTheme();
  
  // boot
  fetch('/api/meta').then(r => r.json()).then(m => {
    APP_MODE = m.mode || 'single';
    META = m;
    if (APP_MODE === 'hub') {
      window.addEventListener('hashchange', handleRoute);
      handleRoute();
    } else {
      loadMeta();
      handleRoute();
    }
  }).catch(() => {
    loadMeta();
    handleRoute();
  });
}
init();
