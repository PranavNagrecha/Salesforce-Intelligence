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

const ASSIGNMENT_RULES_FILE_SUFFIX = '.assignmentRules-meta.xml';
const ROOT_ELEMENT = 'AssignmentRules';
const RULE_ELEMENT = 'assignmentRule';
const EXTRACTOR_SOURCE = 'assignment-rule-extractor';
const ALLOWED_ASSIGNED_TO_TYPES = ['Queue', 'User', 'Role'] as const;

type AssignedToType = (typeof ALLOWED_ASSIGNED_TO_TYPES)[number];

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Required-once elements (`fullName`, `active`)
 * use this; repeating elements (`ruleEntry`, `criteriaItems`) use
 * `toArray` instead.
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
 * Coerce an XML scalar to a boolean. The Salesforce default for unset
 * boolean elements is `false`, so anything that isn't the literal `true`
 * (or its string form) collapses to `false`.
 */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
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
 * Locate and validate the `<AssignmentRules>` root in a parsed XML tree.
 *
 * Per `AssignmentRule.md`, a file with an `<AssignmentRules>` root but
 * zero child rules is a documented happy path (not an error).
 * fast-xml-parser represents `<AssignmentRules/>` and
 * `<AssignmentRules></AssignmentRules>` as an empty string rather than
 * an empty object; both shapes count as a valid empty root and yield
 * zero nodes/edges. A missing `<AssignmentRules>` key is the only
 * malformed case here.
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
  // `<AssignmentRules/>` / `<AssignmentRules></AssignmentRules>` — empty but valid.
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
 * Convert an `<assignedTo>` + `<assignedToType>` pair to a canonical
 * target id per the variant table in `AssignmentRule.md`. The `User`
 * variant dangles by design in v1.3 (no User extractor); the edge is
 * still emitted so downstream consumers know about the dependency.
 */
const resolveAssignedTo = (
  assignedTo: string,
  assignedToType: AssignedToType,
): string => `${assignedToType}:${assignedTo}`;

/**
 * Convert a `<template>` XML value of the form `{Folder}/{TemplateName}`
 * to its canonical `EmailTemplate:{Folder}.{TemplateName}` id. Only the
 * first slash is treated as the folder separator; template names
 * containing additional slashes round-trip unchanged.
 */
const templateToEmailTemplateId = (template: string): string => {
  const slash = template.indexOf('/');
  if (slash === -1) {
    // Templated without a folder prefix is unusual but the doc doesn't
    // forbid it. Keep the value verbatim after the prefix; downstream
    // tools see a flat name and can flag the edge as suspect.
    return `EmailTemplate:${template}`;
  }
  return `EmailTemplate:${template.slice(0, slash)}.${template.slice(slash + 1)}`;
};

/**
 * The per-`<ruleEntry>` derived bundle: the resolved assignment-target
 * canonical id, the entry's type variant, the counted criteria, the
 * `<formula>` presence, the boolean overrides, and the optional
 * `<template>` value. Used to build both the per-entry `references`
 * edge and the optional `sendsEmail` edge in lock-step.
 *
 * v2.0a additionally captures the raw criteria items (or the formula
 * string) so the calling `buildRule` can hand them to the shared
 * `extractConditions` helper. Per
 * `ConditionalContextSemantics.md` §"AutoResponseRule / AssignmentRule /
 * EscalationRule conditions", the v2.0a layer emits ONE
 * ConditionalContext per `<ruleEntry>`.
 */
interface ResolvedRuleEntry {
  /** Null when the entry filters only (no `<assignedTo>` in org metadata). */
  readonly targetId: string | null;
  readonly assignedToType: AssignedToType | null;
  readonly criteriaItemCount: number;
  readonly hasFormula: boolean;
  readonly overrideExistingAssignment: boolean;
  readonly notifyAssignee: boolean;
  readonly template: string | null;
  /** v2.0a — the per-entry condition source for `extractConditions`. */
  readonly conditionSource: ConditionSource | null;
}

/**
 * Parse a single `<criteriaItems>` element into the helper's
 * `CriteriaItem` shape. `<field>` and `<operation>` are required for
 * a usable criteria item; an entry missing either is silently skipped.
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
  return {
    field: String(fieldRaw),
    operation: String(operationRaw),
    value:
      valueRaw === undefined || valueRaw === null || valueRaw === ''
        ? null
        : String(valueRaw),
  };
};

/**
 * Build the per-entry `ConditionSource` per the v2.0a spec. A
 * `<ruleEntry>` carries either `<formula>` or `<criteriaItems>` (or
 * neither, in which case no ConditionalContext is emitted).
 */
const collectEntryConditionSource = (
  entry: Record<string, unknown>,
): ConditionSource | null => {
  const formulaRaw = unwrapSingle(entry['formula']);
  if (
    formulaRaw !== undefined &&
    formulaRaw !== null &&
    formulaRaw !== ''
  ) {
    return { kind: 'formula', expression: String(formulaRaw) };
  }
  const items: CriteriaItem[] = [];
  for (const raw of toArray(entry['criteriaItems'])) {
    const parsed = parseCriteriaItem(raw);
    if (parsed !== null) items.push(parsed);
  }
  if (items.length === 0) return null;
  const booleanFilterRaw = unwrapSingle(entry['booleanFilter']);
  const booleanFilter =
    booleanFilterRaw === undefined ||
    booleanFilterRaw === null ||
    booleanFilterRaw === ''
      ? null
      : String(booleanFilterRaw);
  return { kind: 'criteria', items, booleanFilter };
};

/**
 * Validate and resolve a single `<ruleEntry>` object. The XML may carry
 * `description`, `editable`, and other untracked elements; the extractor
 * extracts only the documented surface. Per `AssignmentRule.md`,
 * `<assignedTo>` + `<assignedToType>` are required together when either is
 * present; a criteria-only entry with neither is valid (filter-only row).
 */
const resolveRuleEntry = (
  entry: Record<string, unknown>,
  path: string,
): Result<ResolvedRuleEntry, ExtractorError> => {
  const assignedToRaw = unwrapSingle(entry['assignedTo']);
  const assignedToTypeRaw = unwrapSingle(entry['assignedToType']);
  const hasAssignedTo =
    assignedToRaw !== undefined && assignedToRaw !== null && assignedToRaw !== '';
  const hasAssignedToType =
    assignedToTypeRaw !== undefined &&
    assignedToTypeRaw !== null &&
    assignedToTypeRaw !== '';

  if (!hasAssignedTo && !hasAssignedToType) {
    // Filter-only entry — no assignee target edge.
    const formulaRaw = unwrapSingle(entry['formula']);
    const hasFormula =
      formulaRaw !== undefined && formulaRaw !== null && formulaRaw !== '';
    const templateRaw = unwrapSingle(entry['template']);
    const template =
      templateRaw === undefined || templateRaw === null || templateRaw === ''
        ? null
        : String(templateRaw);
    return ok({
      targetId: null,
      assignedToType: null,
      criteriaItemCount: toArray(entry['criteriaItems']).length,
      hasFormula,
      overrideExistingAssignment: coerceBoolean(
        unwrapSingle(entry['overrideExistingAssignment']),
      ),
      notifyAssignee: coerceBoolean(unwrapSingle(entry['notifyAssignee'])),
      template,
      conditionSource: collectEntryConditionSource(entry),
    });
  }

  if (!hasAssignedTo) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <assignedTo>',
    });
  }
  if (!hasAssignedToType) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <assignedToType>',
    });
  }
  const assignedToTypeStr = String(assignedToTypeRaw);
  if (!ALLOWED_ASSIGNED_TO_TYPES.includes(assignedToTypeStr as AssignedToType)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid assignedToType: ${assignedToTypeStr}`,
    });
  }
  const assignedToType = assignedToTypeStr as AssignedToType;
  const assignedTo = String(assignedToRaw);

  const templateRaw = unwrapSingle(entry['template']);
  const template =
    templateRaw === undefined || templateRaw === null || templateRaw === ''
      ? null
      : String(templateRaw);

  const formulaRaw = unwrapSingle(entry['formula']);
  const hasFormula =
    formulaRaw !== undefined && formulaRaw !== null && formulaRaw !== '';

  return ok({
    targetId: resolveAssignedTo(assignedTo, assignedToType),
    assignedToType,
    criteriaItemCount: toArray(entry['criteriaItems']).length,
    hasFormula,
    overrideExistingAssignment: coerceBoolean(
      unwrapSingle(entry['overrideExistingAssignment']),
    ),
    notifyAssignee: coerceBoolean(unwrapSingle(entry['notifyAssignee'])),
    template,
    conditionSource: collectEntryConditionSource(entry),
  });
};

/**
 * Build a per-rule Node + outgoing edges. Each rule emits one `parentOf`
 * edge from `CustomObject:{ObjectApiName}`, one `references` edge per
 * `<ruleEntry>` to the resolved target, and one optional `sendsEmail`
 * edge per `<ruleEntry>` carrying a `<template>`. `entryIndex` preserves
 * the XML evaluation order, which is load-bearing — Salesforce picks
 * the first matching entry top-to-bottom.
 */
const buildRule = (
  rule: Record<string, unknown>,
  objectApiName: string,
  parentId: string,
  path: string,
): Result<
  {
    readonly node: Node;
    readonly edges: readonly Edge[];
    readonly conditionNodes: readonly Node[];
  },
  ExtractorError
> => {
  const fullNameRaw = unwrapSingle(rule['fullName']);
  if (fullNameRaw === undefined || fullNameRaw === null || fullNameRaw === '') {
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
  const fullName = String(fullNameRaw);
  const active = coerceBoolean(activeRaw);

  const ruleEntries = toArray(rule['ruleEntry']).filter(
    (e): e is Record<string, unknown> => typeof e === 'object' && e !== null,
  );
  const resolvedEntries: ResolvedRuleEntry[] = [];
  for (const entry of ruleEntries) {
    const resolved = resolveRuleEntry(entry, path);
    if (!resolved.ok) return resolved;
    resolvedEntries.push(resolved.value);
  }

  const ruleId = `AssignmentRule:${objectApiName}.${fullName}`;
  const targetCount = new Set(
    resolvedEntries.map((e) => e.targetId).filter((id): id is string => id !== null),
  ).size;

  // v2.0a — Per the spec, emit ONE ConditionalContext per
  // `<ruleEntry>`. Entries lacking a `<formula>` / `<criteriaItems>`
  // produce a `null` `conditionSource` and are NOT counted toward the
  // condition list (silently dropped). The index used in the
  // synthetic id matches the entry's position in the rule's source
  // order, so the indices align with the `entryIndex` we already
  // surface on the per-entry `references` edges.
  const conditionSources: ConditionSource[] = [];
  const conditionEntryIndices: number[] = [];
  for (let entryIndex = 0; entryIndex < resolvedEntries.length; entryIndex += 1) {
    const source = resolvedEntries[entryIndex]!.conditionSource;
    if (source === null) continue;
    conditionSources.push(source);
    conditionEntryIndices.push(entryIndex);
  }
  const { conditionNodes, firesWhenEdges, conditionsMirror } =
    extractConditions({
      parentId: ruleId,
      sources: conditionSources,
      parentSourcePath: path,
      parentObjectApiName: objectApiName,
    });

  const node: Node = {
    id: ruleId,
    type: 'AssignmentRule',
    apiName: `${objectApiName}.${fullName}`,
    label: fullName,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      active,
      ruleEntryCount: resolvedEntries.length,
      targetCount,
      conditions: conditionsMirror,
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
  ];

  for (let entryIndex = 0; entryIndex < resolvedEntries.length; entryIndex += 1) {
    const entry = resolvedEntries[entryIndex]!;
    if (entry.targetId === null) continue;
    edges.push({
      fromId: ruleId,
      toId: entry.targetId,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {
        entryIndex,
        assignedToType: entry.assignedToType,
        criteriaItemCount: entry.criteriaItemCount,
        hasFormula: entry.hasFormula,
        overrideExistingAssignment: entry.overrideExistingAssignment,
        notifyAssignee: entry.notifyAssignee,
      },
    });
    if (entry.template !== null) {
      edges.push({
        fromId: ruleId,
        toId: templateToEmailTemplateId(entry.template),
        edgeType: 'sendsEmail',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: { entryIndex },
      });
    }
  }

  // v2.0a — Append the firesWhen edges at the tail. The synthetic
  // ConditionalContext nodes are returned alongside the rule node.
  edges.push(...firesWhenEdges);

  return ok({ node, edges, conditionNodes });
};

/**
 * Extract Nodes and Edges from a single Salesforce
 * `*.assignmentRules-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<AssignmentRules>`
 * root per the vendored `AssignmentRule.md` spec, and returns an
 * `ExtractionResult` containing one `'AssignmentRule'` Node per
 * `<assignmentRule>` child. The root file itself produces no Node;
 * only the individual rules do.
 *
 * For each rule the extractor emits a `parentOf` edge from
 * `CustomObject:{ObjectApiName}` to the rule, one `references` edge per
 * `<ruleEntry>` to the resolved assignment target
 * (`{Queue,User,Role}:{assignedTo}`), and one optional `sendsEmail` edge
 * per `<ruleEntry>` carrying a `<template>` (to
 * `EmailTemplate:{Folder}.{TemplateName}`). `entryIndex` on each
 * per-entry edge preserves the XML evaluation order — Salesforce picks
 * the first matching entry top-to-bottom, so order is load-bearing.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<fullName>` / `<active>` / `<assignedTo>` /
 * `<assignedToType>`, or `<assignedToType>` outside `{Queue, User,
 * Role}`).
 *
 * @example
 *   const result = await extractAssignmentRule(
 *     'force-app/main/default/assignmentRules/Lead.assignmentRules-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'AssignmentRule:Lead.Standard_Lead_Routing'
 *   }
 */
export const extractAssignmentRule = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale assignment-rules XML (many rule
  // entries multiplied by criteriaItems).
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

  const objectApiName = deriveComponentApiName(path, ASSIGNMENT_RULES_FILE_SUFFIX);
  const parentId = `CustomObject:${objectApiName}`;

  const rules = toArray(rootObj[RULE_ELEMENT]).filter(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
  );

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const rule of rules) {
    const built = buildRule(rule, objectApiName, parentId, path);
    if (!built.ok) return built;
    nodes.push(built.value.node);
    // v2.0a — Append the synthetic ConditionalContext nodes per rule.
    nodes.push(...built.value.conditionNodes);
    edges.push(...built.value.edges);
  }

  return ok({ nodes, edges });
};
