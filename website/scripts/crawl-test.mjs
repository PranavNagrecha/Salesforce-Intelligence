#!/usr/bin/env node
/* ============================================================================
 * crawl-test.mjs — crawler-friendliness gate for the sf-intelligence site.
 *
 *   node scripts/crawl-test.mjs [baseUrl]     # default http://localhost:4455
 *
 * Point it at a running preview of the build (`npm run preview -- --port 4455`)
 * or at the live site. It fetches the sitemap and, for every URL, asserts the
 * things a search/AI crawler needs — 200, one self-canonical, one index H1,
 * valid JSON-LD, no noindex — then checks every internal link resolves and no
 * sitemap page is orphaned from the home page. Exit code is non-zero on any
 * failure, so it works as a CI gate. No dependencies (Node 20+ global fetch).
 * ========================================================================== */
const BASE = (process.argv[2] || "http://localhost:4455").replace(/\/$/, "");

let failures = 0;
const fail = (url, msg) => { failures++; console.error(`  ✗ ${url}\n      ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return null; const j = s.indexOf(b, i + a.length); return j < 0 ? null : s.slice(i + a.length, j); };
const countMatches = (s, re) => (s.match(re) || []).length;
const attr = (tag, name) => { const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', "i")); return m ? m[1] : null; };

async function get(path) {
  const res = await fetch(BASE + path, { redirect: "manual" });
  const body = res.status < 400 ? await res.text() : "";
  return { status: res.status, body, location: res.headers.get("location") };
}

// ---- 1. read the sitemap ----
console.log(`\ncrawl-test → ${BASE}\n`);
let sitemapXml;
try {
  const idx = await get("/sitemap-index.xml");
  const sub = between(idx.body, "<loc>", "</loc>"); // first child sitemap
  const subPath = sub ? new URL(sub).pathname : "/sitemap-0.xml";
  sitemapXml = (await get(subPath)).body;
} catch (e) {
  console.error("Could not read sitemap. Is the preview server running?", e.message);
  process.exit(2);
}
const sitemapUrls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname || "/");
if (!sitemapUrls.length) { console.error("Sitemap had no <loc> URLs."); process.exit(2); }
console.log(`Sitemap lists ${sitemapUrls.length} URLs.\n`);

// ---- 2. per-page assertions ----
const internalLinks = new Set();
for (const path of sitemapUrls) {
  const { status, body } = await get(path);
  if (status !== 200) { fail(path, `expected 200, got ${status}`); continue; }

  // canonical: exactly one, path matches this page (host may differ locally)
  const canons = [...body.matchAll(/<link[^>]+rel="canonical"[^>]*>/gi)];
  if (canons.length !== 1) fail(path, `expected 1 canonical, found ${canons.length}`);
  else {
    const href = attr(canons[0][0], "href");
    const cpath = href ? new URL(href).pathname.replace(/\/$/, "") || "/" : "";
    const want = path.replace(/\/$/, "") || "/";
    if (cpath !== want) fail(path, `canonical path "${cpath}" != page path "${want}"`);
  }

  // robots meta: exactly one, must not be noindex
  const robots = [...body.matchAll(/<meta[^>]+name="robots"[^>]*>/gi)];
  if (robots.length !== 1) fail(path, `expected 1 robots meta, found ${robots.length}`);
  else if (/noindex/i.test(robots[0][0])) fail(path, `robots meta is noindex (catastrophic)`);

  // exactly one H1
  const h1 = countMatches(body, /<h1[\s>]/gi);
  if (h1 !== 1) fail(path, `expected 1 <h1>, found ${h1}`);

  // title length 10–90 (upper bound raised for the v0.2.4 SEO release: the audit's
  // page-build-specs use keyword-front-loaded titles up to ~87 chars — Google
  // truncates the tail near ~60 chars, but the primary keyword leads on purpose).
  const title = between(body, "<title>", "</title>");
  if (!title) fail(path, `no <title>`);
  else if (title.length < 10 || title.length > 90) fail(path, `title length ${title.length} out of 10–90: "${title}"`);

  // meta description 70–170
  const descTag = (body.match(/<meta[^>]+name="description"[^>]*>/i) || [])[0];
  const desc = descTag ? attr(descTag, "content") : null;
  if (!desc) fail(path, `no meta description`);
  else if (desc.length < 70 || desc.length > 170) fail(path, `description length ${desc.length} out of 70–170`);

  // lang + viewport
  if (!/<html[^>]+lang=/i.test(body)) fail(path, `no lang attribute`);
  if (!/name="viewport"/i.test(body)) fail(path, `no viewport meta`);

  // every JSON-LD block parses
  for (const m of body.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { JSON.parse(m[1]); } catch { fail(path, `invalid JSON-LD block`); }
  }
  // og:image present
  if (!/property="og:image"/i.test(body)) fail(path, `no og:image`);
  // twitter card parity (audit found lean template missing these)
  if (!/name="twitter:title"/i.test(body)) fail(path, `no twitter:title`);

  // collect internal links for link-integrity + orphan checks
  for (const m of body.matchAll(/href="(\/[^"#]*)(#[^"]*)?"/g)) {
    const p = m[1].replace(/\/$/, "") || "/";
    // Cloudflare rewrites mailto: into /cdn-cgi/l/email-protection#… — a JS-only
    // endpoint that 404s on a bare fetch by design. Not a real broken link.
    if (p.startsWith("/cdn-cgi/")) continue;
    if (!/\.(png|svg|xml|txt|webmanifest|ico|json)$/i.test(p)) internalLinks.add(p);
  }
}
ok(`per-page assertions run over ${sitemapUrls.length} pages`);

// ---- 3. internal link integrity ----
let broken = 0;
for (const link of internalLinks) {
  const { status } = await get(link);
  if (status >= 400) { broken++; fail(link, `internal link → ${status}`); }
}
if (!broken) ok(`all ${internalLinks.size} internal links resolve (no 404s)`);

// ---- 4. orphan check: every sitemap URL must be linked from somewhere ----
const orphans = sitemapUrls.filter((u) => {
  const norm = u.replace(/\/$/, "") || "/";
  return norm !== "/" && !internalLinks.has(norm);
});
if (orphans.length) orphans.forEach((o) => fail(o, `orphan — in sitemap but not linked from any page`));
else ok(`no orphan pages (every sitemap URL is internally linked)`);

// ---- 5. robots.txt welcomes AI crawlers + points at Astro sitemap index ----
const robotsTxt = (await get("/robots.txt")).body;
for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Bingbot"]) {
  const disallowed = new RegExp(`User-agent:\\s*${bot}[\\s\\S]*?Disallow:\\s*/\\s`, "i").test(robotsTxt);
  if (disallowed) fail("/robots.txt", `${bot} is Disallowed (blocks AI crawler)`);
}
if (!/Sitemap:\s*https?:\/\/[^\s]+\/sitemap-index\.xml/i.test(robotsTxt)) {
  fail("/robots.txt", `Sitemap: must point at /sitemap-index.xml (Astro), not a hand-written /sitemap.xml`);
}
ok(`robots.txt checked`);

// ---- 6. legacy /sitemap.xml must redirect to the Astro index ----
{
  const legacy = await get("/sitemap.xml");
  const loc = legacy.location || "";
  const toIndex =
    legacy.status >= 300 &&
    legacy.status < 400 &&
    (/\/sitemap-index\.xml\/?$/.test(new URL(loc, BASE).pathname) ||
      /\/sitemap-0\.xml\/?$/.test(new URL(loc, BASE).pathname));
  // Local `astro preview` may not honor Cloudflare _redirects — accept 200 of
  // the Astro index body only if the file is absent (no stale hand sitemap).
  if (toIndex) ok(`/sitemap.xml redirects → ${new URL(loc, BASE).pathname}`);
  else if (legacy.status === 404) ok(`/sitemap.xml absent (no stale hand sitemap)`);
  else if (legacy.status === 200 && /<sitemapindex[\s>]/i.test(legacy.body)) {
    ok(`/sitemap.xml serves sitemap index directly`);
  } else if (legacy.status === 200 && /<urlset[\s>]/i.test(legacy.body) && /ai-safety/.test(legacy.body)) {
    ok(`/sitemap.xml is a complete urlset (includes ai-safety)`);
  } else {
    fail(
      "/sitemap.xml",
      `expected 301→sitemap-index, 404, or full Astro sitemap; got ${legacy.status}` +
        (loc ? ` location=${loc}` : "") +
        (legacy.body ? ` body=${legacy.body.slice(0, 80).replace(/\s+/g, " ")}…` : ""),
    );
  }
}

// ---- 7. 404 must be noindex and must not self-canonicalize ----
{
  const missing = await get("/__crawl-test-missing-page__");
  const body = missing.body || (await get("/404")).body;
  if (!(missing.status === 404 || missing.status === 200)) {
    fail("/404", `unexpected status ${missing.status} for missing path`);
  } else {
    const robots = [...body.matchAll(/<meta[^>]+name="robots"[^>]*>/gi)];
    if (!robots.length) fail("/404", `missing robots meta`);
    else if (!/noindex/i.test(robots[0][0])) fail("/404", `robots meta must be noindex (got ${robots[0][0]})`);
    const canons = [...body.matchAll(/<link[^>]+rel="canonical"[^>]*>/gi)];
    if (canons.length) fail("/404", `must not emit a canonical (found ${canons.length})`);
    if (robots.length && /noindex/i.test(robots[0][0]) && !canons.length) {
      ok(`404 page is noindex with no canonical`);
    }
  }
}

// ---- summary ----
console.log("");
if (failures) { console.error(`✗ crawl-test FAILED with ${failures} issue(s).\n`); process.exit(1); }
console.log(`✓ crawl-test PASSED — ${sitemapUrls.length} pages, ${internalLinks.size} links, 0 issues.\n`);
