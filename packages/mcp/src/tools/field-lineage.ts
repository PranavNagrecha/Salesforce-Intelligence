/**
 * Handler for the `sfi.field_lineage` MCP tool.
 *
 * The v3.0 provenance + downstream-effects walker — the sibling
 * synthesis tool to `sfi.field_360`. Given a CustomField id, returns
 * either an upstream walk (provenance: where does this field's data
 * come FROM?), a downstream walk (effects: what fires when this field
 * changes?), or both.
 *
 * Per PLAN-v3.0 §4 `sfi.field_lineage`, the walks inherit v2.7's
 * cycle-detection + depth-bound discipline and v2.9's source-of-truth
 * classification (when the v2.9 marker `properties.isSourceOfTruth` is
 * set on the upstream-reached field, the walk terminates with the
 * `source-of-truth-field` sourceKind so the renderer can call out the
 * trace endpoint).
 *
 * Upstream walk: starting from `fieldId`, query incoming `writesTo`
 * edges; each writer is a source. Recurse into each writer for "where
 * does THIS writer get its value FROM?" — formula upstream / WorkflowRule
 * criteriaItems / integration-inbound external system (terminal) / v2.9
 * source-of-truth field (terminal). The walk depth is bounded by
 * `maxDepth` (default 3, max 5); cycles are detected by
 * `(fromId, toId, edgeType)` keying.
 *
 * R6-11 flow dataflow: a FLOW writer no longer dead-ends the walk. The
 * flow extractor traces each DML input assignment back through the
 * flow's internal assignment chain and stamps the resolved source
 * fields on the field-level `writesTo` edge
 * (`properties.sourceFields` / `sourceFieldConfidence` /
 * `unresolvedSourceCount`). The upstream walk follows those fields as
 * `flow-input-field` sources one hop past the flow and RECURSES into
 * each, so a field written by Flow A from a field written by Flow B
 * chains end-to-end. Per-hop confidence is the extractor's per-field
 * trace label (`declared` = direct $Record/record-lookup chain,
 * `heuristic` = through a formula/loop/non-Assign operator); inputs the
 * extractor could not statically resolve surface as a DISCLOSED count
 * (`upstream.flowDataflow.unresolvedInputCount`), never as guessed
 * fields. Flow write edges from a vault refreshed BEFORE the tracer
 * existed carry no trace — they are counted in
 * `flowDataflow.untracedFlowWriteEdges` and disclosed.
 *
 * Downstream walk: starting from `fieldId`, walk incoming `firesWhen`
 * (v2.0a) + `triggersOn` + `callsApex` from automation surfaces
 * reading the field. Surfaces flow-decision-branch /
 * apex-if-clause / workflow-fire / validation-fire /
 * integration-outbound / email-fire / formula-recompute. Each effect
 * carries `firesWhen` string for review. Inherits v2.7 depth-bound +
 * cycle discipline.
 *
 * Honesty axis (per PLAN-v3.0 §4): the lineage payload's `boundaries[]`
 * carries the verbatim Q165 disclosure plus per-walk-specific notes.
 * The walk does NOT semantically evaluate conditions — `firesWhen`
 * surfaces conditional context literals but does NOT model whether the
 * runtime record satisfies them.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  Edge,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  DATAFLOW_SOURCE_OPERATION,
  FLOW_DATAFLOW_TRACE_DEPTH_CAP,
} from '@sf-intelligence/extractors';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { FIELD_360_Q165_DISCLOSURE } from './field-360.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import { mergeInputAliases } from './input-aliases.js';
import {
  argsFingerprint,
  decodeCursor,
  paginateSection,
  type PageableSection,
} from './page-cursor.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import {
  REPORT_DASHBOARD_USAGE_CAVEAT,
  reportDashboardUsage,
} from './report-dashboard-usage.js';
import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/** Default `maxDepth` per PLAN-v3.0 §4. */
const DEFAULT_MAX_DEPTH = 3;
/** Hard cap on `maxDepth` — mirrors v2.7's call-graph cap. */
const HARD_CAP_MAX_DEPTH = 5;

/** The direction the caller can request. */
const DIRECTION_VALUES = ['upstream', 'downstream', 'both'] as const;

/**
 * Zod schema for the `sfi.field_lineage` tool input. Per PLAN-v3.0 §4:
 *
 *   - `fieldId`: required non-empty string; canonical CustomField id
 *     or short `Object.Field` form.
 *   - `direction`: optional; one of `'upstream' | 'downstream' | 'both'`.
 *     Defaults to `'both'`.
 *   - `maxDepth`: optional integer in `[1, 5]`. Defaults to 3.
 *   - `includeFieldsOfTruth`: optional boolean. Defaults to true.
 *   - `includeFiresWhen`: optional boolean. Defaults to true.
 */
/** The two pageable list sections. `section` names which one a page advances. */
export const FIELD_LINEAGE_SECTIONS = [
  'upstream.sources',
  'downstream.effects',
] as const;

/** Inclusive upper bound on `limit`. */
const FIELD_LINEAGE_MAX_LIMIT = 500;
/** Default page size when the caller does not pass `limit`. */
const FIELD_LINEAGE_DEFAULT_LIMIT = 200;

const fieldLineageInputBaseSchema = z.object({
  fieldId: z.string().min(1),
  direction: z.enum(DIRECTION_VALUES).optional().default('both'),
  maxDepth: z.number().int().min(1).max(HARD_CAP_MAX_DEPTH).optional(),
  includeFieldsOfTruth: z.boolean().optional(),
  includeFiresWhen: z.boolean().optional(),
  /**
   * Real narrowing knobs. Before these existed the oversize advice named
   * `limit` / `offset` / `cursor` — knobs this tool did not have — and a hub
   * field's lineage was simply unanswerable.
   */
  limit: z.number().int().min(1).max(FIELD_LINEAGE_MAX_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
  cursor: z.string().min(1).optional(),
  section: z.enum(FIELD_LINEAGE_SECTIONS).optional(),
});

export const fieldLineageInputSchema = z.preprocess(
  (raw) => mergeInputAliases(raw, [{ canonical: 'fieldId', aliases: ['componentId'] }]),
  fieldLineageInputBaseSchema,
);

/** Parsed input shape, inferred from `fieldLineageInputSchema`. */
export type FieldLineageInput = z.infer<typeof fieldLineageInputSchema>;

/** One upstream provenance source. */
export interface UpstreamSource {
  readonly sourceKind:
    | 'workflow-field-update'
    | 'flow-assignment'
    | 'apex-write'
    | 'process-builder-assignment'
    | 'formula-source'
    // R6-11: a record field a FLOW writer reads to produce the written
    // value — the flow's INPUT, surfaced one hop past the flow from the
    // extractor's `sourceFields` trace on the writesTo edge. `confidence`
    // is the per-field trace label (declared | heuristic).
    | 'flow-input-field'
    | 'integration-inbound'
    | 'source-of-truth-field';
  readonly sourceId: ComponentId;
  readonly sourceApiName: string;
  readonly depth: number;
  readonly confidence: ConfidenceLevel;
  readonly isSourceOfTruth: boolean;
  readonly reachableVia: readonly ComponentId[];
}

/** One downstream effect. */
export interface DownstreamEffect {
  readonly effectKind:
    | 'flow-decision-branch'
    | 'apex-if-clause'
    | 'workflow-fire'
    | 'validation-fire'
    | 'integration-outbound'
    | 'email-fire'
    | 'formula-recompute'
    // R6-11: a Flow READS this field as a dataflow source and writes its
    // value onward into `targetFields` — the downstream mirror of the
    // upstream `flow-input-field` hop. The walk continues INTO each
    // target field at depth + 1.
    | 'flow-field-write';
  readonly effectId: ComponentId;
  readonly effectApiName: string;
  readonly depth: number;
  readonly confidence: ConfidenceLevel;
  readonly conditionId: ComponentId | null;
  readonly firesWhen: string | null;
  /**
   * R6-11: present ONLY on `flow-field-write` effects — the
   * `{Object}.{Field}` short forms this flow writes the read value into
   * (from the dataflow edge's `targetFields` property).
   */
  readonly targetFields?: readonly string[];
}

/** Upstream payload. */
export interface UpstreamPayload {
  readonly sources: readonly UpstreamSource[];
  /**
   * TRUE total before paging. `sources.length` is a PAGE length once this
   * response is paged, so a caller that read it as a total would be wrong.
   */
  readonly sourceCount: number;
  readonly truncatedAtDepth: number | null;
  readonly sourceOfTruthCount: number;
  /**
   * P4-formula-chains: the formula-reference chain summary, computed from the
   * `formula-source` upstream entries. `maxDepth` is the deepest formula→formula
   * hop reached (0 = this field is not a formula or references no formulas;
   * 1 = its formula references base fields only; >= 2 = its formula references
   * ANOTHER formula, which references more — a multi-hop recompute cascade).
   * `crossesObject` is true when any formula-source sits on a DIFFERENT object
   * than the root field (a cross-object formula reference). A change to a base
   * field at the bottom of a deep / cross-object chain ripples through every
   * formula above it.
   */
  readonly formulaChain: {
    readonly maxDepth: number;
    readonly crossesObject: boolean;
  };
  /**
   * R6-11: the flow-dataflow trace summary for this walk.
   * `inputFieldsTraced` counts the `flow-input-field` sources surfaced;
   * `unresolvedInputCount` totals the flow input references the EXTRACTOR
   * could not statically resolve (ambiguous variables, relationship
   * traversals, action outputs, chains past the trace depth cap) —
   * disclosed here, never guessed; `untracedFlowWriteEdges` counts flow
   * write edges that predate the dataflow tracer (vault refreshed with an
   * older extractor — re-refresh to trace them).
   */
  readonly flowDataflow: {
    readonly inputFieldsTraced: number;
    readonly unresolvedInputCount: number;
    readonly untracedFlowWriteEdges: number;
  };
}

/** Downstream payload. */
export interface DownstreamPayload {
  readonly effects: readonly DownstreamEffect[];
  /** TRUE total before paging. See {@link UpstreamPayload.sourceCount}. */
  readonly effectCount: number;
  readonly truncatedAtDepth: number | null;
}

/** Output payload wrapped inside `McpResponse` on success. */
export interface FieldLineageOutput {
  readonly fieldId: ComponentId;
  readonly direction: 'upstream' | 'downstream' | 'both';
  readonly maxDepth: number;
  readonly upstream?: UpstreamPayload;
  readonly downstream?: DownstreamPayload;
  readonly boundaries: readonly string[];
  readonly dataNotAvailable: readonly string[];
  readonly cyclesDetected: boolean;
  /**
   * Paging keys are emitted ONLY when the response is actually paged
   * (`hasMore`, or `offset > 0`), so an in-budget answer stays byte-identical —
   * the convention `find_semantic_field` already uses.
   */
  readonly section?: (typeof FIELD_LINEAGE_SECTIONS)[number];
  readonly limit?: number;
  readonly offset?: number;
  readonly hasMore?: boolean;
  readonly nextOffset?: number | null;
  readonly nextCursor?: string;
  readonly pageInfo?: PageInfo;
  /** Verbatim; present only when the designated section was truncated. */
  readonly note?: string;
}

/**
 * The not-retrieved baseline for `dataNotAvailable` — same shape as
 * `field_360`. CR-CAP-03 makes the emitted array DYNAMIC (see handler): this
 * full list surfaces only when Report/Dashboard were NOT retrieved and the
 * field has no folded usage. Exported so tests assert the baseline.
 */
export const FIELD_LINEAGE_DATA_NOT_AVAILABLE: readonly string[] = [
  'list-view-filters',
  'reports',
  'dashboards',
];

/** Normalize input id; short form `Object.Field` is promoted. */
const normalizeFieldId = (raw: string): ComponentId | null => {
  if (raw.startsWith(CUSTOM_FIELD_PREFIX)) return raw as ComponentId;
  if (raw.includes(':')) return null;
  if (raw.includes('.') && /^[A-Za-z0-9_.]+$/.test(raw)) {
    return `${CUSTOM_FIELD_PREFIX}${raw}` as ComponentId;
  }
  return null;
};

/** Map a writer node-type to the canonical sourceKind. */
const classifyUpstreamWriter = (node: Node): UpstreamSource['sourceKind'] => {
  if (node.type === 'WorkflowRule') return 'workflow-field-update';
  if (node.type === 'Flow') {
    const pt = node.properties['processType'];
    if (typeof pt === 'string' && pt.toLowerCase().includes('workflow')) {
      return 'process-builder-assignment';
    }
    return 'flow-assignment';
  }
  if (node.type === 'ApexClass' || node.type === 'ApexTrigger') {
    return 'apex-write';
  }
  // Default fallback — formula-source classification is reserved for
  // CustomField writers identified via the formula-tokenizer source
  // marker on the edge.
  return 'apex-write';
};

/**
 * Classify a ConditionalContext source's parent-firer type by reading
 * its synthetic id prefix. v2.0a emits ConditionalContext ids of the
 * form `ConditionalContext:{ParentType}:{ParentApiName}.condition-{i}`;
 * the ParentType is what governs the effectKind.
 */
const classifyConditionalContextParent = (
  source: Node,
): DownstreamEffect['effectKind'] | null => {
  // The synthetic id pattern preserves the parent type as a substring;
  // the v2.0a convention is `ConditionalContext:Flow:Foo.condition-0`,
  // so we look for the parent type after the leading
  // `ConditionalContext:` prefix.
  const id = source.id;
  if (id.includes(':Flow:') || id.includes('Flow:')) {
    return 'flow-decision-branch';
  }
  if (id.includes(':ApexClass:') || id.includes(':ApexTrigger:')) {
    return 'apex-if-clause';
  }
  if (id.includes(':WorkflowRule:')) return 'workflow-fire';
  if (id.includes(':ValidationRule:')) return 'validation-fire';
  // Default: surface as flow-decision-branch — the most common case.
  return 'flow-decision-branch';
};

/**
 * Map an effect node-type to the canonical effectKind. The mapping
 * favors specificity (firesWhen → flow-decision-branch when source is
 * Flow; apex-if-clause when source is Apex; etc.). ConditionalContext
 * sources are classified per `classifyConditionalContextParent`.
 */
const classifyDownstreamEffect = (
  edge: Edge,
  source: Node,
): DownstreamEffect['effectKind'] | null => {
  // Highest specificity: ConditionalContext sources carry the full
  // condition semantics. Surface them regardless of edge type.
  if (source.type === 'ConditionalContext') {
    return classifyConditionalContextParent(source);
  }
  if (edge.edgeType === 'firesWhen') {
    if (source.type === 'Flow') return 'flow-decision-branch';
    if (source.type === 'ApexClass' || source.type === 'ApexTrigger') {
      return 'apex-if-clause';
    }
    if (source.type === 'WorkflowRule') return 'workflow-fire';
    if (source.type === 'ValidationRule') return 'validation-fire';
  }
  // Integration-outbound: OutboundMessage, ExternalService refs.
  if (source.type === 'OutboundMessage') return 'integration-outbound';
  if (source.type === 'ExternalService') return 'integration-outbound';
  if (edge.edgeType === 'references') {
    if (source.type === 'EmailTemplate') return 'email-fire';
    if (source.type === 'CustomField') return 'formula-recompute';
    if (source.type === 'ValidationRule') return 'validation-fire';
    if (source.type === 'WorkflowRule') return 'workflow-fire';
  }
  if (edge.edgeType === 'readsFrom' || edge.edgeType === 'writesTo') {
    if (source.type === 'Flow') return 'flow-decision-branch';
    if (source.type === 'WorkflowRule') return 'workflow-fire';
    if (source.type === 'ApexClass' || source.type === 'ApexTrigger') {
      return 'apex-if-clause';
    }
  }
  return null;
};

/**
 * Read an edge's condition expression for the `firesWhen` literal. v2.0a
 * `firesWhen` edges target a `ConditionalContext:` node whose
 * `properties.expression` carries the raw condition string. v3.0 reads
 * the source-side fallback `properties.condition` when the edge
 * predates the v2.0a primitive.
 */
const extractFiresWhen = (edge: Edge): string | null => {
  const c = edge.properties['condition'] ?? edge.properties['expression'];
  return typeof c === 'string' ? c : null;
};

/** Determine whether a field carries the v2.9 source-of-truth marker. */
const isSourceOfTruthField = (node: Node): boolean =>
  node.properties['isSourceOfTruth'] === true;

/**
 * Recursively walk upstream writers. Each level adds a new writer to
 * `sources` until the depth bound is hit; cycles are short-circuited
 * by the `visited` set.
 */
const walkUpstream = async (
  ctx: Context,
  fieldId: ComponentId,
  maxDepth: number,
  includeSoT: boolean,
): Promise<
  Result<
    {
      sources: UpstreamSource[];
      truncated: boolean;
      cycles: boolean;
      flowDataflow: {
        inputFieldsTraced: number;
        unresolvedInputCount: number;
        untracedFlowWriteEdges: number;
      };
    },
    McpError
  >
> => {
  const sources: UpstreamSource[] = [];
  const visited = new Set<ComponentId>([fieldId]);
  let truncated = false;
  let cycles = false;
  // R6-11 flow-dataflow accumulators (see UpstreamPayload.flowDataflow).
  let inputFieldsTraced = 0;
  let unresolvedInputCount = 0;
  let untracedFlowWriteEdges = 0;

  /**
   * One level of the recursion. The `path` parameter records the
   * reachableVia chain so the renderer can surface the trace path.
   */
  const recurse = async (
    targetId: ComponentId,
    depth: number,
    path: ComponentId[],
  ): Promise<Result<void, McpError>> => {
    if (depth > maxDepth) {
      truncated = true;
      return ok(undefined);
    }
    const incomingResult = await listEdges(ctx.graph, targetId, {
      direction: 'in',
      edgeType: 'writesTo',
    });
    if (!incomingResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${incomingResult.error.message}`,
      });
    }
    for (const edge of incomingResult.value) {
      if (visited.has(edge.fromId)) {
        cycles = true;
        continue;
      }
      visited.add(edge.fromId);
      const sr = await getNodeById(ctx.graph, edge.fromId);
      if (!sr.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${sr.error.message}`,
        });
      }
      if (sr.value === null) continue;
      const sourceNode = sr.value;

      const isSoT = isSourceOfTruthField(sourceNode);
      const sourceKind: UpstreamSource['sourceKind'] = isSoT
        ? 'source-of-truth-field'
        : classifyUpstreamWriter(sourceNode);

      sources.push({
        sourceKind,
        sourceId: sourceNode.id,
        sourceApiName: sourceNode.apiName,
        depth,
        confidence: edge.confidence,
        isSourceOfTruth: isSoT,
        reachableVia: [...path, targetId],
      });

      // v2.9 source-of-truth fields are terminal — stop the walk.
      if (isSoT && includeSoT) continue;
      // R6-11: a FLOW writer's next hop is its traced INPUT fields (the
      // extractor's `sourceFields` on this very edge) — a Flow node has no
      // incoming `writesTo` edges, so recursing into the flow itself (the
      // pre-R6-11 behavior) always dead-ended.
      if (sourceNode.type === 'Flow') {
        const next = await followFlowInputs(edge, sourceNode, depth, [
          ...path,
          targetId,
        ]);
        if (!next.ok) return next;
        continue;
      }
      // Recurse only into writers that themselves write to other
      // fields. Apex writers may write to multiple downstream
      // fields, but for lineage we only follow further `writesTo`
      // edges into the writer's own field reads (which manifest as
      // incoming `writesTo` edges on the writer's target fields).
      if (
        sourceNode.type === 'CustomField' ||
        sourceNode.type === 'ApexClass'
      ) {
        const next = await recurse(sourceNode.id, depth + 1, [
          ...path,
          targetId,
        ]);
        if (!next.ok) return next;
      }
    }

    // Formula sources: a formula field carries OUTGOING `references` edges
    // (producer formula-tokenizer) to the fields it is computed FROM. Those
    // referenced fields are this field's upstream provenance — sourceKind
    // 'formula-source' — symmetric to the downstream walk's incoming
    // `references` → 'formula-recompute'. Without this branch a formula
    // field reports ZERO upstream sources even though its value is derived
    // entirely from the fields it references (cross-tool inconsistency:
    // field_lineage(source, downstream) lists the formula as an effect, but
    // field_lineage(formula, upstream) returned []).
    const formulaSrcResult = await listEdges(ctx.graph, targetId, {
      direction: 'out',
      edgeType: 'references',
    });
    if (!formulaSrcResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${formulaSrcResult.error.message}`,
      });
    }
    for (const edge of formulaSrcResult.value) {
      if (visited.has(edge.toId)) {
        cycles = true;
        continue;
      }
      const sr = await getNodeById(ctx.graph, edge.toId);
      if (!sr.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${sr.error.message}`,
        });
      }
      if (sr.value === null) continue;
      const sourceNode = sr.value;
      // Only CustomField targets are formula sources (mirrors the
      // downstream incoming-`references` → CustomField rule); a Lookup's
      // object reference is not a formula provenance source.
      if (sourceNode.type !== 'CustomField') continue;
      visited.add(edge.toId);

      const isSoT = isSourceOfTruthField(sourceNode);
      sources.push({
        sourceKind: isSoT ? 'source-of-truth-field' : 'formula-source',
        sourceId: sourceNode.id,
        sourceApiName: sourceNode.apiName,
        depth,
        confidence: edge.confidence,
        isSourceOfTruth: isSoT,
        reachableVia: [...path, targetId],
      });

      // Source-of-truth fields are terminal; otherwise recurse, since the
      // referenced field may itself be a formula referencing further fields.
      if (isSoT && includeSoT) continue;
      const next = await recurse(sourceNode.id, depth + 1, [...path, targetId]);
      if (!next.ok) return next;
    }
    return ok(undefined);
  };

  /**
   * R6-11: follow a FLOW writer's traced input fields. The extractor
   * stamped the flow's resolvable inputs on the field-level `writesTo`
   * edge itself (`sourceFields` + parallel `sourceFieldConfidence`,
   * `unresolvedSourceCount`); each resolved field becomes a
   * `flow-input-field` source at `flowDepth + 1` and is recursed into,
   * so multi-flow chains (A writes F1 from F2, B writes F2 from F3)
   * walk end-to-end. Honesty: unresolved inputs and untraced
   * (pre-tracer-vault) edges are COUNTED and disclosed, never guessed;
   * an input field missing from the vault (standard/unmodeled) is
   * surfaced by its short form but not walked further.
   */
  const followFlowInputs = async (
    edge: Edge,
    flowNode: Node,
    flowDepth: number,
    pathToFlow: ComponentId[],
  ): Promise<Result<void, McpError>> => {
    const rawUnresolved = edge.properties['unresolvedSourceCount'];
    if (typeof rawUnresolved === 'number' && Number.isFinite(rawUnresolved)) {
      unresolvedInputCount += rawUnresolved;
    }
    const rawFields = edge.properties['sourceFields'];
    if (!Array.isArray(rawFields)) {
      // No trace on this edge. Only a LITERAL write provably has zero field
      // inputs; anything else — a reference-kind write extracted before the
      // tracer existed, or an edge with no assignedValue at all (pre-R2-1
      // vault, verified live on a production-scale gate vault) — has UNKNOWN
      // inputs and is disclosed as untraced, never silently read as "the
      // flow has no inputs".
      if (edge.properties['assignedValueKind'] !== 'literal') {
        untracedFlowWriteEdges += 1;
      }
      return ok(undefined);
    }
    const rawConfidence = edge.properties['sourceFieldConfidence'];
    const pathViaFlow = [...pathToFlow, flowNode.id];
    for (let i = 0; i < rawFields.length; i += 1) {
      const shortForm = rawFields[i];
      if (typeof shortForm !== 'string' || shortForm.length === 0) continue;
      const inputFieldId = `${CUSTOM_FIELD_PREFIX}${shortForm}` as ComponentId;
      if (visited.has(inputFieldId)) {
        cycles = true;
        continue;
      }
      if (flowDepth + 1 > maxDepth) {
        truncated = true;
        continue;
      }
      visited.add(inputFieldId);
      const rawLabel = Array.isArray(rawConfidence)
        ? rawConfidence[i]
        : undefined;
      const confidence: ConfidenceLevel =
        rawLabel === 'declared' || rawLabel === 'heuristic'
          ? rawLabel
          : 'heuristic';
      const nodeResult = await getNodeById(ctx.graph, inputFieldId);
      if (!nodeResult.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${nodeResult.error.message}`,
        });
      }
      const inputNode = nodeResult.value;
      const isSoT = inputNode !== null && isSourceOfTruthField(inputNode);
      sources.push({
        sourceKind: isSoT ? 'source-of-truth-field' : 'flow-input-field',
        sourceId: inputFieldId,
        sourceApiName: inputNode?.apiName ?? shortForm,
        depth: flowDepth + 1,
        confidence,
        isSourceOfTruth: isSoT,
        reachableVia: pathViaFlow,
      });
      inputFieldsTraced += 1;
      if (isSoT && includeSoT) continue;
      if (inputNode === null) continue;
      const next = await recurse(inputFieldId, flowDepth + 2, pathViaFlow);
      if (!next.ok) return next;
    }
    return ok(undefined);
  };

  const r = await recurse(fieldId, 1, []);
  if (!r.ok) return r;
  return ok({
    sources,
    truncated,
    cycles,
    flowDataflow: {
      inputFieldsTraced,
      unresolvedInputCount,
      untracedFlowWriteEdges,
    },
  });
};

/**
 * Recursively walk downstream effects. Each level adds a new effect
 * to `effects` until the depth bound is hit; cycles are short-
 * circuited by the `visited` set.
 */
const walkDownstream = async (
  ctx: Context,
  fieldId: ComponentId,
  maxDepth: number,
  includeFiresWhen: boolean,
): Promise<
  Result<
    { effects: DownstreamEffect[]; truncated: boolean; cycles: boolean },
    McpError
  >
> => {
  const effects: DownstreamEffect[] = [];
  const visited = new Set<ComponentId>([fieldId]);
  let truncated = false;
  let cycles = false;

  const recurse = async (
    targetId: ComponentId,
    depth: number,
  ): Promise<Result<void, McpError>> => {
    if (depth > maxDepth) {
      truncated = true;
      return ok(undefined);
    }
    // Walk every incoming edge — `firesWhen`, `references` from
    // automations, `readsFrom` from automations, etc.
    const incomingResult = await listEdges(ctx.graph, targetId, {
      direction: 'in',
    });
    if (!incomingResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${incomingResult.error.message}`,
      });
    }
    for (const edge of incomingResult.value) {
      if (edge.edgeType === 'parentOf') continue;
      if (!includeFiresWhen && edge.edgeType === 'firesWhen') continue;
      if (visited.has(edge.fromId)) {
        cycles = true;
        continue;
      }
      visited.add(edge.fromId);
      const sr = await getNodeById(ctx.graph, edge.fromId);
      if (!sr.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${sr.error.message}`,
        });
      }
      if (sr.value === null) continue;
      const sourceNode = sr.value;

      // R6-11: a flow-dataflow READ edge means this field's value is
      // carried by the flow into `targetFields`. Surface the flow as a
      // `flow-field-write` effect and continue the walk INTO each written
      // field, so downstream chains cross flows symmetrically with the
      // upstream `flow-input-field` hop. Must run BEFORE the generic
      // classifier, which would mislabel this edge `flow-decision-branch`.
      if (
        edge.edgeType === 'readsFrom' &&
        sourceNode.type === 'Flow' &&
        edge.properties['operation'] === DATAFLOW_SOURCE_OPERATION
      ) {
        const rawTargets = edge.properties['targetFields'];
        const targetFields = Array.isArray(rawTargets)
          ? rawTargets.filter((t): t is string => typeof t === 'string')
          : [];
        effects.push({
          effectKind: 'flow-field-write',
          effectId: sourceNode.id,
          effectApiName: sourceNode.apiName,
          depth,
          confidence: edge.confidence,
          conditionId: null,
          firesWhen: null,
          targetFields,
        });
        for (const targetField of targetFields) {
          const targetFieldId = `${CUSTOM_FIELD_PREFIX}${targetField}` as ComponentId;
          if (visited.has(targetFieldId)) {
            cycles = true;
            continue;
          }
          visited.add(targetFieldId);
          const next = await recurse(targetFieldId, depth + 1);
          if (!next.ok) return next;
        }
        continue;
      }

      const effectKind = classifyDownstreamEffect(edge, sourceNode);
      if (effectKind === null) continue;

      // For firesWhen the conditionId IS the source ConditionalContext
      // id; for other edges no conditionId.
      const conditionId: ComponentId | null =
        edge.edgeType === 'firesWhen' &&
        sourceNode.type === 'ConditionalContext'
          ? sourceNode.id
          : null;

      effects.push({
        effectKind,
        effectId: sourceNode.id,
        effectApiName: sourceNode.apiName,
        depth,
        confidence: edge.confidence,
        conditionId,
        firesWhen: extractFiresWhen(edge),
      });
    }
    return ok(undefined);
  };

  const r = await recurse(fieldId, 1);
  if (!r.ok) return r;
  return ok({ effects, truncated, cycles });
};

/**
 * The `sfi.field_lineage` handler. Performs the requested walk(s) and
 * assembles the structured response. See module JSDoc for the walk
 * semantics, the v2.7-inherited cycle/depth discipline, and the v2.9
 * source-of-truth termination.
 *
 * @example
 *   const r = await fieldLineageHandler(ctx, {
 *     fieldId: 'CustomField:Account.Customer_Segment__c',
 *     direction: 'upstream',
 *     maxDepth: 3,
 *   });
 *   if (r.ok) console.log(r.value.data.upstream?.sources.length);
 */
export const fieldLineageHandler = async (
  ctx: Context,
  input: FieldLineageInput,
): Promise<Result<McpResponse<FieldLineageOutput>, McpError>> => {
  // FLD-02: graceful object→field routing.
  const suggestionResult = await resolveToFieldOrSuggest(ctx, input.fieldId);
  if (!suggestionResult.ok) return suggestionResult;
  if (suggestionResult.value !== null) {
    return ok(suggestionResult.value as unknown as McpResponse<FieldLineageOutput>);
  }

  const normalized = normalizeFieldId(input.fieldId);
  if (normalized === null) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must be a CustomField canonical id or '<Object>.<Field>' short form; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }
  const fieldId = normalized;
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const includeSoT = input.includeFieldsOfTruth ?? true;
  const includeFiresWhen = input.includeFiresWhen ?? true;

  // Verify the field exists — an unknown id surfaces as
  // `component-not-found`, not as an empty walk.
  const fieldResult = await getNodeById(ctx.graph, fieldId);
  if (!fieldResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${fieldResult.error.message}`,
    });
  }
  if (fieldResult.value === null) {
    return err(
      await fieldNotFoundError(
        ctx,
        fieldId,
        await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      ),
    );
  }
  // CR-CAP-03: the field node carries the folded report/dashboard usage flags
  // (the reports pull DROPS the report/dashboard nodes + edges and stamps
  // `usedInReport` / `usedInDashboard` booleans). field_lineage previously
  // discarded this node; capturing it brings the tool to field_360 parity.
  const fieldNode = fieldResult.value;

  let upstreamPayload: UpstreamPayload | undefined;
  let downstreamPayload: DownstreamPayload | undefined;
  let cyclesDetected = false;

  if (input.direction === 'upstream' || input.direction === 'both') {
    const r = await walkUpstream(ctx, fieldId, maxDepth, includeSoT);
    if (!r.ok) return r;
    if (r.value.cycles) cyclesDetected = true;
    // P4-formula-chains: summarise the formula-reference chain from the
    // formula-source upstream entries. The object is the segment between
    // `CustomField:` and the first `.` of the canonical id.
    const objectOf = (id: ComponentId): string =>
      id.startsWith('CustomField:')
        ? id.slice('CustomField:'.length).split('.')[0] ?? ''
        : '';
    const rootObject = objectOf(fieldId);
    const formulaSources = r.value.sources.filter(
      (s) => s.sourceKind === 'formula-source',
    );
    const formulaChain = {
      maxDepth: formulaSources.reduce((m, s) => Math.max(m, s.depth), 0),
      crossesObject: formulaSources.some(
        (s) => objectOf(s.sourceId) !== rootObject,
      ),
    };
    upstreamPayload = {
      sources: r.value.sources,
      sourceCount: r.value.sources.length,
      truncatedAtDepth: r.value.truncated ? maxDepth : null,
      sourceOfTruthCount: r.value.sources.filter((s) => s.isSourceOfTruth)
        .length,
      formulaChain,
      flowDataflow: r.value.flowDataflow,
    };
  }
  if (input.direction === 'downstream' || input.direction === 'both') {
    const r = await walkDownstream(ctx, fieldId, maxDepth, includeFiresWhen);
    if (!r.ok) return r;
    if (r.value.cycles) cyclesDetected = true;
    downstreamPayload = {
      effects: r.value.effects,
      effectCount: r.value.effects.length,
      truncatedAtDepth: r.value.truncated ? maxDepth : null,
    };
  }

  // CR-CAP-03: read the folded report/dashboard usage + coverage so the
  // report/dashboard boundary line is coverage-aware (parity with field_360,
  // which lineage previously lacked entirely). list-view column refs are NOT
  // composed into lineage sections (lineage has no listViews section — out of
  // CR-CAP-03 scope), so that line stays accurate.
  const analytics = reportDashboardUsage(fieldNode);
  const analyticsCoverage = summarizeCoverage(ctx.manifest, [
    'Report',
    'Dashboard',
  ]);
  let reportDashboardBoundary: string;
  if (analytics.usedInReport || analytics.usedInDashboard) {
    const where = [
      analytics.usedInReport ? 'a report column/filter' : null,
      analytics.usedInDashboard ? 'a dashboard component' : null,
    ].filter((x): x is string => x !== null);
    reportDashboardBoundary = `this field IS referenced by ${where.join(' and ')} (folded reports-pull usage) — it is NOT unused; per-report breakdown is not composed here.`;
  } else if (analyticsCoverage.status === 'complete') {
    reportDashboardBoundary =
      'reports/dashboards WERE retrieved and none reference this field — confirmed not-used (within the retrieved set); per-report breakdown is not composed here.';
  } else {
    reportDashboardBoundary = REPORT_DASHBOARD_USAGE_CAVEAT;
  }

  const boundaries: string[] = [
    FIELD_360_Q165_DISCLOSURE,
    'list view column AND filter field refs are extracted as graph edges (see field_360.listViews) but are NOT composed into field_lineage sections',
    reportDashboardBoundary,
    'conditions in firesWhen edges are listed but NOT EVALUATED — the tool does not know whether the runtime record satisfies them',
    `lineage walk depth-bounded at ${maxDepth} hops; deeper transitive provenance is NOT walked in this response`,
  ];
  if (cyclesDetected) {
    boundaries.push(
      'cycle detected in the lineage walk; back-edges were short-circuited per the v2.7 cycle discipline',
    );
  }
  // R6-11: disclose the flow-dataflow trace semantics whenever the upstream
  // walk crossed (or failed to cross) a flow writer. Absence of trace data
  // is disclosed, never silently treated as "the flow has no inputs".
  if (upstreamPayload !== undefined) {
    const fd = upstreamPayload.flowDataflow;
    if (
      fd.inputFieldsTraced > 0 ||
      fd.unresolvedInputCount > 0 ||
      fd.untracedFlowWriteEdges > 0
    ) {
      let flowDataflowBoundary =
        `flow writers' INPUT fields are traced from each flow's parsed assignment chain ` +
        `(per-hop confidence: declared = direct $Record / record-lookup chains, heuristic = through formulas/loops/non-Assign operators; ` +
        `extractor trace depth cap ${FLOW_DATAFLOW_TRACE_DEPTH_CAP} hops); ` +
        `${fd.unresolvedInputCount} flow input reference(s) could not be statically traced and are disclosed as a count, never guessed`;
      if (fd.untracedFlowWriteEdges > 0) {
        flowDataflowBoundary += `; ${fd.untracedFlowWriteEdges} flow write edge(s) predate the dataflow tracer (vault refreshed with an older extractor) — re-run \`sfi refresh\` to trace them`;
      }
      boundaries.push(flowDataflowBoundary);
    }
  }

  // CR-CAP-03: DYNAMIC dataNotAvailable (same retrieved-vs-not logic as
  // field_360). `list-view-filters` always; `reports`/`dashboards` only when
  // NOT retrieved AND no folded usage.
  const dataNotAvailable: string[] = ['list-view-filters'];
  const reportsRetrieved = analyticsCoverage.status === 'complete';
  if (!reportsRetrieved && !analytics.usedInReport) {
    dataNotAvailable.push('reports');
  }
  if (!reportsRetrieved && !analytics.usedInDashboard) {
    dataNotAvailable.push('dashboards');
  }

  // ---- Paging (FIX 8 Half B) -------------------------------------------
  // `paginateSection` pages ONE designated list and returns `otherSections`
  // carrying the un-paged lists' TRUE totals, which is exactly this payload's
  // shape. The section defaults to `downstream.effects`, falling back to the
  // section that EXISTS when `direction` omitted it — a default must not
  // refuse. Only an explicitly NAMED missing section is refused.
  const availableSections: PageableSection<UpstreamSource | DownstreamEffect>[] =
    [];
  if (upstreamPayload !== undefined) {
    availableSections.push({
      listId: 'upstream.sources',
      items: upstreamPayload.sources,
    });
  }
  if (downstreamPayload !== undefined) {
    availableSections.push({
      listId: 'downstream.effects',
      items: downstreamPayload.effects,
    });
  }

  const fingerprint = argsFingerprint({
    fieldId,
    direction: input.direction,
    maxDepth,
    includeFieldsOfTruth: includeSoT,
    includeFiresWhen,
  });
  const binding = {
    tool: 'sfi.field_lineage',
    vaultHash: ctx.manifest.sourceTreeHash,
    argsFingerprint: fingerprint,
  };

  let offset = input.offset ?? 0;
  let requestedSection = input.section;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, binding);
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
    // HANDLER CONTRACT: re-bind the designated section from the cursor.
    const listId = decoded.value.listId;
    if (listId !== undefined) {
      requestedSection = listId as (typeof FIELD_LINEAGE_SECTIONS)[number];
    }
  }

  if (
    requestedSection !== undefined &&
    !availableSections.some((sec) => sec.listId === requestedSection)
  ) {
    return err({
      kind: 'invalid-query',
      message: `section '${requestedSection}' is not present in this response: direction='${input.direction}' produced only ${availableSections
        .map((sec) => `'${sec.listId}'`)
        .join(', ')}. Pass a section this direction carries, or widen \`direction\`.`,
      path: 'section',
    });
  }

  const designated =
    requestedSection ??
    (availableSections.some((sec) => sec.listId === 'downstream.effects')
      ? 'downstream.effects'
      : (availableSections[0]?.listId as
          | (typeof FIELD_LINEAGE_SECTIONS)[number]
          | undefined));

  let pagedUpstream = upstreamPayload;
  let pagedDownstream = downstreamPayload;
  let pagingKeys: Record<string, unknown> = {};

  if (designated !== undefined) {
    const limit = input.limit ?? FIELD_LINEAGE_DEFAULT_LIMIT;
    const paged = paginateSection(availableSections, designated, {
      offset,
      limit,
      binding,
    });
    if (!paged.ok) return err(paged.error);
    const { items, pageInfo } = paged.value;
    const emit = pageInfo.hasMore || offset > 0;
    if (emit) {
      if (designated === 'upstream.sources' && pagedUpstream !== undefined) {
        pagedUpstream = {
          ...pagedUpstream,
          sources: items as readonly UpstreamSource[],
        };
      } else if (
        designated === 'downstream.effects' &&
        pagedDownstream !== undefined
      ) {
        pagedDownstream = {
          ...pagedDownstream,
          effects: items as readonly DownstreamEffect[],
        };
      }
      const other = paged.value.otherSections
        .map(
          (sec) =>
            `\`${sec.listId === 'upstream.sources' ? 'upstream.sourceCount' : 'downstream.effectCount'}\` reports the other section's total, which this page does not include`,
        )
        .join('; ');
      const totalKey =
        designated === 'upstream.sources'
          ? 'upstream.sourceCount'
          : 'downstream.effectCount';
      pagingKeys = {
        section: designated,
        limit,
        offset,
        hasMore: pageInfo.hasMore,
        nextOffset: pageInfo.hasMore ? offset + items.length : null,
        ...(pageInfo.nextCursor !== null
          ? { nextCursor: pageInfo.nextCursor }
          : {}),
        pageInfo,
        ...(pageInfo.hasMore
          ? {
              note: `Showing ${items.length} of ${pageInfo.totalCount} \`${designated}\` row(s) (offset=${offset}). MORE remain — advance with offset=${
                offset + items.length
              } or echo \`nextCursor\`. \`${totalKey}\` is the TRUE total${
                other === '' ? '' : `; ${other}`
              }.`,
            }
          : {}),
      };
    }
  }

  return ok({
    data: {
      fieldId,
      direction: input.direction,
      maxDepth,
      ...(pagedUpstream !== undefined && { upstream: pagedUpstream }),
      ...(pagedDownstream !== undefined && {
        downstream: pagedDownstream,
      }),
      boundaries,
      dataNotAvailable,
      cyclesDetected,
      ...pagingKeys,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
