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

import { deriveComponentApiName } from './path-utils.js';

const MATCHING_RULE_FILE_SUFFIX = '.matchingRule-meta.xml';
const ROOT_ELEMENT = 'MatchingRules';
const RULE_ELEMENT = 'matchingRules';
const EXTRACTOR_SOURCE = 'matching-rule-extractor';
const ALLOWED_RULE_STATUSES = [
  'Active',
  'Inactive',
  'Activating',
  'Deactivating',
  'DeactivatingMaster',
  'Draft',
  // A rule whose async activation failed reports `ActivationFailed`. It is a
  // real, documented status on live orgs (seen on real Account/Contact matching
  // rules); omitting it made the extractor reject the rule with
  // `invalid ruleStatus`, which aborted the WHOLE file and dropped every OTHER
  // (valid) matching rule on that object.
  'ActivationFailed',
] as const;
const ALLOWED_BLANK_VALUE_BEHAVIORS = [
  'MatchBlanks',
  'NullNotAllowed',
  'Null',
] as const;

type RuleStatus = (typeof ALLOWED_RULE_STATUSES)[number];
type BlankValueBehavior = (typeof ALLOWED_BLANK_VALUE_BEHAVIORS)[number];

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Required-once elements (`fullName`, `label`,
 * `ruleStatus`) use this; repeating elements (`matchingRuleItems`) use
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
 * Locate and validate the `<MatchingRules>` root in a parsed XML tree.
 *
 * Per `MatchingRule.md`, a file with a `<MatchingRules>` root but zero
 * child rules is a documented happy path (not an error). fast-xml-parser
 * represents `<MatchingRules/>` and `<MatchingRules></MatchingRules>` as
 * an empty string rather than an empty object; both shapes count as a
 * valid empty root and yield zero nodes/edges. A missing `<MatchingRules>`
 * key is the only malformed case here.
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
  // `<MatchingRules/>` / `<MatchingRules></MatchingRules>` — empty but valid.
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
 * The per-`<matchingRuleItems>` derived bundle: the field being compared,
 * the matching method, and (optionally) the blank-value behavior. Used to
 * compute the rule's `itemCount`, `matchingMethods`, and `fieldsCompared`
 * property strings.
 */
interface ResolvedRuleItem {
  readonly fieldName: string;
  readonly matchingMethod: string;
}

/**
 * Validate and resolve a single `<matchingRuleItems>` object. Per
 * `MatchingRule.md`, `<fieldName>` and `<matchingMethod>` are required;
 * if `<blankValueBehavior>` is present it must be one of `{MatchBlanks,
 * NullNotAllowed, Null}`. Unknown sub-elements are silently skipped.
 */
const resolveRuleItem = (
  item: Record<string, unknown>,
  path: string,
): Result<ResolvedRuleItem, ExtractorError> => {
  const fieldNameRaw = unwrapSingle(item['fieldName']);
  if (fieldNameRaw === undefined || fieldNameRaw === null || fieldNameRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <fieldName>',
    });
  }
  const matchingMethodRaw = unwrapSingle(item['matchingMethod']);
  if (
    matchingMethodRaw === undefined ||
    matchingMethodRaw === null ||
    matchingMethodRaw === ''
  ) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <matchingMethod>',
    });
  }
  const blankValueBehaviorRaw = unwrapSingle(item['blankValueBehavior']);
  if (
    blankValueBehaviorRaw !== undefined &&
    blankValueBehaviorRaw !== null &&
    blankValueBehaviorRaw !== ''
  ) {
    const value = String(blankValueBehaviorRaw);
    if (!ALLOWED_BLANK_VALUE_BEHAVIORS.includes(value as BlankValueBehavior)) {
      return err({
        kind: 'malformed-input',
        path,
        message: `invalid blankValueBehavior: ${value}`,
      });
    }
  }
  return ok({
    fieldName: String(fieldNameRaw),
    matchingMethod: String(matchingMethodRaw),
  });
};

/**
 * Build a per-rule Node + one `parentOf` edge. Each rule contributes
 * exactly one node and one edge — MatchingRules emit no `references`
 * edges in v1.3 (the duplicate-rule -> matching-rule link is the
 * **inbound** reference produced by the DuplicateRule extractor).
 */
const buildRule = (
  rule: Record<string, unknown>,
  objectApiName: string,
  parentId: string,
  path: string,
): Result<{ readonly node: Node; readonly edges: readonly Edge[] }, ExtractorError> => {
  const fullNameRaw = unwrapSingle(rule['fullName']);
  if (fullNameRaw === undefined || fullNameRaw === null || fullNameRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <fullName>',
    });
  }
  const labelRaw = unwrapSingle(rule['label']);
  if (labelRaw === undefined || labelRaw === null || labelRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <label>',
    });
  }
  const ruleStatusRaw = unwrapSingle(rule['ruleStatus']);
  if (
    ruleStatusRaw === undefined ||
    ruleStatusRaw === null ||
    ruleStatusRaw === ''
  ) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <ruleStatus>',
    });
  }
  const ruleStatusValue = String(ruleStatusRaw);
  if (!ALLOWED_RULE_STATUSES.includes(ruleStatusValue as RuleStatus)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid ruleStatus: ${ruleStatusValue}`,
    });
  }

  const fullName = String(fullNameRaw);
  const label = String(labelRaw);
  const ruleStatus = ruleStatusValue as RuleStatus;

  const items = toArray(rule['matchingRuleItems']).filter(
    (i): i is Record<string, unknown> => typeof i === 'object' && i !== null,
  );
  const resolvedItems: ResolvedRuleItem[] = [];
  for (const item of items) {
    const resolved = resolveRuleItem(item, path);
    if (!resolved.ok) return resolved;
    resolvedItems.push(resolved.value);
  }

  const descriptionRaw = unwrapSingle(rule['description']);
  const description =
    descriptionRaw === undefined || descriptionRaw === null
      ? null
      : String(descriptionRaw);

  const booleanFilterRaw = unwrapSingle(rule['booleanFilter']);
  const booleanFilter =
    booleanFilterRaw === undefined || booleanFilterRaw === null
      ? null
      : String(booleanFilterRaw);

  // De-duplicate matching methods while preserving first-seen order.
  const distinctMethods: string[] = [];
  const seen = new Set<string>();
  for (const item of resolvedItems) {
    if (!seen.has(item.matchingMethod)) {
      seen.add(item.matchingMethod);
      distinctMethods.push(item.matchingMethod);
    }
  }
  const fieldsCompared = resolvedItems.map((i) => i.fieldName).join(',');
  const matchingMethods = distinctMethods.join(',');

  const ruleId = `MatchingRule:${objectApiName}.${fullName}`;
  const node: Node = {
    id: ruleId,
    type: 'MatchingRule',
    apiName: `${objectApiName}.${fullName}`,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      ruleStatus,
      description,
      booleanFilter,
      itemCount: resolvedItems.length,
      matchingMethods,
      fieldsCompared,
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

  return ok({ node, edges });
};

/**
 * Extract Nodes and Edges from a single Salesforce
 * `{ObjectApiName}.matchingRule-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<MatchingRules>`
 * (plural) root per the vendored `MatchingRule.md` spec, and returns an
 * `ExtractionResult` containing one `'MatchingRule'` Node per
 * `<matchingRules>` (plural with `s`) child. The root file itself
 * produces no Node; only the individual rules do.
 *
 * **Filename typo trap.** Salesforce ships the filename suffix as
 * `.matchingRule-meta.xml` (singular) but the XML container element is
 * `<MatchingRules>` (plural) and each per-rule child is `<matchingRules>`
 * (plural with `s`, not `<matchingRule>` singular). The extractor reads
 * the plural child as documented; the singular filename is a Salesforce
 * shipped convention.
 *
 * For each rule the extractor emits one `parentOf` edge from
 * `CustomObject:{ObjectApiName}` to the rule. MatchingRules emit no
 * `references` edges in v1.3 — the duplicate-rule -> matching-rule link
 * is the **inbound** `references` edge produced by the DuplicateRule
 * extractor (the matcher itself is a leaf consumer in the rule graph).
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<fullName>` / `<label>` / `<ruleStatus>` / `<fieldName>` /
 * `<matchingMethod>`, `<ruleStatus>` outside the allowed set, or
 * `<blankValueBehavior>` outside the allowed set).
 *
 * @example
 *   const result = await extractMatchingRule(
 *     'force-app/main/default/matchingRules/Lead.matchingRule-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'MatchingRule:Lead.Lead_Match_Email'
 *   }
 */
export const extractMatchingRule = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale matching-rules XML (many rules
  // multiplied by matchingRuleItems).
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

  const objectApiName = deriveComponentApiName(path, MATCHING_RULE_FILE_SUFFIX);
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
    edges.push(...built.value.edges);
  }

  return ok({ nodes, edges });
};
