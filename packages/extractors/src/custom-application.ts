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

const APPLICATION_FILE_SUFFIX = '.app-meta.xml';
const ROOT_ELEMENT = 'CustomApplication';
const EXTRACTOR_SOURCE = 'custom-application-extractor';
const REQUIRED_ELEMENTS = ['label'] as const;
// `Classic` is not a Salesforce navType value — it is the internal marker for a
// classic-style app whose .app-meta.xml omits <navType> entirely (only
// Lightning apps declare Standard/Console). Synthesizing it lets classic apps
// extract instead of failing as malformed, without mislabelling them Standard.
const ALLOWED_NAV_TYPE = ['Standard', 'Console', 'Classic'] as const;

type NavType = (typeof ALLOWED_NAV_TYPE)[number];

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Single-occurrence CustomApplication elements
 * (`<label>`, `<navType>`, etc.) use this helper.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise. Used for `<tabs>` which may appear
 * zero, one, or many times.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined ? null : String(raw);
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
 * Locate the `<CustomApplication>` root and verify the required `<label>`
 * child. A missing `<navType>` is defaulted (standard apps → `Standard`,
 * classic apps → `Classic`) rather than required; its enum check happens
 * after this, once the value is in hand.
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
  // Standard apps (`standard__` prefix, e.g. standard__AppLauncher) carry a
  // system-defined label + navType that Salesforce OMITS from retrieved metadata
  // — the .app-meta.xml is just nav config + tabs. Requiring them errored on
  // every standard app (10 on a real govt-org refresh). Synthesize sensible
  // defaults so they still extract; CUSTOM apps must still declare them.
  const apiName = deriveComponentApiName(path, APPLICATION_FILE_SUFFIX);
  if (apiName.startsWith('standard__')) {
    if (rootObj['label'] === undefined) rootObj['label'] = apiName;
    if (rootObj['navType'] === undefined) rootObj['navType'] = 'Standard';
  }
  // A classic app omits <navType> (only Lightning apps declare it). Default it
  // to the `Classic` marker rather than failing extraction — a missing navType
  // is a classic-style app, not malformed metadata. Custom Lightning apps still
  // carry their real Standard/Console value, validated by the enum check below.
  if (rootObj['navType'] === undefined) rootObj['navType'] = 'Classic';
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
 * Extract a Node and edges from a single Salesforce `*.app-meta.xml`
 * file.
 *
 * Reads the file, parses it as XML, validates the `<CustomApplication>`
 * root per the vendored `CustomApplication.md` spec, and returns an
 * `ExtractionResult` containing one `Node` of type `'CustomApplication'`
 * and one `belongsToApp` edge per `<tabs>` entry — in document order,
 * each carrying its 0-based `ordinal` so consumers can reconstruct the
 * app's navigation bar order. Tabs are **not** deduplicated; the same
 * tab appearing twice produces two edges with distinct ordinals.
 *
 * The `toId` of each edge is `CustomTab:{TabName}` verbatim. Standard
 * tabs (`standard-Account`, etc.) and tabs whose `.tab-meta.xml` was not
 * extracted are dangling-by-design — the CustomTab node may or may not
 * exist.
 *
 * The canonical ID is `CustomApplication:{AppName}` where `{AppName}`
 * derives from the filename, not from any XML element.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<label>`, or an explicit `<navType>` outside
 * `{Standard, Console, Classic}`). A missing `<navType>` is synthesized
 * (`Standard` for `standard__` apps, `Classic` otherwise), not an error.
 *
 * @example
 *   const result = await extractCustomApplication(
 *     'force-app/main/default/applications/StudentService.app-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'CustomApplication:StudentService'
 *   }
 */
export const extractCustomApplication = async (
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

  // `<navType>` value must be in `{Standard, Console, Classic}` — `Classic`
  // is the synthesized marker for an app that omits <navType> (validateRoot
  // defaults it). A value outside the set is an explicit error case.
  const navTypeValue = String(unwrapSingle(rootObj['navType']));
  if (!ALLOWED_NAV_TYPE.includes(navTypeValue as NavType)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid navType: ${navTypeValue}`,
    });
  }

  const apiName = deriveComponentApiName(path, APPLICATION_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;
  const label = String(unwrapSingle(rootObj['label']));

  const tabs = toArray(rootObj['tabs']);
  const utilityBar = optionalString(rootObj, 'utilityBar');

  const node: Node = {
    id: nodeId,
    type: 'CustomApplication',
    apiName,
    label,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      label,
      navType: navTypeValue,
      description: optionalString(rootObj, 'description'),
      formFactors: optionalString(rootObj, 'formFactors'),
      defaultLandingTab: optionalString(rootObj, 'defaultLandingTab'),
      utilityBar,
      tabCount: tabs.length,
    },
  };

  // Per CustomApplication.md: one `belongsToApp` edge per `<tabs>`
  // entry, in document order, each carrying its 0-based ordinal. Tabs
  // are not deduplicated — the doc explicitly permits duplicates and
  // emits one edge per occurrence with distinct ordinals.
  const edges: Edge[] = tabs.map((tab, index) => ({
    fromId: `CustomTab:${String(tab)}`,
    toId: nodeId,
    edgeType: 'belongsToApp' as const,
    confidence: 'declared' as const,
    source: EXTRACTOR_SOURCE,
    properties: { ordinal: index },
  }));

  return ok({ nodes: [node], edges });
};
