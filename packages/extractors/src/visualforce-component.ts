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

const COMPONENT_FILE_SUFFIX = '.component';
const META_FILE_EXT = '-meta.xml';
const ROOT_ELEMENT = 'ApexComponent';
const NODE_TYPE = 'VisualforceComponent';
const META_REQUIRED_ELEMENTS = ['apiVersion', 'label'] as const;
const EDGE_SOURCE = 'vf-component-extractor';
const SCANNER_SOURCE = 'vf-scanner';

/**
 * Match the opening `<apex:component ...>` tag (single line or wrapped).
 * The extractor only inspects the first such tag — declared controller /
 * extensions attributes always live on the root, and the worker spec
 * deliberately doesn't fully parse the markup XML (the body is the VF
 * scanner's territory).
 */
const APEX_COMPONENT_TAG = /<apex:component\b([^>]*)>/;

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
 * scalar/object otherwise. The meta-xml fields the component extractor
 * reads are all single-occurrence; this helper tolerates either shape.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

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

interface ComponentMeta {
  readonly apiVersion: number;
  readonly label: string;
  readonly description: string | null;
}

/**
 * Parse the `<ApexComponent>` companion metadata XML and return the values
 * required by the v1.4 node. Validates the root element name and the
 * required child elements per the vendored `ApexComponent.md` spec.
 */
const parseMetaXml = (
  xmlText: string,
  path: string,
): Result<ComponentMeta, ExtractorError> => {
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
  const descriptionRaw = unwrapSingle(rootObj['description']);
  const description = descriptionRaw === undefined ? null : String(descriptionRaw);
  return ok({ apiVersion, label, description });
};

interface RootAttributes {
  readonly controller: string | null;
  readonly extensions: readonly string[];
}

/**
 * Pull `controller` and `extensions` from the markup's `<apex:component>`
 * root tag via a single regex sweep. Returns `null` controller / empty
 * extensions when either attribute is absent — both are optional per
 * `ApexComponent.md` (a presentation-only component takes no controller
 * binding).
 *
 * The first `<apex:component ...>` tag occurrence wins. Note that, unlike
 * `<apex:page>`, components do NOT carry a `standardController=` attribute
 * on their root, so only `controller=` and `extensions=` are inspected.
 */
const parseRootAttributes = (markup: string): RootAttributes | null => {
  const tagMatch = APEX_COMPONENT_TAG.exec(markup);
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
 * Read a `.component` source file with UTF-8 encoding. Maps `ENOENT` to
 * `file-not-found` per the vendored ApexComponent.md spec; other I/O
 * errors become `parse-error` so the caller can surface the underlying
 * cause.
 */
const readComponentSource = async (
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
 * onto graph edges owned by `ownerId`. Identical projection to
 * `visualforce-page.ts` — the VF scanner is shared, and the edge
 * confidence + role conventions match the v1.4 spec for both component
 * types.
 *
 * Scanner errors (`empty-source`, etc.) surface as a warning string the
 * caller stores on the node — never as a hard failure.
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
 * Extract a Node and edges from a single Salesforce Visualforce custom
 * component. Takes the path to the `.component` markup file (not the
 * meta-xml — per the vendored doc, the `.component` is the canonical
 * `sourcePath`).
 *
 * Reads both the `.component` markup and its companion
 * `.component-meta.xml`, parses the `<apex:component>` opening-tag
 * attributes for declared `controller=` / `extensions=` references, and
 * runs the v1.4 frontend scanner (`'vf'` dialect) over the full markup
 * body for `{!Object.Field}` reads, `{!ClassName.method()}` calls, and
 * `<c:OtherComponent>` references.
 *
 * Returns one `Node` of type `'VisualforceComponent'` and edges:
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
 *     nested `<c:OtherComponent>` tag (`confidence: 'declared'`,
 *     `properties.role: 'composition'`).
 *
 * Edges are deduped + sorted by `(toId asc, edgeType asc)` so the
 * declared-vs-heuristic origin doesn't influence output order — golden
 * tests do deep equality.
 *
 * Scanner errors surface as `node.properties.vfScannerWarnings: string[]`,
 * never as hard failures. Omitted entirely on the success path so the
 * golden's positive case stays free of an empty-array property (matching
 * `apex-class.ts`'s precedent).
 *
 * Error cases (per vendored `ApexComponent.md`):
 *   - `file-not-found` if `.component` is missing (message `file not found`)
 *   - `file-not-found` if `.component-meta.xml` is missing
 *     (message `metadata file missing`)
 *   - `parse-error` if the metadata XML is malformed
 *   - `malformed-input` if the metadata root isn't `<ApexComponent>`,
 *     a required element is missing, or `apiVersion` is non-numeric
 *
 * @example
 *   const result = await extractVisualforceComponent(
 *     'force-app/main/default/components/Header.component',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'VisualforceComponent:Header'
 *   }
 */
export const extractVisualforceComponent = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const apiName = deriveComponentApiName(path, COMPONENT_FILE_SUFFIX);

  const sourceResult = await readComponentSource(path);
  if (!sourceResult.ok) return sourceResult;
  const markup = sourceResult.value;

  const metaPath = `${path}${META_FILE_EXT}`;
  const xmlResult = await readAndValidateXml(metaPath, 'metadata file missing');
  if (!xmlResult.ok) return xmlResult;

  const metaResult = parseMetaXml(xmlResult.value, metaPath);
  if (!metaResult.ok) return metaResult;
  const meta = metaResult.value;

  const ownerId = `${NODE_TYPE}:${apiName}`;

  // Pull the `<apex:component controller=... extensions=...>` declared
  // edges from the opening tag. The scanner runs over the full markup,
  // but its patterns (`{!...}`, `<c:...>`) cannot match
  // `controller="X"` attribute text, so there's no double-count.
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
  // strictly (toId asc, edgeType asc). First occurrence wins on dedupe;
  // declared edges are pushed first so a declared `references` survives
  // a scanner-emitted duplicate.
  const edges = mergeAndSortEdges([...declaredEdges, ...scannerOutput.edges]);

  const baseProperties = {
    apiVersion: meta.apiVersion,
    label: meta.label,
    description: meta.description,
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
