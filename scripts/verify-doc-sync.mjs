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
