import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
import { deriveDotSplitObjectAndApiName } from './path-utils.js';
import {
  buildAlertTemplateMap,
  buildFieldUpdateTargetMap,
  isWellFormedFieldRef,
  type FieldUpdateTarget,
} from './workflow-rule.js';

const APPROVAL_PROCESS_FILE_SUFFIX = '.approvalProcess-meta.xml';
const ROOT_ELEMENT = 'ApprovalProcess';
const EXTRACTOR_SOURCE = 'approval-process-extractor';
/**
 * CR-CAP-07: an ApprovalProcess FieldUpdate hook action carries only the
 * field-update NAME (`<action><name>`); the actual target `<field>` lives in
 * the OBJECT's sibling `workflows/{Object}.workflow-meta.xml` file's
 * `<fieldUpdates>` collection — NOT in the .approvalProcess file. This suffix
 * names that sibling file (mirrors `WORKFLOW_FILE_SUFFIX` in workflow-rule.ts).
 */
const WORKFLOW_FILE_SUFFIX = '.workflow-meta.xml';

/**
 * Variant table for the `<approver><type>` discriminator per
 * `ApprovalProcess.md`. Each entry resolves to a target-id prefix; some
 * variants are scoped by the parent object (field references) and some
 * are not (Role, Group, Queue, User — global namespaces). Extra
 * properties may be attached (e.g., `includeSubordinates` for
 * `roleSubordinates`).
 */
interface ApproverVariantSpec {
  readonly idPrefix: string;
  readonly scopedByObject: boolean;
  readonly extraProps: Readonly<Record<string, unknown>>;
}

const APPROVER_VARIANT_TABLE: Readonly<Record<string, ApproverVariantSpec>> = {
  user: { idPrefix: 'User', scopedByObject: false, extraProps: {} },
  userHierarchyField: {
    idPrefix: 'CustomField',
    scopedByObject: true,
    extraProps: {},
  },
  relatedUserField: {
    idPrefix: 'CustomField',
    scopedByObject: true,
    extraProps: {},
  },
  role: { idPrefix: 'Role', scopedByObject: false, extraProps: {} },
  roleSubordinates: {
    idPrefix: 'Role',
    scopedByObject: false,
    extraProps: { includeSubordinates: true },
  },
  group: { idPrefix: 'Group', scopedByObject: false, extraProps: {} },
  queue: { idPrefix: 'Queue', scopedByObject: false, extraProps: {} },
};

/**
 * Approver types that may legitimately carry NO `<name>`: a hierarchy approver
 * can be the built-in standard Manager field with no explicit field name. There
 * is then no component to reference, so the approver is skipped (no edge) rather
 * than failing the whole ApprovalProcess extraction — the node + `stepCount`
 * must survive. (A hierarchy approver WITH a `<name>` still emits its
 * `CustomField` edge through the normal path.)
 */
const NAME_OPTIONAL_APPROVER_TYPES: ReadonlySet<string> = new Set([
  'userHierarchyField',
  'relatedUserField',
  'adhoc',
]);

/**
 * Variant table for hook `<action>` types — identical shape to the
 * WorkflowRule `<actions>` variant table (per the spec's pointer to
 * `WorkflowRule.md`'s table). Hook actions emit edges with `hookType`
 * in `properties` so consumers can distinguish initial-submission from
 * final-approval from final-rejection from recall hooks.
 */
interface HookActionVariantSpec {
  readonly idPrefix: string;
  readonly scopedByObject: boolean;
  readonly edgeType: 'references' | 'callsApex';
}

const HOOK_ACTION_VARIANT_TABLE: Readonly<Record<string, HookActionVariantSpec>> = {
  Alert: {
    idPrefix: 'WorkflowAlert',
    scopedByObject: true,
    edgeType: 'references',
  },
  FieldUpdate: {
    idPrefix: 'WorkflowFieldUpdate',
    scopedByObject: true,
    edgeType: 'references',
  },
  Task: {
    idPrefix: 'WorkflowTask',
    scopedByObject: true,
    edgeType: 'references',
  },
  OutboundMessage: {
    idPrefix: 'OutboundMessage',
    scopedByObject: true,
    edgeType: 'references',
  },
  Apex: {
    idPrefix: 'ApexClass',
    scopedByObject: false,
    edgeType: 'callsApex',
  },
  FlowAction: {
    idPrefix: 'Flow',
    scopedByObject: false,
    edgeType: 'references',
  },
};

type HookType =
  | 'initialSubmission'
  | 'finalApproval'
  | 'finalRejection'
  | 'recall';

/** The XML element name → hookType pairs walked in order, per the spec. */
const HOOK_LIST_NAMES: readonly { readonly element: string; readonly hookType: HookType }[] = [
  { element: 'initialSubmissionActions', hookType: 'initialSubmission' },
  { element: 'finalApprovalActions', hookType: 'finalApproval' },
  { element: 'finalRejectionActions', hookType: 'finalRejection' },
  { element: 'recallActions', hookType: 'recall' },
];

/**
 * Unwrap a possibly-array single-occurrence XML child.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Coerce an XML scalar to a boolean. Salesforce-style booleans serialise
 * as the lowercase string `'true'` / `'false'`.
 */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/** Return `<element>` value as a string, or `null` when absent/empty. */
const optionalString = (
  obj: Record<string, unknown>,
  key: string,
): string | null => {
  const raw = unwrapSingle(obj[key]);
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
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
 * Locate the `<ApprovalProcess>` root and verify the required `<label>`
 * and `<active>` elements. Field order matches the error-cases table.
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
  if (unwrapSingle(rootObj['label']) === undefined) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <label>',
    });
  }
  if (unwrapSingle(rootObj['active']) === undefined) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <active>',
    });
  }
  return ok(rootObj);
};

/**
 * Convert a slash-separated EmailTemplate reference (e.g.,
 * `Sales/ApprovalNeeded`) to its canonical id form
 * (`Sales.ApprovalNeeded`). Unfiled-public templates without a folder
 * retain their single-segment name.
 */
const templateRefToCanonicalTail = (templateRef: string): string =>
  templateRef.includes('/') ? templateRef.replace(/\//g, '.') : templateRef;

/** A resolved `<approver>` element. */
interface ResolvedApprover {
  readonly name: string;
  readonly type: string;
}

/** A resolved hook `<action>` element. */
interface ResolvedHookAction {
  readonly name: string;
  readonly type: string;
}

/**
 * Validate and resolve a single `<approver>` child. Both `<name>` and
 * `<type>` are required per the error-cases table; `<type>` values
 * outside the variant table return `malformed-input`.
 */
const resolveApprover = (
  approverRaw: unknown,
  path: string,
): Result<ResolvedApprover | null, ExtractorError> => {
  if (typeof approverRaw !== 'object' || approverRaw === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <name>',
    });
  }
  const approver = approverRaw as Record<string, unknown>;
  const nameRaw = unwrapSingle(approver['name']);
  if (nameRaw === undefined || nameRaw === null || nameRaw === '') {
    // A name-less hierarchy approver is the implicit standard Manager field —
    // no named component to reference, so skip it (the node + stepCount stay).
    const typePeek = unwrapSingle(approver['type']);
    if (
      typeof typePeek === 'string' &&
      NAME_OPTIONAL_APPROVER_TYPES.has(typePeek)
    ) {
      return ok(null);
    }
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <name>',
    });
  }
  const typeRaw = unwrapSingle(approver['type']);
  if (typeRaw === undefined || typeRaw === null || typeRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <type>',
    });
  }
  const typeValue = String(typeRaw);
  if (!(typeValue in APPROVER_VARIANT_TABLE)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid approver type: ${typeValue}`,
    });
  }
  return ok({ name: String(nameRaw), type: typeValue });
};

/**
 * Validate and resolve a hook `<action>` element. Both `<name>` and
 * `<type>` are required; unknown types are returned verbatim and
 * filtered later (silently skipped per the variant-table policy from
 * WorkflowRule).
 */
const resolveHookAction = (
  actionRaw: unknown,
): Result<ResolvedHookAction | null, ExtractorError> => {
  if (typeof actionRaw !== 'object' || actionRaw === null) {
    return ok(null);
  }
  const action = actionRaw as Record<string, unknown>;
  const nameRaw = unwrapSingle(action['name']);
  if (nameRaw === undefined || nameRaw === null || nameRaw === '') {
    return ok(null);
  }
  const typeRaw = unwrapSingle(action['type']);
  if (typeRaw === undefined || typeRaw === null || typeRaw === '') {
    return ok(null);
  }
  return ok({ name: String(nameRaw), type: String(typeRaw) });
};

/** Build a `references` edge for an approver entry. */
const approverEdge = (
  approver: ResolvedApprover,
  processId: string,
  objectApiName: string,
  stepIndex: number,
): Edge => {
  const spec = APPROVER_VARIANT_TABLE[approver.type]!;
  const targetTail = spec.scopedByObject
    ? `${objectApiName}.${approver.name}`
    : approver.name;
  const targetId = `${spec.idPrefix}:${targetTail}`;
  return {
    fromId: processId,
    toId: targetId,
    edgeType: 'references',
    confidence: 'declared',
    source: EXTRACTOR_SOURCE,
    properties: {
      stepIndex,
      approverType: approver.type,
      ...spec.extraProps,
    },
  };
};

/**
 * Walk one approval-steps entry, validating the assigned-approver
 * sub-tree, the optional `<notificationTemplate>`, and emitting the
 * required edges.
 */
const stepEdges = (
  stepRaw: unknown,
  stepIndex: number,
  processId: string,
  objectApiName: string,
  path: string,
): Result<readonly Edge[], ExtractorError> => {
  if (typeof stepRaw !== 'object' || stepRaw === null) {
    return ok([]);
  }
  const step = stepRaw as Record<string, unknown>;
  const edges: Edge[] = [];

  const assigned = unwrapSingle(step['assignedApprover']);
  if (typeof assigned === 'object' && assigned !== null) {
    const approvers = toArray(
      (assigned as Record<string, unknown>)['approver'],
    );
    for (const approverRaw of approvers) {
      const resolved = resolveApprover(approverRaw, path);
      if (!resolved.ok) return resolved;
      // null = a name-less hierarchy approver (implicit Manager) with no named
      // target — skip the edge, keep walking.
      if (resolved.value === null) continue;
      edges.push(
        approverEdge(resolved.value, processId, objectApiName, stepIndex),
      );
    }
  }

  const notificationTemplate = optionalString(step, 'notificationTemplate');
  if (notificationTemplate !== null) {
    edges.push({
      fromId: processId,
      toId: `EmailTemplate:${templateRefToCanonicalTail(notificationTemplate)}`,
      edgeType: 'sendsEmail',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { stepIndex, role: 'notification' },
    });
  }

  return ok(edges);
};

/**
 * A `{ name, type }` pair as it appears in an `<approver>` / hook `<action>`
 * element — the structured, edge-free view of an approval step's participants
 * and side-effects (APPROVAL-PROCESS-OMITS-STEP-APPROVER-BREAKDOWN). `name` /
 * `type` are `null` when the element omits them (e.g. an implicit standard
 * Manager hierarchy approver carries a `type` but no `name`).
 */
interface NamedTypedRef {
  readonly name: string | null;
  readonly type: string | null;
}

/**
 * The structured per-step breakdown surfaced on `properties.steps` — the
 * approver assignment, entry criteria, reject behavior, and per-step
 * approve/reject actions of ONE `<approvalStep>`, in declared order. Answers
 * "who approves at each step and what happens on reject?" from the node's own
 * facts, not from unordered `references` edges.
 */
interface ApprovalStepSummary {
  readonly stepIndex: number;
  readonly name: string | null;
  readonly label: string | null;
  readonly approvers: readonly NamedTypedRef[];
  readonly entryCriteriaFormula: string | null;
  readonly entryCriteriaItemCount: number;
  readonly ifCriteriaNotMet: string | null;
  readonly rejectBehaviorType: string | null;
  readonly approvalActions: readonly NamedTypedRef[];
  readonly rejectionActions: readonly NamedTypedRef[];
}

/**
 * Read a `{ name, type }` list from a container element's repeated `childKey`
 * children (e.g. `<assignedApprover>`'s `<approver>`s, or a hook list's
 * `<action>`s). Lenient by design — the strict validation stays in the edge
 * builders (`stepEdges` / `hookListEdges`); this structured mirror never fails
 * extraction, it just skips entirely-empty entries.
 */
const readNamedTypedList = (container: unknown, childKey: string): NamedTypedRef[] => {
  if (typeof container !== 'object' || container === null) return [];
  return toArray((container as Record<string, unknown>)[childKey]).flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const obj = item as Record<string, unknown>;
    const name = optionalString(obj, 'name');
    const type = optionalString(obj, 'type');
    if (name === null && type === null) return [];
    return [{ name, type }];
  });
};

/** Summarize one `<approvalStep>` into its structured, edge-free breakdown. */
const summarizeApprovalStep = (stepRaw: unknown, stepIndex: number): ApprovalStepSummary => {
  const step =
    typeof stepRaw === 'object' && stepRaw !== null
      ? (stepRaw as Record<string, unknown>)
      : {};
  const assigned = unwrapSingle(step['assignedApprover']);
  const entryCriteriaRaw = unwrapSingle(step['entryCriteria']);
  const entryCriteria =
    typeof entryCriteriaRaw === 'object' && entryCriteriaRaw !== null
      ? (entryCriteriaRaw as Record<string, unknown>)
      : null;
  const rejectBehaviorRaw = unwrapSingle(step['rejectBehavior']);
  const rejectBehavior =
    typeof rejectBehaviorRaw === 'object' && rejectBehaviorRaw !== null
      ? (rejectBehaviorRaw as Record<string, unknown>)
      : null;
  return {
    stepIndex,
    name: optionalString(step, 'name'),
    label: optionalString(step, 'label'),
    approvers: readNamedTypedList(assigned, 'approver'),
    entryCriteriaFormula: entryCriteria === null ? null : optionalString(entryCriteria, 'formula'),
    entryCriteriaItemCount:
      entryCriteria === null ? 0 : toArray(entryCriteria['criteriaItems']).length,
    ifCriteriaNotMet: optionalString(step, 'ifCriteriaNotMet'),
    rejectBehaviorType: rejectBehavior === null ? null : optionalString(rejectBehavior, 'type'),
    approvalActions: readNamedTypedList(unwrapSingle(step['approvalActions']), 'action'),
    rejectionActions: readNamedTypedList(unwrapSingle(step['rejectionActions']), 'action'),
  };
};

/**
 * The two name→target maps the sibling workflow file resolves for an
 * ApprovalProcess: the `<fieldUpdates>` field-update targets (CR-CAP-07) and
 * the `<alerts>` template map (W4.3). Both keys are the action `<name>` an
 * ApprovalProcess hook `<action>` carries.
 */
interface ObjectWorkflowMaps {
  readonly fieldUpdateMap: Readonly<Map<string, FieldUpdateTarget>>;
  readonly alertTemplateMap: Readonly<Map<string, string | null>>;
}

/**
 * CR-CAP-07 / W4.3 — load the OBJECT's `<fieldUpdates>` name→target map AND its
 * `<alerts>` name→template map from the SIBLING
 * `workflows/{Object}.workflow-meta.xml` file. This is a cross-file load for an
 * extractor: the `Extractor` type hands each extractor ONLY its own `path`, so
 * we DERIVE the sibling path. `approvalProcesses/` and `workflows/` are sibling
 * directories under `main/default/`, so the workflow file is
 * `dirname(dirname(approvalPath))/workflows/{Object}.workflow-meta.xml`. The
 * file is read + parsed ONCE and both maps are built from it.
 *
 * An ApprovalProcess `Alert` hook `<action>` carries only the alert NAME; the
 * alert's `<template>` (which names the EmailTemplate) lives in this sibling
 * workflow file's `<alerts>` collection — exactly the same cross-file shape as
 * the FieldUpdate case. Resolving it here lets each Alert hook emit a DIRECT
 * `references` edge to the EmailTemplate (W4.3), so the template's delete
 * blast-radius sees the ApprovalProcess dependent (the alert node is 2 hops
 * away; `find_component_usages` / delete verdicts count only 1-hop referrers).
 *
 * MUST fail-soft: a missing sibling workflow file is NORMAL (not every object
 * that has an approval process also defines workflows), and an unparseable one
 * must not sink the ApprovalProcess extraction. On ENOENT, parse-error, or any
 * other read failure, return EMPTY maps — the node, approver edges, sendsEmail
 * edges, and the `references` scaffolding edge all survive; absence simply
 * means no field-level `writesTo` and no alert-template `references` are minted
 * (the alert `references` scaffolding edge already documents the action).
 * Reuses `buildFieldUpdateTargetMap` + `buildAlertTemplateMap` from
 * workflow-rule.ts (single source of truth) so resolution semantics never drift.
 */
const loadObjectWorkflowMaps = async (
  approvalPath: string,
  objectApiName: string,
): Promise<ObjectWorkflowMaps> => {
  const empty: ObjectWorkflowMaps = {
    fieldUpdateMap: new Map(),
    alertTemplateMap: new Map(),
  };
  const workflowPath = join(
    dirname(dirname(approvalPath)),
    'workflows',
    `${objectApiName}${WORKFLOW_FILE_SUFFIX}`,
  );
  const xmlResult = await readAndValidateXml(workflowPath);
  // Fail-soft: ENOENT (no sibling workflow file) or parse-error → empty maps.
  if (!xmlResult.ok) return empty;

  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlResult.value) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const root = unwrapSingle(parsed['Workflow']);
  if (typeof root !== 'object' || root === null) return empty;
  const rootObj = root as Record<string, unknown>;
  return {
    fieldUpdateMap: buildFieldUpdateTargetMap(rootObj),
    alertTemplateMap: buildAlertTemplateMap(rootObj),
  };
};

/**
 * Walk one hook list, validating each `<action>` and emitting the
 * variant-table edges with `hookType` in properties.
 *
 * CR-CAP-07: a `FieldUpdate` hook action additionally emits a FIELD-level
 * `writesTo` edge to the `CustomField` the update SETS, resolved against the
 * `fieldUpdateMap` loaded from the sibling workflow file. This is
 * KEEP-the-`references`-ADD-the-`writesTo`, mirroring workflow-rule.ts: the
 * `references` edge still points at the `WorkflowFieldUpdate:{Object}.{name}`
 * scaffolding node; the new `writesTo` points at the real `CustomField` so
 * field-change-impact tools (CR-CAP-01) see the ApprovalProcess as a writer.
 */
const hookListEdges = (
  rootObj: Record<string, unknown>,
  hookElement: string,
  hookType: HookType,
  processId: string,
  objectApiName: string,
  fieldUpdateMap: Readonly<Map<string, FieldUpdateTarget>>,
  alertTemplateMap: Readonly<Map<string, string | null>>,
  seenEmailTemplates: Set<string>,
  _path: string,
): Result<readonly Edge[], ExtractorError> => {
  const hookContainerRaw = unwrapSingle(rootObj[hookElement]);
  if (typeof hookContainerRaw !== 'object' || hookContainerRaw === null) {
    return ok([]);
  }
  const hookContainer = hookContainerRaw as Record<string, unknown>;
  const actionRaws = toArray(hookContainer['action']);
  const edges: Edge[] = [];
  for (const actionRaw of actionRaws) {
    const resolved = resolveHookAction(actionRaw);
    if (!resolved.ok) return resolved;
    if (resolved.value === null) continue;
    const { name, type } = resolved.value;
    if (type === 'Send') continue;
    const spec = HOOK_ACTION_VARIANT_TABLE[type];
    // Unknown variant: silently skipped.
    if (spec === undefined) continue;
    const targetTail = spec.scopedByObject
      ? `${objectApiName}.${name}`
      : name;
    const targetId = `${spec.idPrefix}:${targetTail}`;
    if (spec.edgeType === 'callsApex') {
      edges.push({
        fromId: processId,
        toId: targetId,
        edgeType: 'callsApex',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: { hookType },
      });
    } else {
      edges.push({
        fromId: processId,
        toId: targetId,
        edgeType: 'references',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: { hookType, actionType: type },
      });
    }

    // W4.3: an `Alert` hook action names a WorkflowAlert whose `<template>`
    // (resolved from the sibling workflow file's `<alerts>` collection) names
    // the EmailTemplate the approval sends. The `references` above points at
    // the `WorkflowAlert:{Object}.{name}` scaffolding node (which is itself 1
    // hop from the EmailTemplate via the alert-node edge W4.3 adds in
    // workflow-rule.ts) — but `find_component_usages` / delete verdicts count
    // only DIRECT (1-hop) referrers, so without a DIRECT edge the template's
    // delete blast-radius would miss this ApprovalProcess dependent. Emit the
    // DIRECT `references` edge here (KEEP the WorkflowAlert `references`, ADD
    // the EmailTemplate one). Deduped per (process, template) across all four
    // hook lists via the shared `seenEmailTemplates` set so an alert reused in
    // several hooks emits ONE template edge. Fail-soft: a missing/unresolved
    // template (no sibling workflow file, or the alert has no `<template>`)
    // emits no edge — the WorkflowAlert `references` already documents the hook.
    if (type === 'Alert') {
      const template = alertTemplateMap.get(name);
      if (template !== undefined && template !== null) {
        const emailId = `EmailTemplate:${templateRefToCanonicalTail(template)}`;
        if (!seenEmailTemplates.has(emailId)) {
          seenEmailTemplates.add(emailId);
          edges.push({
            fromId: processId,
            toId: emailId,
            edgeType: 'references',
            confidence: 'declared',
            source: EXTRACTOR_SOURCE,
            properties: { referenceKind: 'alertTemplate', viaAlert: name, hookType },
          });
        }
      }
    }

    // CR-CAP-07: FieldUpdate hook actions additionally emit a FIELD-level
    // `writesTo` to the CustomField the update SETS — mirroring
    // workflow-rule.ts's `edgesForAction` exactly. The target field is NOT on
    // the `<action>` child (it carries only `<name>` == the field-update's
    // `<fullName>`); it lives in the sibling `workflows/{Object}.workflow-meta.xml`
    // file's `<fieldUpdates>` collection, resolved via `fieldUpdateMap`.
    //
    // CR-P3-5: a CROSS-OBJECT field update (Salesforce emits a `<targetObject>`)
    // sets a field on a RELATED record. `<targetObject>` is the relationship
    // reference, not the related object's API name, and the relationship→object
    // map is not resolvable offline — so we SKIP the `writesTo` (emit no edge)
    // rather than mint a relationship-scoped `CustomField:{rel}.{field}` phantom.
    // The `references` edge to the scaffolding node above STILL emits, so the
    // action is never silently dropped. Confidence is `parsed` (the field name
    // is read straight out of the workflow XML), matching workflow-rule.ts CR-05
    // and flow.ts — NOT `declared` (that tier is for the scaffolding ref).
    if (type === 'FieldUpdate') {
      const target = fieldUpdateMap.get(name);
      if (
        target !== undefined &&
        target.field !== null &&
        target.targetObject === null &&
        isWellFormedFieldRef(target.field)
      ) {
        const fieldTargetId = target.field.includes('.')
          ? `CustomField:${target.field}`
          : `CustomField:${objectApiName}.${target.field}`;
        edges.push({
          fromId: processId,
          toId: fieldTargetId,
          edgeType: 'writesTo',
          confidence: 'parsed',
          source: EXTRACTOR_SOURCE,
          properties: { hookType, operation: target.operation },
        });
      }
    }
  }
  return ok(edges);
};

/**
 * Extract `ApprovalProcess` Node and Edges from a single Salesforce
 * `*.approvalProcess-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<ApprovalProcess>`
 * root per the vendored `ApprovalProcess.md` spec, and returns an
 * `ExtractionResult` containing one `'ApprovalProcess'` Node and one
 * `parentOf` edge from `CustomObject:{ObjectApiName}`.
 *
 * The canonical ID derives from the filename — `{ObjectApiName}` and
 * `{ProcessName}` are split on the first dot. Each `<approvalStep>`
 * entry contributes one `references` edge per `<approver>` (the
 * approver chain), preserving step order via the `stepIndex`
 * property. It ALSO contributes a structured, edge-free summary to
 * `properties.steps` (approver assignment, entry criteria, reject
 * behavior, and per-step actions per step), and the four process-level
 * action hooks are mirrored as structured
 * `initialSubmission/finalApproval/finalRejection/recallActions` lists —
 * so the approve/reject path is answerable from the node's own facts. A step's optional `<notificationTemplate>` emits a
 * `sendsEmail` edge with `role: 'notification'`. The top-level
 * `<emailTemplate>` (when present) emits a `sendsEmail` edge with
 * `role: 'default'`. The four hook lists
 * (`<initialSubmissionActions>`, `<finalApprovalActions>`,
 * `<finalRejectionActions>`, `<recallActions>`) each contribute their
 * `<action>` children to the edge set with `hookType` set to the
 * originating hook name and the WorkflowRule variant-table edge
 * shapes (`callsApex` for `Apex`, `references` for everything else;
 * `Send` and unknown types silently skipped). W4.3: an `Alert` hook
 * action additionally emits a DIRECT `references` edge to the
 * `EmailTemplate:{Folder.Name}` its WorkflowAlert sends — the alert's
 * `<template>` is resolved from the sibling
 * `workflows/{Object}.workflow-meta.xml` file's `<alerts>` collection
 * (the same cross-file load used for FieldUpdate `writesTo`), so
 * "safe to delete EmailTemplate X?" sees the ApprovalProcess as a
 * direct dependent (deduped per template across the four hook lists;
 * fail-soft when the sibling file or the alert `<template>` is absent).
 *
 * Approver references are dangling-by-design for `user` (User nodes
 * are not extracted in v1.3) and `userHierarchyField` /
 * `relatedUserField` when the named field is outside the extracted
 * set; `role` / `group` / `queue` typically resolve to v1.1 nodes.
 *
 * Returns an `ExtractorError` for any documented failure mode:
 * `file-not-found`, `parse-error`, or `malformed-input` (filename not
 * splittable on a dot, wrong root, missing required element, or an
 * `<approver>` with an invalid `<type>`).
 *
 * @example
 *   const result = await extractApprovalProcess(
 *     'tests/fixtures/synthetic-v1.3/approvalProcesses/Opportunity.Discount_Approval.approvalProcess-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'ApprovalProcess:Opportunity.Discount_Approval'
 *   }
 */
export const extractApprovalProcess = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = deriveDotSplitObjectAndApiName(
    path,
    APPROVAL_PROCESS_FILE_SUFFIX,
  );
  if (pathParts === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot split filename into object and process name',
    });
  }
  const { objectApiName, apiName: processName } = pathParts;

  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is too
  // tight for production-scale ApprovalProcess XML.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
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

  // CR-CAP-07 / W4.3 — resolve the sibling object's workflow `<fieldUpdates>`
  // AND `<alerts>` maps ONCE (single file read) so each FieldUpdate hook action
  // can emit a field-level `writesTo` and each Alert hook action can emit a
  // DIRECT `references` to the EmailTemplate its alert sends. Fail-soft: a
  // missing/unparseable sibling workflow file yields empty maps (the
  // ApprovalProcess node + all other edges are unaffected).
  const { fieldUpdateMap, alertTemplateMap } = await loadObjectWorkflowMaps(
    path,
    objectApiName,
  );
  // W4.3 — dedup EmailTemplate `references` across the four hook lists so an
  // alert reused in several hooks emits ONE template edge per (process, template).
  const seenEmailTemplates = new Set<string>();

  const processId = `ApprovalProcess:${objectApiName}.${processName}`;
  const parentId = `CustomObject:${objectApiName}`;

  const label = String(unwrapSingle(rootObj['label']));
  const active = coerceBoolean(unwrapSingle(rootObj['active']));

  const entryCriteriaRaw = unwrapSingle(rootObj['entryCriteria']);
  const entryCriteria =
    typeof entryCriteriaRaw === 'object' && entryCriteriaRaw !== null
      ? (entryCriteriaRaw as Record<string, unknown>)
      : null;
  const entryCriteriaFormula =
    entryCriteria === null ? null : optionalString(entryCriteria, 'formula');
  const entryCriteriaItemCount =
    entryCriteria === null
      ? 0
      : toArray(entryCriteria['criteriaItems']).length;

  // The Metadata API element is `<approvalStep>` (singular, repeated once per
  // step) — NOT `<approvalSteps>`. Reading the plural key silently yielded
  // `stepCount: 0` and zero approver edges on every real org (NI-2). Prefer the
  // canonical singular; keep the plural as a defensive fallback.
  const steps = toArray(rootObj['approvalStep'] ?? rootObj['approvalSteps']);

  // v2.0a — A top-level `<entryCriteria>` block is the firing
  // condition for the process as a whole. Per
  // `ConditionalContextSemantics.md` §"ApprovalProcess conditions",
  // we extract ONLY the top-level entry (per-step entry criteria are
  // deferred to a future v2.0a+ extension). The shape mirrors
  // WorkflowRule — either a `<formula>` OR a `<criteriaItems>` block,
  // mutually exclusive in practice. When neither is present, no
  // ConditionalContext is emitted.
  const entryConditionSources: ConditionSource[] = [];
  if (entryCriteria !== null) {
    if (entryCriteriaFormula !== null && entryCriteriaFormula.length > 0) {
      entryConditionSources.push({
        kind: 'formula',
        expression: entryCriteriaFormula,
      });
    } else if (entryCriteriaItemCount > 0) {
      const items: CriteriaItem[] = [];
      for (const raw of toArray(entryCriteria['criteriaItems'])) {
        if (typeof raw !== 'object' || raw === null) continue;
        const obj = raw as Record<string, unknown>;
        const fieldRaw = unwrapSingle(obj['field']);
        if (fieldRaw === undefined || fieldRaw === null || fieldRaw === '') {
          continue;
        }
        const operationRaw = unwrapSingle(obj['operation']);
        if (
          operationRaw === undefined ||
          operationRaw === null ||
          operationRaw === ''
        ) {
          continue;
        }
        const valueRaw = unwrapSingle(obj['value']);
        items.push({
          field: String(fieldRaw),
          operation: String(operationRaw),
          value:
            valueRaw === undefined || valueRaw === null || valueRaw === ''
              ? null
              : String(valueRaw),
        });
      }
      if (items.length > 0) {
        entryConditionSources.push({
          kind: 'criteria',
          items,
          booleanFilter: optionalString(entryCriteria, 'booleanFilter'),
        });
      }
    }
  }
  const { conditionNodes, firesWhenEdges, conditionsMirror } =
    extractConditions({
      parentId: processId,
      sources: entryConditionSources,
      parentSourcePath: path,
      parentObjectApiName: objectApiName,
    });

  const node: Node = {
    id: processId,
    type: 'ApprovalProcess',
    apiName: `${objectApiName}.${processName}`,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      active,
      allowRecall: coerceBoolean(unwrapSingle(rootObj['allowRecall'])),
      finalApprovalRecordLock: coerceBoolean(
        unwrapSingle(rootObj['finalApprovalRecordLock']),
      ),
      finalRejectionRecordLock: coerceBoolean(
        unwrapSingle(rootObj['finalRejectionRecordLock']),
      ),
      description: optionalString(rootObj, 'description'),
      recordEditability: optionalString(rootObj, 'recordEditability'),
      enableMobileDeviceAccess: coerceBoolean(
        unwrapSingle(rootObj['enableMobileDeviceAccess']),
      ),
      nextAutomaticApprover: optionalString(rootObj, 'nextAutomaticApprover'),
      defaultEmailTemplate: optionalString(rootObj, 'emailTemplate'),
      entryCriteriaFormula,
      entryCriteriaItemCount,
      stepCount: steps.length,
      // Structured per-step breakdown (APPROVAL-PROCESS-OMITS-STEP-APPROVER-
      // BREAKDOWN): approver assignment, entry criteria, reject behavior, and
      // per-step actions in declared order — so the approval chain is
      // answerable from the node's own facts, not by re-deriving it from
      // unordered `references` edges. The edges are still emitted below.
      steps: steps.map((step, i) => summarizeApprovalStep(step, i)),
      // Process-level action hooks, structured (the same actions the hook edges
      // model) so "what happens on final approval / rejection?" is answerable
      // from facts — e.g. the Rejected email alert + status field update.
      initialSubmissionActions: readNamedTypedList(
        unwrapSingle(rootObj['initialSubmissionActions']),
        'action',
      ),
      finalApprovalActions: readNamedTypedList(
        unwrapSingle(rootObj['finalApprovalActions']),
        'action',
      ),
      finalRejectionActions: readNamedTypedList(
        unwrapSingle(rootObj['finalRejectionActions']),
        'action',
      ),
      recallActions: readNamedTypedList(unwrapSingle(rootObj['recallActions']), 'action'),
      allowedSubmitters: toArray(rootObj['allowedSubmitters']).flatMap(
        (rawEntry) => {
          if (typeof rawEntry !== 'object' || rawEntry === null) return [];
          const entry = rawEntry as Record<string, unknown>;
          const typeRaw = unwrapSingle(entry['type']);
          if (typeRaw === undefined || typeRaw === null || typeRaw === '') {
            return [];
          }
          const submitterType = String(typeRaw);
          const submitterNameRaw = unwrapSingle(entry['submitter']);
          const submitterName =
            submitterNameRaw === undefined ||
            submitterNameRaw === null ||
            submitterNameRaw === ''
              ? null
              : String(submitterNameRaw);
          return [{ type: submitterType, name: submitterName }];
        },
      ),
      conditions: conditionsMirror,
    },
  };

  const edges: Edge[] = [
    {
      fromId: parentId,
      toId: processId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    },
  ];

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const stepResult = stepEdges(
      steps[stepIndex],
      stepIndex,
      processId,
      objectApiName,
      path,
    );
    if (!stepResult.ok) return stepResult;
    edges.push(...stepResult.value);
  }

  const defaultEmail = optionalString(rootObj, 'emailTemplate');
  if (defaultEmail !== null) {
    edges.push({
      fromId: processId,
      toId: `EmailTemplate:${templateRefToCanonicalTail(defaultEmail)}`,
      edgeType: 'sendsEmail',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { role: 'default' },
    });
  }

  for (const hook of HOOK_LIST_NAMES) {
    const hookResult = hookListEdges(
      rootObj,
      hook.element,
      hook.hookType,
      processId,
      objectApiName,
      fieldUpdateMap,
      alertTemplateMap,
      seenEmailTemplates,
      path,
    );
    if (!hookResult.ok) return hookResult;
    edges.push(...hookResult.value);
  }

  // Allowed-submitter references — emit one `references` edge per named entry.
  // The `<type>` discriminates the target node prefix (same set as the approver
  // variant table). Entries with no `<submitter>` name (e.g. type=owner) have
  // no named target and produce no edge.
  const SUBMITTER_TYPE_TO_PREFIX: Readonly<Record<string, string>> = {
    group: 'Group',
    role: 'Role',
    queue: 'Queue',
    user: 'User',
    roleSubordinates: 'Role',
    roleAndSubordinates: 'Role',
  };
  for (const rawEntry of toArray(rootObj['allowedSubmitters'])) {
    if (typeof rawEntry !== 'object' || rawEntry === null) continue;
    const entry = rawEntry as Record<string, unknown>;
    const typeRaw = unwrapSingle(entry['type']);
    if (typeRaw === undefined || typeRaw === null || typeRaw === '') continue;
    const submitterType = String(typeRaw);
    const submitterNameRaw = unwrapSingle(entry['submitter']);
    if (
      submitterNameRaw === undefined ||
      submitterNameRaw === null ||
      submitterNameRaw === ''
    ) {
      // owner / adhoc / etc. — no named target, no edge
      continue;
    }
    const submitterName = String(submitterNameRaw);
    const prefix = SUBMITTER_TYPE_TO_PREFIX[submitterType];
    if (prefix === undefined) continue; // unknown type — skip silently
    edges.push({
      fromId: processId,
      toId: `${prefix}:${submitterName}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { referenceKind: 'allowedSubmitter', submitterType },
    });
  }

  // v2.0a — Append the firesWhen edges and the synthetic
  // ConditionalContext nodes (if any).
  edges.push(...firesWhenEdges);

  return ok({ nodes: [node, ...conditionNodes], edges });
};
