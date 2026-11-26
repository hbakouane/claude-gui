import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = page.match(/<script>([\s\S]*)<\/script>/)[1];
const slice = (from, to) => script.slice(script.indexOf(from), script.indexOf(to));
const { markdown, linkify } = new Function(`${slice('  const esc =', '  const tilde =')}${slice('  function inline(text)', '  /* ---------- Session page')}return { markdown, linkify };`)();

describe('markdown', () => {
  it('renders headings, emphasis, code, links, tables, lists, quotes and rules', () => {
    const html = markdown([
      '### Plan',
      'Some **bold**, *italic* and `code <b>` text. See [PR](https://github.com/a/b/pull/1) or https://x.dev/y.',
      '',
      '| Col A | Col B |',
      '|---|---|',
      '| `x` | **y** |',
      '',
      '1. First',
      '2. Second',
      '   continued',
      '',
      '> quoted',
      '---',
    ].join('\n'));

    assert.ok(html.includes('<h4>Plan</h4>'));
    assert.ok(html.includes('<strong>bold</strong>') && html.includes('<em>italic</em>'));
    assert.ok(html.includes('<code>code &lt;b&gt;</code>'));
    assert.ok(html.includes('<a href="https://github.com/a/b/pull/1" target="_blank" rel="noopener noreferrer">PR</a>'));
    assert.ok(html.includes('<a href="https://x.dev/y" target="_blank" rel="noopener noreferrer">https://x.dev/y</a>.'));
    assert.ok(html.includes('<th>Col A</th>') && html.includes('<td><code>x</code></td><td><strong>y</strong></td>'));
    assert.ok(html.includes('<ol><li>First</li><li>Second<br>continued</li></ol>'));
    assert.ok(html.includes('<blockquote>quoted</blockquote><hr>'));
  });

  it('escapes HTML everywhere, including code blocks', () => {
    const html = markdown('- bullet <script>alert(1)</script>\n\n```php\nif ($a < $b) { echo "<x>"; }\n```');

    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('<pre><code>if ($a &lt; $b) { echo &quot;&lt;x&gt;&quot;; }</code></pre>'));
  });

  it('only links http and https URLs', () => {
    assert.ok(!markdown('[bad](javascript:alert(1))').includes('href'));
    assert.equal(linkify('see https://a.b/c <i>'), 'see <a href="https://a.b/c" target="_blank" rel="noopener noreferrer">https://a.b/c</a> &lt;i&gt;');
  });

  it('survives an unclosed code fence', () => {
    assert.equal(markdown('```\nstill typing'), '<pre><code>still typing</code></pre>');
  });
});
