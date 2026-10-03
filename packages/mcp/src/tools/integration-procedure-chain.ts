/**
 * Handler for the `sfi.integration_procedure_chain` MCP tool.
 *
 * Given an OmniIntegrationProcedure (IP) canonical id, walks the IP's
 * steps — top-level and nested inside blocks — in runtime order and
 * surfaces:
 *
 *   1. The IP's identity metadata (`omniProcessKey`, `versionNumber`,
 *      `subType`, `type`, `uniqueName`, `isActive`).
 *   2. The ordered action list — every step, siblings by
 *      `sequenceNumber`, depth-first. Each carries its `name`, `type`,
 *      `description`, `sequenceNumber`, `isActive`, the optional
 *      `executionConditionalFormula`, its `path` / `depth`, and the element
 *      catalog's `canonicalType` and `role` (`omnistudio/catalog.ts`), so
 *      every spelling of one action is read the same way.
 *   3. The `externalEndpoints[]` payload, by the same rules the extractor
 *      uses for edges: ANY element naming a `bundle` (kind `dataraptor`),
 *      an `integrationProcedureKey` (`integration-procedure`), a
 *      `remoteClass` (`remote-action`, resolved to its ApexClass); an HTTP
 *      step's URL (`rest`); a Delete Action's objects (`delete`). DataMapper
 *      and IP targets take the graph's import-time resolution — the
 *      version that runs, the others listed — and fall back to scanning
 *      the target type by the property the caller names it by. A resolved
 *      DataMapper carries the objects it reads and writes.
 *   4. `dataAccess` — the chain's own footprint over its endpoints.
 *   5. The `responseShape` parsed from the terminal `Response Action`'s
 *      `propertySetConfig.additionalOutput` (the response template).
 *   6. The verbatim honesty disclosures bundled into `boundaries[]`:
 *      Native-vs-Vlocity-Legacy (ALWAYS), the Apex-coupling scope
 *      (ALWAYS), the OmniProcessElement record-level boundary
 *      (ALWAYS — Q179 anchor), and the REST-endpoint reachability
 *      caveat (ALWAYS — URLs are `parsed`, not verified).
 *
 * Implementation notes (composition recipe per PLAN-v3.2 §4):
 *
 *   - The graph carries the IP node + outgoing `dispatchesOmniAction`
 *     edges, but NOT the action list or the per-step
 *     `propertySetConfig`. The handler re-parses the source XML at
 *     `node.sourcePath` to surface the action sequence and the
 *     embedded JSON. This mirrors `sfi.search_flow_metadata`'s
 *     re-read-the-source-on-demand pattern.
 *   - The `OmniIntegrationProcedure.md` vendored doc lists the exact
 *     XML element shape; the parser here implements only the subset
 *     the tool surfaces and tolerates absent / malformed
 *     `propertySetConfig` blobs by emitting `null` rather than
 *     failing.
 *   - The `dataraptor` and `integration-procedure` targets are
 *     resolved against the graph by scanning the target node type and
 *     matching the PROPERTY the caller names it by — never by
 *     string-templating the caller's name onto the type's id prefix,
 *     which misses a present target whenever the node id (filename
 *     stem) and the callable name differ, as they ordinarily do.
 *     `targetId` is populated only when exactly ONE node answers;
 *     `targetResolution` says why it is `null` otherwise — a proven
 *     absence (`'not-in-vault'`), several versions answering to one
 *     key (`'ambiguous'`, with every candidate in
 *     `targetCandidateIds`), an unread scan tail (`'unresolved'`), or
 *     a failed graph read (`'lookup-failed'`). Only `'not-in-vault'`
 *     asserts anything about the org, and it is emitted only after a
 *     COMPLETE scan of the type.
 *   - Per the task's honesty boundaries, REST endpoint URLs are
 *     documented as `parsed` confidence (not verified). The
 *     `endpointConfidence` field on each `externalEndpoint` carries
 *     `'parsed'` for all four kinds: the URL / bundle / IP key /
 *     class.method lives inside the JSON blob, not in a top-level
 *     XML element.
 */

import { readFile } from 'node:fs/promises';

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { omnistudio } from '@sf-intelligence/extractors';
import { getNodeById, listEdgesForNodes, listNodesByIds } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

import type { Context } from '../server.js';

import { NATIVE_VS_VLOCITY_DISCLOSURE } from './omni-disclosures.js';
import { isDataPackSourcePath, readDataPackRoot } from './omni-source.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { FULL_SCAN_MAX_NODES } from './scan-cap.js';

/** Canonical id prefix for the OmniIntegrationProcedure node type. */
const IP_PREFIX = 'OmniIntegrationProcedure:';

/** Canonical id prefix for the OmniDataTransform node type. */
const DATA_TRANSFORM_PREFIX = 'OmniDataTransform:';

/** The root element name of an OmniIntegrationProcedure source file. */
const ROOT_ELEMENT = 'OmniIntegrationProcedure';

/**
 * Apex-coupling scope disclosure. Surfaced on every IP-chain response:
 * calls OUT to Apex are resolved; what the Apex does is answered elsewhere;
 * Apex that runs this IP by a literal key is an INCOMING edge (usage tools).
 */
const APEX_COUPLING_DEFERRAL_DISCLOSURE =
  'Every element naming a `remoteClass` (a Remote Action, a Try Catch ' +
  'failure handler, …) is resolved to its ApexClass — the graph carries the ' +
  'matching `callsApex` edge from this IP. What that Apex reads or writes ' +
  'is answered by the Apex tools, not here; a class the vault does not hold ' +
  '(a managed-package class, or one not retrieved) is `not-in-vault`. ' +
  'Apex that RUNS this IP by key (`<ns>.IntegrationProcedureService.runIntegrationService(' +
  "'Type_SubType', …)` with a literal key) is in the graph as an incoming " +
  '`dispatchesOmniAction` edge from that class (`via: apex`) — ask the usage or ' +
  'impact tools for callers; a key built at runtime is not seen.';

/**
 * OmniProcessElement record-level boundary (Q179 anchor). Surfaced on
 * every IP-chain response because runtime state callers might assume
 * the record-level data is queryable through this tool. It is not.
 */
const RECORD_LEVEL_BOUNDARY_DISCLOSURE =
  'v3.2 walks the OmniScript / IP / Card metadata XML. The actual ' +
  'user-entered data and runtime state lives in OmniProcessElement and ' +
  'related SObject records; that is record-level data, out of scope ' +
  "for v0.1's read-the-metadata posture.";

/**
 * REST endpoint reachability disclosure. Per the task's honesty
 * boundary: "REST endpoint URLs documented as `parsed` confidence
 * (not verified)." Each Rest Action's URL is read from the
 * propertySetConfig JSON; v3.2 does NOT probe the endpoint, verify
 * DNS / TLS, or resolve the Named Credential against live state.
 */
const REST_REACHABILITY_DISCLOSURE =
  'REST endpoint URLs are surfaced with `parsed` confidence (from the ' +
  'propertySetConfig JSON blob); v3.2 does NOT probe the URL, verify ' +
  'the endpoint is reachable, or resolve the Named Credential against ' +
  'live state.';

/**
 * Zod schema for the `sfi.integration_procedure_chain` tool input.
 *
 *   - `integrationProcedureId`: required, non-empty string. The
 *     canonical IP id (`OmniIntegrationProcedure:{ApiName}`).
 *     Non-IP prefixes surface as `invalid-query`; unknown well-formed
 *     ids surface as `component-not-found`.
 *   - `includeChildPropertySetConfig`: optional, default false. When
 *     true, each action's parsed `propertySetConfig` is attached to
 *     the action entry as `propertySetConfigParsed`. The parsed blob
 *     can be 1-10kB per action; default-off keeps responses compact.
 */
export const integrationProcedureChainInputSchema = z.object({
  integrationProcedureId: z.string().min(1),
  includeChildPropertySetConfig: z.boolean().optional(),
});

/** Parsed input shape, inferred from the Zod schema. */
export type IntegrationProcedureChainInput = z.infer<
  typeof integrationProcedureChainInputSchema
>;

/**
 * One row in the response's `actions` array. Mirrors PLAN-v3.2 §4's
 * `IntegrationProcedureAction` interface — name, type, description,
 * sequenceNumber, isActive, executionConditionalFormula, and the
 * optional parsed propertySetConfig.
 */
export interface IntegrationProcedureAction {
  readonly name: string;
  readonly type: string;
  readonly description: string | null;
  readonly sequenceNumber: number;
  readonly isActive: boolean;
  readonly executionConditionalFormula: string | null;
  /** Names from the top-level step down (`Guard/LoadOrder`): a nested step runs inside its block. */
  readonly path: string;
  /** 0 for a top-level step. */
  readonly depth: number;
  /** The catalog's canonical type — every spelling of one action maps to one name. */
  readonly canonicalType: string;
  /** The step's role in the IP's data flow (catalog): dataMapper, remote, rest, nestedIp, delete, … */
  readonly role: string;
  readonly propertySetConfigParsed?: Readonly<Record<string, unknown>>;
}

/**
 * One row in the response's `externalEndpoints` array. Mirrors
 * PLAN-v3.2 §4's `ExternalEndpoint` interface, extended with
 * `endpointConfidence` per the task's "URLs documented as `parsed`"
 * boundary.
 */
export interface ExternalEndpoint {
  readonly stepName: string;
  /** The step's element path (`Guard/LoadOrder` for a step inside a block). */
  readonly stepPath: string;
  readonly kind: 'rest' | 'dataraptor' | 'remote-action' | 'integration-procedure' | 'delete';
  readonly target: string;
  readonly targetId: ComponentId | null;
  /**
   * Why `targetId` looks the way it does. Every reason a `targetId`
   * can be `null` is a DIFFERENT claim, and only one of them is an
   * affirmative fact about the org:
   *   - `'resolved'` — exactly one node in the vault answers to this
   *     target name; `targetId` is populated.
   *   - `'active-version'` — several versions answer and exactly one is
   *     active: `targetId` is that one (for an IP, `isActive` IS the
   *     runtime switch). The others are in `targetCandidateIds`.
   *   - `'highest-version'` — a DataMapper with several versions and no
   *     single active one: the highest version is named (a DataMapper's
   *     `active` flag is not a runtime switch).
   *   - `'no-active-version'` — an IP with several versions, none active:
   *     nothing runs; `targetId` is null.
   *   - `'ambiguous'` — MORE THAN ONE node answers to it (the normal
   *     shape for a versioned IP: every version file carries the same
   *     `omniProcessKey`). Which one runs is decided at RUNTIME by
   *     activation state, which the vault cannot settle, so `targetId`
   *     stays `null` and every candidate is listed in
   *     {@link ExternalEndpoint.targetCandidateIds}.
   *   - `'not-in-vault'` — the COMPLETE scan of the target's node type
   *     came back with no match: a genuine dangling reference (managed
   *     package, cross-namespace, or a target the refresh never
   *     retrieved). This is the only value that asserts absence, and
   *     it is emitted only when absence was actually proven.
   *   - `'unresolved'` — no match, but the scan stopped at its
   *     residual node cap, so nodes behind the cap were never read.
   *     Absence is NOT established; do not render this as "missing".
   *   - `'lookup-failed'` — the graph query itself errored. NOT an org
   *     fact; it must never be read as "not in this vault". See
   *     `notExtractedFamilyDisclosure`'s reasoning in
   *     `absence-disclosure.ts` for why the two are kept apart.
   *   - `'not-applicable'` — `rest` endpoints (external URLs) and a
   *     `delete` whose object has no node, which never resolve.
   */
  readonly targetResolution: TargetResolution;
  /**
   * Every vault node that answers to `target`, id-ASC. Length 1 when
   * `targetResolution` is `'resolved'` (and its single entry equals
   * `targetId`), ≥2 when `'ambiguous'`, and empty for every other
   * value. Always present, so an empty array is never load-bearing on
   * its own — `targetResolution` carries the reason.
   */
  readonly targetCandidateIds: readonly ComponentId[];
  readonly namedCredential: string | null;
  readonly endpointConfidence: 'parsed';
  /**
   * For a resolved DataMapper: the objects it reads and writes (from its
   * field-level `readsFrom` / `writesTo` edges). For a `delete`: the object.
   */
  readonly dataAccess?: { readonly reads: readonly string[]; readonly writes: readonly string[] };
}

/** @see ExternalEndpoint.targetResolution */
export type TargetResolution =
  | 'resolved'
  | 'active-version'
  | 'highest-version'
  | 'no-active-version'
  | 'ambiguous'
  | 'not-in-vault'
  | 'unresolved'
  | 'lookup-failed'
  | 'not-applicable';

/**
 * The response shape parsed from the terminal `Response Action`'s
 * `propertySetConfig.additionalOutput`. Both fields surface `null`
 * when the IP has no Response Action or the JSON is unparseable.
 */
export interface ResponseShape {
  readonly additionalOutput: Readonly<Record<string, unknown>> | null;
  readonly returnOnlyAdditionalOutput: boolean | null;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface IntegrationProcedureChainOutput {
  readonly integrationProcedureId: ComponentId;
  readonly apiName: string;
  readonly metadata: {
    readonly omniProcessKey: string | null;
    readonly versionNumber: number | null;
    readonly isActive: boolean;
    readonly subType: string | null;
    readonly type: string | null;
    readonly uniqueName: string | null;
  };
  readonly actions: readonly IntegrationProcedureAction[];
  readonly externalEndpoints: readonly ExternalEndpoint[];
  /**
   * What the chain's own steps touch, summed over its endpoints: objects its
   * DataMappers read / write, objects its Delete Actions delete, the Apex
   * classes and the IPs / DataMappers it calls (resolved ids). Nested IPs'
   * own steps are not folded in — follow `ipsCalled`.
   */
  readonly dataAccess: {
    readonly reads: readonly string[];
    readonly writes: readonly string[];
    readonly deletes: readonly string[];
    readonly apexClasses: readonly string[];
    readonly ipsCalled: readonly string[];
    readonly mappersCalled: readonly string[];
  };
  readonly responseShape: ResponseShape;
  readonly boundaries: readonly string[];
}

// ---------------------------------------------------------------------
// XML parsing helpers
// ---------------------------------------------------------------------

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. fast-xml-parser
 * emits an object when an element appears once and an array when it
 * appears multiple times; `<omniProcessElements>` can occur any
 * number of times, so the walker consumes an array.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Coerce an XML scalar to a boolean; non-`true` values become false. */
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

/** Return a trimmed non-empty string, or `null` when blank. */
const nonEmptyString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
};

/**
 * Parse the `propertySetConfig` JSON blob inside an action child.
 * The source XML carries HTML-entity-escaped JSON; fast-xml-parser's
 * `processEntities` decodes those before we see the string, so a
 * straight `JSON.parse` works on the unwrapped value.
 *
 * Returns `null` when the blob is absent, empty, or unparseable —
 * malformed blobs are rare but surface as `null` rather than aborting
 * the walk, per the v3.2 "best-effort propertySetConfig parsing"
 * axis.
 */
const parsePropertySetConfig = (
  raw: unknown,
): Record<string, unknown> | null => {
  const value = unwrapSingle(raw);
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------

/**
 * The verbatim boundary disclosures the tool surfaces on every
 * successful response. Frozen so the test suite (and the
 * `salesforce-industries-routing` skill that surfaces these to end
 * users) can assert exact-match.
 */
const BOUNDARIES_VERBATIM: readonly string[] = Object.freeze([
  NATIVE_VS_VLOCITY_DISCLOSURE,
  APEX_COUPLING_DEFERRAL_DISCLOSURE,
  RECORD_LEVEL_BOUNDARY_DISCLOSURE,
  REST_REACHABILITY_DISCLOSURE,
]);

/**
 * Read and parse the IP's Metadata API XML into its `<OmniIntegrationProcedure>` root.
 */
const readIpXmlRoot = async (
  ctx: Context,
  node: Node,
): Promise<Result<Record<string, unknown>, McpError>> => {
  let xmlText: string;
  try {
    xmlText = await readFile(
      resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath),
      'utf-8',
    );
  } catch (cause: unknown) {
    // The graph was imported but the source file is gone — the same
    // shape `sfi.get_component` returns when a vault file is missing.
    return err({
      kind: 'component-not-found',
      message: `source file missing for ${node.id}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      path: node.sourcePath,
    });
  }

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return err({
      kind: 'internal',
      message: `malformed XML at ${node.sourcePath}: ${validation.err.msg}`,
      path: node.sourcePath,
    });
  }

  // Local trusted disk content; XXE not a concern. The
  // `propertySetConfig` JSON blobs are heavily `&quot;`-laden so the
  // entity-expansion cap is bumped to absorb them without falling
  // over — same setting the extractor uses.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 100000 },
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlText) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'internal',
      message: `XML parse failed at ${node.sourcePath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      path: node.sourcePath,
    });
  }

  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'internal',
      message: `expected <${ROOT_ELEMENT}> root at ${node.sourcePath}`,
      path: node.sourcePath,
    });
  }
  return ok(root as Record<string, unknown>);
};

/**
 * A managed-package (Vlocity) IP: its DataPack, converted to the same
 * `<OmniIntegrationProcedure>` root the XML parses to. A missing DataPack is
 * reported exactly like a missing XML file.
 */
const readIpDataPackRoot = async (
  ctx: Context,
  node: Node,
): Promise<Result<Record<string, unknown>, McpError>> => {
  const r = await readDataPackRoot(resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath), 'process');
  if (r.ok) return r;
  return err({
    kind: r.error.missing ? 'component-not-found' : 'internal',
    message: r.error.missing ? `source file missing for ${node.id}: ${r.error.message}` : r.error.message,
    path: node.sourcePath,
  });
};

/**
 * The `sfi.integration_procedure_chain` MCP tool.
 *
 * Pipeline:
 *   1. Validate the id carries the `OmniIntegrationProcedure:` prefix.
 *   2. Resolve the IP node from the graph; refuse with
 *      `component-not-found` when absent.
 *   3. Read and validate the source XML at the node's `sourcePath`.
 *   4. Walk every `<omniProcessElements>` child, sort by
 *      `sequenceNumber` ASC, and emit the structured `actions` list.
 *   5. For each action, classify by `type` and emit an
 *      `externalEndpoints` row when the action targets an external
 *      resource (REST URL / DataRaptor bundle / nested IP key / Apex
 *      remote class.method).
 *   6. Locate the `Response Action` and parse its
 *      `propertySetConfig.additionalOutput` into `responseShape`.
 *   7. Resolve `dataraptor` and `integration-procedure` endpoint
 *      targets against the graph so `targetId` carries a canonical
 *      id when the target component is in the vault.
 *
 * @example
 *   const r = await integrationProcedureChainHandler(ctx, {
 *     integrationProcedureId:
 *       'OmniIntegrationProcedure:Acme_ValidateMember_Procedure_1',
 *   });
 *   if (r.ok) console.log(r.value.data.actions.length);
 */
export const integrationProcedureChainHandler = async (
  ctx: Context,
  input: IntegrationProcedureChainInput,
): Promise<
  Result<McpResponse<IntegrationProcedureChainOutput>, McpError>
> => {
  if (!input.integrationProcedureId.startsWith(IP_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `integrationProcedureId must start with '${IP_PREFIX}'; got '${input.integrationProcedureId}'`,
      path: 'integrationProcedureId',
    });
  }

  const nodeResult = await getNodeById(ctx.graph, input.integrationProcedureId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, input.integrationProcedureId, 'OmniIntegrationProcedure'),
      path: input.integrationProcedureId,
    });
  }
  const node = nodeResult.value;
  if (node.type !== 'OmniIntegrationProcedure') {
    return err({
      kind: 'invalid-query',
      message: `node ${input.integrationProcedureId} is a ${node.type}, not an OmniIntegrationProcedure`,
      path: 'integrationProcedureId',
    });
  }

  const rootResult = isDataPackSourcePath(node.sourcePath)
    ? await readIpDataPackRoot(ctx, node)
    : await readIpXmlRoot(ctx, node);
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const includePsc = input.includeChildPropertySetConfig === true;
  const walk = walkActions(rootObj, includePsc);
  const externalEndpoints = await resolveExternalEndpoints(
    ctx,
    node.id,
    walk.endpointSeeds,
  );
  const dataAccess = summarizeDataAccess(externalEndpoints);

  return ok({
    data: {
      integrationProcedureId: node.id,
      apiName: node.apiName,
      metadata: {
        omniProcessKey: readNodeStringProperty(node, 'omniProcessKey'),
        versionNumber: readNodeNumberProperty(node, 'versionNumber'),
        isActive: readNodeBooleanProperty(node, 'isActive'),
        subType: readNodeStringProperty(node, 'subType'),
        type: readNodeStringProperty(node, 'type'),
        uniqueName: readNodeStringProperty(node, 'uniqueName'),
      },
      actions: walk.actions,
      externalEndpoints,
      dataAccess,
      responseShape: walk.responseShape,
      boundaries: BOUNDARIES_VERBATIM,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * Pre-resolution shape for an external endpoint. The graph-lookup
 * pass converts each seed into a final `ExternalEndpoint` with the
 * resolved `targetId`.
 */
interface EndpointSeed {
  readonly stepName: string;
  readonly stepPath: string;
  readonly kind: ExternalEndpoint['kind'];
  readonly target: string;
  readonly namedCredential: string | null;
  /** The ApexClass api name for a remote call (`ns.Class` → `ns__Class`). */
  readonly apexApiName?: string;
}

interface ActionWalk {
  readonly actions: readonly IntegrationProcedureAction[];
  readonly endpointSeeds: readonly EndpointSeed[];
  readonly responseShape: ResponseShape;
}

/**
 * Walk every step, top-level and nested (a Conditional / Loop / Try-Catch
 * Block holds its steps as `<childElements>`), siblings in `sequenceNumber`
 * order, depth-first. For each:
 *   - Build the per-action row (always), with its path, depth, the catalog's
 *     canonical type and the step's role.
 *   - Push endpoint seeds by the same rules the extractor uses for edges, so
 *     the chain and the graph agree: ANY element naming a `bundle` calls that
 *     DataMapper, an `integrationProcedureKey` that IP, a `remoteClass` that
 *     Apex class; an HTTP action (`Rest Action`, `HTTP Action`, …) its URL;
 *     a Delete Action the objects in its `deleteSObject` list.
 *   - When the action is a `Response Action`, parse its `additionalOutput`
 *     into `responseShape` (last-write-wins if the IP carries several).
 */
const walkActions = (
  rootObj: Record<string, unknown>,
  includePsc: boolean,
): ActionWalk => {
  const actions: IntegrationProcedureAction[] = [];
  const endpointSeeds: EndpointSeed[] = [];
  let responseAdditionalOutput: Record<string, unknown> | null = null;
  let responseReturnOnlyAdditionalOutput: boolean | null = null;

  const visit = (list: unknown, parentPath: string, depth: number): void => {
    const rows: Array<{ element: Record<string, unknown>; sequenceNumber: number; order: number }> = [];
    toArray(list).forEach((raw, order) => {
      if (typeof raw !== 'object' || raw === null) return;
      const element = raw as Record<string, unknown>;
      rows.push({ element, sequenceNumber: coerceNumber(unwrapSingle(element['sequenceNumber'])), order });
    });
    // Siblings in runtime order; equal sequence numbers keep document order.
    rows.sort((a, b) => a.sequenceNumber - b.sequenceNumber || a.order - b.order);
    for (const { element, sequenceNumber } of rows) {
      const type = nonEmptyString(unwrapSingle(element['type']));
      if (type === null) continue;
      const name = nonEmptyString(unwrapSingle(element['name'])) ?? '';
      const path = parentPath === '' ? name : `${parentPath}/${name}`;
      const description = nonEmptyString(unwrapSingle(element['description']));
      const isActive = coerceBoolean(unwrapSingle(element['isActive']));
      const psc = parsePropertySetConfig(element['propertySetConfig']);
      const executionConditionalFormula =
        psc === null ? null : nonEmptyString(psc['executionConditionalFormula']);
      const canonicalType = omnistudio.canonicalElementType(type);
      // A Remote Action on the managed runtime's IntegrationProcedureService
      // runs the IP its method names: a nested IP call, not Apex.
      const service =
        psc === null ? null : omnistudio.runtimeServiceCall(omnistudio.apexRemoteTarget(psc['remoteClass']), psc['remoteMethod']);
      const role = service === null ? omnistudio.ipStepRole(type) : 'nestedIp';
      actions.push({
        name,
        type,
        description,
        sequenceNumber,
        isActive,
        executionConditionalFormula,
        path,
        depth,
        canonicalType,
        role,
        ...(includePsc && psc !== null ? { propertySetConfigParsed: psc } : {}),
      });

      if (psc !== null) {
        const seed = (kind: EndpointSeed['kind'], target: string, extra: Partial<EndpointSeed> = {}): void => {
          endpointSeeds.push({ stepName: name, stepPath: path, kind, target, namedCredential: null, ...extra });
        };
        if (role === 'rest') {
          const url = nonEmptyString(psc['restPath']) ?? nonEmptyString(psc['httpUrl']);
          if (url !== null) {
            seed('rest', url, {
              namedCredential: nonEmptyString(psc['namedCredential']) ?? nonEmptyString(psc['restNamedCredential']),
            });
          }
        }
        const bundle = nonEmptyString(psc['bundle']);
        if (bundle !== null) seed('dataraptor', bundle);
        const ipKey = nonEmptyString(psc['integrationProcedureKey']);
        if (ipKey !== null) seed('integration-procedure', ipKey);
        const apex = omnistudio.apexRemoteTarget(psc['remoteClass']);
        if (service !== null) {
          seed('integration-procedure', service.key);
        } else if (apex !== null) {
          const method = nonEmptyString(psc['remoteMethod']);
          seed('remote-action', `${apex.raw.trim()}${method === null ? '' : `.${method}`}`, { apexApiName: apex.apiName });
        }
        if (role === 'delete') {
          for (const entry of toArray(psc['deleteSObject'])) {
            const object = typeof entry === 'object' && entry !== null ? nonEmptyString((entry as Record<string, unknown>)['Type']) : null;
            if (object !== null) seed('delete', object);
          }
        }
        if (role === 'response') {
          // Last-write-wins on the rare multi-response shape — the
          // canonical authoring pattern is one terminal Response Action.
          const additional = psc['additionalOutput'];
          if (typeof additional === 'object' && additional !== null && !Array.isArray(additional)) {
            responseAdditionalOutput = additional as Record<string, unknown>;
          }
          const returnOnly = psc['returnOnlyAdditionalOutput'];
          if (typeof returnOnly === 'boolean') responseReturnOnlyAdditionalOutput = returnOnly;
        }
      }
      visit(element['childElements'], path, depth + 1);
    }
  };
  visit(rootObj['omniProcessElements'], '', 0);

  return {
    actions,
    endpointSeeds,
    responseShape: {
      additionalOutput: responseAdditionalOutput,
      returnOnlyAdditionalOutput: responseReturnOnlyAdditionalOutput,
    },
  };
};

/**
 * The node property each resolvable endpoint kind is named BY. Neither
 * is the node's api-name, and that is the whole point of this module:
 *
 *   - A nested-IP step names its target with `integrationProcedureKey`,
 *     which is the target IP's `omniProcessKey`. `omni-integration-
 *     procedure.ts` states it verbatim — "the downstream target id uses
 *     the IP's `omniProcessKey` (the lookup key callers invoke), NOT its
 *     file-level `uniqueName`" — while the same extractor mints the IP
 *     NODE id from the FILENAME stem.
 *   - A DataRaptor step names its target with `bundle`, which matches
 *     the DataRaptor's `<name>`, while `omni-data-transform.ts` mints
 *     the node id from the filename stem — the VERSIONED `<uniqueName>`
 *     form (`..._2`).
 *
 * So `${prefix}${target}` is NOT the id of a present target whenever the
 * two forms differ, which is the ordinary case rather than the edge one.
 * Resolving by string-templating the prefix therefore misses live
 * components; the resolution below reads the property instead.
 */
const TARGET_KEY_PROPERTY = {
  'integration-procedure': 'omniProcessKey',
  dataraptor: 'name',
} as const;

/** The node type each resolvable endpoint kind resolves against. */
const TARGET_NODE_TYPE: Record<'integration-procedure' | 'dataraptor', ComponentType> = {
  'integration-procedure': 'OmniIntegrationProcedure',
  dataraptor: 'OmniDataTransform',
};

/** Which node-id prefix a resolvable kind's conventional id form uses. */
const TARGET_ID_PREFIX = {
  'integration-procedure': IP_PREFIX,
  dataraptor: DATA_TRANSFORM_PREFIX,
} as const;

/** A resolvable endpoint kind — the two that attempt a `targetId`. */
type ResolvableKind = keyof typeof TARGET_KEY_PROPERTY;

/** One indexed target node: its id and the version facts that pick one. */
interface IndexedTarget {
  readonly id: ComponentId;
  /** IP: `isActive` (the runtime switch). DataMapper: `active` (not a switch — a tie-breaker). */
  readonly active: boolean;
  readonly versionNumber: number;
}

/**
 * One node type's resolution index, or the fact that it could not be
 * read. `complete` is the honesty hinge: a miss against an INCOMPLETE
 * index proves nothing, so it may not be published as `'not-in-vault'`.
 */
type TargetIndex =
  | {
      readonly ok: true;
      /** Every canonical node id of the type, for the conventional form. */
      readonly byId: ReadonlyMap<string, IndexedTarget>;
      /** Key-property value → every node carrying it. */
      readonly byKey: ReadonlyMap<string, readonly IndexedTarget[]>;
      /** False when the walk stopped at its residual node cap. */
      readonly complete: boolean;
    }
  | { readonly ok: false };

/**
 * Residual ceiling on ONE target-type walk. `SFI_OMNI_TARGET_SCAN_MAX`
 * overrides {@link FULL_SCAN_MAX_NODES} so a test can reach the
 * capped-walk path without seeding twenty thousand nodes — the same
 * per-tool override `tech-debt-score.ts` and `history-tracking-gaps.ts`
 * carry, and the only reason the `'unresolved'` state is exercised by a
 * TOOL-level test rather than by a helper in isolation. This is the
 * PER-TYPE total, not the per-window page size (`SFI_NODE_SCAN_LIMIT`,
 * which `scanAllNodesOfTypes` reads internally).
 */
const targetScanCeiling = (): number => {
  const v = Number(process.env['SFI_OMNI_TARGET_SCAN_MAX']);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : FULL_SCAN_MAX_NODES;
};

const versionOf = (node: Node): number => {
  const v = node.properties['versionNumber'];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Walk EVERY node of one type and index it both ways. Adopts the shared
 * {@link scanAllNodesOfTypes} rather than a single `listNodesByType`
 * page: that call is capped at 500 id-ASC rows, so an alphabetically
 * late IP would have been invisible and reported absent (R6).
 */
const buildTargetIndex = async (
  ctx: Context,
  kind: ResolvableKind,
): Promise<TargetIndex> => {
  const scan = await scanAllNodesOfTypes(
    ctx.graph,
    [TARGET_NODE_TYPE[kind]],
    targetScanCeiling(),
  );
  if (!scan.ok) return { ok: false };

  const keyProperty = TARGET_KEY_PROPERTY[kind];
  const byId = new Map<string, IndexedTarget>();
  const byKey = new Map<string, IndexedTarget[]>();
  for (const node of scan.value.nodes) {
    const entry: IndexedTarget = {
      id: node.id,
      active: kind === 'dataraptor' ? node.properties['active'] === true : node.properties['isActive'] === true,
      versionNumber: versionOf(node),
    };
    byId.set(node.id, entry);
    const keyValue = node.properties[keyProperty];
    if (typeof keyValue !== 'string') continue;
    const trimmed = keyValue.trim();
    if (trimmed.length === 0) continue;
    const bucket = byKey.get(trimmed);
    if (bucket === undefined) byKey.set(trimmed, [entry]);
    else bucket.push(entry);
  }
  return { ok: true, byId, byKey, complete: !scan.value.scanIncomplete };
};

/** The derived resolution state of ONE endpoint seed. */
interface ResolvedTarget {
  readonly targetId: ComponentId | null;
  readonly targetResolution: TargetResolution;
  readonly targetCandidateIds: readonly ComponentId[];
}

/** `rest`: an external URL, never looked up. */
const NOT_APPLICABLE: ResolvedTarget = {
  targetId: null,
  targetResolution: 'not-applicable',
  targetCandidateIds: [],
};

/**
 * Pick among several versions answering to one key — the same rule the
 * import-time resolver (`graph/omni-resolve.ts`) applies to the edges:
 * an IP runs its ACTIVE version (`isActive` is the runtime switch), so
 * exactly one active version is the target, none means nothing runs, and
 * several active is ambiguous. A DataMapper's `active` is not a switch: a
 * single active version wins, else the highest version is named.
 */
const pickVersion = (kind: ResolvableKind, candidates: readonly IndexedTarget[]): ResolvedTarget => {
  const ids = candidates.map((c) => c.id).sort();
  const active = candidates.filter((c) => c.active);
  if (active.length === 1) {
    return { targetId: (active[0] as IndexedTarget).id, targetResolution: 'active-version', targetCandidateIds: ids };
  }
  if (kind === 'integration-procedure') {
    return { targetId: null, targetResolution: active.length === 0 ? 'no-active-version' : 'ambiguous', targetCandidateIds: ids };
  }
  const highest = [...candidates].sort((a, b) => b.versionNumber - a.versionNumber || (a.id < b.id ? -1 : 1))[0] as IndexedTarget;
  return { targetId: highest.id, targetResolution: 'highest-version', targetCandidateIds: ids };
};

/**
 * Classify ONE target name against a built index — the fallback when the
 * graph carries no resolved edge for the step (a vault imported before the
 * import-time resolver, or a target outside a scoped pull). Candidates are
 * the union of the conventional id form and every node carrying the key
 * property, so a vault where both happen to hit yields one candidate rather
 * than a false ambiguity.
 */
const classifyTarget = (
  target: string,
  index: TargetIndex,
  kind: ResolvableKind,
): ResolvedTarget => {
  if (!index.ok) {
    return {
      targetId: null,
      targetResolution: 'lookup-failed',
      targetCandidateIds: [],
    };
  }
  const found = new Map<string, IndexedTarget>();
  for (const entry of index.byKey.get(target) ?? []) found.set(entry.id, entry);
  const conventional = index.byId.get(`${TARGET_ID_PREFIX[kind]}${target}`);
  if (conventional !== undefined) found.set(conventional.id, conventional);
  const candidates = [...found.values()];

  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) {
    return { targetId: only.id, targetResolution: 'resolved', targetCandidateIds: [only.id] };
  }
  if (candidates.length > 1) return pickVersion(kind, candidates);
  return {
    targetId: null,
    // A miss is only ABSENCE when the whole type was read. Behind a
    // residual cap it is merely unread.
    targetResolution: index.complete ? 'not-in-vault' : 'unresolved',
    targetCandidateIds: [],
  };
};

/** The import-time resolver's verdict, as this tool reports it. */
const EDGE_RESOLUTION: Readonly<Record<string, TargetResolution>> = {
  'only-version': 'resolved',
  'active-version': 'active-version',
  'highest-version': 'highest-version',
  'ambiguous-active': 'ambiguous',
  'no-active-version': 'no-active-version',
};

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The object an access edge lands on: `CustomObject:X` / `CustomField:X.Y` → `X`. */
const objectOfTarget = (toId: string): string | null => {
  if (toId.startsWith('CustomObject:')) return toId.slice('CustomObject:'.length);
  if (toId.startsWith('CustomField:')) {
    const rest = toId.slice('CustomField:'.length);
    const dot = rest.indexOf('.');
    return dot === -1 ? null : rest.slice(0, dot);
  }
  return null;
};

/**
 * Resolve each endpoint seed. The graph's own edges come first: the import
 * resolved every DataMapper / IP call onto the version that runs and kept
 * the others (`targetResolution`, `otherVersionIds`), and every
 * `remoteClass` onto its ApexClass (`callsApex`). A step the graph has no
 * resolved edge for falls back to scanning the target type by the property
 * the caller names it by — never by templating the name onto the type's id
 * prefix, which misses a present target whenever the two differ.
 *
 * Each node type is walked at most ONCE per call, and only when a fallback
 * needs it. The endpoint's `target` (the verbatim name) is always present
 * and `targetResolution` says which rule applied; only `'not-in-vault'`
 * asserts absence.
 */
const resolveExternalEndpoints = async (
  ctx: Context,
  ipId: ComponentId,
  seeds: readonly EndpointSeed[],
): Promise<readonly ExternalEndpoint[]> => {
  const resolved: ExternalEndpoint[] = [];
  const indexes = new Map<ResolvableKind, TargetIndex>();
  const indexFor = async (kind: ResolvableKind): Promise<TargetIndex> => {
    const cached = indexes.get(kind);
    if (cached !== undefined) return cached;
    const built = await buildTargetIndex(ctx, kind);
    indexes.set(kind, built);
    return built;
  };

  // The IP's own resolved edges, and which of their targets exist.
  const out = await listEdgesForNodes(ctx.graph, [ipId], { direction: 'out' });
  const ipEdges = out.ok ? (out.value.get(ipId) ?? []) : [];
  const targetIds = [...new Set(ipEdges.map((e) => e.toId))];
  const present = new Set<string>();
  if (targetIds.length > 0) {
    const nodes = await listNodesByIds(ctx.graph, targetIds);
    if (nodes.ok) for (const n of nodes.value) present.add(n.id);
  }
  const rawOf = (props: Readonly<Record<string, unknown>>): string | null => {
    for (const k of ['targetRawName', 'bundle', 'integrationProcedureKey']) {
      const v = props[k];
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    return null;
  };
  const fromEdge = (seed: EndpointSeed): ResolvedTarget | null => {
    const edge = ipEdges.find(
      (e) => e.edgeType === 'dispatchesOmniAction' && e.properties['stepName'] === seed.stepName && rawOf(e.properties) === seed.target,
    );
    if (edge === undefined || !present.has(edge.toId)) return null;
    const how = edge.properties['targetResolution'];
    const resolution = typeof how === 'string' ? (EDGE_RESOLUTION[how] ?? 'resolved') : 'resolved';
    const others = [...stringList(edge.properties['otherVersionIds']), ...stringList(edge.properties['ambiguousActiveIds'])];
    const candidates = [...new Set([edge.toId, ...others])].sort() as ComponentId[];
    const named = resolution === 'ambiguous' || resolution === 'no-active-version';
    return { targetId: named ? null : edge.toId, targetResolution: resolution, targetCandidateIds: candidates };
  };
  const apexEdges = ipEdges.filter((e) => e.edgeType === 'callsApex');

  for (const seed of seeds) {
    let target: ResolvedTarget;
    if (seed.kind === 'dataraptor' || seed.kind === 'integration-procedure') {
      target = fromEdge(seed) ?? classifyTarget(seed.target, await indexFor(seed.kind), seed.kind);
    } else if (seed.kind === 'remote-action') {
      const wanted = `ApexClass:${seed.apexApiName ?? ''}`.toLowerCase();
      const edge = apexEdges.find((e) => e.toId.toLowerCase() === wanted);
      const id = (edge?.toId ?? `ApexClass:${seed.apexApiName ?? ''}`) as ComponentId;
      let found: boolean;
      if (edge !== undefined) found = present.has(edge.toId);
      else {
        const r = await getNodeById(ctx.graph, id);
        found = r.ok && r.value !== null;
      }
      target = found
        ? { targetId: id, targetResolution: 'resolved', targetCandidateIds: [id] }
        : { targetId: null, targetResolution: 'not-in-vault', targetCandidateIds: [] };
    } else if (seed.kind === 'delete') {
      const id = `CustomObject:${seed.target}` as ComponentId;
      const r = await getNodeById(ctx.graph, id);
      target = r.ok && r.value !== null
        ? { targetId: id, targetResolution: 'resolved', targetCandidateIds: [id] }
        : NOT_APPLICABLE;
    } else {
      target = NOT_APPLICABLE;
    }

    resolved.push({
      stepName: seed.stepName,
      stepPath: seed.stepPath,
      kind: seed.kind,
      target: seed.target,
      targetId: target.targetId,
      targetResolution: target.targetResolution,
      targetCandidateIds: target.targetCandidateIds,
      namedCredential: seed.namedCredential,
      endpointConfidence: 'parsed',
      ...(seed.kind === 'delete' ? { dataAccess: { reads: [], writes: [seed.target] } } : {}),
    });
  }

  // What each resolved DataMapper reads and writes, from its access edges.
  const mapperIds = [...new Set(resolved.filter((e) => e.kind === 'dataraptor' && e.targetId !== null).map((e) => e.targetId as ComponentId))];
  if (mapperIds.length === 0) return resolved;
  const access = await listEdgesForNodes(ctx.graph, mapperIds, { direction: 'out' });
  if (!access.ok) return resolved;
  const accessOf = new Map<string, { reads: string[]; writes: string[] }>();
  for (const id of mapperIds) {
    const reads = new Set<string>();
    const writes = new Set<string>();
    for (const e of access.value.get(id) ?? []) {
      const object = objectOfTarget(e.toId);
      if (object === null) continue;
      if (e.edgeType === 'readsFrom') reads.add(object);
      else if (e.edgeType === 'writesTo') writes.add(object);
    }
    accessOf.set(id, { reads: [...reads].sort(), writes: [...writes].sort() });
  }
  return resolved.map((e) => (e.kind === 'dataraptor' && e.targetId !== null ? { ...e, dataAccess: accessOf.get(e.targetId) ?? { reads: [], writes: [] } } : e));
};

/** The chain's own footprint, summed over its endpoints. */
const summarizeDataAccess = (endpoints: readonly ExternalEndpoint[]): IntegrationProcedureChainOutput['dataAccess'] => {
  const set = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
  const ids = (kind: ExternalEndpoint['kind']): string[] =>
    set(endpoints.filter((e) => e.kind === kind && e.targetId !== null).map((e) => e.targetId as string));
  return {
    reads: set(endpoints.filter((e) => e.kind === 'dataraptor').flatMap((e) => e.dataAccess?.reads ?? [])),
    writes: set(endpoints.filter((e) => e.kind === 'dataraptor').flatMap((e) => e.dataAccess?.writes ?? [])),
    deletes: set(endpoints.filter((e) => e.kind === 'delete').map((e) => e.target)),
    apexClasses: ids('remote-action'),
    ipsCalled: ids('integration-procedure'),
    mappersCalled: ids('dataraptor'),
  };
};

// ---------------------------------------------------------------------
// Node-property readers
// ---------------------------------------------------------------------

/**
 * Read a stored Node property as a non-empty string, or `null` when
 * absent / wrong type. Centralized so the metadata block in the
 * response shape stays unambiguous about the absent vs empty case
 * (the IP extractor surfaces missing top-level XML elements as
 * `null`, never as `""`).
 */
const readNodeStringProperty = (node: Node, key: string): string | null => {
  const value = node.properties[key];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

/** Same shape as the string reader for stored numeric properties. */
const readNodeNumberProperty = (node: Node, key: string): number | null => {
  const value = node.properties[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
};

/**
 * Read a stored Node boolean. Defaults to `false` for absent / wrong
 * type — mirrors the extractor's `coerceBoolean` convention so the
 * metadata.isActive default lines up with the source-of-truth
 * extractor.
 */
const readNodeBooleanProperty = (node: Node, key: string): boolean => {
  const value = node.properties[key];
  return value === true;
};
