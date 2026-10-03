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

import { extractProcessDataPack, isDataPackSource } from './datapack-extract.js';
import { type ApexRemoteCall, apexRemoteTarget, buildApexRemoteEdges, literalObjectArgs } from './omnistudio/remote.js';
import { deriveComponentApiName } from './path-utils.js';

/**
 * v3.2 OmniScript extractor.
 *
 * Reads a single Salesforce Industries `*.os-meta.xml` file (the user-facing
 * no-code form flow primitive) and produces:
 *
 *   - One `Node` of type `'OmniScript'` carrying the metadata header
 *     (identity, version, language, type discriminators) plus a count
 *     summary of the body's `<omniProcessElements>` (steps, actions,
 *     widgets) — see `properties` keys per `OmniScript.md`.
 *   - Zero-to-many `dispatchesOmniAction` edges, one per child element
 *     that names an `integrationProcedureKey` (target =
 *     `OmniIntegrationProcedure:{integrationProcedureKey}`) or a DataMapper
 *     `bundle` (any type: DataRaptor Extract / Transform / Post / Turbo
 *     Action; target = `OmniDataTransform:{bundle}`), or a `Navigate Action` with a
 *     `propertySetConfig.targetType === 'OmniScript'` (target =
 *     `OmniScript:{omniType.Name}` / `targetId`). An Edit Block's
 *     `deleteIPKey` / `saveIPKey` properties (target =
 *     `OmniIntegrationProcedure:{key}`, `properties.via` names which) and an
 *     embedded `OmniScript` element (target =
 *     `OmniScript:{Type}/{Sub Type}/{Language}`) emit the same edge type.
 *     Every target is the caller's KEY; the graph import resolves it onto
 *     the versioned node that runs (`@sf-intelligence/graph` omni-resolve).
 *   - `callsApex` edges, one per Apex class named by an element's
 *     `remoteClass` (Remote Action, Calculation Action, File upload, …),
 *     with every routed `remoteMethod` in `methods[]` and every call site in
 *     `callSites[]` (`omnistudio/remote.ts`).
 *
 * The XML body's `<omniProcessElements>` carry a per-child
 * `<propertySetConfig>` HTML-entity-escaped JSON blob. fast-xml-parser
 * with the default `processEntities` (decoding `&quot;` etc.) returns
 * the JSON as a plain string; the extractor then `JSON.parse()`s it.
 * Malformed JSON in a single child becomes a per-element warning rather
 * than a whole-file failure — the v3.2 honesty axis says best-effort
 * JSON parsing.
 *
 * The `OmniScript` XML root is shared with `OmniIntegrationProcedure`
 * via the legacy `<isIntegrationProcedure>` boolean inside the file. v3.2's
 * extractor branches at the top-level `<omniProcessType>` and `<isIntegrationProcedure>`
 * flags — the extractor here only emits nodes for OmniScript (i.e.,
 * `<isIntegrationProcedure>false</isIntegrationProcedure>` AND
 * `<omniProcessType>OmniScript</omniProcessType>`). Integration Procedure
 * files (when found under `omniIntegrationProcedures/`) are handled by
 * the sibling `omni-integration-procedure` extractor.
 *
 * @see docs/vendor/salesforce-metadata/OmniScript.md
 * @see PLAN-v3.2.md §3 (contracts), §4 (composing tool), §7 Q176.
 */
const OMNISCRIPT_FILE_SUFFIX = '.os-meta.xml';
const ROOT_ELEMENT = 'OmniScript';
const EDGE_SOURCE = 'omniscript-extractor';

/**
 * Element `type` discriminants that imply a dispatch (a missing target on
 * these is warned). Targets are read universally — ANY element naming an
 * `integrationProcedureKey`, a DataMapper `bundle` or a `remoteClass` emits
 * its edge, whatever its type (a Navigate Action invoking an IP, a
 * DataRaptor Post / Turbo Action writing or reading directly from the
 * screen, a File element uploading through Apex).
 */
const EDGE_EMITTING_TYPES = new Set<string>([
  'Integration Procedure Action',
  'DataRaptor Extract Action',
  'DataRaptor Transform Action',
  'DataRaptor Post Action',
  'DataRaptor Turbo Action',
  'Navigate Action',
]);

/** Element types that must name a DataMapper `bundle` (a missing one is warned). */
const DATAMAPPER_ACTION_TYPES = new Set<string>([
  'DataRaptor Extract Action',
  'DataRaptor Transform Action',
  'DataRaptor Post Action',
  'DataRaptor Turbo Action',
]);

/**
 * Edit Block properties that name an Integration Procedure the block calls
 * server-side: the per-card delete and the per-card save. They live in the
 * block's own `propertySetConfig`, not on a child action element.
 */
const EDIT_BLOCK_IP_KEYS = ['deleteIPKey', 'saveIPKey'] as const;

/** Element `type` of an OmniScript embedded inside another OmniScript. */
const EMBEDDED_OMNISCRIPT_TYPE = 'OmniScript';

/**
 * Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence
 * children. The parser emits an array when an element appears multiple
 * times and a scalar/object otherwise; OmniScript's identity elements
 * (`<uniqueName>`, `<omniProcessType>`, etc.) are single-occurrence.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * `undefined`/`null`, the value itself when already an array, or a
 * single-element array otherwise. Used for `<omniProcessElements>` and
 * its nested `<childElements>` — both can appear any number of times.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Coerce an XML scalar element to a nullable string. */
const toNullableString = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  if (v === undefined || v === null) return null;
  // fast-xml-parser may surface `<x xsi:nil="true"/>` as an empty object;
  // treat any non-string-coercible scalar as `null`.
  if (typeof v === 'object') return null;
  const s = String(v);
  return s.length > 0 ? s : null;
};

/** Coerce an XML scalar to boolean; non-`true` values become false. */
const coerceBoolean = (value: unknown): boolean => {
  const v = unwrapSingle(value);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
};

/** Coerce an XML scalar to a finite number; returns `null` when not parseable. */
const toNullableNumber = (value: unknown): number | null => {
  const v = unwrapSingle(value);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

/**
 * Best-effort parse of an HTML-entity-escaped JSON string from the XML.
 * fast-xml-parser (with default `processEntities`) decodes `&quot;` into
 * `"` so the input here is plain JSON; the only failure mode is
 * occasional Salesforce exporter quirks (rare but documented in
 * `OmniScript.md` "honesty boundaries"). Failures produce `null` and
 * append a warning rather than aborting extraction.
 */
const parsePropertySetConfig = (
  raw: unknown,
  warnings: string[],
  contextLabel: string,
): Readonly<Record<string, unknown>> | null => {
  const v = unwrapSingle(raw);
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    // Already an object (fast-xml-parser sometimes structures empty
    // JSON-shaped blobs); take it verbatim.
    if (typeof v === 'object') return v as Readonly<Record<string, unknown>>;
    return null;
  }
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Readonly<Record<string, unknown>>;
    }
    return null;
  } catch (cause: unknown) {
    warnings.push(
      `failed to parse propertySetConfig JSON at ${contextLabel}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return null;
  }
};

interface ParsedElement {
  readonly name: string | null;
  readonly type: string | null;
  readonly level: number | null;
  readonly sequenceNumber: number | null;
  readonly isActive: boolean;
  readonly propertySetConfig: Readonly<Record<string, unknown>> | null;
}

/**
 * Recursively walk the `<omniProcessElements>` tree (which may carry
 * nested `<childElements>`) and flatten every node into a single list.
 * The walk preserves source order so call sites can iterate
 * deterministically; v3.2 doesn't sort here (consumers re-sort by
 * `sequenceNumber` per the tool spec).
 *
 * Each element's `<propertySetConfig>` is JSON-parsed at walk time so
 * the same parsed object can be reused by the edge-emission pass.
 */
const collectElements = (
  rootObj: Record<string, unknown>,
  warnings: string[],
): ParsedElement[] => {
  const flat: ParsedElement[] = [];
  const walk = (raw: unknown, depth: number): void => {
    for (const entry of toArray(raw)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const obj = entry as Record<string, unknown>;
      const name = toNullableString(obj['name']);
      const type = toNullableString(obj['type']);
      const level = toNullableNumber(obj['level']);
      const sequenceNumber = toNullableNumber(obj['sequenceNumber']);
      const isActive = coerceBoolean(obj['isActive']);
      const propertySetConfig = parsePropertySetConfig(
        obj['propertySetConfig'],
        warnings,
        `element[name=${name ?? '?'}, depth=${depth}]`,
      );
      flat.push({
        name,
        type,
        level,
        sequenceNumber,
        isActive,
        propertySetConfig,
      });
      // Recurse into nested `<childElements>` — OmniScript Step / Block /
      // Edit Block containers carry their child widgets there.
      walk(obj['childElements'], depth + 1);
    }
  };
  walk(rootObj['omniProcessElements'], 0);
  return flat;
};

/**
 * Walk every parsed element and emit `dispatchesOmniAction` edges per
 * the rules in `OmniScript.md` §"Edge emission rules":
 *
 *   - Integration Procedure Action → target =
 *     `OmniIntegrationProcedure:{integrationProcedureKey}`. The key
 *     lives inside the propertySetConfig JSON. Confidence: `parsed`.
 *   - Any element naming a DataMapper `bundle` (DataRaptor Extract /
 *     Transform / Post / Turbo Action) → target = `OmniDataTransform:{bundle}`.
 *     The bundle name lives inside the propertySetConfig JSON. Confidence:
 *     `parsed`.
 *   - Any element naming a `remoteClass` → one aggregated `callsApex` edge
 *     per Apex class (`omnistudio/remote.ts`).
 *   - Navigate Action with `targetType === 'OmniScript'` → target =
 *     `OmniScript:{omniType.Name | targetId}`. Confidence: `parsed`.
 *     (Most navigate actions target Web Pages and emit no edge.)
 *
 * Edges carry the calling element's `name`, `type`, `level`, and
 * `sequenceNumber` as properties so impact-analysis tools can locate
 * the dispatch within the flow.
 */
const buildDispatchEdges = (
  omniScriptId: string,
  elements: readonly ParsedElement[],
  warnings: string[],
): Edge[] => {
  const edges: Edge[] = [];
  const apexCalls: ApexRemoteCall[] = [];
  for (const el of elements) {
    const cfg = el.propertySetConfig;
    // Any element naming a `remoteClass` runs that Apex class (a Remote
    // Action, a Calculation Action, a File upload). Aggregated into one
    // `callsApex` edge per class after the loop.
    if (cfg !== null) {
      const apexTarget = apexRemoteTarget(cfg['remoteClass']);
      if (apexTarget !== null) {
        apexCalls.push({
          target: apexTarget,
          remoteMethod: typeof cfg['remoteMethod'] === 'string' ? cfg['remoteMethod'] : null,
          site: el.name ?? '',
          siteType: el.type ?? '',
          objectArgs: literalObjectArgs(cfg),
        });
      }
    }
    // An Edit Block calls IPs through PROPERTIES of the block itself, not
    // through a child element: `deleteIPKey` (the server delete behind the
    // card's Delete button) and `saveIPKey` (the per-card save). Without
    // these edges a script whose cards delete through `deleteIPKey` showed
    // no dependency on that IP at all.
    if (el.type === 'Edit Block' && cfg !== null) {
      for (const via of EDIT_BLOCK_IP_KEYS) {
        const raw = cfg[via];
        if (typeof raw !== 'string' || raw.trim().length === 0) continue;
        const key = raw.trim();
        edges.push({
          fromId: omniScriptId,
          toId: `OmniIntegrationProcedure:${key}`,
          edgeType: 'dispatchesOmniAction',
          confidence: 'parsed',
          source: EDGE_SOURCE,
          properties: {
            stepName: el.name,
            stepType: el.type,
            level: el.level,
            sequenceNumber: el.sequenceNumber,
            targetRawName: key,
            via,
          },
        });
      }
    }
    // An embedded OmniScript element runs another OmniScript inline; it
    // names it by Type / Sub Type / Language (the import resolves that key
    // to the active version).
    if (el.type === EMBEDDED_OMNISCRIPT_TYPE && cfg !== null) {
      const t = typeof cfg['Type'] === 'string' ? cfg['Type'].trim() : '';
      const s = typeof cfg['Sub Type'] === 'string' ? cfg['Sub Type'].trim() : '';
      const l = typeof cfg['Language'] === 'string' ? cfg['Language'].trim() : '';
      if (t.length > 0 && s.length > 0 && l.length > 0) {
        const target = `${t}/${s}/${l}`;
        edges.push({
          fromId: omniScriptId,
          toId: `OmniScript:${target}`,
          edgeType: 'dispatchesOmniAction',
          confidence: 'parsed',
          source: EDGE_SOURCE,
          properties: {
            stepName: el.name,
            stepType: el.type,
            level: el.level,
            sequenceNumber: el.sequenceNumber,
            targetRawName: target,
            via: 'embeddedOmniScript',
          },
        });
      } else {
        warnings.push(
          `embedded OmniScript "${el.name ?? '?'}" does not name Type / Sub Type / Language`,
        );
      }
      continue;
    }
    // An `integrationProcedureKey` is an unambiguous IP invocation. It appears
    // on `Integration Procedure Action` steps AND on other element types — e.g.
    // a Step or a "Next" Navigate Action that invokes an IP (the key lives in
    // that element's propertySetConfig; the Navigate block below only looks at
    // targetType, so such IP-carrying navigates were silently dropped). Emit
    // the dispatch edge whenever the key is present, regardless of the
    // element's display type, so the OmniScript→IP dependency is never hidden.
    // A DataMapper `bundle` is read the same way (any element type);
    // Navigate-to-OmniScript dispatches stay keyed on their type.
    const ipKeyRaw = cfg === null ? undefined : cfg['integrationProcedureKey'];
    const ipKey =
      typeof ipKeyRaw === 'string' && ipKeyRaw.length > 0 ? ipKeyRaw : null;
    const bundleRaw = cfg === null ? undefined : cfg['bundle'];
    const hasBundle = typeof bundleRaw === 'string' && bundleRaw.length > 0;
    if (el.type === null || (!EDGE_EMITTING_TYPES.has(el.type) && ipKey === null && !hasBundle)) {
      continue;
    }
    if (cfg === null) {
      // Element type implies a dispatch but the JSON didn't parse;
      // already logged by parsePropertySetConfig. No edge.
      continue;
    }
    if (ipKey !== null) {
      edges.push({
        fromId: omniScriptId,
        toId: `OmniIntegrationProcedure:${ipKey}`,
        edgeType: 'dispatchesOmniAction',
        confidence: 'parsed',
        source: EDGE_SOURCE,
        properties: {
          stepName: el.name,
          stepType: el.type,
          level: el.level,
          sequenceNumber: el.sequenceNumber,
          targetRawName: ipKey,
        },
      });
      // An element can name both an IP and a DataMapper (rare); keep going
      // so the bundle edge below is not lost.
      if (!hasBundle) continue;
    }
    if (el.type === 'Integration Procedure Action' && ipKey === null) {
      // Declared an IP Action but carried no integrationProcedureKey.
      warnings.push(
        `Integration Procedure Action "${el.name ?? '?'}" has no integrationProcedureKey`,
      );
      continue;
    }
    if (hasBundle || DATAMAPPER_ACTION_TYPES.has(el.type)) {
      const bundle = cfg['bundle'];
      if (typeof bundle === 'string' && bundle.length > 0) {
        edges.push({
          fromId: omniScriptId,
          toId: `OmniDataTransform:${bundle}`,
          edgeType: 'dispatchesOmniAction',
          confidence: 'parsed',
          source: EDGE_SOURCE,
          properties: {
            stepName: el.name,
            stepType: el.type,
            level: el.level,
            sequenceNumber: el.sequenceNumber,
            targetRawName: bundle,
          },
        });
      } else {
        warnings.push(
          `${el.type} "${el.name ?? '?'}" has no bundle`,
        );
      }
      continue;
    }
    if (el.type === 'Navigate Action') {
      // Navigate Actions overwhelmingly target Web Page; only emit when
      // the targetType says OmniScript per the spec.
      const targetType = cfg['targetType'];
      if (typeof targetType !== 'string' || targetType !== 'OmniScript') {
        continue;
      }
      // Resolve target via `omniType.Name` (preferred) or `targetId`.
      const omniType = cfg['omniType'];
      let target: string | null = null;
      if (
        typeof omniType === 'object' &&
        omniType !== null &&
        typeof (omniType as Record<string, unknown>)['Name'] === 'string'
      ) {
        target = String((omniType as Record<string, unknown>)['Name']);
      }
      if (target === null) {
        const targetId = cfg['targetId'];
        if (typeof targetId === 'string' && targetId.length > 0) {
          target = targetId;
        }
      }
      if (target !== null && target.length > 0) {
        edges.push({
          fromId: omniScriptId,
          toId: `OmniScript:${target}`,
          edgeType: 'dispatchesOmniAction',
          confidence: 'parsed',
          source: EDGE_SOURCE,
          properties: {
            stepName: el.name,
            stepType: el.type,
            level: el.level,
            sequenceNumber: el.sequenceNumber,
            targetRawName: target,
          },
        });
      }
    }
  }
  return [...edges, ...buildApexRemoteEdges(omniScriptId, apexCalls, EDGE_SOURCE)];
};

/**
 * Deduplicate edges by `(fromId, toId, edgeType, source)` and sort for
 * stable byte-equal test output: by `toId` ascending, then `edgeType`
 * ascending. The first occurrence's `properties` payload wins.
 */
const dedupeAndSortEdges = (edges: readonly Edge[]): Edge[] => {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const edge of edges) {
    const key = `${edge.fromId}|${edge.toId}|${edge.edgeType}|${edge.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  out.sort((a, b) => {
    if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
    if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
    return 0;
  });
  return out;
};

/**
 * Read and strictly-validate a file as XML. Validates before parsing so
 * malformed input surfaces as `parse-error` (fast-xml-parser's
 * `parse()` silently truncates on mismatched tags).
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

/** Locate and validate the `<OmniScript>` root. */
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
  return ok(root as Record<string, unknown>);
};

/**
 * Extract a single Salesforce Industries OmniScript (`.os-meta.xml`)
 * file into a Node + zero-to-many `dispatchesOmniAction` edges.
 *
 * Defensive: per-element JSON parse failures collect into
 * `node.properties.omniScriptExtractionWarnings` rather than failing
 * the whole extraction. The root-element check still hard-fails.
 *
 * Edge emission per `OmniScript.md` §"Edge emission rules":
 *   - Integration Procedure Action → `OmniIntegrationProcedure:{key}`
 *   - DataRaptor Extract/Transform Action → `OmniDataTransform:{bundle}`
 *   - Navigate Action (targetType === 'OmniScript') → `OmniScript:{name}`
 *
 * All `dispatchesOmniAction` edges carry `confidence: 'parsed'` because
 * the target names live inside the HTML-entity-escaped JSON blob, not
 * top-level XML elements.
 *
 * @example
 *   const result = await extractOmniScript(
 *     'force-app/main/default/omniScripts/Acme_Enrollment_English_1.os-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'OmniScript:Acme_Enrollment_English_1'
 *   }
 */
export const extractOmniScript = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  // A managed-package (Vlocity) export: a DataPack folder or its main file.
  if (await isDataPackSource(path)) return extractProcessDataPack(path, 'OmniScript', extractOmniScriptRoot);
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 and
  // even the 10000 used by Flow / Profile are too tight for legitimate
  // OmniScripts — the embedded `propertySetConfig` JSON blobs are
  // dense with `&quot;` entity references and large production scripts
  // (5k+ lines, like Globex's `Income_HouseholdIncome_English_2`)
  // routinely cross 10000. Raised to 100000 to accept real-world
  // scripts while preserving a pathological-input ceiling. Matches the
  // sibling `omni-integration-procedure` extractor.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 100000 },
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

  const rootResult = validateRoot(parsed, path);
  if (!rootResult.ok) return rootResult;
  return extractOmniScriptRoot(rootResult.value, path, deriveComponentApiName(path, OMNISCRIPT_FILE_SUFFIX));
};

/**
 * The extraction over the parsed `<OmniScript>` root — the seam a converted
 * source (a managed-package DataPack) enters through. `apiName` is the
 * component's file-stem name (`Type_SubType_Language_Version`).
 */
export const extractOmniScriptRoot = (
  rootObj: Record<string, unknown>,
  path: string,
  apiName: string,
): Result<ExtractionResult, ExtractorError> => {
  // The OmniScript XML root is shared with OmniIntegrationProcedure;
  // an IP file declares `<isIntegrationProcedure>true</...>` and
  // `<omniProcessType>Integration Procedure</...>`. Skip those — the
  // sibling extractor handles them. Files routed here from
  // `omniScripts/` shouldn't carry the flag, but a defensive check
  // keeps the dispatcher's contract crisp.
  if (coerceBoolean(rootObj['isIntegrationProcedure'])) {
    return err({
      kind: 'malformed-input',
      path,
      message:
        'file declares <isIntegrationProcedure>true</isIntegrationProcedure>; OmniIntegrationProcedure handles this',
    });
  }

  // The canonical id and api-name come from the filename per the v3.2
  // convention (the XML's `<uniqueName>` should match — surfaced as a
  // property for the rare case where it doesn't, so downstream tools
  // can flag drift).
  const omniScriptId = `${ROOT_ELEMENT}:${apiName}`;

  const warnings: string[] = [];
  const elements = collectElements(rootObj, warnings);
  const rawEdges = buildDispatchEdges(omniScriptId, elements, warnings);
  const edges = dedupeAndSortEdges(rawEdges);

  // Top-level `<propertySetConfig>` carries the OmniScript-level UI
  // configuration (persistent components, save-for-later, knowledge,
  // stylesheets). v3.2 surfaces a few well-known keys as properties;
  // the rest is available through the v3.2 R3 MCP tool's
  // `includeChildPropertySetConfig` flag.
  const topPsc = parsePropertySetConfig(
    rootObj['propertySetConfig'],
    warnings,
    'top-level',
  );

  const nameLabel = toNullableString(rootObj['name']);
  const uniqueName = toNullableString(rootObj['uniqueName']);
  const omniProcessType = toNullableString(rootObj['omniProcessType']);
  const subType = toNullableString(rootObj['subType']);
  const type = toNullableString(rootObj['type']);
  const language = toNullableString(rootObj['language']);
  const versionNumber = toNullableNumber(rootObj['versionNumber']);

  // OmniProcess key is the `{Type}_{SubType}` shape used by Integration
  // Procedure Actions to reference an OmniScript. For an OmniScript the
  // key conventionally equals `${type}_${subType}` when both are
  // present; v3.2 surfaces it verbatim per the doc, falling back to
  // `null` when either field is missing.
  const omniProcessKey =
    type !== null && subType !== null ? `${type}_${subType}` : null;

  const node: Node = {
    id: omniScriptId,
    type: 'OmniScript',
    apiName,
    label: nameLabel,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      omniProcessType,
      omniProcessKey,
      uniqueName,
      versionNumber,
      language,
      subType,
      type,
      name: nameLabel,
      isActive: coerceBoolean(rootObj['isActive']),
      isWebCompEnabled: coerceBoolean(rootObj['isWebCompEnabled']),
      isOmniScriptEmbeddable: coerceBoolean(rootObj['isOmniScriptEmbeddable']),
      isMetadataCacheDisabled: coerceBoolean(rootObj['isMetadataCacheDisabled']),
      isManagedUsingStdDesigner: coerceBoolean(
        rootObj['isManagedUsingStdDesigner'],
      ),
      isTestProcedure: coerceBoolean(rootObj['isTestProcedure']),
      elementCount: elements.length,
      // Top-level propertySetConfig — well-known UI keys, surfaced as
      // properties so callers don't have to re-parse the blob. When
      // the blob didn't parse or a key isn't present, the value is null.
      allowSaveForLater:
        topPsc !== null && typeof topPsc['allowSaveForLater'] === 'boolean'
          ? topPsc['allowSaveForLater']
          : null,
      enableKnowledge:
        topPsc !== null && typeof topPsc['enableKnowledge'] === 'boolean'
          ? topPsc['enableKnowledge']
          : null,
      currentLanguage:
        topPsc !== null && typeof topPsc['currentLanguage'] === 'string'
          ? topPsc['currentLanguage']
          : null,
      scrollBehavior:
        topPsc !== null && typeof topPsc['scrollBehavior'] === 'string'
          ? topPsc['scrollBehavior']
          : null,
      stepChartPlacement:
        topPsc !== null && typeof topPsc['stepChartPlacement'] === 'string'
          ? topPsc['stepChartPlacement']
          : null,
      omniScriptExtractionWarnings: warnings,
    },
  };

  return ok({ nodes: [node], edges });
};
