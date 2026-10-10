// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";
import { unified } from "@astrojs/markdown-remark";

import rehypeGuides from "./src/lib/rehype-guides.mjs";

import geo from "./integrations/geo.mjs";

const SITE = "https://sfi.auditforce.cloud";
const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Last content-change date per route, from src/data/lastmod.json.
 *
 * That file is written by recalibrate.mjs from the full-history local repo.
 * The build never runs `git log` itself: Cloudflare Pages clones shallow, so
 * `git log -- <file>` returned HEAD for every file and every sitemap entry
 * read the same deploy timestamp. File mtime is no better there (checkout
 * time). A route missing from lastmod.json simply gets no <lastmod>:
 * omitting beats stamping the deploy date on everything.
 */
/** @type {Record<string, string>} */
let LASTMOD = {};
try {
  LASTMOD = JSON.parse(fs.readFileSync(path.join(SITE_DIR, "src/data/lastmod.json"), "utf8"));
} catch {
  /* no file: no lastmod anywhere */
}
const lastmodFor = (pathname) => LASTMOD[pathname.replace(/\/+$/, "") || "/"] ?? null;

// Per-route sitemap priority — home > install/getting-started/mcp > use-cases/
// compare > glossary/faq/licensing. Pattern borrowed from open-design's landing
// page serialize() hook. Non-canonical routes are filtered out.
const PRIORITY = [
  [/\/$/, 1.0, "weekly"],
  [/\/(getting-started|demo|mcp|capabilities)$/, 0.9, "weekly"],
  [/\/(use-cases|compare|how-to|errors|setup)\//, 0.8, "weekly"],
  [/\/(how-to|errors)$/, 0.8, "weekly"],
  [/\/blog(\/[^/]+)?$/, 0.8, "weekly"],
  [/\/(tools|trust|configuration)$/, 0.7, "monthly"],
];

export default defineConfig({
  site: SITE,
  trailingSlash: "never",
  build: {
    // Inline the single small stylesheet into <head> — removes a render-blocking
    // request; a clean Core Web Vitals win for a site this lean.
    inlineStylesheets: "always",
    format: "file", // emit /page.html so Cloudflare serves /page cleanly
  },
  markdown: {
    // Code blocks use the site's own calm code style (light + dark tokens),
    // not a fixed Shiki theme. rehypeGuides adds doc-table and the framed
    // .code-block markup — see src/lib/rehype-guides.mjs.
    syntaxHighlight: false,
    processor: unified({ rehypePlugins: [rehypeGuides] }),
  },
  integrations: [
    mdx(),
    geo({ siteDir: SITE_DIR }),
    sitemap({
      // Never list the error page (Astro usually skips it; keep the guard explicit).
      filter: (page) => !page.includes("/404") && !/\.(json|txt|xml)$/.test(page),
      serialize(item) {
        const pathname = new URL(item.url).pathname;
        // lastmod is the ONE sitemap signal Google has said it actually uses for
        // recrawl scheduling; changefreq and priority below are documented as
        // ignored. Set it first so every entry carries it regardless of which
        // priority bucket matches.
        const lastmod = lastmodFor(pathname);
        if (lastmod) item.lastmod = lastmod;
        for (const [re, priority, changefreq] of PRIORITY) {
          if (re.test(pathname)) {
            item.priority = priority;
            item.changefreq = /** @type {any} */ (changefreq);
            return item;
          }
        }
        item.priority = 0.5;
        item.changefreq = "monthly";
        return item;
      },
    }),
  ],
});
