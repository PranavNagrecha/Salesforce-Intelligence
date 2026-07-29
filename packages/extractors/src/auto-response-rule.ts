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

const AUTO_RESPONSE_RULES_FILE_SUFFIX = '.autoResponseRules-meta.xml';
const ROOT_ELEMENT = 'AutoResponseRules';
const RULE_ELEMENT = 'autoResponseRule';
const EXTRACTOR_SOURCE = 'auto-response-rule-extractor';

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Required-once elements (`fullName`, `active`,
 * `template`, `senderName`) use this; repeating elements (`ruleEntry`,
 * `criteriaItems`) use `toArray` instead.
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
 * Locate and validate the `<AutoResponseRules>` root in a parsed XML
 * tree.
 *
 * Per `AutoResponseRule.md`, a file with an `<AutoResponseRules>` root
 * but zero child rules is a documented happy path (not an error).
 * fast-xml-parser represents `<AutoResponseRules/>` and
 * `<AutoResponseRules></AutoResponseRules>` as an empty string rather
 * than an empty object; both shapes count as a valid empty root and
 * yield zero nodes/edges.
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
  // `<AutoResponseRules/>` / `<AutoResponseRules></AutoResponseRules>` — empty but valid.
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
 * Convert a `<template>` XML value of the form `{Folder}/{TemplateName}`
 * to its canonical `EmailTemplate:{Folder}.{TemplateName}` id. Only the
 * first slash is treated as the folder separator; template names
 * containing additional slashes round-trip unchanged.
 */
const templateToEmailTemplateId = (template: string): string => {
  const slash = template.indexOf('/');
  if (slash === -1) {
    return `EmailTemplate:${template}`;
  }
  return `EmailTemplate:${template.slice(0, slash)}.${template.slice(slash + 1)}`;
};

/**
 * The per-`<ruleEntry>` derived bundle: the resolved EmailTemplate
 * canonical id, the sender name/email/reply-to, the counted criteria,
 * the `<formula>` presence, and (v2.0a) the per-entry condition source
 * for the shared `extractConditions` helper.
 */
interface ResolvedRuleEntry {
  readonly templateId: string;
  readonly senderName: string;
  readonly senderEmail: string | null;
  readonly replyToEmail: string | null;
  readonly criteriaItemCount: number;
  readonly hasFormula: boolean;
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
 * Build the per-entry condition source per the v2.0a spec — formula
 * takes precedence over criteria; an entry with neither produces
 * `null` (no ConditionalContext).
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
 * Validate and resolve a single `<ruleEntry>`. The XML may carry
 * `description` and other untracked elements; only the documented
 * surface is extracted. Per `AutoResponseRule.md`, `<template>` and
 * `<senderName>` are required.
 */
const resolveRuleEntry = (
  entry: Record<string, unknown>,
  path: string,
): Result<ResolvedRuleEntry, ExtractorError> => {
  const templateRaw = unwrapSingle(entry['template']);
  if (templateRaw === undefined || templateRaw === null || templateRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <template>',
    });
  }
  const senderNameRaw = unwrapSingle(entry['senderName']);
  if (
    senderNameRaw === undefined ||
    senderNameRaw === null ||
    senderNameRaw === ''
  ) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <senderName>',
    });
  }

  const senderEmailRaw = unwrapSingle(entry['senderEmail']);
  const replyToEmailRaw = unwrapSingle(entry['replyToEmail']);
  const formulaRaw = unwrapSingle(entry['formula']);

  return ok({
    templateId: templateToEmailTemplateId(String(templateRaw)),
    senderName: String(senderNameRaw),
    senderEmail:
      senderEmailRaw === undefined || senderEmailRaw === null || senderEmailRaw === ''
        ? null
        : String(senderEmailRaw),
    replyToEmail:
      replyToEmailRaw === undefined || replyToEmailRaw === null || replyToEmailRaw === ''
        ? null
        : String(replyToEmailRaw),
    criteriaItemCount: toArray(entry['criteriaItems']).length,
    hasFormula:
      formulaRaw !== undefined && formulaRaw !== null && formulaRaw !== '',
    conditionSource: collectEntryConditionSource(entry),
  });
};

/**
 * Build a per-rule Node + outgoing edges. Each rule emits one `parentOf`
 * edge from `CustomObject:{ObjectApiName}` and one `sendsEmail` edge per
 * `<ruleEntry>` to the resolved `EmailTemplate`. `entryIndex` preserves
 * the XML evaluation order — Salesforce picks the first matching entry
 * top-to-bottom.
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

  const ruleId = `AutoResponseRule:${objectApiName}.${fullName}`;
  const templateCount = new Set(resolvedEntries.map((e) => e.templateId)).size;

  // v2.0a — emit one ConditionalContext per `<ruleEntry>` carrying a
  // condition source. Entries without a `<formula>` / `<criteriaItems>`
  // produce no condition (silently dropped).
  const conditionSources: ConditionSource[] = [];
  for (const entry of resolvedEntries) {
    if (entry.conditionSource !== null) {
      conditionSources.push(entry.conditionSource);
    }
  }
  const { conditionNodes, firesWhenEdges, conditionsMirror, conditionFieldEdges } =
    extractConditions({
      parentId: ruleId,
      sources: conditionSources,
      parentSourcePath: path,
      parentObjectApiName: objectApiName,
    });

  const node: Node = {
    id: ruleId,
    type: 'AutoResponseRule',
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
      templateCount,
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
    edges.push({
      fromId: ruleId,
      toId: entry.templateId,
      edgeType: 'sendsEmail',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {
        entryIndex,
        senderName: entry.senderName,
        senderEmail: entry.senderEmail,
        replyToEmail: entry.replyToEmail,
        criteriaItemCount: entry.criteriaItemCount,
        hasFormula: entry.hasFormula,
      },
    });
  }

  // v2.0a — Append the firesWhen edges at the tail.
  edges.push(...firesWhenEdges, ...conditionFieldEdges);

  return ok({ node, edges, conditionNodes });
};

/**
 * Extract Nodes and Edges from a single Salesforce
 * `*.autoResponseRules-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<AutoResponseRules>`
 * root per the vendored `AutoResponseRule.md` spec, and returns an
 * `ExtractionResult` containing one `'AutoResponseRule'` Node per
 * `<autoResponseRule>` child. The root file itself produces no Node;
 * only the individual rules do.
 *
 * Auto-response rules are the **primary `sendsEmail` edge producer** in
 * v1.3. For each rule the extractor emits a `parentOf` edge from
 * `CustomObject:{ObjectApiName}` to the rule, plus one `sendsEmail`
 * edge per `<ruleEntry>` to the resolved EmailTemplate canonical id
 * (`EmailTemplate:{Folder}.{TemplateName}`). `entryIndex` preserves the
 * XML evaluation order — Salesforce picks the first matching entry
 * top-to-bottom, so order is load-bearing.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<fullName>` / `<active>` / `<template>` / `<senderName>`).
 *
 * @example
 *   const result = await extractAutoResponseRule(
 *     'force-app/main/default/autoResponseRules/Lead.autoResponseRules-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'AutoResponseRule:Lead.Standard_Web_To_Lead'
 *   }
 */
export const extractAutoResponseRule = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale auto-response-rules XML.
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

  const objectApiName = deriveComponentApiName(
    path,
    AUTO_RESPONSE_RULES_FILE_SUFFIX,
  );
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
