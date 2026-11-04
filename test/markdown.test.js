const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown } = require('../public/markdown');
const { decodeImage, MAX_IMAGE_BYTES } = require('../src/images');

test('question descriptions render local and external Markdown images', () => {
  const html = renderMarkdown('# Diagram\n![Tree](/api/rooms/example/images/123.png)\nSee ![Graph](https://example.com/graph.png "Example graph") below.');
  assert.match(html, /<h1>Diagram<\/h1>/);
  assert.match(html, /<img src="\/api\/rooms\/example\/images\/123.png" alt="Tree"/);
  assert.match(html, /src="https:\/\/example.com\/graph.png" alt="Graph" title="Example graph"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
});

test('image URLs containing spaces or parentheses work in angle brackets', () => {
  assert.match(renderMarkdown('![Diagram](<https://example.com/my diagram(1).png>)'), /<img src="https:\/\/example.com\/my diagram\(1\).png"/);
});

test('image Markdown inside inline code and fenced code remains literal', () => {
  const html = renderMarkdown('`![Example](https://example.com/a.png)`\n```\n![Example](https://example.com/a.png)\n```');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<code>!\[Example\]/);
});

test('Markdown images escape attributes, raw HTML, and formatting inside alt text', () => {
  const html = renderMarkdown('![**a** " onerror="bad <tag>](https://example.com/a.png)\n<script>alert(1)</script>');
  assert.match(html, /alt="\*\*a\*\* &quot; onerror=&quot;bad &lt;tag&gt;"/);
  assert.doesNotMatch(html, /<script>|<tag>|<strong>|" onerror="/);
});

test('executable and embedded image URL schemes are rejected', () => {
  for (const source of ['javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'file:///etc/passwd', 'blob:https://example.com/123']) {
    assert.doesNotMatch(renderMarkdown(`![Image](${source})`), /<img/);
  }
});

test('existing headings, lists, emphasis, code, and separators still render', () => {
  const html = renderMarkdown('# Question\n## Example\n- **bold** and *italic*\n- `value`\n---\n```\n<code>\n```');
  assert.match(html, /<h1>Question<\/h1><h2>Example<\/h2><ul><li><strong>bold<\/strong> and <em>italic<\/em><\/li><li><code>value<\/code><\/li><\/ul><hr \/>/);
  assert.match(html, /<pre><code>&lt;code&gt;<\/code><\/pre>/);
});

test('image uploads validate actual file signatures and size', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4VQAAAAASUVORK5CYII=', 'base64');
  assert.equal(decodeImage(png.toString('base64')).extension, 'png');
  assert.equal(decodeImage(Buffer.from([255, 216, 255, 224]).toString('base64')).extension, 'jpg');
  assert.equal(decodeImage(Buffer.from('GIF89a1234567').toString('base64')).extension, 'gif');
  assert.equal(decodeImage(Buffer.from('RIFF0000WEBP0000').toString('base64')).extension, 'webp');
  assert.throws(() => decodeImage(Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')), /PNG, JPEG, GIF, or WebP/);
  assert.throws(() => decodeImage('not base64'), /Invalid image data/);
  assert.throws(() => decodeImage(Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')), /5 MB/);
});
