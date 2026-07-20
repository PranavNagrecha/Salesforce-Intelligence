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
 *   - When `targetClass` (a PRODUCTION class id/name, or one of the
 *     `componentId`/`classApiName`/`targetId` host aliases) is supplied, the
 *     tool answers "which tests meaningfully cover class X?": it resolves the
 *     target's covering test classes (inbound `callsApex` from `isTest`
 *     classes) and scores THOSE. Previously such target ids were silently
 *     Zod-stripped and the caller got the org-wide leaderboard
 *     (MEANINGFUL-TEST-AUDIT-SILENTLY-IGNORES-TARGET). `appliedScope` always
 *     echoes which scope ran so a target is never silently ignored.
 *   - When `classFilter` is supplied, the scan narrows to the named
 *     ApexClass ids (unknown / non-test ids are silently dropped).
 *   - When `qualityIssues` is absent the v2.1 R2 recognizer pass has
 *     not run; the report still emits per-test entries with
 *     `fakeAssertionCount: 0` and the disclosure clarifies the gap.
 *   - Pagination: scans the FULL ApexClass set by paging
 *     `listNodesByType(ApexClass)` to exhaustion (not just the first
 *     500), so the ranking and `totalTestClassCount` cover every test
 *     class — a test sorted past row 500 used to be silently dropped
 *     from both. `countNodesByType` is the loop's belt cross-check.
 */

import type {
  ComponentId,
  ComponentType,
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

import { coercePrefix } from './coerce-id.js';
import { mergeInputAliases } from './input-aliases.js';
import { nodeScanLimit } from './scan-cap.js';

/**
 * Hard ceiling on a single `listNodesByType` page. `nodeScanLimit()` is
 * env-overridable (`SFI_NODE_SCAN_LIMIT`) so a test can drive the multi-page
 * offset loop without seeding 500+ nodes, but the graph layer rejects
 * `limit > 500` — so every page request is clamped here.
 */
const PAGE_CAP = 500;
const pageSize = (): number => Math.min(nodeScanLimit(), PAGE_CAP);

/**
 * Load EVERY ApexClass node, not just the first page. A single
 * `listNodesByType` page caps at 500 (id ASC), so an org with > 500 classes
 * used to drop the tail — a test class sorted past the cap vanished from the
 * ranking and from `totalTestClassCount`. Page by `pageSize()` accumulating
 * until a short page proves the type is exhausted, with `countNodesByType` as a
 * belt cross-check so a page that unexpectedly returns full cannot loop forever.
 * The common case (org under the cap) runs exactly one sub-cap page —
 * byte-identical.
 */
const loadAllNodes = async (
  ctx: Context,
  type: ComponentType,
): Promise<Result<readonly Node[], string>> => {
  const total = await countNodesByType(ctx.graph, type);
  if (!total.ok) return err(total.error.message);
  const limit = pageSize();
  const all: Node[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await listNodesByType(ctx.graph, type, { limit, offset });
    if (!page.ok) return err(page.error.message);
    all.push(...page.value);
    if (page.value.length < limit || all.length >= total.value) break;
  }
  return ok(all);
};

/** Canonical id prefix every `classFilter` entry must carry. */
const APEX_CLASS_PREFIX = 'ApexClass:';

/** Inclusive upper bound on the number of `classFilter` ids the input accepts. */
const CLASS_FILTER_MAX = 500;

/** Verbatim v2.7 honesty disclosure. */
const MEANINGFUL_TEST_DISCLOSURE =
  'v2.7 meaningful_test_audit ranks test classes by the v2.1 R2 fake-assertion recognizer output and an assertions-per-KB density heuristic. assertionCount counts both System.assert* and the modern Assert.* class; the fake-assertion recognizer that flags meaningless asserts is still scoped to System.assertEquals shapes, and assertions via helper methods (MyTestHelper.assertField) and framework wrappers are invisible to both. A test class with a high fakeAssertionCount may have meaningful tests via a custom assertion helper the recognizer cannot see. When qualityIssues is absent the v2.1 R2 pass has not run for this vault; entries surface with fakeAssertionCount: 0 and the rank is driven by density alone.';

/** Canonical id prefix used to coerce a bare production-class name. */
const TARGET_CLASS_PREFIX = 'ApexClass:';

/**
 * Zod schema for the `sfi.meaningful_test_audit` tool input.
 *
 *   - `classFilter`: optional array of `ApexClass:` canonical ids naming the
 *     TEST classes to score. When omitted (and no `targetClass`), every
 *     ApexClass with `properties.isTest === true` is audited.
 *   - `targetClass`: optional PRODUCTION class (id or bare api name). When
 *     supplied, the tool resolves that class's covering TEST classes (inbound
 *     `callsApex` from `isTest` classes — the same graph `sfi.apex_test_coverage`
 *     uses) and scores THOSE for fake assertions. This is the "which tests
 *     meaningfully cover class X?" question. The common host aliases
 *     (`componentId` / `classApiName` / `targetId` / `targetClassId` /
 *     `apexClass`) are merged into `targetClass` in a preprocess step so a
 *     production-class id is no longer silently stripped
 *     (MEANINGFUL-TEST-AUDIT-SILENTLY-IGNORES-TARGET). `targetClass` and
 *     `classFilter` are mutually exclusive.
 *   - `nameContains`: optional case-insensitive SUBSTRING on the test class's
 *     api name. Narrows the org-wide audit to the test classes whose name
 *     contains the needle (e.g. `nameContains: "CourseEmail"`). Previously such
 *     a name filter was Zod-stripped and the caller got the full org-wide
 *     leaderboard (MEANINGFUL-TEST-AUDIT-NAMECONTAINS-SILENT-ORGWIDE); now it
 *     scopes the scan, echoes `appliedScope: { mode: 'name-filter' }`, and a
 *     needle matching nothing returns an honest empty list — never the full
 *     roster. Mutually exclusive with both `classFilter` (explicit ids) and
 *     `targetClass` (covering-tests mode).
 */
const meaningfulTestAuditInputBaseSchema = z.object({
  classFilter: z.array(z.string().min(1)).max(CLASS_FILTER_MAX).optional(),
  targetClass: z.string().min(1).optional(),
  nameContains: z.string().min(1).optional(),
});

export const meaningfulTestAuditInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [
      {
        canonical: 'targetClass',
        aliases: [
          'componentId',
          'classApiName',
          'targetId',
          'targetClassId',
          'apexClass',
        ],
      },
    ]),
  meaningfulTestAuditInputBaseSchema,
);

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

/**
 * Echo of the scope the tool actually applied, so the host can never mistake a
 * covering-tests answer (or an honest empty one) for an org-wide leaderboard.
 *   - `org-wide`: every `isTest` class was scored.
 *   - `class-filter`: only the caller's `classFilter` test-class ids were scored.
 *   - `name-filter`: only the `isTest` classes whose api name contains the
 *     case-insensitive `nameContains` needle were scored (a needle matching
 *     nothing yields an empty list, never the org-wide roster).
 *   - `covering-tests`: the caller named a PRODUCTION `targetClass`; the scored
 *     tests are that class's covering tests (inbound `callsApex`), and
 *     `coveringTestCount` is how many were found (0 = no static test references).
 */
export type MeaningfulTestAuditScope =
  | { readonly mode: 'org-wide' }
  | { readonly mode: 'class-filter'; readonly testClassFilter: readonly ComponentId[] }
  | { readonly mode: 'name-filter'; readonly nameContains: string }
  | {
      readonly mode: 'covering-tests';
      readonly targetClassId: ComponentId;
      readonly coveringTestCount: number;
    };

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface MeaningfulTestAuditOutput {
  readonly totalTestClassCount: number;
  readonly tests: readonly MeaningfulTestEntry[];
  /** The scope actually applied — always present so the target is never silently ignored. */
  readonly appliedScope: MeaningfulTestAuditScope;
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

  // `targetClass` (production class → score its covering tests) and
  // `classFilter` (explicit test-class ids to score) are two different scope
  // axes. Supplying both is ambiguous — refuse rather than silently pick one.
  if (
    input.targetClass !== undefined &&
    input.classFilter !== undefined &&
    input.classFilter.length > 0
  ) {
    return err({
      kind: 'invalid-query',
      message:
        'Provide either `targetClass` (a production class whose covering tests to score) OR `classFilter` (specific test-class ids to score), not both.',
      path: 'targetClass',
    });
  }

  // `nameContains` is a third scope axis (a substring over test-class names). It
  // narrows the SAME org-wide scan `classFilter` narrows by explicit id, and is
  // orthogonal to the covering-tests answer `targetClass` gives — combining
  // either pair is ambiguous, so refuse rather than silently pick one
  // (MEANINGFUL-TEST-AUDIT-NAMECONTAINS-SILENT-ORGWIDE).
  if (input.nameContains !== undefined && input.targetClass !== undefined) {
    return err({
      kind: 'invalid-query',
      message:
        'Provide either `nameContains` (a test-class name substring) OR `targetClass` (a production class whose covering tests to score), not both.',
      path: 'nameContains',
    });
  }
  if (
    input.nameContains !== undefined &&
    input.classFilter !== undefined &&
    input.classFilter.length > 0
  ) {
    return err({
      kind: 'invalid-query',
      message:
        'Provide either `nameContains` (a test-class name substring) OR `classFilter` (specific test-class ids to score), not both.',
      path: 'nameContains',
    });
  }

  // Production-target mode: the "which tests meaningfully cover class X?"
  // question. Resolve the target's covering tests and score THOSE, never the
  // org-wide leaderboard. This is the fix for the silent-strip bug — a
  // production-class id passed as componentId/classApiName/targetId now scopes
  // the audit instead of being dropped.
  if (input.targetClass !== undefined) {
    return coveringTestsMode(ctx, input.targetClass);
  }

  const classesRes = await loadAllNodes(ctx, 'ApexClass');
  if (!classesRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${classesRes.error}`,
    });
  }

  // Filter to test classes; optionally narrow by classFilter (explicit ids) or
  // nameContains (case-insensitive substring on the api name). The two are
  // mutually exclusive (refused above), so at most one filter is active.
  const filterSet =
    input.classFilter !== undefined && input.classFilter.length > 0
      ? new Set<string>(input.classFilter)
      : null;
  const nameNeedle =
    input.nameContains !== undefined ? input.nameContains.toLowerCase() : null;

  const candidates: Node[] = [];
  for (const node of classesRes.value) {
    if (!isTestClass(node)) continue;
    if (filterSet !== null && !filterSet.has(node.id)) continue;
    if (nameNeedle !== null && !node.apiName.toLowerCase().includes(nameNeedle)) {
      continue;
    }
    candidates.push(node);
  }

  const entries = candidates.map(buildEntry);
  entries.sort(compareEntries);

  const appliedScope: MeaningfulTestAuditScope =
    filterSet !== null
      ? { mode: 'class-filter', testClassFilter: [...filterSet] as ComponentId[] }
      : nameNeedle !== null
        ? { mode: 'name-filter', nameContains: input.nameContains as string }
        : { mode: 'org-wide' };

  return ok({
    data: {
      totalTestClassCount: entries.length,
      tests: entries,
      appliedScope,
      disclosure: MEANINGFUL_TEST_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/**
 * Production-target mode. Resolve the covering TEST classes of `rawTarget`
 * (inbound `callsApex` from `isTest` classes — mirrors
 * `sfi.apex_test_coverage`'s single-class walk) and score THOSE for fake
 * assertions. A target with no covering tests returns an honest empty list with
 * `coveringTestCount: 0`, NOT the org-wide ranking.
 */
const coveringTestsMode = async (
  ctx: Context,
  rawTarget: string,
): Promise<Result<McpResponse<MeaningfulTestAuditOutput>, McpError>> => {
  const targetId = coercePrefix(rawTarget, [TARGET_CLASS_PREFIX]);
  if (!targetId.startsWith(TARGET_CLASS_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `targetClass must be an '${TARGET_CLASS_PREFIX}' id or a bare Apex class name; got '${rawTarget}'`,
      path: 'targetClass',
    });
  }

  const targetNode = await getNodeById(ctx.graph, targetId);
  if (!targetNode.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${targetNode.error.message}`,
    });
  }
  if (targetNode.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no ApexClass matches \`${targetId}\` in this vault`,
      path: 'targetClass',
    });
  }

  // Covering tests = inbound `callsApex` sources that are themselves test
  // classes. The edge PK admits the same (test→target) pair from two extraction
  // sources, so dedupe by fromId.
  const inbound = await listEdges(ctx.graph, targetId, {
    direction: 'in',
    edgeType: 'callsApex',
  });
  if (!inbound.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${inbound.error.message}`,
    });
  }

  const seen = new Set<ComponentId>();
  const coveringNodes: Node[] = [];
  for (const edge of inbound.value) {
    if (seen.has(edge.fromId)) continue;
    seen.add(edge.fromId);
    const src = await getNodeById(ctx.graph, edge.fromId);
    if (!src.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${src.error.message}`,
      });
    }
    // Only a TEST caller counts as a covering test; a non-test class that
    // references the target is not coverage.
    if (src.value !== null && isTestClass(src.value)) coveringNodes.push(src.value);
  }

  const entries = coveringNodes.map(buildEntry);
  entries.sort(compareEntries);

  return ok({
    data: {
      totalTestClassCount: entries.length,
      tests: entries,
      appliedScope: {
        mode: 'covering-tests',
        targetClassId: targetId as ComponentId,
        coveringTestCount: entries.length,
      },
      disclosure: MEANINGFUL_TEST_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
