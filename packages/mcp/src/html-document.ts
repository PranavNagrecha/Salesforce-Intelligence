/**
 * Self-contained HTML export for generated Markdown documents
 * (P11-artifacts-html).
 *
 * `renderHtmlDocument` wraps a document's title + Markdown body into ONE valid,
 * standalone HTML page that renders the Markdown — and its fenced `mermaid`
 * diagrams — client-side via `marked` + `mermaid` loaded from a CDN. The raw
 * Markdown is embedded in a visible `<pre>` that the inline script replaces once
 * rendered, so with no network (or JS disabled) the page still shows the full
 * document as readable Markdown rather than a blank screen.
 *
 * Pure and deterministic: the same `(title, markdownBody)` always yields the
 * same string — no clock, no disk, no randomness — so it is trivially testable
 * and safe to cache. The output never embeds anything but the caller's own text
 * (escaped) plus two fixed CDN module URLs, so it carries no org data of its own.
 */

/** marked / mermaid ESM builds, pinned to a major so the page renders predictably. */
const MARKED_CDN = 'https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js';
const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

/**
 * Escape the HTML-significant characters for text / RCDATA contexts. Used for
 * both the `<title>` and the Markdown body that sits inside the fallback
 * `<pre>` — escaping `<` means a Markdown body that itself contains `</pre>`,
 * `<script>`, etc. cannot break out of the element.
 *
 * @example htmlEscape('<a href="x">') === '&lt;a href=&quot;x&quot;&gt;'
 */
export const htmlEscape = (raw: string): string =>
  raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Render `markdownBody` into a single self-contained HTML page titled `title`.
 * The page renders the Markdown and its `mermaid` code fences in a browser, and
 * degrades to the readable raw Markdown when scripts are unavailable.
 *
 * @example
 *   const html = renderHtmlDocument('Acme — Architecture', '# Acme\n...');
 *   await writeFile('architecture.html', html);
 */
export const renderHtmlDocument = (title: string, markdownBody: string): string => {
  const safeTitle = htmlEscape(title);
  const safeBody = htmlEscape(markdownBody);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="sf-intelligence">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.55; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #8888; padding: 0.3rem 0.6rem; text-align: left; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre#sfi-md { white-space: pre-wrap; word-wrap: break-word; }
  .mermaid { background: transparent; }
</style>
</head>
<body>
<main id="sfi-content"><pre id="sfi-md">${safeBody}</pre></main>
<script type="module">
  const markdown = document.getElementById('sfi-md').textContent;
  try {
    const [marked, mermaidMod] = await Promise.all([
      import(${JSON.stringify(MARKED_CDN)}),
      import(${JSON.stringify(MERMAID_CDN)}),
    ]);
    const mermaid = mermaidMod.default;
    const content = document.getElementById('sfi-content');
    content.innerHTML = marked.marked.parse(markdown);
    // marked renders \`\`\`mermaid fences as <pre><code class="language-mermaid">.
    // Convert each into a <pre class="mermaid"> block that mermaid can render.
    for (const code of content.querySelectorAll('code.language-mermaid')) {
      const holder = document.createElement('pre');
      holder.className = 'mermaid';
      holder.textContent = code.textContent;
      code.closest('pre').replaceWith(holder);
    }
    mermaid.initialize({ startOnLoad: false });
    await mermaid.run({ querySelector: '.mermaid' });
  } catch (e) {
    // Offline / CDN blocked / render error: leave the raw Markdown <pre> visible.
    console.error('sf-intelligence: HTML render fell back to raw Markdown', e);
  }
</script>
</body>
</html>
`;
};
