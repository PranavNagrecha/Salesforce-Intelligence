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

import { UNRESOLVED_PROFILE_PREFIX } from './enterprise-metadata.js';
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
 * DUPLICATE-RULE-FILTER-PROFILE-UNGRAPHED: a Profile the rule's
 * `<duplicateRuleFilter>` scopes matching by. Duplicate rules routinely
 * EXCLUDE an integration/admin Profile from matching (`Profile notEqual
 * Integration` on the User table); that exclusion stayed buried in the
 * opaque `filterExpression` JSON string, so the Profile looked unused and
 * "does Integration bypass portal duplicate matching?" had no graph answer.
 */
interface FilterProfileRef {
  /**
   * Canonical target — `Profile:{name}` for a `Profile` (name) filter, or an
   * honest `UnresolvedProfile:{id}` stub for a `ProfileId` (opaque id) filter. A
   * single-file extractor cannot resolve the id to the name-keyed
   * `Profile:{apiName}` node, and a `Profile:{id}` node would masquerade as a
   * real Profile — so the id stays in the distinct `UnresolvedProfile:`
   * namespace until `resolveRestrictionRuleProfileEdges` resolves it downstream.
   */
  readonly toId: string;
  /** The profile name (or id) verbatim from the filter value. */
  readonly profileValue: string;
  /** The filter operation (`equals` / `notEqual` / `contains` / …). */
  readonly operation: string;
  /** True when the filter field was `ProfileId` (opaque id, name unresolved). */
  readonly idBased: boolean;
  /** `declared` for exact-match ops on a name; `heuristic` otherwise. */
  readonly confidence: 'declared' | 'heuristic';
}

/**
 * Exact-match filter operations whose `<value>` is a Profile NAME the
 * `Profile:{name}` node is keyed by. `contains` / `startsWith` / etc. carry
 * a substring, so the resolved edge is `heuristic` (best-effort) rather than
 * `declared`.
 */
const EXACT_PROFILE_FILTER_OPS: ReadonlySet<string> = new Set([
  'equals',
  'notEqual',
]);

/**
 * DUPLICATE-RULE-FILTER-PROFILE-UNGRAPHED: parse the `<duplicateRuleFilter>`
 * for `Profile` / `ProfileId` filter items on the `User` table and resolve
 * each named Profile to a `Profile:` edge target.
 *
 * A multi-value `equals` / `notEqual` filter serialises its profiles as a
 * comma-separated `<value>` (`Integration, System Administrator`), so the
 * value is split on commas and trimmed; each part becomes ONE edge, in
 * first-seen order and deduplicated by target id. `field == 'Profile'`
 * carries the Profile NAME (matches the `Profile:{Name}` node key →
 * `declared` for exact ops); `field == 'ProfileId'` carries an opaque id the
 * single-file extractor cannot resolve to the name-keyed node, so it emits an
 * honest `UnresolvedProfile:{id}` stub at `heuristic` confidence — NEVER a
 * `Profile:{id}` node that would masquerade as a real Profile (the
 * RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE sibling; see
 * {@link UNRESOLVED_PROFILE_PREFIX}). The downstream
 * `resolveRestrictionRuleProfileEdges` refresh pass rewrites the stub to a real
 * `Profile:{apiName}` edge when an Id->apiName index resolves it.
 */
const extractFilterProfileRefs = (
  rule: Record<string, unknown>,
): readonly FilterProfileRef[] => {
  const filterRaw = unwrapSingle(rule['duplicateRuleFilter']);
  if (typeof filterRaw !== 'object' || filterRaw === null) return [];
  const filterObj = filterRaw as Record<string, unknown>;
  const refs: FilterProfileRef[] = [];
  const seen = new Set<string>();
  for (const rawItem of toArray(filterObj['duplicateRuleFilterItems'])) {
    if (typeof rawItem !== 'object' || rawItem === null) continue;
    const item = rawItem as Record<string, unknown>;
    const fieldRaw = unwrapSingle(item['field']);
    if (fieldRaw === undefined || fieldRaw === null) continue;
    const field = String(fieldRaw).trim();
    const isId = field === 'ProfileId';
    if (field !== 'Profile' && !isId) continue;
    // The standard `Profile` relationship lives on the User table. Require
    // `<table>User</table>` when present so a hypothetical custom field named
    // `Profile` on another object cannot mint a bogus Profile edge; an absent
    // table is tolerated (older serialisations).
    const tableRaw = unwrapSingle(item['table']);
    if (tableRaw !== undefined && tableRaw !== null && String(tableRaw).trim() !== 'User') {
      continue;
    }
    const valueRaw = unwrapSingle(item['value']);
    if (valueRaw === undefined || valueRaw === null || String(valueRaw) === '') {
      continue;
    }
    const operationRaw = unwrapSingle(item['operation']);
    const operation =
      operationRaw === undefined || operationRaw === null
        ? ''
        : String(operationRaw);
    const exact = EXACT_PROFILE_FILTER_OPS.has(operation);
    for (const part of String(valueRaw).split(',')) {
      const value = part.trim();
      if (value === '') continue;
      // A `Profile` name filter targets the real name-keyed `Profile:{name}`
      // node. A `ProfileId` filter's opaque id cannot be resolved to that node
      // here, so it targets an honest `UnresolvedProfile:{id}` stub in a
      // DISTINCT namespace — NEVER a `Profile:{id}` phantom that would
      // masquerade as a real Profile.
      const toId = isId ? `${UNRESOLVED_PROFILE_PREFIX}${value}` : `Profile:${value}`;
      if (seen.has(toId)) continue;
      seen.add(toId);
      refs.push({
        toId,
        profileValue: value,
        operation,
        idBased: isId,
        // A name under an exact op resolves to the `Profile:{name}` node
        // (declared); an id, or a substring op, is a best-effort stub.
        confidence: !isId && exact ? 'declared' : 'heuristic',
      });
    }
  }
  return refs;
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
 * 3. One `references` edge per Profile named in the `<duplicateRuleFilter>`
 *    (`Profile:{name}` for a `Profile` filter — `declared` for exact ops,
 *    `referenceKind: 'duplicateFilterProfile'`; an honest
 *    `UnresolvedProfile:{id}` stub for a `ProfileId` filter — `heuristic`,
 *    `referenceKind: 'duplicateRuleProfileUnresolved'`, NEVER a `Profile:{id}`
 *    node that would masquerade as a real Profile — the
 *    RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE sibling) —
 *    DUPLICATE-RULE-FILTER-PROFILE-UNGRAPHED. Multi-value `equals`/`notEqual`
 *    filters split their comma-separated `<value>` into one edge each. The
 *    edge carries `operation` (so a `notEqual` EXCLUSION is distinguishable),
 *    and the names/ids mirror onto `properties.filterProfiles`. A `ProfileId`
 *    stub is rewritten to a real `Profile:{apiName}` edge downstream by
 *    `resolveRestrictionRuleProfileEdges` when an Id->apiName index resolves it.
 *    The opaque `filterExpression` string is still emitted for backward
 *    compatibility.
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
  // DUPLICATE-RULE-FILTER-PROFILE-UNGRAPHED: Profiles the filter scopes
  // matching by. Emitted as `references` edges (below) and mirrored onto
  // `properties.filterProfiles` (scalar array — depth-4 render-safe).
  const filterProfileRefs = extractFilterProfileRefs(rootObj);

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
      ...(filterProfileRefs.length > 0
        ? { filterProfiles: filterProfileRefs.map((r) => r.profileValue) }
        : {}),
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

  // DUPLICATE-RULE-FILTER-PROFILE-UNGRAPHED: one `references` edge per Profile
  // named in the `<duplicateRuleFilter>`. Emitted AFTER the matcher edges so
  // existing consumers that index the matcher references by position are
  // unaffected. `operation` is carried so a consumer can tell an EXCLUSION
  // (`notEqual` — the profile bypasses matching) from an inclusion.
  //
  // A `ProfileId` filter targets an honest `UnresolvedProfile:{id}` stub
  // (`referenceKind: 'duplicateRuleProfileUnresolved'`) — NEVER a `Profile:{id}`
  // node that masquerades as a real Profile (RESTRICTION-RULE-OMITS-PROFILE-
  // USERCRITERIA-EDGE sibling). The downstream `resolveRestrictionRuleProfileEdges`
  // refresh pass rewrites the stub to a real `Profile:{apiName}` edge when an Id
  // index resolves it; unresolved ids stay explicit stubs.
  for (const ref of filterProfileRefs) {
    edges.push({
      fromId: ruleId,
      toId: ref.toId,
      edgeType: 'references',
      confidence: ref.confidence,
      source: EXTRACTOR_SOURCE,
      properties: ref.idBased
        ? {
            referenceKind: 'duplicateRuleProfileUnresolved',
            filterField: 'ProfileId',
            operation: ref.operation,
            unresolvedProfileId: ref.profileValue,
            idBasedTarget: true,
          }
        : {
            referenceKind: 'duplicateFilterProfile',
            filterField: 'Profile',
            operation: ref.operation,
          },
    });
  }

  return ok({ nodes: [node], edges });
};
