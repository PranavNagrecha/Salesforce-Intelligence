/// <reference types="vitest/globals" />

import { htmlEscape, renderHtmlDocument } from '../src/html-document.js';

// Synthetic, org-free fixture content (P11 Scrub: S-fixtures in HTML) — a title,
// a heading, a table, a mermaid fence, and an inline HTML token to prove escaping.
const TITLE = 'Demo Org — Architecture Overview';
const MARKDOWN = [
  '# Demo Org — Architecture Overview',
  '',
  '## Org Structure',
  '',
  '```mermaid',
  'graph TD',
  '  Widget__c["Widget__c (3 refs)"]',
  '```',
  '',
  '| Surface | Count |',
  '| --- | --- |',
  '| Flow | 2 |',
  '',
  'A literal <b>bold</b> tag and a </pre> token must not break the page.',
].join('\n');

describe('htmlEscape', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(htmlEscape('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('leaves ordinary text untouched', () => {
    expect(htmlEscape('Widget__c has 3 fields')).toBe('Widget__c has 3 fields');
  });
});

describe('renderHtmlDocument', () => {
  const html = renderHtmlDocument(TITLE, MARKDOWN);

  it('emits a well-formed standalone HTML document', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<head>');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    // Exactly one of each structural tag — no duplicate/leaked roots.
    expect(html.match(/<html\b/g)?.length).toBe(1);
    expect(html.match(/<\/html>/g)?.length).toBe(1);
    expect(html.match(/<body\b/g)?.length).toBe(1);
  });

  it('sets the escaped document title', () => {
    expect(html).toContain('<title>Demo Org — Architecture Overview</title>');
  });

  it('embeds the Markdown body escaped inside the fallback <pre>', () => {
    expect(html).toContain('<pre id="sfi-md">');
    // The mermaid fence and table text survive (escaped) so a no-JS reader sees them.
    expect(html).toContain('graph TD');
    expect(html).toContain('| Surface | Count |');
    // Inline HTML in the body is escaped, not live markup.
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('escapes a </pre> in the body so it cannot close the fallback element early', () => {
    // Only the ONE real closing tag of the fallback <pre> is literal; the body's
    // </pre> token is escaped to &lt;/pre&gt;.
    expect(html).toContain('&lt;/pre&gt;');
    expect(html.match(/<\/pre>/g)?.length).toBe(1);
  });

  it('wires client-side marked + mermaid rendering', () => {
    expect(html).toContain('marked');
    expect(html).toContain('mermaid');
    expect(html).toContain('querySelectorAll');
    expect(html).toContain('code.language-mermaid');
  });

  it('is pure — identical input yields identical output', () => {
    expect(renderHtmlDocument(TITLE, MARKDOWN)).toBe(html);
  });
});
