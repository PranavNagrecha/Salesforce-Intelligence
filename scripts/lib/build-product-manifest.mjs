/**
 * Build the ProductManifest from runtime registries (built dist + contracts source).
 *
 * This is the single source of truth for tool / graph / concept-model facts that
 * marketing docs, the website, sfi.capabilities, and eval reports must agree on.
 *
 * Consumers:
 *   - scripts/product-surface.mjs          (compat surface + --write)
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

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const countUnionMembers = (src, startMarker, endMarker) => {
  const block = src.match(new RegExp(`${startMarker}([\\s\\S]*?)\\n${endMarker}`))?.[1] ?? '';
  return (block.match(/\| '[^']+'/g) ?? []).length;
};

const listUnionMembers = (src, startMarker, endMarker) => {
  const block = src.match(new RegExp(`${startMarker}([\\s\\S]*?)\\n${endMarker}`))?.[1] ?? '';
  return [...block.matchAll(/\| '([^']+)'/g)].map((m) => m[1]);
};

const countDirEntries = (dir, predicate) => {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter(predicate).length;
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

  const toolsDist = join(root, 'packages/mcp/dist/src/tools/index.js');
  if (!existsSync(toolsDist)) {
    throw new Error(
      `Built tool registry missing: ${toolsDist}. Run pnpm -r build first.`,
    );
  }
  const { V01_TOOLS, CORE_PROFILE_TOOLS } = await import(
    pathToFileURL(toolsDist).href
  );
  if (!Array.isArray(V01_TOOLS)) {
    throw new Error('V01_TOOLS not found in the built registry.');
  }

  let livePlaneForTool = (name) =>
    name.startsWith('sfi.live_') ? 'primary' : 'never';
  try {
    const liveCapDist = join(root, 'packages/mcp/dist/src/live-capability.js');
    if (existsSync(liveCapDist)) {
      const liveMod = await import(pathToFileURL(liveCapDist).href);
      if (typeof liveMod.livePlaneForTool === 'function') {
        livePlaneForTool = liveMod.livePlaneForTool;
      }
    }
  } catch {
    // Fallback above remains.
  }

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

  let schemaVersion = 1;
  try {
    const graphDist = join(root, 'packages/graph/dist/src/migrations.js');
    if (existsSync(graphDist)) {
      const mod = await import(pathToFileURL(graphDist).href);
      if (typeof mod.CURRENT_SCHEMA_VERSION === 'number') {
        schemaVersion = mod.CURRENT_SCHEMA_VERSION;
      }
    }
  } catch {
    // Keep default; verify-doc-sync will still pin GRAPH_TABLES prose.
  }

  let concepts = 0;
  let rules = 0;
  let modelVersion = 'unknown';
  let conceptIds = [];
  let ruleIds = [];
  const conceptDist = join(
    root,
    'packages/mcp/dist/src/knowledge/generated/concept-model.js',
  );
  if (existsSync(conceptDist)) {
    const mod = await import(pathToFileURL(conceptDist).href);
    const CONCEPTS = mod.CONCEPTS ?? {};
    const CONCEPT_RULES = mod.CONCEPT_RULES ?? [];
    conceptIds = Object.keys(CONCEPTS).sort();
    ruleIds = CONCEPT_RULES.map((r) => r.id).sort();
    concepts = conceptIds.length;
    rules = ruleIds.length;
    modelVersion = mod.MODEL_VERSION ?? 'unknown';
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
    generatedAt: manifest.generatedAt,
  };
}

/** Compare two manifests ignoring volatile timestamps. */
export function manifestDrift(expected, actual) {
  const strip = (m) => {
    const { generatedAt: _g, ...rest } = m;
    return rest;
  };
  const a = JSON.stringify(strip(expected), null, 2);
  const b = JSON.stringify(strip(actual), null, 2);
  if (a === b) return null;
  return { expectedHash: sha256(a), actualHash: sha256(b) };
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
