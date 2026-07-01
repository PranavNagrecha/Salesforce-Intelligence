/**
 * Handler for the `sfi.integration_map` MCP tool.
 *
 * The v1.5 architect-tier headline tool: returns a structured topology
 * of every integration surface an org exposes — AuthProviders, Named-
 * Credentials, RemoteSiteSettings, CspTrustedSites, ExternalDataSources,
 * ExternalServices, ConnectedApps, and NetworkAccess entries — plus the
 * cross-type `references` edges that tie them together (e.g., an
 * ExternalDataSource referencing its declared AuthProvider; an Auth-
 * Provider referencing its issuing ConnectedApp).
 *
 * It ALSO surfaces the OmniStudio Integration Procedure outbound callout
 * surface (`omniStudio`): IP `Rest Action` / `Remote Action` steps call
 * external systems, but their destinations live in the IP node's
 * extracted `restEndpoints` / `remoteActions` properties rather than as
 * first-class integration ComponentTypes. Without this section an
 * OmniStudio org (whose external surface is overwhelmingly IP REST
 * callouts) would read as having "No integration metadata found".
 *
 * The architect's question this tool answers: "what external systems
 * does my org talk to, what trust mechanism do they use, and which
 * pieces are wired together?". One call returns the full map.
 *
 * The cascade, in this exact order:
 *
 *   1. **Per-category enumeration** — for each integration ComponentType
 *      in scope (controlled by `filter`), call `listNodesByType` with a
 *      per-category limit derived from the caller's overall `limit` so
 *      the eight category buckets share the cap fairly.
 *
 *   2. **Reference edge collection** — for each integration node in the
 *      result set, list outgoing `references` edges. Include only those
 *      whose `toId` is itself an integration node (the result is the
 *      connected sub-graph, not every outgoing reference an integration
 *      node happens to emit).
 *
 *   3. **Deterministic sort** — every node array is sorted by `id` ASC,
 *      and the cross-type `references` array by `(fromId, toId, role)`
 *      ASC so the output is stable across runs.
 *
 * Implementation notes:
 *   - The eight integration ComponentTypes share a single per-category
 *     limit (`ceil(limit / 8)`) so the overall result stays under the
 *     caller's cap. Categories the caller scoped out via `filter`
 *     surface as empty arrays — the shape is stable so MCP clients can
 *     access every field without conditional checks.
 *   - `filter='auth'` returns AuthProvider + ConnectedApp (both auth
 *     mechanisms); `filter='sites'` returns RemoteSiteSetting +
 *     CspTrustedSite + NetworkAccess (URL / CSP / IP allowlists);
 *     `filter='sources'` returns ExternalDataSource + ExternalService
 *     (data binding / API binding); `filter='services'` is a synonym
 *     for `sources` per the spec; `filter='access'` returns Named-
 *     Credential + AuthProvider + NetworkAccess (the access-trust
 *     spine). `filter='all'` (default) returns every category.
 *   - The reference edges returned are the connected sub-graph of the
 *     integration surface. An ExternalDataSource referencing a Named-
 *     Credential lands in the result; an ExternalDataSource
 *     referencing a non-integration ComponentType (e.g., a CustomField)
 *     does not. This is what makes the output a coherent "map" rather
 *     than an unbounded fan-out.
 */

import type {
  ComponentId,
  ComponentType,
  EdgeType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Inclusive upper bound on `limit`. Mirrors the
 * `FIND_APEX_USAGES_MAX_LIMIT` and `FORMULA_REFS_MAX_LIMIT` ceilings so
 * every enumeration-style MCP tool shares the same blast-radius cap.
 */
const INTEGRATION_MAP_MAX_LIMIT = 500;

/**
 * Default `limit` when the caller omits it. Set to 100 because the
 * integration surface tends to be denser than a single component's
 * incoming-edge count — an org with eight surfaces in scope typically
 * wants ~12 per category, which 100 / 8 = 12.5 (rounded up) provides.
 */
const INTEGRATION_MAP_DEFAULT_LIMIT = 100;

/**
 * The eight integration ComponentTypes the tool enumerates. Ordered
 * from "trust anchor" (AuthProvider) to "callable surface" (External-
 * Service) so the output reads top-down. The order matters for the
 * `filter` mapping and the per-category limit computation.
 */
const INTEGRATION_TYPES = [
  'AuthProvider',
  'NamedCredential',
  'RemoteSiteSetting',
  'CspTrustedSite',
  'ExternalDataSource',
  'ExternalService',
  'ConnectedApp',
  'NetworkAccess',
] as const satisfies readonly ComponentType[];

/**
 * Set of every integration ComponentType, indexed for O(1) membership
 * checks in the cross-type `references` edge filter (stage 2 of the
 * cascade). An edge's `toId` is "another integration type" if the
 * target node's type is in this set.
 */
const INTEGRATION_TYPE_SET: ReadonlySet<ComponentType> = new Set(
  INTEGRATION_TYPES,
);

/**
 * The `references` edge type used for the cross-type connections. The
 * v1.5 integration topology extractors emit `references` (not a new
 * EdgeType) to link an ExternalDataSource to its AuthProvider, an
 * AuthProvider to its issuing ConnectedApp, etc. — see
 * PLAN-v1.5.md §3 for the rationale.
 */
const REFERENCES_EDGE_TYPE: EdgeType = 'references';

/**
 * Mapping from `filter` value to the set of ComponentTypes that
 * filter surfaces. `'all'` (default) returns every integration type.
 * The other values match the architect's three mental cuts:
 *   - `'auth'`: trust mechanisms (AuthProvider + ConnectedApp).
 *   - `'sites'`: URL / CSP / IP allowlists (RemoteSiteSetting +
 *     CspTrustedSite + NetworkAccess).
 *   - `'sources'` / `'services'`: external bindings (External-
 *     DataSource + ExternalService). Synonymous per the spec —
 *     callers commonly use either word for the same architectural
 *     concern.
 *   - `'access'`: the access-trust spine (NamedCredential +
 *     AuthProvider + NetworkAccess) — what an admin checks when
 *     auditing "what can call out and who proves identity".
 */
const FILTER_TYPE_MAP: Readonly<Record<string, readonly ComponentType[]>> = {
  all: INTEGRATION_TYPES,
  auth: ['AuthProvider', 'ConnectedApp'],
  sites: ['RemoteSiteSetting', 'CspTrustedSite', 'NetworkAccess'],
  sources: ['ExternalDataSource', 'ExternalService'],
  services: ['ExternalDataSource', 'ExternalService'],
  access: ['NamedCredential', 'AuthProvider', 'NetworkAccess'],
};

/**
 * Zod schema for the `sfi.integration_map` tool input.
 *
 *   - `filter`: optional enum narrowing the result to a category set.
 *     Defaults to `'all'` when omitted.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100. Split
 *     evenly across the in-scope ComponentTypes inside the handler so
 *     no single category dominates the response.
 */
export const integrationMapInputSchema = z.object({
  filter: z
    .enum(['auth', 'sites', 'sources', 'services', 'access', 'all'])
    .optional(),
  limit: z.number().int().min(1).max(INTEGRATION_MAP_MAX_LIMIT).optional(),
});

/** Parsed input shape, inferred from `integrationMapInputSchema`. */
export type IntegrationMapInput = z.infer<typeof integrationMapInputSchema>;

/**
 * One node in the integration map. Mirrors a v1.5 integration node
 * with just the fields callers need to render a map: identity (`id`,
 * `type`, `apiName`, `label`) plus the extracted `properties` blob
 * carrying surface-specific data (callout URL for RemoteSiteSetting,
 * principal type for NamedCredential, etc.).
 */
export interface IntegrationMapNode {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly label: string;
  readonly properties: Readonly<Record<string, unknown>>;
  /**
   * Count of inbound `references` edges that point AT this node from
   * elsewhere in the graph (an ExternalService binding a NamedCredential,
   * an OmniStudio IP declaring a `callout:` alias, an ExternalDataSource
   * naming its AuthProvider, etc.). Present only for NamedCredential and
   * AuthProvider nodes — the two trust anchors for which "is anything
   * actually wired to this?" is a grounded, determinate question. A `0`
   * here is the grounded basis for {@link orphaned}.
   */
  readonly referenceCount?: number;
  /**
   * `true` when {@link referenceCount} is `0`: nothing in the retrieved
   * metadata references this trust anchor. Surfaced ONLY for
   * NamedCredential / AuthProvider so the map can answer "which named
   * credential authorizes X" with a determinate "none of these — they are
   * orphaned" instead of falsely implying every credential is wired.
   * Honest-boundary: this counts references the retrieve modeled; an
   * Apex `callout:` reference is modeled only when the apex scanner
   * captured it, so an `orphaned: true` is "no MODELED reference",
   * not a guarantee of zero runtime use — see {@link APEX_CALLOUT_DISCLOSURE}.
   */
  readonly orphaned?: boolean;
}

/**
 * One cross-type reference edge. Combines the two endpoint ids with the
 * edge's metadata (`role` from the extractor — e.g., `'authProvider'`
 * for an ExternalDataSource → AuthProvider edge). The shape is
 * intentionally narrower than the full graph `Edge` — callers want a
 * compact map, not the full edge metadata blob.
 */
export interface IntegrationMapEdge {
  readonly fromId: ComponentId;
  readonly toId: ComponentId;
  readonly edgeType: EdgeType;
  readonly role?: string;
}

/**
 * One outbound REST callout surfaced from an OmniStudio Integration
 * Procedure `Rest Action` step (the IP node's `restEndpoints`
 * property). `sourceComponentId` is the IP node; `path` the verbatim
 * REST path; `namedCredential` the declared host alias (or `null`).
 */
export interface OmniRestCallout {
  readonly sourceComponentId: ComponentId;
  readonly stepName: string;
  readonly path: string;
  readonly method: string | null;
  readonly namedCredential: string | null;
}

/**
 * One Apex callout surfaced from an OmniStudio Integration Procedure
 * `Remote Action` step (the IP node's `remoteActions` property).
 */
export interface OmniRemoteCallout {
  readonly sourceComponentId: ComponentId;
  readonly stepName: string;
  readonly remoteClass: string;
  readonly remoteMethod: string | null;
}

/**
 * The OmniStudio outbound callout surface. Surfaced as its own section
 * because OmniStudio Integration Procedures call external systems via
 * `Rest Action` / `Remote Action` steps whose destinations live in the
 * IP node's extracted `restEndpoints` / `remoteActions` properties —
 * NOT as first-class integration ComponentTypes the eight-bucket
 * enumeration would find. `referencedNamedCredentials` is the distinct,
 * sorted set of host aliases the REST callouts depend on.
 */
export interface OmniStudioIntegrationSurface {
  readonly restCallouts: readonly OmniRestCallout[];
  readonly remoteCallouts: readonly OmniRemoteCallout[];
  readonly referencedNamedCredentials: readonly string[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface IntegrationMapOutput {
  readonly authProviders: readonly IntegrationMapNode[];
  readonly namedCredentials: readonly IntegrationMapNode[];
  readonly remoteSiteSettings: readonly IntegrationMapNode[];
  readonly cspTrustedSites: readonly IntegrationMapNode[];
  readonly externalDataSources: readonly IntegrationMapNode[];
  readonly externalServices: readonly IntegrationMapNode[];
  readonly connectedApps: readonly IntegrationMapNode[];
  readonly networkAccesses: readonly IntegrationMapNode[];
  readonly references: readonly IntegrationMapEdge[];
  /**
   * The OmniStudio Integration Procedure outbound callout surface
   * (`Rest Action` / `Remote Action` destinations). Empty arrays when
   * no IP declares a callout (or the vault predates the
   * omni-integration-procedure extractor change). This is what lets the
   * map surface an OmniStudio org's external-callout surface even when
   * it declares zero classic integration ComponentTypes.
   */
  readonly omniStudio: OmniStudioIntegrationSurface;
  /**
   * Present ONLY when every bucket is empty AND the OmniStudio surface
   * is empty. Distinguishes "this org has no integration metadata (or it
   * wasn't retrieved)" from a broken tool — an all-empty map otherwise
   * reads as a failure to a newcomer.
   */
  readonly note?: string;
  /** Always present: Apex HTTP callouts are out of scope; where to find them. */
  readonly apexCalloutDisclosure: string;
  /**
   * Always present: the grounded, determinate answer to "which trust
   * mechanism authorizes an outbound HTTP callout in this org". Apex /
   * legacy outbound HTTP callouts are authorized EITHER by an active
   * RemoteSiteSetting (when the endpoint URL is hardcoded — `Http.request`
   * to a literal host) OR by a NamedCredential (when the code addresses
   * `callout:{alias}`). This note states which RemoteSiteSettings are
   * present in THIS map (they authorize hardcoded-URL callouts) and which
   * NamedCredentials are referenced vs orphaned — so a caller can answer
   * the authorization question from the map instead of abstaining with a
   * coverage-gap claim when the components ARE present.
   */
  readonly calloutAuthorizationNote: string;
}

/** Honest-empty note attached when the integration map has zero components. */
const INTEGRATION_EMPTY_NOTE =
  'No integration metadata found in this vault. Either this org declares no AuthProviders / NamedCredentials / RemoteSiteSettings / ExternalDataSources / etc., or those types were not included in the retrieve. This is an empty result, not an error. NOTE: this map does not enumerate Apex HTTP callouts (see apexCalloutDisclosure) — an org whose integration is entirely Apex-based can still be active here.';

/** Always-present boundary: Apex HTTP callouts are out of scope for this map. */
const APEX_CALLOUT_DISCLOSURE =
  "This map covers DECLARED integration metadata (AuthProvider / NamedCredential / RemoteSiteSetting / CspTrustedSite / ExternalDataSource / ExternalService / ConnectedApp / NetworkAccess) plus OmniStudio callouts. The individual Apex callsites (`Http.request` / `HttpRequest.setEndpoint`) are not listed as rows here — enumerate them with `sfi.find_code_usages` on `Http`/`HttpRequest` or `sfi.search_apex_source('setEndpoint')`. The TRUST mechanism that AUTHORIZES those callouts IS in this map, however: see `calloutAuthorizationNote` and the RemoteSiteSetting / NamedCredential sections.";

/**
 * Build the grounded `calloutAuthorizationNote` from the components
 * actually present in the map. This is the determinate answer to "which
 * named credential or remote site setting authorizes the outbound
 * callouts" — derived from the retrieved RemoteSiteSetting nodes and the
 * NamedCredential reference/orphan analysis, NOT abstained.
 */
const buildCalloutAuthorizationNote = (
  remoteSiteSettings: readonly IntegrationMapNode[],
  namedCredentials: readonly IntegrationMapNode[],
): string => {
  const rssNames = remoteSiteSettings.map((n) => n.apiName).sort();
  const referencedNcs = namedCredentials
    .filter((n) => n.orphaned !== true)
    .map((n) => n.apiName)
    .sort();
  const orphanedNcs = namedCredentials
    .filter((n) => n.orphaned === true)
    .map((n) => n.apiName)
    .sort();

  const rssPart =
    rssNames.length > 0
      ? `Active RemoteSiteSettings authorize outbound HTTP callouts to a hardcoded endpoint URL (an Apex \`Http.request\` to a literal host): ${rssNames.join(', ')}.`
      : 'This map contains no RemoteSiteSettings, so no hardcoded-URL outbound callout is authorized by a remote site setting.';

  const ncPart =
    namedCredentials.length === 0
      ? 'This map contains no NamedCredentials, so no callout addresses a `callout:{alias}` endpoint.'
      : `NamedCredentials authorize callouts that address \`callout:{alias}\`. Referenced (something in the retrieved metadata is wired to them): ${
          referencedNcs.length > 0 ? referencedNcs.join(', ') : 'none'
        }. Orphaned (no modeled reference — present but nothing wires to them): ${
          orphanedNcs.length > 0 ? orphanedNcs.join(', ') : 'none'
        }.`;

  return `${rssPart} ${ncPart} To attribute a SPECIFIC class's callout, match its endpoint: a \`callout:{alias}\` literal => the NamedCredential of that alias; a hardcoded \`https://host\` => the RemoteSiteSetting whose URL covers that host.`;
};

/**
 * Convert a `Node` from the graph to a compact `IntegrationMapNode`.
 * The label is normalised to a non-null string so the JSON contract is
 * stable (a missing label round-trips to an empty string rather than
 * `null` in the JSON envelope).
 */
const toMapNode = (node: Node): IntegrationMapNode => ({
  id: node.id,
  type: node.type,
  apiName: node.apiName,
  label: node.label ?? '',
  properties: node.properties,
});

/**
 * Deterministic node comparator: id ASC. The graph already returns
 * nodes sorted by id from `listNodesByType`, but a re-sort here keeps
 * the contract independent of upstream ordering changes.
 */
const compareNodes = (a: IntegrationMapNode, b: IntegrationMapNode): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Deterministic edge comparator: `fromId` ASC, then `toId` ASC, then
 * `role` ASC (empty roles sort first). The triple-key sort makes the
 * `references` array stable when the same pair of integration nodes
 * has multiple edges with distinct roles.
 */
const compareEdges = (a: IntegrationMapEdge, b: IntegrationMapEdge): number => {
  if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
  if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
  const ra = a.role ?? '';
  const rb = b.role ?? '';
  if (ra !== rb) return ra < rb ? -1 : 1;
  return 0;
};

/**
 * Resolve a `properties.role` value into a typed string. The v1.5
 * integration extractors emit a string `role` field on each
 * `references` edge (`'authProvider'`, `'namedCredential'`, etc.) but
 * the JSON-backed properties blob is `unknown` at the type level. This
 * narrowing keeps the output's `role` field strictly `string | undefined`.
 */
const resolveRole = (properties: Readonly<Record<string, unknown>>): string | undefined => {
  const role = properties['role'];
  return typeof role === 'string' && role.length > 0 ? role : undefined;
};

/**
 * The `filter` values for which the OmniStudio outbound callout surface
 * is in scope. It is part of the org's OUTBOUND integration picture, so
 * it surfaces for `'all'`, the external-binding cuts (`'sources'` /
 * `'services'`), and the access/callout cut (`'access'`) — but NOT for
 * the pure auth (`'auth'`) or allowlist (`'sites'`) cuts, which keep
 * their narrow, classic-ComponentType scope.
 */
const OMNI_SURFACE_FILTERS: ReadonlySet<string> = new Set([
  'all',
  'sources',
  'services',
  'access',
]);

/** An empty OmniStudio surface (the value used when out of scope or absent). */
const EMPTY_OMNI_SURFACE: OmniStudioIntegrationSurface = {
  restCallouts: [],
  remoteCallouts: [],
  referencedNamedCredentials: [],
};

/**
 * Read a node's `properties.restEndpoints` (`unknown` at the JSON-backed
 * type level) into typed `OmniRestCallout`s sourced to `nodeId`.
 * Defensive: drops any element missing a non-empty string `path`.
 */
const readOmniRestCallouts = (
  nodeId: ComponentId,
  properties: Readonly<Record<string, unknown>>,
): OmniRestCallout[] => {
  const raw = properties['restEndpoints'];
  if (!Array.isArray(raw)) return [];
  const out: OmniRestCallout[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const path = rec['path'];
    if (typeof path !== 'string' || path.length === 0) continue;
    const stepName = rec['stepName'];
    const method = rec['method'];
    const namedCredential = rec['namedCredential'];
    out.push({
      sourceComponentId: nodeId,
      stepName: typeof stepName === 'string' ? stepName : '',
      path,
      method: typeof method === 'string' && method.length > 0 ? method : null,
      namedCredential:
        typeof namedCredential === 'string' && namedCredential.length > 0
          ? namedCredential
          : null,
    });
  }
  return out;
};

/**
 * Read a node's `properties.remoteActions` into typed
 * `OmniRemoteCallout`s sourced to `nodeId`. Defensive: drops any element
 * missing a non-empty string `remoteClass`.
 */
const readOmniRemoteCallouts = (
  nodeId: ComponentId,
  properties: Readonly<Record<string, unknown>>,
): OmniRemoteCallout[] => {
  const raw = properties['remoteActions'];
  if (!Array.isArray(raw)) return [];
  const out: OmniRemoteCallout[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const remoteClass = rec['remoteClass'];
    if (typeof remoteClass !== 'string' || remoteClass.length === 0) continue;
    const stepName = rec['stepName'];
    const remoteMethod = rec['remoteMethod'];
    out.push({
      sourceComponentId: nodeId,
      stepName: typeof stepName === 'string' ? stepName : '',
      remoteClass,
      remoteMethod:
        typeof remoteMethod === 'string' && remoteMethod.length > 0
          ? remoteMethod
          : null,
    });
  }
  return out;
};

/**
 * Collect the OmniStudio outbound callout surface by walking
 * OmniIntegrationProcedure nodes and flattening their extracted
 * `restEndpoints` / `remoteActions` properties. The result is sorted
 * deterministically — REST callouts by `(sourceComponentId, path)`,
 * Remote callouts by `(sourceComponentId, remoteClass)` — and the
 * referenced host aliases are de-duplicated and sorted.
 *
 * Bounded by `perCategoryLimit` (the same cap the eight classic
 * categories share), so a pathological org with thousands of IPs cannot
 * blow the response budget here either.
 *
 * Real-vault note: these are EXTRACTION-time properties; an org
 * refreshed before the omni-integration-procedure extractor change
 * surfaces an empty OmniStudio section until a re-refresh.
 */
const collectOmniSurface = async (
  ctx: Context,
  perCategoryLimit: number,
): Promise<Result<OmniStudioIntegrationSurface, McpError>> => {
  const nodesResult = await listNodesByType(
    ctx.graph,
    'OmniIntegrationProcedure',
    { limit: perCategoryLimit },
  );
  if (!nodesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodesResult.error.message}`,
    });
  }
  const restCallouts: OmniRestCallout[] = [];
  const remoteCallouts: OmniRemoteCallout[] = [];
  for (const node of nodesResult.value) {
    restCallouts.push(...readOmniRestCallouts(node.id, node.properties));
    remoteCallouts.push(...readOmniRemoteCallouts(node.id, node.properties));
  }
  restCallouts.sort((a, b) =>
    a.sourceComponentId !== b.sourceComponentId
      ? a.sourceComponentId < b.sourceComponentId
        ? -1
        : 1
      : a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0,
  );
  remoteCallouts.sort((a, b) =>
    a.sourceComponentId !== b.sourceComponentId
      ? a.sourceComponentId < b.sourceComponentId
        ? -1
        : 1
      : a.remoteClass < b.remoteClass
        ? -1
        : a.remoteClass > b.remoteClass
          ? 1
          : 0,
  );
  const referencedNamedCredentials = [
    ...new Set(
      restCallouts
        .map((c) => c.namedCredential)
        .filter((nc): nc is string => typeof nc === 'string' && nc.length > 0),
    ),
  ].sort();
  return ok({ restCallouts, remoteCallouts, referencedNamedCredentials });
};

/**
 * The `sfi.integration_map` MCP tool. Returns a structured topology of
 * every integration surface in the org (AuthProvider, NamedCredential,
 * RemoteSiteSetting, CspTrustedSite, ExternalDataSource, External-
 * Service, ConnectedApp, NetworkAccess) plus the cross-type
 * `references` edges connecting them. Filter via the `filter`
 * parameter; the per-category result share of `limit` keeps the
 * response bounded.
 *
 * @example
 *   const r = await integrationMapHandler(ctx, { filter: 'auth' });
 *   if (r.ok) console.log(r.value.data.authProviders.length);
 */
export const integrationMapHandler = async (
  ctx: Context,
  input: IntegrationMapInput,
): Promise<Result<McpResponse<IntegrationMapOutput>, McpError>> => {
  const filter = input.filter ?? 'all';
  const limit = input.limit ?? INTEGRATION_MAP_DEFAULT_LIMIT;
  // The eight integration ComponentTypes share the cap fairly; the
  // ceiling division keeps the per-category limit at `>= 1` even when
  // the caller supplies the smallest allowed `limit` (1).
  const perCategoryLimit = Math.max(1, Math.ceil(limit / INTEGRATION_TYPES.length));

  const inScopeTypes: ReadonlySet<ComponentType> = new Set(
    FILTER_TYPE_MAP[filter] ?? INTEGRATION_TYPES,
  );

  // Stage 1: per-category enumeration. Categories the caller scoped
  // out via `filter` are populated as empty arrays so the output
  // shape stays stable.
  const buckets = new Map<ComponentType, IntegrationMapNode[]>();
  for (const type of INTEGRATION_TYPES) {
    buckets.set(type, []);
  }
  for (const type of INTEGRATION_TYPES) {
    if (!inScopeTypes.has(type)) continue;
    const result = await listNodesByType(ctx.graph, type, {
      limit: perCategoryLimit,
    });
    if (!result.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${result.error.message}`,
      });
    }
    buckets.set(
      type,
      result.value.map(toMapNode).sort(compareNodes),
    );
  }

  // Stage 1b: orphan analysis for the two trust anchors (NamedCredential
  // and AuthProvider). For each, count the INBOUND `references` edges
  // (anything in the retrieved metadata wired to this credential/provider
  // — an ExternalService binding it, an ExternalDataSource naming it, an
  // OmniStudio IP declaring a `callout:` alias, or a captured Apex
  // `callout:` reference). A `0` is the grounded basis for `orphaned:
  // true` — the determinate answer to "is this credential actually
  // authorizing anything", rather than abstaining when it is present.
  for (const trustType of ['NamedCredential', 'AuthProvider'] as const) {
    const nodes = buckets.get(trustType);
    if (nodes === undefined || nodes.length === 0) continue;
    const annotated: IntegrationMapNode[] = [];
    for (const node of nodes) {
      const inboundResult = await listEdges(ctx.graph, node.id, {
        direction: 'in',
        edgeType: REFERENCES_EDGE_TYPE,
      });
      if (!inboundResult.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${inboundResult.error.message}`,
        });
      }
      const referenceCount = inboundResult.value.length;
      annotated.push({
        ...node,
        referenceCount,
        orphaned: referenceCount === 0,
      });
    }
    buckets.set(trustType, annotated);
  }

  // Stage 2: cross-type reference edge collection. For each in-scope
  // integration node, list outgoing `references` edges and include
  // only those whose `toId` is also an integration node. The de-dup
  // key (`fromId|toId|edgeType|role`) keeps the result stable when
  // multiple producers emit the same logical edge.
  const allNodes: IntegrationMapNode[] = [];
  for (const type of INTEGRATION_TYPES) {
    const nodes = buckets.get(type);
    if (nodes !== undefined) allNodes.push(...nodes);
  }
  const edgeMap = new Map<string, IntegrationMapEdge>();
  for (const node of allNodes) {
    const edgesResult = await listEdges(ctx.graph, node.id, {
      direction: 'out',
      edgeType: REFERENCES_EDGE_TYPE,
    });
    if (!edgesResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${edgesResult.error.message}`,
      });
    }
    for (const edge of edgesResult.value) {
      // The `toId`'s ComponentType is encoded in the canonical id form
      // `{ComponentType}:{ScopedApiName}`; splitting on the first ':'
      // is the contract-stable way to recover it without a separate
      // graph lookup. See `packages/contracts/src/index.ts` for the
      // `ComponentId` format.
      const colon = edge.toId.indexOf(':');
      if (colon === -1) continue;
      const targetType = edge.toId.slice(0, colon) as ComponentType;
      if (!INTEGRATION_TYPE_SET.has(targetType)) continue;
      const role = resolveRole(edge.properties);
      const mapEdge: IntegrationMapEdge =
        role === undefined
          ? {
              fromId: edge.fromId,
              toId: edge.toId,
              edgeType: edge.edgeType,
            }
          : {
              fromId: edge.fromId,
              toId: edge.toId,
              edgeType: edge.edgeType,
              role,
            };
      edgeMap.set(`${edge.fromId}\0${edge.toId}\0${edge.edgeType}\0${role ?? ''}`, mapEdge);
    }
  }
  const references = [...edgeMap.values()].sort(compareEdges);

  // Stage 2b: OmniStudio outbound callout surface. Collected only when
  // the filter has it in scope; otherwise an empty surface keeps the
  // response shape stable so MCP clients can read `omniStudio.*`
  // unconditionally.
  let omniStudio = EMPTY_OMNI_SURFACE;
  if (OMNI_SURFACE_FILTERS.has(filter)) {
    const omniResult = await collectOmniSurface(ctx, perCategoryLimit);
    if (!omniResult.ok) return omniResult;
    omniStudio = omniResult.value;
  }

  // Stage 3: assemble the response. Bucket lookups are guarded with
  // `?? []` so a future addition to `INTEGRATION_TYPES` without a
  // matching bucket initialization surfaces as an empty array rather
  // than a runtime error.
  const data: IntegrationMapOutput = {
    authProviders: buckets.get('AuthProvider') ?? [],
    namedCredentials: buckets.get('NamedCredential') ?? [],
    remoteSiteSettings: buckets.get('RemoteSiteSetting') ?? [],
    cspTrustedSites: buckets.get('CspTrustedSite') ?? [],
    externalDataSources: buckets.get('ExternalDataSource') ?? [],
    externalServices: buckets.get('ExternalService') ?? [],
    connectedApps: buckets.get('ConnectedApp') ?? [],
    networkAccesses: buckets.get('NetworkAccess') ?? [],
    references,
    omniStudio,
    apexCalloutDisclosure: APEX_CALLOUT_DISCLOSURE,
    calloutAuthorizationNote: buildCalloutAuthorizationNote(
      buckets.get('RemoteSiteSetting') ?? [],
      buckets.get('NamedCredential') ?? [],
    ),
  };
  const totalNodes =
    data.authProviders.length +
    data.namedCredentials.length +
    data.remoteSiteSettings.length +
    data.cspTrustedSites.length +
    data.externalDataSources.length +
    data.externalServices.length +
    data.connectedApps.length +
    data.networkAccesses.length;
  // The OmniStudio callout surface counts toward "this org has an
  // integration surface": an OmniStudio org with 0 classic
  // ComponentTypes but IPs that call out must NOT report "No integration
  // metadata found". The honest-empty note fires only when BOTH the
  // classic buckets AND the OmniStudio surface are empty.
  const omniSurfaceCount =
    omniStudio.restCallouts.length + omniStudio.remoteCallouts.length;

  return ok({
    data:
      totalNodes === 0 && omniSurfaceCount === 0
        ? { ...data, note: INTEGRATION_EMPTY_NOTE }
        : data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
