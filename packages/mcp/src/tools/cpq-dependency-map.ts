/**
 * Handler for the `sfi.cpq_dependency_map` MCP tool.
 *
 * The third of three v2.6a CPQ-specialist tools. Walks the values
 * mirror of every requested CPQ-typed node and surfaces every string-
 * encoded `SBQQ__`-prefixed field reference as a heuristic dependency
 * edge. When `cpqComponentId` is provided, the walker scans only that
 * one component; when omitted, it scans every CPQ-typed node in the
 * vault up to `limit` per CPQ type.
 *
 * Honesty axis: this is a HEURISTIC dependency surface. The recognizer
 * scans string values for the `SBQQ__` prefix literally; it does NOT
 * resolve the referenced node, does NOT walk formula text via the v0.2
 * formula tokenizer, and does NOT account for references encoded in
 * non-string fields. False positives and false negatives are both
 * expected — the boundary disclosure surfaces verbatim.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { phantomAwareNotFoundMessage } from './phantom-node.js';

/**
 * The five CPQ ComponentTypes the tool scans. Mirrors the recognition
 * set in `cpq.ts`. The dependency walker treats all five uniformly —
 * any v2.6a-emitted CPQ node carries a values mirror and is therefore
 * a candidate for the SBQQ__-prefix walk.
 */
const CPQ_NODE_TYPES: readonly ComponentType[] = [
  'CpqProductRule',
  'CpqPriceRule',
  'CpqQuoteTemplate',
  'CpqLookupQuery',
  'CpqConfigurationAttribute',
];

const CPQ_PREFIXES: readonly string[] = CPQ_NODE_TYPES.map((t) => `${t}:`);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Verbatim boundary disclosure per CpqSemantics.md §4.3.
 */
const DEPENDENCY_MAP_DISCLOSURE =
  'CPQ dependency mapping is heuristic — string-value scanning ' +
  'catches direct field references but misses formula-walked ' +
  'dependencies, numeric id references, and dynamic-dispatch ' +
  'resolutions. Use this output as a starting point for impact ' +
  'analysis, not as an authoritative dependency graph.';

/**
 * Zod schema for the `sfi.cpq_dependency_map` tool input. Both fields
 * are optional. When `cpqComponentId` is set, the prefix constraint is
 * enforced at the handler boundary.
 */
export const cpqDependencyMapInputSchema = z.object({
  cpqComponentId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

/** Parsed input shape. */
export type CpqDependencyMapInput = z.infer<
  typeof cpqDependencyMapInputSchema
>;

/**
 * One (source, referencedFieldToken) pair, with the count of times the
 * token appears across the source component's values mirror. Tokens
 * surface in alphabetical order per source component.
 */
export interface CpqDependencyEntry {
  readonly fromComponentId: ComponentId;
  readonly fromComponentType: ComponentType;
  readonly fromApiName: string;
  readonly referencedFieldToken: string;
  readonly occurrenceCount: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface CpqDependencyMapOutput {
  readonly scannedComponentCount: number;
  readonly dependencies: readonly CpqDependencyEntry[];
  readonly truncated: boolean;
  readonly disclosure: string;
}

/**
 * The token pattern the SBQQ__-prefix walker matches: the literal
 * `SBQQ__` followed by one or more identifier characters, optionally
 * followed by a `__c` / `__mdt` / `__r` suffix. The pattern is
 * deliberately conservative — it surfaces likely field references and
 * skips arbitrary `SBQQ__` mentions inside larger strings.
 */
const SBQQ_TOKEN_PATTERN = /SBQQ__[A-Za-z0-9]+(?:__c|__mdt|__r)?/g;

/**
 * Decide whether `componentId` carries one of the five v2.6a CPQ
 * prefixes. Returns true on match, false otherwise.
 */
const isCpqComponentId = (componentId: string): boolean =>
  CPQ_PREFIXES.some((prefix) => componentId.startsWith(prefix));

/**
 * Walk a node's values mirror and collect every SBQQ__-prefix token
 * appearing in any string-typed value. Tokens are de-duped and counted
 * — the returned map carries occurrence counts so callers can spot
 * heavily-referenced fields.
 */
const walkSbqqTokens = (node: Node): ReadonlyMap<string, number> => {
  const tokens = new Map<string, number>();
  const rawValues = node.properties['values'];
  if (!Array.isArray(rawValues)) return tokens;
  for (const entry of rawValues) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    // Skip masked values — the recognition layer collapsed the
    // underlying value, so the string contents are intentionally
    // absent and would yield spurious matches.
    if (obj['isMasked'] === true) continue;
    const value = obj['value'];
    if (typeof value !== 'string') continue;
    const matches = value.match(SBQQ_TOKEN_PATTERN);
    if (matches === null) continue;
    for (const match of matches) {
      tokens.set(match, (tokens.get(match) ?? 0) + 1);
    }
  }
  return tokens;
};

/**
 * Emit one dependency entry per (node, token) pair, sorted by token
 * name for deterministic output order.
 */
const dependencyEntriesForNode = (
  node: Node,
): readonly CpqDependencyEntry[] => {
  const tokens = walkSbqqTokens(node);
  const entries: CpqDependencyEntry[] = [];
  for (const [token, count] of tokens) {
    entries.push({
      fromComponentId: node.id,
      fromComponentType: node.type,
      fromApiName: node.apiName,
      referencedFieldToken: token,
      occurrenceCount: count,
    });
  }
  return entries.sort((a, b) =>
    a.referencedFieldToken < b.referencedFieldToken
      ? -1
      : a.referencedFieldToken > b.referencedFieldToken
        ? 1
        : 0,
  );
};

/**
 * The `sfi.cpq_dependency_map` MCP tool. Returns a heuristic
 * dependency map for the requested CPQ component or every CPQ node in
 * the vault.
 *
 * @example
 *   const r = await cpqDependencyMapHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.dependencies.length);
 */
export const cpqDependencyMapHandler = async (
  ctx: Context,
  input: CpqDependencyMapInput,
): Promise<Result<McpResponse<CpqDependencyMapOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const dependencies: CpqDependencyEntry[] = [];
  let scannedComponentCount = 0;
  let truncated = false;

  if (input.cpqComponentId !== undefined) {
    if (!isCpqComponentId(input.cpqComponentId)) {
      return err({
        kind: 'invalid-query',
        message: `cpqComponentId must start with one of ${CPQ_PREFIXES.join(', ')}; got '${input.cpqComponentId}'`,
        path: 'cpqComponentId',
      });
    }
    const nodeResult = await getNodeById(
      ctx.graph,
      input.cpqComponentId,
    );
    if (!nodeResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${nodeResult.error.message}`,
      });
    }
    const node = nodeResult.value;
    if (node === null) {
      return err({
        kind: 'component-not-found',
        message: await phantomAwareNotFoundMessage(ctx, input.cpqComponentId, 'CPQ component'),
        path: input.cpqComponentId,
      });
    }
    if (!CPQ_NODE_TYPES.includes(node.type as ComponentType)) {
      return err({
        kind: 'component-not-found',
        message: `no CPQ component with id ${input.cpqComponentId}`,
        path: input.cpqComponentId,
      });
    }
    scannedComponentCount = 1;
    for (const entry of dependencyEntriesForNode(node)) {
      dependencies.push(entry);
    }
  } else {
    // Scan every CPQ-typed node up to `limit` per type. The per-type
    // cap keeps the total work bounded; `truncated` flips true when
    // any type's list returns exactly `limit` entries (a heuristic
    // signal that more nodes exist).
    for (const type of CPQ_NODE_TYPES) {
      const listResult = await listNodesByType(ctx.graph, type, {
        limit,
      });
      if (!listResult.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${listResult.error.message}`,
        });
      }
      const nodes = listResult.value;
      scannedComponentCount += nodes.length;
      if (nodes.length === limit) truncated = true;
      for (const node of nodes) {
        for (const entry of dependencyEntriesForNode(node)) {
          dependencies.push(entry);
        }
      }
    }
  }

  // Sort the global emission list by (fromComponentId, token) so
  // identical inputs round-trip to byte-identical outputs.
  const sortedDependencies = dependencies.sort((a, b) => {
    if (a.fromComponentId !== b.fromComponentId) {
      return a.fromComponentId < b.fromComponentId ? -1 : 1;
    }
    return a.referencedFieldToken < b.referencedFieldToken ? -1 : 1;
  });

  return ok({
    data: {
      scannedComponentCount,
      dependencies: sortedDependencies,
      truncated,
      disclosure: DEPENDENCY_MAP_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
