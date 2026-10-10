#!/usr/bin/env node
/**
 * verify-markup.mjs — markup-convention gate over the BUILT site (dist/).
 *
 * Every table style in `src/styles/style.css` is scoped to `.doc-table`; there
 * is no bare `table` rule anywhere in the stylesheet. So a `<table>` written
 * without that class does not render "slightly off" — it renders with browser
 * defaults: no border-collapse, no row rules, no mono/uppercase header, and no
 * `overflow-x: auto`, which is what actually breaks the page (a wide table
 * pushes the whole article sideways on a narrow viewport instead of scrolling
 * inside its own box).
 *
 * That is not a hypothetical. Five tables across three blog posts shipped bare
 * — including the 0.3.1 release article, where the reader sees an unstyled
 * table directly above a correctly styled one on the next page. The convention
 * was documented only by every other author having followed it, which is the
 * same as not being documented at all.
 *
 * Checks dist/ rather than src/ on purpose: it is the bytes the reader gets,
 * so a table introduced by any route — .astro, MDX, or a component — is caught.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");

if (!fs.existsSync(DIST)) {
  console.error("verify-markup: dist/ missing — run `npm run build` first");
  process.exit(2);
}

/** Every .html file under dist/, recursively. */
const htmlFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.isFile() && entry.name.endsWith(".html") ? [full] : [];
  });

const errors = [];

/** Decode the entities Astro emits in <title>, so "&amp;" counts as one character. */
const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

// Search results cut a title at roughly 600px, about 60 characters. 23 of 37
// titles were over that, several of them spending the visible part on a
// repeated "| sf-intelligence" suffix. Pages that are not indexed (404) and
// files with no <title> (search-console verification stubs) are skipped.
const TITLE_MAX = 60;
const indexable = (html) => !/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(html);

for (const file of htmlFiles(DIST)) {
  const html = fs.readFileSync(file, "utf8");
  const rel = path.relative(DIST, file);
  const rawTitle = /<title>([^<]*)<\/title>/i.exec(html)?.[1];
  if (rawTitle !== undefined && indexable(html)) {
    const title = decode(rawTitle).trim();
    if (title.length > TITLE_MAX) {
      errors.push(`${rel}: <title> is ${title.length} characters (max ${TITLE_MAX}): "${title}"`);
    }
  }
  // Match each opening <table ...> tag and read its class attribute, if any.
  for (const match of html.matchAll(/<table\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const cls = /class\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    if (!cls.split(/\s+/).includes("doc-table")) {
      errors.push(
        `${rel}: <table${attrs}> has no \`doc-table\` class — it will render unstyled ` +
          `and overflow its container instead of scrolling inside it`,
      );
    }
  }
  // An empty header cell (a Markdown `| |` corner) leaves that column's data
  // cells with no header: screen readers lose the column name and Lighthouse
  // fails td-has-header. Give the corner a label ("Measure", "Server", ...).
  const emptyTh = (html.match(/<th\b[^>]*>\s*<\/th>/gi) || []).length;
  if (emptyTh) errors.push(`${rel}: ${emptyTh} empty <th> header cell(s); label the column`);
}

// ---- llms.txt lists every indexable page (it is generated at build by
// integrations/geo.mjs; this catches the generator being skipped or broken).
const llmsPath = path.join(DIST, "llms.txt");
if (!fs.existsSync(llmsPath)) {
  errors.push("llms.txt missing from dist/ (integrations/geo.mjs did not run)");
} else {
  const llms = fs.readFileSync(llmsPath, "utf8");
  for (const file of htmlFiles(DIST)) {
    const html = fs.readFileSync(file, "utf8");
    const canonical = /<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i.exec(html)?.[1];
    if (!canonical || !indexable(html)) continue;
    if (!llms.includes(`](${canonical})`)) {
      errors.push(`${path.relative(DIST, file)}: not listed in llms.txt (${canonical})`);
    }
  }
  if (/\{\{\w+\}\}/.test(llms)) errors.push("llms.txt has an unfilled {{token}}");
}

if (errors.length > 0) {
  for (const e of errors) console.error(`verify-markup: FAIL — ${e}`);
  console.error(`verify-markup: ${errors.length} problem(s) found`);
  process.exit(1);
}

console.log(
  `verify-markup: OK — every <table> carries \`doc-table\`, every title is ≤ ${TITLE_MAX} characters, no header cell is empty, and llms.txt lists every indexable page`,
);
