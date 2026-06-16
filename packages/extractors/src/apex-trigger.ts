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

import {
  buildApexScannerEdges,
  buildDispatchesAsyncEdges,
  mergeAndSortEdges,
} from './apex-edges.js';
import { deriveComponentApiName } from './path-utils.js';
import { parseTriggerHeader } from './trigger-header-parser.js';

const TRIGGER_FILE_SUFFIX = '.trigger';
const META_FILE_EXT = '-meta.xml';
const ROOT_ELEMENT = 'ApexTrigger';
const META_REQUIRED_ELEMENTS = ['apiVersion', 'status'] as const;
const EDGE_SOURCE = 'apex-trigger-extractor';

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. The fields the trigger extractor reads are all
 * single-occurrence; this helper tolerates either shape.
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
 * caller distinguishes the missing source file from a missing meta XML by
 * passing the appropriate message.
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

interface TriggerMeta {
  readonly apiVersion: number;
  readonly status: string;
}

/**
 * Parse the `<ApexTrigger>` companion metadata XML and return the values
 * required by the v0.1 node. Validates the root element name and the
 * required child elements per the vendored `ApexTrigger.md` spec.
 */
const parseMetaXml = (
  xmlText: string,
  path: string,
): Result<TriggerMeta, ExtractorError> => {
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
  return ok({ apiVersion, status });
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
 * Read a `.trigger` source file with UTF-8 encoding. Maps `ENOENT` to
 * `file-not-found` per the vendored ApexTrigger.md spec; other I/O errors
 * become `parse-error` so the caller can surface the underlying cause.
 */
const readTriggerSource = async (
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
 * Extract a Node and an edge from a single Salesforce Apex trigger. Takes
 * the path to the `.trigger` source file (per the vendored doc, the
 * `.trigger` is the canonical `sourcePath`).
 *
 * Reads both the `.trigger` source and its companion `.trigger-meta.xml`,
 * performs a shallow header scan of the source (trigger name, target
 * object, events), and parses `apiVersion` and `status` from the metadata
 * XML.
 *
 * Returns one `Node` of type `'ApexTrigger'` and one or more edges:
 * always a declared `'triggersOn'` edge to the trigger's target SObject;
 * zero-to-many declared `'dispatchesAsync'` edges when the body dispatches a
 * Queueable/Batchable/Schedulable via `new X(...)` (the scanner is blind to
 * `new X()`, so this is wired in explicitly — mirroring `apex-class.ts`);
 * plus zero-to-many heuristic `readsFrom`/`writesTo`/`callsApex` edges derived
 * from the v0.3 heuristic Apex scanner (see `apex-edges.ts`). Scanner errors
 * surface as `node.properties.apexScannerWarnings: string[]` (omitted entirely
 * on the success path).
 *
 * Error cases (per vendored `ApexTrigger.md`):
 *   - `file-not-found` if `.trigger` is missing (message `file not found`)
 *   - `file-not-found` if `.trigger-meta.xml` is missing
 *     (message `metadata file missing`)
 *   - `parse-error` if the metadata XML is malformed
 *   - `malformed-input` if the metadata root isn't `<ApexTrigger>`,
 *     a required element is missing, the `.trigger` header cannot be
 *     parsed, the trigger name disagrees with the filename, or the event
 *     list contains an unknown event.
 *
 * @example
 *   const result = await extractApexTrigger(
 *     'tests/fixtures/edu-org/source/main/default/triggers/AccountTrigger.trigger',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'ApexTrigger:AccountTrigger'
 *     console.log(result.value.edges[0].edgeType);
 *     // => 'triggersOn'
 *   }
 */
export const extractApexTrigger = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const apiName = deriveComponentApiName(path, TRIGGER_FILE_SUFFIX);

  const sourceResult = await readTriggerSource(path);
  if (!sourceResult.ok) return sourceResult;
  const source = sourceResult.value;

  const metaPath = `${path}${META_FILE_EXT}`;
  const xmlResult = await readAndValidateXml(metaPath, 'metadata file missing');
  if (!xmlResult.ok) return xmlResult;

  const metaResult = parseMetaXml(xmlResult.value, metaPath);
  if (!metaResult.ok) return metaResult;
  const meta = metaResult.value;

  const headerResult = parseTriggerHeader(source);
  if (!headerResult.ok) {
    const message =
      headerResult.error.kind === 'unknown-event'
        ? headerResult.error.message
        : 'cannot parse trigger header';
    return err({ kind: 'malformed-input', path, message });
  }
  const header = headerResult.value;

  if (header.triggerName !== apiName) {
    return err({
      kind: 'malformed-input',
      path,
      message: `trigger name ${header.triggerName} does not match filename ${apiName}`,
    });
  }

  const ownerId = `${ROOT_ELEMENT}:${apiName}`;
  const scannerResult = buildApexScannerEdges(source, ownerId);

  // The triggersOn edge is always emitted (it comes from the declared
  // trigger header, not the body); scanner edges are merged on top.
  // Final sort is by toId asc, then edgeType asc so the
  // declared-vs-heuristic origin doesn't affect output order — golden
  // tests do deep equality.
  const triggersOnEdge: Edge = {
    fromId: ownerId,
    toId: `CustomObject:${header.objectApiName}`,
    edgeType: 'triggersOn',
    confidence: 'declared',
    source: EDGE_SOURCE,
    properties: { events: header.events },
  };
  // v1.5: when the trigger's target object is a Platform Event
  // (`__e`-suffixed api name), ALSO emit a `listensTo` edge to the
  // same CustomObject. `triggersOn` and `listensTo` aren't synonyms —
  // `triggersOn` says "this trigger fires on these events"; `listensTo`
  // says "this is a Platform Event subscriber". Both edges target the
  // same CustomObject node (the existing v1.0 node for the `__e`
  // event). See `IntegrationTopologySemantics.md` Rule 1.
  const isPlatformEventSubscriber = header.objectApiName.endsWith('__e');
  const declaredEdges: Edge[] = [triggersOnEdge];
  if (isPlatformEventSubscriber) {
    declaredEdges.push({
      fromId: ownerId,
      toId: `CustomObject:${header.objectApiName}`,
      edgeType: 'listensTo',
      confidence: 'declared',
      source: EDGE_SOURCE,
      properties: {
        eventName: header.objectApiName,
        mechanism: 'triggerOnPlatformEvent',
      },
    });
  }
  // A trigger that enqueues a Queueable / executes a Batch / schedules a job
  // names the target class via an inline `new X(...)` constructor — a declared
  // async-dispatch dependency the regex scanner can't see (it only matches the
  // `IDENT.IDENT(` call shape). Wire it in exactly as `apex-class.ts` does so
  // the real edge (e.g. AccountTrigger -> ApexClass:MRK_NewPartnerAccountHelper)
  // is captured instead of dropped.
  const dispatchesAsyncEdges = buildDispatchesAsyncEdges(ownerId, source);
  declaredEdges.push(...dispatchesAsyncEdges);
  // Suppress redundancy: a `new MyQueueable()` inside `enqueueJob`
  // already emits a declared `dispatchesAsync` edge above, and the
  // generic-instantiation scanner sweep would ALSO emit a heuristic
  // `references` edge to the same target. `mergeAndSortEdges` dedupes
  // by `(fromId, toId, edgeType)` so the differing edgeType keeps both
  // — drop the parallel `references` edge here so the dispatch keeps
  // ONLY its `dispatchesAsync` edge. Mirrors `apex-class.ts`.
  const dispatchTargets = new Set(
    dispatchesAsyncEdges.map((e) => `${e.fromId}|${e.toId}`),
  );
  const scannerEdges = scannerResult.edges.filter(
    (e) =>
      e.edgeType !== 'references' ||
      !dispatchTargets.has(`${e.fromId}|${e.toId}`),
  );
  const edges = mergeAndSortEdges([...declaredEdges, ...scannerEdges]);

  // Match apex-class.ts: omit `apexScannerWarnings` on the success path
  // to keep `exactOptionalPropertyTypes` happy and the golden's positive
  // case free of an empty-array property.
  // v1.5 adds `isPlatformEventSubscriber` — always present, default
  // false. Mirrors the apex-class.ts boolean-property approach so
  // consumers can filter triggers by property without distinguishing
  // "absent" from "false".
  const baseProperties = {
    status: meta.status,
    triggerObject: header.objectApiName,
    events: header.events,
    isPlatformEventSubscriber,
    lineCount: countLines(source),
    sourceBytes: Buffer.byteLength(source, 'utf-8'),
  };
  const properties =
    scannerResult.warnings.length === 0
      ? baseProperties
      : { ...baseProperties, apexScannerWarnings: scannerResult.warnings };

  const node: Node = {
    id: ownerId,
    type: 'ApexTrigger',
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
