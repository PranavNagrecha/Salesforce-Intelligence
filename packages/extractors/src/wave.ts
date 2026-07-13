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

/** DX sidecar suffixes (Metadata API `.wdash` / `.wdf` / `.xmd` → source format). */
export const WAVE_DASHBOARD_FILE_SUFFIX = '.wdash-meta.xml';
export const WAVE_DATAFLOW_FILE_SUFFIX = '.wdf-meta.xml';
export const WAVE_XMD_FILE_SUFFIX = '.xmd-meta.xml';

const WAVE_XMD_EXTRACTOR_SOURCE = 'wave-xmd-extractor';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Normalize a fast-xml-parser child into an array. */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
};

/**
 * Read and strictly-validate a file as XML. Validates before parsing so
 * malformed input surfaces as `parse-error` (fast-xml-parser's `parse()`
 * silently truncates on mismatched tags).
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

/** Parse validated XML into a root object for `rootElement`, or an extractor error. */
const parseRoot = async (
  path: string,
  rootElement: string,
): Promise<Result<Record<string, unknown>, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

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

  const root = unwrapSingle(parsed[rootElement]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${rootElement}> root`,
    });
  }
  return ok(root as Record<string, unknown>);
};

/**
 * True when `value` is a single-dot `Object.Field` reference suitable as a
 * `CustomField:{Object}.{Field}` edge target. Rejects bare dataset columns
 * (`StageName`), multi-hop paths, and empty segments. Matches the
 * Object.Field discipline used by PermissionSet / Profile fieldPermissions.
 */
export const isObjectFieldRef = (value: string): boolean => {
  const trimmed = value.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot !== trimmed.lastIndexOf('.') || dot === trimmed.length - 1) {
    return false;
  }
  const objectPart = trimmed.slice(0, dot);
  const fieldPart = trimmed.slice(dot + 1);
  // Salesforce API names: letter/underscore start, then alnum/underscore.
  const apiName = /^[A-Za-z_][A-Za-z0-9_]*$/;
  return apiName.test(objectPart) && apiName.test(fieldPart);
};

/**
 * Resolve a dimension/measure customization to an `Object.Field` CustomField
 * target. Prefers `<origin>` (Salesforce source field on connector-backed
 * datasets) and falls back to `<field>` when that value is already
 * Object.Field-shaped (common for SFDC-connector datasets — e.g.
 * `Opportunity.StageName` in the XMD developer guide).
 */
const resolveCustomFieldRef = (entry: Record<string, unknown>): string | null => {
  const origin = optionalString(entry, 'origin');
  if (origin !== null && isObjectFieldRef(origin)) return origin;
  const field = optionalString(entry, 'field');
  if (field !== null && isObjectFieldRef(field)) return field;
  return null;
};

/**
 * Extract a `WaveDashboard` Node from a DX sidecar
 * `wave/{Name}.wdash-meta.xml` (root `<WaveDashboard>`).
 *
 * Finding #45 CRMA slice: WaveDashboard extends MetadataWithContent — the
 * companion `.wdash` JSON content blob is deliberately OUT OF SCOPE for v1
 * (same precedent as ExperienceBundle's page tree). This extractor models
 * existence + top-level meta only (`application`, `masterLabel`,
 * `description`, `templateAssetSourceName`, `dateVersion`) and stamps
 * `contentModeled: false`. Zero outgoing edges.
 *
 * @example
 *   const r = await extractWaveDashboard('…/wave/Ops_Overview.wdash-meta.xml');
 *   if (r.ok) console.log(r.value.nodes[0].id); // => 'WaveDashboard:Ops_Overview'
 */
export const extractWaveDashboard = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const rootResult = await parseRoot(path, 'WaveDashboard');
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const apiName = deriveComponentApiName(path, WAVE_DASHBOARD_FILE_SUFFIX);
  const masterLabel = optionalString(rootObj, 'masterLabel');

  const node: Node = {
    id: `WaveDashboard:${apiName}`,
    type: 'WaveDashboard',
    apiName,
    label: masterLabel ?? apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      application: optionalString(rootObj, 'application'),
      masterLabel,
      description: optionalString(rootObj, 'description'),
      templateAssetSourceName: optionalString(rootObj, 'templateAssetSourceName'),
      dateVersion: optionalString(rootObj, 'dateVersion'),
      // Honest scope marker: the `.wdash` JSON content blob is NOT modeled.
      contentModeled: false,
    },
  };

  return ok({ nodes: [node], edges: [] });
};

/**
 * Extract a `WaveDataflow` Node from a DX sidecar
 * `wave/{Name}.wdf-meta.xml` (root `<WaveDataflow>`).
 *
 * Finding #45 CRMA slice: WaveDataflow extends MetadataWithContent — the
 * companion `.wdf` JSON recipe/dataflow blob is OUT OF SCOPE for v1. Node +
 * top-level meta only (`application`, `masterLabel`, `description`,
 * `dataflowType`); `contentModeled: false`. Zero outgoing edges.
 *
 * @example
 *   const r = await extractWaveDataflow('…/wave/Daily_Sync.wdf-meta.xml');
 *   if (r.ok) console.log(r.value.nodes[0].id); // => 'WaveDataflow:Daily_Sync'
 */
export const extractWaveDataflow = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const rootResult = await parseRoot(path, 'WaveDataflow');
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const apiName = deriveComponentApiName(path, WAVE_DATAFLOW_FILE_SUFFIX);
  const masterLabel = optionalString(rootObj, 'masterLabel');

  const node: Node = {
    id: `WaveDataflow:${apiName}`,
    type: 'WaveDataflow',
    apiName,
    label: masterLabel ?? apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      application: optionalString(rootObj, 'application'),
      masterLabel,
      description: optionalString(rootObj, 'description'),
      dataflowType: optionalString(rootObj, 'dataflowType'),
      contentModeled: false,
    },
  };

  return ok({ nodes: [node], edges: [] });
};

/**
 * Extract a `WaveXmd` Node + CustomField `references` edges from a DX
 * `wave/{Name}.xmd-meta.xml` (root `<WaveXmd>`).
 *
 * Finding #45 CRMA slice: WaveXmd extends plain Metadata (no content blob).
 * Dimension/measure field customizations (display label, hide-from-explorer,
 * format, …) are the consumption surface that closes the undisclosed CRMA
 * blind spot in `safe_to_delete_field` / `unused_fields_deep`. Each
 * dimension/measure whose `<origin>` or `<field>` is Object.Field-shaped
 * emits a DECLARED `references` edge to `CustomField:{Object}.{Field}`
 * (`referenceKind: 'waveXmdFieldCustomization'`). Bare dataset columns
 * (`StageName`, `Sales`) and non-Object.Field names produce no edge —
 * they are not resolvable CustomField targets offline.
 *
 * Dates are counted on the node but do not mint field edges (WaveXmdDate
 * has no Object.Field origin in the documented schema).
 *
 * @example
 *   const r = await extractWaveXmd('…/wave/Opportunity_Dataset.xmd-meta.xml');
 *   if (r.ok) console.log(r.value.edges[0]?.toId);
 *   // => 'CustomField:Opportunity.StageName'
 */
export const extractWaveXmd = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const rootResult = await parseRoot(path, 'WaveXmd');
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const apiName = deriveComponentApiName(path, WAVE_XMD_FILE_SUFFIX);
  const nodeId = `WaveXmd:${apiName}`;
  const dataset = optionalString(rootObj, 'dataset');

  const dimensions = toArray(rootObj['dimensions']);
  const measures = toArray(rootObj['measures']);
  const dates = toArray(rootObj['dates']);

  const fieldRefs = new Set<string>();
  for (const raw of [...dimensions, ...measures]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const ref = resolveCustomFieldRef(raw as Record<string, unknown>);
    if (ref !== null) fieldRefs.add(ref);
  }
  const referencedFields = [...fieldRefs].sort();

  const node: Node = {
    id: nodeId,
    type: 'WaveXmd',
    apiName,
    label: dataset ?? apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      application: optionalString(rootObj, 'application'),
      dataset,
      datasetConnector: optionalString(rootObj, 'datasetConnector'),
      datasetFullyQualifiedName: optionalString(rootObj, 'datasetFullyQualifiedName'),
      origin: optionalString(rootObj, 'origin'),
      xmdType: optionalString(rootObj, 'type'),
      waveVisualization: optionalString(rootObj, 'waveVisualization'),
      dimensionCount: dimensions.length,
      measureCount: measures.length,
      dateCount: dates.length,
      ...(referencedFields.length > 0 ? { referencedFields } : {}),
    },
  };

  const edges: Edge[] = referencedFields.map((objectField) => ({
    fromId: nodeId,
    toId: `CustomField:${objectField}`,
    edgeType: 'references',
    confidence: 'declared',
    source: WAVE_XMD_EXTRACTOR_SOURCE,
    properties: { referenceKind: 'waveXmdFieldCustomization' },
  }));

  return ok({ nodes: [node], edges });
};
