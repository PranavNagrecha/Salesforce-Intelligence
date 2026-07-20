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

const LETTERHEAD_FILE_SUFFIX = '.letter-meta.xml';
const ROOT_ELEMENT = 'Letterhead';
const EXTRACTOR_SOURCE = 'letterhead-extractor';
const REQUIRED_ELEMENTS = ['name', 'available', 'bodyColor'] as const;

/**
 * LETTERHEAD-LOGO-UNGRAPHED — a Letterhead `<header><logo>` / `<footer><logo>`
 * references a classic Salesforce Document (the letterhead's brand image),
 * declared as a folder path `Folder/DocumentName.ext` (or a bare name).
 * Convert it to the `Document:{Folder.Name}` id — mirroring the folder→id
 * `slash → dot` convention the EmailTemplate id uses — so the reference is a
 * graph target rather than an opaque string. Documents are not extracted into
 * the vault, so the target is dangling-by-design (a phantom classified
 * `unknown` / `managed-extension`), exactly like the `User:{ref}` /
 * `Territory:{ref}` dangling targets other extractors emit.
 */
const logoRefToDocumentId = (logoRef: string): string =>
  `Document:${logoRef.includes('/') ? logoRef.replace(/\//g, '.') : logoRef}`;

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Every Letterhead element the extractor
 * reads is single-occurrence; this helper tolerates either shape.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

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

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined ? null : String(raw);
};

/**
 * Read a `<color>` (or other named scalar) from a structured XML
 * sub-object like `<topLine>` or `<header>`. Returns null when the
 * sub-object is absent, not an object, or doesn't contain the named key.
 */
const readStructuredScalar = (
  rootObj: Record<string, unknown>,
  sectionKey: string,
  scalarKey: string,
): string | null => {
  const section = unwrapSingle(rootObj[sectionKey]);
  if (typeof section !== 'object' || section === null) return null;
  const raw = unwrapSingle((section as Record<string, unknown>)[scalarKey]);
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

/** Locate the `<Letterhead>` root and verify required children per `Letterhead.md`. */
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
 * Extract a Node from a single Salesforce `*.letter-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<Letterhead>` root
 * per the vendored `Letterhead.md` spec, and returns an
 * `ExtractionResult` containing one `Node` of type `'Letterhead'` plus,
 * when a logo is declared, an outgoing `references` edge per logo.
 *
 * LETTERHEAD-LOGO-UNGRAPHED: a `<header><logo>` / `<footer><logo>` names the
 * classic Document holding the letterhead's brand image. It emits a declared
 * `references` edge `Letterhead:{name}` -> `Document:{Folder.Name}`
 * (`properties.via` = `header.logo` / `footer.logo`) so a Document referenced
 * only as a letterhead logo counts as usage in find_component_usages /
 * get_edges instead of reading as orphaned and delete-safe. A letterhead with
 * no logo stays a leaf (zero edges). Inbound `references` edges from
 * EmailTemplate are produced by the EmailTemplate extractor — see
 * `EmailTemplate.md` §"Edges".
 *
 * The canonical ID is `Letterhead:{LetterheadName}` where
 * `LetterheadName` is the filename minus `.letter-meta.xml`.
 *
 * The structured `<topLine>`, `<bottomLine>`, `<header>`, `<footer>`,
 * and `<body>` sub-objects (when present) override the corresponding
 * flat color properties (`topLineColor`, `bottomLineColor`,
 * `headerColor`, `footerColor`, `middleColor`). The extractor surfaces
 * the override values under the flat property names so consumers see a
 * uniform color map regardless of which encoding the source uses.
 *
 * The `<topLineColor>` requirement is satisfied by EITHER the flat
 * `<topLineColor>` element OR the structured `<topLine><color>`
 * override — having neither raises a `malformed-input` error.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root or
 * missing required element).
 *
 * @example
 *   const result = await extractLetterhead(
 *     'force-app/main/default/letterhead/Acme_Corporate.letter-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'Letterhead:Acme_Corporate'
 *   }
 */
export const extractLetterhead = async (
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

  // Per Letterhead.md: `topLineColor` is required, satisfied by either
  // the flat element OR the structured `<topLine><color>` override.
  const flatTopLineColor = optionalString(rootObj, 'topLineColor');
  const structuredTopLineColor = readStructuredScalar(rootObj, 'topLine', 'color');
  const topLineColor = structuredTopLineColor ?? flatTopLineColor;
  if (topLineColor === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <topLineColor>',
    });
  }

  // The other optional structured overrides; structured value wins.
  const bottomLineColor =
    readStructuredScalar(rootObj, 'bottomLine', 'color') ??
    optionalString(rootObj, 'bottomLineColor');
  const headerColor =
    readStructuredScalar(rootObj, 'header', 'backgroundColor') ??
    optionalString(rootObj, 'headerColor');
  const footerColor =
    readStructuredScalar(rootObj, 'footer', 'backgroundColor') ??
    optionalString(rootObj, 'footerColor');
  const middleColor =
    readStructuredScalar(rootObj, 'body', 'backgroundColor') ??
    optionalString(rootObj, 'middleColor');

  const headerLogoRef = readStructuredScalar(rootObj, 'header', 'logo');
  const footerLogoRef = readStructuredScalar(rootObj, 'footer', 'logo');

  const apiName = deriveComponentApiName(path, LETTERHEAD_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;

  // LETTERHEAD-LOGO-UNGRAPHED: emit the declared Letterhead -> Document usage
  // edge per logo ref. Empty refs are skipped; identical header/footer refs are
  // deduped so a single-Document logo isn't double-counted.
  const edges: Edge[] = [];
  const seenLogoTargets = new Set<string>();
  for (const [logoRef, via] of [
    [headerLogoRef, 'header.logo'],
    [footerLogoRef, 'footer.logo'],
  ] as const) {
    if (logoRef === null || logoRef === '') continue;
    const toId = logoRefToDocumentId(logoRef);
    if (seenLogoTargets.has(toId)) continue;
    seenLogoTargets.add(toId);
    edges.push({
      fromId: nodeId,
      toId,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { via },
    });
  }

  const node: Node = {
    id: nodeId,
    type: 'Letterhead',
    apiName,
    label: String(unwrapSingle(rootObj['name'])),
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      available: coerceBoolean(unwrapSingle(rootObj['available'])),
      description: optionalString(rootObj, 'description'),
      topLineColor,
      bottomLineColor,
      headerColor,
      footerColor,
      middleColor,
      bodyColor: String(unwrapSingle(rootObj['bodyColor'])),
      headerLogoRef,
      footerLogoRef,
    },
  };

  return ok({ nodes: [node], edges });
};
