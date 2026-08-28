/**
 * Handler for the `sfi.integration_procedure_chain` MCP tool.
 *
 * The second of five v3.2 R3 OmniStudio composer tools. Given an
 * OmniIntegrationProcedure (IP) canonical id, walks the IP's action
 * chain in `sequenceNumber` order and surfaces:
 *
 *   1. The IP's identity metadata (`omniProcessKey`, `versionNumber`,
 *      `subType`, `type`, `uniqueName`, `isActive`).
 *   2. The ordered action list — every `<omniProcessElements>` child of
 *      the IP's `*.oip-meta.xml` file. Each action carries its `name`,
 *      `type`, `description`, `sequenceNumber`, `isActive`, and the
 *      optional `executionConditionalFormula` extracted from the
 *      `propertySetConfig` JSON.
 *   3. The `externalEndpoints[]` payload — every action whose
 *      `propertySetConfig` declares a downstream target:
 *        - `Rest Action` → kind `'rest'`; target = `restPath`;
 *          `namedCredential` carried alongside.
 *        - `DataRaptor Extract/Transform/Load Action` →
 *          kind `'dataraptor'`; target = the `bundle` field; `targetId`
 *          resolves to the OmniDataTransform node whose
 *          `properties.name` matches (the node id is the VERSIONED
 *          filename stem, so the bundle name is not it).
 *        - `Integration Procedure Action` →
 *          kind `'integration-procedure'`; target = the
 *          `integrationProcedureKey`; `targetId` resolves to the IP
 *          node whose `properties.omniProcessKey` matches (the node id
 *          is the filename stem, so the key is not it).
 *          Both kinds carry `targetResolution` +
 *          `targetCandidateIds` — see `ExternalEndpoint`.
 *        - `Remote Action` → kind `'remote-action'`; target =
 *          `{remoteClass}.{remoteMethod}`. No `targetId` resolution —
 *          Apex→OmniProcess edges are the v3.3
 *          `implementsOmniInterface` follow-up.
 *   4. The `responseShape` parsed from the terminal `Response Action`'s
 *      `propertySetConfig.additionalOutput` (the response template).
 *   5. The verbatim honesty disclosures bundled into `boundaries[]`:
 *      Native-vs-Vlocity-Legacy (ALWAYS), the v3.3 Apex-deferral
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
import { getNodeById } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

import type { Context } from '../server.js';

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
 * Action `type` values that emit a `dataraptor`-kind external endpoint.
 * Mirrors the extractor's edge-emission matrix (the three DataRaptor
 * variants share the same `bundle` JSON key). See
 * `docs/vendor/salesforce-metadata/OmniIntegrationProcedure.md`
 * §"Common action `type` values".
 */
const DATARAPTOR_ACTION_TYPES: ReadonlySet<string> = new Set([
  'DataRaptor Extract Action',
  'DataRaptor Transform Action',
  'DataRaptor Load Action',
]);

/** Discriminant `type` value of an HTTP callout step. */
const REST_ACTION_TYPE = 'Rest Action';
/** Discriminant `type` value of a step calling a nested IP. */
const NESTED_IP_ACTION_TYPE = 'Integration Procedure Action';
/** Discriminant `type` value of a step calling an Apex method. */
const REMOTE_ACTION_TYPE = 'Remote Action';
/** Discriminant `type` value of the terminal response-shaping step. */
const RESPONSE_ACTION_TYPE = 'Response Action';

/**
 * Native-vs-Vlocity-Legacy honesty disclosure. Surfaced on every
 * response per PLAN-v3.2.md §4 (axis 1) and §5 (the
 * salesforce-industries-routing skill's verbatim-disclosure
 * discipline). Frozen as a constant so the test suite can assert the
 * exact string — a paraphrasing during rendering is a code-review
 * concern, not a silent drift.
 */
const NATIVE_VS_VLOCITY_DISCLOSURE =
  'v3.2 recognizes Industries Native XML shapes (file extensions ' +
  '`.os-meta.xml`, `.oip-meta.xml`, `.rpt-meta.xml`, `.ouc-meta.xml`, ' +
  '`.decisionTable-meta.xml`). Legacy Vlocity-managed-package components ' +
  '(namespace `vlocity_cmt__`) are NOT extracted by v3.2. Mid-migration ' +
  'orgs may show partial coverage.';

/**
 * v3.3 Apex-coupling deferral disclosure. Surfaced on every IP-chain
 * response because Remote Action steps may invite callers to assume
 * Apex-edge coverage; the absence of that coverage is documented per
 * PLAN-v3.2.md §4 (axis 3) and §5.
 */
const APEX_COUPLING_DEFERRAL_DISCLOSURE =
  'v3.2 captures OmniStudio components and intra-OmniStudio call chains ' +
  '(`dispatchesOmniAction`). The Apex-to-OmniProcess coupling ' +
  '(`implements omnistudio.VlocityOpenInterface` etc.) is a v3.3 ' +
  'follow-up — those edges are NOT yet in the graph.';

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
  readonly kind: 'rest' | 'dataraptor' | 'remote-action' | 'integration-procedure';
  readonly target: string;
  readonly targetId: ComponentId | null;
  /**
   * Why `targetId` looks the way it does. Every reason a `targetId`
   * can be `null` is a DIFFERENT claim, and only one of them is an
   * affirmative fact about the org:
   *   - `'resolved'` — exactly one node in the vault answers to this
   *     target name; `targetId` is populated.
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
   *   - `'not-applicable'` — `rest` / `remote-action` kinds, which
   *     never attempt a `targetId` lookup at all.
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
}

/** @see ExternalEndpoint.targetResolution */
export type TargetResolution =
  | 'resolved'
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
 *       'OmniIntegrationProcedure:AccountLiniking_MPPValidation_Procedure_1',
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
  const rootObj = root as Record<string, unknown>;

  const includePsc = input.includeChildPropertySetConfig === true;
  const walk = walkActions(rootObj, includePsc);
  const externalEndpoints = await resolveExternalEndpoints(
    ctx,
    walk.endpointSeeds,
  );

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
  readonly kind: ExternalEndpoint['kind'];
  readonly target: string;
  readonly namedCredential: string | null;
}

interface ActionWalk {
  readonly actions: readonly IntegrationProcedureAction[];
  readonly endpointSeeds: readonly EndpointSeed[];
  readonly responseShape: ResponseShape;
}

/**
 * Walk every `<omniProcessElements>` child. For each:
 *   - Build the per-action row (always).
 *   - When the action's `type` indicates an external dispatch, push a
 *     seed onto `endpointSeeds` for the post-walk graph-lookup pass.
 *   - When the action is a `Response Action`, parse its
 *     `additionalOutput` into `responseShape` (last-write-wins if
 *     the IP carries multiple, which is non-canonical but tolerated).
 *
 * Action rows are sorted by `sequenceNumber` ASC after the walk; the
 * walk itself preserves XML document order so equal sequence numbers
 * fall back to declaration order in the sort's stable comparator.
 */
const walkActions = (
  rootObj: Record<string, unknown>,
  includePsc: boolean,
): ActionWalk => {
  const elements = toArray(rootObj['omniProcessElements']);
  const actions: IntegrationProcedureAction[] = [];
  const endpointSeeds: EndpointSeed[] = [];
  let responseAdditionalOutput: Record<string, unknown> | null = null;
  let responseReturnOnlyAdditionalOutput: boolean | null = null;

  for (const raw of elements) {
    if (typeof raw !== 'object' || raw === null) continue;
    const element = raw as Record<string, unknown>;
    const type = nonEmptyString(unwrapSingle(element['type']));
    if (type === null) continue;

    const name = nonEmptyString(unwrapSingle(element['name'])) ?? '';
    const description = nonEmptyString(unwrapSingle(element['description']));
    const sequenceNumber = coerceNumber(unwrapSingle(element['sequenceNumber']));
    const isActive = coerceBoolean(unwrapSingle(element['isActive']));
    const psc = parsePropertySetConfig(element['propertySetConfig']);
    const executionConditionalFormula =
      psc === null
        ? null
        : nonEmptyString(psc['executionConditionalFormula']);

    const action: IntegrationProcedureAction = includePsc && psc !== null
      ? {
          name,
          type,
          description,
          sequenceNumber,
          isActive,
          executionConditionalFormula,
          propertySetConfigParsed: psc,
        }
      : {
          name,
          type,
          description,
          sequenceNumber,
          isActive,
          executionConditionalFormula,
        };
    actions.push(action);

    // Endpoint classification mirrors the extractor's edge-emission
    // matrix — REST Action (external URL; no edge), DataRaptor Actions
    // (DataTransform target via `bundle`), Integration Procedure Action
    // (IP target via `integrationProcedureKey`), and Remote Action
    // (Apex target via `remoteClass` + `remoteMethod`; surfaced here
    // for visibility but NOT emitted as a graph edge — that is v3.3's
    // `implementsOmniInterface` follow-up).
    if (type === REST_ACTION_TYPE) {
      const restPath = psc === null ? null : nonEmptyString(psc['restPath']);
      if (restPath !== null) {
        endpointSeeds.push({
          stepName: name,
          kind: 'rest',
          target: restPath,
          namedCredential:
            psc === null ? null : nonEmptyString(psc['namedCredential']),
        });
      }
    } else if (DATARAPTOR_ACTION_TYPES.has(type)) {
      const bundle = psc === null ? null : nonEmptyString(psc['bundle']);
      if (bundle !== null) {
        endpointSeeds.push({
          stepName: name,
          kind: 'dataraptor',
          target: bundle,
          namedCredential: null,
        });
      }
    } else if (type === NESTED_IP_ACTION_TYPE) {
      const ipKey =
        psc === null ? null : nonEmptyString(psc['integrationProcedureKey']);
      if (ipKey !== null) {
        endpointSeeds.push({
          stepName: name,
          kind: 'integration-procedure',
          target: ipKey,
          namedCredential: null,
        });
      }
    } else if (type === REMOTE_ACTION_TYPE) {
      const remoteClass =
        psc === null ? null : nonEmptyString(psc['remoteClass']);
      const remoteMethod =
        psc === null ? null : nonEmptyString(psc['remoteMethod']);
      if (remoteClass !== null && remoteMethod !== null) {
        endpointSeeds.push({
          stepName: name,
          kind: 'remote-action',
          target: `${remoteClass}.${remoteMethod}`,
          namedCredential: null,
        });
      }
    } else if (type === RESPONSE_ACTION_TYPE) {
      // Last-write-wins on the rare multi-response shape — the
      // canonical authoring pattern is one terminal Response Action,
      // and this tool surfaces the last one walked.
      if (psc !== null) {
        const additional = psc['additionalOutput'];
        if (
          typeof additional === 'object' &&
          additional !== null &&
          !Array.isArray(additional)
        ) {
          responseAdditionalOutput = additional as Record<string, unknown>;
        }
        const returnOnly = psc['returnOnlyAdditionalOutput'];
        if (typeof returnOnly === 'boolean') {
          responseReturnOnlyAdditionalOutput = returnOnly;
        }
      }
    }
  }

  // Sort by sequenceNumber ASC; equal-sequence steps fall back to
  // declaration order via Array.prototype.sort's stability.
  const sortedActions = [...actions].sort(
    (a, b) => a.sequenceNumber - b.sequenceNumber,
  );

  return {
    actions: sortedActions,
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

/**
 * One node type's resolution index, or the fact that it could not be
 * read. `complete` is the honesty hinge: a miss against an INCOMPLETE
 * index proves nothing, so it may not be published as `'not-in-vault'`.
 */
type TargetIndex =
  | {
      readonly ok: true;
      /** Every canonical node id of the type, for the conventional form. */
      readonly byId: ReadonlySet<string>;
      /** Key-property value → every node id carrying it. */
      readonly byKey: ReadonlyMap<string, readonly ComponentId[]>;
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
  const byId = new Set<string>();
  const byKey = new Map<string, ComponentId[]>();
  for (const node of scan.value.nodes) {
    byId.add(node.id);
    const keyValue = node.properties[keyProperty];
    if (typeof keyValue !== 'string') continue;
    const trimmed = keyValue.trim();
    if (trimmed.length === 0) continue;
    const bucket = byKey.get(trimmed);
    if (bucket === undefined) byKey.set(trimmed, [node.id]);
    else bucket.push(node.id);
  }
  return { ok: true, byId, byKey, complete: !scan.value.scanIncomplete };
};

/** The derived resolution state of ONE endpoint seed. */
interface ResolvedTarget {
  readonly targetId: ComponentId | null;
  readonly targetResolution: TargetResolution;
  readonly targetCandidateIds: readonly ComponentId[];
}

/** `rest` / `remote-action`: no lookup is attempted, ever. */
const NOT_APPLICABLE: ResolvedTarget = {
  targetId: null,
  targetResolution: 'not-applicable',
  targetCandidateIds: [],
};

/**
 * Classify ONE target name against a built index. Written ONCE and
 * called by BOTH resolvable kinds — the previous shape spelled this
 * mapping out twice, byte-identically, and only one copy was covered by
 * a test, so a regression on the other was invisible.
 *
 * Candidates are the union of the conventional id form and every node
 * carrying the key property, so a vault where both happen to hit yields
 * one candidate rather than a false ambiguity.
 */
const classifyTarget = (
  target: string,
  index: TargetIndex,
  prefix: string,
): ResolvedTarget => {
  if (!index.ok) {
    return {
      targetId: null,
      targetResolution: 'lookup-failed',
      targetCandidateIds: [],
    };
  }
  const seen = new Set<string>();
  const candidates: ComponentId[] = [];
  for (const id of index.byKey.get(target) ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push(id);
  }
  const conventionalId = `${prefix}${target}`;
  if (index.byId.has(conventionalId) && !seen.has(conventionalId)) {
    candidates.push(conventionalId as ComponentId);
  }
  candidates.sort();

  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) {
    return { targetId: only, targetResolution: 'resolved', targetCandidateIds: candidates };
  }
  if (candidates.length > 1) {
    // Do not pick one. Which version runs is a RUNTIME activation fact
    // the vault does not carry; naming a single `targetId` here would
    // certify a choice nothing in the retrieved metadata makes.
    return { targetId: null, targetResolution: 'ambiguous', targetCandidateIds: candidates };
  }
  return {
    targetId: null,
    // A miss is only ABSENCE when the whole type was read. Behind a
    // residual cap it is merely unread.
    targetResolution: index.complete ? 'not-in-vault' : 'unresolved',
    targetCandidateIds: [],
  };
};

/**
 * Resolve each endpoint seed against the graph. `dataraptor` targets
 * name an OmniDataTransform by its `<name>`; `integration-procedure`
 * targets name an IP by its `omniProcessKey` — in both cases a PROPERTY,
 * not the node id, which the extractors derive from the filename. `rest`
 * and `remote-action` kinds never resolve — REST URLs are external, and
 * Remote Action class.method targets are the v3.3
 * `implementsOmniInterface` follow-up.
 *
 * Each node type is walked at most ONCE per call, and only when a seed
 * of that kind is present, so an IP with no DataRaptor steps pays for no
 * DataRaptor scan.
 *
 * The endpoint's `target` (the verbatim name) is always present so the
 * renderer can flag an unresolved reference, and `targetResolution` says
 * WHICH of the four non-resolutions applies — a proven absence, an
 * ambiguity across versions, an unread tail, or a failed read. Only the
 * first is an assertion about the org.
 */
const resolveExternalEndpoints = async (
  ctx: Context,
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

  for (const seed of seeds) {
    const target =
      seed.kind === 'dataraptor' || seed.kind === 'integration-procedure'
        ? classifyTarget(
            seed.target,
            await indexFor(seed.kind),
            TARGET_ID_PREFIX[seed.kind],
          )
        : NOT_APPLICABLE;

    resolved.push({
      stepName: seed.stepName,
      kind: seed.kind,
      target: seed.target,
      targetId: target.targetId,
      targetResolution: target.targetResolution,
      targetCandidateIds: target.targetCandidateIds,
      namedCredential: seed.namedCredential,
      endpointConfidence: 'parsed',
    });
  }

  return resolved;
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
