import { readFile } from 'node:fs/promises';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { scanFrontendSource } from '@sf-intelligence/parsers';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { buildResourceRefEdges, mergeAndSortEdges } from './apex-edges.js';
import { deriveComponentApiName } from './path-utils.js';

const PAGE_FILE_SUFFIX = '.page';
const META_FILE_EXT = '-meta.xml';
const ROOT_ELEMENT = 'ApexPage';
const NODE_TYPE = 'VisualforcePage';
const META_REQUIRED_ELEMENTS = ['apiVersion', 'label'] as const;
const EDGE_SOURCE = 'vf-page-extractor';
const SCANNER_SOURCE = 'vf-scanner';

/**
 * Match the opening `<apex:page ...>` tag (single line or wrapped). The
 * extractor only inspects the first such tag — the v1.4 worker spec calls
 * out that we deliberately do not fully parse the markup XML; the
 * declared controller / extensions attributes always live on the root.
 *
 * The `[^>]*` body lets attribute order vary, accommodates self-closing
 * (`<apex:page ... />`) and open-tag (`<apex:page ...>`) shapes, and
 * tolerates linebreaks inside the tag (`[\\s\\S]*?` would be stricter but
 * VF markup convention keeps the root tag on one line per Salesforce's
 * own docs).
 */
const APEX_PAGE_TAG = /<apex:page\b([^>]*)>/;

/**
 * Match a `name="value"` (or `name='value'`) attribute pair anywhere in
 * a tag body. Anchored on the attribute name's identifier boundary so
 * substring matches inside other attribute values don't yield spurious
 * captures.
 */
const ATTR_PATTERN = (name: string): RegExp =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`);

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. The meta-xml fields the page extractor reads
 * are all single-occurrence; this helper tolerates either shape.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Coerce a string-valued `<availableInTouch>` / `<confirmationTokenRequired>`
 * element to a boolean. The metadata XML stores values as `true` / `false`;
 * any other text falls back to `false` (matching Salesforce's "default to
 * safest value" stance documented elsewhere in the extractors).
 */
const coerceBoolean = (raw: unknown): boolean =>
  String(raw).trim().toLowerCase() === 'true';

/**
 * Read and strictly-validate a file as XML, returning the raw text on
 * success. fast-xml-parser's `parse()` is permissive (silently truncates
 * on mismatched tags), so we validate first to surface malformed input
 * as `parse-error` rather than a misleading partial extraction.
 */
const readAndValidateXml = async (
  path: string,
  missingMessage: string,
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
      return err({ kind: 'file-not-found', path, message: missingMessage });
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

interface PageMeta {
  readonly apiVersion: number;
  readonly label: string;
  readonly availableInTouch: boolean;
  readonly confirmationTokenRequired: boolean;
}

/**
 * Parse the `<ApexPage>` companion metadata XML and return the values
 * required by the v1.4 node. Validates the root element name and the
 * required child elements per the vendored `ApexPage.md` spec.
 */
const parseMetaXml = (
  xmlText: string,
  path: string,
): Result<PageMeta, ExtractorError> => {
  // Local trusted disk content; XXE not a concern. The 10000-expansion
  // cap matches the precedent set by apex-class / apex-trigger.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlText) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const rootObj = root as Record<string, unknown>;
  for (const required of META_REQUIRED_ELEMENTS) {
    if (rootObj[required] === undefined) {
      return err({
        kind: 'malformed-input',
        path,
        message: `missing required element: <${required}>`,
      });
    }
  }
  const apiVersionRaw = String(unwrapSingle(rootObj['apiVersion']));
  const apiVersion = Number(apiVersionRaw);
  if (!Number.isFinite(apiVersion)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid apiVersion: ${apiVersionRaw}`,
    });
  }
  const label = String(unwrapSingle(rootObj['label']));
  const availableInTouch =
    rootObj['availableInTouch'] === undefined
      ? false
      : coerceBoolean(unwrapSingle(rootObj['availableInTouch']));
  const confirmationTokenRequired =
    rootObj['confirmationTokenRequired'] === undefined
      ? false
      : coerceBoolean(unwrapSingle(rootObj['confirmationTokenRequired']));
  return ok({
    apiVersion,
    label,
    availableInTouch,
    confirmationTokenRequired,
  });
};

interface RootAttributes {
  readonly controller: string | null;
  readonly extensions: readonly string[];
}

/**
 * Pull `controller` and `extensions` from the markup's `<apex:page>` root
 * tag via a single regex sweep. Returns `null` controller / empty
 * extensions when either attribute is absent — both are optional per
 * `ApexPage.md` (a page may render from static markup alone).
 *
 * The first `<apex:page ...>` tag occurrence wins. The body of the
 * markup (everything after the opening tag) is then handed to
 * `scanFrontendSource` for `{!...}` expression extraction; the tag
 * itself is *not* re-scanned, so the `controller="X"` attribute can't
 * yield a spurious scanner edge.
 */
const parseRootAttributes = (markup: string): RootAttributes | null => {
  const tagMatch = APEX_PAGE_TAG.exec(markup);
  if (tagMatch === null) return null;
  const tagBody = tagMatch[1] ?? '';

  const controllerMatch = ATTR_PATTERN('controller').exec(tagBody);
  const controllerRaw = controllerMatch?.[1] ?? controllerMatch?.[2] ?? null;
  const controller =
    controllerRaw !== null && controllerRaw.length > 0 ? controllerRaw : null;

  const extensionsMatch = ATTR_PATTERN('extensions').exec(tagBody);
  const extensionsRaw = extensionsMatch?.[1] ?? extensionsMatch?.[2] ?? '';
  const extensions = extensionsRaw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  return { controller, extensions };
};

/**
 * Read a `.page` source file with UTF-8 encoding. Maps `ENOENT` to
 * `file-not-found` per the vendored ApexPage.md spec; other I/O errors
 * become `parse-error` so the caller can surface the underlying cause.
 */
const readPageSource = async (
  path: string,
): Promise<Result<string, ExtractorError>> => {
  try {
    return ok(await readFile(path, 'utf-8'));
  } catch (cause: unknown) {
    const code = (cause as { code?: string } | null | undefined)?.code;
    if (code === 'ENOENT') {
      return err({ kind: 'file-not-found', path, message: 'file not found' });
    }
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
};

/**
 * Project scanner output (`fieldAccesses`, `apexCalls`, `componentRefs`)
 * onto graph edges owned by `ownerId`.
 *
 * Per the v1.4 spec table:
 *   - `fieldAccesses` → `readsFrom` / `writesTo` to `CustomField:{object}.{field}`,
 *     `confidence: 'heuristic'`, `source: 'vf-scanner'`.
 *   - `apexCalls` → `callsApex` to `ApexClass:{className}`,
 *     `confidence: 'heuristic'`, `source: 'vf-scanner'`.
 *   - `componentRefs` → `references` to `VisualforceComponent:{name}` with
 *     `properties: { role: 'composition' }`, `confidence: 'declared'`,
 *     `source: 'vf-scanner'`.
 *
 * Scanner errors (`empty-source`, etc.) surface as a warning string the
 * caller stores on the node — never as a hard failure. A markup-only
 * page that produces no `{!...}` expressions is a valid happy path.
 */
const buildScannerEdges = (
  markup: string,
  ownerId: string,
): {
  readonly edges: readonly Edge[];
  readonly fieldAccessCount: number;
  readonly apexCallCount: number;
  readonly componentRefCount: number;
  readonly warnings: readonly string[];
} => {
  const result = scanFrontendSource(markup, 'vf');
  if (!result.ok) {
    return {
      edges: [],
      fieldAccessCount: 0,
      apexCallCount: 0,
      componentRefCount: 0,
      warnings: [
        `vf-scanner: ${result.error.kind} at offset ${result.error.offset}: ${result.error.message}`,
      ],
    };
  }

  const raw: Edge[] = [];
  for (const access of result.value.fieldAccesses) {
    raw.push({
      fromId: ownerId,
      toId: `CustomField:${access.object}.${access.field}`,
      edgeType: access.type === 'write' ? 'writesTo' : 'readsFrom',
      confidence: 'heuristic',
      source: SCANNER_SOURCE,
      properties: { offset: access.offset, length: access.length },
    });
  }
  for (const call of result.value.apexCalls) {
    raw.push({
      fromId: ownerId,
      toId: `ApexClass:${call.className}`,
      edgeType: 'callsApex',
      confidence: 'heuristic',
      source: SCANNER_SOURCE,
      properties: {
        methodName: call.methodName,
        offset: call.offset,
        length: call.length,
      },
    });
  }
  for (const ref of result.value.componentRefs) {
    raw.push({
      fromId: ownerId,
      toId: `VisualforceComponent:${ref.componentName}`,
      edgeType: 'references',
      confidence: 'declared',
      source: SCANNER_SOURCE,
      properties: {
        role: 'composition',
        offset: ref.offset,
        length: ref.length,
      },
    });
  }
  // $Label.X / $Resource.X / $Setup.X__c value-provider tokens →
  // references edges (heuristic regex tokens; P14-USAGE-label-static-graph).
  raw.push(...buildResourceRefEdges(ownerId, result.value.resourceRefs, SCANNER_SOURCE, 'heuristic'));
  return {
    edges: raw,
    fieldAccessCount: result.value.fieldAccesses.length,
    apexCallCount: result.value.apexCalls.length,
    componentRefCount: result.value.componentRefs.length,
    warnings: [],
  };
};

/**
 * Extract a Node and edges from a single Salesforce Visualforce page.
 * Takes the path to the `.page` markup file (not the meta-xml — per the
 * vendored doc, the `.page` is the canonical `sourcePath`).
 *
 * Reads both the `.page` markup and its companion `.page-meta.xml`,
 * parses the `<apex:page>` opening-tag attributes for declared
 * `controller=` / `extensions=` references, and runs the v1.4 frontend
 * scanner (`'vf'` dialect) over the full markup body for
 * `{!Object.Field}` reads, `{!ClassName.method()}` calls, and
 * `<c:Component>` references.
 *
 * Returns one `Node` of type `'VisualforcePage'` and edges:
 *
 *   - One `references` edge per `controller=` attribute to
 *     `ApexClass:{controllerName}` with `properties: { role: 'controller' }`,
 *     `confidence: 'declared'`.
 *   - One `references` edge per comma-split `extensions=` value to
 *     `ApexClass:{extensionName}` with `properties: { role: 'extension' }`,
 *     `confidence: 'declared'`.
 *   - `readsFrom` edges to `CustomField:{object}.{field}` for each
 *     scanner field access (`confidence: 'heuristic'`).
 *   - `callsApex` edges to `ApexClass:{className}` for each scanner
 *     `{!Class.method()}` invocation (`confidence: 'heuristic'`).
 *   - `references` edges to `VisualforceComponent:{name}` for each
 *     `<c:Component>` tag (`confidence: 'declared'`,
 *     `properties.role: 'composition'`).
 *
 * Edges are deduped + sorted by `(toId asc, edgeType asc)` so the
 * declared-vs-heuristic origin doesn't influence output order — golden
 * tests do deep equality.
 *
 * Scanner errors surface as `node.properties.vfScannerWarnings: string[]`,
 * never as hard failures — a parse glitch in the markup body shouldn't
 * void the entire node. Omitted entirely on the success path so the
 * golden's positive case stays free of an empty-array property
 * (matching `apex-class.ts`'s precedent).
 *
 * Error cases (per vendored `ApexPage.md`):
 *   - `file-not-found` if `.page` is missing (message `file not found`)
 *   - `file-not-found` if `.page-meta.xml` is missing
 *     (message `metadata file missing`)
 *   - `parse-error` if the metadata XML is malformed
 *   - `malformed-input` if the metadata root isn't `<ApexPage>`,
 *     a required element is missing, or `apiVersion` is non-numeric
 *
 * @example
 *   const result = await extractVisualforcePage(
 *     'force-app/main/default/pages/AccountSummary.page',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'VisualforcePage:AccountSummary'
 *   }
 */
export const extractVisualforcePage = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const apiName = deriveComponentApiName(path, PAGE_FILE_SUFFIX);

  const sourceResult = await readPageSource(path);
  if (!sourceResult.ok) return sourceResult;
  const markup = sourceResult.value;

  const metaPath = `${path}${META_FILE_EXT}`;
  const xmlResult = await readAndValidateXml(metaPath, 'metadata file missing');
  if (!xmlResult.ok) return xmlResult;

  const metaResult = parseMetaXml(xmlResult.value, metaPath);
  if (!metaResult.ok) return metaResult;
  const meta = metaResult.value;

  const ownerId = `${NODE_TYPE}:${apiName}`;

  // Pull the `<apex:page controller=... extensions=...>` declared edges
  // from the opening tag. The full markup is then handed to the scanner
  // — the scanner's regex sweeps run over the whole body including the
  // root tag, but the scanner's patterns (`{!...}`, `<c:...>`) cannot
  // match `controller="X"` attribute text, so there's no double-count.
  const headerAttrs = parseRootAttributes(markup);
  const declaredEdges: Edge[] = [];
  if (headerAttrs !== null) {
    if (headerAttrs.controller !== null) {
      declaredEdges.push({
        fromId: ownerId,
        toId: `ApexClass:${headerAttrs.controller}`,
        edgeType: 'references',
        confidence: 'declared',
        source: EDGE_SOURCE,
        properties: { role: 'controller' },
      });
    }
    for (const extName of headerAttrs.extensions) {
      declaredEdges.push({
        fromId: ownerId,
        toId: `ApexClass:${extName}`,
        edgeType: 'references',
        confidence: 'declared',
        source: EDGE_SOURCE,
        properties: { role: 'extension' },
      });
    }
  }

  const scannerOutput = buildScannerEdges(markup, ownerId);

  // mergeAndSortEdges deduplicates by (fromId, toId, edgeType). The
  // declared-vs-heuristic origin doesn't influence ordering — sort is
  // strictly (toId asc, edgeType asc) per the v0.3 apex-edges precedent.
  // First occurrence wins on dedupe; declared edges are pushed first so
  // a declared `references` survives a scanner-emitted duplicate.
  const edges = mergeAndSortEdges([...declaredEdges, ...scannerOutput.edges]);

  const baseProperties = {
    apiVersion: meta.apiVersion,
    label: meta.label,
    availableInTouch: meta.availableInTouch,
    confirmationTokenRequired: meta.confirmationTokenRequired,
    markupBytes: Buffer.byteLength(markup, 'utf-8'),
    componentRefCount: scannerOutput.componentRefCount,
    fieldAccessCount: scannerOutput.fieldAccessCount,
    apexCallCount: scannerOutput.apexCallCount,
  };
  const properties =
    scannerOutput.warnings.length === 0
      ? baseProperties
      : { ...baseProperties, vfScannerWarnings: scannerOutput.warnings };

  const node: Node = {
    id: ownerId,
    type: NODE_TYPE,
    apiName,
    label: meta.label,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: meta.apiVersion,
    properties,
  };

  return ok({ nodes: [node], edges });
};
