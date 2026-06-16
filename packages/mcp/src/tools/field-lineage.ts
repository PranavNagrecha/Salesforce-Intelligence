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
 * does THIS writer get its value FROM?" — Flow input parameters / Apex
 * `readsFrom` edges / formula upstream / WorkflowRule criteriaItems /
 * integration-inbound external system (terminal) / v2.9 source-of-truth
 * field (terminal). The walk depth is bounded by `maxDepth` (default
 * 3, max 5); cycles are detected by `(fromId, toId, edgeType)` keying.
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
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { FIELD_360_Q165_DISCLOSURE } from './field-360.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import { mergeInputAliases } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
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
const fieldLineageInputBaseSchema = z.object({
  fieldId: z.string().min(1),
  direction: z.enum(DIRECTION_VALUES).optional().default('both'),
  maxDepth: z.number().int().min(1).max(HARD_CAP_MAX_DEPTH).optional(),
  includeFieldsOfTruth: z.boolean().optional(),
  includeFiresWhen: z.boolean().optional(),
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
    | 'formula-recompute';
  readonly effectId: ComponentId;
  readonly effectApiName: string;
  readonly depth: number;
  readonly confidence: ConfidenceLevel;
  readonly conditionId: ComponentId | null;
  readonly firesWhen: string | null;
}

/** Upstream payload. */
export interface UpstreamPayload {
  readonly sources: readonly UpstreamSource[];
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
}

/** Downstream payload. */
export interface DownstreamPayload {
  readonly effects: readonly DownstreamEffect[];
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
}

/** Reused Q165 boundary list — same as `field_360`. */
const FIELD_LINEAGE_DATA_NOT_AVAILABLE: readonly string[] = [
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
    { sources: UpstreamSource[]; truncated: boolean; cycles: boolean },
    McpError
  >
> => {
  const sources: UpstreamSource[] = [];
  const visited = new Set<ComponentId>([fieldId]);
  let truncated = false;
  let cycles = false;

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
      // Recurse only into writers that themselves write to other
      // fields. Apex/Flow writers may write to multiple downstream
      // fields, but for lineage we only follow further `writesTo`
      // edges into the writer's own field reads (which manifest as
      // incoming `writesTo` edges on the writer's target fields).
      if (
        sourceNode.type === 'CustomField' ||
        sourceNode.type === 'ApexClass' ||
        sourceNode.type === 'Flow'
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

  const r = await recurse(fieldId, 1, []);
  if (!r.ok) return r;
  return ok({ sources, truncated, cycles });
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
      truncatedAtDepth: r.value.truncated ? maxDepth : null,
      sourceOfTruthCount: r.value.sources.filter((s) => s.isSourceOfTruth)
        .length,
      formulaChain,
    };
  }
  if (input.direction === 'downstream' || input.direction === 'both') {
    const r = await walkDownstream(ctx, fieldId, maxDepth, includeFiresWhen);
    if (!r.ok) return r;
    if (r.value.cycles) cyclesDetected = true;
    downstreamPayload = {
      effects: r.value.effects,
      truncatedAtDepth: r.value.truncated ? maxDepth : null,
    };
  }

  const boundaries: string[] = [
    FIELD_360_Q165_DISCLOSURE,
    'list view column refs are extracted as graph edges but are NOT composed into field_lineage sections',
    'report/dashboard field usage is folded onto CustomField nodes (default capped pull or `--with-reports`); per-report breakdown is NOT composed here',
    'conditions in firesWhen edges are listed but NOT EVALUATED — the tool does not know whether the runtime record satisfies them',
    `lineage walk depth-bounded at ${maxDepth} hops; deeper transitive provenance is NOT walked in this response`,
  ];
  if (cyclesDetected) {
    boundaries.push(
      'cycle detected in the lineage walk; back-edges were short-circuited per the v2.7 cycle discipline',
    );
  }

  return ok({
    data: {
      fieldId,
      direction: input.direction,
      maxDepth,
      ...(upstreamPayload !== undefined && { upstream: upstreamPayload }),
      ...(downstreamPayload !== undefined && {
        downstream: downstreamPayload,
      }),
      boundaries,
      dataNotAvailable: FIELD_LINEAGE_DATA_NOT_AVAILABLE,
      cyclesDetected,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
