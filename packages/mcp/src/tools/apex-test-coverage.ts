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
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const APEX_TEST_COVERAGE_TOOL = 'sfi.apex_test_coverage';

/**
 * Zod schema for the `sfi.apex_test_coverage` tool input.
 *
 * Every class-selector alias is accepted so a scoped question ("coverage for
 * CourseOfferingTriggerHelper?") reaches single-class mode no matter which key
 * the router / host supplies. `classApiName` / `apexClass` / `className` /
 * `apiName` take a bare name; `componentId` / `classId` / `apexClassId` take a
 * canonical `ApexClass:{name}` id (the `ApexClass:` prefix is stripped). Because
 * `classApiName` is OPTIONAL (omitting every selector selects org-wide mode), a
 * caller who passed one of the previously-unrecognised keys used to have it
 * Zod-stripped and get the whole-org backlog instead of the single class they
 * asked about. Naming the aliases here (plus the handler's coalesce) makes any
 * of them resolve to single-class mode rather than silently answering a
 * different question; a value carrying a non-`ApexClass:` type prefix is
 * `invalid-query`.
 */
export const apexTestCoverageInputSchema = z.object({
  classApiName: z.string().min(1).optional(),
  apexClass: z.string().min(1).optional(),
  className: z.string().min(1).optional(),
  apiName: z.string().min(1).optional(),
  /** Canonical `ApexClass:{name}` id (the router's shape); prefix is stripped. */
  componentId: z.string().min(1).optional(),
  classId: z.string().min(1).optional(),
  apexClassId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  // CR-22: page cursor for walking the full untested-class list (org-wide mode
  // only) when truncated. Single-class mode never paginates.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

export type ApexTestCoverageInput = z.infer<typeof apexTestCoverageInputSchema>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ApexTestCoverageOutput {
  readonly mode: 'single-class' | 'org-wide';
  /**
   * Echoes the scope ACTUALLY applied so a host never assumes a class selector
   * it passed was silently stripped (the org-wide-instead-of-single-class bug
   * this closes). `class` is the resolved bare class api name in single-class
   * mode, null in org-wide mode.
   */
  readonly appliedScope: {
    readonly class: string | null;
    readonly mode: 'single-class' | 'org-wide';
  };
  /** Present in single-class mode. */
  readonly target?: {
    readonly classApiName: string;
    readonly coveringTests: readonly ComponentId[];
    readonly status: 'has-test-references' | 'no-test-references-found';
  };
  /** Present in org-wide mode: non-test classes with no incoming test reference (capped at `limit`). */
  readonly untestedClasses?: readonly ComponentId[];
  readonly summary: {
    /**
     * Org-wide roster counts. `null` in single-class mode: the roster is
     * deliberately never loaded there (single-class mode answers off the
     * target's own uncapped inbound edges), so these are NOT-COMPUTED, not
     * zero — a hardcoded `0` here used to read as "this org has 0 test
     * classes" to a caller who only asked about one class. Real numbers only
     * in org-wide mode.
     */
    readonly testClasses: number | null;
    readonly nonTestClasses: number | null;
    readonly classesWithTestReferences: number;
    readonly classesWithoutTestReferences: number;
    readonly truncated: boolean;
  };
  readonly boundaries: readonly string[];
  /**
   * Page size applied to the org-wide `untestedClasses` list. Present ONLY on a
   * PAGED response (`truncated` or a resumed `offset > 0`); omitted on a
   * whole-fits no-cursor call so that response stays byte-identical to pre-CR-22.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned untested class. Present only when paged (see `limit`). */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when truncated. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when the org-wide page is
   * truncated. Echo it back as `cursor` to resume. Absent on a complete page so
   * an in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated org-wide page. */
  readonly pageInfo?: PageInfo;
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'STATIC reference coverage, NOT runtime line-coverage %. A test referencing a class does not prove it exercises every line; the authoritative number comes from running the org Apex tests.',
  'Dynamic invocation (Type.forName, mocking frameworks, indirect dispatch) is invisible to the v1.x scanner, so a class shown as untested may still be covered at runtime — verify before assuming zero coverage.',
  'A test class is identified by `properties.isTest === true` (set by the extractor); managed-package and SeeAllData tests are out of scope.',
]);

/**
 * Appended only to the single-class-mode boundary list. Single-class mode
 * deliberately never loads the org-wide roster (it answers off the target's
 * own uncapped inbound edges), so `summary.testClasses` /
 * `summary.nonTestClasses` are NOT-COMPUTED (`null`) here, not a real zero —
 * mirroring `profile-security.ts`'s `sessionSecuritySettings: null` for a
 * value it did not read. Call the tool with no class selector for the
 * real org-wide counts.
 */
const SINGLE_CLASS_ROSTER_NOT_COMPUTED_BOUNDARY =
  'summary.testClasses and summary.nonTestClasses are org-wide roster counts; they are `null` here (NOT a real 0) because single-class mode never loads the org-wide roster. Call sfi.apex_test_coverage with no class selector for the real org-wide counts.';

const SINGLE_CLASS_BOUNDARIES: readonly string[] = Object.freeze([
  ...BOUNDARIES,
  SINGLE_CLASS_ROSTER_NOT_COMPUTED_BOUNDARY,
]);

const APEX_CLASS_PREFIX = 'ApexClass:';

/**
 * Resolve the single class the caller scoped to from any of the class-selector
 * aliases. Precedence (highest first): `classApiName`, `apexClass`, `className`,
 * `apiName`, `componentId`, `classId`, `apexClassId` — so the pre-existing
 * `classApiName ?? apexClass` contract (classApiName wins) is preserved and the
 * new keys extend it. Bare names pass through; a `ApexClass:{name}` id has its
 * prefix stripped (keeping `singleClass`, which prepends it, correct); a value
 * carrying a NON-`ApexClass:` type prefix is `invalid-query` (never a silent
 * org-wide fallback). `undefined` (no selector) selects org-wide mode.
 */
const resolveRequestedClass = (
  input: ApexTestCoverageInput,
): Result<string | undefined, McpError> => {
  const raw =
    input.classApiName ??
    input.apexClass ??
    input.className ??
    input.apiName ??
    input.componentId ??
    input.classId ??
    input.apexClassId;
  if (raw === undefined) return ok(undefined);
  if (raw.startsWith(APEX_CLASS_PREFIX)) return ok(raw.slice(APEX_CLASS_PREFIX.length));
  if (raw.includes(':')) {
    return err({
      kind: 'invalid-query',
      message: `'${raw}' is not an ApexClass — pass a bare class api name or an 'ApexClass:{name}' id`,
      path: 'componentId',
    });
  }
  return ok(raw);
};

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
  // Accept every class-selector alias (bare name OR `ApexClass:{name}` id) so a
  // scoped question reaches single-class mode instead of silently dropping to
  // the org-wide backlog. A non-`ApexClass:` type prefix or disagreeing aliases
  // are `invalid-query`, never a silent org-wide fallback.
  const requestedResult = resolveRequestedClass(input);
  if (!requestedResult.ok) return requestedResult;
  const requestedClass = requestedResult.value;

  // Single-class mode: a bounded "does ANY test reference this class?" check via
  // the UNCAPPED inbound `callsApex` edges of the one target. This never loads
  // the roster and never depends on a capped scan, so the verdict is exact even
  // when a covering test sorts past row 500 — removing the H6 false negative by
  // construction (no truncated-scan / indeterminate state needed).
  if (requestedClass !== undefined) {
    return singleClass(ctx, requestedClass);
  }

  // Org-wide mode: load EVERY ApexClass (not just the first page) so the
  // untested-class backlog and counts cover the full org. `scanAllNodesOfTypes`
  // is the shared multi-window OFFSET walker (`scan-all-nodes.ts`) — adopting it
  // in place of a hand-rolled copy of the same loop also gains the
  // `FULL_SCAN_MAX_NODES` residual cap and the `scanIncomplete` disclosure
  // channel a bespoke loop had neither of.
  const rosterResult = await scanAllNodesOfTypes(ctx.graph, ['ApexClass']);
  if (!rosterResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${rosterResult.error.message}` });
  }
  const all = rosterResult.value.nodes;
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

  // The offset loop exhausts the ApexClass type (short of the
  // FULL_SCAN_MAX_NODES residual cap — see `scanIncomplete` below), so the SCAN
  // dimension is honestly complete in the normal case; the only remaining
  // truncation is the explicit, caller-controlled `limit` slice on the output
  // list below. `untestedClasses` is a list of UNIQUE ComponentIds (from
  // `nonTestIds`, a Set), so the id-ASC sort is already a STRICT TOTAL order —
  // no tiebreak needed for resume.
  const sortedUntested = [...classesWithoutRefs].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // Org-wide mode has NO narrowing arg (classApiName/apexClass select single-
  // class mode), so the fingerprint is a constant — the cursor stays bound to
  // tool + vaultHash. Mint a cursor ONLY in org-wide mode.
  const fingerprint = argsFingerprint({});
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: APEX_TEST_COVERAGE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(sortedUntested, {
    offset,
    limit,
    keyOf: (id) => id,
    binding: {
      tool: APEX_TEST_COVERAGE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const untestedClasses = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  const isPaged = truncated || offset > 0;

  // Residual full-scan cap (FULL_SCAN_MAX_NODES): false in the normal case
  // (the ApexClass type walked to exhaustion); true only for a pathological
  // org past the residual cap, in which case the roster counts below are an
  // honest under-count rather than a silent one.
  const boundaries = rosterResult.value.scanIncomplete
    ? [...BOUNDARIES, fullScanTruncationNote(rosterResult.value.incompleteTypes)]
    : BOUNDARIES;

  return ok({
    data: {
      mode: 'org-wide',
      appliedScope: { class: null, mode: 'org-wide' },
      untestedClasses,
      summary: {
        testClasses: tests.length,
        nonTestClasses: nonTests.length,
        classesWithTestReferences: classesWithRefs.length,
        classesWithoutTestReferences: classesWithoutRefs.length,
        truncated,
      },
      boundaries,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + untestedClasses.length } : {}),
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
      appliedScope: { class: requestedClass, mode: 'single-class' },
      target: {
        classApiName: requestedClass,
        coveringTests,
        status: coveringTests.length > 0 ? 'has-test-references' : 'no-test-references-found',
      },
      summary: {
        // NOT-COMPUTED, never a real zero: single-class mode deliberately
        // never loads the org-wide roster (see SINGLE_CLASS_ROSTER_NOT_COMPUTED_BOUNDARY).
        testClasses: null,
        nonTestClasses: null,
        classesWithTestReferences: coveringTests.length > 0 ? 1 : 0,
        classesWithoutTestReferences: coveringTests.length > 0 ? 0 : 1,
        truncated: false,
      },
      boundaries: SINGLE_CLASS_BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
