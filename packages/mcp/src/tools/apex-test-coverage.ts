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
import {
  countNodesByType,
  getNodeById,
  listEdges,
  listNodesByType,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { nodeScanLimit } from './scan-cap.js';

/**
 * Hard ceiling on a single `listNodesByType` page. `nodeScanLimit()` is
 * env-overridable (`SFI_NODE_SCAN_LIMIT`) so a test can drive the multi-page
 * offset loop without seeding 500+ nodes, but it does NOT clamp at 500, and the
 * graph layer rejects `limit > 500` — so every page request is clamped here.
 */
const PAGE_CAP = 500;
const pageSize = (): number => Math.min(nodeScanLimit(), PAGE_CAP);
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
 * Load EVERY ApexClass node, not just the first page. `listNodesByType` caps a
 * single page at 500 (id ASC), so an org with > 500 classes used to drop the
 * tail — and a covering test sorted past the cap looked like it didn't exist,
 * turning the deploy-gate verdict into a false "untested" (the H6 false
 * negative). Page by `pageSize()` accumulating until a short page proves the
 * type is exhausted, with `countNodesByType` as a belt cross-check. The common
 * case (org under the cap) runs exactly one sub-cap page — byte-identical.
 */
const loadAllApexClasses = async (
  ctx: Context,
): Promise<Result<readonly Node[], string>> => {
  const total = await countNodesByType(ctx.graph, 'ApexClass');
  if (!total.ok) return err(total.error.message);
  const limit = pageSize();
  const all: Node[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await listNodesByType(ctx.graph, 'ApexClass', { limit, offset });
    if (!page.ok) return err(page.error.message);
    all.push(...page.value);
    // Primary guard: a short page means the type is exhausted (id-ASC order
    // guarantees forward progress). Count is a belt cross-check so a page that
    // unexpectedly returns full cannot loop forever.
    if (page.value.length < limit || all.length >= total.value) break;
  }
  return ok(all);
};

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

  // Single-class mode: a bounded "does ANY test reference this class?" check via
  // the UNCAPPED inbound `callsApex` edges of the one target. This never loads
  // the roster and never depends on a capped scan, so the verdict is exact even
  // when a covering test sorts past row 500 — removing the H6 false negative by
  // construction (no truncated-scan / indeterminate state needed).
  if (requestedClass !== undefined) {
    return singleClass(ctx, requestedClass);
  }

  // Org-wide mode: load EVERY ApexClass (not just the first page) so the
  // untested-class backlog and counts cover the full org.
  const rosterResult = await loadAllApexClasses(ctx);
  if (!rosterResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${rosterResult.error}` });
  }
  const all = rosterResult.value;
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

  // The offset loop exhausts the ApexClass type, so the SCAN dimension is
  // honestly complete; the only remaining truncation is the explicit,
  // caller-controlled `limit` slice on the output list below.
  const untestedClasses = [...classesWithoutRefs]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit);
  return ok({
    data: {
      mode: 'org-wide',
      untestedClasses,
      summary: {
        testClasses: tests.length,
        nonTestClasses: nonTests.length,
        classesWithTestReferences: classesWithRefs.length,
        classesWithoutTestReferences: classesWithoutRefs.length,
        truncated: classesWithoutRefs.length > limit,
      },
      boundaries: BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/**
 * Resolve the single-class verdict from the target's UNCAPPED inbound
 * `callsApex` edges, keeping only sources that are themselves test classes
 * (`isTest === true`). Bounded by one class's in-degree, so it is genuinely
 * exhaustive and never off a truncated scan.
 *
 * Mirrors the old per-target Set semantics: the edge PK
 * (from_id, to_id, edge_type, source) permits the SAME test→target pair from
 * two extraction sources (e.g. declared vs the heuristic scanner) as two rows,
 * so fromIds are deduped into a Set before being listed — a covering test
 * appears exactly once.
 */
const singleClass = async (
  ctx: Context,
  requestedClass: string,
): Promise<Result<McpResponse<ApexTestCoverageOutput>, McpError>> => {
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

  const inbound = await listEdges(ctx.graph, targetId, { direction: 'in', edgeType: 'callsApex' });
  if (!inbound.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${inbound.error.message}` });
  }

  const covering = new Set<ComponentId>();
  for (const edge of inbound.value) {
    if (covering.has(edge.fromId)) continue;
    const source = await getNodeById(ctx.graph, edge.fromId);
    if (!source.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${source.error.message}` });
    }
    // Inbound `callsApex` includes regular (non-test) callers; only a test
    // caller counts as a covering test, else a non-test class that calls the
    // target would be miscounted as coverage (a false positive).
    if (source.value !== null && isTest(source.value)) covering.add(edge.fromId);
  }
  const coveringTests = [...covering].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return ok({
    data: {
      mode: 'single-class',
      target: {
        classApiName: requestedClass,
        coveringTests,
        status: coveringTests.length > 0 ? 'has-test-references' : 'no-test-references-found',
      },
      summary: {
        testClasses: 0,
        nonTestClasses: 0,
        classesWithTestReferences: coveringTests.length > 0 ? 1 : 0,
        classesWithoutTestReferences: coveringTests.length > 0 ? 0 : 1,
        truncated: false,
      },
      boundaries: BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
