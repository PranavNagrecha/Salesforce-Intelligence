#!/usr/bin/env node
/**
 * Fast documentation / product-fact drift gate.
 *
 * Failures (objective, registry-backed):
 * - every registered MCP tool has a description
 * - committed eval/product-manifest.json matches runtime registries
 * - committed eval/product-surface.json matches the manifest projection
 * - website calibrated counts match the ProductManifest
 * - README / CLAUDE / architecture current-fact concept counts match
 * - configuration.md advertised/registered tool counts match
 * - architecture.md graph table inventory matches the manifest
 * - known stale boundary phrases are absent from active skills/docs
 *
 * Warnings (reported, non-blocking):
 * - tool names missing from skills
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  GRAPH_TABLES,
  buildProductManifest,
  checkArchitectureGraphTables,
  checkCoreRosterCountPins,
  matchConceptCountFacts,
  manifestDrift,
  stripVolatile,
  toProductSurface,
} from './lib/build-product-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const warnings = [];

function read(path) {
  return readFileSync(path, 'utf8');
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

let manifest;
try {
  manifest = await buildProductManifest(root);
} catch (error) {
  fail(`Could not build ProductManifest. Run pnpm -r build first. ${error.message}`);
  manifest = null;
}

const V01_TOOLS = manifest
  ? (
      await import(
        pathToFileURL(join(root, 'packages/mcp/dist/src/tools/index.js')).href
      )
    ).V01_TOOLS
  : [];

const names = new Set();
for (const tool of V01_TOOLS) {
  if (!tool?.name) {
    fail('A V01_TOOLS entry is missing name.');
    continue;
  }
  if (names.has(tool.name)) {
    fail(`Duplicate tool name: ${tool.name}`);
  }
  names.add(tool.name);
  if (typeof tool.description !== 'string' || tool.description.trim().length === 0) {
    fail(`Tool ${tool.name} is missing a description.`);
  }
}

// ── ProductManifest committed artifact ──────────────────────────────────────
const manifestPath = join(root, 'eval/product-manifest.json');
if (!manifest) {
  // Already failed above.
} else if (!existsSync(manifestPath)) {
  fail(
    'eval/product-manifest.json missing. Run: node scripts/generate-product-manifest.mjs',
  );
} else {
  const committed = JSON.parse(read(manifestPath));
  const drift = manifestDrift(committed, manifest);
  if (drift) {
    fail(
      `eval/product-manifest.json drifted from runtime registries ` +
        `(committed content sha256:${drift.expectedHash}, live sha256:${drift.actualHash}` +
        (drift.changedKeys.length
          ? `; changed keys: ${drift.changedKeys.join(', ')}`
          : '') +
        `). Run: node scripts/generate-product-manifest.mjs`,
    );
  }
  if (committed.tools.total !== V01_TOOLS.length) {
    fail(
      `product-manifest tools.total=${committed.tools.total} but V01_TOOLS has ${V01_TOOLS.length}`,
    );
  }
}

// ── Product surface must stay a pure projection of the manifest ─────────────
const surfacePath = join(root, 'eval/product-surface.json');
if (manifest && existsSync(manifestPath)) {
  if (!existsSync(surfacePath)) {
    fail(
      'eval/product-surface.json missing. Run: node scripts/product-surface.mjs --write',
    );
  } else {
    const committedSurface = stripVolatile(JSON.parse(read(surfacePath)));
    const committedManifest = JSON.parse(read(manifestPath));
    const projected = toProductSurface(committedManifest);
    const vsManifest = manifestDrift(committedSurface, projected);
    if (vsManifest) {
      fail(
        `eval/product-surface.json drifted from eval/product-manifest.json ` +
          `(surface sha256:${vsManifest.expectedHash}, projection sha256:${vsManifest.actualHash}` +
          (vsManifest.changedKeys.length
            ? `; changed keys: ${vsManifest.changedKeys.join(', ')}`
            : '') +
          `). Run: node scripts/product-surface.mjs --write`,
      );
    }
    const vsLive = manifestDrift(committedSurface, toProductSurface(manifest));
    if (vsLive) {
      fail(
        `eval/product-surface.json drifted from runtime registries ` +
          `(committed sha256:${vsLive.expectedHash}, live sha256:${vsLive.actualHash}` +
          (vsLive.changedKeys.length
            ? `; changed keys: ${vsLive.changedKeys.join(', ')}`
            : '') +
          `). Run: node scripts/product-surface.mjs --write`,
      );
    }
  }
}

// ── Website calibrated snapshot (Astro path) ────────────────────────────────
const websiteDataPaths = [
  join(root, 'website/src/data/site-data.json'),
  join(root, 'website/site-data.json'), // legacy pre-Astro path
];
const websiteDataPath = websiteDataPaths.find((p) => existsSync(p));
if (websiteDataPath && manifest) {
  const siteData = JSON.parse(read(websiteDataPath));
  if (siteData.toolCount !== manifest.tools.total) {
    fail(
      `${websiteDataPath} toolCount=${siteData.toolCount} but ProductManifest tools.total=${manifest.tools.total}. Run website/recalibrate.mjs.`,
    );
  }
  if (
    siteData.conceptCount != null &&
    siteData.conceptCount !== manifest.conceptModel.concepts
  ) {
    fail(
      `${websiteDataPath} conceptCount=${siteData.conceptCount} but ProductManifest concepts=${manifest.conceptModel.concepts}. Run website/recalibrate.mjs.`,
    );
  }
  if (
    siteData.conceptRuleCount != null &&
    siteData.conceptRuleCount !== manifest.conceptModel.rules
  ) {
    fail(
      `${websiteDataPath} conceptRuleCount=${siteData.conceptRuleCount} but ProductManifest rules=${manifest.conceptModel.rules}. Run website/recalibrate.mjs.`,
    );
  }
  if (
    siteData.componentTypeCount != null &&
    siteData.componentTypeCount !== manifest.graph.componentTypeCount
  ) {
    fail(
      `${websiteDataPath} componentTypeCount=${siteData.componentTypeCount} but ProductManifest has ${manifest.graph.componentTypeCount}.`,
    );
  }
  if (
    siteData.edgeTypeCount != null &&
    siteData.edgeTypeCount !== manifest.graph.edgeTypeCount
  ) {
    fail(
      `${websiteDataPath} edgeTypeCount=${siteData.edgeTypeCount} but ProductManifest has ${manifest.graph.edgeTypeCount}.`,
    );
  }
} else if (!websiteDataPath) {
  warn('website/src/data/site-data.json not found; skipping website count check.');
}

// ── Current-fact concept counts in instructional docs ───────────────────────
if (manifest && manifest.conceptModel.concepts > 0) {
  const { concepts, rules } = manifest.conceptModel;
  const docsToPin = [
    join(root, 'README.md'),
    join(root, 'CLAUDE.md'),
    join(root, 'docs/architecture.md'),
  ];
  for (const path of docsToPin) {
    if (!existsSync(path)) continue;
    const text = read(path);
    const matches = matchConceptCountFacts(text);
    if (matches.length === 0) {
      warn(
        `${path} has no "N concepts /|,|and M rules" current-fact form to pin.`,
      );
      continue;
    }
    for (const m of matches) {
      // Historical prose ("when the Concept Model held 94…") is allowed only
      // outside these instructional files — here every pair must be current.
      if (m.concepts !== concepts || m.rules !== rules) {
        fail(
          `${path} states ${m.concepts} concepts / ${m.rules} rules but ProductManifest has ${concepts}/${rules}`,
        );
      }
    }
  }
}

// ── configuration.md tool counts ────────────────────────────────────────────
const configurationMd = join(root, 'docs/configuration.md');
if (existsSync(configurationMd) && manifest) {
  const configText = read(configurationMd);
  const rosterRe =
    /(\d+)\s+advertised tool schemas\s*\((\d+)\s+registered;\s*(\d+)\s+back-compat/;
  const m = configText.match(rosterRe);
  if (!m) {
    fail(
      'docs/configuration.md missing "N advertised tool schemas (M registered; K back-compat" pin.',
    );
  } else {
    const advertised = Number(m[1]);
    const registered = Number(m[2]);
    const backCompat = Number(m[3]);
    if (advertised !== manifest.tools.advertised) {
      fail(
        `docs/configuration.md advertised=${advertised} but ProductManifest advertised=${manifest.tools.advertised}`,
      );
    }
    if (registered !== manifest.tools.total) {
      fail(
        `docs/configuration.md registered=${registered} but ProductManifest total=${manifest.tools.total}`,
      );
    }
    if (backCompat !== manifest.tools.hidden) {
      fail(
        `docs/configuration.md back-compat=${backCompat} but ProductManifest hidden=${manifest.tools.hidden}`,
      );
    }
  }
}

// ── core-roster size pin (AUDIT-F6 / live_consent in core → 19) ─────────────
// The advertised/registered pin above does not watch the core-roster integer
// that surfaces teach hosts. A silent pass with no match is how 18 survived.
if (manifest) {
  const expectedCore = manifest.tools.profiles?.core?.length ?? null;
  if (typeof expectedCore !== 'number' || expectedCore < 1) {
    fail('ProductManifest missing tools.profiles.core for core-roster pin.');
  } else {
    const corePinFiles = {
      'README.md': join(root, 'README.md'),
      'CLAUDE.md': join(root, 'CLAUDE.md'),
      // The canonical configuration reference states the same integer as
      // "N-schema spine"; it carries the advertised/registered pins already but
      // was NOT core-count pinned, so a stale 18 passed the gate here.
      'docs/configuration.md': join(root, 'docs/configuration.md'),
      // Definition site of CORE_PROFILE_TOOLS — a stale JSDoc here misleads the
      // next maintainer more than any doc does.
      'packages/mcp/src/tools/tool-profile.ts': join(
        root,
        'packages/mcp/src/tools/tool-profile.ts',
      ),
      'website/src/pages/getting-started.astro': join(
        root,
        'website/src/pages/getting-started.astro',
      ),
      'website/src/pages/configuration.astro': join(
        root,
        'website/src/pages/configuration.astro',
      ),
      'website/public/llms.txt': join(root, 'website/public/llms.txt'),
      'website/public/llms-full.txt': join(root, 'website/public/llms-full.txt'),
    };
    const texts = {};
    for (const [label, path] of Object.entries(corePinFiles)) {
      if (!existsSync(path)) {
        warn(`${label} missing — cannot pin core-roster size.`);
        continue;
      }
      texts[label] = read(path);
    }
    const { failures: coreFails, warnings: coreWarns } = checkCoreRosterCountPins(
      texts,
      expectedCore,
    );
    for (const message of coreFails) fail(message);
    for (const message of coreWarns) warn(message);
  }
}

// ── pinned install commands must name the shipping version ──────────────────
// llms.txt / llms-full.txt are published for verbatim machine citation and
// carry `npx -y sf-intelligence@X.Y.Z` install commands. recalibrate.mjs
// rewrites the COUNT blocks in those files but not these lines, so the pin is
// hand-maintained and silently rotted a full minor behind (0.2.5 while the
// same file's header announced 0.3.0). Any assistant citing the site would
// hand users an install command for the previous release.
if (manifest) {
  const versionPinFiles = [
    'website/public/llms.txt',
    'website/public/llms-full.txt',
    'README.md',
    'docs/guides/installation.md',
    '.claude-plugin/plugin.json',
  ];
  const pinRe = /sf-intelligence@(\d+\.\d+\.\d+)/g;
  for (const rel of versionPinFiles) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const text = read(path);
    pinRe.lastIndex = 0;
    let match;
    while ((match = pinRe.exec(text)) !== null) {
      if (match[1] !== manifest.version) {
        fail(
          `${rel} pins ${match[0]} but the shipping version is ${manifest.version}`,
        );
      }
    }
  }
}

// ── REPO-STRUCTURE.md plugin inventory must match what is on disk ───────────
// The repo map advertised "25 skill folders" and "4 slash commands" while
// .claude/ held 26 and 5 (sfi-field-audit shipped unlisted in BOTH counts).
// Counted from disk, never hand-maintained.
{
  // Local binding: this block runs above the `skillsRoot` declaration.
  const skillsDir = join(root, '.claude/skills');
  const toolCount = V01_TOOLS.length;
  let componentTypeCount = 0;
  let edgeTypeCount = 0;
  try {
    ({ COMPONENT_TYPES: componentTypeCount } = await import(
      pathToFileURL(join(root, 'packages/mcp/dist/src/tools/list-components.js')).href
    ));
    componentTypeCount = componentTypeCount?.length ?? 0;
    ({ EDGE_TYPES: edgeTypeCount } = await import(
      pathToFileURL(join(root, 'packages/contracts/dist/index.js')).href
    ));
    edgeTypeCount = edgeTypeCount?.length ?? 0;
  } catch (error) {
    warn(`Could not read COMPONENT_TYPES / EDGE_TYPES to pin inventory. ${error.message}`);
  }
  const skillDirCount = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    : 0;
  const commandsRoot = join(root, '.claude/commands');
  const commandNames = existsSync(commandsRoot)
    ? readdirSync(commandsRoot)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''))
        .sort()
    : [];
  // Every surface that states the plugin's own size, not just the repo map.
  // The entry-point skill (loaded first in EVERY session) was the worst
  // offender: 72/20/121/25 against 101/23/209/26.
  const inventoryPinFiles = [
    'REPO-STRUCTURE.md',
    'README.md',
    '.claude/skills/using-sf-intelligence/SKILL.md',
    '.claude/skills/refreshing-the-org-vault/SKILL.md',
  ];
  // label → [regex, expected]. A file that states none of these is fine;
  // a file that states one WRONG is not.
  const inventoryPins = [
    ['skill folders/skills', /\*{0,2}(\d+)\*{0,2}\s+skill(?:s| folders)\b/gi, skillDirCount],
    ['slash commands', /\*{0,2}(\d+)\*{0,2}\s+slash\s+commands/gi, commandNames.length],
    ['component types', /\*{0,2}(\d+)\*{0,2}\s+component\s+types/gi, componentTypeCount],
    ['edge types', /\*{0,2}(\d+)\*{0,2}\s+(?:typed\s+)?edge\s+types/gi, edgeTypeCount],
    ['sfi.* tools', /\*{0,2}(\d+)\s*\n?`sfi\.\*` tools/gi, toolCount],
  ];
  for (const rel of inventoryPinFiles) {
    const path = join(root, rel);
    if (!existsSync(path)) {
      warn(`${rel} missing — cannot pin the plugin inventory.`);
      continue;
    }
    const text = read(path);
    for (const [label, pattern, expected] of inventoryPins) {
      if (typeof expected !== 'number' || expected <= 0) continue;
      const re = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = re.exec(text)) !== null) {
        if (Number(match[1]) !== expected) {
          fail(
            `${rel} states ${match[1]} ${label} ("${match[0].replace(/\n/g, ' ').trim()}") ` +
              `but the live count is ${expected}`,
          );
        }
      }
    }
  }
  // A count that matches while a NAME is missing is how sfi-field-audit stayed
  // invisible in two files at once: the list is the claim, not just the number.
  for (const rel of ['REPO-STRUCTURE.md', 'README.md']) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const text = read(path);
    if (!/slash\s+commands/i.test(text)) continue;
    for (const name of commandNames) {
      if (!text.includes(name)) {
        fail(`${rel} states a slash-command list that omits \`${name}\``);
      }
    }
  }
}

// ── staleness-check count must match STALE_CHECK_TYPES ──────────────────────
// docs/configuration.md advertised the fleet drift sweep as "N orgs × 6 checks"
// while STALE_CHECK_TYPES had grown to 15 (the P13-WATCH-sweep widening added
// the permission + security drift families). A reader budgeting
// SFI_LIVE_QUERY_BUDGET off that sentence under-provisions by 2.5x and gets
// budget-exhausted skips the doc says should not happen. Derived from the
// constant, never hand-copied.
if (manifest) {
  let staleCheckCount = null;
  try {
    ({ STALE_CHECK_TYPES: staleCheckCount } = await import(
      pathToFileURL(join(root, 'packages/mcp/dist/src/tools/live-plane.js')).href
    ));
    staleCheckCount = staleCheckCount?.length ?? null;
  } catch (error) {
    warn(`Could not read STALE_CHECK_TYPES to pin staleness-check counts. ${error.message}`);
  }
  if (typeof staleCheckCount === 'number' && staleCheckCount > 0) {
    // Both phrasings docs/configuration.md has used: "N orgs × 15 staleness
    // checks" and the older bare "× 6 checks".
    const staleCountRes = [
      /(\d+)\s+staleness\s+checks/gi,
      /×\s*(\d+)\s+checks\b/g,
      /x\s+(\d+)\s+checks\b/g,
    ];
    const staleCountPinFiles = ['docs/configuration.md'];
    for (const rel of staleCountPinFiles) {
      const path = join(root, rel);
      if (!existsSync(path)) {
        warn(`${rel} missing — cannot pin staleness-check count.`);
        continue;
      }
      const text = read(path);
      let matched = 0;
      for (const pattern of staleCountRes) {
        const re = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = re.exec(text)) !== null) {
          matched += 1;
          if (Number(match[1]) !== staleCheckCount) {
            fail(
              `${rel} states ${match[1]} staleness checks ("${match[0].trim()}") ` +
                `but STALE_CHECK_TYPES.length=${staleCheckCount}`,
            );
          }
        }
      }
      if (matched === 0) {
        warn(
          `${rel} has no staleness-check count phrase ` +
            '(`N staleness checks`); a pin that matches nothing is how stale counts survive.',
        );
      }
    }
  }
}

// ── architecture.md graph tables ────────────────────────────────────────────
const architectureMd = join(root, 'docs/architecture.md');
if (existsSync(architectureMd) && manifest) {
  for (const message of checkArchitectureGraphTables(read(architectureMd), GRAPH_TABLES)) {
    fail(message);
  }
}

// Instructional docs Claude reads to decide boundary disclosures — these must
// not carry a stale claim. CHANGELOG.md is deliberately excluded: it is a
// historical log that legitimately QUOTES removed phrasings.
const activeDocs = [
  join(root, 'README.md'),
  join(root, 'CLAUDE.md'),
  // 0.3.0 removed `liveEnabled: true` as a live-access path, but the security
  // policy and the guides still listed it as one of three ways to open the
  // live plane. Scanning only README/CLAUDE is how that survived — the docs a
  // security reviewer actually reads were never in the set.
  join(root, 'SECURITY.md'),
  join(root, 'docs/architecture.md'),
  join(root, 'docs/configuration.md'),
  join(root, 'docs/guides/installation.md'),
];

const skillsRoot = join(root, '.claude/skills');
const skillFiles = existsSync(skillsRoot)
  ? readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(skillsRoot, entry.name, 'SKILL.md'))
      .filter((path) => existsSync(path))
  : [];

const stalePhrases = [
  {
    // AUDIT-F3: resolveLiveAccess takes `_inputLiveEnabled` and never reads it.
    // Any doc offering it as a third way to enable the plane is now false.
    phrase: 'or pass `liveEnabled: true`',
    reason:
      'AUDIT-F3: per-call liveEnabled is intent only and is NOT a consent path.',
  },
  {
    phrase: 'or `liveEnabled: true`)',
    reason:
      'AUDIT-F3: per-call liveEnabled is intent only and is NOT a consent path.',
  },
  {
    phrase: 'or a per-call\n  `liveEnabled: true` flag',
    reason:
      'AUDIT-F3: per-call liveEnabled is intent only and is NOT a consent path.',
  },
  {
    phrase: 'full roster stays the default',
    reason: 'AUDIT-F6 / Wave 4: default tool profile is core, not full.',
  },
  {
    phrase: 'Zero behavior change under the default',
    reason: 'Default is core; unset no longer means full.',
  },
  {
    phrase: 'a non-advertised tool called directly still works',
    reason: 'Under core, non-core tools are refused unless called via run_analysis.',
  },
  {
    phrase: 'a non-advertised tool still works if called directly',
    reason: 'Under core, non-core tools are refused unless called via run_analysis.',
  },
  {
    phrase: 'Default stays `full`',
    reason: 'Default tool profile is core.',
  },
  {
    phrase: 'Default stays <code>full</code>',
    reason: 'Default tool profile is core (HTML phrasing).',
  },
  {
    phrase: 'no LWC/Aura references',
    reason: 'LWC/Aura references are now modeled by the frontend reference tier.',
  },
  {
    phrase: 'arrives in v0.3',
    reason:
      'Apex method-body / frontend edges ship today as heuristic edges; they are not a future v0.3 (PMD-AST) item.',
  },
  {
    phrase: 'never enter the impact graph',
    reason:
      'Heuristic Apex/frontend edges DO enter the impact graph now; cite the heuristic tier instead of denying them.',
  },
  {
    phrase: 'NOT in the graph today',
    reason:
      'List views, reports, and dashboards ARE extracted or folded; field tools disclose composition gaps instead.',
  },
  {
    phrase: 'list view filter references are NOT extracted',
    reason: 'ListView column field refs are extracted; only filter evaluation is uncomposed.',
  },
  {
    phrase: 'report column / filter and dashboard component usage is modeled only when',
    reason:
      'P13-REPORTS-default folds capped report/dashboard usage on every full refresh.',
  },
  {
    phrase: "status: 'stale'",
    reason:
      'health_check returns healthy|degraded|unhealthy; staleness is freshness.stale.',
  },
  {
    phrase: "status: 'missing'",
    reason:
      'health_check returns healthy|degraded|unhealthy; a missing vault is checks.vaultExists false.',
  },
  {
    phrase: 'NOT modeled as graph edges',
    reason:
      'Post-AST-flip Apex field refs ARE modeled as parsed graph edges; disclose residual blind spots instead.',
  },
  {
    phrase: 'regex scanner is the default',
    reason: 'Apex AST parsing is the default since P13-AST-flip.',
  },
  {
    phrase: 'WorkflowOutboundMessage:',
    reason:
      'OutboundMessage action edges must target OutboundMessage: promoted node ids.',
  },
  // ── invented Salesforce enum values ───────────────────────────────────────
  // A skill that tells the model to EMIT a value Salesforce does not define is
  // the worst kind of lie this product can tell: it is indistinguishable from
  // an extracted fact. `SinceCaseCreation` / `SinceModified` were once guessed
  // into the escalation-rule extractor's allowed-enum and rejected every real
  // rule as malformed-input, dropping the WHOLE `Case.escalationRules` file
  // from the vault (CHANGELOG "EscalationRule no longer rejects valid
  // escalationStartTime values"). The extractor was corrected; the skill that
  // teaches the same guess was not, and shipped for another two minor versions.
  {
    phrase: 'SinceCaseCreation',
    reason:
      'Invented enum. EscalationRule <escalationStartTime> is CaseCreation | CaseLastModified ' +
      '(ALLOWED_START_TIMES in packages/extractors/src/escalation-rule.ts). This guess once ' +
      'dropped the whole Case.escalationRules file from the vault.',
  },
  {
    phrase: 'SinceLastUpdate',
    reason:
      'Invented enum. EscalationRule <escalationStartTime> is CaseCreation | CaseLastModified ' +
      '(ALLOWED_START_TIMES in packages/extractors/src/escalation-rule.ts).',
  },
  {
    phrase: 'SinceModified',
    reason:
      'Invented enum. EscalationRule <escalationStartTime> is CaseCreation | CaseLastModified ' +
      '(ALLOWED_START_TIMES in packages/extractors/src/escalation-rule.ts).',
  },
  // ── coversTest is declared but has NO producer ────────────────────────────
  // grep -rn coversTest packages/*/src finds only the contract declaration and
  // the two READ sites in what_if_change_method_signature: zero extractors,
  // zero graph-build mints, zero enrichers emit it. Any wording that implies a
  // covering test is normally found and only occasionally "missed" inverts the
  // truth — coverage mapping is entirely unavailable, not mostly known.
  {
    phrase: '@TestVisible`-tagged covering reference',
    reason:
      'coversTest has NO producer (zero emission sites in packages/*/src), and @TestVisible ' +
      'marks a member on the TARGET class — it names no test. An empty result means ' +
      '"test-coverage mapping UNAVAILABLE", never "no tests cover this".',
  },
  {
    phrase: '@TestVisible-tagged covering reference',
    reason:
      'coversTest has NO producer (zero emission sites in packages/*/src), and @TestVisible ' +
      'marks a member on the TARGET class — it names no test. An empty result means ' +
      '"test-coverage mapping UNAVAILABLE", never "no tests cover this".',
  },
  {
    phrase: 'declared via @TestVisible/@TestSetup',
    reason:
      'coversTest has NO producer. @TestVisible marks a member on the TARGET and names no ' +
      'test; @TestSetup sits inside the test class and names no target.',
  },
];

const honestyConstantPaths = [
  join(root, 'packages/mcp/src/tools/field-360.ts'),
  join(root, 'packages/mcp/src/tools/field-lineage.ts'),
  join(root, 'packages/mcp/src/tools/report-dashboard-usage.ts'),
  join(root, 'packages/mcp/src/tools/unused-fields-deep.ts'),
  join(root, 'packages/mcp/src/tools/find-dead-code.ts'),
];

const websiteProfilePaths = [
  join(root, 'website/src/pages/configuration.astro'),
  join(root, 'website/src/pages/getting-started.astro'),
  join(root, 'website/src/pages/index.astro'),
  join(root, 'website/public/llms.txt'),
  join(root, 'website/public/llms-full.txt'),
];

for (const path of [
  ...activeDocs,
  ...skillFiles,
  ...honestyConstantPaths,
  ...websiteProfilePaths,
]) {
  if (!existsSync(path)) continue;
  const content = read(path);
  for (const { phrase, reason } of stalePhrases) {
    if (content.includes(phrase)) {
      fail(`${path} contains stale phrase "${phrase}" (${reason})`);
    }
  }
}

if (skillFiles.length === 0) {
  warn('No active skill files found under .claude/skills.');
} else {
  const skillsText = skillFiles.map(read).join('\n');
  const missingFromSkills = V01_TOOLS
    .map((tool) => tool.name)
    .filter((name) => !skillsText.includes(name) && !skillsText.includes(`sfi.${name}`));
  if (missingFromSkills.length > 0) {
    warn(
      `${missingFromSkills.length}/${V01_TOOLS.length} tools are not named verbatim in skills: ${missingFromSkills
        .slice(0, 20)
        .join(', ')}${missingFromSkills.length > 20 ? ', ...' : ''}`,
    );
  }
}

if (!read(join(root, 'README.md')).includes('sfi.capabilities')) {
  warn('README.md does not mention sfi.capabilities.');
}

const requiredConfigurationPhrases = [
  'sfi register-vault',
  'SF_INTELLIGENCE_REGISTRY_PATH',
  'sfi.fleet_find',
  'sfi.fleet_drift_ranking',
  'sfi.compare_vaults',
  'sfi vault git enable',
];
if (existsSync(configurationMd)) {
  const configText = read(configurationMd);
  for (const phrase of requiredConfigurationPhrases) {
    if (!configText.includes(phrase)) {
      fail(`docs/configuration.md missing required phrase: ${phrase}`);
    }
  }
} else {
  fail('docs/configuration.md missing (required for registry + vault-git discovery pins).');
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT-DERIVED SKILL GUARDS (documentation-truth sweep, round 2)
//
// The prior tripwires above are PHRASE blacklists — they catch a known-bad
// string. These guards instead DERIVE the legal value set from the source of
// truth and check every value a skill renders against it, so a stage/verdict
// /enum that is renamed, added, or removed fails here without anyone
// remembering to add a phrase.
//
// Why this class matters: the skills below were documenting tool contracts
// that DO NOT EXIST — invented stage names, invented verdicts, and a nested
// input envelope for a flat schema, which means every worked example in them
// was a call that returns `invalid-query`. A model following those examples
// answers confidently and wrongly. That is the failure mode this product
// exists to prevent, so it is guarded, not just fixed.
// ═══════════════════════════════════════════════════════════════════════════

/** Every `'literal'` inside a TS union that follows `readonly <field>:`. */
const readonlyUnionMembers = (source, field) => {
  const re = new RegExp(`readonly ${field}:([\\s\\S]*?);`);
  const m = source.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

/** Every value a skill renders as a JSON literal `"<key>": "<value>"`. */
const jsonLiteralValues = (text, key) =>
  [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'g'))].map((x) => x[1]);

const cascadeContracts = [
  {
    tool: 'sfi.layout_for_user',
    sourcePath: join(root, 'packages/mcp/src/tools/layout-for-user.ts'),
    skillPath: join(root, '.claude/skills/admin-page-layout-routing/SKILL.md'),
  },
  {
    tool: 'sfi.why_cant_user_see_record',
    sourcePath: join(root, 'packages/mcp/src/tools/why-cant-user-see-record.ts'),
    skillPath: join(root, '.claude/skills/admin-sharing-troubleshooting/SKILL.md'),
  },
];

for (const { tool, sourcePath, skillPath } of cascadeContracts) {
  if (!existsSync(sourcePath) || !existsSync(skillPath)) {
    warn(`${tool}: cascade guard skipped (source or skill missing).`);
    continue;
  }
  const source = read(sourcePath);
  const skill = read(skillPath);
  for (const field of ['stage', 'verdict']) {
    const legal = readonlyUnionMembers(source, field);
    if (legal === null || legal.length === 0) {
      fail(`${sourcePath}: could not derive the \`${field}\` union for ${tool}.`);
      continue;
    }
    const rendered = jsonLiteralValues(skill, field);
    if (rendered.length === 0) {
      warn(
        `${skillPath} renders no \`"${field}": "…"\` example for ${tool}; the guard has nothing to check.`,
      );
      continue;
    }
    for (const value of new Set(rendered)) {
      if (!legal.includes(value)) {
        fail(
          `${skillPath} documents ${tool} ${field} "${value}", which is not in the real union ` +
            `(${legal.join(' | ')}) declared in ${sourcePath}. A stage/verdict the tool never emits ` +
            `produces a trace the caller cannot reconcile with the response.`,
        );
      }
    }
  }
}

// ── Sharing enums: OWD values + sharing-rule ruleType ───────────────────────
// `"Public"` is a Salesforce UI LABEL ("Public Read Only"), never a metadata
// SharingModel value; `owner-based` / `criteria-based` are English, never
// `ruleType` values. Both were rendered as field values in the sharing skill.
const customObjectSrc = join(root, 'packages/extractors/src/custom-object.ts');
const sharingRulesSrc = join(root, 'packages/extractors/src/sharing-rules.ts');
const sharingSkill = join(root, '.claude/skills/admin-sharing-troubleshooting/SKILL.md');

if (existsSync(customObjectSrc) && existsSync(sharingSkill)) {
  const block = read(customObjectSrc).match(
    /const ALLOWED_SHARING_MODEL = \[([\s\S]*?)\]/,
  );
  if (!block) {
    fail(`${customObjectSrc}: could not derive ALLOWED_SHARING_MODEL.`);
  } else {
    const allowed = [...block[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const skill = read(sharingSkill);
    // Same-line `OWD is \`X\`` / `sharingModel is \`X\`` only — a multi-line
    // window would graze the next backticked token (a stage name) and produce
    // a false red, which is the exact failure mode this gate exists to stop.
    const owdRendered = [
      ...jsonLiteralValues(skill, 'decision'),
      ...[...skill.matchAll(/(?:OWD|sharingModel)`?\s*(?:is|=)\s*`([A-Za-z]+)`/g)].map(
        (x) => x[1],
      ),
    ];
    for (const value of new Set(owdRendered)) {
      if (!allowed.includes(value)) {
        fail(
          `${sharingSkill} presents "${value}" as an OWD / sharingModel value, but ALLOWED_SHARING_MODEL ` +
            `in ${customObjectSrc} is (${allowed.join(' | ')}). The extractor REJECTS anything else.`,
        );
      }
    }
  }
}

if (existsSync(sharingRulesSrc)) {
  const m = read(sharingRulesSrc).match(/type RuleType =([^;]*);/);
  if (!m) {
    fail(`${sharingRulesSrc}: could not derive the sharing RuleType union.`);
  } else {
    const legal = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    for (const path of skillFiles) {
      const text = read(path);
      const rendered = [
        ...jsonLiteralValues(text, 'ruleType'),
        ...[...text.matchAll(/ruleType:\s*'([^']+)'/g)].map((x) => x[1]),
      ];
      for (const value of new Set(rendered)) {
        if (!legal.includes(value)) {
          fail(
            `${path} documents sharing ruleType "${value}"; the extractor emits (${legal.join(' | ')}).`,
          );
        }
      }
    }
  }
}

// ── Zero-producer signals ──────────────────────────────────────────────────
// The `coversTest` lesson generalized. Each name below was READ by a skill as
// if it were a field on a response. None has a producer anywhere in
// `packages/*/src`: no extractor writes it, no enricher mints it, no handler
// returns it. A model reading an absent signal narrates `undefined` as a
// NEGATIVE FINDING ("CDC is not enabled", "this job has no schedule").
//
// The guard is bidirectional ON PURPOSE. It re-runs the producer search every
// gate, so it fails BOTH when a skill starts reading a signal that does not
// exist AND when someone finally implements one — at which point the "this
// does not exist" prose in the skills becomes the lie and must be updated.
const ZERO_PRODUCER_SIGNALS = [
  'parsedCron',
  'rawCronExpression',
  'isCdcEnabled',
  'maxDepthObserved',
  'publishesTo',
];

const collectSourceFiles = (dir, out) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
};

const packagesRoot = join(root, 'packages');
const productSources = existsSync(packagesRoot)
  ? readdirSync(packagesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => collectSourceFiles(join(packagesRoot, e.name, 'src'), []))
  : [];

if (productSources.length === 0) {
  warn('No packages/*/src sources found; skipping the zero-producer signal guard.');
} else {
  const productText = productSources.map(read).join('\n');
  for (const signal of ZERO_PRODUCER_SIGNALS) {
    // A producer writes the key: `signal:` (object literal / interface) or
    // `'signal'` / `"signal"` (computed property, EdgeType member).
    const producerRe = new RegExp(`(^|[^\\w.'"\`])${signal}\\s*:|['"\`]${signal}['"\`]`, 'm');
    const hasProducer = producerRe.test(productText);
    if (hasProducer) {
      fail(
        `\`${signal}\` now appears as a key in packages/*/src, but the skills state it does not exist. ` +
          `Either it shipped (update the skills to READ it) or something re-introduced a phantom. ` +
          `Do not leave the two disagreeing.`,
      );
      continue;
    }
    // No producer. A skill must not put the signal in a FENCED EXAMPLE — that
    // is the text a model copies into a real call or renders as a real field.
    // Naming it in prose is allowed and expected: the skills now say
    // explicitly that these signals do not exist, and that sentence has to be
    // able to contain the name.
    const inFence = new RegExp(`\\b${signal}\\b`);
    for (const path of skillFiles) {
      const fences = [...read(path).matchAll(/```[\s\S]*?```/g)].map((x) => x[0]);
      if (fences.some((block) => inFence.test(block))) {
        fail(
          `${path} renders \`${signal}\` inside a fenced example, but it has ZERO producers in ` +
            `packages/*/src. An absent signal read as a negative finding is the coversTest ` +
            `failure class — a caller copies the example and narrates \`undefined\` as a result.`,
        );
      }
    }
  }
}

// ── code_quality_audit scope contract ──────────────────────────────────────
// `componentFilter` was documented by developer-code-quality but DROPPED by the
// bare `z.object`, so a one-class audit silently returned the ORG-WIDE sweep and
// the caller read it as that class's findings. It is now an honored alias, and
// the schema is `.strict()` so any OTHER mis-spelled scope key is a loud
// `invalid-query` rather than a silent widening.
if (manifest) {
  try {
    const { codeQualityAuditInputSchema } = await import(
      pathToFileURL(join(root, 'packages/mcp/dist/src/tools/code-quality-audit.js')).href
    );
    // Assert the value SURVIVES parsing, not merely that parsing succeeded — a
    // non-strict schema "succeeds" by silently STRIPPING the key, which is the
    // exact bug this guards.
    const aliasParse = codeQualityAuditInputSchema.safeParse({
      componentFilter: 'ApexClass:X',
    });
    if (!aliasParse.success || aliasParse.data.componentFilter !== 'ApexClass:X') {
      fail(
        'code_quality_audit does not carry `componentFilter` through parsing. It is a documented ' +
          'scope alias; stripping it silently downgrades a scoped audit to an org-wide sweep that ' +
          'the caller reads as that one class\'s findings.',
      );
    }
    if (codeQualityAuditInputSchema.safeParse({ compnentFilter: 'ApexClass:X' }).success) {
      fail(
        'code_quality_audit accepted an unknown key. The schema must stay `.strict()` — a stripped ' +
          'scope key returns the org-wide audit, which the caller reads as the scoped result.',
      );
    }
  } catch (error) {
    warn(`Could not load code_quality_audit schema for the scope guard: ${error.message}`);
  }
}

// ── Phantom taxonomy bucket count ──────────────────────────────────────────
// ADR-004 said "six-bucket" while `PhantomClassification` had seven, and the
// error had propagated into two JSDoc headers.
const contractsSrc = join(root, 'packages/contracts/src/index.ts');
const adr004 = join(root, 'docs/decisions/ADR-004-phantom-taxonomy-on-demand.md');
if (existsSync(contractsSrc) && existsSync(adr004)) {
  const m = read(contractsSrc).match(/export type PhantomClassification =([\s\S]*?)\n\n/);
  if (!m) {
    fail(`${contractsSrc}: could not derive the PhantomClassification union.`);
  } else {
    const members = [...m[1].matchAll(/\|\s*'([^']+)'/g)].map((x) => x[1]);
    const NUMBER_WORD = [
      'zero', 'one', 'two', 'three', 'four', 'five',
      'six', 'seven', 'eight', 'nine', 'ten',
    ];
    const word = NUMBER_WORD[members.length];
    const adrText = read(adr004);
    if (word === undefined) {
      warn(`PhantomClassification has ${members.length} members — no word form to pin.`);
    } else if (!adrText.includes(`${word}-bucket`)) {
      fail(
        `ADR-004 does not say "${word}-bucket" but PhantomClassification has ${members.length} members ` +
          `(${members.join(', ')}).`,
      );
    }
    for (const member of members) {
      if (!adrText.includes(member)) {
        fail(`ADR-004 does not document the \`${member}\` phantom bucket.`);
      }
    }
  }
}

const result = {
  toolCount: V01_TOOLS.length,
  advertisedToolCount: manifest?.tools.advertised ?? null,
  conceptCount: manifest?.conceptModel.concepts ?? null,
  conceptRuleCount: manifest?.conceptModel.rules ?? null,
  identityHash: manifest?.identityHash ?? null,
  skillFileCount: skillFiles.length,
  warnings,
  failures,
};

console.log(JSON.stringify(result, null, 2));

if (failures.length > 0) {
  process.exit(1);
}
