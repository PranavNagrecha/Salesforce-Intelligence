/**
 * Build the ProductManifest from runtime registries (built dist + contracts source).
 *
 * This is the single source of truth for tool / graph / concept-model facts that
 * marketing docs, the website, sfi.capabilities, and eval reports must agree on.
 *
 * Consumers:
 *   - scripts/product-surface.mjs          (compat surface + --write / --check)
 *   - scripts/generate-product-manifest.mjs
 *   - scripts/verify-doc-sync.mjs          (CI drift gate)
 *   - website/recalibrate.mjs
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Tools that write local vault/state files (Salesforce remains read-only). */
export const LOCAL_MUTATION_TOOLS = Object.freeze([
  'sfi.propose_annotation',
  'sfi.confirm_annotation',
  'sfi.reject_annotation',
  'sfi.baseline_acknowledge',
]);

/** Network operation classes the product can perform when separately enabled. */
export const NETWORK_CAPABILITIES = Object.freeze([
  'update-check',
  'model-download',
  'metadata-retrieve',
  'live-query',
]);

/** DuckDB tables that form a vault graph snapshot (must match SCHEMA_DDL). */
export const GRAPH_TABLES = Object.freeze([
  'nodes',
  'edges',
  'facts',
  'schema_version',
]);

/**
 * Current-fact concept-count pin.
 * Matches Concept Model / Graph B prose with `/`, `,`, or `and` separators,
 * optional markdown bold around the integers, and optional "reasoning" adjective.
 */
export const CONCEPT_COUNT_FACT_RE =
  /(?:Concept Model|Graph B)[^\n]{0,160}?\*{0,2}(\d+)\*{0,2}\s+(?:reasoning\s+)?concepts\s*(?:\/|,|and)\s*\*{0,2}(\d+)\*{0,2}\s+rules/gi;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** @returns {{ concepts: number, rules: number, match: string }[]} */
export function matchConceptCountFacts(text) {
  const re = new RegExp(CONCEPT_COUNT_FACT_RE.source, CONCEPT_COUNT_FACT_RE.flags);
  const out = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    out.push({
      concepts: Number(match[1]),
      rules: Number(match[2]),
      match: match[0],
    });
  }
  return out;
}

/**
 * Require backtick-delimited table mentions so bare substrings (e.g. "artifacts"
 * containing "facts") cannot satisfy the architecture inventory pin.
 * @param {string} archMarkdown
 * @param {readonly string[]} [tables]
 * @returns {string[]} failure messages (empty = pass)
 */
export function checkArchitectureGraphTables(archMarkdown, tables = GRAPH_TABLES) {
  const failures = [];
  if (/with two tables/.test(archMarkdown)) {
    failures.push(
      'docs/architecture.md still says the DuckDB graph has "two tables"; ' +
        `ProductManifest.graph.tables = [${tables.join(', ')}].`,
    );
  }
  for (const table of tables) {
    if (!new RegExp(`\`${table}\\b`).test(archMarkdown)) {
      failures.push(
        `docs/architecture.md missing graph table mention: \`${table}\``,
      );
    }
  }
  return failures;
}

const extractUnionBlock = (src, startMarker, endMarker) => {
  const escapedStart = startMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = src.match(
    new RegExp(`${escapedStart}([\\s\\S]*?)\\n${escapedEnd}`),
  )?.[1];
  if (block == null || block.trim().length === 0) {
    throw new Error(
      `Contract union block empty or missing between "${startMarker}" and "${endMarker}". ` +
        'Markers must match packages/contracts/src/index.ts exactly.',
    );
  }
  return block;
};

const countUnionMembers = (src, startMarker, endMarker) => {
  const block = extractUnionBlock(src, startMarker, endMarker);
  const count = (block.match(/\| '[^']+'/g) ?? []).length;
  if (count === 0) {
    throw new Error(
      `Contract union between "${startMarker}" and "${endMarker}" has zero members.`,
    );
  }
  return count;
};

const listUnionMembers = (src, startMarker, endMarker) => {
  const block = extractUnionBlock(src, startMarker, endMarker);
  const members = [...block.matchAll(/\| '([^']+)'/g)].map((m) => m[1]);
  if (members.length === 0) {
    throw new Error(
      `Contract union between "${startMarker}" and "${endMarker}" has zero members.`,
    );
  }
  return members;
};

const countDirEntries = (dir, predicate) => {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter(predicate).length;
};

const requireDist = (path, label) => {
  if (!existsSync(path)) {
    throw new Error(`Built ${label} missing: ${path}. Run pnpm -r build first.`);
  }
  return path;
};

/**
 * @param {string} [productRoot]
 * @returns {Promise<object>}
 */
export async function buildProductManifest(productRoot) {
  const root =
    productRoot ??
    join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const version = JSON.parse(
    readFileSync(join(root, 'packages/cli/package.json'), 'utf8'),
  ).version;

  const contractsSrc = readFileSync(
    join(root, 'packages/contracts/src/index.ts'),
    'utf8',
  );
  const componentTypes = listUnionMembers(
    contractsSrc,
    'export type ComponentType =',
    'export type ComponentId',
  );
  const edgeTypes = listUnionMembers(
    contractsSrc,
    'export type EdgeType =',
    'export const EDGE_TYPES',
  );

  const toolsDist = requireDist(
    join(root, 'packages/mcp/dist/src/tools/index.js'),
    'tool registry',
  );
  const { V01_TOOLS, CORE_PROFILE_TOOLS } = await import(
    pathToFileURL(toolsDist).href
  );
  if (!Array.isArray(V01_TOOLS)) {
    throw new Error('V01_TOOLS not found in the built registry.');
  }

  const liveCapDist = requireDist(
    join(root, 'packages/mcp/dist/src/live-capability.js'),
    'live-capability module',
  );
  const liveMod = await import(pathToFileURL(liveCapDist).href);
  if (typeof liveMod.livePlaneForTool !== 'function') {
    throw new Error('livePlaneForTool not found in the built live-capability module.');
  }
  const livePlaneForTool = liveMod.livePlaneForTool;

  const registered = [...V01_TOOLS].map((t) => t.name).sort();
  const advertised = V01_TOOLS.filter((t) => !t.hidden).map((t) => t.name).sort();
  const hidden = V01_TOOLS.filter((t) => t.hidden).map((t) => t.name).sort();
  const live = V01_TOOLS.filter((t) => livePlaneForTool(t.name) !== 'never')
    .map((t) => t.name)
    .sort();

  const coreProfile = CORE_PROFILE_TOOLS
    ? [...CORE_PROFILE_TOOLS].sort()
    : [];

  const localMutation = LOCAL_MUTATION_TOOLS.filter((name) =>
    V01_TOOLS.some((t) => t.name === name),
  );

  const catalogHash = sha256(
    V01_TOOLS.map((t) => `${t.name}\n${String(t.description ?? '').trim()}`)
      .sort()
      .join('\n---\n'),
  );

  const graphDist = requireDist(
    join(root, 'packages/graph/dist/src/migrations.js'),
    'graph migrations module',
  );
  const graphMod = await import(pathToFileURL(graphDist).href);
  if (typeof graphMod.CURRENT_SCHEMA_VERSION !== 'number') {
    throw new Error('CURRENT_SCHEMA_VERSION not found in the built graph migrations module.');
  }
  const schemaVersion = graphMod.CURRENT_SCHEMA_VERSION;

  const conceptDist = requireDist(
    join(root, 'packages/mcp/dist/src/knowledge/generated/concept-model.js'),
    'concept-model module',
  );
  const conceptMod = await import(pathToFileURL(conceptDist).href);
  const CONCEPTS = conceptMod.CONCEPTS ?? {};
  const CONCEPT_RULES = conceptMod.CONCEPT_RULES ?? [];
  const conceptIds = Object.keys(CONCEPTS).sort();
  const ruleIds = CONCEPT_RULES.map((r) => r.id).sort();
  const concepts = conceptIds.length;
  const rules = ruleIds.length;
  const modelVersion = conceptMod.MODEL_VERSION ?? 'unknown';
  if (concepts === 0 || rules === 0) {
    throw new Error(
      `Concept model is empty (concepts=${concepts}, rules=${rules}). ` +
        'Run pnpm -r build (and regen:concept-model if needed) first.',
    );
  }
  if (modelVersion === 'unknown') {
    throw new Error('MODEL_VERSION missing from the built concept-model module.');
  }

  const contentHash = sha256(
    `concepts:${conceptIds.join(',')}\nrules:${ruleIds.join(',')}\nmodel:${modelVersion}`,
  );

  const skillCount = countDirEntries(join(root, '.claude/skills'), (d) =>
    d.isDirectory(),
  );
  const slashCommandCount = countDirEntries(join(root, '.claude/commands'), (d) =>
    d.isFile() && d.name.endsWith('.md'),
  );
  const agentCount = countDirEntries(join(root, '.claude/agents'), (d) =>
    d.isFile() && d.name.endsWith('.md'),
  );

  // Stable identity for eval reports (excludes generatedAt).
  const catalogIdentity = sha256(
    JSON.stringify({
      version,
      tools: registered,
      catalogHash,
      conceptContentHash: contentHash,
      componentTypes,
      edgeTypes,
      graphTables: GRAPH_TABLES,
      schemaVersion,
    }),
  );

  return {
    schemaVersion: '1.0',
    version,
    /** MCP SDK server capability negotiation — product is MCP-first. */
    protocolVersion: 'mcp',
    tools: {
      total: V01_TOOLS.length,
      advertised: advertised.length,
      hidden: hidden.length,
      profiles: {
        full: advertised,
        core: coreProfile,
      },
      live,
      localMutation,
      hiddenNames: hidden,
    },
    graph: {
      componentTypes,
      edgeTypes,
      tables: [...GRAPH_TABLES],
      schemaVersion,
      componentTypeCount: componentTypes.length,
      edgeTypeCount: edgeTypes.length,
    },
    conceptModel: {
      concepts,
      rules,
      contentHash: `sha256:${contentHash}`,
      modelVersion,
    },
    networkCapabilities: [...NETWORK_CAPABILITIES],
    skillCount,
    slashCommandCount,
    agentCount,
    catalogHash: `sha256:${catalogHash}`,
    identityHash: `sha256:${catalogIdentity}`,
    /** Volatile; omit from committed artifacts via stripVolatile. */
    generatedAt: new Date().toISOString(),
  };
}

/** Compact counts used by product-surface.mjs / website recalibrate. */
export function toProductSurface(manifest) {
  return {
    toolCount: manifest.tools.total,
    advertisedToolCount: manifest.tools.advertised,
    componentTypeCount: manifest.graph.componentTypeCount,
    edgeTypeCount: manifest.graph.edgeTypeCount,
    conceptCount: manifest.conceptModel.concepts,
    conceptRuleCount: manifest.conceptModel.rules,
    skillCount: manifest.skillCount,
    slashCommandCount: manifest.slashCommandCount,
    agentCount: manifest.agentCount,
    catalogHash: manifest.catalogHash,
    identityHash: manifest.identityHash,
  };
}

/** Drop volatile fields before commit / compare. */
export function stripVolatile(manifestOrSurface) {
  const { generatedAt: _g, ...rest } = manifestOrSurface;
  return rest;
}

/** Compare two manifests ignoring volatile timestamps. */
export function manifestDrift(expected, actual) {
  const aObj = stripVolatile(expected);
  const bObj = stripVolatile(actual);
  const a = JSON.stringify(aObj, null, 2);
  const b = JSON.stringify(bObj, null, 2);
  if (a === b) return null;
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  const changedKeys = [...keys].filter(
    (k) => JSON.stringify(aObj[k]) !== JSON.stringify(bObj[k]),
  );
  return {
    expectedHash: sha256(a),
    actualHash: sha256(b),
    changedKeys,
  };
}

export function countContractUnions(productRoot) {
  const root = productRoot;
  const contractsSrc = readFileSync(
    join(root, 'packages/contracts/src/index.ts'),
    'utf8',
  );
  return {
    componentTypeCount: countUnionMembers(
      contractsSrc,
      'export type ComponentType =',
      'export type ComponentId',
    ),
    edgeTypeCount: countUnionMembers(
      contractsSrc,
      'export type EdgeType =',
      'export const EDGE_TYPES',
    ),
  };
}
