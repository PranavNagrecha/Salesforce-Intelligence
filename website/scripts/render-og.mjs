#!/usr/bin/env node
/**
 * render-og.mjs — renders scripts/og-card.html to public/assets/img/og-image.png
 * (1200x630) in headless Chrome.
 *
 *   node scripts/render-og.mjs
 *
 * The old card was an SVG rasterised by macOS Quick Look, which ignored the web
 * fonts: every LinkedIn or Slack share showed an overlapping logo and a clipped
 * headline. Chrome renders the card exactly like the site, with the self-hosted
 * fonts, and the result is checked for size before it is written.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { launch } from "./lib/chrome.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CARD = path.join(ROOT, "scripts/og-card.html");
const OUT = path.join(ROOT, "public/assets/img/og-image.png");

const browser = await launch();
try {
  const page = await browser.newPage({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(CARD).href);
  const check = await page.evaluate(`() => ({
    w: document.documentElement.scrollWidth,
    h: document.documentElement.scrollHeight,
    fonts: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
    clipped: [...document.querySelectorAll("h1, .lede, .chat, .foot")].some((el) => {
      const b = el.getBoundingClientRect();
      return b.right > 1200 || b.bottom > 630;
    }),
  })`);
  if (!check.fonts.some((f) => f.includes("Figtree"))) throw new Error("Figtree did not load; the card would render in a fallback font.");
  if (check.clipped || check.w > 1200) throw new Error(`card content overflows 1200x630 (${check.w}x${check.h})`);
  const tmp = OUT + ".tmp";
  await page.screenshot(tmp);
  const png = fs.readFileSync(tmp);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 1200 || height !== 630) throw new Error(`expected 1200x630, got ${width}x${height}`);
  fs.renameSync(tmp, OUT);
  console.log(`render-og: wrote ${path.relative(ROOT, OUT)} (${width}x${height}, ${(png.length / 1024).toFixed(0)} KB)`);
} finally {
  await browser.close();
}
