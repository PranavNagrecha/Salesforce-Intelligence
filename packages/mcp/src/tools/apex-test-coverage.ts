/**
 * Handler for the `sfi.apex_test_coverage` MCP tool.
 *
 * The developer-facing "is this tested?" tool. Maps `callsApex` references
 * FROM test classes (`properties.isTest === true`) TO the non-test ApexClasses
 * they exercise, answering two shapes of question:
 *
 *   - `classApiName` given → which test classes statically reference this
 *     class (its "covering" tests), and whether any exist.
 *   - omitted → the org-wide list of non-test ApexClasses with NO incoming
 *     reference from any test class (the untested-class backlog that blocks
 *     the Salesforce 75%-coverage deploy gate).
 *
 * **Honesty axis** (load-bearing): this is STATIC reference coverage, NOT
 * runtime line coverage %. A test that references a class does not necessarily
 * exercise all of its lines, and dynamic invocation (`Type.forName`, mock
 * frameworks, indirect calls) is invisible to the v1.x scanner. Read a
 * "covered" result as "a test references this", and an "untested" result as
 * "no static test reference found — verify before assuming zero coverage".
 * The authoritative number comes from running the org's Apex tests.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Graph-layer page cap; documented honesty boundary if an org exceeds it. */
const APEX_PAGE_SIZE = 500;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Zod schema for the `sfi.apex_test_coverage` tool input.
 *
 * `apexClass` is accepted as an explicit alias for `classApiName`: sibling
 * Apex tools name this parameter differently, and because `classApiName` is
 * OPTIONAL (omitting it selects org-wide mode), a caller who passed the wrong
 * key used to have it silently stripped and get the whole-org backlog instead
 * of the single class they asked about. Naming the alias here makes
 * `{ apexClass: 'Foo' }` resolve to single-class mode (see the handler's
 * coalesce) rather than answering a different question with no error.
 */
export const apexTestCoverageInputSchema = z.object({
  classApiName: z.string().min(1).optional(),
  apexClass: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export type ApexTestCoverageInput = z.infer<typeof apexTestCoverageInputSchema>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ApexTestCoverageOutput {
  readonly mode: 'single-class' | 'org-wide';
  /** Present in single-class mode. */
  readonly target?: {
    readonly classApiName: string;
    readonly coveringTests: readonly ComponentId[];
    readonly status: 'has-test-references' | 'no-test-references-found';
  };
  /** Present in org-wide mode: non-test classes with no incoming test reference (capped at `limit`). */
  readonly untestedClasses?: readonly ComponentId[];
  readonly summary: {
    readonly testClasses: number;
    readonly nonTestClasses: number;
    readonly classesWithTestReferences: number;
    readonly classesWithoutTestReferences: number;
    readonly truncated: boolean;
  };
  readonly boundaries: readonly string[];
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'STATIC reference coverage, NOT runtime line-coverage %. A test referencing a class does not prove it exercises every line; the authoritative number comes from running the org Apex tests.',
  'Dynamic invocation (Type.forName, mocking frameworks, indirect dispatch) is invisible to the v1.x scanner, so a class shown as untested may still be covered at runtime — verify before assuming zero coverage.',
  'A test class is identified by `properties.isTest === true` (set by the extractor); managed-package and SeeAllData tests are out of scope.',
]);

const isTest = (n: Node): boolean => n.properties['isTest'] === true;

/**
 * Build a map from non-test ApexClass id → set of test-class ids that emit a
 * `callsApex` edge into it. One outgoing-edge query per test class.
 */
const buildCoverage = async (
  ctx: Context,
  tests: readonly Node[],
  nonTestIds: ReadonlySet<ComponentId>,
): Promise<Result<Map<ComponentId, Set<ComponentId>>, string>> => {
  const coverage = new Map<ComponentId, Set<ComponentId>>();
  for (const test of tests) {
    const r = await listEdges(ctx.graph, test.id, { direction: 'out', edgeType: 'callsApex' });
    if (!r.ok) return err(r.error.message);
    for (const edge of r.value) {
      if (!nonTestIds.has(edge.toId)) continue;
      let set = coverage.get(edge.toId);
      if (set === undefined) {
        set = new Set<ComponentId>();
        coverage.set(edge.toId, set);
      }
      set.add(test.id);
    }
  }
  return ok(coverage);
};

/**
 * The `sfi.apex_test_coverage` MCP tool. See the module JSDoc for the two
 * query shapes and the static-vs-runtime honesty axis.
 *
 * @example
 *   const r = await apexTestCoverageHandler(ctx, { classApiName: 'CaseService' });
 *   if (r.ok) console.log(r.value.data.target?.coveringTests);
 */
export const apexTestCoverageHandler = async (
  ctx: Context,
  input: ApexTestCoverageInput,
): Promise<Result<McpResponse<ApexTestCoverageOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;
  // Accept `apexClass` as an alias for `classApiName` so a wrong-but-plausible
  // key selects the single class instead of silently dropping to org-wide mode.
  const requestedClass = input.classApiName ?? input.apexClass;

  const nodesResult = await listNodesByType(ctx.graph, 'ApexClass', { limit: APEX_PAGE_SIZE });
  if (!nodesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodesResult.error.message}` });
  }
  const all = nodesResult.value;
  const tests = all.filter(isTest);
  const nonTests = all.filter((n) => !isTest(n));
  const nonTestIds = new Set<ComponentId>(nonTests.map((n) => n.id));

  const coverageResult = await buildCoverage(ctx, tests, nonTestIds);
  if (!coverageResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${coverageResult.error}` });
  }
  const coverage = coverageResult.value;

  const classesWithRefs = [...nonTestIds].filter((id) => (coverage.get(id)?.size ?? 0) > 0);
  const classesWithoutRefs = [...nonTestIds].filter((id) => (coverage.get(id)?.size ?? 0) === 0);
  const scanTruncated = all.length >= APEX_PAGE_SIZE;

  const summary = {
    testClasses: tests.length,
    nonTestClasses: nonTests.length,
    classesWithTestReferences: classesWithRefs.length,
    classesWithoutTestReferences: classesWithoutRefs.length,
    truncated: scanTruncated,
  };

  // Single-class mode.
  if (requestedClass !== undefined) {
    const targetId: ComponentId = `ApexClass:${requestedClass}`;
    const node = await getNodeById(ctx.graph, targetId);
    if (!node.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${node.error.message}` });
    }
    if (node.value === null) {
      return err({
        kind: 'component-not-found',
        message: `no ApexClass matches \`${targetId}\` in this vault`,
        path: targetId,
      });
    }
    const coveringTests = [...(coverage.get(targetId) ?? new Set<ComponentId>())].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return ok({
      data: {
        mode: 'single-class',
        target: {
          classApiName: requestedClass,
          coveringTests,
          status: coveringTests.length > 0 ? 'has-test-references' : 'no-test-references-found',
        },
        summary,
        boundaries: BOUNDARIES,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // Org-wide mode: the untested-class backlog.
  const untestedClasses = [...classesWithoutRefs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit);
  return ok({
    data: {
      mode: 'org-wide',
      untestedClasses,
      summary: { ...summary, truncated: scanTruncated || classesWithoutRefs.length > limit },
      boundaries: BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
