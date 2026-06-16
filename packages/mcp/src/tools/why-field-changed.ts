/**
 * Handler for the `sfi.why_field_changed` MCP tool.
 *
 * v2.0e W1 — the field-write-tracing headline. Answers the buyer-
 * priority #1 question: "why did this field get updated?". Walks every
 * incoming `writesTo` edge to the target CustomField and surfaces each
 * writer with its categorisation (declared vs heuristic), the
 * `firesWhen` ConditionalContext gating the write (when one exists),
 * and the trigger event when the writer is an ApexTrigger.
 *
 * Writer categorisation:
 *   - **declared** writers: producers whose metadata declaration IS
 *     the write contract — Flow recordCreates/Updates (`writesTo` at
 *     `declared` confidence), WorkflowRule field-update actions
 *     (`writesTo` at `declared` confidence), and ApprovalProcess
 *     actions. The platform will refuse to deploy these without the
 *     target field.
 *   - **heuristic** writers: producers whose write was inferred from
 *     a source scan rather than a metadata declaration — ApexClass /
 *     ApexTrigger writes emitted by the v0.3 Apex scanner with
 *     `source: 'apex-scanner'` and `confidence: 'heuristic'`. These
 *     may include false positives (dynamic SOQL, reflective access);
 *     callers should spot-check before acting on them.
 *
 * Implementation notes:
 *   - One `listEdges(fieldId, { direction: 'in', edgeType: 'writesTo' })`
 *     call retrieves every candidate edge; `getNodeById` resolves each
 *     `fromId` to a writer node. Sparse-graph misses are dropped
 *     silently (matches `safe-to-delete-field`'s tolerance).
 *   - For each writer, the handler fetches the writer's outgoing
 *     `firesWhen` ConditionalContext (when one exists) to expose the
 *     gating condition. Multi-condition writers (a Flow with several
 *     decisions, a WorkflowRule whose condition is a formula) surface
 *     their FIRST condition — callers wanting the full list re-query
 *     via `sfi.get_edges`.
 *   - For ApexTrigger writers, the handler ALSO fetches the trigger's
 *     `events` property and surfaces it on the writer entry. Apex
 *     scanner emits writes from triggers without per-event scoping,
 *     so the trigger's overall event list IS the per-write event
 *     surface.
 *   - The honesty axis is the categorisation itself: `declared`
 *     writers are deterministic; `heuristic` writers are flagged so
 *     the caller can show the confidence boundary to the user.
 */

import type {
  ComponentId,
  ComponentType,
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

import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/**
 * The verbatim honesty-axis disclosure surfaced in every response.
 * Frozen here so the test suite can assert the exact string and so a
 * caller-facing rephrasing during rendering is a code-review concern,
 * not a silent drift.
 */
const DISCLOSURE =
  "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.";

/**
 * Zod schema for the `sfi.why_field_changed` tool input.
 *
 *   - `fieldId`: required, non-empty string. The canonical CustomField
 *     id (`CustomField:{Object}.{Field}`). Non-`CustomField:` prefixes
 *     surface as `invalid-query` from the handler; unknown but
 *     well-formed ids surface as `component-not-found`.
 */
export const whyFieldChangedInputSchema = z.object({
  fieldId: z.string().min(1),
});

/** Parsed input shape, inferred from `whyFieldChangedInputSchema`. */
export type WhyFieldChangedInput = z.infer<typeof whyFieldChangedInputSchema>;

/**
 * One writer's condition reference. Carries the synthetic
 * ConditionalContext id and the parsed expression — the scalar fast-
 * path that lets a caller render "WorkflowRule X writes to this field
 * WHEN (Type = 'Tier 1')" without an extra graph traversal.
 */
export interface WhyFieldChangedCondition {
  readonly conditionContextId: ComponentId;
  readonly expression: string;
}

/**
 * One writer in the response. `id` / `type` / `apiName` identify the
 * writer node; `confidence` surfaces the edge-level confidence
 * (declared vs parsed vs heuristic — the categorisation axis);
 * `conditional` references the ConditionalContext gating the write
 * (when one exists); `triggerEvent` is the ApexTrigger's `events`
 * property concatenated when the writer is a trigger.
 */
export interface WhyFieldChangedWriter {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly confidence: ConfidenceLevel;
  readonly conditional?: WhyFieldChangedCondition;
  readonly triggerEvent?: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhyFieldChangedOutput {
  readonly fieldId: ComponentId;
  readonly writers: readonly WhyFieldChangedWriter[];
  readonly summary: {
    readonly declaredCount: number;
    readonly heuristicCount: number;
  };
  readonly disclosure: string;
}

/**
 * Surface the first `firesWhen` ConditionalContext for a writer
 * node. Returns `undefined` when the writer has no `firesWhen`
 * edges. The condition carries the synthetic id and the parsed
 * expression — enough for the caller to render the gating predicate
 * without an extra round trip.
 */
const surfaceFirstCondition = async (
  ctx: Context,
  writerId: ComponentId,
): Promise<Result<WhyFieldChangedCondition | undefined, string>> => {
  const edgesResult = await listEdges(ctx.graph, writerId, {
    direction: 'out',
    edgeType: 'firesWhen',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const firstEdge = edgesResult.value[0];
  if (firstEdge === undefined) return ok(undefined);
  const conditionNodeResult = await getNodeById(ctx.graph, firstEdge.toId);
  if (!conditionNodeResult.ok) return err(conditionNodeResult.error.message);
  if (conditionNodeResult.value === null) return ok(undefined);
  const conditionNode = conditionNodeResult.value;
  const expression = conditionNode.properties['expression'];
  return ok({
    conditionContextId: conditionNode.id,
    expression: typeof expression === 'string' ? expression : '',
  });
};

/**
 * For an ApexTrigger writer, surface the trigger's lifecycle events
 * as a comma-separated string (e.g., `'before insert, after update'`).
 * Returns `undefined` for non-trigger writers, or when the trigger
 * node lacks an `events` property in its properties block.
 */
const surfaceTriggerEvent = (writerNode: Node): string | undefined => {
  if (writerNode.type !== 'ApexTrigger') return undefined;
  const events = writerNode.properties['events'];
  if (!Array.isArray(events) || events.length === 0) return undefined;
  const stringEvents = events.filter((e): e is string => typeof e === 'string');
  if (stringEvents.length === 0) return undefined;
  return stringEvents.join(', ');
};

/**
 * Compose one `WhyFieldChangedWriter` entry from a single
 * `writesTo` edge + its resolved source node. Surfaces the
 * ConditionalContext, the trigger event, and the edge confidence;
 * returns null when the writer node has gone missing (sparse-graph
 * tolerance).
 */
const buildWriter = async (
  ctx: Context,
  edge: Edge,
  writerNode: Node,
): Promise<Result<WhyFieldChangedWriter, string>> => {
  const conditionResult = await surfaceFirstCondition(ctx, writerNode.id);
  if (!conditionResult.ok) return err(conditionResult.error);
  const triggerEvent = surfaceTriggerEvent(writerNode);
  const base: Omit<WhyFieldChangedWriter, 'conditional' | 'triggerEvent'> = {
    id: writerNode.id,
    type: writerNode.type,
    apiName: writerNode.apiName,
    confidence: edge.confidence,
  };
  const withCondition: WhyFieldChangedWriter =
    conditionResult.value === undefined
      ? base
      : { ...base, conditional: conditionResult.value };
  return ok(
    triggerEvent === undefined
      ? withCondition
      : { ...withCondition, triggerEvent },
  );
};

/**
 * The `sfi.why_field_changed` MCP tool. Returns every writer of the
 * given field with its confidence categorisation, the gating
 * condition (when one exists), and (for ApexTrigger writers) the
 * lifecycle event list. See the module JSDoc for the categorisation
 * design and the honesty axis.
 *
 * @example
 *   const r = await whyFieldChangedHandler(ctx, {
 *     fieldId: 'CustomField:Account.Industry__c',
 *   });
 *   if (r.ok) for (const w of r.value.data.writers) {
 *     console.log(w.apiName, w.confidence);
 *   }
 */
export const whyFieldChangedHandler = async (
  ctx: Context,
  input: WhyFieldChangedInput,
): Promise<Result<McpResponse<WhyFieldChangedOutput>, McpError>> => {
  if (!input.fieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }
  const fieldId = input.fieldId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, fieldId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      path: fieldId,
    });
  }

  const edgesResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
    edgeType: 'writesTo',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  const writers: WhyFieldChangedWriter[] = [];
  let declaredCount = 0;
  let heuristicCount = 0;
  for (const edge of edgesResult.value) {
    const fromResult = await getNodeById(ctx.graph, edge.fromId);
    if (!fromResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${fromResult.error.message}`,
      });
    }
    if (fromResult.value === null) continue;
    const writerResult = await buildWriter(ctx, edge, fromResult.value);
    if (!writerResult.ok) {
      return err({ kind: 'internal', message: writerResult.error });
    }
    const writer = writerResult.value;
    writers.push(writer);
    if (writer.confidence === 'heuristic') {
      heuristicCount += 1;
    } else {
      // `declared` and `parsed` both count as declared for this
      // categorisation. The parsed confidence ships from the v0.2
      // formula tokenizer; the field is still extracted from
      // metadata, not inferred from a body scan.
      declaredCount += 1;
    }
  }

  // Deterministic order by id so the response is stable across runs.
  const sortedWriters = [...writers].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  return ok({
    data: {
      fieldId,
      writers: sortedWriters,
      summary: { declaredCount, heuristicCount },
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
