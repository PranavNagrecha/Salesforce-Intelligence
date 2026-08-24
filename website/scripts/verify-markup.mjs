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

for (const file of htmlFiles(DIST)) {
  const html = fs.readFileSync(file, "utf8");
  const rel = path.relative(DIST, file);
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
}

if (errors.length > 0) {
  for (const e of errors) console.error(`verify-markup: FAIL — ${e}`);
  console.error(`verify-markup: ${errors.length} unstyled table(s) found`);
  process.exit(1);
}

console.log("verify-markup: OK — every <table> in dist/ carries `doc-table`");
