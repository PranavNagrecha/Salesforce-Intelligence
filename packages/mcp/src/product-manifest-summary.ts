/**
 * Runtime ProductManifest summary for `sfi.capabilities`.
 *
 * Derived from the same registries the CI generator
 * (`scripts/lib/build-product-manifest.mjs`) reads — never from handwritten
 * docs — so the tool's self-description cannot disagree with the committed
 * `eval/product-manifest.json` on counts/hashes that matter for trust.
 */

import { createHash } from 'node:crypto';

import { CURRENT_SCHEMA_VERSION } from '@sf-intelligence/graph';

import { CONCEPT_RULES, CONCEPTS, MODEL_VERSION } from './knowledge/loader.js';
import { livePlaneForTool } from './live-capability.js';
import { V01_TOOLS } from './tools/roster.js';
import { CORE_PROFILE_TOOLS } from './tools/tool-profile.js';

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** Graph tables that form a vault snapshot (lockstep with SCHEMA_DDL). */
export const PRODUCT_GRAPH_TABLES = [
  'nodes',
  'edges',
  'facts',
  'schema_version',
] as const;

/** Tools that write local vault/state (Salesforce remains read-only). */
export const PRODUCT_LOCAL_MUTATION_TOOLS = [
  'sfi.propose_annotation',
  'sfi.confirm_annotation',
  'sfi.reject_annotation',
  'sfi.baseline_acknowledge',
] as const;

export interface ProductManifestSummary {
  readonly schemaVersion: '1.0';
  readonly tools: {
    readonly total: number;
    readonly advertised: number;
    readonly hidden: number;
    readonly coreProfileSize: number;
    readonly liveCount: number;
    readonly localMutation: readonly string[];
  };
  readonly graph: {
    readonly tables: readonly string[];
    readonly schemaVersion: number;
  };
  readonly conceptModel: {
    readonly concepts: number;
    readonly rules: number;
    readonly contentHash: string;
    readonly modelVersion: string;
  };
  readonly catalogHash: string;
}

export const buildProductManifestSummary = (): ProductManifestSummary => {
  const advertised = V01_TOOLS.filter((t) => !t.hidden);
  const hidden = V01_TOOLS.filter((t) => t.hidden);
  const liveCount = V01_TOOLS.filter(
    (t) => livePlaneForTool(t.name) !== 'never',
  ).length;
  const localMutation = PRODUCT_LOCAL_MUTATION_TOOLS.filter((name) =>
    V01_TOOLS.some((t) => t.name === name),
  );

  const conceptIds = Object.keys(CONCEPTS).sort();
  const ruleIds = CONCEPT_RULES.map((r) => r.id).sort();
  const contentHash = sha256(
    `concepts:${conceptIds.join(',')}\nrules:${ruleIds.join(',')}\nmodel:${MODEL_VERSION}`,
  );
  const catalogHash = sha256(
    V01_TOOLS.map((t) => `${t.name}\n${String(t.description ?? '').trim()}`)
      .sort()
      .join('\n---\n'),
  );

  return {
    schemaVersion: '1.0',
    tools: {
      total: V01_TOOLS.length,
      advertised: advertised.length,
      hidden: hidden.length,
      coreProfileSize: CORE_PROFILE_TOOLS.size,
      liveCount,
      localMutation,
    },
    graph: {
      tables: [...PRODUCT_GRAPH_TABLES],
      schemaVersion: CURRENT_SCHEMA_VERSION,
    },
    conceptModel: {
      concepts: conceptIds.length,
      rules: ruleIds.length,
      contentHash: `sha256:${contentHash}`,
      modelVersion: MODEL_VERSION,
    },
    catalogHash: `sha256:${catalogHash}`,
  };
};
