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
import { scanFrontendSource, type FrontendResourceRef } from '@sf-intelligence/parsers';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { buildResourceRefEdges, mergeAndSortEdges } from './apex-edges.js';
import { deriveBundleApiName } from './path-utils.js';

const ROOT_ELEMENT = 'AuraDefinitionBundle';
const META_REQUIRED_ELEMENTS = ['apiVersion'] as const;
const META_SUFFIX = '-meta.xml';
const MARKUP_SUFFIXES = ['.cmp', '.app', '.evt', '.intf', '.tokens'] as const;
const CONTROLLER_SUFFIX = 'Controller.js';
const HELPER_SUFFIX = 'Helper.js';
const RENDERER_SUFFIX = 'Renderer.js';
const EDGE_SOURCE = 'aura-extractor';

type MarkupSuffix = (typeof MARKUP_SUFFIXES)[number];

/**
 * Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence
 * children. Mirrors the helper used in the file-based extractors.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Confirm a path exists and is a directory. Returns `file-not-found`
 * (the canonical extractor error for this case) when missing or when
 * the path points at something other than a directory.
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
 * Read and strictly-validate the bundle's `-meta.xml`. Surfaces a
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

interface AuraMeta {
  readonly apiVersion: number;
  readonly description: string | null;
}

/**
 * Parse the bundle's `-meta.xml` text and surface the values the
 * extractor needs. Validates the root element name and the required
 * children per the vendored `AuraDefinition.md` spec.
 */
const parseMetaXml = (
  xmlText: string,
  path: string,
): Result<AuraMeta, ExtractorError> => {
  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale Aura metadata.
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
  const descriptionRaw = unwrapSingle(rootObj['description']);
  const description = descriptionRaw === undefined ? null : String(descriptionRaw);
  return ok({ apiVersion, description });
};

/**
 * Read a bundle file if it exists. Returns the source text on success,
 * `null` when the file is absent (no error), or an `ExtractorError` on
 * any other I/O failure.
 */
const readOptionalFile = async (
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
 * Probe the bundle directory for the first root markup file (`.cmp` >
 * `.app` > `.evt` > `.intf` > `.tokens`, in priority order). Returns the
 * suffix that matched, or `null` when no recognized root markup file is
 * present. The caller maps `null` to a `malformed-input` error per the
 * vendored spec's error-cases table.
 */
const findMarkupFile = async (
  dirPath: string,
  apiName: string,
): Promise<{ readonly suffix: MarkupSuffix; readonly source: string } | null> => {
  for (const suffix of MARKUP_SUFFIXES) {
    const filePath = join(dirPath, `${apiName}${suffix}`);
    try {
      const source = await readFile(filePath, 'utf-8');
      return { suffix, source };
    } catch (cause: unknown) {
      const code = (cause as { code?: string } | null | undefined)?.code;
      if (code === 'ENOENT') continue;
      // Any other I/O error on the markup file is rare enough to fall
      // through as "no markup found"; subsequent reads will surface the
      // underlying problem.
      continue;
    }
  }
  return null;
};

/** True when `filePath` exists (any stat-able node), false otherwise. */
const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

interface AuraScanResult {
  readonly componentRefs: readonly string[];
  readonly resourceRefs: readonly FrontendResourceRef[];
  readonly warnings: readonly string[];
}

/**
 * Run the v1.4 Aura frontend scanner across one source string and
 * collect the component references plus `$Label.c.X` / `$Resource.X`
 * value-provider tokens (P14-USAGE-label-static-graph). Scanner errors
 * (empty-source, unknown-dialect) are non-fatal — they surface as
 * warnings so a parse glitch in one file doesn't void the whole bundle.
 */
const scanOne = (source: string, label: string): AuraScanResult => {
  const result = scanFrontendSource(source, 'aura');
  if (!result.ok) {
    return {
      componentRefs: [],
      resourceRefs: [],
      warnings: [
        `aura-scanner[${label}]: ${result.error.kind} at offset ${result.error.offset}: ${result.error.message}`,
      ],
    };
  }
  return {
    componentRefs: result.value.componentRefs.map((r) => r.componentName),
    resourceRefs: result.value.resourceRefs,
    warnings: [],
  };
};

/**
 * Extract a Node and edges from a single Aura definition bundle. Takes
 * the path to the bundle **directory** (not any individual file).
 *
 * Reads the bundle's `-meta.xml` (required), the root markup file
 * (`.cmp` / `.app` / `.evt` / `.intf` / `.tokens` — first match wins,
 * required), and any optional controller / helper / renderer JS files.
 * Each non-empty source is passed to the v1.4 Aura frontend scanner
 * (`scanFrontendSource(..., 'aura')`); the scanner extracts component
 * references from markup tags (`<c:CustomerCard ... />`) and `$A.get`
 * event references. Scanner errors surface as
 * `node.properties.auraScannerWarnings: string[]`, never as hard
 * failures.
 *
 * Returns one `Node` of type `'AuraDefinitionBundle'` and edges:
 *
 *   - One `references` edge per component reference to
 *     `AuraDefinitionBundle:{Name}` at `confidence: 'heuristic'`. (The
 *     v1.4 Aura scanner does not emit field accesses or apex calls;
 *     those patterns will land in a later milestone.)
 *
 * Edges are deduped + sorted by `(toId asc, edgeType asc)` to match
 * the precedent set by the Apex extractors.
 *
 * Error cases (per vendored `AuraDefinition.md`):
 *   - `file-not-found` if the bundle directory is missing
 *     (message `bundle directory not found`)
 *   - `file-not-found` if `{Name}-meta.xml` is missing
 *     (message `metadata file missing`)
 *   - `malformed-input` if no root markup file is present
 *     (message `no Aura definition type found`)
 *   - `parse-error` if the meta XML is malformed
 *   - `malformed-input` if the meta root isn't `<AuraDefinitionBundle>`,
 *     a required element is missing, or `apiVersion` is non-numeric
 *
 * @example
 *   const result = await extractAuraDefinitionBundle(
 *     'force-app/main/default/aura/CaseManager',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'AuraDefinitionBundle:CaseManager'
 *   }
 */
export const extractAuraDefinitionBundle = async (
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

  // Resolve the primary definition (markup) first: the DX source-format
  // metadata file is named after the bundle AND that definition's suffix —
  // `{name}.cmp-meta.xml` / `.app-meta.xml` / etc. (what `sf project retrieve`
  // writes), NOT the bare `{name}-meta.xml`. Knowing the markup suffix lets us
  // build the correct meta path; without this, every aura bundle in a
  // DX-retrieved org failed with `metadata file missing`.
  const markup = await findMarkupFile(path, apiName);
  if (markup === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'no Aura definition type found',
    });
  }

  // Prefer the suffixed meta name; fall back to the bare `{name}-meta.xml` for
  // legacy / non-DX layouts.
  const suffixedMetaPath = join(path, `${apiName}${markup.suffix}${META_SUFFIX}`);
  const metaPath = (await fileExists(suffixedMetaPath))
    ? suffixedMetaPath
    : join(path, `${apiName}${META_SUFFIX}`);
  const xmlResult = await readAndValidateXml(metaPath);
  if (!xmlResult.ok) return xmlResult;
  const metaResult = parseMetaXml(xmlResult.value, metaPath);
  if (!metaResult.ok) return metaResult;
  const meta = metaResult.value;

  const controllerPath = join(path, `${apiName}${CONTROLLER_SUFFIX}`);
  const helperPath = join(path, `${apiName}${HELPER_SUFFIX}`);
  const rendererPath = join(path, `${apiName}${RENDERER_SUFFIX}`);

  const controllerResult = await readOptionalFile(controllerPath);
  if (!controllerResult.ok) return controllerResult;
  const helperResult = await readOptionalFile(helperPath);
  if (!helperResult.ok) return helperResult;
  const rendererResult = await readOptionalFile(rendererPath);
  if (!rendererResult.ok) return rendererResult;

  const ownerId = `${ROOT_ELEMENT}:${apiName}`;

  // Scan markup + each optional JS file. Each contributes to the same
  // dedup set keyed by component name.
  const seenRefs = new Set<string>();
  const refs: { readonly name: string; readonly source: string }[] = [];
  const seenResourceRefs = new Set<string>();
  const resourceRefs: FrontendResourceRef[] = [];
  const warnings: string[] = [];
  const scans: { readonly label: string; readonly source: string | null }[] = [
    { label: 'markup', source: markup.source },
    { label: 'controller', source: controllerResult.value },
    { label: 'helper', source: helperResult.value },
    { label: 'renderer', source: rendererResult.value },
  ];
  for (const { label, source } of scans) {
    if (source === null || source.trim().length === 0) continue;
    const scanned = scanOne(source, label);
    for (const name of scanned.componentRefs) {
      if (seenRefs.has(name)) continue;
      seenRefs.add(name);
      refs.push({ name, source: label });
    }
    for (const ref of scanned.resourceRefs) {
      const key = `${ref.kind}:${ref.apiName}`;
      if (seenResourceRefs.has(key)) continue;
      seenResourceRefs.add(key);
      resourceRefs.push(ref);
    }
    if (scanned.warnings.length > 0) warnings.push(...scanned.warnings);
  }

  const rawEdges: Edge[] = refs.map((ref) => ({
    fromId: ownerId,
    toId: `AuraDefinitionBundle:${ref.name}`,
    edgeType: 'references',
    confidence: 'heuristic',
    source: EDGE_SOURCE,
    properties: { detectedIn: ref.source },
  }));
  // $Label.c.X / $Resource.X value-provider tokens → references edges
  // (heuristic: regex tokens, not declarative imports).
  rawEdges.push(...buildResourceRefEdges(ownerId, resourceRefs, EDGE_SOURCE, 'heuristic'));
  const edges = mergeAndSortEdges(rawEdges);

  const baseProperties = {
    description: meta.description,
    apiVersion: meta.apiVersion,
    hasController: controllerResult.value !== null,
    hasHelper: helperResult.value !== null,
    hasRenderer: rendererResult.value !== null,
    markupBytes: Buffer.byteLength(markup.source, 'utf-8'),
    definitionType: markup.suffix.slice(1),
    componentRefCount: refs.length,
  };
  const properties =
    warnings.length === 0
      ? baseProperties
      : { ...baseProperties, auraScannerWarnings: warnings };

  const node: Node = {
    id: ownerId,
    type: 'AuraDefinitionBundle',
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
