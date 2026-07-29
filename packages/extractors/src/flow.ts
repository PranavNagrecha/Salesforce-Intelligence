import { readFile } from 'node:fs/promises';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  extractConditions,
  type ConditionSource,
  type CriteriaItem,
} from './condition-extractor.js';
import {
  buildFlowDataflowIndex,
  DATAFLOW_SOURCE_OPERATION,
  traceValueReference,
  type DataflowConfidence,
  type FlowDataflowIndex,
} from './flow-dataflow.js';
import { deriveComponentApiName } from './path-utils.js';

const FLOW_FILE_SUFFIX = '.flow-meta.xml';
const ROOT_ELEMENT = 'Flow';

/**
 * The fast-xml-parser options shared by every Flow-XML entry point —
 * {@link extractFlow} and the flow-graph projection (`flow-graph.ts`). Flow
 * metadata files are local trusted disk content sourced from `sf project
 * retrieve`, so XXE is not a concern; the default 1000 entity-expansion limit
 * is too tight for real production Flows, so it is raised to 10000 while
 * preserving a pathological-input ceiling. Exported (rather than re-declared)
 * so the two entry points parse byte-identically.
 */
export const FLOW_XML_PARSER_OPTIONS = {
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: { maxTotalExpansions: 10000 },
};
// <apiVersion> is OPTIONAL: auto-generated flows (record-triggered
// PolicyCondition_* helpers, screen flows like customer_satisfaction) omit
// it. It is NOT required for extraction — the node carries `number | null`
// and the read site below defaults a missing/unparseable value to null.
const REQUIRED_ELEMENTS = ['label', 'processType', 'status'] as const;
const ALLOWED_STATUS = ['Active', 'Draft', 'Obsolete', 'InvalidDraft'] as const;
const EDGE_SOURCE = 'flow-extractor';
/**
 * The set of `<start><triggerType>` values for which we emit a
 * `triggersOn` edge to `<start><object>`. Non-record-triggered flows
 * (autolaunched, screen, scheduled) don't carry an SObject target on
 * `<start>` and so produce no edge here.
 */
const RECORD_TRIGGER_TYPES = new Set([
  'RecordAfterSave',
  'RecordBeforeSave',
  'RecordBeforeDelete',
]);

/**
 * The set of `<start><triggerType>` values for which `$Record` (and
 * `$Record__Prior`) names a concrete record whose SObject type is the
 * `<start><object>`. This is a SUPERSET of {@link RECORD_TRIGGER_TYPES}:
 * a `Scheduled` flow runs over the records matching its schedule filter on
 * `<start><object>`, so an `<inputReference>$Record</inputReference>` DML
 * inside a scheduled flow updates THAT object — the same object the flow is
 * scheduled on. Without this, a scheduled flow's `$Record` update was dropped
 * with a misleading "has no <object>" warning, making `explain_flow` /
 * `what_happens_on_save` report no write target (or, worse, letting the
 * synthesis layer mistake the unresolved warning for a cross-object write).
 * `Scheduled` is intentionally NOT in `RECORD_TRIGGER_TYPES` because it does
 * not get a record-trigger `triggersOn` edge; it only resolves `$Record`.
 */
const RECORD_SCOPED_TRIGGER_TYPES = new Set([
  ...RECORD_TRIGGER_TYPES,
  'Scheduled',
]);

type FlowStatus = (typeof ALLOWED_STATUS)[number];

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Flow elements the extractor reads are all
 * single-occurrence; this helper tolerates either shape.
 */
export const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. fast-xml-parser
 * emits an object when an element appears once and an array when it
 * appears multiple times. Flow's `<actionCalls>`, `<recordLookups>`,
 * etc. may appear any number of times, so call sites consume an array.
 * Returns `[]` for `undefined`/`null`.
 */
export const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Coerce an XML scalar element to a nullable string. Missing or
 * `undefined` becomes `null`; everything else stringifies. Used for
 * optional string-valued elements that default to `null`.
 */
export const toNullableString = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  if (v === undefined || v === null) return null;
  return String(v);
};

/**
 * Coerce an XML scalar element to a non-empty trimmed string. Returns
 * `null` when the element is missing, empty, or whitespace-only.
 * Edge-emission rules treat such values as "no object specified" and
 * record a warning rather than emit a malformed-id edge.
 */
export const toNonEmptyString = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
};

/**
 * Read and strictly-validate a file as XML. fast-xml-parser's `parse()`
 * is permissive (it silently truncates on mismatched tags), so we
 * validate first to surface malformed input as `parse-error` rather than
 * a misleading partial extraction.
 */
const readAndValidateXml = async (
  path: string,
): Promise<Result<string, ExtractorError>> => {
  let xmlText: string;
  try {
    xmlText = await readFile(path, 'utf-8');
  } catch (cause: unknown) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      (cause as { code?: string }).code === 'ENOENT'
    ) {
      return err({ kind: 'file-not-found', path, message: 'file not found' });
    }
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return err({ kind: 'parse-error', path, message: validation.err.msg });
  }
  return ok(xmlText);
};

/**
 * Locate and validate the `<Flow>` root in a parsed XML tree, then
 * verify every required child element is present.
 */
const validateRoot = (
  parsed: Record<string, unknown>,
  path: string,
): Result<Record<string, unknown>, ExtractorError> => {
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const rootObj = root as Record<string, unknown>;
  for (const required of REQUIRED_ELEMENTS) {
    if (rootObj[required] === undefined) {
      return err({
        kind: 'malformed-input',
        path,
        message: `missing required element: <${required}>`,
      });
    }
  }
  return ok(rootObj);
};

/**
 * Pull `object`, `triggerType`, `recordTriggerType`, and the optional
 * `<schedule>` sub-block from the `<start>` subtree. Returns all-null
 * when `<start>` is absent (e.g., autolaunched flows without a record
 * trigger).
 *
 * T7: `<start><schedule>` is present on scheduled flows
 * (`triggerType: Scheduled`). Its `<frequency>` (e.g. `Weekly`),
 * `<startDate>` (`2024-11-09`), and `<startTime>` (`08:00:00.000Z`) are
 * the flow's design-time schedule. `<startTime>` is UTC (the trailing
 * `Z`); the local wall-clock run time depends on the org's default
 * timezone, which the vault does not hold — so consumers must disclose
 * the UTC framing rather than imply a local time. This is the FLOW
 * schedule (declared in metadata), distinct from an Apex Schedulable's
 * runtime CronTrigger registration, which lives only in the Tooling API.
 */
const extractStartProperties = (
  rootObj: Record<string, unknown>,
): {
  triggerObject: string | null;
  triggerType: string | null;
  recordTriggerType: string | null;
  scheduleFrequency: string | null;
  scheduleStartDate: string | null;
  scheduleStartTime: string | null;
  scheduledPathTypes: string[];
  runAsyncAfterCommit: boolean;
  /**
   * True when the `<start>` element carries a direct `<connector>` child that
   * is NOT inside a `<scheduledPaths>` element. A direct connector means the
   * flow has an immediate synchronous execution path that fires within the
   * same transaction as the triggering DML.
   *
   * A record-triggered after-save flow with `hasImmediateConnector: false`
   * that has `scheduledPaths` executes ONLY via its scheduled/async paths —
   * it never fires synchronously within the triggering save transaction.
   * Such flows belong in `post-save-async`, not `post-save-flows`, in the
   * Salesforce Order of Execution.
   */
  hasImmediateConnector: boolean;
} => {
  const start = unwrapSingle(rootObj['start']);
  if (typeof start !== 'object' || start === null) {
    return {
      triggerObject: null,
      triggerType: null,
      recordTriggerType: null,
      scheduleFrequency: null,
      scheduleStartDate: null,
      scheduleStartTime: null,
      scheduledPathTypes: [],
      runAsyncAfterCommit: false,
      hasImmediateConnector: false,
    };
  }
  const startObj = start as Record<string, unknown>;
  const schedule = unwrapSingle(startObj['schedule']);
  const scheduleObj =
    typeof schedule === 'object' && schedule !== null
      ? (schedule as Record<string, unknown>)
      : null;
  const scheduledPathTypes = extractScheduledPathTypes(startObj);
  // A direct `<connector>` child of `<start>` (not inside `<scheduledPaths>`)
  // indicates a synchronous execution path. fast-xml-parser parses `<connector>`
  // as an object or array; its presence (non-null/undefined) is sufficient.
  const hasImmediateConnector =
    startObj['connector'] !== undefined && startObj['connector'] !== null;
  return {
    triggerObject: toNullableString(startObj['object']),
    triggerType: toNullableString(startObj['triggerType']),
    recordTriggerType: toNullableString(startObj['recordTriggerType']),
    scheduleFrequency:
      scheduleObj === null ? null : toNonEmptyString(scheduleObj['frequency']),
    scheduleStartDate:
      scheduleObj === null ? null : toNonEmptyString(scheduleObj['startDate']),
    scheduleStartTime:
      scheduleObj === null ? null : toNonEmptyString(scheduleObj['startTime']),
    scheduledPathTypes,
    runAsyncAfterCommit: scheduledPathTypes.includes(ASYNC_AFTER_COMMIT_PATH),
    hasImmediateConnector,
  };
};

/**
 * The `<scheduledPaths><scheduledPaths><pathType>` marker Salesforce stamps on
 * the immediate post-commit ASYNCHRONOUS path of a record-triggered (after-save)
 * flow. Such a path runs in a SEPARATE transaction AFTER the triggering save has
 * already committed, so an unhandled fault on it cannot roll the save back —
 * `explain_flow`'s fault-rollback verdict needs this distinction (bundle-3).
 */
const ASYNC_AFTER_COMMIT_PATH = 'AsyncAfterCommit';

/**
 * Collect the `<pathType>` of every `<start><scheduledPaths>` entry, in source
 * order. A record-triggered after-save flow can declare scheduled paths: a
 * `pathType` of `AsyncAfterCommit` is the immediate-async post-commit path; an
 * absent `pathType` (or a time-based scheduled path) carries a real delay. We
 * surface only the declared `pathType` strings (skipping empty ones) so
 * consumers — chiefly `explain_flow.buildFaultRollback` — can tell an async
 * post-commit path from a synchronous one without re-parsing the XML.
 */
const extractScheduledPathTypes = (
  startObj: Record<string, unknown>,
): string[] => {
  const out: string[] = [];
  for (const path of toArray(startObj['scheduledPaths'])) {
    if (typeof path !== 'object' || path === null) continue;
    const pathType = toNonEmptyString((path as Record<string, unknown>)['pathType']);
    if (pathType !== null) out.push(pathType);
  }
  return out;
};

/**
 * Build a `triggersOn` edge for a record-triggered Flow.
 *
 * Emits one edge from the Flow to its `<start><object>` when both:
 *   - `<start><triggerType>` is in {RecordAfterSave, RecordBeforeSave,
 *     RecordBeforeDelete}.
 *   - `<start><object>` is a non-empty string.
 *
 * Returns `null` (no edge) for autolaunched/screen/scheduled flows or
 * when the object is missing.
 *
 * Carries `confidence: 'declared'` because `<start><object>` is
 * Salesforce's own declaration of the Flow's target SObject — not
 * something we inferred from a body walk.
 */
const buildStartEdge = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
): Edge | null => {
  try {
    const start = unwrapSingle(rootObj['start']);
    if (typeof start !== 'object' || start === null) return null;
    const startObj = start as Record<string, unknown>;
    const triggerType = toNonEmptyString(startObj['triggerType']);
    if (triggerType === null || !RECORD_TRIGGER_TYPES.has(triggerType)) {
      return null;
    }
    const object = toNonEmptyString(startObj['object']);
    if (object === null) {
      warnings.push(`<start> has triggerType ${triggerType} but no <object>`);
      return null;
    }
    const recordTriggerType = toNullableString(startObj['recordTriggerType']);
    return {
      fromId: flowId,
      toId: `CustomObject:${object}`,
      edgeType: 'triggersOn',
      confidence: 'declared',
      source: EDGE_SOURCE,
      properties: { triggerType, recordTriggerType },
    };
  } catch (cause: unknown) {
    warnings.push(
      `failed to read <start>: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  }
};

/**
 * Build a v1.5 `listensTo` edge for a Platform-Event-triggered Flow.
 *
 * Emits one edge from the Flow to its `<start><object>` when:
 *   - `<start><triggerType>` is `PlatformEvent`.
 *   - `<start><object>` is a non-empty string.
 *
 * Returns `null` for record-triggered / autolaunched / screen / scheduled
 * flows, or when the object is missing.
 *
 * The Flow's pre-v1.5 `triggersOn` production (above) is unchanged;
 * this `listensTo` production is **additive** — see
 * `IntegrationTopologySemantics.md` §"Rule 3: Flow with PlatformEvent
 * start". The `triggersOn` builder above filters on
 * `RECORD_TRIGGER_TYPES` so it does not double-emit for
 * `PlatformEvent` start.
 *
 * Carries `confidence: 'declared'` per Rule 3.
 */
const buildPlatformEventListensToEdge = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
): Edge | null => {
  try {
    const start = unwrapSingle(rootObj['start']);
    if (typeof start !== 'object' || start === null) return null;
    const startObj = start as Record<string, unknown>;
    const triggerType = toNonEmptyString(startObj['triggerType']);
    if (triggerType !== 'PlatformEvent') return null;
    const object = toNonEmptyString(startObj['object']);
    if (object === null) {
      warnings.push(
        `<start> has triggerType PlatformEvent but no <object>`,
      );
      return null;
    }
    return {
      fromId: flowId,
      toId: `CustomObject:${object}`,
      edgeType: 'listensTo',
      confidence: 'declared',
      source: EDGE_SOURCE,
      properties: { eventName: object, mechanism: 'platformEventStart' },
    };
  } catch (cause: unknown) {
    warnings.push(
      `failed to read <start>: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  }
};

/**
 * Build `callsApex` edges from `<actionCalls>` elements whose
 * `<actionType>` is `apex`. Each apex-typed action call yields one edge
 * to `ApexClass:{actionName}`.
 *
 * Non-apex action types (`emailAlert`, `emailSimple`, `chatterPost`,
 * `flow`, etc.) are deferred to v0.3 and produce no edges here — but
 * they don't warn either, since they're a normal part of Flow XML, not
 * an inconsistency.
 *
 * Edges carry `confidence: 'parsed'` (we parsed them out of the XML)
 * with `properties.actionType: 'apex'`. Duplicates by toId are
 * collapsed in the outer dedup pass.
 */
const buildActionCallEdges = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
): Edge[] => {
  const edges: Edge[] = [];
  const actionCalls = toArray(rootObj['actionCalls']);
  for (let i = 0; i < actionCalls.length; i += 1) {
    const call = actionCalls[i];
    try {
      if (typeof call !== 'object' || call === null) continue;
      const callObj = call as Record<string, unknown>;
      const actionType = toNonEmptyString(callObj['actionType']);
      if (actionType !== 'apex') continue;
      const actionName = toNonEmptyString(callObj['actionName']);
      if (actionName === null) {
        warnings.push(
          `<actionCalls>[${i}] has actionType=apex but no <actionName>`,
        );
        continue;
      }
      edges.push({
        fromId: flowId,
        toId: `ApexClass:${actionName}`,
        edgeType: 'callsApex',
        confidence: 'parsed',
        source: EDGE_SOURCE,
        properties: { actionType: 'apex' },
      });
    } catch (cause: unknown) {
      warnings.push(
        `failed to read <actionCalls>[${i}]: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return edges;
};

/**
 * Build `references` edges from `<subflows>` elements. Each `<subflows>`
 * element calls another Flow as a subflow, naming its target via the
 * `<flowName>` child; that becomes the edge's `toId` as `Flow:{flowName}`.
 *
 * The edge carries `confidence: 'declared'` — `<flowName>` is Salesforce's own
 * declaration of which Flow this one invokes, not something inferred from a body
 * walk (mirrors {@link buildStartEdge}'s `triggersOn`). `properties.referenceKind`
 * is `'subflow'` (the idiom the enterprise-metadata / approval-process extractors
 * use to disambiguate a generic `references` edge — e.g.
 * `permissionSetGroupMember`, `allowedSubmitter`); `properties.subflowElementName`
 * carries the calling element's `<name>` so a consumer can name the call site.
 *
 * The target Flow may not be in the vault (a managed-package or otherwise
 * uncaptured subflow). Following the same dangling-by-design discipline as
 * {@link buildActionCallEdges} (`callsApex` → `ApexClass:{name}` regardless of
 * whether the class was extracted) and approval-process approver refs, the edge
 * is STILL emitted — the graph layer classifies an unresolved `Flow:{name}`
 * target as dangling; the extractor never fabricates a scaffolding node.
 *
 * Why this matters (R6-02): before this production the extractor scoped out
 * `<subflows>` entirely, so NO flow→flow edge existed. A subflow called by N
 * parent flows therefore had zero incoming edges and read as SAFE to deactivate
 * (`what_if_deactivate_flow`) and as having no dependents (`get_impact`) — a
 * wrong, destructive verdict. Elements missing a `<flowName>` are skipped with a
 * warning rather than emitting a malformed-id edge.
 */
const buildSubflowEdges = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
): Edge[] => {
  const edges: Edge[] = [];
  const subflows = toArray(rootObj['subflows']);
  for (let i = 0; i < subflows.length; i += 1) {
    const subflow = subflows[i];
    try {
      if (typeof subflow !== 'object' || subflow === null) continue;
      const subflowObj = subflow as Record<string, unknown>;
      const flowName = toNonEmptyString(subflowObj['flowName']);
      if (flowName === null) {
        warnings.push(`<subflows>[${i}] has no <flowName>`);
        continue;
      }
      const subflowElementName = toNonEmptyString(subflowObj['name']);
      edges.push({
        fromId: flowId,
        toId: `${ROOT_ELEMENT}:${flowName}`,
        edgeType: 'references',
        confidence: 'declared',
        source: EDGE_SOURCE,
        properties: { referenceKind: 'subflow', subflowElementName },
      });
    } catch (cause: unknown) {
      warnings.push(
        `failed to read <subflows>[${i}]: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return edges;
};

/**
 * A non-edge-bearing summary of a single `<actionCalls>` element: its declared
 * `actionType` (e.g. `apex`, `activateSessionPermSet`, `emailAlert`, `flow`)
 * and `actionName`. Apex action calls already get a `callsApex` edge, but
 * non-apex action types emit no edge (a `callsApex` edge to an ApexClass would
 * be a lie for, say, `activateSessionPermSet`). Without this list `explain_flow`
 * sees `actionCalls: []` and cannot even name the faultable element, which lets
 * a caller mistake an action-call element for missing. Surfacing every action
 * call's `{actionType, actionName}` lets the consumer identify the element type
 * — e.g. recognise `activateSessionPermSet` as a TRANSIENT session activation
 * (no PermissionSetAssignment row is inserted), so an "orphaned grant" premise
 * is structurally impossible.
 */
interface FlowActionCallSummary {
  readonly actionType: string | null;
  readonly actionName: string | null;
}

/**
 * Collect a `{actionType, actionName}` summary for EVERY `<actionCalls>`
 * element (apex AND non-apex), in source order, for the flow node properties.
 * This is independent of {@link buildActionCallEdges} (which emits `callsApex`
 * edges only for `actionType=apex`): the property list documents the full set
 * of action-call elements so a consumer can identify the element type even when
 * no edge is warranted.
 */
const collectActionCallSummaries = (
  rootObj: Record<string, unknown>,
): FlowActionCallSummary[] => {
  const out: FlowActionCallSummary[] = [];
  for (const call of toArray(rootObj['actionCalls'])) {
    if (typeof call !== 'object' || call === null) continue;
    const callObj = call as Record<string, unknown>;
    out.push({
      actionType: toNonEmptyString(callObj['actionType']),
      actionName: toNonEmptyString(callObj['actionName']),
    });
  }
  return out;
};

/**
 * Build `readsFrom` edges from `<recordLookups>` elements. Each lookup
 * names a target SObject via its `<object>` child, which becomes the
 * edge's `toId` as `CustomObject:{object}`.
 *
 * `properties.operation: 'recordLookup'` records why the edge exists
 * so downstream consumers can distinguish recordLookup-derived reads
 * from recordUpdate-derived reads (both edgeType `readsFrom`).
 */
const buildRecordLookupEdges = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
): Edge[] => {
  const edges: Edge[] = [];
  const lookups = toArray(rootObj['recordLookups']);
  for (let i = 0; i < lookups.length; i += 1) {
    const lookup = lookups[i];
    try {
      if (typeof lookup !== 'object' || lookup === null) continue;
      const lookupObj = lookup as Record<string, unknown>;
      const object = toNonEmptyString(lookupObj['object']);
      if (object === null) {
        warnings.push(`<recordLookups>[${i}] has no <object>`);
        continue;
      }
      edges.push({
        fromId: flowId,
        toId: `CustomObject:${object}`,
        edgeType: 'readsFrom',
        confidence: 'parsed',
        source: EDGE_SOURCE,
        properties: { operation: 'recordLookup' },
      });
    } catch (cause: unknown) {
      warnings.push(
        `failed to read <recordLookups>[${i}]: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return edges;
};

/**
 * Emit per-field `writesTo` edges from a DML element's `<inputAssignments>`.
 *
 * Each `<inputAssignments><field>` names a field the create/update SETS on its
 * target object, so the edge lands at `CustomField:{object}.{field}` carrying
 * the parent element's `operation` (`recordCreate` | `recordUpdate`). These
 * FIELD-level edges sit ALONGSIDE the OBJECT-level write edge the caller also
 * emits — they do NOT replace it. The object-level edge answers "does this Flow
 * create/update this object?" (`record_creation_paths`, the impact walk); the
 * field-level edges answer "WHICH fields does it set?", which lets
 * `what_if_make_field_required` tell whether a creating Flow populates a given
 * field before that field is made required.
 *
 * Confidence is `parsed` (the field name was read straight out of the XML).
 * `<inputAssignments>` entries missing a `<field>` are skipped with a warning;
 * `<field>` is taken verbatim, so an unmodeled (e.g. standard) field yields an
 * edge whose target the importer flags `targetMissing` — harmless, since the
 * consumer only queries edges to the modeled field it was asked about.
 */
/**
 * The literal-scalar `<value>` wrapper keys, in source-precedence order.
 * Mirrors the right-value wrappers {@link parseFlowConditionTriplet}
 * recognises. A value carried under any of these is a *literal* the flow
 * assigns verbatim (e.g. `<stringValue>Completed</stringValue>` →
 * `'Completed'`); a value under `<elementReference>` is a *reference* to a
 * variable / formula / `$Record.Field` and is NOT a statically-resolvable
 * literal.
 */
const ASSIGNED_VALUE_LITERAL_WRAPPERS = [
  'stringValue',
  'numberValue',
  'booleanValue',
  'dateValue',
  'dateTimeValue',
] as const;

/** Discriminates a parsed `<inputAssignments><value>` payload. */
type AssignedValue = {
  /** The unwrapped scalar, inspectable in BOTH kinds. */
  readonly value: string;
  /**
   * `'literal'` when the value came from a scalar wrapper
   * (stringValue/numberValue/…) — statically comparable. `'reference'`
   * when it came from `<elementReference>` (a variable/formula/$Record
   * path) — NOT a literal, so consumers must not string-match it against
   * a removed picklist value.
   */
  readonly kind: 'literal' | 'reference';
};

/**
 * Parse the `<value>` child of an `<inputAssignments>` entry into its
 * unwrapped scalar plus a `kind` discriminator. Reuses the scalar-unwrap
 * MECHANISM of {@link parseFlowConditionTriplet} but — unlike that helper,
 * which collapses every wrapper into one `value` — records WHICH wrapper
 * matched, because that distinction is load-bearing downstream: an
 * `<elementReference>` assignment (e.g. `$Record.FormAssembly_Multi_Accom__c`)
 * must not be mistaken for a literal when a consumer checks whether a flow
 * assigns a specific picklist value.
 *
 * Returns `null` when no `<value>` is present or it carries no recognised
 * scalar (the edge is still emitted, just without value properties).
 */
const parseAssignedValue = (
  assignment: Record<string, unknown>,
): AssignedValue | null => {
  const rawValue = unwrapSingle(assignment['value']);
  if (typeof rawValue !== 'object' || rawValue === null) {
    // A bare scalar `<value>Foo</value>` (uncommon for inputAssignments)
    // is treated as a literal.
    if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
      return { value: String(rawValue), kind: 'literal' };
    }
    return null;
  }
  const wrapper = rawValue as Record<string, unknown>;
  for (const key of ASSIGNED_VALUE_LITERAL_WRAPPERS) {
    const v = unwrapSingle(wrapper[key]);
    if (v !== undefined && v !== null && v !== '') {
      return { value: String(v), kind: 'literal' };
    }
  }
  const ref = unwrapSingle(wrapper['elementReference']);
  if (ref !== undefined && ref !== null && ref !== '') {
    return { value: String(ref), kind: 'reference' };
  }
  return null;
};

/**
 * Per-flow accumulator for the R6-11 dataflow READ edges: resolved source
 * field (`{Object}.{Field}`) → the strongest trace confidence seen plus the
 * set of written fields it feeds. Aggregated across every DML element and
 * emitted once per source field by {@link buildDataflowReadEdges}.
 */
type DataflowSourceCollector = Map<
  string,
  { confidence: DataflowConfidence; targetFields: Set<string> }
>;

/**
 * Stamp the R6-11 dataflow-trace properties for ONE reference-valued field
 * write onto `properties` and feed each resolved source field into
 * `dataflowCollector` (so {@link buildDataflowReadEdges} can emit the
 * symmetric field-level `readsFrom` edges). Shared by the DML
 * `<inputAssignments>` writes ({@link buildInputAssignmentEdges}) and the
 * R7-W2 before-save `$Record.<Field>` assignment writes
 * ({@link buildBeforeSaveFieldAssignmentEdges}).
 *
 * `targetField` is the `{Object}.{Field}` the value flows INTO. `demote` marks
 * the whole trace `heuristic` even for otherwise-`declared` sources — passed
 * `true` when the write arrives through a non-`Assign` operator (`Add` etc.),
 * where the source field FEEDS the value but is not a clean copy. A DML
 * `<inputAssignments>` has no operator, so it always passes `demote: false`,
 * reproducing the pre-refactor behaviour byte-for-byte.
 */
const attachDataflowTrace = (
  properties: Record<string, unknown>,
  referenceValue: string,
  targetField: string,
  dataflowIndex: FlowDataflowIndex,
  dataflowCollector: DataflowSourceCollector,
  demote: boolean,
): void => {
  const trace = traceValueReference(dataflowIndex, referenceValue);
  properties['sourceFields'] = trace.sources.map((s) => s.field);
  properties['sourceFieldConfidence'] = trace.sources.map((s) =>
    demote ? 'heuristic' : s.confidence,
  );
  properties['unresolvedSourceCount'] = trace.unresolvedCount;
  if (trace.depthCapped) properties['sourceTraceDepthCapped'] = true;
  for (const s of trace.sources) {
    const conf: DataflowConfidence = demote ? 'heuristic' : s.confidence;
    const entry = dataflowCollector.get(s.field) ?? {
      confidence: conf,
      targetFields: new Set<string>(),
    };
    if (conf === 'declared') entry.confidence = 'declared';
    entry.targetFields.add(targetField);
    dataflowCollector.set(s.field, entry);
  }
};

const buildInputAssignmentEdges = (
  flowId: string,
  element: Record<string, unknown>,
  object: string,
  operation: 'recordCreate' | 'recordUpdate',
  elementLabel: string,
  warnings: string[],
  dataflowIndex: FlowDataflowIndex,
  dataflowCollector: DataflowSourceCollector,
): Edge[] => {
  const edges: Edge[] = [];
  const assignments = toArray(element['inputAssignments']);
  for (let j = 0; j < assignments.length; j += 1) {
    const assignment = assignments[j];
    if (typeof assignment !== 'object' || assignment === null) continue;
    const assignmentObj = assignment as Record<string, unknown>;
    const field = toNonEmptyString(assignmentObj['field']);
    if (field === null) {
      warnings.push(`${elementLabel}.<inputAssignments>[${j}] has no <field>`);
      continue;
    }
    // R2-1: capture the assigned <value> so a consumer (e.g.
    // what_if_remove_picklist_value) can tell whether a flow maps the
    // field to a specific picklist value. `assignedValueKind` keeps the
    // literal-vs-reference distinction: an `<elementReference>` is a
    // variable/formula, NOT a statically-comparable literal.
    const assigned = parseAssignedValue(assignmentObj);
    const properties: Record<string, unknown> = { operation };
    if (assigned !== null) {
      properties['assignedValue'] = assigned.value;
      properties['assignedValueKind'] = assigned.kind;
    }
    // R6-11: trace a reference-valued assignment back through the flow's
    // internal assignment chain to the record FIELDS it derives from, so
    // `field_lineage` can walk THROUGH the flow instead of dead-ending at
    // it. Literal assignments have zero field sources by construction and
    // carry no trace properties. `sourceFields` / `sourceFieldConfidence`
    // are parallel arrays (`declared` = direct $Record/lookup chain,
    // `heuristic` = through a formula/loop/non-Assign operator);
    // `unresolvedSourceCount` DISCLOSES inputs the trace could not resolve
    // (ambiguous variables, relationship traversals, action outputs) —
    // never guessed. `sourceTraceDepthCapped` flags a chain cut at the
    // extractor's trace depth cap.
    if (assigned !== null && assigned.kind === 'reference') {
      // A DML <inputAssignments> has no operator (it is always a direct set),
      // so the trace is never operator-demoted here (demote=false).
      attachDataflowTrace(
        properties,
        assigned.value,
        `${object}.${field}`,
        dataflowIndex,
        dataflowCollector,
        false,
      );
    }
    edges.push({
      fromId: flowId,
      toId: `CustomField:${object}.${field}`,
      edgeType: 'writesTo',
      confidence: 'parsed',
      source: EDGE_SOURCE,
      properties,
    });
  }
  return edges;
};

/**
 * Emit the R6-11 FIELD-level dataflow `readsFrom` edges — one per resolved
 * source field the flow's DML input assignments derive from, landing on
 * `CustomField:{Object}.{Field}` with
 * `properties.operation: 'dataflowSource'` and `properties.targetFields`
 * naming the written fields it feeds. These are the DOWNSTREAM-walkable
 * mirror of the `sourceFields` trace on the `writesTo` edges: a lineage
 * walk on the SOURCE field sees the flow (and where the value goes) via its
 * incoming edges, exactly like the apex-scanner's field-level `readsFrom`.
 * The edge `confidence` is the strongest per-source trace confidence
 * (`declared` | `heuristic`). Consumers that enumerate a flow's
 * OBJECT-level lookups (e.g. `explain_flow`) must skip the
 * `dataflowSource` operation marker.
 */
const buildDataflowReadEdges = (
  flowId: string,
  collector: DataflowSourceCollector,
): Edge[] => {
  const edges: Edge[] = [];
  for (const [sourceField, entry] of collector) {
    edges.push({
      fromId: flowId,
      toId: `CustomField:${sourceField}`,
      edgeType: 'readsFrom',
      confidence: entry.confidence,
      source: EDGE_SOURCE,
      properties: {
        operation: DATAFLOW_SOURCE_OPERATION,
        targetFields: [...entry.targetFields].sort(),
      },
    });
  }
  return edges;
};

/**
 * Build `writesTo` edges from `<recordCreates>` elements. Each create targets
 * the SObject named by `<object>` (OBJECT-level edge) and additionally writes
 * each field named in its `<inputAssignments>` (FIELD-level edges via
 * {@link buildInputAssignmentEdges}). Both are kept: the object-level edge is
 * what record-creation / impact consumers query, the field-level edges record
 * which fields the create actually sets.
 *
 * R7-W1: a create that inserts a whole record VARIABLE carries an
 * `<inputReference>` instead of `<object>` + `<inputAssignments>`. We resolve
 * the variable to its declared objectType and emit the OBJECT-level edge at
 * `declared` confidence with the whole-record disclosure — the inserted fields
 * are not enumerable from the metadata, so NO per-field edges are fabricated.
 */
const buildRecordCreateEdges = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
  dataflowIndex: FlowDataflowIndex,
  dataflowCollector: DataflowSourceCollector,
): Edge[] => {
  const edges: Edge[] = [];
  const creates = toArray(rootObj['recordCreates']);
  for (let i = 0; i < creates.length; i += 1) {
    const create = creates[i];
    try {
      if (typeof create !== 'object' || create === null) continue;
      const createObj = create as Record<string, unknown>;
      let object = toNonEmptyString(createObj['object']);
      let confidence: Edge['confidence'] = 'parsed';
      let resolution: InputReferenceResolution | null = null;
      if (object === null) {
        resolution = resolveInputReferenceObject(createObj, rootObj, dataflowIndex);
        if (resolution === null) {
          warnings.push(
            `<recordCreates>[${i}] has no <object> and no resolvable <inputReference> (typed record variable / $Record); skipped`,
          );
          continue;
        }
        object = resolution.object;
        confidence = resolution.confidence;
      }
      edges.push({
        fromId: flowId,
        toId: `CustomObject:${object}`,
        edgeType: 'writesTo',
        confidence,
        source: EDGE_SOURCE,
        properties: buildObjectDmlProps('recordCreate', resolution, true),
      });
      // A record-variable whole-record insert has no <inputAssignments> to
      // enumerate (the fields come from the variable); skip the per-field pass.
      if (resolution === null || resolution.kind !== 'recordVariable') {
        edges.push(
          ...buildInputAssignmentEdges(
            flowId,
            createObj,
            object,
            'recordCreate',
            `<recordCreates>[${i}]`,
            warnings,
            dataflowIndex,
            dataflowCollector,
          ),
        );
      }
    } catch (cause: unknown) {
      warnings.push(
        `failed to read <recordCreates>[${i}]: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return edges;
};

/**
 * The verbatim disclosure a record-VARIABLE `<inputReference>` DML carries
 * (R7-W1). A `recordCreate`/`recordUpdate`/`recordDelete` that names a whole
 * record variable writes ALL of that record's field values — the metadata does
 * not enumerate them (there are no `<inputAssignments>`), so we emit only the
 * OBJECT-level edge and disclose that the fields are not knowable offline
 * rather than fabricating per-field edges.
 */
const WHOLE_RECORD_DISCLOSURE =
  'whole-record write; individual fields not enumerable from a record-variable DML';

/**
 * The resolved SObject target of an `<inputReference>`-style record DML, plus
 * HOW it was resolved. Two disjoint shapes:
 *
 *   - `triggerRecord`: the reference is `$Record` / `$Record__Prior`, the
 *     triggering record of a record-scoped flow. Its SObject type is INFERRED
 *     from the `<start><object>` (via the trigger type), so confidence is
 *     `heuristic` and the DML's `<inputAssignments>` still enumerate the fields
 *     it sets (a `$Record` update names specific fields).
 *   - `recordVariable` (R7-W1): the reference is a record VARIABLE declared in
 *     `<variables>` with an `<objectType>`. The DML writes the WHOLE record; the
 *     individual fields are NOT enumerable (no `<inputAssignments>`). Confidence
 *     is `declared` (the variable's declared objectType IS the write target),
 *     and the caller suppresses per-field edges and stamps
 *     {@link WHOLE_RECORD_DISCLOSURE}.
 */
export interface InputReferenceResolution {
  readonly object: string;
  readonly kind: 'triggerRecord' | 'recordVariable';
  readonly confidence: Edge['confidence'];
  /** The `<inputReference>` string verbatim (`$Record` or the variable name). */
  readonly reference: string;
  /**
   * Object-level provenance for a record variable: when a single-record
   * `<recordLookups>` populated this variable (its `<outputReference>` names
   * it), the object that lookup read from — object-level only, never per-field.
   * `null` for `$Record` or a variable with no traceable lookup source.
   */
  readonly sourceObject: string | null;
}

/**
 * Resolve an `<inputReference>`-style record DML target to its SObject api name
 * AND how it was resolved (see {@link InputReferenceResolution}).
 *
 *   - `$Record` / `$Record__Prior` → the triggering record of a record-scoped
 *     flow, typed by `<start><object>` (`kind: 'triggerRecord'`, `heuristic`).
 *   - Otherwise, a record VARIABLE declared in `<variables>` with an
 *     `<objectType>` (R7-W1) → that objectType (`kind: 'recordVariable'`,
 *     `declared`), with object-level lookup provenance when available.
 *
 * Returns `null` when the reference is neither the trigger record nor a typed
 * record variable (a loop/collection variable with no objectType, an undeclared
 * name, or a `$Record` on a flow that is not record-scoped / has no trigger
 * object) — those remain unresolvable offline and the caller skips + discloses.
 */
export const resolveInputReferenceObject = (
  dmlObj: Record<string, unknown>,
  rootObj: Record<string, unknown>,
  dataflowIndex: FlowDataflowIndex,
): InputReferenceResolution | null => {
  const inputRef = toNonEmptyString(dmlObj['inputReference']);
  if (inputRef === null) return null;
  if (inputRef === '$Record' || inputRef === '$Record__Prior') {
    const start = extractStartProperties(rootObj);
    if (
      start.triggerType === null ||
      !RECORD_SCOPED_TRIGGER_TYPES.has(start.triggerType) ||
      start.triggerObject === null
    ) {
      return null;
    }
    return {
      object: start.triggerObject,
      kind: 'triggerRecord',
      confidence: 'heuristic',
      reference: inputRef,
      sourceObject: null,
    };
  }
  // R7-W1: a record VARIABLE — resolve its DECLARED objectType. A collection
  // variable is still a single object type per element, so `isCollection` does
  // not block the object-level edge (the DML writes rows of that object).
  const variable = dataflowIndex.variables.get(inputRef);
  if (variable === undefined || variable.objectType === null) return null;
  let sourceObject: string | null = null;
  for (const lookup of dataflowIndex.lookups.values()) {
    if (
      lookup.outputReference === inputRef &&
      lookup.getFirstRecordOnly &&
      lookup.object !== null
    ) {
      sourceObject = lookup.object;
      break;
    }
  }
  return {
    object: variable.objectType,
    kind: 'recordVariable',
    confidence: 'declared',
    reference: inputRef,
    sourceObject,
  };
};

/**
 * Build the OBJECT-level DML edge `properties` for a `writesTo` / `readsFrom`
 * edge, adding the R7-W1 whole-record disclosure markers when the DML target
 * was a record VARIABLE `<inputReference>`. For a normal `<object>` DML or a
 * `$Record` trigger-record reference the result is just `{ operation }` —
 * byte-identical to the pre-R7 edges (so existing goldens are unaffected).
 *
 * `includeDisclosure` gates the write-phrased {@link WHOLE_RECORD_DISCLOSURE}
 * string: `true` for the `writesTo` edge, `false` for the matching `readsFrom`
 * edge (which carries the neutral markers but not the "…write…" sentence).
 */
const buildObjectDmlProps = (
  operation: 'recordCreate' | 'recordUpdate' | 'recordDelete',
  resolution: InputReferenceResolution | null,
  includeDisclosure: boolean,
): Record<string, unknown> => {
  const properties: Record<string, unknown> = { operation };
  if (resolution !== null && resolution.kind === 'recordVariable') {
    properties['inputReferenceKind'] = 'recordVariable';
    properties['inputReference'] = resolution.reference;
    properties['wholeRecord'] = true;
    properties['fieldsEnumerable'] = false;
    if (resolution.sourceObject !== null) {
      properties['sourceObject'] = resolution.sourceObject;
    }
    if (includeDisclosure) properties['disclosure'] = WHOLE_RECORD_DISCLOSURE;
  }
  return properties;
};

/**
 * Build read+write edges from `<recordUpdates>` elements. A record
 * update both reads (matches records to update) and writes (the new
 * field values), so it produces two OBJECT-level edges per update — one
 * `readsFrom`, one `writesTo` — both with
 * `properties.operation: 'recordUpdate'`, plus one FIELD-level `writesTo`
 * edge per `<inputAssignments><field>` (via {@link buildInputAssignmentEdges}).
 *
 * Updates that use `<inputReference>` (e.g., `$Record` on a
 * record-triggered flow) carry no `<object>`. The triggering record's
 * `$Record` (or `$Record__Prior`) resolves to the `<start><object>` of a
 * record-triggered flow — so we resolve it to that SObject and emit the same
 * edges as an `<object>`-typed update, at `heuristic` confidence (the object
 * is inferred from the trigger type, not parsed from the element).
 *
 * R7-W1: a `<inputReference>` naming a whole record VARIABLE ("use all field
 * values from this record / record collection") resolves to the variable's
 * declared objectType at `declared` confidence, and the edges carry the
 * whole-record disclosure — the individual fields are NOT enumerable (no
 * `<inputAssignments>`), so no per-field edges are fabricated. A
 * `<inputReference>` that is neither `$Record` nor a typed record variable
 * (an undeclared loop/collection name) still can't be resolved offline and is
 * skipped with a warning.
 */
const buildRecordUpdateEdges = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
  dataflowIndex: FlowDataflowIndex,
  dataflowCollector: DataflowSourceCollector,
): Edge[] => {
  const edges: Edge[] = [];
  const updates = toArray(rootObj['recordUpdates']);
  for (let i = 0; i < updates.length; i += 1) {
    const update = updates[i];
    try {
      if (typeof update !== 'object' || update === null) continue;
      const updateObj = update as Record<string, unknown>;
      let object = toNonEmptyString(updateObj['object']);
      let confidence: Edge['confidence'] = 'parsed';
      let resolution: InputReferenceResolution | null = null;
      if (object === null) {
        resolution = resolveInputReferenceObject(updateObj, rootObj, dataflowIndex);
        if (resolution === null) {
          warnings.push(
            `<recordUpdates>[${i}] has no <object>; its <inputReference> is neither the trigger record ($Record) nor a typed record variable; skipped`,
          );
          continue;
        }
        object = resolution.object;
        confidence = resolution.confidence;
      }
      const toId = `CustomObject:${object}`;
      edges.push({
        fromId: flowId,
        toId,
        edgeType: 'readsFrom',
        confidence,
        source: EDGE_SOURCE,
        properties: buildObjectDmlProps('recordUpdate', resolution, false),
      });
      edges.push({
        fromId: flowId,
        toId,
        edgeType: 'writesTo',
        confidence,
        source: EDGE_SOURCE,
        properties: buildObjectDmlProps('recordUpdate', resolution, true),
      });
      // A record-variable whole-record update has no <inputAssignments> to
      // enumerate; skip the per-field pass (the fields come from the variable).
      if (resolution === null || resolution.kind !== 'recordVariable') {
        edges.push(
          ...buildInputAssignmentEdges(
            flowId,
            updateObj,
            object,
            'recordUpdate',
            `<recordUpdates>[${i}]`,
            warnings,
            dataflowIndex,
            dataflowCollector,
          ),
        );
      }
    } catch (cause: unknown) {
      warnings.push(
        `failed to read <recordUpdates>[${i}]: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return edges;
};

/**
 * Build `writesTo` edges from `<recordDeletes>` elements. A delete is
 * a kind of write — the record's state changes from existing to gone.
 *
 * Like `<recordUpdates>`, a delete can use `<inputReference>` instead of
 * `<object>`: `$Record` resolves to the trigger object (`heuristic`), a whole
 * record VARIABLE (R7-W1) to its declared objectType (`declared`, with the
 * whole-record disclosure). A delete has no fields to enumerate, so it emits
 * only the OBJECT-level edge either way. An `<inputReference>` that is neither
 * is skipped with a warning.
 */
const buildRecordDeleteEdges = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
  dataflowIndex: FlowDataflowIndex,
): Edge[] => {
  const edges: Edge[] = [];
  const deletes = toArray(rootObj['recordDeletes']);
  for (let i = 0; i < deletes.length; i += 1) {
    const del = deletes[i];
    try {
      if (typeof del !== 'object' || del === null) continue;
      const delObj = del as Record<string, unknown>;
      let object = toNonEmptyString(delObj['object']);
      let confidence: Edge['confidence'] = 'parsed';
      let resolution: InputReferenceResolution | null = null;
      if (object === null) {
        resolution = resolveInputReferenceObject(delObj, rootObj, dataflowIndex);
        if (resolution === null) {
          warnings.push(
            `<recordDeletes>[${i}] has no <object>; its <inputReference> is neither the trigger record ($Record) nor a typed record variable; skipped`,
          );
          continue;
        }
        object = resolution.object;
        confidence = resolution.confidence;
      }
      edges.push({
        fromId: flowId,
        toId: `CustomObject:${object}`,
        edgeType: 'writesTo',
        confidence,
        source: EDGE_SOURCE,
        properties: buildObjectDmlProps('recordDelete', resolution, true),
      });
    } catch (cause: unknown) {
      warnings.push(
        `failed to read <recordDeletes>[${i}]: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return edges;
};

/**
 * The `<start><triggerType>` for which an `<assignments>` write to
 * `$Record.<Field>` PERSISTS: a before-save record-triggered flow mutates the
 * triggering record in place before it is committed, so a bare assignment IS a
 * field write (no DML needed). After-save / before-delete flows do NOT persist
 * an in-memory `$Record` mutation without an explicit Update Records on
 * `$Record`, so those are disclosed, never emitted as a write.
 */
const BEFORE_SAVE_TRIGGER_TYPE = 'RecordBeforeSave';

/** Coerce an already-unwrapped XML child into a record, else null (no unwrapSingle — call sites iterate `toArray` output). */
export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;

/** Strip an optional `{! ... }` merge wrapper from a reference string. */
export const stripMergeWrapper = (ref: string): string => {
  const t = ref.trim();
  return t.startsWith('{!') && t.endsWith('}') ? t.slice(2, -1).trim() : t;
};

/**
 * If `assignToReference` names a DIRECT field on the triggering record
 * (`$Record.<Field>`, optionally `{!$Record.<Field>}`), return the bare
 * `<Field>` api name. Returns `null` for anything that is not a direct
 * trigger-record field write:
 *   - `$Record__Prior.<Field>` — the pre-update snapshot is READ-ONLY.
 *   - a relationship traversal `$Record.Rel__r.<Field>` — a parent's field is
 *     not writable via a flow assignment and cannot be resolved to an object
 *     offline.
 *   - any non-`$Record` target (a variable, `$Record` bare, etc.).
 */
const parseRecordFieldAssignTarget = (
  assignToReference: string,
): string | null => {
  const ref = stripMergeWrapper(assignToReference);
  if (!ref.startsWith('$Record.')) return null;
  const rest = ref.slice('$Record.'.length).trim();
  if (rest.length === 0 || rest.includes('.')) return null;
  return rest;
};

/** One `$Record.<Field>` assignment write gathered from `<assignments>`. */
interface RecordFieldAssignment {
  readonly field: string;
  readonly item: Record<string, unknown>;
  readonly operator: string;
}

/**
 * R7-W2 — emit FIELD-level `writesTo` edges for a before-save
 * record-triggered flow's `<assignments>` items that set `$Record.<Field>`.
 *
 * In a RecordBeforeSave flow, assigning to `$Record.<Field>` mutates the
 * triggering record IN PLACE before it is committed — there is no DML element
 * and no `<inputAssignments>`, so the write was previously INVISIBLE to
 * impact/lineage (a false-safe: a field set this way read as unwritten). This
 * production makes the classic "before-save flow sets a field" pattern visible.
 *
 * Honesty / scope:
 *   - Emits ONLY when `triggerType === RecordBeforeSave` and the
 *     `<start><object>` is resolvable. Each write edge is `declared` (both the
 *     assignment and the trigger object are stated).
 *   - After-save (`RecordAfterSave`) / before-delete flows: an in-memory
 *     `$Record` mutation does NOT persist without an explicit Update Records on
 *     `$Record`, so NO edge is emitted and the skipped count is DISCLOSED via a
 *     warning — never a phantom write. A RecordBeforeSave flow whose
 *     `<start><object>` is missing is likewise disclosed, not guessed.
 *   - The assigned `<value>` is traced through the R6-11 dataflow index exactly
 *     like a DML `<inputAssignments>` (`sourceFields` / `sourceFieldConfidence`
 *     / `unresolvedSourceCount`), and each resolved source field feeds the
 *     dataflow collector so the symmetric field-level `readsFrom` edges are
 *     emitted — letting `field_lineage` walk THROUGH the before-save write to
 *     its inputs. A non-`Assign` operator (`Add`/`Subtract`/…) DEMOTES the
 *     traced source confidence to `heuristic` (the field feeds the value but is
 *     not a clean copy); the WRITE edge itself stays `declared`.
 *   - `$Record__Prior.<Field>` (read-only) and relationship traversals are not
 *     writes; they are counted and disclosed, never emitted.
 */
const buildBeforeSaveFieldAssignmentEdges = (
  flowId: string,
  rootObj: Record<string, unknown>,
  startProps: ReturnType<typeof extractStartProperties>,
  warnings: string[],
  dataflowIndex: FlowDataflowIndex,
  dataflowCollector: DataflowSourceCollector,
): Edge[] => {
  // Gather every $Record.<Field> assignment first (so the disclosure can count
  // them even when the trigger context bars emission), plus the count of
  // $Record-rooted-but-non-direct targets ($Record__Prior / relationship).
  const writes: RecordFieldAssignment[] = [];
  let skippedNonDirect = 0;
  for (const rawAssign of toArray(rootObj['assignments'])) {
    const assign = asRecord(rawAssign);
    if (assign === null) continue;
    for (const rawItem of toArray(assign['assignmentItems'])) {
      const item = asRecord(rawItem);
      if (item === null) continue;
      const target = toNonEmptyString(item['assignToReference']);
      if (target === null) continue;
      // Only $Record-rooted targets are candidate trigger-record writes.
      if (!stripMergeWrapper(target).startsWith('$Record')) continue;
      const field = parseRecordFieldAssignTarget(target);
      if (field === null) {
        skippedNonDirect += 1;
        continue;
      }
      writes.push({
        field,
        item,
        operator: toNonEmptyString(item['operator']) ?? 'Assign',
      });
    }
  }
  if (writes.length === 0 && skippedNonDirect === 0) return [];

  // Trigger-context gating. In a RecordBeforeSave flow an <assignments> write
  // to $Record.<Field> persists directly (confidence: declared). In an
  // after-save / scheduled / before-delete record-triggered flow the same
  // in-memory assignment persists ONLY when the flow ALSO runs an explicit
  // whole-record Update Records on $Record downstream — the precondition the
  // pre-fix code named in its own warning but never checked, so it silently
  // dropped every real after-save $Record field write. When that persisting
  // update element exists we emit the field writes at HEURISTIC confidence
  // (persistence is inferred from the element's presence, not proven per
  // execution path); when it does not, we still suppress and disclose.
  let writeConfidence: Edge['confidence'] = 'declared';
  if (startProps.triggerType !== BEFORE_SAVE_TRIGGER_TYPE) {
    if (
      startProps.triggerType === null ||
      !RECORD_TRIGGER_TYPES.has(startProps.triggerType)
    ) {
      // Not record-triggered → there is no $Record to persist; nothing to say.
      return [];
    }
    const persistsToTriggerRecord = toArray(rootObj['recordUpdates']).some(
      (raw) => {
        const upd = asRecord(raw);
        const ref =
          upd === null ? null : toNonEmptyString(upd['inputReference']);
        return ref === '$Record' || ref === '$Record__Prior';
      },
    );
    if (!persistsToTriggerRecord) {
      warnings.push(
        `${writes.length + skippedNonDirect} <assignments> to $Record field(s) in a ${startProps.triggerType} flow are in-memory only and do not persist without an explicit Update Records on $Record; no writesTo edge emitted`,
      );
      return [];
    }
    writeConfidence = 'heuristic';
  }
  if (startProps.triggerObject === null) {
    warnings.push(
      `<assignments> set $Record field(s) in a record-triggered flow but <start> has no <object>; trigger object unknown, no field writesTo edge emitted`,
    );
    return [];
  }
  if (skippedNonDirect > 0) {
    warnings.push(
      `${skippedNonDirect} <assignments> to $Record__Prior or a relationship path are not direct trigger-record field writes; skipped`,
    );
  }

  const triggerObject = startProps.triggerObject;
  const edges: Edge[] = [];
  for (const w of writes) {
    const properties: Record<string, unknown> = {
      operation: 'beforeSaveFieldAssignment',
    };
    const assigned = parseAssignedValue(w.item);
    if (assigned !== null) {
      properties['assignedValue'] = assigned.value;
      properties['assignedValueKind'] = assigned.kind;
      if (assigned.kind === 'reference') {
        attachDataflowTrace(
          properties,
          assigned.value,
          `${triggerObject}.${w.field}`,
          dataflowIndex,
          dataflowCollector,
          w.operator !== 'Assign',
        );
      }
    }
    edges.push({
      fromId: flowId,
      toId: `CustomField:${triggerObject}.${w.field}`,
      edgeType: 'writesTo',
      confidence: writeConfidence,
      source: EDGE_SOURCE,
      properties,
    });
  }
  return edges;
};

/**
 * Read the first of `keys` that unwraps to a present, non-empty payload, or
 * `null` when none does. `keys` is in PRECEDENCE order, so the caller's
 * canonical spelling is tried before its dialect alias. Used to accept the two
 * XML spellings of a Flow condition triplet without duplicating the
 * empty-string tolerance at each call site.
 */
const pickTripletMember = (
  obj: Record<string, unknown>,
  keys: readonly string[],
): unknown => {
  for (const key of keys) {
    const v = unwrapSingle(obj[key]);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

/**
 * Parse a single Flow condition triplet into the helper's `CriteriaItem`
 * shape.
 *
 * Flow ships TWO spellings of the same triplet and this parser must accept
 * both:
 *
 *   - `<leftValueReference>` / `<operator>` / `<rightValue>` —
 *     `<decisions><rules><conditions>`.
 *   - `<field>` / `<operator>` / `<value>` — `<start><filters>`, the
 *     record-trigger ENTRY CRITERIA (and the legacy `<recordTriggers><filters>`
 *     shape).
 *
 * Reading only the first spelling made EVERY entry criterion parse to `null`:
 * no `CriteriaItem`, so no `fieldRefs` on the ConditionalContext, so no
 * `readsFrom` condition-field edge. A field used only as a record-trigger entry
 * filter therefore looked unreferenced to `safe_to_delete_field`, which is a
 * pure incoming-edge walk — a delete-it verdict for a field the platform
 * refuses to delete. `leftValueReference` / `rightValue` are tried FIRST so the
 * decision dialect's output is byte-identical to before this alias existed.
 *
 * `<operator>` is required in both dialects (`<start><filters>` always carries
 * one, even for the unary `IsNull` / `IsChanged` operators), so an
 * operator-less triplet is still rejected.
 *
 * The comparison value is wrapped in a typed sub-element in both dialects
 * (`<stringValue>`, `<numberValue>`, `<elementReference>`, etc.); the extractor
 * preserves whichever scalar form is present. A triplet with no value element
 * at all (Salesforce allows it for unary tests) yields `value: null`, which
 * `CriteriaItem` documents and the expression renderer handles.
 */
const parseFlowConditionTriplet = (raw: unknown): CriteriaItem | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const fieldRaw = pickTripletMember(obj, ['leftValueReference', 'field']);
  if (fieldRaw === null) {
    return null;
  }
  const operatorRaw = unwrapSingle(obj['operator']);
  if (operatorRaw === undefined || operatorRaw === null || operatorRaw === '') {
    return null;
  }
  const rightValueRaw = pickTripletMember(obj, ['rightValue', 'value']);
  let value: string | null = null;
  if (typeof rightValueRaw === 'object' && rightValueRaw !== null) {
    const wrapper = rightValueRaw as Record<string, unknown>;
    // Try the documented scalar wrappers in source order.
    for (const key of [
      'stringValue',
      'numberValue',
      'booleanValue',
      'dateValue',
      'dateTimeValue',
      'elementReference',
    ]) {
      const v = unwrapSingle(wrapper[key]);
      if (v !== undefined && v !== null && v !== '') {
        value = String(v);
        break;
      }
    }
  } else if (rightValueRaw !== undefined && rightValueRaw !== null && rightValueRaw !== '') {
    value = String(rightValueRaw);
  }
  return {
    field: String(fieldRaw),
    operation: String(operatorRaw),
    value,
  };
};

/**
 * Build the list of v2.0a `ConditionSource` entries for a Flow.
 * Walks the two condition-bearing XML surfaces per
 * `ConditionalContextSemantics.md` §"Flow conditions":
 *
 *   1. `<decisions><rules>` — one source per `<rules>` element
 *      (`kind: 'flow-decision'`). The `<recordLookups>` filter shape
 *      is out of scope (those are query criteria, not firing
 *      conditions; per the spec).
 *   2. The record-trigger filter surface — either `<start><filters>`
 *      with structured triplets or `<start><filterFormula>` as a
 *      bare formula string. Modern Flow XML uses the latter; older
 *      record-trigger Flow XML uses `<recordTriggers><filters>` (we
 *      check both shapes for forward / backward compat).
 *
 * Source order is preserved so the synthetic-id indices are stable
 * across extraction runs.
 */
/**
 * Compose the human-readable `sourceName` for a Flow decision's condition
 * source from the decision element `<name>` and the matched rule `<name>`.
 * Renders `Decision (Rule)` when both are present, the non-null one alone
 * when only one is, and `null` when neither is — in which case explain_flow
 * falls back to the synthetic `condition-N` handle. Both names come straight
 * from the Flow XML (`declared`); no identifier is fabricated.
 */
const buildFlowDecisionSourceName = (
  decisionName: string | null,
  ruleName: string | null,
): string | null => {
  if (decisionName !== null && ruleName !== null) {
    return `${decisionName} (${ruleName})`;
  }
  return decisionName ?? ruleName;
};

const collectFlowConditionSources = (
  rootObj: Record<string, unknown>,
): readonly ConditionSource[] => {
  const sources: ConditionSource[] = [];

  // `<decisions>` block.
  const decisions = toArray(rootObj['decisions']);
  for (const decision of decisions) {
    if (typeof decision !== 'object' || decision === null) continue;
    const decisionObj = decision as Record<string, unknown>;
    // The decision element's API name (`<decisions><name>`) — the real name a
    // reader recognises (e.g. `My_Decision`), vs the synthetic `condition-N`
    // handle. Captured here and threaded onto the ConditionalContext node +
    // mirror so explain_flow can label the decision row with it.
    const decisionName = toNonEmptyString(decisionObj['name']);
    const rules = toArray(decisionObj['rules']);
    for (const rule of rules) {
      if (typeof rule !== 'object' || rule === null) continue;
      const ruleObj = rule as Record<string, unknown>;
      const conditions: CriteriaItem[] = [];
      for (const triplet of toArray(ruleObj['conditions'])) {
        const parsed = parseFlowConditionTriplet(triplet);
        if (parsed !== null) conditions.push(parsed);
      }
      if (conditions.length === 0) continue;
      const conditionLogic = toNullableString(ruleObj['conditionLogic']);
      // The rule (outcome) name (`<rules><name>`) disambiguates the multiple
      // sources a multi-outcome decision produces (each `<rules>` is one
      // source → one `condition-N`). Combine decision + rule for the label.
      const ruleName = toNonEmptyString(ruleObj['name']);
      sources.push({
        kind: 'flow-decision',
        conditions,
        conditionLogic,
        sourceName: buildFlowDecisionSourceName(decisionName, ruleName),
      });
    }
  }

  // `<start><filters>` or `<start><filterFormula>` — the modern shape
  // for record-triggered Flows.
  const start = unwrapSingle(rootObj['start']);
  if (typeof start === 'object' && start !== null) {
    const startObj = start as Record<string, unknown>;
    const filterFormula = toNullableString(startObj['filterFormula']);
    const startFilters: CriteriaItem[] = [];
    for (const triplet of toArray(startObj['filters'])) {
      const parsed = parseFlowConditionTriplet(triplet);
      if (parsed !== null) startFilters.push(parsed);
    }
    const filterLogic = toNullableString(startObj['filterLogic']);
    if (
      (filterFormula !== null && filterFormula.length > 0) ||
      startFilters.length > 0
    ) {
      sources.push({
        kind: 'flow-recordtrigger',
        filters: startFilters,
        filterLogic,
        filterFormula,
      });
    }
  }

  // Older `<recordTriggers>` shape (kept for compat — some legacy
  // record-trigger Flow XML uses this top-level element instead of
  // `<start><filters>`).
  const recordTriggers = toArray(rootObj['recordTriggers']);
  for (const trigger of recordTriggers) {
    if (typeof trigger !== 'object' || trigger === null) continue;
    const triggerObj = trigger as Record<string, unknown>;
    const triggerFilters: CriteriaItem[] = [];
    for (const triplet of toArray(triggerObj['filters'])) {
      const parsed = parseFlowConditionTriplet(triplet);
      if (parsed !== null) triggerFilters.push(parsed);
    }
    const triggerLogic = toNullableString(triggerObj['filterLogic']);
    const triggerFormula = toNullableString(triggerObj['filterFormula']);
    if (
      (triggerFormula !== null && triggerFormula.length > 0) ||
      triggerFilters.length > 0
    ) {
      sources.push({
        kind: 'flow-recordtrigger',
        filters: triggerFilters,
        filterLogic: triggerLogic,
        filterFormula: triggerFormula,
      });
    }
  }

  return sources;
};

/**
 * Read an edge's DML `operation` marker (`recordLookup` / `recordCreate` /
 * `recordUpdate` / `recordDelete` / …) as a string, or `''` when the edge
 * carries no `operation` property. Used as the fourth dedup/sort dimension so
 * distinct DML operations on the SAME object stay DISTINCT edges.
 */
const edgeOperation = (edge: Edge): string => {
  const op = edge.properties && edge.properties['operation'];
  return op === undefined || op === null ? '' : String(op);
};

/**
 * Deduplicate edges by the composite key
 * `(fromId, toId, edgeType, source, operation)` and sort the result for
 * stable output: by `toId` ascending, then by `edgeType` ascending, then by
 * `operation` ascending. The first occurrence of each key wins (which
 * preserves the original `properties` payload for that key).
 *
 * The `operation` dimension is load-bearing: a Flow that does a
 * `recordLookup` + `recordCreate` + `recordUpdate` on the SAME object emits
 * `readsFrom`(recordLookup), `writesTo`(recordCreate), `readsFrom`(recordUpdate)
 * and `writesTo`(recordUpdate) edges to that object. Keying only on
 * `(from, to, type, source)` collapsed the two `writesTo` edges into one —
 * only the first-emitted operation (recordCreate) survived — and likewise
 * merged the two `readsFrom` reads. Including `operation` keeps each distinct
 * DML operation as its own edge while genuine same-operation duplicates (two
 * `<recordLookups>` on one object) still share a key and dedup. Non-DML edges
 * (triggersOn / callsApex / references / …) have no `operation` property, so
 * their key suffix is `''` and their behaviour is byte-identical to before.
 *
 * Sorting matters because golden tests do deep equality; without it,
 * the order of edges would depend on the order of the source XML's
 * `<recordLookups>` vs `<recordCreates>` etc., which is not a property
 * of the Flow we want tests to depend on.
 */
const dedupeAndSortEdges = (edges: readonly Edge[]): Edge[] => {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const edge of edges) {
    const key = `${edge.fromId}|${edge.toId}|${edge.edgeType}|${edge.source}|${edgeOperation(edge)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  out.sort((a, b) => {
    if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
    if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
    const opA = edgeOperation(a);
    const opB = edgeOperation(b);
    if (opA !== opB) return opA < opB ? -1 : 1;
    return 0;
  });
  return out;
};

/**
 * Extract a Node and edges from a single Salesforce `*.flow-meta.xml`
 * file.
 *
 * Reads the file, parses it as XML, validates required elements per
 * the vendored `Flow.md` spec, and returns an `ExtractionResult`
 * containing one `Node` of type `'Flow'` plus zero-to-many edges
 * derived from the Flow's semantic body:
 *
 *   - `<start>` → one `triggersOn` edge to the trigger object
 *     (record-triggered flows only; confidence `declared`).
 *   - `<actionCalls>` with `actionType=apex` → one `callsApex` edge
 *     per call.
 *   - `<recordLookups>` → one `readsFrom` edge per lookup.
 *   - `<recordCreates>` → one OBJECT-level `writesTo` edge per create,
 *     plus one FIELD-level `writesTo` edge per `<inputAssignments><field>`.
 *   - `<recordUpdates>` → one `readsFrom` + one OBJECT-level `writesTo`
 *     per update, plus one FIELD-level `writesTo` per `<inputAssignments>`.
 *   - R7-W1: a create/update/delete that names a whole record VARIABLE via
 *     `<inputReference>` (no `<object>`, no `<inputAssignments>`) resolves the
 *     variable to its declared `<objectType>` and emits ONLY the OBJECT-level
 *     edge, at `declared` confidence, carrying `wholeRecord: true` +
 *     `disclosure` (individual fields are NOT enumerable from a record-variable
 *     DML — no per-field edges are fabricated). Before this, such a write emitted
 *     NO edges — a false-safe. (`$Record` inputReference remains the separate,
 *     heuristic trigger-record path, unchanged.)
 *   - R6-11: each FIELD-level `writesTo` whose `<value>` is an
 *     `<elementReference>` carries the traced dataflow properties
 *     (`sourceFields` / `sourceFieldConfidence` / `unresolvedSourceCount`,
 *     plus `sourceTraceDepthCapped` when the chain was cut at the trace
 *     cap) — see `flow-dataflow.ts` for the trace rules and the honesty
 *     contract (declared vs heuristic vs disclosed-unresolved).
 *   - R7-W2: a before-save (`RecordBeforeSave`) flow's `<assignments>` item
 *     that sets `$Record.<Field>` emits a FIELD-level `writesTo` edge to
 *     `CustomField:{TriggerObject}.{Field}` (confidence `declared`,
 *     `operation: 'beforeSaveFieldAssignment'`) — the classic "before-save flow
 *     sets a field" pattern, previously invisible. After-save / before-delete
 *     `$Record` assignments do NOT persist and are disclosed, not emitted.
 *   - R6-11: one FIELD-level `readsFrom` edge per resolved dataflow SOURCE
 *     field (`properties.operation: 'dataflowSource'`,
 *     `properties.targetFields` naming the fields it feeds), so downstream
 *     lineage walks cross the flow from the source side — the same shape
 *     the apex-scanner emits for Apex field reads. (The R7-W2 before-save
 *     assignment feeds this the same way DML input assignments do.)
 *   - `<recordDeletes>` → one `writesTo` edge per delete.
 *   - `<subflows>` → one `references` edge per subflow call to the
 *     target `Flow:{flowName}` (confidence `declared`,
 *     `referenceKind: 'subflow'`). This is the ONLY flow→flow edge;
 *     without it a subflow called by N parents reads as having zero
 *     dependents (R6-02).
 *
 * Edges are deduplicated by `(fromId, toId, edgeType, source)` and
 * sorted by `toId`, then `edgeType` for byte-stable test output.
 *
 * Defensive: per-element parse failures collect into
 * `node.properties.flowExtractionWarnings` rather than failing the
 * whole extraction. The Flow's `<status>` validation and root-element
 * checks still hard-fail per the documented error contract.
 *
 * Decisions, screens, and non-apex action types remain out of scope as
 * ELEMENTS (no element-level nodes are minted); see `Flow.md` v0.2
 * section "Deferred to v0.3". `<assignments>`, `<variables>`,
 * `<formulas>`, and `<loops>` are PARSED (R6-11) — not as elements, but as
 * the dataflow plumbing that maps DML input assignments back to their
 * record-field sources; R7-W2 additionally reads `<assignments>` items that
 * write `$Record.<Field>` in a before-save flow as first-class field writes,
 * and R7-W1 reads `<variables>` objectTypes to resolve whole-record
 * `<inputReference>` DML. Subflow calls (`<subflows>`) ARE modeled as of R6-02
 * (see the `<subflows>` bullet above).
 *
 * @example
 *   const result = await extractFlow(
 *     'tests/fixtures/edu-org/source/main/default/flows/RT_CU_BS_Update_Number_of_Event_Members_on_Engagement.flow-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'Flow:RT_CU_BS_Update_Number_of_Event_Members_on_Engagement'
 *     console.log(result.value.edges[0].edgeType);
 *     // => 'triggersOn'
 *   }
 */
/**
 * Fault-coverage of a Flow's faultable elements. DML/action elements
 * (recordCreates/Updates/Deletes/Lookups, actionCalls) may carry a
 * `<faultConnector>` that routes errors to a handler; an element without one
 * lets a runtime error halt the interview silently. Counts the faultable
 * elements lacking a fault path so `flow_fault_audit` can flag unhandled flows.
 */
interface FlowFaultCoverage {
  readonly faultableElementCount: number;
  readonly elementsWithoutFault: number;
  readonly hasUnhandledFaults: boolean;
}
const FAULTABLE_ELEMENTS = [
  'actionCalls',
  'recordCreates',
  'recordUpdates',
  'recordDeletes',
  'recordLookups',
] as const;
const analyzeFaultCoverage = (
  rootObj: Record<string, unknown>,
): FlowFaultCoverage => {
  let faultableElementCount = 0;
  let elementsWithoutFault = 0;
  for (const key of FAULTABLE_ELEMENTS) {
    for (const el of toArray(rootObj[key])) {
      faultableElementCount += 1;
      const hasFault =
        el !== null &&
        typeof el === 'object' &&
        (el as Record<string, unknown>)['faultConnector'] !== undefined;
      if (!hasFault) elementsWithoutFault += 1;
    }
  }
  return {
    faultableElementCount,
    elementsWithoutFault,
    hasUnhandledFaults: elementsWithoutFault > 0,
  };
};

/**
 * CUSTOM-LABEL-USAGES-MISS-FLOW-LABEL-REFS: build heuristic `references` edges
 * from a Flow to every Custom Label it references via the `$Label.{ApiName}`
 * merge syntax (e.g. a formula `<expression>{!$Label.Sample_Label}
 * </expression>` in an Active flow).
 *
 * These references live in `<expression>` / text-template / default-value
 * strings that no existing flow builder scans, so `find_component_usages` on
 * the label returned 0 graph + 0 grep (the grep tier discloses Apex/LWC/Aura/VF
 * only — Flow XML excluded) and `review_change` delete read `safe` — even
 * though `search_flow_metadata` DID find the same `$Label` string on another
 * path. Emitting the edge closes that gap: label usages and the change gate now
 * see the binding Flow.
 *
 * Scans the raw flow XML for `$Label.{name}` (name = `[A-Za-z0-9_]+`, covering
 * a namespaced `ns__Label`). Deduped + sorted; `heuristic` confidence — a raw
 * value scan, not a parsed formula AST. `referenceKind: 'flowLabelRef'`.
 */
const FLOW_LABEL_REF_PATTERN = /\$Label\.([A-Za-z0-9_]+)/g;
const buildLabelReferenceEdges = (flowId: string, xmlText: string): Edge[] => {
  const names = new Set<string>();
  FLOW_LABEL_REF_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FLOW_LABEL_REF_PATTERN.exec(xmlText)) !== null) {
    const name = m[1];
    if (name !== undefined && name.length > 0) names.add(name);
  }
  return [...names].sort().map((name) => ({
    fromId: flowId,
    toId: `CustomLabel:${name}`,
    edgeType: 'references',
    confidence: 'heuristic',
    source: EDGE_SOURCE,
    properties: { referenceKind: 'flowLabelRef' },
  }));
};

export const extractFlow = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Shared options (see {@link FLOW_XML_PARSER_OPTIONS}) so this and the
  // flow-graph projection parse Flow XML byte-identically.
  const parser = new XMLParser(FLOW_XML_PARSER_OPTIONS);
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce — e.g., the `maxTotalExpansions` entity-reference
  // cap (raised to 10000 above; see JSDoc). Catch it here so a single
  // bad file becomes a per-file `parse-error` rather than aborting
  // `runRefresh` for the whole vault.
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlResult.value) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const rootResult = validateRoot(parsed, path);
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const status = String(unwrapSingle(rootObj['status']));
  if (!ALLOWED_STATUS.includes(status as FlowStatus)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid status: ${status}`,
    });
  }

  const apiName = deriveComponentApiName(path, FLOW_FILE_SUFFIX);
  const label = String(unwrapSingle(rootObj['label']));
  const processType = String(unwrapSingle(rootObj['processType']));
  // Default a missing/unparseable <apiVersion> to null (not NaN): the field
  // is optional and the graph column is `number | null`.
  const apiVersionParsed = Number(unwrapSingle(rootObj['apiVersion']));
  const apiVersion = Number.isFinite(apiVersionParsed) ? apiVersionParsed : null;
  const startProps = extractStartProperties(rootObj);
  const faultCoverage = analyzeFaultCoverage(rootObj);
  const actionCallSummaries = collectActionCallSummaries(rootObj);

  // Semantic walk: collect edges from every body section. Each builder
  // pushes onto `warnings` instead of throwing so one bad element
  // doesn't lose all the others.
  const flowId = `${ROOT_ELEMENT}:${apiName}`;
  const warnings: string[] = [];
  const rawEdges: Edge[] = [];
  const startEdge = buildStartEdge(flowId, rootObj, warnings);
  if (startEdge !== null) rawEdges.push(startEdge);
  const platformEventListensToEdge = buildPlatformEventListensToEdge(
    flowId,
    rootObj,
    warnings,
  );
  if (platformEventListensToEdge !== null) {
    rawEdges.push(platformEventListensToEdge);
  }
  // R6-11: the dataflow index resolves DML input references back to record
  // fields; `$Record` names the `<start><object>` only for record-scoped
  // trigger types (same rule `resolveInputReferenceObject` applies to DML
  // targets). The collector aggregates resolved source fields across every
  // DML element for the field-level dataflow `readsFrom` edges below.
  const dataflowIndex = buildFlowDataflowIndex(
    rootObj,
    startProps.triggerType !== null &&
      RECORD_SCOPED_TRIGGER_TYPES.has(startProps.triggerType)
      ? startProps.triggerObject
      : null,
  );
  const dataflowCollector: DataflowSourceCollector = new Map();
  rawEdges.push(...buildActionCallEdges(flowId, rootObj, warnings));
  rawEdges.push(...buildSubflowEdges(flowId, rootObj, warnings));
  rawEdges.push(...buildRecordLookupEdges(flowId, rootObj, warnings));
  rawEdges.push(
    ...buildRecordCreateEdges(flowId, rootObj, warnings, dataflowIndex, dataflowCollector),
  );
  rawEdges.push(
    ...buildRecordUpdateEdges(flowId, rootObj, warnings, dataflowIndex, dataflowCollector),
  );
  rawEdges.push(...buildRecordDeleteEdges(flowId, rootObj, warnings, dataflowIndex));
  // R7-W2: before-save $Record.<Field> assignment writes. Runs BEFORE
  // buildDataflowReadEdges so its traced source fields are in the collector.
  rawEdges.push(
    ...buildBeforeSaveFieldAssignmentEdges(
      flowId,
      rootObj,
      startProps,
      warnings,
      dataflowIndex,
      dataflowCollector,
    ),
  );
  rawEdges.push(...buildDataflowReadEdges(flowId, dataflowCollector));
  // CUSTOM-LABEL-USAGES-MISS-FLOW-LABEL-REFS: `$Label.{ApiName}` merge refs in
  // formulas / text templates → heuristic `references` edges to the CustomLabel
  // node. Scans the raw XML (the refs live in string content no other builder
  // reads).
  rawEdges.push(...buildLabelReferenceEdges(flowId, xmlResult.value));
  const edges = dedupeAndSortEdges(rawEdges);

  // v2.0a — Build the per-Flow ConditionalContext nodes. The Flow's
  // `parentObjectApiName` is the record-trigger's target object (the
  // `<start><object>` value), so field references like `Industry__c`
  // resolve to that object's CustomField. For non-record-triggered
  // Flows (autolaunched / screen / scheduled), `parentObjectApiName`
  // is null and bare field names remain in their dangling form per
  // the helper's documented behaviour.
  const conditionSources = collectFlowConditionSources(rootObj);
  const { conditionNodes, firesWhenEdges, conditionsMirror, conditionFieldEdges } =
    extractConditions({
      parentId: flowId,
      sources: conditionSources,
      parentSourcePath: path,
      parentApiVersion: apiVersion,
      parentObjectApiName: startProps.triggerObject,
    });
  // firesWhen edges are appended after `dedupeAndSortEdges`; they
  // already carry unique synthetic ids and sorting them in alongside
  // the rest would scatter them throughout the edge list. The
  // alphabetic-by-toId convention already places
  // `ConditionalContext:...` entries near the top of any sort.
  const allEdges = [...edges, ...firesWhenEdges, ...conditionFieldEdges];

  const node: Node = {
    id: flowId,
    type: 'Flow',
    apiName,
    label,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion,
    properties: {
      label,
      description: toNullableString(rootObj['description']),
      processType,
      status,
      interviewLabel: toNullableString(rootObj['interviewLabel']),
      runInMode: toNullableString(rootObj['runInMode']),
      triggerObject: startProps.triggerObject,
      triggerType: startProps.triggerType,
      recordTriggerType: startProps.recordTriggerType,
      // T7: design-time schedule from <start><schedule>. startTime is UTC
      // (trailing Z); local run time needs the org timezone (not in vault).
      scheduleFrequency: startProps.scheduleFrequency,
      scheduleStartDate: startProps.scheduleStartDate,
      scheduleStartTime: startProps.scheduleStartTime,
      // bundle-4(c): async post-commit scheduled paths from
      // <start><scheduledPaths>. `scheduledPathTypes` lists each declared
      // <pathType> in source order; `runAsyncAfterCommit` is the convenience
      // flag explain_flow.buildFaultRollback reads to tell an async post-commit
      // RecordAfterSave flow (fault cannot roll back the committed save) from a
      // synchronous one.
      scheduledPathTypes: startProps.scheduledPathTypes,
      runAsyncAfterCommit: startProps.runAsyncAfterCommit,
      // True when <start> carries a direct <connector> child (not inside
      // <scheduledPaths>). A false value on a RecordAfterSave flow that has
      // scheduledPaths means the flow is scheduled-only (async) — it never
      // executes synchronously in the triggering transaction. The SOE tools
      // use this to place these flows in post-save-async rather than
      // post-save-flows.
      hasImmediateConnector: startProps.hasImmediateConnector,
      // bundle-4(a): every <actionCalls> element's {actionType, actionName}
      // (apex AND non-apex). Apex calls also get a `callsApex` edge; non-apex
      // action types (e.g. activateSessionPermSet) emit no edge, so this list
      // is the only place explain_flow can identify the faultable element type.
      actionCalls: actionCallSummaries,
      flowExtractionWarnings: warnings,
      conditions: conditionsMirror,
      faultableElementCount: faultCoverage.faultableElementCount,
      elementsWithoutFault: faultCoverage.elementsWithoutFault,
      hasUnhandledFaults: faultCoverage.hasUnhandledFaults,
    },
  };

  return ok({ nodes: [node, ...conditionNodes], edges: allEdges });
};
