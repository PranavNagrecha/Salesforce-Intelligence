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
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  REPORT_DASHBOARD_USAGE_CAVEAT,
  reportDashboardUsage,
} from './report-dashboard-usage.js';

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
 * `componentId ASC`, then `edgeType ASC`.
 */
const compareRefs = (a: FieldReference, b: FieldReference): number => {
  if (a.componentId !== b.componentId) {
    return a.componentId < b.componentId ? -1 : 1;
  }
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
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

  // Group by ComponentType.
  const byType = new Map<ComponentType, FieldReference[]>();
  for (const ref of collected) {
    const arr = byType.get(ref.componentType);
    if (arr === undefined) {
      byType.set(ref.componentType, [ref]);
    } else {
      arr.push(ref);
    }
  }

  // Sort within each group.
  for (const arr of byType.values()) arr.sort(compareRefs);

  // Apply `limit` across the total — preserve per-group sort order, then
  // truncate as we walk groups in alphabetical order.
  const sortedTypes = [...byType.keys()].sort();
  const groups: ReferenceGroup[] = [];
  let total = 0;
  let truncated = false;
  for (const type of sortedTypes) {
    const refs = byType.get(type) ?? [];
    if (total >= limit) {
      truncated = true;
      break;
    }
    const remaining = limit - total;
    const slice = refs.slice(0, remaining);
    if (slice.length < refs.length) truncated = true;
    groups.push({
      componentType: type,
      references: slice,
      count: refs.length,
    });
    total += slice.length;
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

  // Report / Dashboard usage is folded onto the field as a property (no per-report
  // node/edge — see foldReportDashboardUsageIntoFields), so it's invisible to the
  // edge walk above. Surface it: a positive note when the field carries the folded
  // usage, otherwise the caveat that it's only modeled with `--with-reports`.
  const targetNodeResult = await getNodeById(ctx.graph, targetId);
  const rdUsage =
    targetNodeResult.ok && targetNodeResult.value !== null
      ? reportDashboardUsage(targetNodeResult.value)
      : { usedInReport: false, usedInDashboard: false };
  if (rdUsage.usedInReport || rdUsage.usedInDashboard) {
    const where = [
      rdUsage.usedInReport ? 'report column(s) / filter(s)' : null,
      rdUsage.usedInDashboard ? 'dashboard component(s)' : null,
    ]
      .filter((s): s is string => s !== null)
      .join(' and ');
    boundaries.push(
      `This field IS used in ${where} (folded from a \`--with-reports\` refresh). Reports/dashboards are not stored as per-report nodes, so there is no per-report breakdown here.`,
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
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
