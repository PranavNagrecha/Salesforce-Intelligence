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

const WORKFLOW_FILE_SUFFIX = '.workflow-meta.xml';
const ROOT_ELEMENT = 'Workflow';
const EXTRACTOR_SOURCE = 'workflow-rule-extractor';

const ALLOWED_TRIGGER_TYPES = [
  'onCreateOnly',
  'onCreateOrTriggeringUpdate',
  'onAllChanges',
  'onCreateOrAllChanges',
] as const;
type TriggerType = (typeof ALLOWED_TRIGGER_TYPES)[number];

/**
 * Variant table for `<rules><actions>` per `WorkflowRule.md`. Each
 * `<actions>` entry pairs a `<name>` with a `<type>` discriminator; the
 * type selects a target-id prefix and an edge type. `Send` is the
 * deprecated legacy variant — the doc explicitly tells the extractor to
 * skip it.
 */
interface ActionVariantSpec {
  /** Target id prefix (e.g., `WorkflowAlert`, `ApexClass`). */
  readonly idPrefix: string;
  /** Whether the target id is scoped by the parent object name. */
  readonly scopedByObject: boolean;
  /** Edge type emitted for this action variant. */
  readonly edgeType: 'references' | 'callsApex';
}

const ACTION_VARIANT_TABLE: Readonly<Record<string, ActionVariantSpec>> = {
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

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Coerce an XML scalar to a boolean. Salesforce-style booleans serialise
 * as the lowercase string `'true'` or `'false'`.
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
 * Locate and validate the `<Workflow>` root. Per `WorkflowRule.md`, a
 * file with a `<Workflow>` root but zero `<rules>` children is a
 * documented happy path — the extractor yields zero nodes and zero
 * edges. A missing `<Workflow>` key is the only malformed case here.
 */
const validateRoot = (
  parsed: Record<string, unknown>,
  path: string,
): Result<Record<string, unknown>, ExtractorError> => {
  if (!(ROOT_ELEMENT in parsed)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root === 'object' && root !== null) {
    return ok(root as Record<string, unknown>);
  }
  // `<Workflow/>` / `<Workflow></Workflow>` — empty but valid.
  if (root === '' || root === null || root === undefined) {
    return ok({});
  }
  return err({
    kind: 'malformed-input',
    path,
    message: `expected <${ROOT_ELEMENT}> root`,
  });
};

/**
 * Build a name -> template lookup from the file's `<alerts>` collection.
 * Each entry maps a `WorkflowAlert` `<fullName>` to its `<template>`
 * value (used by `sendsEmail` resolution for `Alert` actions).
 *
 * Alerts without a `<fullName>` are silently skipped — they're not
 * addressable by name, so they cannot be referenced by a rule. Alerts
 * without a `<template>` are included with `null` so the caller can
 * distinguish "alert exists but has no template" from "alert not found".
 *
 * Exported so `approval-process.ts` (W4.3) can reuse the SAME builder when it
 * resolves an ApprovalProcess `Alert` hook action's EmailTemplate against the
 * sibling `workflows/{Object}.workflow-meta.xml` file's `<alerts>` collection
 * (mirroring the {@link buildFieldUpdateTargetMap} cross-file reuse). Single
 * source of truth — do NOT copy-paste into the approval extractor.
 */
export const buildAlertTemplateMap = (
  rootObj: Record<string, unknown>,
): Readonly<Map<string, string | null>> => {
  const result = new Map<string, string | null>();
  for (const raw of toArray(rootObj['alerts'])) {
    if (typeof raw !== 'object' || raw === null) continue;
    const alert = raw as Record<string, unknown>;
    const fullNameRaw = unwrapSingle(alert['fullName']);
    if (fullNameRaw === undefined || fullNameRaw === null || fullNameRaw === '') {
      continue;
    }
    const templateRaw = unwrapSingle(alert['template']);
    const template =
      templateRaw === undefined || templateRaw === null || templateRaw === ''
        ? null
        : String(templateRaw);
    result.set(String(fullNameRaw), template);
  }
  return result;
};

/**
 * A `<fieldUpdates>` entry's resolved target: the field it sets + the op.
 *
 * Exported so `approval-process.ts` (CR-CAP-07) can reuse the SAME shape
 * + builder + well-formedness guard when it resolves an ApprovalProcess
 * FieldUpdate hook action against the sibling `workflows/{Object}.workflow-meta.xml`
 * file's `<fieldUpdates>` collection. Single source of truth — do NOT
 * copy-paste into the approval extractor (drift risk per CR-CAP-07).
 */
export interface FieldUpdateTarget {
  /** The `<field>` API name the update sets (verbatim, or null if absent). */
  readonly field: string | null;
  /** The `<operation>` (Formula|Literal|Null|NextValue|PreviousValue). */
  readonly operation: string | null;
  /**
   * CR-P3-5: the `<targetObject>` element. Salesforce emits it ONLY for a
   * CROSS-OBJECT field update (e.g. updating a field on a parent/related
   * record); it holds the RELATIONSHIP reference, not the related object's API
   * name. Same-object updates omit it (null). Its mere PRESENCE marks the
   * update as cross-object, which is all we need: the relationship→object map
   * is not resolvable offline, so a cross-object update emits NO `writesTo`
   * (minting `CustomField:{relationship}.{field}` would be a relationship-scoped
   * phantom — a false writer claim). Mirrors `formula-references.ts`, which
   * skips every cross-object dotted path for the same reason.
   */
  readonly targetObject: string | null;
}

/**
 * Build a name -> target lookup from the file's `<fieldUpdates>`
 * collection. Each entry maps a field-update `<fullName>` (the name a
 * rule's `<actions><name>` references) to the `<field>` that update SETS
 * and its `<operation>`. This is the same join `buildAlertTemplateMap`
 * does for alert templates: the `<actions>` child of a rule carries only
 * the field-update's NAME, never the target field — the target field lives
 * here, in the sibling top-level `<fieldUpdates>` collection.
 *
 * Entries without a `<fullName>` are silently skipped — they're not
 * addressable by name, so no rule can reference them. Entries without a
 * `<field>` are included with `field: null` so the caller can distinguish
 * "field-update exists but names no target" (emit no `writesTo`) from
 * "field-update not found". CR-P3-5: `<targetObject>` is captured so the
 * caller can detect (and skip the `writesTo` for) cross-object updates whose
 * relationship→object mapping is not resolvable offline.
 */
export const buildFieldUpdateTargetMap = (
  rootObj: Record<string, unknown>,
): Readonly<Map<string, FieldUpdateTarget>> => {
  const result = new Map<string, FieldUpdateTarget>();
  for (const raw of toArray(rootObj['fieldUpdates'])) {
    if (typeof raw !== 'object' || raw === null) continue;
    const fu = raw as Record<string, unknown>;
    const fullNameRaw = unwrapSingle(fu['fullName']);
    if (fullNameRaw === undefined || fullNameRaw === null || fullNameRaw === '') {
      continue;
    }
    result.set(String(fullNameRaw), {
      field: optionalString(fu, 'field'),
      operation: optionalString(fu, 'operation'),
      targetObject: optionalString(fu, 'targetObject'),
    });
  }
  return result;
};

/**
 * v2.9 — promote each `<alerts>` child to a real `WorkflowAlert` Node.
 * Pre-v2.9 `buildAlertTemplateMap` read `<alerts>` only to build the
 * name→template lookup for `sendsEmail` edge resolution; it emitted no
 * nodes, so alert-level properties (`senderType`, `description`,
 * `template`, `ccEmails`) were invisible to graph queries.
 *
 * One Node per `<alerts>` entry. Entries lacking a `<fullName>` are
 * silently skipped (they're not addressable by name). Each Node carries:
 *
 *   - `name`: the entry's `<fullName>` verbatim.
 *   - `description`: the `<description>` (string or null).
 *   - `senderType`: the `<senderType>` (string or null; typically
 *     `CurrentUser`, `OrgWideEmailAddress`, or `DefaultWorkflowUser`).
 *   - `template`: the `<template>` (string or null; slash-separated
 *     EmailTemplate path, verbatim from XML).
 *   - `ccEmails`: the `<ccEmails>` collection as a string array (may
 *     be empty when no `<ccEmails>` child is present).
 *
 * The parent edge is the existing `parentOf` from
 * `CustomObject:{ObjectApiName}` mirroring the OutboundMessage v2.8
 * pattern; no new EdgeType is introduced.
 *
 * Emission happens regardless of whether the file has any `<rules>` —
 * a workflow file with only `<alerts>` is a documented orphan-collection
 * happy path (alert definitions that outlive their consuming rules).
 */
const buildWorkflowAlertNodes = (
  rootObj: Record<string, unknown>,
  objectApiName: string,
  parentId: string,
  path: string,
): { readonly nodes: readonly Node[]; readonly edges: readonly Edge[] } => {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const raw of toArray(rootObj['alerts'])) {
    if (typeof raw !== 'object' || raw === null) continue;
    const alert = raw as Record<string, unknown>;
    const fullNameRaw = unwrapSingle(alert['fullName']);
    if (
      fullNameRaw === undefined ||
      fullNameRaw === null ||
      fullNameRaw === ''
    ) {
      continue;
    }
    const name = String(fullNameRaw);
    const alertId = `WorkflowAlert:${objectApiName}.${name}`;
    const template = optionalString(alert, 'template');
    const ccEmailsRaw = toArray(alert['ccEmails']);
    const ccEmails = ccEmailsRaw
      .map((entry) =>
        entry === undefined || entry === null || entry === ''
          ? null
          : String(entry),
      )
      .filter((entry): entry is string => entry !== null);
    nodes.push({
      id: alertId,
      type: 'WorkflowAlert',
      apiName: `${objectApiName}.${name}`,
      label: name,
      parentId,
      sourcePath: path,
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        name,
        description: optionalString(alert, 'description'),
        senderType: optionalString(alert, 'senderType'),
        template,
        ccEmails,
      },
    });
    edges.push({
      fromId: parentId,
      toId: alertId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    });
    // W4.3 — the alert's `<template>` names the EmailTemplate this alert
    // sends. Pre-W4.3 the template lived ONLY on `properties.template` as a
    // string, so `get_edges` on the alert reached no EmailTemplate and
    // "safe to delete EmailTemplate X" invented no WorkflowAlert dependent
    // (the object-scoped alert node is the direct dependent even when NO
    // WorkflowRule references the alert — the rule-level `sendsEmail` edge
    // only fires for rule-referenced alerts). Emit a DECLARED `references`
    // edge alert -> `EmailTemplate:{Folder.Name}` so the alert node is a
    // counted usage of the template. `referenceKind: 'alertTemplate'`
    // discriminates it from other `references` edges.
    if (template !== null) {
      edges.push({
        fromId: alertId,
        toId: `EmailTemplate:${templateRefToCanonicalTail(template)}`,
        edgeType: 'references',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: { referenceKind: 'alertTemplate' },
      });
    }
  }
  return { nodes, edges };
};

/**
 * v2.8 — promote each `<outboundMessages>` child to a real
 * `OutboundMessage` Node. Pre-v2.8 these references dangled by design
 * (per `WorkflowRule.md` § "outboundMessages"); v2.8 promotes them so
 * the integration catalog tools (`sfi.outbound_message_catalog`,
 * `sfi.endpoint_catalog`) can enumerate outbound destinations
 * alongside RemoteSiteSetting and NamedCredential.
 *
 * One Node per `<outboundMessages>` entry. Entries lacking a
 * `<fullName>` are silently skipped — they're not addressable by name,
 * so a consuming rule cannot reference them. Each Node carries:
 *
 *   - `name`: the entry's `<fullName>` verbatim.
 *   - `endpointUrl`: the `<endpointUrl>` (string or null).
 *   - `includeSessionId`: the `<includeSessionId>` boolean (default false).
 *   - `useDeadLetterQueue`: the `<useDeadLetterQueue>` boolean (default false).
 *   - `integrationUser`: the `<integrationUser>` (string or null).
 *   - `fields`: the per-entry `<fields>` collection as a string array.
 *
 * The parent edge is the existing `parentOf` from
 * `CustomObject:{ObjectApiName}` mirroring the v1.0 CustomField pattern;
 * no new EdgeType is introduced. Edges are emitted by the caller to keep
 * this helper a pure node-emitter (parallel to `buildAlertTemplateMap`).
 */
const buildOutboundMessageNodes = (
  rootObj: Record<string, unknown>,
  objectApiName: string,
  parentId: string,
  path: string,
): { readonly nodes: readonly Node[]; readonly edges: readonly Edge[] } => {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const raw of toArray(rootObj['outboundMessages'])) {
    if (typeof raw !== 'object' || raw === null) continue;
    const om = raw as Record<string, unknown>;
    const fullNameRaw = unwrapSingle(om['fullName']);
    if (
      fullNameRaw === undefined ||
      fullNameRaw === null ||
      fullNameRaw === ''
    ) {
      continue;
    }
    const name = String(fullNameRaw);
    const omId = `OutboundMessage:${objectApiName}.${name}`;
    const fieldsRaw = toArray(om['fields']);
    const fields = fieldsRaw
      .map((entry) =>
        entry === undefined || entry === null || entry === ''
          ? null
          : String(entry),
      )
      .filter((entry): entry is string => entry !== null);
    nodes.push({
      id: omId,
      type: 'OutboundMessage',
      apiName: `${objectApiName}.${name}`,
      label: name,
      parentId,
      sourcePath: path,
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        name,
        endpointUrl: optionalString(om, 'endpointUrl'),
        includeSessionId: coerceBoolean(unwrapSingle(om['includeSessionId'])),
        useDeadLetterQueue: coerceBoolean(
          unwrapSingle(om['useDeadLetterQueue']),
        ),
        integrationUser: optionalString(om, 'integrationUser'),
        fields,
      },
    });
    edges.push({
      fromId: parentId,
      toId: omId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    });
  }
  return { nodes, edges };
};

/**
 * Convert a slash-separated EmailTemplate reference (e.g.,
 * `Sales/WelcomeEmail`) to its canonical id form (`Sales.WelcomeEmail`).
 * Salesforce stores template paths with `/` between folder and name; the
 * canonical id uses `.` as the scope separator. Templates that don't
 * carry a folder (deprecated unfiled-public templates) retain their
 * single-segment name.
 */
const templateRefToCanonicalTail = (templateRef: string): string =>
  templateRef.includes('/') ? templateRef.replace(/\//g, '.') : templateRef;

/** Required per-rule scalars surfaced by `validateRuleRequired`. */
interface RequiredRuleFields {
  readonly fullName: string;
  readonly active: boolean;
  readonly triggerType: TriggerType;
}

/**
 * Validate the required-once scalars on a `<rules>` child per
 * `WorkflowRule.md`. Field order matches the error-cases table.
 */
const validateRuleRequired = (
  rule: Record<string, unknown>,
  path: string,
): Result<RequiredRuleFields, ExtractorError> => {
  const fullNameRaw = unwrapSingle(rule['fullName']);
  if (
    fullNameRaw === undefined ||
    fullNameRaw === null ||
    fullNameRaw === ''
  ) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <fullName>',
    });
  }
  const activeRaw = unwrapSingle(rule['active']);
  if (activeRaw === undefined || activeRaw === null || activeRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <active>',
    });
  }
  const triggerTypeRaw = unwrapSingle(rule['triggerType']);
  if (
    triggerTypeRaw === undefined ||
    triggerTypeRaw === null ||
    triggerTypeRaw === ''
  ) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <triggerType>',
    });
  }
  const triggerTypeValue = String(triggerTypeRaw);
  if (!ALLOWED_TRIGGER_TYPES.includes(triggerTypeValue as TriggerType)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid triggerType: ${triggerTypeValue}`,
    });
  }
  return ok({
    fullName: String(fullNameRaw),
    active: coerceBoolean(activeRaw),
    triggerType: triggerTypeValue as TriggerType,
  });
};

/** A resolved `<actions>` entry: name + type pair. */
interface ResolvedAction {
  readonly name: string;
  readonly type: string;
}

/**
 * Resolve a single `<actions>` child of a rule. Both `<name>` and
 * `<type>` are required (per the error-cases table); `<type>` values
 * outside the variant table are returned verbatim and filtered later
 * (the `Send` deprecated variant is one such case).
 */
const resolveAction = (
  actionRaw: unknown,
  path: string,
): Result<ResolvedAction, ExtractorError> => {
  if (typeof actionRaw !== 'object' || actionRaw === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <name>',
    });
  }
  const action = actionRaw as Record<string, unknown>;
  const nameRaw = unwrapSingle(action['name']);
  if (nameRaw === undefined || nameRaw === null || nameRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <name>',
    });
  }
  const typeRaw = unwrapSingle(action['type']);
  if (typeRaw === undefined || typeRaw === null || typeRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <type>',
    });
  }
  return ok({ name: String(nameRaw), type: String(typeRaw) });
};

/**
 * CR-RV13: malformed-leaf guard for a FieldUpdate's target `<field>`.
 * Returns `false` for a `<field>` value that real Salesforce metadata never
 * emits as a same-object FieldUpdate target but a hand-edited/corrupt file can,
 * each of which would mint a phantom `CustomField:…` writer claim:
 *
 *   - a `$`-prefixed global-variable ref ($User.x, $Setup.x, …) → not a field
 *     on this object (would mint `CustomField:$User.x`);
 *   - a dotted ref with an empty object-part or leaf-part (".", "Foo.", ".Foo")
 *     → degenerate id (`CustomField:.`, `CustomField:Foo.`, `CustomField:.Foo`).
 *
 * A bare same-object name (no dot) and a clean `Object.Field` dotted ref both
 * pass. (Truly empty `<field>` is already filtered upstream by `optionalString`
 * → `null`; the cross-object `<targetObject>` case is handled separately per
 * CR-P3-5.)
 */
export const isWellFormedFieldRef = (field: string): boolean => {
  if (field.startsWith('$')) return false;
  if (!field.includes('.')) return true;
  // Dotted: every segment must be non-empty.
  return field.split('.').every((segment) => segment.length > 0);
};

/**
 * Emit edges for a single resolved action, applying the variant table
 * and the dedup key set. Returns the edges to append. Skips deprecated
 * `Send` and any other unknown variant per the doc.
 */
const edgesForAction = (
  action: ResolvedAction,
  ruleId: string,
  objectApiName: string,
  alertTemplateMap: Readonly<Map<string, string | null>>,
  fieldUpdateMap: Readonly<Map<string, FieldUpdateTarget>>,
  seen: Set<string>,
): readonly Edge[] => {
  // `Send` is the deprecated variant: silently ignored.
  if (action.type === 'Send') return [];
  const spec = ACTION_VARIANT_TABLE[action.type];
  // Unknown variant: silently skipped (the doc says only explicitly
  // listed variants produce edges; unrecognised names are scaffolding).
  if (spec === undefined) return [];

  const targetTail = spec.scopedByObject
    ? `${objectApiName}.${action.name}`
    : action.name;
  const targetId = `${spec.idPrefix}:${targetTail}`;
  const dedupKey = `${spec.edgeType}|${targetId}`;

  const out: Edge[] = [];
  if (!seen.has(dedupKey)) {
    seen.add(dedupKey);
    if (spec.edgeType === 'callsApex') {
      out.push({
        fromId: ruleId,
        toId: targetId,
        edgeType: 'callsApex',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: {},
      });
    } else {
      out.push({
        fromId: ruleId,
        toId: targetId,
        edgeType: 'references',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: { actionType: action.type },
      });
    }
  }

  // FieldUpdate actions additionally emit a FIELD-level `writesTo` edge
  // to the CustomField the update SETS — mirroring `flow.ts`'s
  // `buildInputAssignmentEdges`. This is KEEP-the-`references`-ADD-the-
  // `writesTo`: the `references` above points at the
  // `WorkflowFieldUpdate:{Object}.{name}` scaffolding node (which several
  // consumers and the change-impact metadata-blocker branch rely on); the
  // new `writesTo` points at the actual `CustomField:{Object}.{field}` so
  // that field-change-impact tools see the WorkflowRule as a writer. The
  // target field is NOT on the `<actions>` child (it carries only
  // `<name>` == the field-update's `<fullName>`) — it lives in the sibling
  // `<fieldUpdates>` collection, resolved via `fieldUpdateMap`.
  //
  // CR-P3-5: a CROSS-OBJECT field update (Salesforce emits a `<targetObject>`)
  // sets a field on a RELATED record. `<targetObject>` is the relationship
  // reference, not the related object's API name, and the relationship→object
  // map is not resolvable offline — so we SKIP the `writesTo` entirely (emit no
  // edge) rather than mint a relationship-scoped `CustomField:{rel}.{field}`
  // phantom (a false writer claim). This mirrors `formula-references.ts`, which
  // skips every cross-object dotted path for the same reason. The `references`
  // edge to the scaffolding node above STILL emits, so the action is not
  // silently dropped (admin-legacy-automation's dangling-edge honesty
  // contract). A SAME-OBJECT update (no `<targetObject>`): a bare field name is
  // object-scoped; a dotted name is taken verbatim (mirrors condition-
  // extractor's field resolution). Confidence is `parsed` (the field name is
  // read straight out of the XML), matching `flow.ts`.
  if (action.type === 'FieldUpdate') {
    const target = fieldUpdateMap.get(action.name);
    if (
      target !== undefined &&
      target.field !== null &&
      target.targetObject === null &&
      isWellFormedFieldRef(target.field)
    ) {
      const fieldTargetId = target.field.includes('.')
        ? `CustomField:${target.field}`
        : `CustomField:${objectApiName}.${target.field}`;
      const writesToDedupKey = `writesTo|${fieldTargetId}`;
      if (!seen.has(writesToDedupKey)) {
        seen.add(writesToDedupKey);
        out.push({
          fromId: ruleId,
          toId: fieldTargetId,
          edgeType: 'writesTo',
          confidence: 'parsed',
          source: EXTRACTOR_SOURCE,
          properties: { operation: target.operation },
        });
      }
    }
  }

  // Alert actions additionally emit `sendsEmail` to the EmailTemplate
  // named by the alert's `<template>`, when the alert is present in
  // this file's `<alerts>` collection AND the alert has a non-null
  // template. Missing or template-less alerts produce no `sendsEmail`.
  if (action.type === 'Alert') {
    const template = alertTemplateMap.get(action.name);
    if (template !== undefined && template !== null) {
      const tail = templateRefToCanonicalTail(template);
      const emailId = `EmailTemplate:${tail}`;
      const emailDedupKey = `sendsEmail|${emailId}`;
      if (!seen.has(emailDedupKey)) {
        seen.add(emailDedupKey);
        out.push({
          fromId: ruleId,
          toId: emailId,
          edgeType: 'sendsEmail',
          confidence: 'declared',
          source: EXTRACTOR_SOURCE,
          properties: { viaAlert: action.name },
        });
      }
    }
  }
  return out;
};

/**
 * Parse a single `<criteriaItems>` element into the helper's
 * `CriteriaItem` shape. Required `<field>` / `<operation>` per the
 * vendored WorkflowRule.md; the `<value>` may be empty (modelled as
 * `null` in the helper) for unary tests.
 */
const parseCriteriaItem = (raw: unknown): CriteriaItem | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const fieldRaw = unwrapSingle(obj['field']);
  if (fieldRaw === undefined || fieldRaw === null || fieldRaw === '') {
    return null;
  }
  const operationRaw = unwrapSingle(obj['operation']);
  if (operationRaw === undefined || operationRaw === null || operationRaw === '') {
    return null;
  }
  const valueRaw = unwrapSingle(obj['value']);
  const value =
    valueRaw === undefined || valueRaw === null || valueRaw === ''
      ? null
      : String(valueRaw);
  return {
    field: String(fieldRaw),
    operation: String(operationRaw),
    value,
  };
};

/**
 * CR-CAP-11 — declarative shape of a single `<workflowTimeTriggers>`
 * child of a `<rules>` element. This is the verbatim DECLARATIVE XML
 * (confidence tier `declared`), NOT an assertion that the trigger fires:
 * `offsetFromField` is measured from a record's field value the offline
 * vault cannot evaluate, and the scheduled-action queue is record-level.
 */
interface TimeTrigger {
  /** `<timeLength>` integer offset (null when absent/unparseable). */
  readonly timeLength: number | null;
  /** `<workflowTimeTriggerUnit>` enum (Hours|Days), verbatim or null. */
  readonly timeUnit: string | null;
  /** `<offsetFromField>` API name; null = offset from the rule trigger date. */
  readonly offsetFromField: string | null;
  /** Count of nested `<actions>` queued by this time trigger. */
  readonly actionCount: number;
}

/**
 * CR-CAP-11 — parse the per-rule `<workflowTimeTriggers>` collection.
 *
 * `<workflowTimeTriggers>` is a REPEATABLE child of each `<rules>`
 * element (NOT a top-level Workflow collection like `<fieldUpdates>`),
 * so it MUST be read off the `rule` record, never off the root. Each
 * trigger carries `<timeLength>`, `<workflowTimeTriggerUnit>`, an
 * optional `<offsetFromField>`, and a nested repeatable `<actions>`
 * block whose count we surface (the action chain itself stays
 * record-level and is deliberately not modeled — see the extractor doc).
 */
const parseTimeTriggers = (
  rule: Record<string, unknown>,
): readonly TimeTrigger[] => {
  const out: TimeTrigger[] = [];
  for (const raw of toArray(rule['workflowTimeTriggers'])) {
    if (typeof raw !== 'object' || raw === null) continue;
    const tt = raw as Record<string, unknown>;
    const lengthStr = optionalString(tt, 'timeLength');
    const lengthNum = lengthStr === null ? null : Number(lengthStr);
    out.push({
      timeLength:
        lengthNum !== null && Number.isFinite(lengthNum) ? lengthNum : null,
      timeUnit: optionalString(tt, 'workflowTimeTriggerUnit'),
      offsetFromField: optionalString(tt, 'offsetFromField'),
      actionCount: toArray(tt['actions']).length,
    });
  }
  return out;
};

/**
 * Build the per-rule list of `ConditionSource` entries per the v2.0a
 * spec. A WorkflowRule emits at most ONE condition surface (either
 * the `<formula>` or the `<criteriaItems>` array). When the rule has
 * NEITHER a formula NOR criteria items, the returned list is empty
 * and the v2.0a layer produces no ConditionalContext (the lifecycle
 * narrator treats an empty `properties.conditions[]` as "always
 * fires").
 */
const collectWorkflowRuleConditionSources = (
  rule: Record<string, unknown>,
): readonly ConditionSource[] => {
  const formula = optionalString(rule, 'formula');
  if (formula !== null && formula.length > 0) {
    return [{ kind: 'formula', expression: formula }];
  }
  const items: CriteriaItem[] = [];
  for (const raw of toArray(rule['criteriaItems'])) {
    const parsed = parseCriteriaItem(raw);
    if (parsed !== null) items.push(parsed);
  }
  if (items.length === 0) return [];
  const booleanFilter = optionalString(rule, 'booleanFilter');
  return [{ kind: 'criteria', items, booleanFilter }];
};

/**
 * The shape `buildRule` returns on success: the rule's primary node,
 * its outgoing/incoming edges (including the v2.0a `firesWhen` edges
 * appended at the tail), and the new ConditionalContext nodes the
 * v2.0a extension emits alongside the rule. The caller (the top-level
 * extractor) concatenates `conditionNodes` into the result's `nodes`
 * array.
 */
interface BuiltRule {
  readonly node: Node;
  readonly edges: readonly Edge[];
  readonly conditionNodes: readonly Node[];
}

/**
 * Build a single `<rules>` child into its node + edges (plus any v2.0a
 * ConditionalContext nodes synthesised from its condition surface).
 */
const buildRule = (
  rule: Record<string, unknown>,
  objectApiName: string,
  parentId: string,
  alertTemplateMap: Readonly<Map<string, string | null>>,
  fieldUpdateMap: Readonly<Map<string, FieldUpdateTarget>>,
  path: string,
): Result<BuiltRule, ExtractorError> => {
  const required = validateRuleRequired(rule, path);
  if (!required.ok) return required;
  const { fullName, active, triggerType } = required.value;

  const ruleId = `WorkflowRule:${objectApiName}.${fullName}`;
  const actions: ResolvedAction[] = [];
  for (const actionRaw of toArray(rule['actions'])) {
    const resolved = resolveAction(actionRaw, path);
    if (!resolved.ok) return resolved;
    actions.push(resolved.value);
  }

  // v2.0a — Conditional Context extraction. Build the per-rule
  // condition surface (one formula OR one criteria block; see
  // `ConditionalContextSemantics.md` §"WorkflowRule conditions") and
  // synthesise the ConditionalContext nodes + firesWhen edges. The
  // `conditionsMirror` is mirrored onto the rule's
  // `properties.conditions[]` per the documented property mirror.
  const conditionSources = collectWorkflowRuleConditionSources(rule);
  const { conditionNodes, firesWhenEdges, conditionsMirror, conditionFieldEdges } =
    extractConditions({
      parentId: ruleId,
      sources: conditionSources,
      parentSourcePath: path,
      parentObjectApiName: objectApiName,
    });

  // CR-CAP-11 — declarative time-trigger shape. Surfaced as node
  // properties only; never as a firing claim (record-level condition).
  const timeTriggers = parseTimeTriggers(rule);

  const node: Node = {
    id: ruleId,
    type: 'WorkflowRule',
    apiName: `${objectApiName}.${fullName}`,
    label: fullName,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      active,
      triggerType,
      description: optionalString(rule, 'description'),
      formula: optionalString(rule, 'formula'),
      booleanFilter: optionalString(rule, 'booleanFilter'),
      criteriaItemCount: toArray(rule['criteriaItems']).length,
      actionCount: actions.length,
      // CR-CAP-11b — per-rule action-type breakdown. Counts this rule's
      // IMMEDIATE `<actions>` by `<type>` (the SAME array the per-action
      // edges are derived from), NOT the top-level `<fieldUpdates>` /
      // `<outboundMessages>` / `<tasks>` DEFINITION collections (which are
      // a different, larger surface) and NOT the time-trigger nested
      // actions. Confidence tier `declared` (verbatim from `<type>`). These
      // make process_builder_migration_candidates' propertyNumber reads
      // (fieldUpdateCount / outboundMessageCount / taskCreationCount) TRUE
      // instead of silently 0, so its `totalActions` sum is coherent with
      // the sendsEmail / callsApex EDGE counts (also per-rule-derived).
      fieldUpdateCount: actions.filter((a) => a.type === 'FieldUpdate').length,
      outboundMessageCount: actions.filter((a) => a.type === 'OutboundMessage')
        .length,
      taskCreationCount: actions.filter((a) => a.type === 'Task').length,
      conditions: conditionsMirror,
      // CR-CAP-11 — makes the pre-existing skill claim
      // (admin-legacy-automation/SKILL.md "surfaces the trigger count
      // via properties.timeTriggerCount") and the consumer read
      // (process-builder-migration-candidates.ts) TRUE; both silently
      // defaulted to 0 before this property was emitted.
      timeTriggerCount: timeTriggers.length,
      timeTriggers,
    },
  };

  const edges: Edge[] = [
    {
      fromId: parentId,
      toId: ruleId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    },
    {
      fromId: ruleId,
      toId: parentId,
      edgeType: 'triggersOn',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { triggerType },
    },
  ];
  const seen = new Set<string>();
  for (const action of actions) {
    edges.push(
      ...edgesForAction(
        action,
        ruleId,
        objectApiName,
        alertTemplateMap,
        fieldUpdateMap,
        seen,
      ),
    );
  }
  edges.push(...firesWhenEdges, ...conditionFieldEdges);
  return ok({ node, edges, conditionNodes });
};

/**
 * Extract `WorkflowRule` Nodes and Edges from a single Salesforce
 * `*.workflow-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<Workflow>` root per
 * the vendored `WorkflowRule.md` spec, and returns an `ExtractionResult`
 * containing one `'WorkflowRule'` Node per `<rules>` child. The
 * `<Workflow>` container itself produces no node — only the rules do.
 *
 * For each rule the extractor emits `parentOf` from
 * `CustomObject:{ObjectApiName}` to the rule, `triggersOn` from the rule
 * back to the object, plus per-action edges per the variant table.
 * `Alert` actions emit two edges: a `references` to
 * `WorkflowAlert:{ObjectApiName}.{name}` AND a `sendsEmail` to
 * `EmailTemplate:{Folder}.{Name}` when the named alert's `<template>`
 * resolves inside this file. `FieldUpdate` actions likewise emit two
 * edges: the `references` to `WorkflowFieldUpdate:{ObjectApiName}.{name}`
 * scaffolding node AND a FIELD-level `writesTo` to the
 * `CustomField:{ObjectApiName}.{field}` the update SETS (the target field
 * is read from this file's sibling `<fieldUpdates>` collection via
 * {@link buildFieldUpdateTargetMap}, mirroring `flow.ts`'s
 * `<inputAssignments>` writesTo edges). `Apex` actions emit `callsApex`
 * (no `references`); `FlowAction` emits `references` to `Flow:{name}` (no
 * object scope, per the variant table); the deprecated `Send` variant
 * and any unknown action type are silently ignored. Duplicate
 * `(rule, target, edgeType)` triples within a single rule are
 * deduplicated.
 *
 * CR-CAP-11: each rule's per-rule `<workflowTimeTriggers>` collection
 * (a REPEATABLE child of `<rules>`, NOT a top-level Workflow collection)
 * is parsed into two declarative node properties: `timeTriggerCount`
 * (the number of time triggers) and `timeTriggers[]` ({timeLength,
 * timeUnit, offsetFromField, actionCount}). These are confidence tier
 * `declared` — the verbatim declarative XML. The extractor does NOT
 * model whether or when a trigger fires: the firing condition and the
 * scheduled-action queue are record-level (the `offsetFromField` offset
 * is measured from a record's field value the offline vault cannot read),
 * and the nested action chain is surfaced only as a count.
 *
 * CR-CAP-11b: each rule also carries three per-rule action-type counts —
 * `fieldUpdateCount`, `outboundMessageCount`, `taskCreationCount` —
 * computed by filtering the rule's resolved IMMEDIATE `<actions>` array by
 * `<type>` (`FieldUpdate` / `OutboundMessage` / `Task`). These count the
 * per-rule `<actions>`, NOT the top-level `<fieldUpdates>` /
 * `<outboundMessages>` / `<tasks>` definition collections (a different,
 * larger surface) and NOT the time-trigger nested actions; the deprecated
 * `Send` and any unknown `<type>` are ignored. Confidence tier `declared`.
 * They mirror the CR-CAP-11 `timeTriggerCount` precedent: the consumer
 * (`process_builder_migration_candidates`) already reads them via
 * `propertyNumber` and silently defaulted them to 0 before this emit.
 *
 * `<alerts>`, `<fieldUpdates>`, `<tasks>`, and `<outboundMessages>`
 * collections under the root are not promoted to NODES — they appear
 * only as dangling-by-design `references` targets named by consuming
 * rules. The `<fieldUpdates>` collection is additionally CONSULTED (not
 * promoted) to resolve each FieldUpdate action's target field for the
 * field-level `writesTo` edge described above. A file with `<Workflow>`
 * root but zero `<rules>` children is the documented happy path for
 * objects whose action scaffolding outlives its consuming rules; it
 * yields zero nodes and zero edges.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<fullName>` / `<active>` / `<triggerType>` on a rule,
 * invalid `<triggerType>` value, or `<actions>` missing `<name>` /
 * `<type>`).
 *
 * @example
 *   const result = await extractWorkflowRule(
 *     'tests/fixtures/synthetic-v1.3/workflows/Account.workflow-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'WorkflowRule:Account.Notify_Sales_On_New_Tier1'
 *   }
 */
export const extractWorkflowRule = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is too
  // tight for production-scale Workflow XML.
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

  const objectApiName = deriveComponentApiName(path, WORKFLOW_FILE_SUFFIX);
  const parentId = `CustomObject:${objectApiName}`;
  const alertTemplateMap = buildAlertTemplateMap(rootObj);
  const fieldUpdateMap = buildFieldUpdateTargetMap(rootObj);

  const rules = toArray(rootObj['rules']).filter(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
  );

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const rule of rules) {
    const built = buildRule(
      rule,
      objectApiName,
      parentId,
      alertTemplateMap,
      fieldUpdateMap,
      path,
    );
    if (!built.ok) return built;
    nodes.push(built.value.node);
    // v2.0a — emit the per-rule ConditionalContext nodes alongside
    // the rule node so they're discoverable by `sfi.list_components`
    // / `sfi.get_edges`.
    nodes.push(...built.value.conditionNodes);
    edges.push(...built.value.edges);
  }
  // v2.9 — promote `<alerts>` entries to WorkflowAlert nodes. These
  // were dangling-by-design references (the alert name appeared only
  // in the name→template map used for `sendsEmail` resolution); v2.9
  // captures them so alert-level properties (`senderType`,
  // `description`, `template`, `ccEmails`) are queryable via graph
  // queries (`sfi.get_component`, `sfi.find_component_usages`).
  // W4.3 additionally emits a DECLARED `references` edge from each alert
  // node to the `EmailTemplate:{Folder.Name}` its `<template>` names, so
  // the alert is a counted usage of the template and "safe to delete
  // EmailTemplate X?" sees the WorkflowAlert dependent.
  // Emission happens regardless of whether the file has any `<rules>` —
  // a workflow file with only `<alerts>` is a documented orphan-
  // collection happy path.
  const wa = buildWorkflowAlertNodes(rootObj, objectApiName, parentId, path);
  nodes.push(...wa.nodes);
  edges.push(...wa.edges);
  // v2.8 — promote `<outboundMessages>` entries to OutboundMessage
  // nodes. These were dangling-by-design references in v1.3; v2.8
  // captures them so the integration-catalog tools can enumerate
  // outbound destinations alongside RemoteSiteSetting and
  // NamedCredential. Emission happens regardless of whether the
  // file has any `<rules>` — a workflow file with only
  // `<outboundMessages>` is a documented orphan-collection happy path.
  const om = buildOutboundMessageNodes(rootObj, objectApiName, parentId, path);
  nodes.push(...om.nodes);
  edges.push(...om.edges);
  return ok({ nodes, edges });
};
