import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

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
import { deriveBundleApiName } from './path-utils.js';

const ROOT_ELEMENT = 'LightningComponentBundle';
const META_REQUIRED_ELEMENTS = ['apiVersion', 'isExposed'] as const;
const META_SUFFIX = '.js-meta.xml';
const JS_SUFFIX = '.js';
const HTML_SUFFIX = '.html';
const EDGE_SOURCE = 'lwc-extractor';

/**
 * Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence
 * children. Mirrors the helper used in the file-based extractors.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Coerce a string-valued `<isExposed>` element to a boolean. The metadata
 * XML stores the value as `true` / `false`; any other text falls back to
 * `false` (matching Salesforce's "default to safest value" stance).
 */
const coerceBoolean = (raw: unknown): boolean =>
  String(raw).trim().toLowerCase() === 'true';

/**
 * Confirm a path exists and is a directory. Returns `file-not-found`
 * (the canonical extractor error for this case) when missing or when the
 * path points at something other than a directory.
 */
const ensureBundleDir = async (
  path: string,
): Promise<Result<true, ExtractorError>> => {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      return err({
        kind: 'file-not-found',
        path,
        message: 'bundle directory not found',
      });
    }
    return ok(true);
  } catch (cause: unknown) {
    const code = (cause as { code?: string } | null | undefined)?.code;
    if (code === 'ENOENT') {
      return err({
        kind: 'file-not-found',
        path,
        message: 'bundle directory not found',
      });
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
 * Read and strictly-validate the bundle's `.js-meta.xml`. Surfaces a
 * missing file as `file-not-found` with the documented message; malformed
 * XML as `parse-error`. fast-xml-parser's `parse()` is permissive, so we
 * validate first to avoid silent truncation.
 */
const readAndValidateXml = async (
  path: string,
): Promise<Result<string, ExtractorError>> => {
  let xmlText: string;
  try {
    xmlText = await readFile(path, 'utf-8');
  } catch (cause: unknown) {
    const code = (cause as { code?: string } | null | undefined)?.code;
    if (code === 'ENOENT') {
      return err({
        kind: 'file-not-found',
        path,
        message: 'metadata file missing',
      });
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

interface LwcMeta {
  readonly apiVersion: number;
  readonly isExposed: boolean;
  readonly targets: readonly string[];
  readonly targetConfigObjects: readonly string[];
  readonly targetConfigCount: number;
}

/**
 * Walk `<targetConfigs><targetConfig><objects><object>X</object></objects>`
 * and surface the listed SObjects. The shape is repeated and the XML
 * parser returns either an array or a scalar depending on cardinality —
 * `toArray` normalizes both. Duplicates across configs are preserved
 * (the extractor dedups when emitting edges).
 */
const collectTargetConfigObjects = (raw: unknown): readonly string[] => {
  if (raw === undefined || raw === null) return [];
  const targetConfigsObj = unwrapSingle(raw);
  if (typeof targetConfigsObj !== 'object' || targetConfigsObj === null) {
    return [];
  }
  const targetConfigRaw = (targetConfigsObj as Record<string, unknown>)[
    'targetConfig'
  ];
  if (targetConfigRaw === undefined) return [];
  const targetConfigs: readonly unknown[] = Array.isArray(targetConfigRaw)
    ? targetConfigRaw
    : [targetConfigRaw];
  const out: string[] = [];
  for (const cfg of targetConfigs) {
    if (typeof cfg !== 'object' || cfg === null) continue;
    const objectsRaw = (cfg as Record<string, unknown>)['objects'];
    if (objectsRaw === undefined || objectsRaw === null) continue;
    const objectsObj = unwrapSingle(objectsRaw);
    if (typeof objectsObj !== 'object' || objectsObj === null) continue;
    const objectRaw = (objectsObj as Record<string, unknown>)['object'];
    if (objectRaw === undefined || objectRaw === null) continue;
    const list: readonly unknown[] = Array.isArray(objectRaw)
      ? objectRaw
      : [objectRaw];
    for (const o of list) {
      const s = String(o).trim();
      if (s.length > 0) out.push(s);
    }
  }
  return out;
};

/**
 * Parse the bundle's `.js-meta.xml` text and surface the values the
 * extractor needs. Validates the root element name and the required
 * children per the vendored `LightningWebComponent.md` spec.
 */
const parseMetaXml = (
  xmlText: string,
  path: string,
): Result<LwcMeta, ExtractorError> => {
  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale Lightning metadata.
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
  const isExposed = coerceBoolean(unwrapSingle(rootObj['isExposed']));

  const targetsRaw = rootObj['targets'];
  const targets: string[] = [];
  if (targetsRaw !== undefined && targetsRaw !== null) {
    const targetsObj = unwrapSingle(targetsRaw);
    if (typeof targetsObj === 'object' && targetsObj !== null) {
      const targetRaw = (targetsObj as Record<string, unknown>)['target'];
      if (targetRaw !== undefined && targetRaw !== null) {
        const list: readonly unknown[] = Array.isArray(targetRaw)
          ? targetRaw
          : [targetRaw];
        for (const t of list) {
          const s = String(t).trim();
          if (s.length > 0) targets.push(s);
        }
      }
    }
  }

  // `targetConfigCount` mirrors the documented `targetConfigs` property —
  // we surface the count separately so consumers can decide whether to
  // load the full verbatim XML on demand.
  const targetConfigsRaw = rootObj['targetConfigs'];
  const targetConfigObjects = collectTargetConfigObjects(targetConfigsRaw);
  let targetConfigCount = 0;
  if (targetConfigsRaw !== undefined && targetConfigsRaw !== null) {
    const tcObj = unwrapSingle(targetConfigsRaw);
    if (typeof tcObj === 'object' && tcObj !== null) {
      const tcRaw = (tcObj as Record<string, unknown>)['targetConfig'];
      if (tcRaw !== undefined && tcRaw !== null) {
        targetConfigCount = Array.isArray(tcRaw) ? tcRaw.length : 1;
      }
    }
  }

  return ok({
    apiVersion,
    isExposed,
    targets,
    targetConfigObjects,
    targetConfigCount,
  });
};

/**
 * Read the bundle's primary `.js` controller. Missing JS is treated as
 * `file-not-found` per `LightningWebComponent.md`; an empty file is a
 * valid (if unusual) input — the scanner returns `empty-source` which
 * the caller silently tolerates.
 */
const readJsSource = async (
  path: string,
): Promise<Result<string, ExtractorError>> => {
  try {
    return ok(await readFile(path, 'utf-8'));
  } catch (cause: unknown) {
    const code = (cause as { code?: string } | null | undefined)?.code;
    if (code === 'ENOENT') {
      return err({
        kind: 'file-not-found',
        path,
        message: 'primary js file missing',
      });
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
 * Read the bundle's optional `.html` template. ENOENT is **not** an
 * error here — bare `.js` + `.js-meta.xml` LWC bundles are a
 * documented happy path. Returns the source on success; null when the
 * file is absent.
 */
const readHtmlSource = async (
  path: string,
): Promise<Result<string | null, ExtractorError>> => {
  try {
    return ok(await readFile(path, 'utf-8'));
  } catch (cause: unknown) {
    const code = (cause as { code?: string } | null | undefined)?.code;
    if (code === 'ENOENT') return ok(null);
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
};

/**
 * Project scanner output (`fieldAccesses`, `apexCalls`) onto graph edges
 * owned by `ownerId`. Schema-import discrimination isn't visible in the
 * scanner output (the scanner emits all reads identically), so the
 * extractor defaults every field-access edge to `'heuristic'`. The
 * `@salesforce/apex/...` import shape is unambiguous, so `callsApex`
 * edges land at `'declared'` per `LightningWebComponent.md`'s edge
 * table.
 *
 * Edges are deduped + sorted by `(toId asc, edgeType asc)` to match
 * the precedent set by the Apex extractors.
 */
const buildScannerEdges = (
  jsSource: string,
  ownerId: string,
): { readonly edges: readonly Edge[]; readonly warnings: readonly string[] } => {
  const result = scanFrontendSource(jsSource, 'lwc');
  if (!result.ok) {
    // Empty source is a tolerable shape (the doc allows a JS-less bundle
    // in theory; here we've read JS but it might be whitespace-only).
    // Surface the scanner error as a warning, never as a hard failure.
    return {
      edges: [],
      warnings: [
        `lwc-scanner: ${result.error.kind} at offset ${result.error.offset}: ${result.error.message}`,
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
      source: EDGE_SOURCE,
      properties: { offset: access.offset, length: access.length },
    });
  }
  for (const call of result.value.apexCalls) {
    raw.push({
      fromId: ownerId,
      toId: `ApexClass:${call.className}`,
      edgeType: 'callsApex',
      confidence: 'declared',
      source: EDGE_SOURCE,
      properties: {
        methodName: call.methodName,
        offset: call.offset,
        length: call.length,
      },
    });
  }
  // CustomLabel / StaticResource imports → references edges. `declared`:
  // an `import ... from '@salesforce/label/c.X'` statement is as declarative
  // as the apex imports above (P14-USAGE-label-static-graph).
  raw.push(...buildResourceRefEdges(ownerId, result.value.resourceRefs, EDGE_SOURCE, 'declared'));
  return { edges: raw, warnings: [] };
};

/**
 * Extract a Node and edges from a single Lightning Web Component bundle.
 * Takes the path to the bundle **directory** (not any individual file) —
 * LWC bundles are directory-shaped components, distinct from the
 * file-based ApexClass / CustomField extractors.
 *
 * Reads the bundle's `{Name}.js-meta.xml` (required), `{Name}.js`
 * (required), and `{Name}.html` (optional). The JS source is passed to
 * the v1.4 LWC frontend scanner (`scanFrontendSource(..., 'lwc')`); the
 * HTML template is intentionally not scanned in v1.4 (markup-side reads
 * are deferred). Scanner errors surface as
 * `node.properties.lwcScannerWarnings: string[]`, never as hard
 * failures — a parse glitch in the JS shouldn't void the entire node.
 *
 * Returns one `Node` of type `'LightningComponentBundle'` and edges:
 *
 *   - One `references` edge per `<targetConfig><objects><object>` to
 *     `CustomObject:{ObjectApiName}` at `confidence: 'declared'`.
 *   - `readsFrom` / `writesTo` edges to `CustomField:{object}.{field}`
 *     for each scanner field access (`confidence: 'heuristic'`).
 *   - `callsApex` edges to `ApexClass:{className}` for each scanner
 *     `@salesforce/apex/...` import (`confidence: 'declared'`).
 *
 * Error cases (per vendored `LightningWebComponent.md`):
 *   - `file-not-found` if the bundle directory is missing
 *     (message `bundle directory not found`)
 *   - `file-not-found` if `{Name}.js-meta.xml` is missing
 *     (message `metadata file missing`)
 *   - `file-not-found` if `{Name}.js` is missing
 *     (message `primary js file missing`)
 *   - `parse-error` if the meta XML is malformed
 *   - `malformed-input` if the meta root isn't `<LightningComponentBundle>`,
 *     a required element is missing, or `apiVersion` is non-numeric
 *
 * @example
 *   const result = await extractLightningComponentBundle(
 *     'force-app/main/default/lwc/accountQuickPanel',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'LightningComponentBundle:accountQuickPanel'
 *   }
 */
export const extractLightningComponentBundle = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const dirCheck = await ensureBundleDir(path);
  if (!dirCheck.ok) return dirCheck;

  const apiName = deriveBundleApiName(path);
  if (apiName.length === 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot derive bundle name from path',
    });
  }

  const metaPath = join(path, `${apiName}${META_SUFFIX}`);
  const jsPath = join(path, `${apiName}${JS_SUFFIX}`);
  const htmlPath = join(path, `${apiName}${HTML_SUFFIX}`);

  const xmlResult = await readAndValidateXml(metaPath);
  if (!xmlResult.ok) return xmlResult;
  const metaResult = parseMetaXml(xmlResult.value, metaPath);
  if (!metaResult.ok) return metaResult;
  const meta = metaResult.value;

  const jsResult = await readJsSource(jsPath);
  if (!jsResult.ok) return jsResult;
  const jsSource = jsResult.value;

  const htmlResult = await readHtmlSource(htmlPath);
  if (!htmlResult.ok) return htmlResult;
  const htmlSource = htmlResult.value;

  const ownerId = `${ROOT_ELEMENT}:${apiName}`;
  const scannerOutput = buildScannerEdges(jsSource, ownerId);

  // Declared `references` to bound SObjects come from `<targetConfigs>`
  // and are independent of the scanner. Emit one per unique object name.
  const seenObjects = new Set<string>();
  const declaredEdges: Edge[] = [];
  for (const objectName of meta.targetConfigObjects) {
    if (seenObjects.has(objectName)) continue;
    seenObjects.add(objectName);
    declaredEdges.push({
      fromId: ownerId,
      toId: `CustomObject:${objectName}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EDGE_SOURCE,
      properties: { role: 'targetConfig-object' },
    });
  }

  const edges = mergeAndSortEdges([...declaredEdges, ...scannerOutput.edges]);

  const baseProperties = {
    apiVersion: meta.apiVersion,
    isExposed: meta.isExposed,
    targets: meta.targets,
    targetConfigCount: meta.targetConfigCount,
    hasController: jsSource.length > 0,
    hasTemplate: htmlSource !== null,
    jsFileBytes: Buffer.byteLength(jsSource, 'utf-8'),
    apexCallCount: scannerOutput.edges.filter((e) => e.edgeType === 'callsApex')
      .length,
    fieldAccessCount: scannerOutput.edges.filter(
      (e) => e.edgeType === 'readsFrom' || e.edgeType === 'writesTo',
    ).length,
  };
  // `exactOptionalPropertyTypes` makes the warnings key all-or-nothing —
  // omit it on the success path so the golden's positive case stays
  // free of an empty-array prop.
  const properties =
    scannerOutput.warnings.length === 0
      ? baseProperties
      : { ...baseProperties, lwcScannerWarnings: scannerOutput.warnings };

  const node: Node = {
    id: ownerId,
    type: 'LightningComponentBundle',
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
