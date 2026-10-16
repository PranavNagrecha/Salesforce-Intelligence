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
 * <lastmod> per route. Precedence:
 *
 *   1. The date the page itself declares: `dateModified` in a guide's
 *      frontmatter, or the `const dateModified = "YYYY-MM-DD"` /
 *      `dateModified="YYYY-MM-DD"` literal in a hand-written page. An author
 *      bumps it when the content changes, so it is per page by construction.
 *   2. src/data/lastmod.json, the last git commit that touched the file,
 *      written by recalibrate.mjs from the full-history local repo. The build
 *      never runs `git log` itself: Cloudflare Pages clones shallow, so
 *      `git log -- <file>` returned HEAD for every file and every sitemap
 *      entry read the same deploy timestamp. File mtime is no better there
 *      (checkout time).
 *   3. Nothing. Omitting beats stamping the deploy date on everything.
 */
/** @type {Record<string, string>} */
let LASTMOD = {};
try {
  LASTMOD = JSON.parse(fs.readFileSync(path.join(SITE_DIR, "src/data/lastmod.json"), "utf8"));
} catch {
  /* no file: no lastmod anywhere */
}

/** Routes whose source declares a dateModified, as "YYYY-MM-DD". */
const DECLARED = (() => {
  /** @type {Record<string, string>} */
  const out = {};
  const DATE = /dateModified\s*[=:]\s*"?(\d{4}-\d{2}-\d{2})"?/g;
  const declaredIn = (file) => {
    const dates = [...fs.readFileSync(file, "utf8").matchAll(DATE)].map((m) => m[1]);
    return dates.length ? dates.sort().at(-1) : null;
  };
  const pagesDir = path.join(SITE_DIR, "src/pages");
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(astro|md|mdx)$/.test(e.name) || e.name.startsWith("_") || e.name.includes("[")) continue;
      const rel = path.relative(pagesDir, full).replace(/\\/g, "/").replace(/\.(astro|md|mdx)$/, "");
      if (rel === "404") continue;
      const route = ("/" + rel.replace(/(^|\/)index$/, "")).replace(/\/$/, "") || "/";
      const d = declaredIn(full);
      if (d) out[route] = d;
    }
  };
  if (fs.existsSync(pagesDir)) walk(pagesDir);
  // Markdown guides render at /<section>/<name> through a [slug] route.
  const guidesDir = path.join(SITE_DIR, "src/content/guides");
  if (fs.existsSync(guidesDir)) {
    for (const section of fs.readdirSync(guidesDir, { withFileTypes: true })) {
      if (!section.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(guidesDir, section.name))) {
        if (!/\.mdx?$/.test(f)) continue;
        const d = declaredIn(path.join(guidesDir, section.name, f));
        if (d) out[`/${section.name}/${f.replace(/\.mdx?$/, "")}`] = d;
      }
    }
  }
  return out;
})();

const lastmodFor = (pathname) => {
  const route = pathname.replace(/\/+$/, "") || "/";
  return DECLARED[route] ?? LASTMOD[route] ?? null;
};

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
