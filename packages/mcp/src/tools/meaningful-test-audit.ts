/**
 * Handler for the `sfi.meaningful_test_audit` MCP tool.
 *
 * Audits every ApexClass with `properties.isTest === true` for
 * assertion meaningfulness. Computes a heuristic per-test score from
 * the v2.1 `qualityIssues[]` mirror:
 *   - `assertionCount`: invocations of `System.assert*` and the modern
 *     `Assert.*` class recognised by the extraction pass (read from
 *     `properties.assertionCount` when present; 0 when absent).
 *   - `fakeAssertionCount`: number of `qualityIssues[]` entries whose
 *     `rule === 'fake-assertion'`.
 *   - `density`: `assertionCount / max(1, sourceBytes / 1000)` — a
 *     rough assertions-per-KB metric. When `sourceBytes` is absent,
 *     density is the raw `assertionCount` so tests still rank.
 *
 * The ranking sorts test classes by `fakeAssertionCount` DESC, then
 * by `density` ASC (low density = sparse asserts, suspicious). The
 * top-of-the-list test classes are the most likely candidates for a
 * meaningfulness audit.
 *
 * **Honesty axis (verbatim)**: `assertionCount` recognises `System.assert*`
 * and the modern `Assert.*` class against direct tokens; the separate
 * fake-assertion recognizer is still scoped to `System.assertEquals`
 * shapes, and helper methods (`MyTestHelper.assertField(record, ...)`) /
 * framework wrappers are invisible to both. A test class flagged with a
 * high fakeAssertionCount may have meaningful tests via a custom assertion
 * helper that the recognizer cannot see. Surfaced verbatim in the
 * `disclosure` field.
 *
 * Implementation notes:
 *   - When `classFilter` is supplied, the scan narrows to the named
 *     ApexClass ids (unknown / non-test ids are silently dropped).
 *   - When `qualityIssues` is absent the v2.1 R2 recognizer pass has
 *     not run; the report still emits per-test entries with
 *     `fakeAssertionCount: 0` and the disclosure clarifies the gap.
 *   - Pagination: scans the full ApexClass set via
 *     `listNodesByType(ApexClass, { limit: 500 })`; matches the
 *     v2.1 `test_coverage_gaps` page size.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Per-type cap matching `listNodesByType`'s default. */
const LIST_PAGE_SIZE = 500;

/** Canonical id prefix every `classFilter` entry must carry. */
const APEX_CLASS_PREFIX = 'ApexClass:';

/** Verbatim v2.7 honesty disclosure. */
const MEANINGFUL_TEST_DISCLOSURE =
  'v2.7 meaningful_test_audit ranks test classes by the v2.1 R2 fake-assertion recognizer output and an assertions-per-KB density heuristic. assertionCount counts both System.assert* and the modern Assert.* class; the fake-assertion recognizer that flags meaningless asserts is still scoped to System.assertEquals shapes, and assertions via helper methods (MyTestHelper.assertField) and framework wrappers are invisible to both. A test class with a high fakeAssertionCount may have meaningful tests via a custom assertion helper the recognizer cannot see. When qualityIssues is absent the v2.1 R2 pass has not run for this vault; entries surface with fakeAssertionCount: 0 and the rank is driven by density alone.';

/**
 * Zod schema for the `sfi.meaningful_test_audit` tool input.
 *
 *   - `classFilter`: optional array of `ApexClass:` canonical ids
 *     scoping the scan. When omitted, every ApexClass with
 *     `properties.isTest === true` is audited.
 */
export const meaningfulTestAuditInputSchema = z.object({
  classFilter: z.array(z.string().min(1)).max(LIST_PAGE_SIZE).optional(),
});

/** Parsed input shape. */
export type MeaningfulTestAuditInput = z.infer<
  typeof meaningfulTestAuditInputSchema
>;

/** One per-test-class report row. */
export interface MeaningfulTestEntry {
  readonly testClassId: ComponentId;
  readonly apiName: string;
  readonly assertionCount: number;
  readonly fakeAssertionCount: number;
  readonly sourceBytes: number;
  /** Heuristic assertion density per KB of source. */
  readonly density: number;
  /** Per-rule fake-assertion locations (sorted ASC) for follow-up triage. */
  readonly fakeAssertionLocations: readonly string[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface MeaningfulTestAuditOutput {
  readonly totalTestClassCount: number;
  readonly tests: readonly MeaningfulTestEntry[];
  readonly disclosure: string;
}

const isTestClass = (node: Node): boolean =>
  node.properties['isTest'] === true;

/**
 * Pull a non-negative integer property with `0` default. Used for
 * `assertionCount` and `sourceBytes`.
 */
const readNonNegativeInt = (node: Node, key: string): number => {
  const raw = node.properties[key];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return 0;
};

/**
 * Walk a node's `qualityIssues[]` array and return the locations of
 * every `fake-assertion` finding. Empty array when the array is
 * absent or contains no fake-assertion entries.
 */
const collectFakeAssertions = (node: Node): readonly string[] => {
  const raw = node.properties['qualityIssues'];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== 'object') continue;
    const obj = r as Record<string, unknown>;
    if (obj['rule'] !== 'fake-assertion') continue;
    const loc = obj['location'];
    if (typeof loc === 'string') out.push(loc);
  }
  return [...out].sort();
};

/**
 * Compute the per-class entry. Density uses sourceBytes / 1000 as the
 * denominator (rough KB approximation) with a `max(1, ...)` guard so
 * tiny classes don't divide by zero.
 */
const buildEntry = (node: Node): MeaningfulTestEntry => {
  const assertionCount = readNonNegativeInt(node, 'assertionCount');
  const sourceBytes = readNonNegativeInt(node, 'sourceBytes');
  const fakeLocs = collectFakeAssertions(node);
  const kb = Math.max(1, sourceBytes / 1000);
  const density = assertionCount / kb;
  return {
    testClassId: node.id,
    apiName: node.apiName,
    assertionCount,
    fakeAssertionCount: fakeLocs.length,
    sourceBytes,
    density,
    fakeAssertionLocations: fakeLocs,
  };
};

/**
 * Ranking comparator: fake count DESC (worst first), then density
 * ASC (sparse asserts surface higher), then id ASC for stable order.
 */
const compareEntries = (
  a: MeaningfulTestEntry,
  b: MeaningfulTestEntry,
): number => {
  if (a.fakeAssertionCount !== b.fakeAssertionCount) {
    return b.fakeAssertionCount - a.fakeAssertionCount;
  }
  if (a.density !== b.density) return a.density - b.density;
  return a.testClassId < b.testClassId
    ? -1
    : a.testClassId > b.testClassId
      ? 1
      : 0;
};

/**
 * The `sfi.meaningful_test_audit` MCP tool. Lists every test class
 * with a heuristic assertion-density score and ranks by
 * fake-assertion count DESC.
 *
 * @example
 *   const r = await meaningfulTestAuditHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.totalTestClassCount);
 */
export const meaningfulTestAuditHandler = async (
  ctx: Context,
  input: MeaningfulTestAuditInput,
): Promise<Result<McpResponse<MeaningfulTestAuditOutput>, McpError>> => {
  // Refuse `classFilter: []` up front. Per journal 0160's deep-smoke
  // finding, the empty-array case is ambiguous: did the caller mean
  // "no filter" (omit the field) or "filter to nothing" (a typo they
  // want to know about)? Surfacing it as `invalid-query` forces
  // explicit intent and matches the same refusal added to
  // `sfi.test_coverage_gaps` for consistency across the v2.x
  // test-quality tier. (Supersedes journal 0158's "by-design" note.)
  if (input.classFilter !== undefined && input.classFilter.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        'classFilter is an empty array; omit the field to scan all test classes, or supply at least one ApexClass: id',
      path: 'classFilter',
    });
  }

  // Refuse malformed classFilter ids up front. An id that doesn't
  // start with `ApexClass:` could never match a test class, and silently
  // returning an empty result let the caller treat the bad input as
  // "no findings" — surface the typo instead.
  if (input.classFilter !== undefined && input.classFilter.length > 0) {
    const malformed = input.classFilter.filter(
      (id) => !id.startsWith(APEX_CLASS_PREFIX),
    );
    if (malformed.length > 0) {
      return err({
        kind: 'invalid-query',
        message: `classFilter entries must start with '${APEX_CLASS_PREFIX}'; got malformed id(s): ${malformed.map((id) => `'${id}'`).join(', ')}`,
        path: 'classFilter',
      });
    }
  }

  const classesRes = await listNodesByType(ctx.graph, 'ApexClass', {
    limit: LIST_PAGE_SIZE,
  });
  if (!classesRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${classesRes.error.message}`,
    });
  }

  // Filter to test classes; optionally narrow by classFilter.
  const filterSet =
    input.classFilter !== undefined && input.classFilter.length > 0
      ? new Set<string>(input.classFilter)
      : null;

  const candidates: Node[] = [];
  for (const node of classesRes.value) {
    if (!isTestClass(node)) continue;
    if (filterSet !== null && !filterSet.has(node.id)) continue;
    candidates.push(node);
  }

  const entries = candidates.map(buildEntry);
  entries.sort(compareEntries);

  return ok({
    data: {
      totalTestClassCount: entries.length,
      tests: entries,
      disclosure: MEANINGFUL_TEST_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
