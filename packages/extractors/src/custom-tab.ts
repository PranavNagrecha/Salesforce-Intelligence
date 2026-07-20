import { readFile } from 'node:fs/promises';

import type {
  ComponentType,
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { deriveComponentApiName } from './path-utils.js';

const TAB_FILE_SUFFIX = '.tab-meta.xml';
const ROOT_ELEMENT = 'CustomTab';
const EXTRACTOR_SOURCE = 'custom-tab-extractor';
const REQUIRED_ELEMENTS = ['motif', 'label'] as const;

/**
 * The six tab variants documented in `CustomTab.md`. Each maps to exactly
 * one target-variant XML element; the variant determines `tabType` and
 * `targetName` in the emitted node's properties.
 */
const TAB_VARIANTS = [
  { element: 'customObject', tabType: 'object' as const },
  { element: 'lwcComponent', tabType: 'lwc' as const },
  { element: 'auraComponent', tabType: 'aura' as const },
  { element: 'flexiPage', tabType: 'flexiPage' as const },
  { element: 'page', tabType: 'page' as const },
  { element: 'url', tabType: 'url' as const },
] as const;

type TabType = (typeof TAB_VARIANTS)[number]['tabType'];

/**
 * CUSTOM-TAB-TARGET-UNGRAPHED: the destination ComponentType a tab's
 * `targetName` resolves to, keyed by `tabType`. A page/flexiPage/lwc/aura tab
 * opens a specific in-org UI component; the extractor must emit a
 * `CustomTab -> {target}` `references` edge so that component is not read as
 * unused (`unused_components` treats a no-inbound-edge VF/Lightning page as
 * deletable) and "what does this tab open?" can hop tab -> page on the graph.
 *
 * `object` and `url` map to `null`: an object-variant tab already carries its
 * object relationship through the `parentOf` edge (and its name-matches-object
 * convention), and a `url` (web) tab has no in-org destination component. Both
 * carry `targetName: null` from {@link detectVariant} anyway.
 */
const TAB_TARGET_TYPE: Readonly<Record<TabType, ComponentType | null>> = {
  page: 'VisualforcePage',
  flexiPage: 'FlexiPage',
  lwc: 'LightningComponentBundle',
  aura: 'AuraDefinitionBundle',
  object: null,
  url: null,
};

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. CustomTab elements the extractor reads are all
 * single-occurrence; this helper tolerates either shape.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined ? null : String(raw);
};

/**
 * Parse a `<frameHeight>` element to an integer or `null`. Salesforce
 * serializes the element as a numeric string; non-integer or non-numeric
 * values collapse to `null` rather than aborting the extraction.
 */
const optionalInteger = (rootObj: Record<string, unknown>, key: string): number | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined || raw === null) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? Math.trunc(num) : null;
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
 * Locate the `<CustomTab>` root and verify required children per
 * `CustomTab.md`. Variant detection (and the exactly-one-of constraint on
 * the six target elements) happens in a later step.
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
  // A custom-object tab (<customObject>true</customObject>) INHERITS its label
  // from the parent object, so Salesforce omits <label> from the tab's XML.
  // Requiring it errored on every custom-object tab (11 on a real govt-org
  // refresh). Synthesize label=apiName for such tabs; other tab variants
  // (Visualforce / Web / LWC) must still declare <label>.
  const isObjectTab =
    String(unwrapSingle(rootObj['customObject']) ?? '') === 'true';
  if (isObjectTab && rootObj['label'] === undefined) {
    rootObj['label'] = deriveComponentApiName(path, TAB_FILE_SUFFIX);
  }
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
 * Detect which of the six target-variant elements is present in the
 * `<CustomTab>` body. Exactly one of `<customObject>`, `<lwcComponent>`,
 * `<auraComponent>`, `<flexiPage>`, `<page>`, or `<url>` must be present;
 * zero or more than one is a `malformed-input` error per `CustomTab.md`.
 */
const detectVariant = (
  rootObj: Record<string, unknown>,
  path: string,
): Result<{ tabType: TabType; targetName: string | null }, ExtractorError> => {
  const present = TAB_VARIANTS.filter((v) => rootObj[v.element] !== undefined);
  if (present.length === 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'expected exactly one target variant, found 0',
    });
  }
  if (present.length > 1) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected exactly one target variant, found ${present.length}`,
    });
  }
  // Non-null assertion is safe: filter guaranteed exactly one entry.
  const variant = present[0]!;
  // Per CustomTab.md: `<customObject>` must carry the literal value `'true'`.
  // Any other value is a `malformed-input` error.
  if (variant.tabType === 'object') {
    const customObjectValue = String(unwrapSingle(rootObj[variant.element]));
    if (customObjectValue !== 'true') {
      return err({
        kind: 'malformed-input',
        path,
        message: `invalid customObject value: ${customObjectValue}`,
      });
    }
    return ok({ tabType: 'object', targetName: null });
  }
  // Per CustomTab.md table: `<url>` tabs do not surface `targetName`.
  if (variant.tabType === 'url') {
    return ok({ tabType: 'url', targetName: null });
  }
  const targetName = String(unwrapSingle(rootObj[variant.element]));
  return ok({ tabType: variant.tabType, targetName });
};

/**
 * Extract a Node and (at most one) edge from a single Salesforce
 * `*.tab-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<CustomTab>` root per
 * the vendored `CustomTab.md` spec, and returns an `ExtractionResult`
 * containing one `Node` of type `'CustomTab'` and its incident edges:
 * - at most one `parentOf` edge (CustomObject -> CustomTab), emitted only
 *   for object-variant tabs whose API name ends in `__c` (the heuristic for
 *   "the underlying CustomObject is a custom object the org actually owns,
 *   not a standard object the platform provides"); and
 * - one `references` edge (CustomTab -> target) for a page / flexiPage / lwc
 *   / aura variant, pointing at the `VisualforcePage` / `FlexiPage` /
 *   `LightningComponentBundle` / `AuraDefinitionBundle` its `targetName`
 *   opens (CUSTOM-TAB-TARGET-UNGRAPHED — without it a tabbed page read as
 *   unused). `url` (web) tabs carry no in-org destination, so no target edge.
 *
 * The `belongsToApp` edge is **not** emitted by this extractor; the
 * CustomApplication extractor owns that direction per `CustomApplication.md`.
 *
 * The canonical ID is `CustomTab:{TabName}` where `{TabName}` derives
 * from the filename, not from any XML element. For object-variant tabs,
 * the `parentId` is `CustomObject:{TabName}` because Salesforce requires
 * the tab's API name to match the underlying object's API name. For all
 * other variants, `parentId` is `null`.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<motif>` / `<label>`, zero or multiple target-variant
 * elements, or `<customObject>` with a value other than `'true'`).
 *
 * @example
 *   const result = await extractCustomTab(
 *     'force-app/main/default/tabs/StudentEnrollment.tab-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'CustomTab:StudentEnrollment'
 *   }
 */
export const extractCustomTab = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale Profile/PermissionSet/Layout XML.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's default entity-expansion
  // cap). Catch it here so a single pathological file becomes a
  // per-file `parse-error` rather than aborting the refresh pipeline.
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

  const variantResult = detectVariant(rootObj, path);
  if (!variantResult.ok) return variantResult;
  const { tabType, targetName } = variantResult.value;

  const apiName = deriveComponentApiName(path, TAB_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;
  const motif = String(unwrapSingle(rootObj['motif']));
  const label = String(unwrapSingle(rootObj['label']));

  const parentId = tabType === 'object' ? `CustomObject:${apiName}` : null;

  const node: Node = {
    id: nodeId,
    type: 'CustomTab',
    apiName,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      motif,
      label,
      tabType,
      targetName,
      description: optionalString(rootObj, 'description'),
      frameHeight: optionalInteger(rootObj, 'frameHeight'),
    },
  };

  const edges: Edge[] = [];

  // Emit a `parentOf` edge from CustomObject -> CustomTab only when the tab is
  // an object variant **and** the TabName ends in `__c` (the heuristic for
  // "real custom object, not a standard one"). Standard-object tabs (e.g., a
  // tab named `Account`) produce no edge — the platform owns those names and
  // emitting a dangling edge from a node the extractor never produces would
  // clutter the graph.
  if (tabType === 'object' && apiName.endsWith('__c')) {
    edges.push({
      fromId: `CustomObject:${apiName}`,
      toId: nodeId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    });
  }

  // CUSTOM-TAB-TARGET-UNGRAPHED: emit a `references` edge from the tab to the
  // UI component its `targetName` opens (a Visualforce page, Lightning page,
  // LWC, or Aura bundle). `targetName` is null for object / url variants (see
  // {@link detectVariant}) and `TAB_TARGET_TYPE` is null for those tabTypes, so
  // this fires only for the four component-target variants. Declared confidence
  // — `<page>` / `<flexiPage>` / `<lwcComponent>` / `<auraComponent>` names the
  // destination directly. The target node may not be in the vault (dangling
  // references are tolerated); a resolvable target is now excluded from
  // `unused_components` because it carries this inbound edge.
  const targetType = TAB_TARGET_TYPE[tabType];
  if (targetType !== null && targetName !== null) {
    edges.push({
      fromId: nodeId,
      toId: `${targetType}:${targetName}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { referenceKind: 'tabTarget', tabType },
    });
  }

  return ok({ nodes: [node], edges });
};
