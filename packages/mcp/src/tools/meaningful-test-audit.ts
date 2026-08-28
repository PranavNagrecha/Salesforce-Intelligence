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
 *   - When `classFilter` is supplied, the named ApexClass ids are resolved by
 *     DIRECT id lookup (`listNodesByIds`, the batched `getNodeById`), NOT by
 *     membership in the org-wide walk — so existence is never a function of
 *     that walk's residual ceiling and a real class sorting past the ceiling is
 *     never refused as absent. An id with NO ApexClass row at all (typo, wrong
 *     case, or never retrieved) is refused as `invalid-query` rather than
 *     silently dropped — the same "refuse an unresolvable scope, never silently
 *     widen or empty it" posture `resolveExistingObjectScope` codifies for
 *     object scopes. An id that DOES resolve to an ApexClass but is not
 *     `isTest` is still narrowed out silently (the caller named a real,
 *     non-test class on purpose).
 *   - When `qualityIssues` is absent the v2.1 R2 recognizer pass has
 *     not run; the report still emits per-test entries with
 *     `fakeAssertionCount: 0` and the disclosure clarifies the gap.
 *   - Pagination: the org-wide and `nameContains` scopes scan the FULL
 *     ApexClass set via the shared `scanAllNodesOfTypes` multi-window walk
 *     (not just the first 500), so the ranking and `totalTestClassCount`
 *     cover every test class — a test sorted past row 500 used to be silently
 *     dropped from both. A pathological ApexClass count past the walk's
 *     residual ceiling discloses `scanIncomplete` via `fullScanTruncationNote`
 *     instead of scanning unbounded with no way to say so. The `classFilter`
 *     scope does not run that walk at all (it resolves ids directly), so its
 *     answer is complete and carries no truncation note.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByIds } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { mergeInputAliases } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { FULL_SCAN_MAX_NODES, fullScanTruncationNote } from './scan-cap.js';

/**
 * Residual ceiling on the full ApexClass multi-window walk. Defaults to the
 * house-wide {@link FULL_SCAN_MAX_NODES}; `SFI_MEANINGFUL_TEST_SCAN_MAX`
 * overrides it so a test can exercise the truncated-disclosure path without
 * seeding 20 000 nodes. Mirrors `history_tracking_gaps`'s
 * `historyScanCeiling` / `flow_fault_audit`'s `SFI_FLOW_FAULT_SCAN_MAX`.
 */
const meaningfulTestScanCeiling = (): number => {
  const v = Number(process.env['SFI_MEANINGFUL_TEST_SCAN_MAX']);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : FULL_SCAN_MAX_NODES;
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

/** Tool name the CR-22 continuation cursor is bound to. */
const MEANINGFUL_TEST_AUDIT_TOOL = 'sfi.meaningful_test_audit';

/** Inclusive upper bound on `limit`. Mirrors the enumeration-style tools. */
const MEANINGFUL_TEST_MAX_LIMIT = 500;

/**
 * Default `limit`. Deliberately at the max: this is a PRE-EMPTIVE resume knob,
 * so an org under the cap must page exactly as it did before the knob existed
 * (one whole page, no paging fields emitted, byte-identical response).
 */
const MEANINGFUL_TEST_DEFAULT_LIMIT = MEANINGFUL_TEST_MAX_LIMIT;

/** Per-response byte budget for the `tests` page. Mirrors `test_coverage_gaps`. */
const MEANINGFUL_TEST_PAYLOAD_BUDGET_BYTES = 34_000;

/**
 * The verbatim paging disclosure, appended to `disclosure` ONLY on a paged
 * response. Product copy; do not reword.
 */
const pagingNote = (shown: number, total: number): string =>
  ` Showing ${shown} of ${total} test classes. totalTestClassCount is the FULL count; advance with the returned nextCursor.`;

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
  // CR-22 paging. Pre-emptive: today's corpus fits in one page, so a call that
  // omits all three is byte-identical to the pre-paging response. The knob
  // exists so the tail is reachable BEFORE an org needs it, rather than after
  // a silent drop is discovered in production.
  limit: z.number().int().min(1).max(MEANINGFUL_TEST_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
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
  /** FULL count of scored test classes, ALWAYS the whole set — never the page. */
  readonly totalTestClassCount: number;
  /** The PAGE of scored test classes (the whole set unless `truncated`). */
  readonly tests: readonly MeaningfulTestEntry[];
  /** The scope actually applied — always present so the target is never silently ignored. */
  readonly appliedScope: MeaningfulTestAuditScope;
  readonly disclosure: string;
  /**
   * True when this page does not reach the end of the ranking (cut by `limit`
   * OR by the byte budget). Emitted ONLY on a paged response, so an org whose
   * whole corpus fits stays byte-identical to the pre-paging shape.
   */
  readonly truncated?: boolean;
  /** Page size applied. Present only when paged. */
  readonly limit?: number;
  /** Zero-based offset of the first returned test class. Present only when paged. */
  readonly offset?: number;
  /** Offset to pass on the next call. Present only when `truncated`. */
  readonly nextOffset?: number;
  /** CR-22 opaque continuation token, present ONLY when this page is truncated. */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

/**
 * Slice one already-ranked list into a page and build the paging half of the
 * payload. Shared by the org-wide / filtered path and covering-tests mode so
 * the two can never drift. Emits NOTHING when the whole list fits and no
 * offset was requested — that is the byte-identity guarantee.
 *
 * The list MUST already be sorted to a TOTAL order (`compareEntries` ends on a
 * unique `testClassId` tiebreak), or an offset resume would skip / duplicate.
 */
const pageEntries = (
  ctx: Context,
  entries: readonly MeaningfulTestEntry[],
  input: Pick<
    MeaningfulTestAuditInput,
    'classFilter' | 'targetClass' | 'nameContains' | 'limit' | 'offset' | 'cursor'
  >,
): Result<
  {
    readonly page: readonly MeaningfulTestEntry[];
    readonly disclosure: string;
    readonly pagingFields: Readonly<Record<string, unknown>>;
  },
  McpError
> => {
  const limit = input.limit ?? MEANINGFUL_TEST_DEFAULT_LIMIT;
  // All three narrowing args are in the fingerprint, so a cursor minted in
  // org-wide / class-filter / name-filter / covering-tests mode cannot be
  // replayed in another. `limit`/`offset`/`cursor` are excluded by
  // `argsFingerprint` — a different PAGE of the same query is the point.
  const fingerprintArgs: Record<string, unknown> = {};
  if (input.classFilter !== undefined) fingerprintArgs['classFilter'] = input.classFilter;
  if (input.targetClass !== undefined) fingerprintArgs['targetClass'] = input.targetClass;
  if (input.nameContains !== undefined) fingerprintArgs['nameContains'] = input.nameContains;
  const fingerprint = argsFingerprint(fingerprintArgs);

  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: MEANINGFUL_TEST_AUDIT_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(entries, {
    offset,
    limit,
    byteBudget: MEANINGFUL_TEST_PAYLOAD_BUDGET_BYTES,
    keyOf: (e) => e.testClassId,
    binding: {
      tool: MEANINGFUL_TEST_AUDIT_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const truncated = paged.hasMore;
  const isPaged = truncated || offset > 0;
  return ok({
    page: paged.items,
    disclosure: isPaged
      ? `${MEANINGFUL_TEST_DISCLOSURE}${pagingNote(paged.items.length, entries.length)}`
      : MEANINGFUL_TEST_DISCLOSURE,
    pagingFields: {
      ...(isPaged ? { truncated, limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + paged.items.length } : {}),
      ...(paged.nextCursor !== null
        ? { nextCursor: paged.nextCursor, pageInfo: paged.pageInfo }
        : {}),
    },
  });
};

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
 * The candidate test classes a scope resolved to, plus the truncation note the
 * scope owes the caller (`null` when the scope answered completely).
 */
interface ScopedCandidates {
  readonly candidates: readonly Node[];
  readonly truncationNote: string | null;
}

/**
 * Resolve an explicit `classFilter` scope by DIRECT id lookup — the batched
 * `listNodesByIds` (the same absent-id null-skip `getNodeById` performs, in one
 * round-trip) — never by membership in the org-wide walk.
 *
 * MEANINGFUL-TEST-AUDIT-CLASSFILTER-REFUSES-PAST-CAP: deciding "does this id
 * exist?" from `scanAllNodesOfTypes`'s node set makes existence a function of
 * {@link meaningfulTestScanCeiling}. A real ApexClass sorting past that ceiling
 * would be refused as absent — a confident falsehood that additionally
 * prescribes `/sfi-refresh`, a remedy that can never fix it. An id lookup is
 * exact, is bounded by {@link CLASS_FILTER_MAX} ids, and is immune to the
 * ceiling; it also makes a class-filter answer COMPLETE, so this branch owes no
 * truncation note.
 *
 * MEANINGFUL-TEST-AUDIT-CLASSFILTER-SILENTLY-DROPS-UNRESOLVED: an id with no
 * ApexClass row at all (a typo, wrong case, or a class the refresh never
 * retrieved) can never contribute a row — refuse rather than let it silently
 * collapse into an honest-looking `totalTestClassCount: 0`. An id that DOES
 * resolve but is not `isTest` is narrowed out silently (the caller may be
 * intentionally naming a real production class).
 */
const classFilterCandidates = async (
  ctx: Context,
  filterSet: ReadonlySet<string>,
): Promise<Result<ScopedCandidates, McpError>> => {
  const filterIds = [...filterSet] as ComponentId[];
  const resolved = await listNodesByIds(ctx.graph, filterIds);
  if (!resolved.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${resolved.error.message}`,
    });
  }
  const resolvedIds = new Set(resolved.value.map((n) => n.id));
  const unresolved = filterIds.filter((id) => !resolvedIds.has(id));
  if (unresolved.length > 0) {
    return err({
      kind: 'invalid-query',
      message: `classFilter id(s) do not match any ApexClass in this vault: ${unresolved.map((id) => `'${id}'`).join(', ')} — verify the id (including case), or run /sfi-refresh if the vault may be stale`,
      path: 'classFilter',
    });
  }
  // `listNodesByIds` is unordered; sort by id ASC so ties in `compareEntries`
  // break the same way the org-wide walk's row order breaks them.
  const ordered = [...resolved.value].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return ok({
    candidates: ordered.filter((node) => isTestClass(node)),
    truncationNote: null,
  });
};

/**
 * Resolve the org-wide (or `nameContains`-narrowed) scope via the shared
 * {@link scanAllNodesOfTypes} multi-window walk, carrying its `scanIncomplete`
 * state out as a {@link fullScanTruncationNote} the caller appends to the
 * disclosure.
 */
const scannedCandidates = async (
  ctx: Context,
  nameNeedle: string | null,
): Promise<Result<ScopedCandidates, McpError>> => {
  const ceiling = meaningfulTestScanCeiling();
  const scan = await scanAllNodesOfTypes(ctx.graph, ['ApexClass'], ceiling);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }
  const candidates: Node[] = [];
  for (const node of scan.value.nodes) {
    if (!isTestClass(node)) continue;
    if (nameNeedle !== null && !node.apiName.toLowerCase().includes(nameNeedle)) {
      continue;
    }
    candidates.push(node);
  }
  return ok({
    candidates,
    truncationNote: scan.value.scanIncomplete
      ? fullScanTruncationNote(scan.value.incompleteTypes, ceiling)
      : null,
  });
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
    return coveringTestsMode(ctx, input.targetClass, input);
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

  const scoped =
    filterSet !== null
      ? await classFilterCandidates(ctx, filterSet)
      : await scannedCandidates(ctx, nameNeedle);
  if (!scoped.ok) return err(scoped.error);

  const entries = scoped.value.candidates.map(buildEntry);
  entries.sort(compareEntries);

  const appliedScope: MeaningfulTestAuditScope =
    filterSet !== null
      ? { mode: 'class-filter', testClassFilter: [...filterSet] as ComponentId[] }
      : nameNeedle !== null
        ? { mode: 'name-filter', nameContains: input.nameContains as string }
        : { mode: 'org-wide' };

  const paged = pageEntries(ctx, entries, input);
  if (!paged.ok) return err(paged.error);

  const disclosure =
    scoped.value.truncationNote !== null
      ? `${paged.value.disclosure} ${scoped.value.truncationNote}`
      : paged.value.disclosure;

  return ok({
    data: {
      // The FULL count, never the page — the paging note points back at it.
      totalTestClassCount: entries.length,
      tests: paged.value.page,
      appliedScope,
      disclosure,
      ...paged.value.pagingFields,
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
  input: MeaningfulTestAuditInput,
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

  const paged = pageEntries(ctx, entries, input);
  if (!paged.ok) return err(paged.error);

  return ok({
    data: {
      totalTestClassCount: entries.length,
      tests: paged.value.page,
      appliedScope: {
        mode: 'covering-tests',
        targetClassId: targetId as ComponentId,
        // The FULL covering-test count, not the page length.
        coveringTestCount: entries.length,
      },
      disclosure: paged.value.disclosure,
      ...paged.value.pagingFields,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
