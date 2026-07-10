#!/usr/bin/env node
/**
 * verify-seo-indexing.mjs — local gate for website indexability (Astro dist/).
 * Run after `npm run build`. Checks robots ↔ Astro sitemap, per-URL SEO tags,
 * and that 404.html is noindex without a canonical.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");
const BASE = "https://sfi.auditforce.cloud";

const errors = [];
const warnings = [];

if (!fs.existsSync(DIST)) {
  console.error("dist/ missing — run `npm run build` first");
  process.exit(2);
}

const ROBOTS = fs.readFileSync(path.join(DIST, "robots.txt"), "utf8");
const INDEX_XML = fs.readFileSync(path.join(DIST, "sitemap-index.xml"), "utf8");
const childLoc = INDEX_XML.match(/<loc>([^<]+)<\/loc>/)?.[1];
if (!childLoc) {
  errors.push("sitemap-index.xml has no child <loc>");
}
const childName = childLoc ? path.basename(new URL(childLoc).pathname) : "sitemap-0.xml";
const SITEMAP = fs.readFileSync(path.join(DIST, childName), "utf8");

function locToFile(loc) {
  const u = new URL(loc);
  if (u.pathname === "/" || u.pathname === "") return path.join(DIST, "index.html");
  const rel = u.pathname.replace(/^\//, "").replace(/\/$/, "");
  const asHtml = path.join(DIST, `${rel}.html`);
  if (fs.existsSync(asHtml)) return asHtml;
  const asIndex = path.join(DIST, rel, "index.html");
  if (fs.existsSync(asIndex)) return asIndex;
  return asHtml;
}

// 1. robots.txt points at Astro sitemap index
if (!ROBOTS.includes(`Sitemap: ${BASE}/sitemap-index.xml`)) {
  errors.push("robots.txt must declare Sitemap: …/sitemap-index.xml");
}
if (/Sitemap:.*\/sitemap\.xml\s*$/m.test(ROBOTS)) {
  errors.push("robots.txt still points at legacy /sitemap.xml");
}
if (/Disallow:\s*\//.test(ROBOTS)) {
  errors.push("robots.txt blocks root");
}

// 2. Legacy hand sitemap must not ship in dist
if (fs.existsSync(path.join(DIST, "sitemap.xml"))) {
  errors.push("dist/sitemap.xml present — remove hand-written sitemap; use Astro sitemap-index only");
}

// 3. Parse sitemap URLs
const locs = [...SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (locs.length === 0) errors.push(`${childName} has no URLs`);

const seen = new Set();
for (const loc of locs) {
  if (seen.has(loc)) errors.push(`duplicate sitemap loc: ${loc}`);
  seen.add(loc);
  if (!loc.startsWith(BASE)) errors.push(`sitemap loc not on BASE: ${loc}`);
  if (/404/.test(loc)) errors.push(`404 listed in sitemap: ${loc}`);
  const u = new URL(loc);
  if (u.pathname !== "/" && u.pathname.endsWith(".html")) {
    errors.push(`sitemap loc should use extensionless canonical URL: ${loc}`);
  }
  const file = locToFile(loc);
  if (!fs.existsSync(file)) errors.push(`sitemap loc missing file: ${loc} → ${path.relative(DIST, file)}`);
}

// 4. Per-page SEO tags (indexable URLs only)
for (const loc of locs) {
  const file = locToFile(loc);
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, "utf8");
  const rel = path.relative(DIST, file);
  const wantCanon = loc.replace(/\/$/, "") === BASE ? `${BASE}/` : loc.replace(/\/$/, "");
  const altCanon = wantCanon === `${BASE}/` ? BASE : `${wantCanon}/`;

  if (!html.includes(`rel="canonical" href="${wantCanon}"`) && !html.includes(`rel="canonical" href="${altCanon}"`)) {
    errors.push(`${rel}: canonical mismatch (expected ${wantCanon})`);
  }
  if (!html.match(/meta name="robots" content="index, follow/)) {
    errors.push(`${rel}: missing index,follow robots meta`);
  }
  if (html.includes('content="noindex')) {
    errors.push(`${rel}: noindex on sitemap URL`);
  }
  const title = html.match(/<title>([^<]+)<\/title>/);
  if (!title) errors.push(`${rel}: missing <title>`);
  const desc = html.match(/<meta name="description" content="([^"]+)"/);
  if (!desc) errors.push(`${rel}: missing meta description`);
  else if (desc[1].length > 170) errors.push(`${rel}: meta description too long (${desc[1].length} chars)`);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (!h1) errors.push(`${rel}: missing <h1>`);
  if (!html.includes('lang="en"')) warnings.push(`${rel}: missing lang=en`);
  if (!html.includes("application/ld+json")) warnings.push(`${rel}: no JSON-LD`);
}

// 5. 404 must be noindex and must not self-canonicalize
const notFound = path.join(DIST, "404.html");
if (!fs.existsSync(notFound)) {
  errors.push("dist/404.html missing");
} else {
  const html = fs.readFileSync(notFound, "utf8");
  if (!/name="robots" content="noindex/i.test(html)) {
    errors.push("404.html must have robots noindex");
  }
  if (/rel="canonical"/i.test(html)) {
    errors.push("404.html must not emit a canonical link");
  }
  if (/content="index,\s*follow/i.test(html)) {
    errors.push("404.html must not be index,follow");
  }
}

// 6. _redirects sends legacy sitemap to Astro index
const redirects = path.join(DIST, "_redirects");
if (!fs.existsSync(redirects)) {
  errors.push("dist/_redirects missing (need /sitemap.xml → /sitemap-index.xml)");
} else {
  const body = fs.readFileSync(redirects, "utf8");
  if (!/\/sitemap\.xml\s+\/sitemap-index\.xml\s+301/.test(body)) {
    errors.push("_redirects must 301 /sitemap.xml → /sitemap-index.xml");
  }
}

console.log(`verify-seo-indexing: ${locs.length} sitemap URLs checked (${childName})`);
if (warnings.length) {
  console.log(`\nWARNINGS (${warnings.length}):`);
  warnings.forEach((w) => console.log("  ⚠", w));
}
if (errors.length) {
  console.log(`\nERRORS (${errors.length}):`);
  errors.forEach((e) => console.log("  ✗", e));
  process.exit(1);
}
console.log("\n✓ All indexability checks passed");
