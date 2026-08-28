/**
 * Handler for the `sfi.field_provenance` MCP tool.
 *
 * v2.9 R4 — the "is this field manually entered or automated?"
 * surface (PLAN-v2.9 §4). Given a CustomField canonical id, returns:
 *   - the v2.9 sourceOfTruth classification + confidence,
 *   - declared-as-formula trace (formula expression when present),
 *   - declared-as-auto-number trace (displayFormat when present),
 *   - ALL ApexClass writers (with `isIntegrationTagged` from v2.0a
 *     `references` edges to NamedCredential / ExternalDataSource),
 *   - ALL Flow writers,
 *   - ALL ApexTrigger writers,
 *   - ALL remaining writers (`otherWriters`) — WorkflowRule /
 *     ApprovalProcess field updates, LWC, Visualforce, and any other
 *     `writesTo` emitter — with their ComponentType and edge confidence,
 *   - `noWritersDetected` boolean,
 *   - boundaries.
 *
 * The tool lists EVERY writer, not just the ones used in the
 * classification cascade — callers can verify the classification's
 * basis (PLAN-v2.9 §4).
 *
 * Composition (PLAN-v2.9 §14):
 *   - Reads CustomField + `properties.sourceOfTruth`.
 *   - Walks incoming `writesTo` edges, partitioned by source-node type,
 *     with no type discarded.
 *   - For each ApexClass writer, walks outgoing `references` edges to
 *     check v2.0a integration tagging (NamedCredential /
 *     ExternalDataSource targets).
 *
 * Honesty axis (PLAN-v2.9 §4):
 *   - "dynamic SOQL, reflective field access, and managed-package
 *     writers may be invisible" — always surfaced. It does NOT cover
 *     the non-canonical writer families, which are modeled and
 *     declared: those get their own counted disclosure.
 *   - Writers outside the three canonical arrays are named, counted,
 *     and disclosed by ComponentType so an empty apex/flow/trigger
 *     trace is never read as an absence of writers.
 *   - Classification missing → surfaced as a separate boundary; the
 *     trace still emits whatever writers exist so the caller can
 *     verify manually.
 *
 * Implementation notes:
 *   - Input validation: `fieldId` must start with `CustomField:`.
 *   - Unknown ids surface as `component-not-found`.
 *   - Writers are partitioned into the three canonical arrays (apex,
 *     flow, trigger); a writer of ANY other ComponentType lands in
 *     `otherWriters` with its `componentType` and edge `confidence`.
 *     `writesTo` is emitted by ten extractors, not three — dropping the
 *     other seven made `noWritersDetected` report "nothing writes this
 *     field" about a field a WorkflowRule field update writes on every
 *     save, and made this tool contradict `sfi.automation_collisions`
 *     about the same field by construction. A `writesTo` edge whose
 *     SOURCE node is absent from the vault (managed package / outside
 *     the retrieve scope) is COUNTED as `unresolvedWriterCount` — the
 *     edge survives import and `listEdges` returns it, so dropping it
 *     silently let `noWritersDetected` read true over an edge list that
 *     asserted a writer.
 *   - `noWritersDetected` is true when ALL FOUR writer arrays are empty,
 *     `unresolvedWriterCount` is 0, AND the field has no formula / no
 *     auto-number. PLAN-v2.9 Q151
 *     specifies false for formula fields (the formula IS the source —
 *     not absent).
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

import { fieldNotFoundError } from './field-not-found-suggest.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/** Verbatim honesty boundaries (PLAN-v2.9 §4). */
const BOUNDARY_WRITES_INVISIBLE =
  'Dynamic SOQL, reflective field access (e.g., put()/get() with runtime keys), and managed-package writers may be invisible to the trace — a writer not listed here may still exist at runtime.';
const BOUNDARY_CLASSIFICATION_HEURISTIC =
  'Classification is heuristic on writes-fabric inference — integration-tagged Apex without a references edge may be misclassified.';
const BOUNDARY_CLASSIFICATION_MISSING =
  'Vocabulary classifier has not run for this vault — sourceOfTruth defaults to unknown. Run `sfi refresh --rebuild-vocabulary` to populate it.';

/** How many writer ids the un-partitioned-writers sentence enumerates. */
const MAX_ENUMERATED_OTHER_WRITERS = 10;

/**
 * Build the "writers outside the three canonical arrays" disclosure.
 *
 * `writesTo` is emitted by ten extractors — WorkflowRule field updates,
 * ApprovalProcess field updates, LWC bundles, Visualforce pages and
 * components, the flow dataflow pass, and the Apex family. The trace
 * partitions three of those and the other seven used to be dropped on the
 * floor, which made an empty `apexWriters`/`flowWriters`/`triggerWriters`
 * read as "nothing writes this field" about a field a workflow writes on
 * every save. `BOUNDARY_WRITES_INVISIBLE` does NOT cover this case: those
 * edges are modeled, declared-confidence, and present in the graph — they
 * were simply not surfaced.
 */
/**
 * Build the "a writer edge names a component this vault does not hold"
 * disclosure. `listEdges` returns the edge; `getNodeById` on its `fromId`
 * returns null. Dropping those silently let `noWritersDetected` read true over
 * an edge list that asserted a writer.
 */
const unresolvedWritersBoundary = (
  writerIds: readonly string[],
): string => {
  const shown = writerIds.slice(0, MAX_ENUMERATED_OTHER_WRITERS);
  const rest = writerIds.length - shown.length;
  const ids =
    rest > 0 ? `${shown.join(', ')}, … and ${rest} more` : shown.join(', ');
  return (
    `${writerIds.length} \`writesTo\` edge(s) into this field name a writer that is NOT a ` +
    `component in this vault — a managed-package component, or one this refresh did not ` +
    `retrieve (${ids}). The WRITE is declared and real; the writer cannot be named here, so ` +
    '`resolve` / `get_component` on that id returns component-not-found. Surfaced as ' +
    '`trace.unresolvedWriterCount`, and counted against `noWritersDetected`.'
  );
};

const otherWritersBoundary = (
  writers: readonly FieldProvenanceOtherWriter[],
): string => {
  const types = [...new Set(writers.map((w) => w.componentType))].sort();
  const shown = writers.slice(0, MAX_ENUMERATED_OTHER_WRITERS);
  const rest = writers.length - shown.length;
  const ids = shown.map((w) => w.componentId).join(', ');
  const idList = rest > 0 ? `${ids}, … and ${rest} more` : ids;
  return (
    `${writers.length} writer(s) of type(s) ${types.join(', ')} also write this field via ` +
    '`writesTo` edges but fall OUTSIDE the three canonical writer arrays ' +
    `(\`apexWriters\` / \`flowWriters\` / \`triggerWriters\`): ${idList}. They are listed in ` +
    '`trace.otherWriters` with their per-writer confidence — an empty apex/flow/trigger trace ' +
    'is NOT "nothing writes this field".'
  );
};

/**
 * The five-value sourceOfTruth classification per PLAN-v2.9 §3.
 * Duplicated from `field-meaning.ts` so the two tools' output unions
 * stay independent — the contract surfaces (R1b) will hoist the
 * shared type to `@sf-intelligence/contracts`.
 */
export type SourceOfTruthClassification =
  | 'manual'
  | 'derived'
  | 'integration-synced'
  | 'manual-and-coded'
  | 'unknown';

/** One classification with its confidence label. */
export interface FieldProvenanceClassification {
  readonly value: SourceOfTruthClassification;
  readonly confidence: 'declared' | 'heuristic';
}

/** Declared-as-formula trace entry per PLAN-v2.9 §4. */
export interface FieldProvenanceDeclaredFormula {
  readonly formula: string;
}

/** Declared-as-auto-number trace entry per PLAN-v2.9 §4. */
export interface FieldProvenanceDeclaredAutoNumber {
  readonly displayFormat: string;
}

/**
 * One ApexClass writer entry. `isIntegrationTagged` derives from v2.0a
 * `references` edges from the class to a NamedCredential or
 * ExternalDataSource — the v2.9 integration-synced classifier signal.
 */
export interface FieldProvenanceApexWriter {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly isIntegrationTagged: boolean;
}

/** One Flow writer entry. */
export interface FieldProvenanceFlowWriter {
  readonly componentId: ComponentId;
  readonly apiName: string;
}

/** One ApexTrigger writer entry. */
export interface FieldProvenanceTriggerWriter {
  readonly componentId: ComponentId;
  readonly apiName: string;
}

/**
 * One writer whose ComponentType is NOT one of the three canonical writer
 * families — a WorkflowRule / ApprovalProcess field update, an LWC bundle, a
 * Visualforce page or component, or any other `writesTo` emitter. Carries the
 * declaring ComponentType and the edge's stored confidence so the caller can
 * weigh a declared field update differently from a heuristic UI-scanner hit.
 */
export interface FieldProvenanceOtherWriter {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly componentType: string;
  readonly confidence: ConfidenceLevel;
}

/** The provenance trace block per PLAN-v2.9 §4 output schema. */
export interface FieldProvenanceTrace {
  readonly declaredAsFormula: FieldProvenanceDeclaredFormula | null;
  readonly declaredAsAutoNumber: FieldProvenanceDeclaredAutoNumber | null;
  readonly apexWriters: readonly FieldProvenanceApexWriter[];
  readonly flowWriters: readonly FieldProvenanceFlowWriter[];
  readonly triggerWriters: readonly FieldProvenanceTriggerWriter[];
  /**
   * Every remaining `writesTo` source, by ComponentType. NEVER dropped: this
   * array is what stops `noWritersDetected` from being decided by three array
   * lengths over an edge list that held more.
   */
  readonly otherWriters: readonly FieldProvenanceOtherWriter[];
  /** `otherWriters.length`, surfaced for callers that read counts only. */
  readonly otherWriterCount: number;
  /** Distinct ComponentTypes present in `otherWriters`, sorted ASC. */
  readonly otherWriterTypes: readonly string[];
  /**
   * `writesTo` edges whose SOURCE component is not a node in this vault —
   * a managed-package class, or one this refresh did not retrieve. The edge
   * is declared and real; the writer cannot be named. Counted, never
   * dropped: an unnameable writer is still a detected writer.
   */
  readonly unresolvedWriterCount: number;
  readonly noWritersDetected: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FieldProvenanceOutput {
  readonly fieldId: ComponentId;
  readonly apiName: string;
  readonly classification: FieldProvenanceClassification;
  readonly trace: FieldProvenanceTrace;
  readonly boundaries: readonly string[];
}

/** Allowed sourceOfTruth values for the property-shape guard. */
const SOURCE_OF_TRUTH_VALUES: ReadonlySet<string> = new Set([
  'manual',
  'derived',
  'integration-synced',
  'manual-and-coded',
  'unknown',
]);

/**
 * Zod schema for the `sfi.field_provenance` tool input.
 *
 *   - `fieldId`: required, non-empty string. The canonical CustomField
 *     id. Prefix is enforced at the handler boundary.
 */
export const fieldProvenanceInputSchema = z.object({
  fieldId: z.string().min(1),
});

/** Parsed input shape, inferred from the Zod schema. */
export type FieldProvenanceInput = z.infer<typeof fieldProvenanceInputSchema>;

/**
 * Pull the sourceOfTruth classification from the field's properties.
 * Returns `{ value: 'unknown', confidence: 'heuristic' }` when the
 * property is absent or malformed — surfaces as the
 * classification-missing boundary in the response.
 */
const readSourceOfTruth = (
  node: Node,
): {
  classification: FieldProvenanceClassification;
  populated: boolean;
} => {
  const raw = node.properties['sourceOfTruth'];
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const value = obj['value'];
    const confidence = obj['confidence'];
    if (
      typeof value === 'string' &&
      SOURCE_OF_TRUTH_VALUES.has(value) &&
      (confidence === 'declared' || confidence === 'heuristic')
    ) {
      return {
        classification: {
          value: value as SourceOfTruthClassification,
          confidence,
        },
        populated: true,
      };
    }
  }
  return {
    classification: { value: 'unknown', confidence: 'heuristic' },
    populated: false,
  };
};

/**
 * Read the formula expression from `properties.formula`. Returns
 * `null` when the field is not a formula. Some extractors emit the
 * formula text under `properties.formula`; others under
 * `properties.formulaExpression`. Both are checked.
 */
const readFormula = (node: Node): FieldProvenanceDeclaredFormula | null => {
  const direct = node.properties['formula'];
  if (typeof direct === 'string' && direct.length > 0) {
    return { formula: direct };
  }
  const alt = node.properties['formulaExpression'];
  if (typeof alt === 'string' && alt.length > 0) {
    return { formula: alt };
  }
  return null;
};

/**
 * Pull the field type from `properties.type` or `properties.dataType`.
 */
const readFieldType = (node: Node): string => {
  const direct = node.properties['type'];
  if (typeof direct === 'string') return direct;
  const dataType = node.properties['dataType'];
  return typeof dataType === 'string' ? dataType : '';
};

/**
 * Read the auto-number displayFormat when the field's type is
 * `AutoNumber`. Returns `null` for any other field type.
 */
const readAutoNumber = (
  node: Node,
): FieldProvenanceDeclaredAutoNumber | null => {
  if (readFieldType(node) !== 'AutoNumber') return null;
  const displayFormat = node.properties['displayFormat'];
  if (typeof displayFormat === 'string' && displayFormat.length > 0) {
    return { displayFormat };
  }
  // Auto-number with no captured displayFormat: still emit the trace
  // entry so the caller sees the field IS auto-number; just with
  // empty displayFormat (the extractor may not capture every dialect).
  return { displayFormat: '' };
};

/**
 * Decide whether an ApexClass writer is integration-tagged: walk its
 * outgoing `references` edges and check whether any target is a
 * NamedCredential or ExternalDataSource. The v2.0a integration-
 * adjacency signal (PLAN-v2.9 §3 rule 3).
 */
const isApexWriterIntegrationTagged = async (
  ctx: Context,
  apexClassId: ComponentId,
): Promise<Result<boolean, string>> => {
  const edgesResult = await listEdges(ctx.graph, apexClassId, {
    direction: 'out',
    edgeType: 'references',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  for (const edge of edgesResult.value) {
    if (
      edge.toId.startsWith('NamedCredential:') ||
      edge.toId.startsWith('ExternalDataSource:')
    ) {
      return ok(true);
    }
  }
  return ok(false);
};

/**
 * Resolve all writers for a field: walk incoming `writesTo` edges,
 * resolve each source node, and partition by ComponentType. The three
 * canonical families keep their dedicated arrays; EVERY OTHER writer type
 * lands in `otherWriters` rather than being dropped. Sparse-graph misses (a
 * `writesTo` edge whose source node is no longer in the graph) are dropped
 * silently.
 */
const collectWriters = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<
  Result<
    {
      apexWriters: readonly FieldProvenanceApexWriter[];
      flowWriters: readonly FieldProvenanceFlowWriter[];
      triggerWriters: readonly FieldProvenanceTriggerWriter[];
      otherWriters: readonly FieldProvenanceOtherWriter[];
      unresolvedWriterIds: readonly string[];
    },
    string
  >
> => {
  const edgesResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
    edgeType: 'writesTo',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const edges: readonly Edge[] = edgesResult.value;

  const apex: FieldProvenanceApexWriter[] = [];
  const flow: FieldProvenanceFlowWriter[] = [];
  const trigger: FieldProvenanceTriggerWriter[] = [];
  const other: FieldProvenanceOtherWriter[] = [];
  const unresolved: string[] = [];

  for (const edge of edges) {
    const fromResult = await getNodeById(ctx.graph, edge.fromId);
    if (!fromResult.ok) return err(fromResult.error.message);
    const fromNode = fromResult.value;
    if (fromNode === null) {
      // The edge is real and declared; the writer is simply not a node in
      // this vault. Counting it is the difference between "no writer" and
      // "a writer we cannot name".
      unresolved.push(edge.fromId);
      continue;
    }
    if (fromNode.type === 'ApexClass') {
      const taggedResult = await isApexWriterIntegrationTagged(
        ctx,
        fromNode.id,
      );
      if (!taggedResult.ok) return err(taggedResult.error);
      apex.push({
        componentId: fromNode.id,
        apiName: fromNode.apiName,
        isIntegrationTagged: taggedResult.value,
      });
    } else if (fromNode.type === 'Flow') {
      flow.push({ componentId: fromNode.id, apiName: fromNode.apiName });
    } else if (fromNode.type === 'ApexTrigger') {
      trigger.push({ componentId: fromNode.id, apiName: fromNode.apiName });
    } else {
      // `writesTo` is emitted by ten extractors, not three. A WorkflowRule
      // or ApprovalProcess field update, an LWC, or a Visualforce page is a
      // real, modeled, declared writer; dropping it here is what made
      // `noWritersDetected` lie about a field a workflow writes on every
      // save. The three canonical arrays keep their contract shape and the
      // remainder is surfaced here instead of on the floor.
      other.push({
        componentId: fromNode.id,
        apiName: fromNode.apiName,
        componentType: fromNode.type,
        confidence: edge.confidence,
      });
    }
  }

  // Deterministic sort: componentId ASC per writer array.
  apex.sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );
  flow.sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );
  trigger.sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );
  other.sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );

  unresolved.sort();

  return ok({
    apexWriters: apex,
    flowWriters: flow,
    triggerWriters: trigger,
    otherWriters: other,
    unresolvedWriterIds: unresolved,
  });
};

/**
 * The `sfi.field_provenance` MCP tool. Returns the field's
 * sourceOfTruth classification + the structural trace listing every
 * writer with v2.0a integration tagging for Apex writers. See module
 * JSDoc for the trace shape and the honesty axis.
 *
 * @example
 *   const r = await fieldProvenanceHandler(ctx, {
 *     fieldId: 'CustomField:Contact.External_Customer_Id__c',
 *   });
 *   if (r.ok) console.log(r.value.data.trace.apexWriters);
 */
export const fieldProvenanceHandler = async (
  ctx: Context,
  input: FieldProvenanceInput,
): Promise<Result<McpResponse<FieldProvenanceOutput>, McpError>> => {
  // FLD-02: graceful object→field routing — return the object's field list
  // when the caller passes a CustomObject id instead of a CustomField id.
  const suggestionResult = await resolveToFieldOrSuggest(ctx, input.fieldId);
  if (!suggestionResult.ok) return suggestionResult;
  if (suggestionResult.value !== null) {
    return ok(suggestionResult.value as unknown as McpResponse<FieldProvenanceOutput>);
  }

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
    return err(
      await fieldNotFoundError(
        ctx,
        fieldId,
        await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      ),
    );
  }
  const node = nodeResult.value;
  if (node.type !== 'CustomField') {
    return err({
      kind: 'component-not-found',
      message: `node ${fieldId} is not a CustomField (type=${node.type})`,
      path: fieldId,
    });
  }

  const classification = readSourceOfTruth(node);
  const declaredAsFormula = readFormula(node);
  const declaredAsAutoNumber = readAutoNumber(node);

  const writersResult = await collectWriters(ctx, fieldId);
  if (!writersResult.ok) {
    return err({ kind: 'internal', message: writersResult.error });
  }
  const {
    apexWriters,
    flowWriters,
    triggerWriters,
    otherWriters,
    unresolvedWriterIds,
  } = writersResult.value;
  const otherWriterTypes = [
    ...new Set(otherWriters.map((w) => w.componentType)),
  ].sort();

  // PLAN-v2.9 Q151: formula fields are NOT noWritersDetected — the
  // formula IS the source. Same for auto-number.
  //
  // `otherWriters` is part of this predicate BY CONSTRUCTION: the answer is
  // "no writer was detected", and a writer the partition declined to bucket
  // is still a writer that was detected.
  const noWritersDetected =
    declaredAsFormula === null &&
    declaredAsAutoNumber === null &&
    apexWriters.length === 0 &&
    flowWriters.length === 0 &&
    triggerWriters.length === 0 &&
    otherWriters.length === 0 &&
    unresolvedWriterIds.length === 0;

  const boundaries: string[] = [BOUNDARY_WRITES_INVISIBLE];
  if (otherWriters.length > 0) {
    boundaries.push(otherWritersBoundary(otherWriters));
  }
  if (unresolvedWriterIds.length > 0) {
    boundaries.push(unresolvedWritersBoundary(unresolvedWriterIds));
  }
  if (classification.classification.confidence === 'heuristic') {
    boundaries.push(BOUNDARY_CLASSIFICATION_HEURISTIC);
  }
  if (!classification.populated) {
    boundaries.push(BOUNDARY_CLASSIFICATION_MISSING);
  }

  return ok({
    data: {
      fieldId,
      apiName: node.apiName,
      classification: classification.classification,
      trace: {
        declaredAsFormula,
        declaredAsAutoNumber,
        apexWriters,
        flowWriters,
        triggerWriters,
        otherWriters,
        otherWriterCount: otherWriters.length,
        otherWriterTypes,
        unresolvedWriterCount: unresolvedWriterIds.length,
        noWritersDetected,
      },
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
