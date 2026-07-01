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
import { deriveComponentApiName } from './path-utils.js';

const FLOW_FILE_SUFFIX = '.flow-meta.xml';
const ROOT_ELEMENT = 'Flow';
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
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. fast-xml-parser
 * emits an object when an element appears once and an array when it
 * appears multiple times. Flow's `<actionCalls>`, `<recordLookups>`,
 * etc. may appear any number of times, so call sites consume an array.
 * Returns `[]` for `undefined`/`null`.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Coerce an XML scalar element to a nullable string. Missing or
 * `undefined` becomes `null`; everything else stringifies. Used for
 * optional string-valued elements that default to `null`.
 */
const toNullableString = (value: unknown): string | null => {
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
const toNonEmptyString = (value: unknown): string | null => {
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

const buildInputAssignmentEdges = (
  flowId: string,
  element: Record<string, unknown>,
  object: string,
  operation: 'recordCreate' | 'recordUpdate',
  elementLabel: string,
  warnings: string[],
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
 * Build `writesTo` edges from `<recordCreates>` elements. Each create targets
 * the SObject named by `<object>` (OBJECT-level edge) and additionally writes
 * each field named in its `<inputAssignments>` (FIELD-level edges via
 * {@link buildInputAssignmentEdges}). Both are kept: the object-level edge is
 * what record-creation / impact consumers query, the field-level edges record
 * which fields the create actually sets.
 */
const buildRecordCreateEdges = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
): Edge[] => {
  const edges: Edge[] = [];
  const creates = toArray(rootObj['recordCreates']);
  for (let i = 0; i < creates.length; i += 1) {
    const create = creates[i];
    try {
      if (typeof create !== 'object' || create === null) continue;
      const createObj = create as Record<string, unknown>;
      const object = toNonEmptyString(createObj['object']);
      if (object === null) {
        warnings.push(`<recordCreates>[${i}] has no <object>`);
        continue;
      }
      edges.push({
        fromId: flowId,
        toId: `CustomObject:${object}`,
        edgeType: 'writesTo',
        confidence: 'parsed',
        source: EDGE_SOURCE,
        properties: { operation: 'recordCreate' },
      });
      edges.push(
        ...buildInputAssignmentEdges(
          flowId,
          createObj,
          object,
          'recordCreate',
          `<recordCreates>[${i}]`,
          warnings,
        ),
      );
    } catch (cause: unknown) {
      warnings.push(
        `failed to read <recordCreates>[${i}]: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return edges;
};

/**
 * Resolve an `<inputReference>`-style record DML target to its SObject api
 * name. `$Record` / `$Record__Prior` is the triggering record of a
 * record-triggered flow, whose type is the `<start><object>`. Returns that
 * object api name, or `null` when the reference is not the trigger record
 * (e.g. a loop/collection variable) or the flow is not record-triggered with
 * a resolvable trigger object — those remain unresolvable offline.
 */
const resolveInputReferenceObject = (
  dmlObj: Record<string, unknown>,
  rootObj: Record<string, unknown>,
): string | null => {
  const inputRef = toNonEmptyString(dmlObj['inputReference']);
  if (inputRef !== '$Record' && inputRef !== '$Record__Prior') return null;
  const start = extractStartProperties(rootObj);
  if (
    start.triggerType === null ||
    !RECORD_SCOPED_TRIGGER_TYPES.has(start.triggerType)
  ) {
    return null;
  }
  return start.triggerObject;
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
 * is inferred from the trigger type, not parsed from the element). A
 * non-`$Record` inputReference (a loop/collection variable) still can't be
 * resolved offline and is skipped with a warning.
 */
const buildRecordUpdateEdges = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
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
      if (object === null) {
        const resolved = resolveInputReferenceObject(updateObj, rootObj);
        if (resolved === null) {
          warnings.push(
            `<recordUpdates>[${i}] has no <object> and its <inputReference> is not the trigger record ($Record); skipped`,
          );
          continue;
        }
        object = resolved;
        confidence = 'heuristic';
      }
      const toId = `CustomObject:${object}`;
      edges.push({
        fromId: flowId,
        toId,
        edgeType: 'readsFrom',
        confidence,
        source: EDGE_SOURCE,
        properties: { operation: 'recordUpdate' },
      });
      edges.push({
        fromId: flowId,
        toId,
        edgeType: 'writesTo',
        confidence,
        source: EDGE_SOURCE,
        properties: { operation: 'recordUpdate' },
      });
      edges.push(
        ...buildInputAssignmentEdges(
          flowId,
          updateObj,
          object,
          'recordUpdate',
          `<recordUpdates>[${i}]`,
          warnings,
        ),
      );
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
 * Like `<recordUpdates>`, a delete can use `<inputReference>` instead
 * of `<object>`; we skip and warn in that case.
 */
const buildRecordDeleteEdges = (
  flowId: string,
  rootObj: Record<string, unknown>,
  warnings: string[],
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
      if (object === null) {
        const resolved = resolveInputReferenceObject(delObj, rootObj);
        if (resolved === null) {
          warnings.push(
            `<recordDeletes>[${i}] has no <object> and its <inputReference> is not the trigger record ($Record); skipped`,
          );
          continue;
        }
        object = resolved;
        confidence = 'heuristic';
      }
      edges.push({
        fromId: flowId,
        toId: `CustomObject:${object}`,
        edgeType: 'writesTo',
        confidence,
        source: EDGE_SOURCE,
        properties: { operation: 'recordDelete' },
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
 * Parse a single Flow condition triplet (`<leftValueReference>`,
 * `<operator>`, `<rightValue>`) into the helper's `CriteriaItem`
 * shape. Flow `<rightValue>` is wrapped in a typed sub-element
 * (`<stringValue>`, `<numberValue>`, `<elementReference>`, etc.); the
 * extractor preserves whichever scalar form is present, falling back
 * to JSON-stringifying the wrapper when nothing matches (rare).
 */
const parseFlowConditionTriplet = (raw: unknown): CriteriaItem | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const fieldRaw = unwrapSingle(obj['leftValueReference']);
  if (fieldRaw === undefined || fieldRaw === null || fieldRaw === '') {
    return null;
  }
  const operatorRaw = unwrapSingle(obj['operator']);
  if (operatorRaw === undefined || operatorRaw === null || operatorRaw === '') {
    return null;
  }
  const rightValueRaw = unwrapSingle(obj['rightValue']);
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
const collectFlowConditionSources = (
  rootObj: Record<string, unknown>,
): readonly ConditionSource[] => {
  const sources: ConditionSource[] = [];

  // `<decisions>` block.
  const decisions = toArray(rootObj['decisions']);
  for (const decision of decisions) {
    if (typeof decision !== 'object' || decision === null) continue;
    const decisionObj = decision as Record<string, unknown>;
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
      sources.push({ kind: 'flow-decision', conditions, conditionLogic });
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
 * Deduplicate edges by the composite key
 * `(fromId, toId, edgeType, source)` and sort the result for stable
 * output: by `toId` ascending, then by `edgeType` ascending. The first
 * occurrence of each key wins (which preserves the original
 * `properties` payload for that key).
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
    const key = `${edge.fromId}|${edge.toId}|${edge.edgeType}|${edge.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  out.sort((a, b) => {
    if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
    if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
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
 *   - `<recordDeletes>` → one `writesTo` edge per delete.
 *
 * Edges are deduplicated by `(fromId, toId, edgeType, source)` and
 * sorted by `toId`, then `edgeType` for byte-stable test output.
 *
 * Defensive: per-element parse failures collect into
 * `node.properties.flowExtractionWarnings` rather than failing the
 * whole extraction. The Flow's `<status>` validation and root-element
 * checks still hard-fail per the documented error contract.
 *
 * Decisions, assignments, screens, loops, subflows, and non-apex
 * action types are still out of scope; see `Flow.md` v0.2 section
 * "Deferred to v0.3" for the next slice.
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

export const extractFlow = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  /**
   * Flow metadata files are local trusted disk content sourced from
   * `sf project retrieve`; XXE is not a concern. The default 1000
   * limit is too tight for real Flows in production orgs. Raising to
   * 10000 to accept legitimate complex flows while preserving a
   * pathological-input ceiling.
   */
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
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
  rawEdges.push(...buildActionCallEdges(flowId, rootObj, warnings));
  rawEdges.push(...buildRecordLookupEdges(flowId, rootObj, warnings));
  rawEdges.push(...buildRecordCreateEdges(flowId, rootObj, warnings));
  rawEdges.push(...buildRecordUpdateEdges(flowId, rootObj, warnings));
  rawEdges.push(...buildRecordDeleteEdges(flowId, rootObj, warnings));
  const edges = dedupeAndSortEdges(rawEdges);

  // v2.0a — Build the per-Flow ConditionalContext nodes. The Flow's
  // `parentObjectApiName` is the record-trigger's target object (the
  // `<start><object>` value), so field references like `Industry__c`
  // resolve to that object's CustomField. For non-record-triggered
  // Flows (autolaunched / screen / scheduled), `parentObjectApiName`
  // is null and bare field names remain in their dangling form per
  // the helper's documented behaviour.
  const conditionSources = collectFlowConditionSources(rootObj);
  const { conditionNodes, firesWhenEdges, conditionsMirror } =
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
  const allEdges = [...edges, ...firesWhenEdges];

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
