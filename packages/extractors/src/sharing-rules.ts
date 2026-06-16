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

const SHARING_RULES_FILE_SUFFIX = '.sharingRules-meta.xml';
const ROOT_ELEMENT = 'SharingRules';
const EXTRACTOR_SOURCE = 'sharing-rule-extractor';
const ALLOWED_ACCESS_LEVELS = ['Read', 'Edit'] as const;

type AccessLevel = (typeof ALLOWED_ACCESS_LEVELS)[number];

/**
 * Variant table for `<sharedTo>` and `<sharedFrom>` per `Sharing.md`. The
 * key is the XML child element name; the value derives the edge `toId`
 * from the inner text (or supplies a synthetic id when the variant is
 * self-closing) and any extra edge properties to merge.
 *
 * `idPrefix` and `synthetic` are the only inputs needed to construct an
 * edge — keeping them in a table beats an eight-branch dispatcher.
 */
export interface VariantSpec {
  readonly idPrefix: 'Group' | 'Role';
  readonly extraProps: Readonly<Record<string, unknown>>;
  /**
   * For self-closing variants (e.g., `<allInternalUsers/>`), the id-tail
   * is a fixed synthetic name. For named variants, the id-tail is the
   * element's inner text.
   */
  readonly syntheticName: string | null;
}

/**
 * The `<sharedTo>` variant table is exported so the ListView `<sharedTo>`
 * reader (`enterprise-metadata.ts`) constructs `visibleTo` edge targets with
 * the SAME element→id logic sharing rules use for `sharedWith` — one source of
 * truth keeps the two surfaces from drifting (e.g. the `roleAndSubordinates`
 * inheritance marker must mean the same thing in both).
 */
export const VARIANT_TABLE: Readonly<Record<string, VariantSpec>> = {
  group: { idPrefix: 'Group', extraProps: {}, syntheticName: null },
  role: { idPrefix: 'Role', extraProps: {}, syntheticName: null },
  portalRole: {
    idPrefix: 'Role',
    extraProps: { portal: true },
    syntheticName: null,
  },
  roleAndSubordinates: {
    idPrefix: 'Role',
    extraProps: { inheritance: 'subordinates' },
    syntheticName: null,
  },
  roleAndSubordinatesInternal: {
    idPrefix: 'Role',
    extraProps: { inheritance: 'subordinatesInternal' },
    syntheticName: null,
  },
  allInternalUsers: {
    idPrefix: 'Group',
    extraProps: { synthetic: true },
    syntheticName: 'AllInternalUsers',
  },
  allCustomerPortalUsers: {
    idPrefix: 'Group',
    extraProps: { synthetic: true },
    syntheticName: 'AllCustomerPortalUsers',
  },
  partnerUsers: {
    idPrefix: 'Group',
    extraProps: { synthetic: true },
    syntheticName: 'PartnerUsers',
  },
  // The real Salesforce `<sharedTo>` element for "All Partner Users" is
  // `allPartnerUsers` (mirroring `allCustomerPortalUsers`); without it, every
  // Experience-Cloud / partner-community sharing rule was rejected as malformed
  // and its whole file dropped — found via a real-org grounded refresh.
  allPartnerUsers: {
    idPrefix: 'Group',
    extraProps: { synthetic: true },
    syntheticName: 'AllPartnerUsers',
  },
  guestUser: {
    idPrefix: 'Group',
    extraProps: { synthetic: true },
    syntheticName: 'GuestUser',
  },
};
export const VARIANT_KEYS = new Set(Object.keys(VARIANT_TABLE));

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Required-once elements (`fullName`,
 * `accessLevel`, `sharedTo`) use this; repeating elements
 * (`sharingCriteriaRules`, `criteriaItems`) use `toArray` instead.
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
 * Locate and validate the `<SharingRules>` root in a parsed XML tree.
 *
 * Per `Sharing.md`, a file with a `<SharingRules>` root but zero child
 * rules is a documented happy path (not an error). fast-xml-parser
 * represents `<SharingRules/>` and `<SharingRules></SharingRules>` as an
 * empty string rather than an empty object; both shapes count as a
 * valid empty root and yield zero nodes/edges. A missing `<SharingRules>`
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
  // `<SharingRules/>` / `<SharingRules></SharingRules>` — empty but valid.
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
 * The resolved form of a `<sharedTo>` or `<sharedFrom>` element: the
 * variant's element key (e.g., `'group'`), its inner text (or null for
 * self-closing variants), the canonical edge target id, and any
 * properties the edge should carry beyond `confidence` and `source`.
 */
interface ResolvedTarget {
  readonly variantKey: string;
  readonly variantName: string | null;
  readonly toId: string;
  readonly extraProps: Readonly<Record<string, unknown>>;
}

/**
 * Resolve a `<sharedTo>` or `<sharedFrom>` element to its edge target id
 * and extra edge-property additions. Returns the variant's element key
 * (e.g., `'group'`, `'roleAndSubordinates'`) so the caller can populate
 * `sharedToType`/`sharedFromType`.
 *
 * Per `Sharing.md`, exactly one variant child is required. Zero or more
 * than one is `malformed-input`.
 */
const resolveSharedTarget = (
  container: Record<string, unknown>,
  elementName: 'sharedTo' | 'sharedFrom',
  path: string,
): Result<ResolvedTarget, ExtractorError> => {
  const presentVariants = Object.keys(container).filter((k) =>
    VARIANT_KEYS.has(k),
  );
  if (presentVariants.length !== 1) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected exactly one <${elementName}> variant, found ${presentVariants.length}`,
    });
  }
  const variantKey = presentVariants[0]!;
  const spec = VARIANT_TABLE[variantKey]!;
  if (spec.syntheticName !== null) {
    return ok({
      variantKey,
      variantName: null,
      toId: `${spec.idPrefix}:${spec.syntheticName}`,
      extraProps: spec.extraProps,
    });
  }
  const innerRaw = unwrapSingle(container[variantKey]);
  if (innerRaw === undefined || innerRaw === null || innerRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: `<${elementName}><${variantKey}> is empty`,
    });
  }
  const innerText = String(innerRaw);
  return ok({
    variantKey,
    variantName: innerText,
    toId: `${spec.idPrefix}:${innerText}`,
    extraProps: spec.extraProps,
  });
};

/**
 * Validate that a per-rule child object carries the required scalars
 * (`fullName`, `accessLevel`) and target containers, and return them as
 * a typed bundle. Field order matches the error-cases table in
 * `Sharing.md`.
 */
const validateRuleRequired = (
  rule: Record<string, unknown>,
  path: string,
  needsSharedFrom: boolean,
): Result<
  {
    readonly fullName: string;
    readonly accessLevel: AccessLevel;
    readonly sharedTo: Record<string, unknown>;
    readonly sharedFrom: Record<string, unknown> | null;
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
  const accessLevelRaw = unwrapSingle(rule['accessLevel']);
  if (
    accessLevelRaw === undefined ||
    accessLevelRaw === null ||
    accessLevelRaw === ''
  ) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <accessLevel>',
    });
  }
  const accessLevelValue = String(accessLevelRaw);
  if (!ALLOWED_ACCESS_LEVELS.includes(accessLevelValue as AccessLevel)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid accessLevel: ${accessLevelValue}`,
    });
  }
  const sharedToRaw = unwrapSingle(rule['sharedTo']);
  if (typeof sharedToRaw !== 'object' || sharedToRaw === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <sharedTo>',
    });
  }
  let sharedFromObj: Record<string, unknown> | null = null;
  if (needsSharedFrom) {
    const sharedFromRaw = unwrapSingle(rule['sharedFrom']);
    if (typeof sharedFromRaw !== 'object' || sharedFromRaw === null) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <sharedFrom>',
      });
    }
    sharedFromObj = sharedFromRaw as Record<string, unknown>;
  }
  return ok({
    fullName: String(fullNameRaw),
    accessLevel: accessLevelValue as AccessLevel,
    sharedTo: sharedToRaw as Record<string, unknown>,
    sharedFrom: sharedFromObj,
  });
};

/**
 * Convert a single rule into its Node + Edges. `ruleType` selects which
 * branch of the property schema applies; `Sharing.md` defines criteria
 * rules as carrying `booleanFilter` + `criteriaItemCount` and owner
 * rules as carrying `sharedFromType` + `sharedFromName`.
 */
const buildRule = (
  rule: Record<string, unknown>,
  ruleType: 'criteria' | 'owner',
  objectApiName: string,
  parentId: string,
  path: string,
): Result<{ readonly node: Node; readonly edges: readonly Edge[] }, ExtractorError> => {
  const required = validateRuleRequired(rule, path, ruleType === 'owner');
  if (!required.ok) return required;
  const { fullName, accessLevel, sharedTo, sharedFrom } = required.value;

  const sharedToResult = resolveSharedTarget(sharedTo, 'sharedTo', path);
  if (!sharedToResult.ok) return sharedToResult;

  // `sharedFrom` is non-null exactly when `ruleType === 'owner'`, per
  // `validateRuleRequired`. Resolve it for owner rules only.
  let sharedFromResolved: ResolvedTarget | null = null;
  if (sharedFrom !== null) {
    const fromResult = resolveSharedTarget(sharedFrom, 'sharedFrom', path);
    if (!fromResult.ok) return fromResult;
    sharedFromResolved = fromResult.value;
  }

  const ruleId = `SharingRule:${objectApiName}.${fullName}`;
  const labelRaw = unwrapSingle(rule['label']);
  const label = labelRaw === undefined ? null : String(labelRaw);

  const booleanFilterRaw =
    ruleType === 'criteria' ? unwrapSingle(rule['booleanFilter']) : undefined;
  const booleanFilter =
    booleanFilterRaw === undefined || booleanFilterRaw === null
      ? null
      : String(booleanFilterRaw);
  const criteriaItemCount =
    ruleType === 'criteria' ? toArray(rule['criteriaItems']).length : 0;

  const node: Node = {
    id: ruleId,
    type: 'SharingRule',
    apiName: `${objectApiName}.${fullName}`,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      ruleType,
      accessLevel,
      sharedToType: sharedToResult.value.variantKey,
      sharedToName: sharedToResult.value.variantName,
      sharedFromType: sharedFromResolved?.variantKey ?? null,
      sharedFromName: sharedFromResolved?.variantName ?? null,
      booleanFilter,
      criteriaItemCount,
    },
  };

  const parentEdge: Edge = {
    fromId: parentId,
    toId: ruleId,
    edgeType: 'parentOf',
    confidence: 'declared',
    source: EXTRACTOR_SOURCE,
    properties: {},
  };

  // For owner rules, sharedTo and sharedFrom both emit `sharedWith` edges;
  // `direction` distinguishes them. Criteria rules emit only the sharedTo
  // edge and do NOT set `direction` (per Sharing.md edge spec).
  const sharedToEdgeProps: Readonly<Record<string, unknown>> =
    ruleType === 'owner'
      ? { ...sharedToResult.value.extraProps, direction: 'to' }
      : sharedToResult.value.extraProps;
  const sharedToEdge: Edge = {
    fromId: ruleId,
    toId: sharedToResult.value.toId,
    edgeType: 'sharedWith',
    confidence: 'declared',
    source: EXTRACTOR_SOURCE,
    properties: sharedToEdgeProps,
  };

  const edges: Edge[] = [parentEdge, sharedToEdge];
  if (sharedFromResolved !== null) {
    edges.push({
      fromId: ruleId,
      toId: sharedFromResolved.toId,
      edgeType: 'sharedWith',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { ...sharedFromResolved.extraProps, direction: 'from' },
    });
  }
  return ok({ node, edges });
};

/**
 * Extract Nodes and Edges from a single Salesforce
 * `*.sharingRules-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<SharingRules>` root
 * per the vendored `Sharing.md` spec, and returns an `ExtractionResult`
 * containing one `'SharingRule'` Node per `<sharingCriteriaRules>` /
 * `<sharingOwnerRules>` child. The root file itself produces no Node;
 * only the individual rules do.
 *
 * For each rule the extractor emits a `parentOf` edge from
 * `CustomObject:{ObjectApiName}` to the rule, plus one `sharedWith` edge
 * to the resolved `<sharedTo>` target. Owner rules additionally emit a
 * `sharedWith` edge to the resolved `<sharedFrom>` target with
 * `properties.direction = 'from'` (and the `sharedTo` edge carries
 * `direction: 'to'`); criteria rules emit only the `sharedTo` edge and
 * do NOT set `direction`. Variant resolution follows the
 * `<sharedTo>`/`<sharedFrom>` table in `Sharing.md` — synthetic group
 * ids (`Group:AllInternalUsers`, etc.) carry `synthetic: true` in their
 * edge properties and are dangling-by-design in v1.1.
 *
 * `<sharingGuestRules>` and `<sharingTerritoryRules>` are skipped
 * without emitting nodes or edges — v1.1 does not model their context.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<fullName>` / `<accessLevel>` / `<sharedTo>` / `<sharedFrom>`,
 * invalid `accessLevel`, or a `<sharedTo>`/`<sharedFrom>` container
 * without exactly one variant child).
 *
 * @example
 *   const result = await extractSharingRules(
 *     'tests/fixtures/synthetic-v1.1/sharingRules/Account.sharingRules-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'SharingRule:Account.Share_Tech_Accounts_With_Sales'
 *   }
 */
export const extractSharingRules = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale sharing-rules XML.
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

  const objectApiName = deriveComponentApiName(path, SHARING_RULES_FILE_SUFFIX);
  const parentId = `CustomObject:${objectApiName}`;

  const criteriaRules = toArray(rootObj['sharingCriteriaRules']).filter(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
  );
  const ownerRules = toArray(rootObj['sharingOwnerRules']).filter(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
  );

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const rule of criteriaRules) {
    const built = buildRule(rule, 'criteria', objectApiName, parentId, path);
    if (!built.ok) return built;
    nodes.push(built.value.node);
    edges.push(...built.value.edges);
  }
  for (const rule of ownerRules) {
    const built = buildRule(rule, 'owner', objectApiName, parentId, path);
    if (!built.ok) return built;
    nodes.push(built.value.node);
    edges.push(...built.value.edges);
  }

  return ok({ nodes, edges });
};
