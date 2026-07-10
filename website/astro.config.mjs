// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";

const SITE = "https://sfi.auditforce.cloud";

// Per-route sitemap priority — home > install/getting-started/mcp > use-cases/
// compare > glossary/faq/licensing. Pattern borrowed from open-design's landing
// page serialize() hook. Non-canonical routes are filtered out.
const PRIORITY = [
  [/\/$/, 1.0, "weekly"],
  [/\/(getting-started|mcp|capabilities)$/, 0.9, "weekly"],
  [/\/(use-cases|compare)\//, 0.8, "weekly"],
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
        for (const [re, priority, changefreq] of PRIORITY) {
          if (re.test(new URL(item.url).pathname)) {
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
