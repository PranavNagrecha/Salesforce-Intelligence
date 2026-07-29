#!/usr/bin/env node
/**
 * seo-snapshot.mjs — SEO drift baseline (item #32 / T29).
 *
 * After a build, walks `website/dist/**` and snapshots, per route, the four
 * signals that must not silently drift:
 *   - <title>
 *   - <link rel="canonical" href>
 *   - the first visible <h1> text
 *   - the set of JSON-LD @type values (from every application/ld+json block,
 *     including nodes inside an @graph)
 *
 * Usage:
 *   node scripts/seo-snapshot.mjs            # write/update the baseline
 *   node scripts/seo-snapshot.mjs --check    # compare against the baseline, report drift
 *
 * DELIBERATELY NON-FAILING: even with --check this always exits 0 and only
 * prints a human-readable drift report. It is NOT wired into a CI gate — that
 * wiring (and the decision to make drift fail a build) is left to a separate,
 * explicit step so a concurrent/central build is never broken by this script.
 * It also never runs a build itself; it only reads an already-built dist/.
 *
 * Zero dependencies (Node stdlib only). Extraction is regex-based, which is
 * sufficient for these deterministic, self-authored templates.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = join(HERE, "..");
const DIST = join(WEBSITE_ROOT, "dist");
const BASELINE = join(HERE, "seo-baseline.json");

/** Recursively collect every .html file under a directory. */
function walkHtml(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walkHtml(full));
    else if (entry.endsWith(".html")) out.push(full);
  }
  return out;
}

/** Map a dist/*.html path to its canonical-ish route key (format:"file" output). */
function routeKey(file) {
  let rel = relative(DIST, file).replace(/\\/g, "/");
  rel = rel.replace(/index\.html$/, "").replace(/\.html$/, "");
  rel = rel.replace(/\/$/, "");
  return "/" + rel;
}

function firstMatch(re, html) {
  const m = re.exec(html);
  return m ? m[1].trim() : null;
}

/** Collect every @type value found in the page's JSON-LD blocks. */
function jsonLdTypes(html) {
  const types = new Set();
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const nodes = [];
      if (Array.isArray(data)) nodes.push(...data);
      else if (data["@graph"]) nodes.push(...data["@graph"]);
      else nodes.push(data);
      for (const node of nodes) {
        const t = node && node["@type"];
        if (Array.isArray(t)) t.forEach((x) => types.add(x));
        else if (t) types.add(t);
      }
    } catch {
      /* ignore malformed block */
    }
  }
  return [...types].sort();
}

function snapshotFile(file) {
  const html = readFileSync(file, "utf8");
  const title = firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  const canonical = firstMatch(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i, html);
  const h1raw = firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
  const h1 = h1raw ? h1raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : null;
  return { title, canonical, h1, jsonLdTypes: jsonLdTypes(html) };
}

function buildSnapshot() {
  const snap = {};
  for (const file of walkHtml(DIST).sort()) snap[routeKey(file)] = snapshotFile(file);
  return snap;
}

function diff(baseline, current) {
  const routes = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const changes = [];
  for (const route of [...routes].sort()) {
    const a = baseline[route];
    const b = current[route];
    if (!a) { changes.push(`+ ${route} (new route)`); continue; }
    if (!b) { changes.push(`- ${route} (route removed)`); continue; }
    for (const field of ["title", "canonical", "h1"]) {
      if (a[field] !== b[field]) changes.push(`~ ${route} ${field}: ${JSON.stringify(a[field])} -> ${JSON.stringify(b[field])}`);
    }
    const ta = (a.jsonLdTypes || []).join(",");
    const tb = (b.jsonLdTypes || []).join(",");
    if (ta !== tb) changes.push(`~ ${route} jsonLdTypes: [${ta}] -> [${tb}]`);
  }
  return changes;
}

function main() {
  if (!existsSync(DIST)) {
    console.error(`seo-snapshot: no dist/ found at ${DIST}. Run the build first, then re-run this script.`);
    return; // exit 0 — non-failing by design
  }
  const current = buildSnapshot();
  const check = process.argv.includes("--check");

  if (check && existsSync(BASELINE)) {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    const changes = diff(baseline, current);
    if (changes.length === 0) {
      console.log(`seo-snapshot: no drift across ${Object.keys(current).length} routes.`);
    } else {
      console.log(`seo-snapshot: DRIFT detected (${changes.length}):`);
      for (const c of changes) console.log("  " + c);
      console.log("\nIf intended, refresh the baseline: node scripts/seo-snapshot.mjs");
    }
    return; // never fails the build
  }

  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n");
  console.log(`seo-snapshot: wrote baseline for ${Object.keys(current).length} routes -> ${relative(WEBSITE_ROOT, BASELINE)}`);
}

main();
