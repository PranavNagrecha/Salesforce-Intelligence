/**
 * Handler for the `sfi.find_field_anywhere` MCP tool.
 *
 * The v2.2 universal "find this field everywhere it's touched" surface —
 * the canonical Q86-style discovery question for a single field id.
 * Composes incoming edges of every code/declarative kind that
 * references a CustomField, groups them by the referrer's
 * `ComponentType`, and surfaces a structured cross-component-type
 * inventory: Apex reads/writes, Apex calls (when the field is an Apex
 * class), Flow record-lookup/create/update references, Layout
 * placements, formula references, ValidationRule references,
 * SharingRule criteria references, and any other declarative edge that
 * exists in the graph.
 *
 * **Composition recipe:** one
 * `listEdges(fieldId, { direction: 'in' })` call retrieves every
 * incoming edge regardless of type; the handler then walks each edge's
 * `fromId`, resolves the referrer to a `Node`, and emits one
 * `FieldReference` per (referrer, edgeType) pair. Sparse-graph misses
 * (the referrer node is not in the graph) are dropped silently.
 *
 * **Grouping axis:** results are bucketed by the referrer's
 * `ComponentType` — `ApexClass`, `ApexTrigger`, `Flow`, `Layout`,
 * `ValidationRule`, `SharingRule`, `WorkflowRule`, etc. The grouping is
 * the universal-search ergonomic: the consumer asks "where is this
 * field used?" and wants the answer split by KIND of usage, not by
 * individual referrer.
 *
 * **Edge-type axis within a group:** within each ComponentType bucket
 * the references retain their `edgeType` so a consumer rendering the
 * group can distinguish reads from writes (Apex `readsFrom` vs.
 * `writesTo`) or formula references from metadata references
 * (`references` edge with `source: 'formula-tokenizer'` vs.
 * `source: 'metadata-dependency'`).
 *
 * **v2.2 honesty axis:** the v0.3 / v1.4 / v2.1 string-stripping
 * discipline means dynamic SOQL strings, reflective field access
 * (`obj.get('FieldName')`), and managed-package code are INVISIBLE to
 * the graph edges this tool walks. The `boundaries` array surfaces the
 * verbatim "dynamic SOQL invisible" disclosure unconditionally when
 * any results are returned, mirroring `SemanticSearchSemantics.md`'s
 * per-tool disclosure catalog for `sfi.find_anywhere`.
 *
 * Implementation notes:
 *   - The CustomField id is `targetId` OR its alias `fieldId` (parity with
 *     the field-tool family); exactly one is required and must start with
 *     `CustomField:`. A missing id or non-CustomField prefix surfaces as
 *     `invalid-query` at the handler boundary.
 *   - EXISTENCE GATE: the prefix check alone let a typo, a WRONG-CASE id, and a
 *     never-retrieved field all return the same confident
 *     `{groups: [], totalCount: 0}` as a field that is genuinely referenced
 *     nowhere. An id that no node carries AND no edge references now surfaces
 *     as `component-not-found` with ranked `resolveSuggestions`
 *     (`fieldNotFoundError` + `phantomAwareNotFoundMessage` — the same pair the
 *     sibling field tools use). A PHANTOM id — referenced by real edges but
 *     whose own definition was never retrieved — still ANSWERS (those
 *     references are true) and carries a boundary saying the definition is
 *     absent and the folded report/dashboard flags could not be read.
 *   - The sort within each group is deterministic — `componentId ASC`,
 *     then `edgeType ASC`. The grouped output is sorted alphabetically
 *     by component-type label so the response is reproducible across
 *     runs.
 *   - `limit` caps the TOTAL match count across all groups, not the
 *     per-group count. The slice is applied AFTER the per-group sort
 *     so truncation is stable.
 *   - `confidence` on each reference is the edge's stored confidence
 *     (`declared` for layout / formula / parentOf-declared edges,
 *     `heuristic` for apex-scanner / lwc-scanner / flow-extractor
 *     edges). The tool does not re-classify; it surfaces what the
 *     extractor stored.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  EdgeType,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
  PageCursorToken,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { fieldNotFoundError } from './field-not-found-suggest.js';
import {
  argsFingerprint,
  decodeCursor,
  encodeCursor,
  PAGE_CURSOR_VERSION,
  paginateSection,
  type PageableSection,
  type SectionDisclosure,
} from './page-cursor.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import {
  REPORT_DASHBOARD_USAGE_CAVEAT,
  reportDashboardUsage,
} from './report-dashboard-usage.js';

/** Per-response byte budget for the designated section's page. */
const FIND_FIELD_ANYWHERE_BYTE_BUDGET = 38_000;

/** Canonical CustomField prefix. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';
/** Inclusive upper bound on `limit`. */
const FIND_FIELD_ANYWHERE_MAX_LIMIT = 500;
/** Default `limit`. */
const FIND_FIELD_ANYWHERE_DEFAULT_LIMIT = 200;

/** Verbatim honesty disclosures echoed in the response's `boundaries`. */
const STATIC_GRAPH_DISCLOSURE =
  "the search uses pattern-matching over Apex source, Flow XML, and metadata XML. Dynamic SOQL (`Database.query('SELECT...')`) is stripped before the pattern pass and is invisible. Reflective field access (`obj.get('FieldName')`) is invisible. Custom utility methods that wrap the operation you're searching for are invisible — the search finds calls to `Messaging.sendEmail` but not calls to `MyEmailHelper.send(...)` unless you also search for that helper.";
const MANAGED_PACKAGE_DISCLOSURE =
  'results from managed packages are limited to metadata XML; Apex source within managed packages is not indexed. If the operation lives inside a managed-package class, this search will not find it.';
/**
 * PHANTOM target: the id is referenced by real edges but no node carries it, so
 * the field's own definition was never retrieved. The reference list is still
 * true — refusing would throw away a real answer — but the folded
 * report/dashboard flags live on the ABSENT node and cannot be read at all, so
 * a plain "no report usage" caveat here would be a second confident zero.
 */
const phantomTargetDisclosure = (id: string): string =>
  `\`${id}\` is referenced by the component(s) listed above, but its OWN CustomField definition was never retrieved into this vault — typically a managed-package field, an uncustomized standard field the Metadata API does not emit, or one outside the retrieve scope. Treat the reference list as what the graph holds ABOUT the id, not as a complete picture of the field; the folded \`usedInReport\` / \`usedInDashboard\` flags live on the missing node and could NOT be read, so report/dashboard usage is UNKNOWN here rather than absent.`;

/**
 * Zod schema for the `sfi.find_field_anywhere` tool input.
 *
 *   - `targetId` (or its alias `fieldId`): exactly one required, a
 *     non-empty string starting with `CustomField:`; a missing id or a
 *     non-matching prefix surfaces as `invalid-query` at the handler
 *     boundary.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 200.
 *   - `componentTypes`: optional array filter — narrows the returned
 *     references to a subset of ComponentTypes (e.g., only Apex
 *     classes, only Flows). Omitted means "all".
 */
export const findFieldAnywhereInputSchema = z.object({
  // `targetId` is the canonical param. `fieldId` is accepted as an ALIAS for
  // parity with the rest of the field-tool family (field_360, field_access_audit,
  // field_lineage, safe_to_delete_field, … all take `fieldId`), so an agent that
  // learned `fieldId` there doesn't hit a confusing `targetId: Required`. Exactly
  // one of the two is required (enforced in the handler).
  targetId: z.string().min(1).optional(),
  fieldId: z.string().min(1).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(FIND_FIELD_ANYWHERE_MAX_LIMIT)
    .optional(),
  componentTypes: z.array(z.string().min(1)).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`; carries the resume offset + which
  // ComponentType section it advances. Omit = today's behavior.
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape. */
export type FindFieldAnywhereInput = z.infer<
  typeof findFieldAnywhereInputSchema
>;

/** One reference in the response. */
export interface FieldReference {
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly edgeType: EdgeType;
  readonly source: string;
  readonly confidence: ConfidenceLevel;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** A grouped bucket of references sharing one ComponentType. */
export interface ReferenceGroup {
  readonly componentType: ComponentType;
  readonly references: readonly FieldReference[];
  readonly count: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindFieldAnywhereOutput {
  readonly targetId: ComponentId;
  readonly groups: readonly ReferenceGroup[];
  readonly totalCount: number;
  readonly byEdgeType: Readonly<Record<string, number>>;
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
  /**
   * CR-22 opaque continuation token, present ONLY when truncated (the designated
   * ComponentType section overflowed `limit`/the byte budget). Echo it back as
   * `cursor` to resume; absent on a whole-fits page so the response is
   * byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata for the designated section; truncation only. */
  readonly pageInfo?: PageInfo;
  /** Which ComponentType section the cursor advances; truncation only. */
  readonly designatedList?: string;
  /** The non-paged ComponentType sections, with their full reference counts; truncation only. */
  readonly otherSections?: readonly SectionDisclosure[];
}

const isCustomField = (id: string): boolean =>
  id.startsWith(CUSTOM_FIELD_PREFIX);

/**
 * Resolve one incoming edge to a `FieldReference` by looking up the
 * referrer node and copying identity + edge metadata. Sparse-graph
 * misses (referrer node not present) return `null` and are dropped by
 * the caller — same tolerance as `find-formula-references` and
 * `find-apex-usages`.
 */
const resolveReference = async (
  ctx: Context,
  edge: Edge,
): Promise<Result<FieldReference | null, string>> => {
  const nodeResult = await getNodeById(ctx.graph, edge.fromId);
  if (!nodeResult.ok) {
    return err(nodeResult.error.message);
  }
  const node: Node | null = nodeResult.value;
  if (node === null) return ok(null);
  return ok({
    componentId: node.id,
    componentType: node.type,
    apiName: node.apiName,
    edgeType: edge.edgeType,
    source: edge.source,
    confidence: edge.confidence,
    properties: edge.properties,
  });
};

/**
 * Deterministic comparator inside one ComponentType bucket:
 * `componentId ASC`, then `edgeType ASC`, then `source ASC`. The final `source`
 * tiebreak makes the order match the graph edge PK `(from_id, to_id, edge_type,
 * source)` exactly — UNIQUE — so an offset-based section cursor resume can
 * neither dup nor skip at a (componentId, edgeType) tie (two edges from one
 * referrer with the same edgeType but different `source`).
 */
const compareRefs = (a: FieldReference, b: FieldReference): number => {
  if (a.componentId !== b.componentId) {
    return a.componentId < b.componentId ? -1 : 1;
  }
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
};

/**
 * The `sfi.find_field_anywhere` MCP tool. Given a `CustomField:` id,
 * returns every incoming reference (Apex reads/writes, Flow lookups,
 * Layout placements, formula refs, ValidationRule refs, SharingRule
 * refs) grouped by referrer ComponentType.
 *
 * @example
 *   const r = await findFieldAnywhereHandler(ctx, {
 *     targetId: 'CustomField:Account.Industry__c',
 *   });
 *   if (r.ok) console.log(r.value.data.groups.length);
 */
export const findFieldAnywhereHandler = async (
  ctx: Context,
  input: FindFieldAnywhereInput,
): Promise<Result<McpResponse<FindFieldAnywhereOutput>, McpError>> => {
  // Accept `fieldId` as an alias for `targetId` (field-family parity).
  const rawTargetId = input.targetId ?? input.fieldId;
  if (rawTargetId === undefined) {
    return err({
      kind: 'invalid-query',
      message: `targetId (or its alias fieldId) is required and must be a '${CUSTOM_FIELD_PREFIX}' id`,
      path: 'targetId',
    });
  }
  if (!isCustomField(rawTargetId)) {
    return err({
      kind: 'invalid-query',
      message: `targetId must start with '${CUSTOM_FIELD_PREFIX}'; got '${rawTargetId}'`,
      path: 'targetId',
    });
  }
  const targetId = rawTargetId as ComponentId;
  const limit = input.limit ?? FIND_FIELD_ANYWHERE_DEFAULT_LIMIT;
  const typeFilter: ReadonlySet<string> | null =
    input.componentTypes !== undefined && input.componentTypes.length > 0
      ? new Set(input.componentTypes)
      : null;

  const edgesResult = await listEdges(ctx.graph, targetId, {
    direction: 'in',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  // EXISTENCE GATE (R4). `targetId` was validated by PREFIX only. Without this
  // gate four distinct causes produced a byte-identical
  // `{groups: [], totalCount: 0, byEdgeType: {}, truncated: false}` and three of
  // them were lies: a typo, a real field in the WRONG CASE (ids are
  // case-sensitive), a field the refresh never retrieved, and a real field that
  // genuinely is referenced nowhere. Only the last one may answer zero. The
  // handler already fetched this node below (for the folded report/dashboard
  // flags) and silently substituted `false` on null — ask FIRST, and route the
  // refusal through the same `fieldNotFoundError` + phantom-aware message the
  // sibling field tools use so the caller gets ranked `resolveSuggestions`.
  const targetNodeResult = await getNodeById(ctx.graph, targetId);
  if (!targetNodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${targetNodeResult.error.message}`,
    });
  }
  const targetNode = targetNodeResult.value;
  if (targetNode === null) {
    // A PHANTOM (edges exist, definition not retrieved) still has a true answer
    // to give, so only an id that is BOTH absent and unreferenced is refused.
    const referencingEdges = edgesResult.value.filter(
      (e) => e.edgeType !== 'parentOf',
    ).length;
    if (referencingEdges === 0) {
      return err(
        await fieldNotFoundError(
          ctx,
          targetId,
          await phantomAwareNotFoundMessage(ctx, targetId, 'CustomField'),
        ),
      );
    }
  }

  const collected: FieldReference[] = [];
  for (const edge of edgesResult.value) {
    // The parentOf edge is the containment edge from CustomObject and
    // does not represent a "use" of the field. Skip it so the universal
    // search returns only meaningful usages.
    if (edge.edgeType === 'parentOf') continue;
    const resolved = await resolveReference(ctx, edge);
    if (!resolved.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${resolved.error}`,
      });
    }
    if (resolved.value === null) continue;
    if (typeFilter !== null && !typeFilter.has(resolved.value.componentType)) {
      continue;
    }
    collected.push(resolved.value);
  }

  // Group by ComponentType (keyed as string so a cursor's `listId` indexes it).
  const byType = new Map<string, FieldReference[]>();
  for (const ref of collected) {
    const arr = byType.get(ref.componentType);
    if (arr === undefined) {
      byType.set(ref.componentType, [ref]);
    } else {
      arr.push(ref);
    }
  }

  // Sort within each group to a UNIQUE total order (compareRefs ends in
  // `source` — matches the edge PK — so section-offset resume is dup/skip-free).
  for (const arr of byType.values()) arr.sort(compareRefs);

  // Stable section order: ComponentType label ASC (also the existing group
  // order). Typed as string[] so a cursor's `listId` (string) can index it.
  const sortedTypes: readonly string[] = [...byType.keys()].sort();

  // CR-22 section cursor over the per-ComponentType buckets. `limit` is now the
  // per-SECTION page size (was a cross-group running cap). On a whole-fits call
  // (no cursor, every section ≤ limit) the response is byte-identical: every
  // section is emitted with its full references and NO cursor block. When a
  // section overflows, the DESIGNATED section is paged and the others are emitted
  // with empty `references` (their `count` preserved) + disclosed via
  // otherSections, so each is walkable section-by-section.
  const TOOL = 'sfi.find_field_anywhere';
  const fingerprint = argsFingerprint({
    targetId,
    ...(input.componentTypes !== undefined ? { componentTypes: input.componentTypes } : {}),
  });

  // A no-cursor call is "paged" only when at least one section exceeds `limit`.
  const anyOverLimit = sortedTypes.some((t) => (byType.get(t) ?? []).length > limit);

  let designatedListId: string | null = sortedTypes.length > 0 ? (sortedTypes[0] as string) : null;
  let offset = 0;
  let isPaged = anyOverLimit;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
    if (decoded.value.listId !== undefined) designatedListId = decoded.value.listId;
    isPaged = true;
  }

  const sections: readonly PageableSection<FieldReference>[] = sortedTypes.map((t) => ({
    listId: t,
    items: byType.get(t) ?? [],
  }));

  const groups: ReferenceGroup[] = [];
  let truncated = false;
  let cursorBlock:
    | { nextCursor: string; pageInfo: PageInfo; designatedList: string; otherSections: readonly SectionDisclosure[] }
    | undefined;

  if (!isPaged || designatedListId === null) {
    // Whole-fits: emit every section with its full references (today's shape).
    for (const type of sortedTypes) {
      const refs = byType.get(type) ?? [];
      groups.push({ componentType: type as ComponentType, references: refs, count: refs.length });
    }
  } else {
    // Truncated: page the designated section; emit the others with empty
    // references but their honest count. paginateSection mints the
    // continuation cursor for THIS section when it overflows.
    const pagedResult = paginateSection(sections, designatedListId, {
      offset,
      limit,
      byteBudget: FIND_FIELD_ANYWHERE_BYTE_BUDGET,
      keyOf: (r) => `${r.componentId}|${r.edgeType}|${r.source}`,
      binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
    });
    if (!pagedResult.ok) return err(pagedResult.error);
    const paged = pagedResult.value;
    truncated = true;
    for (const type of sortedTypes) {
      const refs = byType.get(type) ?? [];
      groups.push({
        componentType: type as ComponentType,
        references: type === designatedListId ? paged.items : [],
        count: refs.length,
      });
    }
    if (paged.pageInfo.nextCursor !== null) {
      // The designated section still has more — resume it.
      cursorBlock = {
        nextCursor: paged.pageInfo.nextCursor,
        pageInfo: paged.pageInfo,
        designatedList: paged.listId,
        otherSections: paged.otherSections,
      };
    } else {
      // Designated section exhausted; roll the cursor forward to the NEXT
      // non-empty section at offset 0 so the next call pages it (the whole
      // nested result stays walkable section-by-section). No re-emit this call.
      const idx = sortedTypes.indexOf(designatedListId);
      const nextType = sortedTypes
        .slice(idx + 1)
        .find((t) => (byType.get(t) ?? []).length > 0);
      if (nextType !== undefined) {
        const token: PageCursorToken = {
          v: PAGE_CURSOR_VERSION,
          t: TOOL,
          h: ctx.manifest.sourceTreeHash,
          o: 0,
          q: fingerprint,
          listId: nextType,
        };
        cursorBlock = {
          nextCursor: encodeCursor(token),
          pageInfo: { ...paged.pageInfo, hasMore: true, nextCursor: encodeCursor(token) },
          // The cursor now advances the NEXT section, so report that as the list
          // it will page on resume.
          designatedList: nextType,
          otherSections: paged.otherSections,
        };
      }
    }
  }

  // byEdgeType tally over the FULL collected set (not the truncated
  // slice) so the user can see the unfiltered edge-type distribution.
  const byEdgeType: Record<string, number> = {};
  for (const ref of collected) {
    byEdgeType[ref.edgeType] = (byEdgeType[ref.edgeType] ?? 0) + 1;
  }

  const boundaries: string[] = [];
  if (collected.length > 0) {
    boundaries.push(STATIC_GRAPH_DISCLOSURE);
    boundaries.push(MANAGED_PACKAGE_DISCLOSURE);
  }

  // Report / Dashboard field usage is folded onto the field as a PROPERTY by
  // `applyReportDashboardPersistence`, so it is invisible to the edge walk
  // above. REPORT-DASHBOARD-GRAPH-PERSISTENCE persists the Report/Dashboard
  // NODES (so `Report:{Folder}/{Name}` is now a real, inspectable component)
  // but deliberately NOT the analytics -> CustomField edges: at real-org scale
  // they were 94% of the persisted rows for an answer this property already
  // gives over EVERY extracted report. The property stays the authority here.
  // Surface it: a positive note when the field carries the folded usage,
  // otherwise the caveat that report usage is only modeled when the pull ran.
  // `targetNode` was resolved by the existence gate above; a null here can now
  // only mean PHANTOM (the gate refused the absent-and-unreferenced case). A
  // phantom target has NO node to carry the folded flags, so it gets the
  // phantom disclosure instead of a report/dashboard claim in either direction.
  const rdUsage = targetNode !== null ? reportDashboardUsage(targetNode) : null;
  if (rdUsage === null) {
    boundaries.push(phantomTargetDisclosure(targetId));
  } else if (rdUsage.usedInReport || rdUsage.usedInDashboard) {
    const where = [
      rdUsage.usedInReport ? 'report column(s) / filter(s)' : null,
      rdUsage.usedInDashboard ? 'dashboard component(s)' : null,
    ]
      .filter((s): s is string => s !== null)
      .join(' and ');
    boundaries.push(
      `This field IS used in ${where} (folded from the report/dashboard pull). Report/dashboard referrers are NOT edges, so they do not appear in the reference list above — read the folded \`usedInReports\` / \`usedInDashboards\` name list on the field (first 50, with an exact truncation total), or open the \`Report:{Folder}/{Name}\` node those names identify.`,
    );
  } else {
    boundaries.push(REPORT_DASHBOARD_USAGE_CAVEAT);
  }

  return ok({
    data: {
      targetId,
      groups,
      totalCount: collected.length,
      byEdgeType,
      boundaries,
      truncated,
      ...(cursorBlock !== undefined
        ? {
            nextCursor: cursorBlock.nextCursor,
            pageInfo: cursorBlock.pageInfo,
            designatedList: cursorBlock.designatedList,
            otherSections: cursorBlock.otherSections,
          }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
