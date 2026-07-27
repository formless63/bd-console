// Pure document-navigation helpers. Docs2 uses these to keep hundreds of
// markdown files compact; smoke.mjs imports them without a browser runtime.

export function docGroup(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : 'Project root';
}

export function groupDocs(docs, query = '') {
  const q = String(query).trim().toLowerCase();
  const groups = new Map();
  for (const doc of docs || []) {
    if (q && !String(doc.path).toLowerCase().includes(q)) continue;
    const group = docGroup(doc.path);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(doc);
  }
  for (const list of groups.values()) list.sort((a, b) => a.path.localeCompare(b.path));
  return [...groups.entries()]
    .sort(([a], [b]) => (a === 'Project root' ? -1 : b === 'Project root' ? 1 : a.localeCompare(b)))
    .map(([name, items]) => ({ name, items }));
}

const START_NAMES = new Map([
  ['readme.md', 0], ['docs/readme.md', 1], ['docs/index.md', 2],
  ['agents.md', 3], ['claude.md', 4], ['contributing.md', 5],
]);

export function starterDocs(docs, limit = 6) {
  const ranked = (docs || []).map((doc) => {
    const path = String(doc.path).toLowerCase();
    const exact = START_NAMES.has(path) ? START_NAMES.get(path) : 100;
    const base = path.split('/').pop();
    const basenameRank = base === 'readme.md' ? 10 : base === 'index.md' ? 20 : 100;
    return { doc, rank: Math.min(exact, basenameRank) };
  }).sort((a, b) => a.rank - b.rank || a.doc.path.length - b.doc.path.length || a.doc.path.localeCompare(b.doc.path));
  return ranked.slice(0, limit).map((x) => x.doc);
}

