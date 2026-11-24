import { describe, it, expect } from 'vitest';
import { highlightShell } from '../src/lib/highlight.js';

describe('the shell highlighter of chat steps', () => {
  it('marks commands, flags, strings, operators and comments', () => {
    const h = highlightShell('git log --oneline -5 | grep "fix" && wc -l x # count');
    expect(h).toContain('<span class="hl-cmd">git</span>');
    expect(h).toContain('<span class="hl-flag">--oneline</span>');
    expect(h).toContain('<span class="hl-op">|</span> <span class="hl-cmd">grep</span>');
    expect(h).toContain('<span class="hl-str">"fix"</span>');
    expect(h).toContain('<span class="hl-cmd">wc</span>');
    expect(h).toContain('<span class="hl-com"># count</span>');
  });
  it('escapes everything the agent wrote', () => {
    const h = highlightShell('echo "<img src=x onerror=alert(1)>" > /tmp/<b>');
    expect(h).not.toMatch(/<img|<b>/);
    expect(h).toContain('&lt;img');
    expect(h.replace(/<\/?span[^>]*>/g, '')).toBe('echo "&lt;img src=x onerror=alert(1)&gt;" &gt; /tmp/&lt;b&gt;');
  });
  it('keeps the text the same, apart from the markup', () => {
    const src = 'ls docs/agents/ && wc -l a b\ncat x';
    const plain = highlightShell(src).replace(/<\/?span[^>]*>/g, '').replace(/&amp;/g, '&');
    expect(plain).toBe(src);
  });
});
