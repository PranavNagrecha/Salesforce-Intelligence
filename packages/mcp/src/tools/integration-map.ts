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
 * It ALSO surfaces `martechConnectors` (Finding #44): a friendly-name
 * decoration over data this tool and `installed_package_catalog` already
 * see — an `InstalledPackage` node whose namespace matches a known martech
 * vendor (Marketing Cloud Connect / Pardot / Marketo), or a NamedCredential
 * / ExternalDataSource whose declared endpoint host matches a known martech
 * domain (adds HubSpot, which has no reliable namespace signal). This adds
 * NO new extraction — see `packages/mcp/src/known-integration-packages.ts`
 * for the lookup table and its disclosed heuristic-confidence boundary.
 *
 * The architect's question this tool answers: "what external systems
 * does my org talk to, what trust mechanism do they use, and which
 * pieces are wired together?". One call returns the full map.
 *
 * The cascade, in this exact order:
 *
 *   1. **Per-category enumeration** — for each integration ComponentType
 *      in scope (controlled by `filter`), walk the type to exhaustion
 *      via `scanAllNodesOfTypes` (windows the SQL `OFFSET` past the
 *      500-row per-page cap). Every category is scanned in FULL.
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
 *   4. **Payload trim** — LAST, and only after every derived field
 *      above has read the COMPLETE sets, each bucket is trimmed to
 *      `limit` rows and `truncatedCategories` names what was dropped
 *      plus the true total.
 *
 * Implementation notes:
 *   - `limit` caps the RETURNED rows per category; it does NOT bound
 *     the scan. It used to be split eight ways (`ceil(limit / 8)` = 13
 *     by default), which handed `collectMartechConnectors` and
 *     `buildCalloutAuthorizationNote` an alphabetical 13-row prefix and
 *     let them assert a complete authorization surface off it.
 *     Categories the caller scoped out via `filter` surface as empty
 *     arrays — the shape is stable so MCP clients can access every
 *     field without conditional checks.
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
import { listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import {
  lookupKnownMartechEndpoint,
  lookupKnownMartechNamespace,
  MARTECH_CONNECTOR_DISCLOSURE,
  type MartechCategory,
} from '../known-integration-packages.js';
import type { Context } from '../server.js';

import { firstNonEmpty } from './input-aliases.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

/**
 * Inclusive upper bound on `limit`. Mirrors the
 * `FIND_APEX_USAGES_MAX_LIMIT` and `FORMULA_REFS_MAX_LIMIT` ceilings so
 * every enumeration-style MCP tool shares the same blast-radius cap.
 */
const INTEGRATION_MAP_MAX_LIMIT = 500;

/**
 * Default `limit` when the caller omits it. Caps the RETURNED rows PER
 * CATEGORY (it is no longer split across the eight categories — every category
 * is scanned in FULL and `truncatedCategories` discloses any payload trim).
 */
const INTEGRATION_MAP_DEFAULT_LIMIT = 100;

/**
 * The eight integration ComponentTypes the tool enumerates. Ordered
 * from "trust anchor" (AuthProvider) to "callable surface" (External-
 * Service) so the output reads top-down. The order matters for the
 * `filter` mapping and the bucket ordering.
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
  // INTEGRATION-MAP-IGNORES-OBJECT-SCOPE: object / component scope keys a host
  // reaches for on "integrations that touch {object}". Accepted here ONLY so the
  // handler can REFUSE with the org-wide-only pointer instead of silently
  // returning the whole-org catalog (which was byte-identical for Contact vs
  // Opportunity vs bare). NEVER a valid scope — the integration surface is
  // org-wide and is not indexed by the SObject it ultimately touches.
  objectApiName: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
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

/**
 * One detected martech (marketing-technology) connector (Finding #44) — a
 * friendly-name decoration over a component this map (or
 * `installed_package_catalog`) already surfaces, not a new extraction. See
 * `packages/mcp/src/known-integration-packages.ts` for the lookup table and
 * its disclosed confidence boundary.
 */
export interface MartechConnectorMatch {
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly productName: string;
  readonly vendor: string;
  readonly category: MartechCategory;
  /**
   * `'installed-package'`: matched an `InstalledPackage` node's namespace
   * (declared confidence). `'named-credential-endpoint'` /
   * `'external-data-source-endpoint'` / `'remote-site-setting-endpoint'`:
   * matched a NamedCredential / ExternalDataSource / (Active)
   * RemoteSiteSetting node's declared endpoint host against a known martech
   * domain (heuristic confidence — see {@link confidence}).
   */
  readonly source:
    | 'installed-package'
    | 'named-credential-endpoint'
    | 'external-data-source-endpoint'
    | 'remote-site-setting-endpoint';
  /** What actually matched (`namespace:et4ae5` / `endpoint:https://…`), for audit. */
  readonly matchedOn: string;
  readonly confidence: 'declared' | 'heuristic';
  /** One-line basis for the match, echoed from the lookup table. */
  readonly basis: string;
}

/**
 * One category whose bucket was trimmed to `limit` for the payload. `total` is
 * the TRUE count from the full scan, so a caller can tell "13 of 41" from "13".
 */
export interface IntegrationMapTruncatedCategory {
  readonly type: ComponentType;
  /** Rows actually returned in this response. */
  readonly returned: number;
  /** Rows the full scan found for this type. */
  readonly total: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface IntegrationMapOutput {
  /**
   * Echoes the scope ACTUALLY applied so a host never assumes an object /
   * component key it passed was honored — this map is ORG-WIDE, so `object` is
   * always `null` and `mode` is always `'all'`. A call that DID pass an object /
   * component scope is rejected upstream with `invalid-query`
   * (INTEGRATION-MAP-IGNORES-OBJECT-SCOPE), never silently answered org-wide.
   */
  readonly appliedScope: {
    readonly object: string | null;
    readonly mode: 'all';
  };
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
   * Martech (marketing-technology) connectors detected via the known-
   * namespace / known-endpoint lookup (Finding #44) — Marketing Cloud
   * Connect, Pardot/Account Engagement, Marketo, HubSpot. Empty when no
   * `InstalledPackage` / NamedCredential / ExternalDataSource node matches a
   * known martech signal — that is "none detected", not "none exist"; see
   * {@link martechConnectorDisclosure}. Populated from `InstalledPackage`
   * nodes (filter-independent — always scanned) plus whichever
   * NamedCredential / ExternalDataSource nodes the current `filter` already
   * put in scope (no extra query beyond what the map already fetched).
   */
  readonly martechConnectors: readonly MartechConnectorMatch[];
  /** Always present: the heuristic-confidence boundary for {@link martechConnectors}. */
  readonly martechConnectorDisclosure: string;
  /**
   * Present ONLY when every bucket is empty AND the OmniStudio surface
   * is empty AND no martech connector was detected. Distinguishes "this
   * org has no integration metadata (or it wasn't retrieved)" from a
   * broken tool — an all-empty map otherwise reads as a failure to a
   * newcomer.
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
  /**
   * Categories whose bucket was trimmed to `limit` for the payload, with the
   * TRUE total from the full scan. EMPTY when nothing was trimmed — the normal
   * case. Every category is always SCANNED in full, so `martechConnectors`,
   * `calloutAuthorizationNote` and `references` are computed over the complete
   * sets even when a bucket here is short.
   */
  readonly truncatedCategories: readonly IntegrationMapTruncatedCategory[];
  /**
   * Scope disclosures for this response: the payload trim (when
   * `truncatedCategories` is non-empty) and the residual full-scan cap. Empty
   * in the normal case — this map is complete.
   */
  readonly boundaries: readonly string[];
}

/** Honest-empty note attached when the integration map has zero components. */
const INTEGRATION_EMPTY_NOTE =
  'No integration metadata found in this vault. Either this org declares no AuthProviders / NamedCredentials / RemoteSiteSettings / ExternalDataSources / etc., or those types were not included in the retrieve. This is an empty result, not an error. NOTE: this map does not enumerate Apex HTTP callouts (see apexCalloutDisclosure) — an org whose integration is entirely Apex-based can still be active here.';

/** Always-present boundary: Apex HTTP callouts are out of scope for this map. */
const APEX_CALLOUT_DISCLOSURE =
  "This map covers DECLARED integration metadata (AuthProvider / NamedCredential / RemoteSiteSetting / CspTrustedSite / ExternalDataSource / ExternalService / ConnectedApp / NetworkAccess) plus OmniStudio callouts. The individual Apex callsites (`Http.request` / `HttpRequest.setEndpoint`) are not listed as rows here — enumerate them with `sfi.find_code_usages` on `Http`/`HttpRequest` or `sfi.search_apex_source('setEndpoint')`. The TRUST mechanism that AUTHORIZES those callouts IS in this map, however: see `calloutAuthorizationNote` and the RemoteSiteSetting / NamedCredential sections.";

/** Max names enumerated inline in `calloutAuthorizationNote` before the tail is summarised. */
const MAX_ENUMERATED_NAMES = 20;

/**
 * Render a name list for the authorization note: the first
 * {@link MAX_ENUMERATED_NAMES} verbatim, then `… and N more` derived from the
 * TRUE length. Never presents a slice as the whole list.
 */
const enumerateNames = (names: readonly string[]): string =>
  names.length <= MAX_ENUMERATED_NAMES
    ? names.join(', ')
    : `${names.slice(0, MAX_ENUMERATED_NAMES).join(', ')} … and ${names.length - MAX_ENUMERATED_NAMES} more`;

/**
 * Build the grounded `calloutAuthorizationNote` from the components
 * actually present in the map. This is the determinate answer to "which
 * named credential or remote site setting authorizes the outbound
 * callouts" — derived from the retrieved RemoteSiteSetting nodes and the
 * NamedCredential reference/orphan analysis, NOT abstained.
 *
 * Takes the COMPLETE per-type sets, never the payload-trimmed buckets: the note
 * makes positive absence claims ("this map contains no NamedCredentials"), which
 * a truncated bucket turns into a lie.
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
      ? `Active RemoteSiteSettings authorize outbound HTTP callouts to a hardcoded endpoint URL (an Apex \`Http.request\` to a literal host) — ${rssNames.length} in this org: ${enumerateNames(rssNames)}.`
      : 'This map contains no RemoteSiteSettings, so no hardcoded-URL outbound callout is authorized by a remote site setting.';

  const ncPart =
    namedCredentials.length === 0
      ? 'This map contains no NamedCredentials, so no callout addresses a `callout:{alias}` endpoint.'
      : `NamedCredentials authorize callouts that address \`callout:{alias}\` — ${namedCredentials.length} in this org. Referenced (something in the retrieved metadata is wired to them): ${
          referencedNcs.length > 0 ? enumerateNames(referencedNcs) : 'none'
        }. Orphaned (no modeled reference — present but nothing wires to them): ${
          orphanedNcs.length > 0 ? enumerateNames(orphanedNcs) : 'none'
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
 * Scans every OmniIntegrationProcedure (windows past the 500-row per-page cap);
 * it used to take the same `ceil(limit / 8)` = 13 slice the classic categories
 * shared, so an org with more than 13 IPs reported an alphabetical prefix of its
 * callout surface. Residual incompleteness is returned to the caller.
 *
 * Real-vault note: these are EXTRACTION-time properties; an org
 * refreshed before the omni-integration-procedure extractor change
 * surfaces an empty OmniStudio section until a re-refresh.
 */
const collectOmniSurface = async (
  ctx: Context,
): Promise<
  Result<
    {
      readonly surface: OmniStudioIntegrationSurface;
      readonly incompleteTypes: readonly string[];
    },
    McpError
  >
> => {
  const nodesResult = await scanAllNodesOfTypes(ctx.graph, [
    'OmniIntegrationProcedure',
  ]);
  if (!nodesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodesResult.error.message}`,
    });
  }
  const restCallouts: OmniRestCallout[] = [];
  const remoteCallouts: OmniRemoteCallout[] = [];
  for (const node of nodesResult.value.nodes) {
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
  return ok({
    surface: { restCallouts, remoteCallouts, referencedNamedCredentials },
    incompleteTypes: nodesResult.value.incompleteTypes,
  });
};

/**
 * Read a node's declared endpoint URL, trying the extractor-canonical
 * `endpoint` property first (NamedCredential / ExternalDataSource both use
 * this key — see `named-credential.ts` / `external-data-source.ts`), falling
 * back to `url` for a looser fixture/vault shape. Returns `null` when neither
 * is a non-empty string.
 */
const readDeclaredEndpoint = (
  properties: Readonly<Record<string, unknown>>,
): string | null => {
  const endpoint = properties['endpoint'];
  if (typeof endpoint === 'string' && endpoint.length > 0) return endpoint;
  const url = properties['url'];
  if (typeof url === 'string' && url.length > 0) return url;
  return null;
};

/**
 * Detect martech (marketing-technology) connectors (Finding #44) from data
 * this map already has, plus one additional filter-independent scan of
 * `InstalledPackage` nodes (scanned in full). NamedCredential /
 * ExternalDataSource endpoint matching reuses whichever of those buckets the
 * caller's `filter` already put in scope — no extra graph query for that half.
 * Those buckets are the COMPLETE per-type sets, not the payload-trimmed ones:
 * a connector that sorts past `limit` is still detected.
 *
 * Two independent signal sources, never conflated:
 *   - `InstalledPackage.namespace` against {@link lookupKnownMartechNamespace}
 *     — `declared` confidence (the org's own retrieved package metadata).
 *   - NamedCredential / ExternalDataSource / (Active) RemoteSiteSetting
 *     declared endpoint host against {@link lookupKnownMartechEndpoint} —
 *     `heuristic` confidence (a hostname regex, not declared package
 *     metadata). RemoteSiteSetting is the pre-NamedCredential callout pattern
 *     (still common for Marketo SOAP/REST): the host is present in the same
 *     map payload, so an org whose only martech signal is a `*.mktoapi.com`
 *     RemoteSite now lights up a connector row instead of being invisible.
 *     Only ACTIVE remote sites are classified — a deactivated site authorizes
 *     nothing.
 */
const collectMartechConnectors = async (
  ctx: Context,
  namedCredentials: readonly IntegrationMapNode[],
  externalDataSources: readonly IntegrationMapNode[],
  remoteSiteSettings: readonly IntegrationMapNode[],
): Promise<
  Result<
    {
      readonly matches: readonly MartechConnectorMatch[];
      readonly incompleteTypes: readonly string[];
    },
    McpError
  >
> => {
  const matches: MartechConnectorMatch[] = [];

  // Only Active remote sites authorize a callout; an inactive one is dead
  // metadata and must not mint a connector row.
  const activeRemoteSites = remoteSiteSettings.filter(
    (node) => node.properties['isActive'] === true,
  );

  const pkgResult = await scanAllNodesOfTypes(ctx.graph, ['InstalledPackage']);
  if (!pkgResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${pkgResult.error.message}`,
    });
  }
  for (const node of pkgResult.value.nodes) {
    const rawNamespace = node.properties['namespace'];
    const namespace =
      typeof rawNamespace === 'string' && rawNamespace.length > 0
        ? rawNamespace
        : node.apiName;
    const known = lookupKnownMartechNamespace(namespace);
    if (known === null) continue;
    matches.push({
      componentId: node.id,
      componentType: 'InstalledPackage',
      productName: known.productName,
      vendor: known.vendor,
      category: known.category,
      source: 'installed-package',
      matchedOn: `namespace:${namespace}`,
      confidence: 'declared',
      basis: known.basis,
    });
  }

  const endpointBuckets: ReadonlyArray<
    readonly [readonly IntegrationMapNode[], MartechConnectorMatch['source']]
  > = [
    [namedCredentials, 'named-credential-endpoint'],
    [externalDataSources, 'external-data-source-endpoint'],
    [activeRemoteSites, 'remote-site-setting-endpoint'],
  ];
  for (const [nodes, source] of endpointBuckets) {
    for (const node of nodes) {
      const rawEndpoint = readDeclaredEndpoint(node.properties);
      if (rawEndpoint === null) continue;
      const known = lookupKnownMartechEndpoint(rawEndpoint);
      if (known === null) continue;
      matches.push({
        componentId: node.id,
        componentType: node.type,
        productName: known.productName,
        vendor: known.vendor,
        category: known.category,
        source,
        matchedOn: `endpoint:${rawEndpoint}`,
        confidence: 'heuristic',
        basis: known.basis,
      });
    }
  }

  matches.sort((a, b) => {
    if (a.componentId !== b.componentId) return a.componentId < b.componentId ? -1 : 1;
    return a.productName < b.productName ? -1 : a.productName > b.productName ? 1 : 0;
  });
  return ok({ matches, incompleteTypes: pkgResult.value.incompleteTypes });
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
  // INTEGRATION-MAP-IGNORES-OBJECT-SCOPE: refuse an object / component scope
  // rather than silently returning the whole-org catalog (byte-identical for
  // Contact vs Opportunity vs bare). The declared integration surface is not
  // indexed by the SObject it touches, so there is no honest object-scoped answer
  // to give — point the caller at the tools that ARE object-scoped.
  const scopeKey = firstNonEmpty(
    input.objectApiName,
    input.object,
    input.objectId,
    input.componentId,
  );
  if (scopeKey !== undefined) {
    return err({
      kind: 'invalid-query',
      message:
        `integration_map returns the ORG-WIDE integration topology; it cannot scope to a single object or component (\`${scopeKey}\`). ` +
        'The declared integration surface (AuthProvider / NamedCredential / RemoteSiteSetting / ExternalDataSource / …) is not indexed by the SObject it ultimately touches. ' +
        'To find callouts / connectors tied to a specific object, use `find_code_usages` on that object, or `endpoint_catalog` for the URL surface. Call integration_map with only `filter` / `limit` for the whole-org map.',
      path: 'objectApiName',
    });
  }

  const filter = input.filter ?? 'all';
  const limit = input.limit ?? INTEGRATION_MAP_DEFAULT_LIMIT;

  const inScopeTypes: ReadonlySet<ComponentType> = new Set(
    FILTER_TYPE_MAP[filter] ?? INTEGRATION_TYPES,
  );

  // Stage 1: per-category enumeration, in FULL. `limit` no longer splits a
  // budget eight ways — it caps the RETURNED rows per category at Stage 4,
  // AFTER the derived fields below have read the complete sets. Categories the
  // caller scoped out via `filter` are populated as empty arrays so the output
  // shape stays stable.
  const buckets = new Map<ComponentType, IntegrationMapNode[]>();
  for (const type of INTEGRATION_TYPES) {
    buckets.set(type, []);
  }
  const scannedTypes = INTEGRATION_TYPES.filter((type) => inScopeTypes.has(type));
  const scan = await scanAllNodesOfTypes(ctx.graph, scannedTypes);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }
  for (const node of scan.value.nodes) {
    buckets.get(node.type)?.push(toMapNode(node));
  }
  for (const type of scannedTypes) {
    buckets.get(type)?.sort(compareNodes);
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
  const incompleteTypes: string[] = [...scan.value.incompleteTypes];
  if (OMNI_SURFACE_FILTERS.has(filter)) {
    const omniResult = await collectOmniSurface(ctx);
    if (!omniResult.ok) return omniResult;
    omniStudio = omniResult.value.surface;
    incompleteTypes.push(...omniResult.value.incompleteTypes);
  }

  // Stage 2c: martech connector detection (Finding #44). Filter-independent
  // for the InstalledPackage half (always scanned — small, bounded); reuses
  // whichever NamedCredential / ExternalDataSource / RemoteSiteSetting buckets
  // `filter` already populated for the endpoint half (no extra query). The
  // RemoteSiteSetting host is the pre-NamedCredential callout pattern
  // (INTEGRATION-MAP-MARTECH-IGNORES-REMOTE-SITE-HOSTS): Active Marketo SOAP/REST
  // sites now light up a connector instead of hiding in `remoteSiteSettings`.
  const martechResult = await collectMartechConnectors(
    ctx,
    buckets.get('NamedCredential') ?? [],
    buckets.get('ExternalDataSource') ?? [],
    buckets.get('RemoteSiteSetting') ?? [],
  );
  if (!martechResult.ok) return martechResult;
  const martechConnectors = martechResult.value.matches;
  incompleteTypes.push(...martechResult.value.incompleteTypes);

  // Stage 3: payload trim — LAST, so every derived field above (martech,
  // callout authorization, the `references` cascade, the OmniStudio surface)
  // was computed over the COMPLETE sets. `truncatedCategories` carries the true
  // total per trimmed category so `13` is never mistakable for `13 of 41`.
  const truncatedCategories: IntegrationMapTruncatedCategory[] = [];
  const paged = new Map<ComponentType, IntegrationMapNode[]>();
  for (const type of INTEGRATION_TYPES) {
    const full = buckets.get(type) ?? [];
    if (full.length > limit) {
      truncatedCategories.push({ type, returned: limit, total: full.length });
      paged.set(type, full.slice(0, limit));
    } else {
      paged.set(type, full);
    }
  }

  const boundaries: string[] = [];
  if (truncatedCategories.length > 0) {
    boundaries.push(
      `Returned rows capped at limit=${limit} per category: ${truncatedCategories
        .map((t) => `${t.type} ${t.returned} of ${t.total}`)
        .join(', ')}. Every category was SCANNED in full — martechConnectors, calloutAuthorizationNote and references are computed over the complete sets. Raise \`limit\` (max ${INTEGRATION_MAP_MAX_LIMIT}) or narrow with \`filter\` to see the rest.`,
    );
  }
  if (incompleteTypes.length > 0) {
    boundaries.push(fullScanTruncationNote(incompleteTypes));
  }

  // Stage 4: assemble the response. Bucket lookups are guarded with
  // `?? []` so a future addition to `INTEGRATION_TYPES` without a
  // matching bucket initialization surfaces as an empty array rather
  // than a runtime error.
  const data: IntegrationMapOutput = {
    appliedScope: { object: null, mode: 'all' },
    authProviders: paged.get('AuthProvider') ?? [],
    namedCredentials: paged.get('NamedCredential') ?? [],
    remoteSiteSettings: paged.get('RemoteSiteSetting') ?? [],
    cspTrustedSites: paged.get('CspTrustedSite') ?? [],
    externalDataSources: paged.get('ExternalDataSource') ?? [],
    externalServices: paged.get('ExternalService') ?? [],
    connectedApps: paged.get('ConnectedApp') ?? [],
    networkAccesses: paged.get('NetworkAccess') ?? [],
    references,
    omniStudio,
    martechConnectors,
    martechConnectorDisclosure: MARTECH_CONNECTOR_DISCLOSURE,
    apexCalloutDisclosure: APEX_CALLOUT_DISCLOSURE,
    calloutAuthorizationNote: buildCalloutAuthorizationNote(
      buckets.get('RemoteSiteSetting') ?? [],
      buckets.get('NamedCredential') ?? [],
    ),
    truncatedCategories,
    boundaries,
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
  // The OmniStudio callout surface AND a detected martech connector both
  // count toward "this org has an integration surface": an org with 0
  // classic ComponentTypes but IPs that call out, or an InstalledPackage
  // that matches a known martech namespace, must NOT report "No integration
  // metadata found". The honest-empty note fires only when the classic
  // buckets, the OmniStudio surface, AND the martech detections are ALL
  // empty.
  const omniSurfaceCount =
    omniStudio.restCallouts.length + omniStudio.remoteCallouts.length;

  return ok({
    data:
      totalNodes === 0 && omniSurfaceCount === 0 && martechConnectors.length === 0
        ? { ...data, note: INTEGRATION_EMPTY_NOTE }
        : data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
