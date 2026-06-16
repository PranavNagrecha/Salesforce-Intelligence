import { readFile } from 'node:fs/promises';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { countAssertions, detectCodeQualityIssues } from '@sf-intelligence/patterns';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  buildApexScannerEdges,
  buildClassListensToEdge,
  buildDispatchesAsyncEdges,
  buildExposesEdges,
  mergeAndSortEdges,
} from './apex-edges.js';
import { parseApexHeader } from './apex-header-parser.js';
import { deriveComponentApiName } from './path-utils.js';

const CLS_FILE_SUFFIX = '.cls';
const META_FILE_EXT = '-meta.xml';
const ROOT_ELEMENT = 'ApexClass';
const META_REQUIRED_ELEMENTS = ['apiVersion', 'status'] as const;

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. The `.cls-meta.xml` fields the extractor reads
 * are all single-occurrence; this helper tolerates either shape.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Read and strictly-validate a file as XML, returning the raw text on
 * success. fast-xml-parser's `parse()` is permissive (silently truncates on
 * mismatched tags), so we validate first to surface malformed input as
 * `parse-error` rather than a misleading partial extraction.
 *
 * Maps `ENOENT` to `file-not-found` with a caller-supplied message; the
 * caller distinguishes the missing `.cls` from a missing `.cls-meta.xml`
 * by passing the appropriate message.
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

interface ApexMeta {
  readonly apiVersion: number;
  readonly status: string;
  readonly description: string | null;
}

/**
 * Parse the `<ApexClass>` companion metadata XML and return the values
 * required by the v0.1 node. Validates the root element name and the
 * required child elements per the vendored `ApexClass.md` spec.
 */
const parseMetaXml = (
  xmlText: string,
  path: string,
): Result<ApexMeta, ExtractorError> => {
  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale Profile/PermissionSet/Layout XML.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` upstream catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's default entity-expansion
  // cap of 1000). Catch it here so a single pathological file becomes a
  // per-file `parse-error` rather than aborting the refresh pipeline.
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
  const status = String(unwrapSingle(rootObj['status']));
  const descriptionRaw = unwrapSingle(rootObj['description']);
  const description = descriptionRaw === undefined ? null : String(descriptionRaw);
  return ok({ apiVersion, status, description });
};

/**
 * Count lines in `text` matching the convention of `awk 'END{print NR}'`:
 * the number of newline-terminated lines plus 1 if the text ends without a
 * trailing newline (and is non-empty).
 */
const countLines = (text: string): number => {
  if (text.length === 0) return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return newlines + (text.endsWith('\n') ? 0 : 1);
};

/**
 * Read a `.cls` source file with UTF-8 encoding. Maps `ENOENT` to
 * `file-not-found` per the vendored ApexClass.md spec; other I/O errors
 * become `parse-error` so the caller can surface the underlying cause.
 */
const readClsSource = async (
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
 * Extract a Node from a single Salesforce Apex class. Takes the path to the
 * `.cls` source file (not the metadata XML — per the vendored doc, the
 * `.cls` is the canonical `sourcePath`).
 *
 * Reads both the `.cls` source and its companion `.cls-meta.xml`, performs
 * a shallow header scan of the source (modifiers, sharing, class name,
 * superclass, implements, annotations), and parses `apiVersion` and
 * `status` from the metadata XML.
 *
 * Returns one `Node` of type `'ApexClass'` and zero-to-many edges
 * (`readsFrom`, `writesTo`, `callsApex`) derived from the v0.3 heuristic
 * Apex scanner (see `apex-edges.ts` and `ApexSemantics.md`). All scanner
 * edges carry `confidence: 'heuristic'`. Scanner errors surface as
 * `node.properties.apexScannerWarnings: string[]` (omitted entirely on
 * the success path).
 *
 * Error cases (per vendored `ApexClass.md`):
 *   - `file-not-found` if `.cls` is missing (message `file not found`)
 *   - `file-not-found` if `.cls-meta.xml` is missing (message `metadata file missing`)
 *   - `parse-error` if the metadata XML is malformed
 *   - `malformed-input` if the metadata root isn't `<ApexClass>`,
 *     a required element is missing, the `.cls` has no class
 *     declaration, or the parsed class name disagrees with the filename.
 *
 * @example
 *   const result = await extractApexClass(
 *     'tests/fixtures/edu-org/source/main/default/classes/MRK_ClearLogsBatch.cls',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'ApexClass:MRK_ClearLogsBatch'
 *   }
 */
export const extractApexClass = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const apiName = deriveComponentApiName(path, CLS_FILE_SUFFIX);

  const sourceResult = await readClsSource(path);
  if (!sourceResult.ok) return sourceResult;
  const source = sourceResult.value;

  const metaPath = `${path}${META_FILE_EXT}`;
  const xmlResult = await readAndValidateXml(metaPath, 'metadata file missing');
  if (!xmlResult.ok) return xmlResult;

  const metaResult = parseMetaXml(xmlResult.value, metaPath);
  if (!metaResult.ok) return metaResult;
  const meta = metaResult.value;

  const headerResult = parseApexHeader(source);
  if (!headerResult.ok) {
    const message =
      headerResult.error.kind === 'no-class-declaration'
        ? 'no class or interface declaration found'
        : headerResult.error.message;
    return err({ kind: 'malformed-input', path, message });
  }
  const header = headerResult.value;

  if (header.className !== apiName) {
    return err({
      kind: 'malformed-input',
      path,
      message: `class name ${header.className} does not match filename ${apiName}`,
    });
  }

  const ownerId = `${ROOT_ELEMENT}:${apiName}`;
  const scannerResult = buildApexScannerEdges(source, ownerId);

  // v1.5 async / API surface classifier booleans. All are
  // always-present (default `false`) so consumers can filter by
  // property without the renderer having to thread an "absent vs
  // false" distinction. The "isFuture / hasFutureMethod" naming
  // mirrors `IntegrationTopologySemantics.md` §"Async / job classifier
  // patterns" — `isFuture` reads "class is a future-method holder"
  // and `hasFutureMethod` reads symmetrically with the
  // `hasAuraEnabledMethod` / `hasInvocableMethod` family; both names
  // are populated identically so the v1.5
  // `sfi.list_components(propertyFilter=...)` enum can route either
  // name to the same underlying flag without two boolean fields with
  // diverging values.
  const implementsSet = new Set(header.implements);
  const methodAnnotationsSet = new Set(header.methodAnnotations);
  const isQueueable = implementsSet.has('Queueable');
  const isSchedulable = implementsSet.has('Schedulable');
  // `Database.Batchable<{Type}>` arrives from `readTypeRef` as a
  // single contiguous string with the angle-bracket arg joined; check
  // by prefix so any `Database.Batchable<...>` variant is recognized.
  const isBatchable = header.implements.some((entry) =>
    entry.startsWith('Database.Batchable<'),
  );
  const hasFutureMethod = methodAnnotationsSet.has('future');
  const hasInvocableMethod = methodAnnotationsSet.has('InvocableMethod');
  const hasAuraEnabledMethod = methodAnnotationsSet.has('AuraEnabled');
  const isRestResource = header.restUrlMapping !== null;

  // v1.5 declared edges: listensTo (Triggerable<...__e>), exposes
  // (REST/Aura/Invocable synthetic ids), dispatchesAsync (Queueable /
  // Batchable / Schedulable inline-constructor dispatches). The
  // declared edges merge with the scanner-derived heuristic edges and
  // are re-sorted by (toId, edgeType) so golden output is stable
  // regardless of edge origin — same approach `apex-trigger.ts`
  // takes for its declared `triggersOn`.
  const declaredEdges: Edge[] = [];
  const listensToEdge = buildClassListensToEdge(ownerId, header.implements);
  if (listensToEdge !== null) declaredEdges.push(listensToEdge);
  declaredEdges.push(
    ...buildExposesEdges(
      ownerId,
      apiName,
      header.restUrlMapping,
      methodAnnotationsSet,
    ),
  );
  const dispatchesAsyncEdges = buildDispatchesAsyncEdges(ownerId, source);
  declaredEdges.push(...dispatchesAsyncEdges);
  // Suppress redundancy: a `new MyQueueable()` inside `enqueueJob`
  // already emits a declared `dispatchesAsync` edge above, and the
  // generic-instantiation scanner sweep would ALSO emit a heuristic
  // `references` edge to the same target. `mergeAndSortEdges` dedupes
  // by `(fromId, toId, edgeType)` so the differing edgeType keeps both
  // — drop the parallel `references` edge here so the dispatch keeps
  // ONLY its `dispatchesAsync` edge.
  const dispatchTargets = new Set(
    dispatchesAsyncEdges.map((e) => `${e.fromId}|${e.toId}`),
  );
  const scannerEdges = scannerResult.edges.filter(
    (e) =>
      e.edgeType !== 'references' ||
      !dispatchTargets.has(`${e.fromId}|${e.toId}`),
  );
  const edges = mergeAndSortEdges([...declaredEdges, ...scannerEdges]);

  // v2.1: code-quality recognizer family runs over the raw source.
  // The output is always-present (empty array on the clean path) so
  // consumers can filter by `qualityIssues.length > 0` without
  // threading an absent-vs-empty distinction. This mirrors v1.5's
  // boolean classifier discipline (`isQueueable` etc.).
  const qualityIssues = detectCodeQualityIssues(source, {
    apiVersion: meta.apiVersion,
    isTest: header.isTest,
  });

  // `exactOptionalPropertyTypes` makes the warnings key all-or-nothing:
  // omit it on the success path so the golden's positive case stays
  // free of an empty-array prop; include it (non-empty) on scanner
  // error. The error path still emits the Node and any declared edges,
  // matching `flow.ts`'s precedent for `flowExtractionWarnings`.
  // v1.5 properties (isQueueable etc.) are unconditionally present;
  // restUrlMapping is included only when non-null so the absent case
  // doesn't clutter golden output with `null` slots.
  const baseProperties: Record<string, unknown> = {
    status: meta.status,
    description: meta.description,
    modifiers: header.modifiers,
    sharingModel: header.sharingModel,
    superclass: header.superclass,
    implements: header.implements,
    annotations: header.annotations,
    isTest: header.isTest,
    isQueueable,
    isSchedulable,
    isBatchable,
    hasFutureMethod,
    hasInvocableMethod,
    hasAuraEnabledMethod,
    isRestResource,
    lineCount: countLines(source),
    sourceBytes: Buffer.byteLength(source, 'utf-8'),
    qualityIssues,
  };
  if (header.restUrlMapping !== null) {
    baseProperties['restUrlMapping'] = header.restUrlMapping;
  }
  // Test classes carry an `assertionCount` (raw assertion frequency — both the
  // legacy `System.assert*` family and the modern `Assert.*` class) so
  // `sfi.meaningful_test_audit` can compute its assertions-per-KB density. Set
  // only on test classes to keep non-test node properties unchanged. Without
  // this the property was never written and density was always 0.
  if (header.isTest) {
    baseProperties['assertionCount'] = countAssertions(source);
  }
  const properties =
    scannerResult.warnings.length === 0
      ? baseProperties
      : { ...baseProperties, apexScannerWarnings: scannerResult.warnings };

  const node: Node = {
    id: ownerId,
    type: 'ApexClass',
    apiName,
    label: apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: meta.apiVersion,
    properties,
  };

  return ok({ nodes: [node], edges });
};
