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
 *
 * Absence axis: an empty dependency map is ambiguous — it can mean CPQ is
 * installed but nothing references it, OR that CPQ is not installed at all. The
 * response carries `cpqPresent` (true when any CPQ-typed node was scanned OR an
 * `InstalledPackage:SBQQ` node exists) and, when `false`, appends an explicit
 * "CPQ is not installed/modeled" sentence to the disclosure so an empty map is
 * never misread as "installed CPQ has zero dependencies"
 * (CPQ-DEPENDENCY-MAP-EMPTY-WITHOUT-PACKAGE-ABSENCE).
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

const CPQ_DEPENDENCY_MAP_TOOL = 'sfi.cpq_dependency_map';

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

/** The Salesforce CPQ managed-package namespace. Its InstalledPackage id is `InstalledPackage:SBQQ`. */
const CPQ_NAMESPACE = 'SBQQ';
const CPQ_INSTALLED_PACKAGE_ID = `InstalledPackage:${CPQ_NAMESPACE}` as ComponentId;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Disclosure appended when NO CPQ is present in the vault — so an empty
 * dependency map reads as "CPQ is not installed", not "installed CPQ has zero
 * dependencies" (CPQ-DEPENDENCY-MAP-EMPTY-WITHOUT-PACKAGE-ABSENCE).
 */
const CPQ_ABSENT_DISCLOSURE =
  'No Salesforce CPQ (SBQQ) rule/template components and no SBQQ InstalledPackage ' +
  'were found in this vault: an empty dependency map here means CPQ is NOT installed ' +
  '(or was not retrieved), NOT that installed CPQ components have no dependencies.';

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
  // CR-22: page cursor for walking the full dependency list when truncated
  // (full-scan mode only; the single-component path is never paginated).
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
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
  /**
   * Whether Salesforce CPQ (SBQQ) is present in this vault at all — true when
   * any CPQ-typed component was scanned OR an `InstalledPackage:SBQQ` node
   * exists. When `false`, an empty `dependencies` map means CPQ is NOT
   * installed/modeled, NOT that installed CPQ has zero dependencies
   * (CPQ-DEPENDENCY-MAP-EMPTY-WITHOUT-PACKAGE-ABSENCE); the `disclosure` says so.
   */
  readonly cpqPresent: boolean;
  readonly scannedComponentCount: number;
  readonly dependencies: readonly CpqDependencyEntry[];
  readonly truncated: boolean;
  readonly disclosure: string;
  /**
   * Page size applied to the `dependencies` list (full-scan mode only). Present
   * ONLY on a PAGED response (`truncated` or a resumed `offset > 0`); omitted on
   * a whole-fits no-cursor call so that response stays byte-identical to
   * pre-CR-22.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned dependency. Present only when paged (see `limit`). */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when truncated. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated.
   * Echo it back as `cursor` to resume. Absent on a complete page so an
   * in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
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
/**
 * Total-order comparator for the global dependency emission list:
 * fromComponentId ASC, referencedFieldToken ASC, then occurrenceCount ASC.
 *
 * Per-node token de-dup (the `walkSbqqTokens` Map) already makes
 * (fromComponentId, referencedFieldToken) unique today, so the order is
 * effectively unique; occurrenceCount is a defensive final tiebreak so the
 * order stays a STRICT TOTAL order even if a future change emits two rows with
 * the same (fromComponentId, token) — a CR-22 offset resume then cannot dup or
 * skip.
 */
/**
 * Whether the CPQ (SBQQ) managed package is present as an `InstalledPackage`
 * node in the vault. Used only as the fallback presence signal when the full
 * scan found ZERO CPQ-typed components, to distinguish "CPQ not installed"
 * from "installed CPQ has no dependencies".
 */
const cpqPackageInstalled = async (ctx: Context): Promise<Result<boolean, string>> => {
  const r = await getNodeById(ctx.graph, CPQ_INSTALLED_PACKAGE_ID);
  if (!r.ok) return err(r.error.message);
  return ok(r.value !== null);
};

const compareDependencies = (
  a: CpqDependencyEntry,
  b: CpqDependencyEntry,
): number => {
  if (a.fromComponentId !== b.fromComponentId) {
    return a.fromComponentId < b.fromComponentId ? -1 : 1;
  }
  if (a.referencedFieldToken !== b.referencedFieldToken) {
    return a.referencedFieldToken < b.referencedFieldToken ? -1 : 1;
  }
  return a.occurrenceCount - b.occurrenceCount;
};

export const cpqDependencyMapHandler = async (
  ctx: Context,
  input: CpqDependencyMapInput,
): Promise<Result<McpResponse<CpqDependencyMapOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;

  // --- Single-component path: scan exactly one node, no cap, no cursor. ---
  // Left untouched (never paginates); the whole dependency list is emitted.
  if (input.cpqComponentId !== undefined) {
    if (!isCpqComponentId(input.cpqComponentId)) {
      return err({
        kind: 'invalid-query',
        message: `cpqComponentId must start with one of ${CPQ_PREFIXES.join(', ')}; got '${input.cpqComponentId}'`,
        path: 'cpqComponentId',
      });
    }
    const nodeResult = await getNodeById(ctx.graph, input.cpqComponentId);
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
    const dependencies = [...dependencyEntriesForNode(node)].sort(
      compareDependencies,
    );
    return ok({
      data: {
        // A CPQ-typed node was resolved and scanned, so CPQ is present by definition.
        cpqPresent: true,
        scannedComponentCount: 1,
        dependencies,
        truncated: false,
        disclosure: DEPENDENCY_MAP_DISCLOSURE,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // --- Full-scan path (CR-22 B4, Option A). ---
  // Previously each CPQ type was scanned with a single capped
  // `listNodesByType({ limit })` and `truncated` flipped on a per-type SCAN cap
  // (nodes 51+/201+ silently dropped). Scan EVERY CPQ node window-by-window so
  // the scan-tail bug vanishes, then page the OUTPUT `dependencies` list — so
  // `limit` is now an OUTPUT page size and `truncated` is an OUTPUT-truncation
  // signal. (A borderline org that hit exactly `limit` nodes of a CPQ type and
  // reported truncated:true under the old per-type cap now reports the honest
  // full scan; this is strictly more honest — see the design-check.)
  const scan = await scanAllNodesOfTypes(ctx.graph, CPQ_NODE_TYPES);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }
  const dependencies: CpqDependencyEntry[] = [];
  for (const node of scan.value.nodes) {
    for (const entry of dependencyEntriesForNode(node)) {
      dependencies.push(entry);
    }
  }
  const sortedDependencies = dependencies.sort(compareDependencies);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers `cpqComponentId` so a full-scan token can't replay
  // against a single-component call and vice versa (full-scan mints it absent;
  // single-component never mints one).
  const fingerprint = argsFingerprint({});
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: CPQ_DEPENDENCY_MAP_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(sortedDependencies, {
    offset,
    limit,
    keyOf: (d) => `${d.fromComponentId}|${d.referencedFieldToken}`,
    binding: {
      tool: CPQ_DEPENDENCY_MAP_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const pageDeps = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  const isPaged = truncated || offset > 0;

  // Presence: any scanned CPQ node proves CPQ is here; on a ZERO-node scan,
  // fall back to the InstalledPackage:SBQQ signal so an empty map is never
  // silently read as "installed CPQ has no dependencies".
  let cpqPresent = scan.value.nodes.length > 0;
  if (!cpqPresent) {
    const pkg = await cpqPackageInstalled(ctx);
    if (!pkg.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${pkg.error}` });
    }
    cpqPresent = pkg.value;
  }

  const scanNote = scan.value.scanIncomplete
    ? ` ${scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit())}`
    : '';
  const absenceNote = cpqPresent ? '' : ` ${CPQ_ABSENT_DISCLOSURE}`;
  const disclosure = `${DEPENDENCY_MAP_DISCLOSURE}${scanNote}${absenceNote}`;

  return ok({
    data: {
      cpqPresent,
      scannedComponentCount: scan.value.nodes.length,
      dependencies: pageDeps,
      truncated,
      disclosure,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + pageDeps.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
