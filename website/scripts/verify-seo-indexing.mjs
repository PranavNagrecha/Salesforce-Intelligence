#!/usr/bin/env node
/**
 * verify-seo-indexing.mjs — local gate for website indexability.
 * Checks sitemap ↔ files, canonical/robots/title/h1 on every indexable URL.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = "https://salesforce-intelligence.pages.dev";
const ROBOTS = fs.readFileSync(path.join(SITE, "robots.txt"), "utf8");
const SITEMAP = fs.readFileSync(path.join(SITE, "sitemap.xml"), "utf8");

const errors = [];
const warnings = [];

function locToFile(loc) {
  const u = new URL(loc);
  if (u.pathname === "/") return path.join(SITE, "index.html");
  const rel = u.pathname.replace(/^\//, "");
  const direct = path.join(SITE, rel);
  if (fs.existsSync(direct)) return direct;
  return path.join(SITE, `${rel}.html`);
}

// 1. robots.txt points at sitemap
if (!ROBOTS.includes(`Sitemap: ${BASE}/sitemap.xml`)) {
  errors.push("robots.txt missing Sitemap directive");
}
if (/Disallow:\s*\//.test(ROBOTS)) {
  errors.push("robots.txt blocks root");
}

// 2. Parse sitemap URLs
const locs = [...SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (locs.length === 0) errors.push("sitemap.xml has no URLs");

const seen = new Set();
for (const loc of locs) {
  if (seen.has(loc)) errors.push(`duplicate sitemap loc: ${loc}`);
  seen.add(loc);
  if (!loc.startsWith(BASE)) errors.push(`sitemap loc not on BASE: ${loc}`);
  const u = new URL(loc);
  if (u.pathname !== "/" && u.pathname.endsWith(".html")) {
    errors.push(`sitemap loc should use extensionless canonical URL: ${loc}`);
  }
  const file = locToFile(loc);
  if (!fs.existsSync(file)) errors.push(`sitemap loc missing file: ${loc} → ${path.relative(SITE, file)}`);
}

// 3. Per-page SEO tags
for (const loc of locs) {
  const file = locToFile(loc);
  const html = fs.readFileSync(file, "utf8");
  const rel = path.relative(SITE, file);

  if (!html.includes(`rel="canonical" href="${loc}"`)) {
    errors.push(`${rel}: canonical mismatch (expected ${loc})`);
  }
  if (!html.match(/meta name="robots" content="index, follow/)) {
    errors.push(`${rel}: missing index,follow robots meta`);
  }
  if (html.includes('content="noindex')) {
    errors.push(`${rel}: noindex on sitemap URL`);
  }
  const title = html.match(/<title>([^<]+)<\/title>/);
  if (!title) errors.push(`${rel}: missing <title>`);
  else if (!/Salesforce|sf-intelligence|MCP|install|Configuration|FAQ|Glossary|impact|sharing|trust|capabilities|tools/i.test(title[1])) {
    warnings.push(`${rel}: title may lack primary keyword: ${title[1]}`);
  }
  const desc = html.match(/<meta name="description" content="([^"]+)"/);
  if (!desc) {
    errors.push(`${rel}: missing meta description`);
  } else if (desc[1].length > 160) {
    errors.push(`${rel}: meta description too long (${desc[1].length} chars)`);
  }
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (!h1) errors.push(`${rel}: missing <h1>`);
  if (!html.includes('lang="en"')) warnings.push(`${rel}: missing lang=en`);
  if (html.match(/\u2014|\u2013/)) errors.push(`${rel}: contains em/en dash (indexing copy rule)`);
  if (!html.includes("application/ld+json")) warnings.push(`${rel}: no JSON-LD`);
}

// 4. Homepage internal links to new pages
const index = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
for (const href of ["/mcp", "/use-cases/impact-analysis", "/use-cases/salesforce-metadata-analysis", "/use-cases/salesforce-dependency-analysis", "/use-cases/sharing-troubleshooting", "/use-cases/claude-salesforce-mcp", "/compare/salesforce-dx-mcp", "/glossary"]) {
  if (!index.includes(`href="${href}"`)) errors.push(`index.html missing link to ${href}`);
}

// 5. llms.txt lists sitemap pages (except tools optional)
const llms = fs.readFileSync(path.join(SITE, "llms.txt"), "utf8");
for (const loc of locs) {
  if (loc.endsWith("/tools")) continue;
  if (!llms.includes(loc)) warnings.push(`llms.txt missing ${loc}`);
}

// 6. 404 must NOT be in sitemap
if (locs.some((l) => l.includes("404"))) errors.push("404.html in sitemap");

console.log(`verify-seo-indexing: ${locs.length} sitemap URLs checked`);
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
