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

import { deriveDotSplitObjectAndApiName } from './path-utils.js';

const DUPLICATE_RULE_FILE_SUFFIX = '.duplicateRule-meta.xml';
const ROOT_ELEMENT = 'DuplicateRule';
const EXTRACTOR_SOURCE = 'duplicate-rule-extractor';
const ALLOWED_ACTIONS = ['Allow', 'Block'] as const;
const ALLOWED_SECURITY_OPTIONS = [
  'EnforceSharingRules',
  'BypassSharingRules',
] as const;
// The `DuplicateRuleOperation` enumeration. `<operationsOnInsert>` /
// `<operationsOnUpdate>` repeat, each carrying one of these values.
const ALLOWED_OPERATIONS = ['Allow', 'Block', 'Alert', 'Report'] as const;

type Action = (typeof ALLOWED_ACTIONS)[number];
type SecurityOption = (typeof ALLOWED_SECURITY_OPTIONS)[number];
type Operation = (typeof ALLOWED_OPERATIONS)[number];

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Single-occurrence elements (`masterLabel`,
 * `isActive`, `alertText`) use this; repeating elements
 * (`operationsOnInsert`, `operationsOnUpdate`, `duplicateRuleMatchRules`,
 * `objectMapping`) use `toArray` instead.
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
 * Locate the `<DuplicateRule>` root in a parsed XML tree.
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
  return ok(root as Record<string, unknown>);
};

/**
 * Resolve the repeated `<operationsOnInsert>` / `<operationsOnUpdate>`
 * elements into a list of `DuplicateRuleOperation` enum values. Each
 * occurrence holds a single enum string (`Allow` / `Block` / `Alert` /
 * `Report`); the element is NOT a container and carries no nested
 * `<allowSave>`. The list is optional — an absent element yields `[]`,
 * and empty / `xsi:nil` occurrences are skipped. A present value outside
 * the enum is a `malformed-input` error, mirroring how `<actionOnInsert>`
 * and `<securityOption>` are validated.
 */
const resolveOperations = (
  raw: unknown,
  fieldName: 'operationsOnInsert' | 'operationsOnUpdate',
  path: string,
): Result<Operation[], ExtractorError> => {
  const operations: Operation[] = [];
  for (const entry of toArray(raw)) {
    if (entry === undefined || entry === null || entry === '') continue;
    const value = String(entry);
    if (!ALLOWED_OPERATIONS.includes(value as Operation)) {
      return err({
        kind: 'malformed-input',
        path,
        message: `invalid ${fieldName}: ${value}`,
      });
    }
    operations.push(value as Operation);
  }
  return ok(operations);
};

/**
 * Resolve the optional `<duplicateRuleFilter>` element into a filter
 * expression string. The vendored doc allows either a literal
 * `<filterExpression>` child or a serialized criteria block; either way
 * the value is preserved verbatim, untokenized — field-level edges from
 * the filter are v1.4 work.
 */
const resolveFilterExpression = (rule: Record<string, unknown>): string | null => {
  const filterRaw = unwrapSingle(rule['duplicateRuleFilter']);
  if (filterRaw === undefined || filterRaw === null) return null;
  if (typeof filterRaw === 'string') {
    return filterRaw === '' ? null : filterRaw;
  }
  if (typeof filterRaw === 'object') {
    const filterObj = filterRaw as Record<string, unknown>;
    const expressionRaw = unwrapSingle(filterObj['filterExpression']);
    if (expressionRaw !== undefined && expressionRaw !== null && expressionRaw !== '') {
      return String(expressionRaw);
    }
    // The filter element is present but has no inner `filterExpression` —
    // serialize the criteria block opaquely so downstream consumers see
    // something. JSON is the simplest verbatim representation.
    try {
      return JSON.stringify(filterObj);
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * The resolved form of a `<duplicateRuleMatchRules>` entry: the canonical
 * target id of the matching rule and the count of real (object-shaped)
 * `<objectMapping>` entries — nil/empty mappings excluded — used as an edge
 * property to flag cross-object field mappings.
 */
interface ResolvedMatcher {
  readonly toId: string;
  readonly objectMappingCount: number;
}

/**
 * Resolve a single `<duplicateRuleMatchRules>` entry. Per
 * `DuplicateRule.md`, `<matchingRule>` is required; `<matchRuleSObjectType>`
 * is optional and defaults to the duplicate rule's parent object.
 */
const resolveMatcher = (
  matcher: Record<string, unknown>,
  defaultObjectApiName: string,
  path: string,
): Result<ResolvedMatcher, ExtractorError> => {
  const matchingRuleRaw = unwrapSingle(matcher['matchingRule']);
  if (
    matchingRuleRaw === undefined ||
    matchingRuleRaw === null ||
    matchingRuleRaw === ''
  ) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <matchingRule>',
    });
  }
  const matchingRuleName = String(matchingRuleRaw);
  const sObjectRaw = unwrapSingle(matcher['matchRuleSObjectType']);
  const matchObjectApiName =
    sObjectRaw === undefined || sObjectRaw === null || sObjectRaw === ''
      ? defaultObjectApiName
      : String(sObjectRaw);
  // Count only real (object-shaped) object mappings. Salesforce emits an
  // empty mapping as `<objectMapping xsi:nil="true"/>`; with the parser's
  // `ignoreAttributes: true`, that (and any empty `<objectMapping/>`)
  // collapses to the string `""`, which `toArray` would otherwise count as
  // one entry. A real mapping parses to an object, so the filter drops the
  // nil/empty form and a matcher with no real mapping correctly reports 0.
  const objectMappingCount = toArray(matcher['objectMapping']).filter(
    (m) => typeof m === 'object' && m !== null,
  ).length;
  return ok({
    toId: `MatchingRule:${matchObjectApiName}.${matchingRuleName}`,
    objectMappingCount,
  });
};

/**
 * Extract a Node and edges from a single Salesforce
 * `{ObjectApiName}.{RuleName}.duplicateRule-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<DuplicateRule>` root
 * per the vendored `DuplicateRule.md` spec, and returns an
 * `ExtractionResult` containing one `'DuplicateRule'` Node and one or
 * more outgoing edges:
 *
 * 1. One `parentOf` edge from `CustomObject:{ObjectApiName}` to the rule.
 * 2. One `references` edge per `<duplicateRuleMatchRules>` entry to the
 *    referenced MatchingRule
 *    (`MatchingRule:{MatchObjectApiName}.{matchingRule}`). When the entry
 *    specifies `<matchRuleSObjectType>`, that drives the target object;
 *    when absent, the parent object of the duplicate rule is used. The
 *    edge carries `matcherIndex` (0-based XML order) and
 *    `objectMappingCount` (the count of real object-shaped `<objectMapping>`
 *    entries; nil/empty mappings excluded) as properties. Duplicate matcher
 *    references (same matching rule named twice) are deduplicated.
 *
 * The two-segment filename `{Obj}.{Rule}` is split on the **first** dot
 * to recover both parts; rule names containing dots round-trip correctly.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * un-splittable filename, missing `<masterLabel>` / `<isActive>` / any
 * `<matchingRule>`, empty `<duplicateRuleMatchRules>` list, or
 * `<operationsOnInsert>` / `<operationsOnUpdate>` / `<actionOnInsert>` /
 * `<actionOnUpdate>` / `<securityOption>` outside the documented allowed
 * sets).
 *
 * @example
 *   const result = await extractDuplicateRule(
 *     'force-app/main/default/duplicateRules/Account.Block_Domain_Dupes.duplicateRule-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'DuplicateRule:Account.Block_Domain_Dupes'
 *   }
 */
export const extractDuplicateRule = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = deriveDotSplitObjectAndApiName(
    path,
    DUPLICATE_RULE_FILE_SUFFIX,
  );
  if (pathParts === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot split filename into object and rule name',
    });
  }
  const { objectApiName, apiName: ruleName } = pathParts;

  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale duplicate-rules XML (many matcher
  // entries multiplied by objectMapping fields).
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

  // Required scalars.
  const masterLabelRaw = unwrapSingle(rootObj['masterLabel']);
  if (
    masterLabelRaw === undefined ||
    masterLabelRaw === null ||
    masterLabelRaw === ''
  ) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <masterLabel>',
    });
  }
  const isActiveRaw = unwrapSingle(rootObj['isActive']);
  if (isActiveRaw === undefined || isActiveRaw === null || isActiveRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <isActive>',
    });
  }
  const masterLabel = String(masterLabelRaw);
  const isActive = coerceBoolean(isActiveRaw);

  // Operations lists (repeated DuplicateRuleOperation enum elements).
  const insertOps = resolveOperations(
    rootObj['operationsOnInsert'],
    'operationsOnInsert',
    path,
  );
  if (!insertOps.ok) return insertOps;
  const updateOps = resolveOperations(
    rootObj['operationsOnUpdate'],
    'operationsOnUpdate',
    path,
  );
  if (!updateOps.ok) return updateOps;

  // Required matcher list (must be non-empty).
  const matcherEntries = toArray(rootObj['duplicateRuleMatchRules']).filter(
    (m): m is Record<string, unknown> => typeof m === 'object' && m !== null,
  );
  if (matcherEntries.length === 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'DuplicateRule must reference at least one MatchingRule',
    });
  }
  const resolvedMatchers: ResolvedMatcher[] = [];
  for (const matcher of matcherEntries) {
    const resolved = resolveMatcher(matcher, objectApiName, path);
    if (!resolved.ok) return resolved;
    resolvedMatchers.push(resolved.value);
  }

  // Validated-against-enum optionals.
  const actionOnInsertRaw = unwrapSingle(rootObj['actionOnInsert']);
  let actionOnInsert: Action | null = null;
  if (
    actionOnInsertRaw !== undefined &&
    actionOnInsertRaw !== null &&
    actionOnInsertRaw !== ''
  ) {
    const value = String(actionOnInsertRaw);
    if (!ALLOWED_ACTIONS.includes(value as Action)) {
      return err({
        kind: 'malformed-input',
        path,
        message: `invalid actionOnInsert: ${value}`,
      });
    }
    actionOnInsert = value as Action;
  }
  const actionOnUpdateRaw = unwrapSingle(rootObj['actionOnUpdate']);
  let actionOnUpdate: Action | null = null;
  if (
    actionOnUpdateRaw !== undefined &&
    actionOnUpdateRaw !== null &&
    actionOnUpdateRaw !== ''
  ) {
    const value = String(actionOnUpdateRaw);
    if (!ALLOWED_ACTIONS.includes(value as Action)) {
      return err({
        kind: 'malformed-input',
        path,
        message: `invalid actionOnUpdate: ${value}`,
      });
    }
    actionOnUpdate = value as Action;
  }
  const securityOptionRaw = unwrapSingle(rootObj['securityOption']);
  let securityOption: SecurityOption | null = null;
  if (
    securityOptionRaw !== undefined &&
    securityOptionRaw !== null &&
    securityOptionRaw !== ''
  ) {
    const value = String(securityOptionRaw);
    if (!ALLOWED_SECURITY_OPTIONS.includes(value as SecurityOption)) {
      return err({
        kind: 'malformed-input',
        path,
        message: `invalid securityOption: ${value}`,
      });
    }
    securityOption = value as SecurityOption;
  }

  // Free-form optionals. `<alertText>` is a single top-level element (the
  // message shown when a duplicate is detected), not nested inside the
  // operations elements.
  const descriptionRaw = unwrapSingle(rootObj['description']);
  const description =
    descriptionRaw === undefined || descriptionRaw === null
      ? null
      : String(descriptionRaw);
  const alertTextRaw = unwrapSingle(rootObj['alertText']);
  const alertText =
    alertTextRaw === undefined || alertTextRaw === null
      ? null
      : String(alertTextRaw);
  const sortOrderRaw = unwrapSingle(rootObj['sortOrder']);
  let sortOrder: number | null = null;
  if (sortOrderRaw !== undefined && sortOrderRaw !== null && sortOrderRaw !== '') {
    const parsedNum = Number(sortOrderRaw);
    sortOrder = Number.isFinite(parsedNum) ? parsedNum : null;
  }

  const filterExpression = resolveFilterExpression(rootObj);

  const ruleId = `DuplicateRule:${objectApiName}.${ruleName}`;
  const parentId = `CustomObject:${objectApiName}`;
  const apiName = `${objectApiName}.${ruleName}`;

  const node: Node = {
    id: ruleId,
    type: 'DuplicateRule',
    apiName,
    label: masterLabel,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      isActive,
      description,
      securityOption,
      actionOnInsert,
      actionOnUpdate,
      operationsOnInsert: insertOps.value,
      operationsOnUpdate: updateOps.value,
      alertText,
      filterExpression,
      matchingRuleCount: resolvedMatchers.length,
      sortOrder,
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

  // Deduplicate `(rule, matcher canonical id)` pairs while preserving
  // first-seen XML order (so `matcherIndex` reflects the originating XML
  // position, not the deduplicated position).
  const seenTargets = new Set<string>();
  for (let matcherIndex = 0; matcherIndex < resolvedMatchers.length; matcherIndex += 1) {
    const matcher = resolvedMatchers[matcherIndex]!;
    if (seenTargets.has(matcher.toId)) continue;
    seenTargets.add(matcher.toId);
    edges.push({
      fromId: ruleId,
      toId: matcher.toId,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {
        matcherIndex,
        objectMappingCount: matcher.objectMappingCount,
      },
    });
  }

  return ok({ nodes: [node], edges });
};
