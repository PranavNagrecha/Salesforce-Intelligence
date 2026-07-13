#!/usr/bin/env node
/* ============================================================================
 * recalibrate.mjs  —  the single source of truth for every COMPUTED number on
 * the sf-intelligence website (Astro edition).
 *
 *   $ node recalibrate.mjs                 # product = parent repo
 *   $ SFI_PRODUCT_DIR=/path node recalibrate.mjs
 *
 * DATA-ONLY. Unlike the pre-Astro version, this NO LONGER templates tools.html
 * or regex-rewrites inline numbers into hand-written pages. It emits data files
 * that Astro consumes at build time (Zod-validated → a shape mismatch is a
 * build error, not a silent regex no-op):
 *   1. src/data/site-data.json  — the calibrated numeric snapshot.
 *   2. src/data/tools.json      — the tool registry, grouped by function, with
 *                                 one-line descriptions ready to render.
 *   3. public/llms-full.txt     — regenerated from public/llms.txt + the catalog.
 *   4. public/llms.txt          — inline counts/version patched in place.
 *   5. public/assets/img/og-image.{svg,png} — tool count patched + PNG rebuilt.
 *
 * Requires the product repo present as the parent (or SFI_PRODUCT_DIR), built
 * (`pnpm -r build` so packages/mcp/dist exists). Node 20+. It must run somewhere
 * with the private product repo — NOT in Cloudflare's build (which only sees the
 * public site subfolder). Run it before every deploy that changes product numbers.
 * ========================================================================== */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SITE = path.dirname(fileURLToPath(import.meta.url));
function findProduct() {
  if (process.env.SFI_PRODUCT_DIR) return path.resolve(process.env.SFI_PRODUCT_DIR);
  for (const c of [path.resolve(SITE, ".."), path.resolve(SITE, "../sf-intelligence")]) {
    if (fs.existsSync(path.join(c, "packages/mcp"))) return c;
  }
  return path.resolve(SITE, "..");
}
const PRODUCT = findProduct();
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
const PKG_DESC = {
  mcp: (s) => `The ${s.toolCount} read-only tools + router + grounding layer`,
  extractors: () => "Metadata parsing for every Salesforce component type",
  graph: () => "The DuckDB dependency-graph engine",
  cli: () => "The sfi command-line tool",
  patterns: () => "Heuristic recognizers (PII, naming, code quality)",
  parsers: () => "Formula / SOQL / source tokenizers",
  renderers: () => "Markdown vault rendering",
  vault: () => "Vault layout, manifest, freshness",
  "tooling-api": () => "Optional Tooling-API enrichment",
};

/* =========================================================================
 * 1. COMPUTE — the math, straight from product source
 * ======================================================================= */
if (!fs.existsSync(PRODUCT)) die(`Product repo not found at ${PRODUCT}. Set SFI_PRODUCT_DIR.`);
const distIndex = path.join(PRODUCT, "packages/mcp/dist/src/tools/index.js");
if (!fs.existsSync(distIndex)) die(`Built tool registry missing: ${distIndex}\n  Build the product first:  (cd "${PRODUCT}" && pnpm -r build)`);
const { V01_TOOLS } = await import(pathToFileURL(distIndex).href);
if (!Array.isArray(V01_TOOLS)) die("V01_TOOLS not found in the built registry.");
// Match the product's own advertisedTools logic (packages/mcp/src/tools/index.ts):
// hidden back-compat aliases are filtered out so they never occupy a tools/list
// schema slot — the site advertises the 196 distinct tools, not the 4 aliases.
const tools = V01_TOOLS.filter((t) => !t.hidden).map((t) => ({ name: t.name, description: String(t.description || "").replace(/\s+/g, " ").trim() }));
const toolCount = tools.length;
log(`• tools (V01_TOOLS):            ${toolCount}`);

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

let integrationSuiteCount = 0;
try {
  integrationSuiteCount = fs.readdirSync(path.join(PRODUCT, "tests/integration")).filter((f) => f.endsWith(".test.ts")).length;
} catch { warn("tests/integration not found; integration count left as-is."); }
log(`• integration suites:           ${integrationSuiteCount}`);

const approxTests = Math.floor(totalCases / 100) * 100;
const approxStr = fmt(approxTests);

const stats = {
  generatedAt: new Date().toISOString(),
  version: VERSION,
  toolCount,
  skillCount: surface.skillCount ?? null,
  commandCount: surface.slashCommandCount ?? null,
  componentTypeCount: surface.componentTypeCount ?? null,
  edgeTypeCount: surface.edgeTypeCount ?? null,
  tests: { packages, totalCases, totalFiles, packageCount, approx: approxTests },
  integrationSuiteCount,
  gates: GATES, gateCount: GATES.length,
  scaleBudgets: SCALE_BUDGETS,
  packageDescriptions: packages.map((p) => ({
    name: p.name,
    files: p.files,
    cases: p.cases,
    description: (PKG_DESC[p.name] || (() => `${p.name} package tests`))({ toolCount }),
  })),
};

/* =========================================================================
 * 2. snapshot + diff
 * ======================================================================= */
const dataDir = path.join(SITE, "src/data");
fs.mkdirSync(dataDir, { recursive: true });
const dataPath = path.join(dataDir, "site-data.json");
let prev = null;
try { prev = JSON.parse(fs.readFileSync(dataPath, "utf8")); } catch {}
fs.writeFileSync(dataPath, JSON.stringify(stats, null, 2) + "\n");

/* =========================================================================
 * 3. tools.json — grouped registry for the /tools page + llms-full catalog
 * ======================================================================= */
const normalizeSeoText = (s) => s.replace(/[–—]/g, "-").replace(/…/g, "...");
const oneLine = (d) => {
  let s = d.split(/\.\s/)[0].trim();
  if (s.length > 165) s = s.slice(0, 162).trimEnd() + "...";
  else if (!/[.!?…]$/.test(s)) s += ".";
  return normalizeSeoText(s);
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
  ["Industries — OmniStudio & CPQ", (n) => n.startsWith("omni") || n.startsWith("cpq_") || ["integration_procedure_chain","datatransform_field_map","decision_table_browse"].includes(n)],
  ["Documentation generators", (n) => n.startsWith("generate_") || ["org_overview","get_naming_convention_report","domain_clusters","field_mapping_between_objects"].includes(n)],
  ["Health, freshness & audit", (n) => n.startsWith("baseline_") || ["health_check","coverage_report","get_manifest","org_pulse","org_history","org_risk_report","release_readiness_report","pii_inventory","tech_debt_score","changed_since","trend","churn","last_modified","diff_snapshots","what_changed_since_refresh","field_cleanup_candidates","unused_components","unused_fields_deep","empty_queues_and_groups","promotion_readiness","retrieve_blindspot_report"].includes(n)],
  ["Cross-org & fleet", (n) => n.startsWith("compare_") || n.startsWith("fleet_")],
  ["Live org data (opt-in)", (n) => n.startsWith("live_")],
  ["Other tools", () => true],
];
const buckets = new Map(GROUPS.map(([l]) => [l, []]));
for (const t of tools) { const n = bare(t.name); for (const [l, test] of GROUPS) if (test(n)) { buckets.get(l).push(t); break; } }
const sections = GROUPS.map(([l]) => [l, buckets.get(l)]).filter(([, a]) => a.length)
  .map(([label, arr]) => ({
    label: normalizeSeoText(label),
    tools: arr.map((t) => ({ name: t.name, description: oneLine(t.description) })),
  }));
fs.writeFileSync(path.join(dataDir, "tools.json"), JSON.stringify({ generatedAt: stats.generatedAt, toolCount, sections }, null, 2) + "\n");

/* =========================================================================
 * 4. llms.txt (patch inline numbers) + llms-full.txt (regenerate)
 * ======================================================================= */
const pub = path.join(SITE, "public");
function patch(rel, rules) {
  const file = path.join(pub, rel);
  if (!fs.existsSync(file)) { warn(`missing ${rel}, skipped.`); return; }
  let s = fs.readFileSync(file, "utf8"); const before = s;
  for (const [re, rep] of rules) s = s.replace(re, rep);
  if (s !== before) fs.writeFileSync(file, s);
}
const T = String(toolCount);
const llmsRules = [
  [/(\*\*)\d[\d,]*( read-only tools\*\*)/, `$1${T}$2`],
  [/(\(version )\d+\.\d+\.\d+(\))/, `$1${VERSION}$2`],
];
if (stats.commandCount != null) llmsRules.push([/(\*\*)\d+( slash commands\*\*)/, `$1${stats.commandCount}$2`]);
if (stats.skillCount != null) llmsRules.push([/(ships \*\*)\d+( skills\*\*)/, `$1${stats.skillCount}$2`]);
llmsRules.push([/(~)[\d,]+( automated tests across )\d+( packages)/g, `$1${approxStr}$2${packageCount}$3`]);
patch("llms.txt", llmsRules);

const llms = fs.readFileSync(path.join(pub, "llms.txt"), "utf8").trimEnd();
let cat = `\n\n## All tools (${toolCount})\n\nEvery read-only tool, grouped by function. You never call these by name  -  an offline semantic router surfaces a ranked shortlist and your AI host picks which to run.\n`;
for (const { label, tools: arr } of sections) {
  cat += `\n### ${label} (${arr.length})\n\n`;
  cat += arr.map((t) => `- \`${t.name}\`  -  ${t.description}`).join("\n") + "\n";
}
fs.writeFileSync(path.join(pub, "llms-full.txt"), llms + cat + "\n");

/* =========================================================================
 * 5. og-image: patch tool count in the SVG + rebuild PNG (macOS)
 * ======================================================================= */
patch("assets/img/og-image.svg", [
  [/(>)\d[\d,]*(<\/text><text x="68" y="34" fill="#5E8A6E">tools)/, `$1${T}$2`],
]);
try {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "sfi-og-"));
  const svg = path.join(pub, "assets/img/og-image.svg");
  execSync(`qlmanage -t -s 1200 -o "${tmp}" "${svg}"`, { stdio: "ignore" });
  execSync(`sips -c 630 1200 "${tmp}/og-image.svg.png" --out "${path.join(pub, "assets/img/og-image.png")}"`, { stdio: "ignore" });
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { warn("OG PNG not rebuilt (qlmanage/sips unavailable). Re-export og-image.svg manually."); }

/* =========================================================================
 * 6. report
 * ======================================================================= */
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
log("\nDATA WRITTEN: src/data/site-data.json, src/data/tools.json, public/llms.txt, public/llms-full.txt");
log("✓ recalibration complete.\n");
