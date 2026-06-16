#!/usr/bin/env node
/* ============================================================================
 * recalibrate.mjs  -  the single source of truth for every COMPUTED number on
 * the sf-intelligence website.
 *
 *   $ node recalibrate.mjs                 # uses ../sf-intelligence
 *   $ SFI_PRODUCT_DIR=/path node recalibrate.mjs
 *
 * What it does (it does the MATH  -  it never reads the site's own docs or the
 * product README for numbers):
 *   1. Imports the live tool registry (V01_TOOLS) from the built product.
 *   2. Counts every test case across every package by scanning *.test.ts.
 *   3. Runs the product's own surface math (component/edge/skill/command counts).
 *   4. Writes site-data.json  -  the calibrated snapshot (diffable next run).
 *   5. Regenerates the generated surfaces: tools.html + llms-full.txt.
 *   6. Rewrites every inline number in the hand-written pages (hero/stat/meta/
 *      OG card/trust table) to match.
 *   7. Rebuilds the OG PNG from the SVG (macOS qlmanage+sips; warns if absent).
 *   8. Prints a before -> after diff so you can see exactly what moved.
 *
 * Requires: the product repo present as a sibling (or SFI_PRODUCT_DIR), built
 * (`pnpm -r build` in the product) so packages/mcp/dist exists. Node 20+.
 * ========================================================================== */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SITE = path.dirname(fileURLToPath(import.meta.url));
// Find the product repo. Works whether this site is nested inside it
// (sf-intelligence/website → product is the parent) or a sibling
// (../sf-intelligence). Override with SFI_PRODUCT_DIR.
function findProduct() {
  if (process.env.SFI_PRODUCT_DIR) return path.resolve(process.env.SFI_PRODUCT_DIR);
  for (const c of [path.resolve(SITE, ".."), path.resolve(SITE, "../sf-intelligence")]) {
    if (fs.existsSync(path.join(c, "packages/mcp"))) return c;
  }
  return path.resolve(SITE, ".."); // default: nested layout (parent is the product)
}
const PRODUCT = findProduct();

// The published npm version is the single source of truth for the site version,
// so the website never drifts from the package it documents.
const VERSION = JSON.parse(
  fs.readFileSync(path.join(PRODUCT, "packages/cli/package.json"), "utf8"),
).version;

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  ⚠ ", ...a);
const die = (m) => { console.error("\n✗ " + m + "\n"); process.exit(1); };
const fmt = (n) => Number(n).toLocaleString("en-US");

/* ---- editorial constants (config, not computed from source) ------------- */
const GATES = [
  "Type-check", "Lint", "Unit tests", "Integration + golden tests",
  "End-to-end smoke", "Natural-language regression", "Analytical correctness eval",
  "Scale benchmarks", "SAST", "Release guard", "Org-data leak scan",
];
const SCALE_BUDGETS = {
  graphImport: "10,000 nodes in under 90 seconds",
  fullRefresh: "1,000 object + field files in under 10 minutes",
  resolve: "p95 under 2 seconds on the CI vault",
};
// per-package one-line descriptions for the trust-page table (editorial)
const PKG_DESC = {
  mcp: (s) => `The ${s.toolCount} read-only tools + router + grounding layer`,
  extractors: () => "Metadata parsing for every Salesforce component type",
  graph: () => "The DuckDB dependency-graph engine",
  cli: () => `The <span class="mono">sfi</span> command-line tool`,
  patterns: () => "Heuristic recognizers (PII, naming, code quality)",
  parsers: () => "Formula / SOQL / source tokenizers",
  renderers: () => "Markdown vault rendering",
  vault: () => "Vault layout, manifest, freshness",
  "tooling-api": () => "Optional Tooling-API enrichment",
};

/* =========================================================================
 * 1. COMPUTE  -  the math, straight from product source
 * ======================================================================= */
if (!fs.existsSync(PRODUCT)) die(`Product repo not found at ${PRODUCT}. Set SFI_PRODUCT_DIR.`);

// --- tools: import the live registry from the built product ---
const distIndex = path.join(PRODUCT, "packages/mcp/dist/src/tools/index.js");
if (!fs.existsSync(distIndex)) die(`Built tool registry missing: ${distIndex}\n  Build the product first:  (cd "${PRODUCT}" && pnpm -r build)`);
const { V01_TOOLS } = await import(pathToFileURL(distIndex).href);
if (!Array.isArray(V01_TOOLS)) die("V01_TOOLS not found in the built registry.");
const tools = V01_TOOLS.map((t) => ({ name: t.name, description: String(t.description || "").replace(/\s+/g, " ").trim() }));
const toolCount = tools.length;
log(`• tools (V01_TOOLS):            ${toolCount}`);

// --- surface math (component/edge/skill/command counts) via the product's own script ---
let surface = {};
try {
  surface = JSON.parse(execSync("node scripts/product-surface.mjs", { cwd: PRODUCT, encoding: "utf8" }));
  log(`• component types:              ${surface.componentTypeCount}`);
  log(`• edge types:                   ${surface.edgeTypeCount}`);
  log(`• skills:                       ${surface.skillCount}`);
  log(`• slash commands:               ${surface.slashCommandCount}`);
  if (surface.toolCount && surface.toolCount !== toolCount)
    warn(`product-surface toolCount (${surface.toolCount}) != V01_TOOLS length (${toolCount}); trusting V01_TOOLS.`);
} catch (e) {
  warn("product-surface.mjs failed; skill/command/type counts will be left untouched.", e.message);
}

// --- tests: count every case across every package ---
function walkTests(dir, acc = []) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTests(p, acc);
    else if (e.name.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}
const countCases = (file) => (fs.readFileSync(file, "utf8").match(/^[ \t]*(it|test)\(/gm) || []).length;
const pkgRoot = path.join(PRODUCT, "packages");
const packages = [];
for (const name of fs.readdirSync(pkgRoot).sort()) {
  const dir = path.join(pkgRoot, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  const files = walkTests(dir);
  if (!files.length) continue;
  const cases = files.reduce((a, f) => a + countCases(f), 0);
  packages.push({ name, files: files.length, cases });
}
packages.sort((a, b) => b.cases - a.cases);
const totalCases = packages.reduce((a, p) => a + p.cases, 0);
const totalFiles = packages.reduce((a, p) => a + p.files, 0);
const packageCount = packages.length;
log(`• unit test cases:              ~${fmt(totalCases)} across ${totalFiles} files in ${packageCount} packages`);

// --- integration suites ---
let integrationSuiteCount = 0;
try {
  integrationSuiteCount = fs.readdirSync(path.join(PRODUCT, "tests/integration")).filter((f) => f.endsWith(".test.ts")).length;
} catch { warn("tests/integration not found; integration count left as-is."); }
log(`• integration suites:           ${integrationSuiteCount}`);

const stats = {
  generatedAt: new Date().toISOString(),
  // NB: never write an absolute local path (e.g. PRODUCT) into site-data.json  - 
  // it ships in the repo and the release guard rejects /Users/<name> paths.
  toolCount,
  skillCount: surface.skillCount ?? null,
  commandCount: surface.slashCommandCount ?? null,
  componentTypeCount: surface.componentTypeCount ?? null,
  edgeTypeCount: surface.edgeTypeCount ?? null,
  tests: { packages, totalCases, totalFiles, packageCount },
  integrationSuiteCount,
  gates: GATES, gateCount: GATES.length,
  scaleBudgets: SCALE_BUDGETS,
};
const approxTests = Math.floor(totalCases / 100) * 100;      // 3112 -> 3100
const approxStr = fmt(approxTests);                           // "3,100"

/* =========================================================================
 * 2. snapshot + diff
 * ======================================================================= */
const dataPath = path.join(SITE, "site-data.json");
let prev = null;
try { prev = JSON.parse(fs.readFileSync(dataPath, "utf8")); } catch {}
fs.writeFileSync(dataPath, JSON.stringify(stats, null, 2) + "\n");

/* =========================================================================
 * 3. regenerate the GENERATED surfaces (tools.html + the catalog)
 * ======================================================================= */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oneLine = (d) => {
  let s = d.split(/\.\s/)[0].trim();
  if (s.length > 165) s = s.slice(0, 162).trimEnd() + "…";
  else if (!/[.!?…]$/.test(s)) s += ".";
  return s;
};
const bare = (n) => n.replace(/^sfi\./, "");
const GROUPS = [
  ["Orientation & routing", (n) => ["capabilities","route_question","synthesize_answer","resolve","disambiguate_concepts","guidance"].includes(n)],
  ["Search & find", (n) => n.startsWith("search_") || n.startsWith("find_") || ["get_component","list_components","lookup_record"].includes(n)],
  ["Explain & understand", (n) => n.startsWith("explain_") || ["field_meaning","field_provenance","what_happens_on_save","order_of_execution"].includes(n)],
  ["Impact, dependencies & what-if", (n) => n.startsWith("what_if_") || ["get_impact","get_edges","get_subgraph","downstream_effects","field_lineage","field_360","call_graph","method_reachability","find_dependency_cycles","safe_to_delete_field","value_change_audit","why_field_changed","tests_for_change","blast_radius_live","field_change_advisor","package_impact"].includes(n)],
  ["Permissions, sharing & access", (n) => n.includes("permission") || ["why_cant_user_see_record","crud_fls_audit","field_access_audit","generate_sharing_summary","unassigned_permission_sets","layout_for_user"].includes(n)],
  ["Code & quality", (n) => ["code_quality_audit","governor_limit_risks","find_dead_code","test_coverage_gaps","test_coverage_for_method","meaningful_test_audit","apex_test_coverage","apex_build_advisor","process_builder_migration_candidates"].includes(n)],
  ["Automation, integrations & events", (n) => ["integration_map","endpoint_catalog","outbound_message_catalog","cdc_subscribers","event_subscribers","async_chain_depth","scheduled_job_catalog","automation_build_advisor","automation_risk_report"].includes(n)],
  ["Industries  -  OmniStudio & CPQ", (n) => n.startsWith("omni") || n.startsWith("cpq_") || ["integration_procedure_chain","datatransform_field_map","decision_table_browse"].includes(n)],
  ["Documentation generators", (n) => n.startsWith("generate_") || ["org_overview","get_naming_convention_report","domain_clusters","field_mapping_between_objects"].includes(n)],
  ["Health, freshness & audit", (n) => n.startsWith("baseline_") || ["health_check","coverage_report","get_manifest","org_pulse","org_history","org_risk_report","release_readiness_report","pii_inventory","tech_debt_score","changed_since","trend","churn","last_modified","diff_snapshots","what_changed_since_refresh","field_cleanup_candidates","unused_components","unused_fields_deep","empty_queues_and_groups","promotion_readiness","retrieve_blindspot_report"].includes(n)],
  ["Cross-org & fleet", (n) => n.startsWith("compare_") || n.startsWith("fleet_")],
  ["Live org data (opt-in)", (n) => n.startsWith("live_")],
  ["Other tools", () => true],
];
const buckets = new Map(GROUPS.map(([l]) => [l, []]));
for (const t of tools) { const n = bare(t.name); for (const [l, test] of GROUPS) if (test(n)) { buckets.get(l).push(t); break; } }
const sections = GROUPS.map(([l]) => [l, buckets.get(l)]).filter(([, a]) => a.length);

const bodyCards = sections.map(([label, arr]) => {
  const rows = arr.map((t) => `          <div class="row"><div class="tn">${esc(t.name)}</div><div class="td">${esc(oneLine(t.description))}</div></div>`).join("\n");
  return `        <article class="card" style="margin-bottom:18px;">
          <h2 style="font-family:var(--mono); font-size:1.15rem; color:var(--fg-strong); margin-bottom:4px;">${esc(label)} <span class="muted" style="font-size:.8rem;">· ${arr.length}</span></h2>
          <div class="toollist">
${rows}
          </div>
        </article>`;
}).join("\n");

const N = toolCount;
const toolsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <title>All ${N} tools  -  sf-intelligence Salesforce MCP tool reference</title>
  <meta name="description" content="The complete reference for all ${N} read-only sf-intelligence tools for a Salesforce org  -  search, explain, impact &amp; dependency analysis, permissions, code quality, integrations, OmniStudio, documentation, health, cross-org, and live data  -  each with what it does.">
  <link rel="canonical" href="https://salesforce-intelligence.pages.dev/tools.html">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <meta name="author" content="sf-intelligence">
  <meta name="theme-color" content="#05070A">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="sf-intelligence">
  <meta property="og:title" content="All ${N} tools  -  sf-intelligence Salesforce MCP tool reference">
  <meta property="og:description" content="Every read-only sf-intelligence tool for a Salesforce org, grouped by function, each with what it does.">
  <meta property="og:url" content="https://salesforce-intelligence.pages.dev/tools.html">
  <meta property="og:image" content="https://salesforce-intelligence.pages.dev/assets/img/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="sf-intelligence product card">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="All ${N} tools  -  sf-intelligence">
  <meta name="twitter:description" content="The complete Salesforce MCP tool reference, each with what it does.">
  <meta name="twitter:image" content="https://salesforce-intelligence.pages.dev/assets/img/og-image.png">

  <link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/assets/img/favicon-32.png" sizes="32x32" type="image/png">
  <link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=VT323&display=swap">
  <link rel="stylesheet" href="/assets/css/style.css">

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://salesforce-intelligence.pages.dev/" },
      { "@type": "ListItem", "position": 2, "name": "Capabilities", "item": "https://salesforce-intelligence.pages.dev/capabilities.html" },
      { "@type": "ListItem", "position": 3, "name": "All tools", "item": "https://salesforce-intelligence.pages.dev/tools.html" }
    ]
  }
  </script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>

  <header class="site-header">
    <div class="container nav">
      <a class="brand" href="/" aria-label="sf-intelligence home"><span class="mk">&gt;_</span>&nbsp;sf-intelligence</a>
      <nav aria-label="Primary">
        <ul class="nav-links">
          <li><a href="/capabilities.html">capabilities</a></li>
          <li><a href="/tools.html">tools</a></li>
          <li><a href="/trust.html">trust</a></li>
          <li><a href="/getting-started.html">get-started</a></li>
          <li><a href="/faq.html">faq</a></li>
        </ul>
      </nav>
      <div class="nav-cta">
        <a class="btn btn-ghost" href="https://www.npmjs.com/package/sf-intelligence" rel="noopener">npm</a>
        <a class="btn btn-solid" href="/#install">install</a>
        <button class="nav-toggle" aria-label="Open menu" aria-controls="mobile-menu" aria-expanded="false">menu</button>
      </div>
    </div>
    <div class="container">
      <div id="mobile-menu" class="mobile-menu">
        <ul>
          <li><a href="/capabilities.html">capabilities</a></li>
          <li><a href="/tools.html">tools</a></li>
          <li><a href="/trust.html">trust</a></li>
          <li><a href="/getting-started.html">get-started</a></li>
          <li><a href="/faq.html">faq</a></li>
        </ul>
        <a class="btn btn-solid" href="/#install" style="width:100%; justify-content:center;">install</a>
      </div>
    </div>
  </header>

  <main id="main">
    <section class="subhero">
      <div class="container">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">home</a><span>/</span><a href="/capabilities.html">capabilities</a><span>/</span>tools</nav>
        <h1 class="screen-type">All ${N} Salesforce tools</h1>
        <p>The complete reference for every read-only tool sf-intelligence exposes for a Salesforce org  -  grouped by function, each with what it does. You never call these by name; the router picks them from your plain-language question. They are listed here for transparency and so AI assistants can cite them accurately.</p>
      </div>
    </section>

    <section>
      <div class="container">
${bodyCards}
        <p class="muted center" style="margin-top:24px; font-size:.84rem;">${N} tools registered in this build. Grouping is by function for readability; some tools span more than one area. Generated from the product's tool registry.</p>
        <div style="padding-top:38px;">
          <div class="cta-box">
            <h2 class="screen-type">See it in action</h2>
            <p>You don't memorize these  -  you ask in plain language and the router runs the right ones.</p>
            <div class="cta-actions">
              <a class="btn btn-solid" href="/getting-started.html">get started</a>
              <a class="btn btn-ghost" href="/capabilities.html">capability overview</a>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-about">
          <a class="brand" href="/" style="margin-bottom:12px;"><span class="mk">&gt;_</span>&nbsp;sf-intelligence</a>
          <p>An offline, read-only, MCP-first knowledge base for one Salesforce org. Answers grounded in real metadata  -  never a guess.</p>
        </div>
        <div><h4>product</h4><ul><li><a href="/capabilities.html">capabilities</a></li><li><a href="/tools.html">all tools</a></li><li><a href="/trust.html">quality &amp; trust</a></li><li><a href="/#install">install</a></li></ul></div>
        <div><h4>docs</h4><ul><li><a href="/getting-started.html">getting started</a></li><li><a href="/configuration.html">configuration</a></li><li><a href="/faq.html">faq</a></li><li><a href="https://www.npmjs.com/package/sf-intelligence" rel="noopener">npm package</a></li></ul></div>
        <div><h4>about</h4><ul><li><a href="/faq.html#privacy">privacy</a></li><li><a href="/licensing.html">license</a></li></ul></div>
      </div>
      <div class="footer-bottom">
        <span><span class="ok">●</span> © <span id="year">2026</span> sf-intelligence  -  all systems offline</span>
        <span>MIT + Commons Clause · built for Salesforce teams</span>
      </div>
    </div>
  </footer>

  <script src="/assets/js/main.js" defer></script>
</body>
</html>
`;
fs.writeFileSync(path.join(SITE, "tools.html"), toolsHtml);

/* =========================================================================
 * 4. rewrite inline numbers in the hand-written pages
 * ======================================================================= */
const changed = new Set();
function patch(rel, rules) {
  const file = path.join(SITE, rel);
  if (!fs.existsSync(file)) { warn(`missing ${rel}, skipped.`); return; }
  let s = fs.readFileSync(file, "utf8"); const before = s;
  for (const [re, rep] of rules) s = s.replace(re, rep);
  if (s !== before) { fs.writeFileSync(file, s); changed.add(rel); }
}
const T = String(toolCount);

patch("index.html", [
  [/(<b>)\d[\d,]*(<\/b> tools<\/span>)/, `$1${T}$2`],
  [/(browse )\d[\d,]*( capabilities)/, `$1${T}$2`],
  [/(offline_snapshot · )\d[\d,]*( tools ready)/, `$1${T}$2`],
  [/(<div class="num">)\d[\d,]*(<\/div><div class="label">read-only tools<\/div>)/, `$1${T}$2`],
  [/(› all )\d[\d,]*( tools<\/a>)/, `$1${T}$2`],
  [/("softwareVersion": ")\d+\.\d+\.\d+(")/, `$1${VERSION}$2`],
]);
patch("capabilities.html", [
  [/(capability map: )\d[\d,]*( read-only tools)/, `$1${T}$2`],
  [/(content=")\d[\d,]*( read-only tools across eight)/g, `$1${T}$2`],
  [/(registers <strong>)\d[\d,]*(<\/strong> read-only tools)/, `$1${T}$2`],
  [/(see all )\d[\d,]*( tools  -  each explained)/, `$1${T}$2`],
]);
patch("assets/img/og-image.svg", [
  [/(>)\d[\d,]*(<\/text><text x="68" y="34" fill="#5E8A6E">tools)/, `$1${T}$2`],
]);

// llms.txt: tool / skill / command counts (skill+command only if surface ran)
const llmsRules = [
  [/(\*\*)\d[\d,]*( read-only tools\*\*)/, `$1${T}$2`],
  [/(\(version )\d+\.\d+\.\d+(\))/, `$1${VERSION}$2`],
];
if (stats.commandCount != null) llmsRules.push([/(\*\*)\d+( slash commands\*\*)/, `$1${stats.commandCount}$2`]);
if (stats.skillCount != null) llmsRules.push([/(ships \*\*)\d+( skills\*\*)/, `$1${stats.skillCount}$2`]);
patch("llms.txt", llmsRules);

// trust.html: stat band, headings, meta, per-package table
const pkgRows = packages.map((p) => {
  const desc = (PKG_DESC[p.name] || (() => `${p.name} package tests`))(stats);
  const tail = p.name === "mcp" ? ` across ${p.files} files` : "";
  return `            <div class="row"><div class="tn">${esc(p.name)}</div><div class="td">${desc}  -  <strong>≈${fmt(p.cases)}</strong> cases${tail}.</div></div>`;
}).join("\n");
patch("trust.html", [
  [/(<div class="num">)[\d,]+\+?(<\/div><div class="label">automated tests<\/div>)/, `$1${approxStr}+$2`],
  [/(<div class="num">)\d+(<\/div><div class="label">tested packages<\/div>)/, `$1${packageCount}$2`],
  [/(<div class="num">)\d+(<\/div><div class="label">CI gates per change<\/div>)/, `$1${stats.gateCount}$2`],
  [/(~)[\d,]+( tests across the stack)/, `$1${approxStr}$2`],
  [/(~)[\d,]+( unit tests)/, `$1${approxStr}$2`],
  [/(~)[\d,]+( automated tests)/g, `$1${approxStr}$2`],
  [/(automated tests across )\d+( packages)/g, `$1${packageCount}$2`],
  [/(the )\d[\d,]*( MCP tools and the CLI)/, `$1${T}$2`],
  [/(<strong>)\d+( integration suites<\/strong>)/, `$1${integrationSuiteCount}$2`],
  [/<!--PKGTABLE:start[\s\S]*?<!--PKGTABLE:end-->/, `<!--PKGTABLE:start (regenerated by recalibrate.mjs  -  do not hand-edit)-->\n          <div class="toollist">\n${pkgRows}\n          </div>\n          <!--PKGTABLE:end-->`],
]);

/* =========================================================================
 * 5. regenerate llms-full.txt from the (now-patched) llms.txt + the catalog
 * ======================================================================= */
const llms = fs.readFileSync(path.join(SITE, "llms.txt"), "utf8").trimEnd();
let cat = `\n\n## All tools (${N})\n\nEvery read-only tool, grouped by function. You never call these by name  -  a router maps a plain-language question to the right ones.\n`;
for (const [label, arr] of sections) {
  cat += `\n### ${label} (${arr.length})\n\n`;
  cat += arr.map((t) => `- \`${t.name}\`  -  ${oneLine(t.description)}`).join("\n") + "\n";
}
fs.writeFileSync(path.join(SITE, "llms-full.txt"), llms + cat + "\n");

/* =========================================================================
 * 6. rebuild the OG PNG from the SVG (macOS qlmanage + sips)
 * ======================================================================= */
try {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "sfi-og-"));
  const svg = path.join(SITE, "assets/img/og-image.svg");
  execSync(`qlmanage -t -s 1200 -o "${tmp}" "${svg}"`, { stdio: "ignore" });
  execSync(`sips -c 630 1200 "${tmp}/og-image.svg.png" --out "${path.join(SITE, "assets/img/og-image.png")}"`, { stdio: "ignore" });
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { warn("OG PNG not rebuilt (qlmanage/sips unavailable). Re-export assets/img/og-image.svg manually."); }

/* =========================================================================
 * 7. report
 * ======================================================================= */
log("\n -  site-data.json written  - ");
const metrics = {
  toolCount, skillCount: stats.skillCount, commandCount: stats.commandCount,
  componentTypeCount: stats.componentTypeCount, edgeTypeCount: stats.edgeTypeCount,
  unitTestCases: totalCases, testPackages: packageCount, integrationSuites: integrationSuiteCount, ciGates: stats.gateCount,
};
log("\nMETRIC                 PREVIOUS -> NOW");
for (const [k, v] of Object.entries(metrics)) {
  const old = prev ? (
    k === "unitTestCases" ? prev.tests?.totalCases :
    k === "testPackages" ? prev.tests?.packageCount :
    k === "integrationSuites" ? prev.integrationSuiteCount :
    k === "ciGates" ? prev.gateCount :
    prev[k]
  ) : undefined;
  const moved = prev && old !== v;
  log(`  ${k.padEnd(20)} ${String(old ?? " - ").padStart(8)} -> ${String(v).padStart(6)} ${moved ? "  ← changed" : ""}`);
}
log("\nFILES REWRITTEN: " + (changed.size ? [...changed].join(", ") : "(none  -  already calibrated)") + ", tools.html, llms-full.txt");
log("✓ recalibration complete.\n");
