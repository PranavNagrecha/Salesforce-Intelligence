#!/usr/bin/env node
/**
 * Fast documentation drift gate.
 *
 * This script intentionally checks facts the product can prove cheaply:
 * - every registered MCP tool has a description
 * - website calibrated counts match the built product surface
 * - known stale boundary phrases are absent from active skills/docs
 *
 * It also reports, but does not yet fail on, tool names missing from skills.
 * That coverage audit is useful, but the current skills describe many tools by
 * family rather than by exact tool name.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

let V01_TOOLS;
try {
  ({ V01_TOOLS } = await import(join(root, 'packages/mcp/dist/src/tools/index.js')));
} catch (error) {
  fail(`Could not import built V01_TOOLS. Run pnpm -r build first. ${error.message}`);
  V01_TOOLS = [];
}

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

// recalibrate.mjs writes the calibrated snapshot here (post-Astro location).
const websiteDataPath = join(root, 'website/src/data/site-data.json');
if (existsSync(websiteDataPath)) {
  const siteData = JSON.parse(read(websiteDataPath));
  if (siteData.toolCount !== V01_TOOLS.length) {
    fail(
      `website/src/data/site-data.json toolCount=${siteData.toolCount} but V01_TOOLS has ${V01_TOOLS.length}. Run website/recalibrate.mjs before release.`,
    );
  }
} else {
  warn('website/src/data/site-data.json not found; skipping website count check.');
}

// Instructional docs Claude reads to decide boundary disclosures — these must
// not carry a stale claim. CHANGELOG.md is deliberately excluded: it is a
// historical log that legitimately QUOTES removed phrasings (e.g. "removed the
// 'no LWC/Aura references' claim"), which a substring scan can't tell apart
// from making the claim.
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

for (const path of [...activeDocs, ...skillFiles, ...honestyConstantPaths]) {
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

const configurationMd = join(root, 'docs/configuration.md');
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
  skillFileCount: skillFiles.length,
  warnings,
  failures,
};

console.log(JSON.stringify(result, null, 2));

if (failures.length > 0) {
  process.exit(1);
}
