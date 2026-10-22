// Cross-project work derivations. No DOM, requests, or persisted issue bodies.
import { blockersOf } from './relationships.js';
import { reviewOf } from './issueContent.js';
export const issueLink = (projectId, id) => `#/p2/${encodeURIComponent(projectId)}/issue/${encodeURIComponent(id)}`;
export function projectWork(projectId, project, issues, now = Date.now()) {
  const byId = new Map(issues.map(i => [i.id, i]));
  const dependents = new Map();
  for (const issue of issues.filter(i => i.status !== 'closed')) {
    for (const blocker of blockersOf(issue)) dependents.set(blocker, (dependents.get(blocker) || 0) + 1);
  }
  return issues.map(issue => {
    const deferred = Date.parse(issue.defer_until) > now;
    const ready = issue.status === 'open' && !deferred && !blockersOf(issue).some(id => byId.get(id)?.status !== 'closed');
    const review = reviewOf(issue);
    const reasons = [];
    let rank = 100;
    if (issue.status !== 'closed' && !deferred) {
      if (issue.issue_type === 'gate' && (!issue.await_type || issue.await_type === 'human')) { reasons.push('Human approval needed'); rank = 0; }
      if (review && ['pending', 'changes_requested'].includes(review.decision)) { reasons.push(review.decision === 'pending' ? 'Needs review' : 'Changes requested'); rank = Math.min(rank, 1); }
      if (issue.status === 'in_progress' && now - Date.parse(issue.updated_at) > 86400000) { reasons.push('In progress · no update for 24h'); rank = Math.min(rank, 2); }
      if (dependents.has(issue.id)) { reasons.push(`Blocks ${dependents.get(issue.id)} open issue${dependents.get(issue.id) === 1 ? '' : 's'}`); rank = Math.min(rank, 3); }
      if (ready && Number(issue.priority) <= 1) { reasons.push(`P${issue.priority} ready to start`); rank = Math.min(rank, 4); }
    }
    return { projectId, projectName: project.name || projectId, issue, ready, reasons, rank, href: issueLink(projectId, issue.id) };
  });
}
export function searchWork(rows, query, { project = '', status = '' } = {}) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return rows.filter(row => (!project || row.projectId === project) && (!status || row.issue.status === status)
    && words.every(word => [row.projectName, row.issue.id, row.issue.title, row.issue.description, row.issue.design, row.issue.notes, row.issue.acceptance_criteria, ...(row.issue.labels || [])].join('\n').toLocaleLowerCase().includes(word)));
}
export function workSnapshot(rows) {
  return Object.fromEntries(rows.map(({ issue: i, ready }) => [i.id, { title: i.title, status: i.status, priority: i.priority, assignee: i.assignee || '', updated: i.updated_at || '', ready }]));
}
export function activitySince(rows, baseline) {
  const changes = [];
  for (const row of rows) {
    const before = baseline?.[row.projectId]?.issues;
    if (!before) continue; // First visit is a baseline, not thousands of new events.
    const prior = before[row.issue.id];
    const after = workSnapshot([row])[row.issue.id];
    let reason = '';
    if (!prior) reason = 'New issue';
    else if (after.status === 'closed' && prior.status !== 'closed') reason = 'Closed';
    else if (after.ready && !prior.ready) reason = 'Newly ready';
    else if (after.status !== prior.status) reason = `${prior.status} → ${after.status}`;
    else if (JSON.stringify(after) !== JSON.stringify(prior)) reason = 'Updated';
    if (reason) changes.push({ ...row, reasons: [reason] });
  }
  return changes.sort((a, b) => (Date.parse(b.issue.updated_at) || 0) - (Date.parse(a.issue.updated_at) || 0));
}
// Bounded fan-out; one unavailable project never hides the others.
export async function collectWork(projects, fetchIssues, concurrency = 3) {
  const pending = Object.entries(projects); let cursor = 0;
  const results = {};
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (cursor < pending.length) {
      const [id, project] = pending[cursor++];
      try {
        const data = await fetchIssues(id);
        if (!Array.isArray(data.issues) || data.export?.ok === false) throw new Error(data.export?.error || 'Invalid issue response');
        results[id] = { rows: projectWork(id, project, data.issues) };
      } catch (error) { results[id] = { error: error.message }; }
    }
  }));
  return results;
}
