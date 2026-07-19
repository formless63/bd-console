// markdown.js — compact, dependency-free Markdown → HTML renderer.
// Handles headings, fenced code, lists (incl. task lists), tables, blockquotes,
// horizontal rules and inline emphasis/code/links. Output is escaped first, so
// it is safe to inject via dangerouslySetInnerHTML.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) => `<a href="${esc(href)}" target="_blank" rel="noopener">${txt}</a>`);

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      let code = ''; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + '\n'; i++; }
      i++;
      html += `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^\s*([-*_])\1{1,}\s*$/.test(line) || /^---+$/.test(line)) { html += '<hr>'; i++; continue; }
    if (/^>\s?/.test(line)) {
      let q = '';
      while (i < lines.length && /^>\s?/.test(lines[i])) { q += lines[i].replace(/^>\s?/, '') + ' '; i++; }
      html += `<blockquote>${inline(q.trim())}</blockquote>`;
      continue;
    }
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line); i += 2;
      let rows = '';
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) { rows += `<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`; i++; }
      html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      continue;
    }
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
        items += `<li>${txt}</li>`; i++;
      }
      html += ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    let para = line; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])) { para += ' ' + lines[i]; i++; }
    html += `<p>${inline(para)}</p>`;
  }
  return html;
}
