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
import { canonicalElementType } from './omnistudio/catalog.js';
import { type ApexRemoteCall, apexRemoteTarget, buildApexRemoteEdges, literalObjectArgs } from './omnistudio/remote.js';
import { deriveComponentApiName } from './path-utils.js';

const OIP_FILE_SUFFIX = '.oip-meta.xml';
const ROOT_ELEMENT = 'OmniIntegrationProcedure';
const NODE_TYPE = 'OmniIntegrationProcedure';
const EXTRACTOR_SOURCE = 'omni-integration-procedure';

/**
 * Canonical action types (`omnistudio/catalog.ts`) that call a DataMapper —
 * every spelling (`Data Mapper Load Action`, `DataRaptor Load Action`, …) is
 * compared through {@link canonicalElementType}. Each carries its target's
 * name in `propertySetConfig.bundle`.
 */
const DATARAPTOR_ACTION_TYPES = new Set<string>([
  'DataRaptor Extract Action',
  'DataRaptor Turbo Action',
  'DataRaptor Transform Action',
  'DataRaptor Post Action',
]);

/**
 * Action `type` value that emits a `dispatchesOmniAction` edge to a
 * nested `OmniIntegrationProcedure` target. The target IP's
 * `omniProcessKey` lives in `propertySetConfig.integrationProcedureKey`.
 */
const NESTED_IP_ACTION_TYPE = 'Integration Procedure Action';

/**
 * Canonical action type identifying an HTTP callout (`Rest Action` and
 * `HTTP Request Action` are spellings of it). Surfaced as a REST endpoint
 * property on the IP node (`restEndpoints` array + the derived
 * `restEndpointCount`); does NOT emit a `dispatchesOmniAction` edge (the
 * target is external — its destination is surfaced for composition with
 * v1.5's integration-topology tools downstream).
 */
const REST_ACTION_TYPE = 'HTTP Action';

/** The callout's URL: `restPath` (Rest Action) or `httpUrl` (HTTP Action). */
const restPathOf = (psc: Record<string, unknown> | null): string | null =>
  psc === null ? null : nonEmptyString(psc['restPath']) ?? nonEmptyString(psc['httpUrl']);

/**
 * Action `type` value identifying an Apex callout. Its
 * `propertySetConfig.remoteClass` / `.remoteMethod` name the target. Surfaced
 * as a `remoteActions` property on the IP node AND — like every element that
 * names a `remoteClass` (Try Catch Block failure handlers, Calculation
 * Actions) — as a `callsApex` edge to the class (see `omnistudio/remote.ts`).
 */
const REMOTE_ACTION_TYPE = 'Remote Action';

/**
 * Block-type action containers whose `propertySetConfig` (and/or direct
 * `omniProcessElements` child) nests further `<omniProcessElements>`.
 * The action walk recurses into these so actions buried inside a
 * Conditional / Loop / Cache / Try-Catch Block are not invisible. The
 * set is advisory only — the walk recurses into ANY discovered nested
 * `omniProcessElements` array regardless of the parent `type`, so an
 * unrecognised future block type still gets descended.
 */
const BLOCK_ACTION_TYPES = new Set<string>([
  'Conditional Block',
  'Loop Block',
  'Cache Block',
  'Try Catch Block',
]);

/**
 * Depth cap on the recursive action walk. Mirrors the depth-10 ceiling
 * the v2.8 async-chain walker uses (`async_chain_depth`); a Block
 * nesting deeper than this is pathological (the OmniStudio designer
 * caps practical nesting well below 10) and is silently truncated
 * rather than risking unbounded recursion on a hand-edited cyclic blob.
 */
const ACTION_WALK_MAX_DEPTH = 10;

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. fast-xml-parser
 * emits an object when an element appears once and an array when it
 * appears multiple times. IP `<omniProcessElements>` may appear any
 * number of times, so the action walker consumes an array.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Coerce an XML scalar to boolean; non-`true` values become false (per SF defaults). */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/** Coerce an XML scalar to a finite number, or `0` when unparseable. */
const coerceNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

/** Return a trimmed non-empty string, or `null` if blank. */
const nonEmptyString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
};

/**
 * Return `<element>` value as a trimmed non-empty string, or `null`
 * when absent or empty. fast-xml-parser turns `<element xsi:nil="true"/>`
 * into an empty string; we collapse that to `null` so degenerate stub
 * IPs (4 in the Globex corpus, all-`xsi:nil` shells) surface as
 * `properties.omniProcessKey: null` rather than as the empty-string
 * sentinel.
 */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  return nonEmptyString(unwrapSingle(rootObj[key]));
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

/**
 * Locate the `<OmniIntegrationProcedure>` root. Only the root tag is
 * required; every body element is optional and surfaces as `null`
 * when missing. This matches the real-world corpus where degenerate
 * stub IPs ship with all metadata elements `xsi:nil="true"` (the
 * Globex corpus has 4 such files); they are still legitimate
 * components that callers may need to flag for cleanup, so we surface
 * them as nodes rather than rejecting them.
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
  return ok(root as Record<string, unknown>);
};

/**
 * Parse the `propertySetConfig` JSON blob inside an action child. The
 * source XML carries HTML-entity-escaped JSON (`&quot;` everywhere);
 * fast-xml-parser's `processEntities` decodes those before we see the
 * string, so a straight `JSON.parse` works on the unwrapped value.
 *
 * Returns `null` when the blob is absent, empty, or unparseable.
 * Malformed blobs are rare (Salesforce's exporter is reliable) but
 * surface as `null` rather than aborting the extraction — per the
 * v3.2 "best-effort propertySetConfig parsing" axis.
 */
const parsePropertySetConfig = (raw: unknown): Record<string, unknown> | null => {
  const value = unwrapSingle(raw);
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * One outbound REST callout surfaced from a `Rest Action` child. Decoded
 * verbatim from the action's `propertySetConfig` JSON blob:
 *   - `stepName` — the action's `<name>` (`''` when absent).
 *   - `path` — `propertySetConfig.restPath` (the callout URL / path).
 *   - `method` — `propertySetConfig.restMethod` (`GET`/`POST`/… or
 *     `null` when the blob omits it).
 *   - `namedCredential` — `propertySetConfig.namedCredential` (the host
 *     alias, e.g. `callout:My_NC`), falling back to the legacy
 *     `restNamedCredential` key; `null` when neither is present.
 *
 * Surfaced on the IP node's `properties.restEndpoints` so
 * `endpoint_catalog` / `integration_map` can render the org's
 * OmniStudio outbound callout surface without re-walking the XML.
 */
export interface RestEndpoint {
  readonly stepName: string;
  readonly path: string;
  readonly method: string | null;
  readonly namedCredential: string | null;
}

/**
 * One Apex callout surfaced from a `Remote Action` child:
 *   - `stepName` — the action's `<name>` (`''` when absent).
 *   - `remoteClass` — `propertySetConfig.remoteClass` (the Apex class).
 *   - `remoteMethod` — `propertySetConfig.remoteMethod` (`null` when
 *     the blob omits it).
 *
 * Surfaced on the IP node's `properties.remoteActions` (the data surface
 * `integration_map` reads). The dependency itself is the `callsApex` edge the
 * walk emits for every element naming a `remoteClass`.
 */
export interface RemoteAction {
  readonly stepName: string;
  readonly remoteClass: string;
  readonly remoteMethod: string | null;
}

/**
 * Result of walking the IP's action chain. `edges` holds the
 * `dispatchesOmniAction` edges emitted for DataRaptor and nested-IP
 * action children (found at ANY nesting depth post-recursion). The
 * counts + payload arrays feed the IP node's properties
 * (`restEndpointCount`/`restEndpoints`, `dataRaptorCount`,
 * `chainedIpCount`, `remoteActions`).
 */
interface ActionWalk {
  readonly edges: readonly Edge[];
  readonly restEndpoints: readonly RestEndpoint[];
  readonly remoteActions: readonly RemoteAction[];
  readonly dataRaptorCount: number;
  readonly chainedIpCount: number;
  readonly elementCount: number;
}

/**
 * Collect every nested child-action array reachable from a single
 * Block-type element. OmniStudio's exporter nests child actions in a few
 * shapes, and a real-world Block may use any of them:
 *
 *   1. A direct `<childElements>` child element — the shape real
 *      `sf project retrieve` output actually uses (a Conditional/Loop/etc.
 *      Block holds its nested actions under `<childElements>`). Some
 *      exports use a nested `<omniProcessElements>` instead; accept both.
 *   2. Inside the decoded `propertySetConfig` JSON, where the designer
 *      stores children under `children[].eleArray[]` (the runtime
 *      shape) or a flat `propertySetConfig.omniProcessElements`.
 *
 * All are unwrapped to `Record<string,unknown>` element objects so the
 * walk treats a nested action identically to a top-level one.
 */
const collectNestedElements = (
  element: Record<string, unknown>,
  psc: Record<string, unknown> | null,
): Record<string, unknown>[] => {
  const nested: Record<string, unknown>[] = [];
  const push = (value: unknown): void => {
    for (const child of toArray(value)) {
      if (typeof child === 'object' && child !== null) {
        nested.push(child as Record<string, unknown>);
      }
    }
  };

  // Shape 1: direct XML child elements. Real `sf project retrieve` output
  // nests a Block's children under `<childElements>` — most IPs sit inside
  // `childElements`, invisible to an `omniProcessElements`-only descent.
  // Some exports use a nested `<omniProcessElements>` instead; accept both.
  push(element['childElements']);
  push(element['omniProcessElements']);

  // Shape 2: decoded-JSON children. `children` is an array of
  // `{ eleArray: [...] }`; some exports also carry a flat
  // `omniProcessElements` inside the blob.
  if (psc !== null) {
    push(psc['omniProcessElements']);
    for (const group of toArray(psc['children'])) {
      if (typeof group === 'object' && group !== null) {
        push((group as Record<string, unknown>)['eleArray']);
      }
    }
  }

  return nested;
};

/**
 * Resolve the target-identity segment of an action's dedupe key from
 * its decoded `propertySetConfig`. Each edge-/payload-emitting action
 * type keys on a different field (REST → `restPath`, DataRaptor →
 * `bundle`, nested IP → `integrationProcedureKey`, Remote →
 * `remoteClass`); leaf / block types contribute no target. Returns `''`
 * when the blob is absent or the keyed field is empty, so the dedupe
 * key still distinguishes such actions by `(type, name, sequence)`.
 */
const resolveTargetKey = (
  actionType: string,
  psc: Record<string, unknown> | null,
): string => {
  if (psc === null) return '';
  const kind = canonicalElementType(actionType);
  if (kind === REST_ACTION_TYPE) {
    return restPathOf(psc) ?? '';
  }
  if (DATARAPTOR_ACTION_TYPES.has(kind)) {
    return nonEmptyString(psc['bundle']) ?? '';
  }
  if (kind === NESTED_IP_ACTION_TYPE) {
    return nonEmptyString(psc['integrationProcedureKey']) ?? '';
  }
  if (kind === REMOTE_ACTION_TYPE) {
    return nonEmptyString(psc['remoteClass']) ?? '';
  }
  return '';
};

/**
 * Mutable accumulator threaded through the recursive walk. Edges and
 * payload arrays are appended in encounter order; the caller sorts the
 * payload arrays deterministically afterwards.
 */
interface WalkAccumulator {
  readonly edges: Edge[];
  readonly restEndpoints: RestEndpoint[];
  readonly remoteActions: RemoteAction[];
  /** Every element that names a `remoteClass` — aggregated into `callsApex` edges after the walk. */
  readonly apexCalls: ApexRemoteCall[];
  /** Delete Action targets: object → steps that delete its records. */
  readonly deletes: Map<string, { stepName: string; recordId: string | null }[]>;
  readonly seen: Set<string>;
  dataRaptorCount: number;
  chainedIpCount: number;
  elementCount: number;
}

/**
 * Recursively walk a list of `<omniProcessElements>`, classify each by
 * `<type>`, emit `dispatchesOmniAction` edges for the documented
 * target-resolving keys, and accumulate the Rest / Remote callout
 * payloads. Descends into Block-type elements (Conditional / Loop /
 * Cache / Try-Catch Blocks nest child actions) — and into ANY element
 * that exposes a nested `omniProcessElements` array — so an action
 * buried inside a Block is no longer invisible. Without this descent
 * the bulk of the Globex corpus's IP actions (and their Rest / Remote /
 * DataRaptor / nested-IP surface) were never seen.
 *
 * Depth-bounded at {@link ACTION_WALK_MAX_DEPTH}; a Block nested deeper
 * is silently truncated. Deduped on a per-action key
 * (`type|stepName|sequenceNumber|targetKey`) so the same action reached
 * twice (e.g. a malformed blob that re-lists a child) is counted once.
 *
 * The `sequenceNumber` is surfaced verbatim into the edge properties so
 * impact-analysis tools can preserve the action ordering when rendering
 * the chain. Numeric coercion uses {@link coerceNumber}; a missing
 * `sequenceNumber` lands as `0` (the XML never carries a negative one).
 *
 * Edge confidence is `parsed` because the target identity lives inside
 * the `propertySetConfig` JSON blob; the per-doc "declared" branch
 * (top-level XML `<bundle>` siblings) is rare on Native IPs and is not
 * exercised on the Globex corpus.
 */
const walkElements = (
  elements: readonly unknown[],
  ipNodeId: string,
  depth: number,
  acc: WalkAccumulator,
): void => {
  for (const raw of elements) {
    if (typeof raw !== 'object' || raw === null) continue;
    const element = raw as Record<string, unknown>;
    const actionType = nonEmptyString(unwrapSingle(element['type']));
    if (actionType === null) continue;
    const stepName = nonEmptyString(unwrapSingle(element['name'])) ?? '';
    const sequenceNumber = coerceNumber(unwrapSingle(element['sequenceNumber']));
    const psc = parsePropertySetConfig(element['propertySetConfig']);

    // Dedupe key: same type + name + sequence + resolved target. Two
    // distinct REST steps with the same name but different paths stay
    // distinct (the path is folded into the target segment via
    // `resolveTargetKey`).
    const targetKey = resolveTargetKey(actionType, psc);
    const dedupeKey = `${actionType}\0${stepName}\0${sequenceNumber}\0${targetKey}`;
    const alreadySeen = acc.seen.has(dedupeKey);
    if (!alreadySeen) {
      acc.seen.add(dedupeKey);
      acc.elementCount += 1;
    }

    // A `bundle` (DataRaptor) or `integrationProcedureKey` (nested IP) in ANY
    // element's propertySetConfig is a real dispatch — present on DataRaptor /
    // IP action steps AND embedded in Rest / Remote / Response actions (e.g. a
    // response- or logging-DataRaptor on a callout, the shape real example.gov IPs
    // use). Emit the dependency edge here regardless of the element's
    // actionType so it is never hidden; the type-specific branches below keep
    // only their non-dispatch bookkeeping (restEndpoints, remoteActions).
    if (!alreadySeen && psc !== null) {
      const bundle = nonEmptyString(psc['bundle']);
      if (bundle !== null) {
        acc.dataRaptorCount += 1;
        acc.edges.push({
          fromId: ipNodeId,
          toId: `OmniDataTransform:${bundle}`,
          edgeType: 'dispatchesOmniAction',
          confidence: 'parsed',
          source: EXTRACTOR_SOURCE,
          properties: { stepName, stepType: actionType, bundle, sequenceNumber },
        });
      }
      // Any element naming a `remoteClass` runs that Apex class — a Remote
      // Action, a Try Catch Block's failure handler, a Calculation Action. The
      // call sites are aggregated into one `callsApex` edge per class after the
      // walk, so dead-code / impact / usage tools see the OmniStudio caller.
      const apexTarget = apexRemoteTarget(psc['remoteClass']);
      if (apexTarget !== null) {
        acc.apexCalls.push({
          target: apexTarget,
          remoteMethod: typeof psc['remoteMethod'] === 'string' ? psc['remoteMethod'] : null,
          site: stepName,
          siteType: actionType,
          objectArgs: literalObjectArgs(psc),
        });
      }
      // A Delete Action names the SObject type of every record it deletes
      // (`deleteSObject[].Type`). Emitted as `writesTo` with operation
      // `recordDelete` — the vocabulary Flow delete elements use — so record
      // delete paths are visible to every tool.
      for (const entry of toArray(psc['deleteSObject'])) {
        if (typeof entry !== 'object' || entry === null) continue;
        const type = nonEmptyString((entry as Record<string, unknown>)['Type']);
        if (type === null) continue;
        const object = type.trim();
        const idRaw = (entry as Record<string, unknown>)['Id'];
        acc.deletes.set(object, [
          ...(acc.deletes.get(object) ?? []),
          { stepName, recordId: typeof idRaw === 'string' ? idRaw : null },
        ]);
      }
      const ipKey = nonEmptyString(psc['integrationProcedureKey']);
      if (ipKey !== null) {
        acc.chainedIpCount += 1;
        acc.edges.push({
          fromId: ipNodeId,
          // Keyed by the downstream IP's omniProcessKey; the IP-chain tool
          // resolves it against node properties.omniProcessKey.
          toId: `OmniIntegrationProcedure:${ipKey}`,
          edgeType: 'dispatchesOmniAction',
          confidence: 'parsed',
          source: EXTRACTOR_SOURCE,
          properties: {
            stepName,
            stepType: actionType,
            integrationProcedureKey: ipKey,
            sequenceNumber,
          },
        });
      }
    }

    const kind = canonicalElementType(actionType);
    if (kind === REST_ACTION_TYPE) {
      if (!alreadySeen) {
        const restPath = restPathOf(psc);
        if (restPath !== null) {
          acc.restEndpoints.push({
            stepName,
            path: restPath,
            method: psc === null ? null : nonEmptyString(psc['restMethod']),
            namedCredential:
              psc === null
                ? null
                : nonEmptyString(psc['namedCredential']) ??
                  nonEmptyString(psc['restNamedCredential']),
          });
        }
      }
      // Rest Actions never nest child actions; no recursion.
      continue;
    }

    if (kind === REMOTE_ACTION_TYPE) {
      if (!alreadySeen) {
        const remoteClass =
          psc === null ? null : nonEmptyString(psc['remoteClass']);
        if (remoteClass !== null) {
          acc.remoteActions.push({
            stepName,
            remoteClass,
            remoteMethod:
              psc === null ? null : nonEmptyString(psc['remoteMethod']),
          });
        }
      }
      // The `callsApex` edge comes from the universal `remoteClass` rule
      // above. A Remote Action nests no child actions; no recursion.
      continue;
    }

    if (DATARAPTOR_ACTION_TYPES.has(kind)) {
      // Dispatch edge emitted by the universal block above; DataRaptor actions
      // nest no child elements, so there is nothing to recurse into.
      continue;
    }

    if (kind === NESTED_IP_ACTION_TYPE) {
      // Dispatch edge emitted by the universal block above (keyed by the
      // downstream IP's omniProcessKey). A nested IP Action references another
      // IP by key and does not inline its elements — nothing to recurse into.
      continue;
    }

    // Block-type (and any other) element: descend into nested
    // `omniProcessElements` so actions buried inside a Conditional /
    // Loop / Cache / Try-Catch Block are visible. The descent fires
    // when the element is a KNOWN block type OR when it simply exposes
    // a nested element array — so an unrecognised future block type
    // still gets walked, while a leaf action that happens to carry an
    // unrelated `children` key does not get spuriously descended unless
    // it actually yields elements. Leaf types (`Response Action`,
    // `Set Values Action`, …) expose no nested elements and fall
    // through untouched.
    if (depth < ACTION_WALK_MAX_DEPTH) {
      const nested = collectNestedElements(element, psc);
      if (BLOCK_ACTION_TYPES.has(actionType) || nested.length > 0) {
        walkElements(nested, ipNodeId, depth + 1, acc);
      }
    }
  }
};

/**
 * Walk the IP's full action tree starting at the root
 * `<omniProcessElements>` and return the emitted edges plus the
 * decoded callout payloads. Thin wrapper over {@link walkElements} that
 * seeds the accumulator and applies the deterministic payload sort.
 *
 * Post-recursion, `restEndpointCount` is `restEndpoints.length` (the two
 * always agree) and `elementCount` counts every DISTINCT action across
 * all nesting levels (deduped), which is why a Block's children now
 * contribute to it where the old flat walk only counted top-level
 * elements.
 */
const walkActions = (
  rootObj: Record<string, unknown>,
  ipNodeId: string,
): ActionWalk => {
  const acc: WalkAccumulator = {
    edges: [],
    restEndpoints: [],
    remoteActions: [],
    apexCalls: [],
    deletes: new Map(),
    seen: new Set<string>(),
    dataRaptorCount: 0,
    chainedIpCount: 0,
    elementCount: 0,
  };
  walkElements(toArray(rootObj['omniProcessElements']), ipNodeId, 0, acc);

  // Deterministic ordering: restEndpoints by (stepName, path);
  // remoteActions by (stepName, remoteClass). Stable across runs so the
  // persisted `properties_json` is byte-identical refresh-to-refresh.
  const restEndpoints = [...acc.restEndpoints].sort((a, b) =>
    a.stepName !== b.stepName
      ? a.stepName < b.stepName
        ? -1
        : 1
      : a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0,
  );
  const remoteActions = [...acc.remoteActions].sort((a, b) =>
    a.stepName !== b.stepName
      ? a.stepName < b.stepName
        ? -1
        : 1
      : a.remoteClass < b.remoteClass
        ? -1
        : a.remoteClass > b.remoteClass
          ? 1
          : 0,
  );

  const deleteEdges: Edge[] = [...acc.deletes]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([object, steps]) => ({
      fromId: ipNodeId,
      toId: `CustomObject:${object}`,
      edgeType: 'writesTo' as const,
      confidence: 'parsed' as const,
      source: EXTRACTOR_SOURCE,
      properties: {
        operation: 'recordDelete',
        mechanism: 'omnistudio-delete-action',
        steps: steps.map((x) => x.stepName).sort(),
        recordIds: [...new Set(steps.map((x) => x.recordId).filter((x): x is string => x !== null))].sort(),
      },
    }));
  return {
    edges: [...acc.edges, ...buildApexRemoteEdges(ipNodeId, acc.apexCalls, EXTRACTOR_SOURCE), ...deleteEdges],
    restEndpoints,
    remoteActions,
    dataRaptorCount: acc.dataRaptorCount,
    chainedIpCount: acc.chainedIpCount,
    elementCount: acc.elementCount,
  };
};

/**
 * Extract a Node and zero-or-more `dispatchesOmniAction` edges from a
 * single Salesforce `*.oip-meta.xml` file (an OmniIntegrationProcedure).
 *
 * The IP is the server-side action-chain orchestrator of Salesforce
 * Industries — a headless callable invoked by OmniScripts, OmniUiCards,
 * Apex, or external clients. Its body is a flat sequence of
 * `<omniProcessElements>` actions; each action's type discriminant
 * (`Rest Action`, `DataRaptor Extract Action`, `Integration Procedure
 * Action`, `Response Action`, etc.) drives the edge-emission matrix
 * documented in `OmniIntegrationProcedure.md`.
 *
 * Edge emissions (per `OmniIntegrationProcedure.md` §"Edge emission rules"):
 *   - `dispatchesOmniAction` -> `OmniDataTransform:{bundle}` for each
 *     `DataRaptor Extract / Transform / Load Action` whose
 *     `propertySetConfig.bundle` is non-empty.
 *   - `dispatchesOmniAction` -> `OmniIntegrationProcedure:{ipKey}` for
 *     each `Integration Procedure Action` whose
 *     `propertySetConfig.integrationProcedureKey` is non-empty. The
 *     downstream target id uses the IP's `omniProcessKey` (the lookup
 *     key callers invoke), NOT its file-level `uniqueName`.
 *   - `Rest Action` steps DO NOT emit edges — their `restPath`,
 *     `restMethod`, and `namedCredential` are surfaced verbatim on the
 *     IP node's `restEndpoints` array (and counted in
 *     `restEndpointCount`) so `endpoint_catalog` / `integration_map`
 *     can render the org's OmniStudio outbound callout surface.
 *   - `writesTo` -> `CustomObject:{Type}` with `operation: 'recordDelete'`
 *     for every `deleteSObject[].Type` a Delete Action names (one edge per
 *     object; `steps` and `recordIds` list where and which ids).
 *   - `callsApex` -> `ApexClass:{remoteClass}` for every element whose
 *     propertySetConfig names a `remoteClass` — a `Remote Action`, a Try
 *     Catch Block's failure handler, a Calculation Action — aggregated to
 *     one edge per class with every routed `remoteMethod` in `methods[]` and
 *     every call site in `callSites[]` (`omnistudio/remote.ts`). Remote
 *     Actions are also listed on the IP node's `remoteActions` array.
 *
 * The action walk is RECURSIVE and depth-bounded: it descends into
 * Block-type elements (Conditional / Loop / Cache / Try-Catch Blocks
 * nest child `omniProcessElements`), so actions buried inside a Block —
 * and their Rest / Remote / DataRaptor / nested-IP surface — are no
 * longer invisible. See {@link walkElements}.
 *
 * Edge confidence is `parsed` (the target identity lives inside the
 * `propertySetConfig` JSON blob); the per-doc "declared" branch
 * (top-level XML element siblings) is not exercised by Native IPs.
 *
 * Per-type Node properties surfaced (per PLAN-v3.2.md §3 + the
 * vendored doc):
 *   - `omniProcessType` ('Integration Procedure'), `omniProcessKey`,
 *     `versionNumber`, `language`, `subType`, `type`, `uniqueName`,
 *     `isActive`, `isWebCompEnabled`, `isOmniScriptEmbeddable`,
 *     `isIntegrationProcedure`, `isIntegProcdSignatureAvl`,
 *     `isMetadataCacheDisabled`, `isTestProcedure`,
 *     `isManagedUsingStdDesigner`.
 *   - `restEndpoints` — array of `{ stepName, path, method,
 *     namedCredential }`, one per Rest Action child with a non-empty
 *     `restPath`, sorted by (stepName, path). OMITTED when empty
 *     (matching the repo's omit-empty-optional-props pattern).
 *   - `restEndpointCount` — `restEndpoints.length` (the count is
 *     derived from the array, so the two always agree). Retained for
 *     back-compat; always present (0 when no REST endpoints).
 *   - `remoteActions` — array of `{ stepName, remoteClass,
 *     remoteMethod }`, one per Remote Action child with a non-empty
 *     `remoteClass`, sorted by (stepName, remoteClass). OMITTED when
 *     empty.
 *   - `dataRaptorCount` — count of DataRaptor-action edges emitted.
 *   - `chainedIpCount` — count of nested-IP edges emitted.
 *   - `elementCount` — count of every DISTINCT action across all
 *     nesting levels (deduped); post-recursion this includes a Block's
 *     children, where the old flat walk counted only top-level
 *     elements.
 *
 * Error cases (per the v0.1 extractor error contract):
 *   - `file-not-found` if the file is missing.
 *   - `parse-error` if the XML is malformed.
 *   - `malformed-input` if the root isn't `<OmniIntegrationProcedure>`.
 *
 * The Globex corpus carries 4 degenerate stub IPs whose body
 * elements are all `xsi:nil="true"` (every metadata field empty);
 * these are surfaced as nodes with `null` properties rather than
 * rejected, so downstream tools can flag them for cleanup. Only the
 * root tag is required.
 *
 * @example
 *   const result = await extractOmniIntegrationProcedure(
 *     'force-app/main/default/omniIntegrationProcedures/Foo_Bar_Procedure_1.oip-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'OmniIntegrationProcedure:Foo_Bar_Procedure_1'
 */
export const extractOmniIntegrationProcedure = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  // A managed-package (Vlocity) export: a DataPack folder or its main file.
  if (await isDataPackSource(path)) {
    return extractProcessDataPack(path, 'IntegrationProcedure', extractOmniIntegrationProcedureRoot);
  }
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. The Globex
  // corpus has IPs with `propertySetConfig` JSON blobs in the
  // 1k-10k character range; the entity-expansion cap is bumped to
  // 10000 to absorb the `&quot;`-laden JSON without falling over.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 100000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's entity-expansion cap).
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
  // The file-level basename (sans `.oip-meta.xml`) IS the canonical
  // api-name for the graph node. In every well-formed file in the
  // Globex corpus the basename matches `<uniqueName>`; for the 4
  // degenerate stubs (where `<uniqueName xsi:nil="true"/>` is empty)
  // the filename is the only stable identifier.
  return extractOmniIntegrationProcedureRoot(rootResult.value, path, deriveComponentApiName(path, OIP_FILE_SUFFIX));
};

/**
 * The extraction over the parsed `<OmniIntegrationProcedure>` root — the seam
 * a converted source (a managed-package DataPack) enters through.
 */
export const extractOmniIntegrationProcedureRoot = (
  rootObj: Record<string, unknown>,
  path: string,
  apiName: string,
): Result<ExtractionResult, ExtractorError> => {
  const nodeId = `${NODE_TYPE}:${apiName}`;
  const labelName = optionalString(rootObj, 'name');

  const walk = walkActions(rootObj, nodeId);

  // `restEndpoints` / `remoteActions` are spread in only when non-empty,
  // matching the repo's pattern of omitting empty optional props (so the
  // common IP with no callouts carries no empty-array churn in its
  // persisted `properties_json`). `restEndpointCount` is always present
  // (0 when no REST endpoints) for back-compat with the v3.2 shape, and
  // is derived from `restEndpoints.length` so the two never disagree.
  const calloutProperties: Record<string, unknown> = {};
  if (walk.restEndpoints.length > 0) {
    calloutProperties['restEndpoints'] = walk.restEndpoints;
  }
  if (walk.remoteActions.length > 0) {
    calloutProperties['remoteActions'] = walk.remoteActions;
  }

  const node: Node = {
    id: nodeId,
    type: 'OmniIntegrationProcedure',
    apiName,
    label: labelName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      omniProcessType: optionalString(rootObj, 'omniProcessType'),
      omniProcessKey: optionalString(rootObj, 'omniProcessKey'),
      uniqueName: optionalString(rootObj, 'uniqueName'),
      versionNumber:
        rootObj['versionNumber'] === undefined
          ? null
          : coerceNumber(unwrapSingle(rootObj['versionNumber'])),
      language: optionalString(rootObj, 'language'),
      subType: optionalString(rootObj, 'subType'),
      type: optionalString(rootObj, 'type'),
      description: optionalString(rootObj, 'description'),
      isActive: coerceBoolean(unwrapSingle(rootObj['isActive'])),
      // `isIntegrationProcedure` defaults to `true` for IPs per the
      // vendored doc — most files carry it explicitly, but legacy
      // exporters may omit it when the IP is on the unified OmniScript
      // root shape. We surface the verbatim XML value when present.
      isIntegrationProcedure: coerceBoolean(
        unwrapSingle(rootObj['isIntegrationProcedure']),
      ),
      isIntegProcdSignatureAvl: coerceBoolean(
        unwrapSingle(rootObj['isIntegProcdSignatureAvl']),
      ),
      isMetadataCacheDisabled: coerceBoolean(
        unwrapSingle(rootObj['isMetadataCacheDisabled']),
      ),
      isOmniScriptEmbeddable: coerceBoolean(
        unwrapSingle(rootObj['isOmniScriptEmbeddable']),
      ),
      isTestProcedure: coerceBoolean(unwrapSingle(rootObj['isTestProcedure'])),
      isManagedUsingStdDesigner: coerceBoolean(
        unwrapSingle(rootObj['isManagedUsingStdDesigner']),
      ),
      isWebCompEnabled: coerceBoolean(unwrapSingle(rootObj['isWebCompEnabled'])),
      elementCount: walk.elementCount,
      // The three counts that integration-topology / impact tools
      // surface as quick summary signals without re-walking the
      // omniProcessElements. `restEndpointCount` is `restEndpoints.length`
      // — the count of Rest Action children (at any nesting depth) whose
      // `restPath` is non-empty (Q177-relevant — see
      // OmniIntegrationProcedure.md §"REST endpoint surfacing"). The full
      // `restEndpoints` / `remoteActions` arrays are spread in below when
      // non-empty.
      restEndpointCount: walk.restEndpoints.length,
      dataRaptorCount: walk.dataRaptorCount,
      chainedIpCount: walk.chainedIpCount,
      ...calloutProperties,
    },
  };

  return ok({ nodes: [node], edges: walk.edges });
};
