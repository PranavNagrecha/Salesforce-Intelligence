// @ts-check
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";

const SITE = "https://sfi.auditforce.cloud";

const PAGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "src/pages");

/**
 * Resolve a sitemap URL pathname back to the source file that produces it, so
 * `lastmod` can be stamped from the page's real content-change date.
 *   "/"            -> src/pages/index.astro
 *   "/mcp"         -> src/pages/mcp.astro
 *   "/use-cases"   -> src/pages/use-cases/index.astro
 *   "/blog/a-post" -> src/pages/blog/a-post.astro
 */
function sourceFileFor(pathname) {
  const slug = pathname.replace(/^\/+|\/+$/g, "");
  const bases = slug === "" ? ["index"] : [slug, `${slug}/index`];
  for (const base of bases) {
    for (const ext of [".astro", ".mdx", ".md"]) {
      const candidate = path.join(PAGES_DIR, base + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Last content-change date for a page, most trustworthy source first.
 *
 * Deliberately NOT build time. Stamping every URL with `new Date()` on each
 * deploy makes `lastmod` a lie — Google learns to discount the signal, which is
 * strictly worse than omitting it. So: real commit date, else filesystem mtime,
 * else `null` and the field is left off that entry entirely.
 *
 * `git log` is tried first but can legitimately fail on a shallow or
 * export-without-history checkout (some CI providers clone that way), hence the
 * mtime fallback rather than a hard failure.
 */
const lastmodCache = new Map();
function lastmodFor(pathname) {
  if (lastmodCache.has(pathname)) return lastmodCache.get(pathname);
  const file = sourceFileFor(pathname);
  let iso = null;
  if (file) {
    try {
      const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) iso = new Date(out).toISOString();
    } catch {
      /* fall through to mtime */
    }
    if (!iso) {
      try {
        iso = fs.statSync(file).mtime.toISOString();
      } catch {
        /* leave null — omitting beats inventing */
      }
    }
  }
  lastmodCache.set(pathname, iso);
  return iso;
}

// Per-route sitemap priority — home > install/getting-started/mcp > use-cases/
// compare > glossary/faq/licensing. Pattern borrowed from open-design's landing
// page serialize() hook. Non-canonical routes are filtered out.
const PRIORITY = [
  [/\/$/, 1.0, "weekly"],
  [/\/(getting-started|mcp|capabilities)$/, 0.9, "weekly"],
  [/\/(use-cases|compare)\//, 0.8, "weekly"],
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
  integrations: [
    mdx(),
    sitemap({
      // Never list the error page (Astro usually skips it; keep the guard explicit).
      filter: (page) => !page.includes("/404"),
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
