((root) => {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function formatText(text) {
    return escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  function formatInline(text) {
    const tokens = /`([^`]+)`|!\[([^\]\n]*)\]\(\s*(<[^<>\n]+>|[^\s)]+)(?:\s+"([^"\n]*)")?\s*\)/g;
    let html = '';
    let offset = 0;
    for (const match of text.matchAll(tokens)) {
      html += formatText(text.slice(offset, match.index));
      if (match[1] !== undefined) {
        html += `<code>${escapeHtml(match[1])}</code>`;
      } else {
        const source = match[3].startsWith('<') ? match[3].slice(1, -1) : match[3];
        let allowed = false;
        try {
          const url = new URL(source, 'https://webcoder.invalid');
          allowed = url.protocol === 'https:' || url.protocol === 'http:';
        } catch {}
        html += allowed
          ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(match[2])}"${match[4] ? ` title="${escapeHtml(match[4])}"` : ''} loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
          : escapeHtml(match[0]);
      }
      offset = match.index + match[0].length;
    }
    return html + formatText(text.slice(offset));
  }

  function renderMarkdown(md) {
    let html = '';
    let inCodeBlock = false;
    let codeBlockLines = [];
    let inList = false;
    const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
    for (const line of String(md || '').split(/\r?\n/)) {
      if (line.trim().startsWith('```')) {
        closeList();
        if (!inCodeBlock) { inCodeBlock = true; codeBlockLines = []; }
        else { html += `<pre><code>${escapeHtml(codeBlockLines.join('\n'))}</code></pre>`; inCodeBlock = false; }
        continue;
      }
      if (inCodeBlock) { codeBlockLines.push(line); continue; }
      const trimmed = line.trim();
      if (!trimmed) { closeList(); continue; }
      if (/^---+$/.test(trimmed)) { closeList(); html += '<hr />'; continue; }
      const heading = /^(#{1,3}) (.*)$/.exec(trimmed);
      if (heading) {
        closeList();
        const level = heading[1].length;
        html += `<h${level}>${formatInline(heading[2])}</h${level}>`;
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${formatInline(trimmed.slice(2))}</li>`;
      } else {
        closeList();
        html += `<p>${formatInline(trimmed)}</p>`;
      }
    }
    closeList();
    if (inCodeBlock) html += `<pre><code>${escapeHtml(codeBlockLines.join('\n'))}</code></pre>`;
    return html || '<p style="color: var(--text-muted);">No problem prompt written yet.</p>';
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { renderMarkdown };
  else root.WebCoderMarkdown = { renderMarkdown };
})(typeof window === 'undefined' ? globalThis : window);
