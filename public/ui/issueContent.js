// Shared, DOM-free shapes for issue editing and explicit review evidence.
export const CONTENT_FIELDS = {
  title: 'Title', description: 'Description', design: 'Design',
  notes: 'Notes', acceptance_criteria: 'Acceptance criteria',
};
export const REVIEW_FIELDS = {
  branch: 'Branch or worktree', commit: 'Commit', url: 'Pull request or evidence URL',
  tests: 'Validation performed and results', reviewer: 'Reviewer', summary: 'Review notes',
};
export const REVIEW_DECISIONS = { pending: 'Needs review', changes_requested: 'Changes requested', approved: 'Approved' };
export function contentOf(issue) {
  return Object.fromEntries(Object.keys(CONTENT_FIELDS).map(k => [k, String(issue?.[k] ?? '')]));
}
export function reviewOf(issue) {
  let metadata = issue?.metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = null; } }
  // bd --set-metadata stores values as strings; decode this namespaced key
  // without replacing unrelated metadata. Also accept native object exports.
  let value = metadata?.bd_console_review;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
export function reviewDraft(issue) {
  const review = reviewOf(issue);
  return { ...Object.fromEntries(Object.keys(REVIEW_FIELDS).map(k => [k, String(review?.[k] ?? '')])),
    decision: Object.hasOwn(REVIEW_DECISIONS, review?.decision) ? review.decision : 'pending' };
}
export function safeEvidenceUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
