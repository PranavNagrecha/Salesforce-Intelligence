/**
 * Handler for the `sfi.endpoint_catalog` MCP tool.
 *
 * The v2.8 async-deep-tier composite over every endpoint surface an
 * org touches. Sibling of `sfi.integration_map` (which surfaces the
 * NODES + their wiring) and `sfi.outbound_message_catalog` (which
 * surfaces ONE category in depth); this tool surfaces the URL /
 * endpoint axis ALONE for every category in a single response.
 *
 * The architect's question this tool answers: "show me every URL
 * that participates in an integration, whether inbound or outbound."
 *
 * Composes five categories:
 *
 *   1. **Inbound APIs** — `exposes` edges from ApexClass to
 *      synthetic `ExternalApi:{kind}/{path}` targets (v1.5 R3). The
 *      `path` is the URL fragment the org listens to (e.g.,
 *      `/Account/*` for `@RestResource(urlMapping='/Account/*')`).
 *
 *   2. **Outbound messages** — OutboundMessage node properties
 *      (v2.8). The `endpointUrl` is the destination the SOAP
 *      message is sent to.
 *
 *   3. **ExternalDataSource endpoints** — `endpoint` property on
 *      ExternalDataSource nodes (v1.5 R2). The OData / cross-org
 *      data binding's URL.
 *
 *   4. **NamedCredential endpoints** — `url` property on
 *      NamedCredential nodes (v0.2). The outbound HTTP callout's
 *      destination.
 *
 *   5. **OmniStudio REST callouts** — `restEndpoints` property on
 *      OmniIntegrationProcedure nodes (the omni-integration-procedure
 *      extractor). One outbound `omni-rest` entry per Integration
 *      Procedure `Rest Action` step; the `url` is the verbatim
 *      `restPath` and `namedCredential` the declared host alias. The
 *      distinct referenced aliases are rolled up into
 *      `referencedNamedCredentials`.
 *
 *   6. **RemoteSiteSetting allowlist** — `url` property on
 *      RemoteSiteSetting nodes. The canonical Salesforce declaration
 *      of an outbound-callout allowlist entry: the external host an
 *      Apex `Http.request` to a HARDCODED URL is permitted to reach.
 *      `url` is a REQUIRED element in the extractor, so every node
 *      carries one. Each entry also carries `isActive`.
 *
 *   7. **CspTrustedSite allowlist** — `endpointUrl` property on
 *      CspTrustedSite nodes. The browser-side external-host allowlist
 *      an Experience/Lightning page is permitted to load from.
 *      `endpointUrl` is likewise a REQUIRED element.
 *
 * Categories 6 and 7 are AUTHORIZATIONS, not proven callsites — the
 * host is reachable, not necessarily reached. That distinction is
 * stated verbatim in `disclosure` and the entries carry their own
 * `endpointKind` so `summary.byKind` keeps them separable from a
 * NamedCredential or an OutboundMessage destination. They were absent
 * for eight versions: a real org returned `totalEndpoints: 34` with
 * `boundaries: []` while 35 allowlist URLs sat in the same vault and
 * were surfaced, on the same call, by `sfi.integration_map`.
 *
 * Implementation notes:
 *   - Every category is scanned to EXHAUSTION (`scanAllNodesOfTypes`
 *     windows the SQL `OFFSET` past the graph layer's 500-row per-page
 *     cap), so "every URL" is literal and `summary.totalEndpoints` is a
 *     true total. Each collector used to take ONE 500-row page, so a
 *     `@RestResource` sorting past position 500 by id was silently
 *     absent with nothing in the payload to distinguish it from an
 *     endpoint that does not exist. `boundaries` discloses the residual
 *     `FULL_SCAN_MAX_NODES` ceiling when it bites, and ALWAYS carries the
 *     scope boundary pointing at `notCovered[]`.
 *   - `summary.totalEndpoints` is a true total OF THE DECLARED, URL-BEARING
 *     METADATA FAMILIES ABOVE — never of "every URL in the org". It is not a
 *     certificate. The URL surfaces this catalog does NOT enumerate are named
 *     in the TYPED `notCovered[]` field (Apex literals passed to
 *     `HttpRequest.setEndpoint`, URLs in LWC/Aura/Visualforce markup,
 *     ConnectedApp callback URLs, WebLink targets, URLs stored as Custom
 *     Setting / Custom Metadata data). An EMPTY `boundaries[]` used to be the
 *     signal that nothing was omitted, which inverted the signal precisely
 *     when the answer was most incomplete.
 *   - Each category surfaces a `direction` field (inbound | outbound)
 *     so the renderer can render two sections.
 *   - The catalog is intentionally URL-centric — no edges, no
 *     subscriber lists. Use `sfi.integration_map` for the wired
 *     topology and `sfi.outbound_message_catalog` for per-message
 *     invokers.
 *   - Intentionally ORG-WIDE: an object / component argument is REFUSED
 *     (ENDPOINT-CATALOG-IGNORES-OBJECT-SCOPE) — no endpoint→object edge.
 *   - Honesty axis (verbatim in `disclosure`): URLs are captured
 *     verbatim — v2.8 does NOT probe or validate any of them.
 *     Runtime callouts whose destination is computed dynamically
 *     (e.g., a NamedCredential resolved via custom metadata) are
 *     captured at the NamedCredential level but the runtime URL
 *     the system actually hits may be different from the stored
 *     `url` field.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listEdgesForNodes } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { firstNonEmpty } from './input-aliases.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, fullScanTruncationNote } from './scan-cap.js';

/**
 * What one category collector returns: its entries plus the types whose full
 * scan stopped at the residual `FULL_SCAN_MAX_NODES` cap (empty in the normal
 * case — every category is now walked to exhaustion).
 */
interface CollectedCategory {
  readonly entries: readonly EndpointEntry[];
  readonly incompleteTypes: readonly string[];
}

/**
 * Zod schema for the `sfi.endpoint_catalog` tool input. Intentionally ORG-WIDE;
 * the object / component keys exist ONLY so the handler can REFUSE them
 * (ENDPOINT-CATALOG-IGNORES-OBJECT-SCOPE) — see the handler.
 */
export const endpointCatalogInputSchema = z.object({
  objectApiName: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `endpointCatalogInputSchema`. */
export type EndpointCatalogInput = z.infer<typeof endpointCatalogInputSchema>;

/**
 * Endpoint direction. `inbound` means the org listens at this URL;
 * `outbound` means the org sends to this URL.
 */
export type EndpointDirection = 'inbound' | 'outbound';

/**
 * Endpoint kind discriminator. Matches the composing categories:
 * `rest`/`aura`/`invocable` (inbound APIs), `outbound-message`,
 * `external-data-source`, `named-credential`, `omni-rest`
 * (OmniStudio Integration Procedure Rest Action callouts), and the two
 * ALLOWLIST kinds `remote-site` / `csp-trusted-site` (a host the org is
 * AUTHORIZED to reach — not evidence that anything reaches it).
 */
export type EndpointKind =
  | 'rest'
  | 'aura'
  | 'invocable'
  | 'outbound-message'
  | 'external-data-source'
  | 'named-credential'
  | 'omni-rest'
  | 'remote-site'
  | 'csp-trusted-site';

/**
 * One endpoint entry.
 *
 * `namedCredential` is populated only for `omni-rest` entries that
 * declare one (the host alias from the Rest Action's `propertySetConfig`,
 * e.g. `callout:My_NC`); it is `null`/absent for every other kind, whose
 * trust binding is the node itself.
 */
export interface EndpointEntry {
  readonly endpointKind: EndpointKind;
  readonly direction: EndpointDirection;
  readonly sourceComponentId: ComponentId;
  readonly url: string | null;
  readonly namedCredential?: string | null;
  /**
   * For `named-credential` entries only: the count of inbound
   * `references` edges that point at this NamedCredential node (an
   * ExternalService binding it, an OmniStudio IP declaring its
   * `callout:` alias, a captured Apex `callout:` reference, etc.).
   * Absent for every other kind. A `0` is the grounded basis for
   * {@link orphaned}.
   */
  readonly referenceCount?: number;
  /**
   * For `named-credential` entries only: `true` when
   * {@link referenceCount} is `0` — the credential exists in the org but
   * nothing in the retrieved metadata is wired to it. Surfaced so the
   * catalog reports an orphaned credential as orphaned instead of
   * implying it authorizes a callout. Honest-boundary: this counts
   * MODELED references; an `orphaned: true` means "no reference the
   * retrieve captured", not a guarantee of zero runtime use.
   */
  readonly orphaned?: boolean;
  /**
   * For the allowlist kinds (`remote-site` / `csp-trusted-site`) only: the
   * node's declared `isActive`. An INACTIVE allowlist entry is still LISTED —
   * silently dropping it would repeat the omission this field exists to
   * disclose — but a reviewer needs to tell a live authorization from a
   * dormant one. Absent for every other kind.
   */
  readonly isActive?: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface EndpointCatalogOutput {
  readonly inboundApis: readonly EndpointEntry[];
  readonly outboundMessages: readonly EndpointEntry[];
  readonly externalDataSources: readonly EndpointEntry[];
  readonly namedCredentials: readonly EndpointEntry[];
  /**
   * Outbound REST callouts surfaced from OmniStudio Integration
   * Procedure `Rest Action` steps (the IP node's `restEndpoints`
   * property, populated by the omni-integration-procedure extractor).
   * Each entry's `url` is the verbatim `restPath` and `namedCredential`
   * the declared host alias (or `null`).
   */
  readonly omniRestEndpoints: readonly EndpointEntry[];
  /**
   * The distinct, sorted set of NamedCredential host aliases referenced
   * by `omniRestEndpoints` entries (verbatim, e.g. `callout:My_NC`).
   * Surfaces the trust bindings the OmniStudio callout surface depends
   * on so an architect can cross-check them against the
   * NamedCredential inventory. Empty when no IP REST callout declares
   * one.
   */
  readonly referencedNamedCredentials: readonly string[];
  /**
   * The outbound-callout ALLOWLIST: one entry per RemoteSiteSetting, `url`
   * verbatim, `isActive` carried. This is the artifact a security review asks
   * for by name ("every external host this org can talk to") and the one a
   * migration must re-create in the target org — an Apex callout to a host
   * with no RemoteSiteSetting throws at runtime. An entry authorizes a host;
   * it does not prove a callout exists.
   */
  readonly remoteSiteSettings: readonly EndpointEntry[];
  /**
   * The browser-side external-host allowlist: one entry per CspTrustedSite,
   * `endpointUrl` verbatim as `url`, `isActive` carried.
   */
  readonly cspTrustedSites: readonly EndpointEntry[];
  readonly summary: {
    /**
     * The total across the enumerated families BELOW — not "every URL in the
     * org". Read it with {@link EndpointCatalogOutput.notCovered}, which names
     * the URL surfaces this catalog does not model at all.
     */
    readonly totalEndpoints: number;
    readonly inboundCount: number;
    readonly outboundCount: number;
    /**
     * `endpointKind` → count. Present so an allowlist AUTHORIZATION
     * (`remote-site` / `csp-trusted-site`) can never be read as a callsite,
     * and so a caller can decompose `totalEndpoints` without re-counting the
     * arrays. Every kind with at least one entry appears; kinds with none are
     * omitted (a missing key and a `0` both mean "none of that kind here",
     * which is a scanned, not an unchecked, zero — every family above is
     * walked to exhaustion on every call).
     */
    readonly byKind: Readonly<Record<string, number>>;
  };
  readonly disclosure: string;
  /**
   * URL surfaces this catalog does NOT enumerate, always non-empty.
   *
   * A TYPED field rather than prose because the failure it prevents is a
   * machine one: a host LLM read `boundaries: []` as "nothing was omitted" and
   * told a security reviewer that a certified `totalEndpoints` was the complete
   * outbound surface. Each entry names the surface and the tool that DOES
   * enumerate it, so the gap is actionable rather than merely admitted.
   */
  readonly notCovered: readonly string[];
  /**
   * Scope disclosures for this response. NEVER empty: the first entry always
   * points at {@link EndpointCatalogOutput.notCovered}, because
   * `summary.totalEndpoints` counts the DECLARED URL-bearing metadata families
   * and not every URL the org can reach. A further entry appears when a type
   * hit the residual `FULL_SCAN_MAX_NODES` ceiling.
   */
  readonly boundaries: readonly string[];
}

/**
 * Verbatim honesty disclosure surfaced ALWAYS in the response.
 */
const ENDPOINT_CATALOG_DISCLOSURE =
  'URLs are captured verbatim from the source metadata; this tool does NOT probe, does NOT validate, and does NOT confirm that the destination exists or that the system is currently reachable. Runtime registrations (e.g., a NamedCredential resolved via custom metadata at runtime) may carry a stored URL that differs from the actual production destination. `remoteSiteSettings` and `cspTrustedSites` are ALLOWLIST authorizations — a host the org is PERMITTED to reach, which is not evidence that any code reaches it — so read them via `summary.byKind` rather than as callsites. `summary.totalEndpoints` totals the families enumerated in this response ONLY; it is NOT a certificate that the org has no other URLs. Read `notCovered[]` before treating this as the complete external surface.';

/**
 * URL surfaces this catalog does not model, named verbatim in `notCovered[]`
 * on EVERY response.
 *
 * These are not oversights that a future scan closes cheaply — each needs a
 * subsystem this tool does not have (an Apex expression evaluator, a markup
 * parser, a data-plane read). What was a defect is having claimed a TRUE total
 * while they were silently missing. Each entry names the surface AND the tool
 * that can enumerate it, so the caller is handed a next step rather than a
 * shrug.
 */
const UNCOVERED_URL_SURFACES: readonly string[] = [
  'Hardcoded URL literals inside Apex — `HttpRequest.setEndpoint(\'https://…\')` / `Http.request` to a literal host. The CALLSITE is not modeled as a URL-bearing node, so these URLs are absent from every count here; the RemoteSiteSetting that authorizes them usually is present, in `remoteSiteSettings`. Enumerate the callsites with `sfi.search_apex_source(\'setEndpoint\')` or `sfi.find_code_usages` on `HttpRequest`.',
  'URLs embedded in LWC / Aura / Visualforce markup, and in static resources — not parsed for URLs.',
  'ConnectedApp OAuth callback URLs and WebLink / custom-button targets — modeled as node properties but NOT part of this URL axis; `sfi.integration_map` returns ConnectedApps as first-class rows.',
  'URLs stored as DATA rather than metadata — Custom Setting / Custom Metadata rows, environment config resolved at runtime. An offline vault holds the metadata, not the row values.',
];

/**
 * The boundary that is ALWAYS emitted. It exists because the previous contract
 * ("`boundaries[]` is empty in the normal case") made the empty array read as a
 * completeness certificate, which inverted the signal exactly when the answer
 * was most incomplete.
 */
const SCOPE_BOUNDARY =
  '`summary.totalEndpoints` counts the DECLARED, URL-bearing metadata families ' +
  'enumerated in this response — it is NOT every URL the org can reach. ' +
  `${String(UNCOVERED_URL_SURFACES.length)} further URL surface(s) are NOT enumerated here ` +
  'and are named in `notCovered[]`; read them before signing off an integration ' +
  'or security inventory.';

/**
 * Read a string property defensively. Returns the verbatim value
 * when it's a non-empty string, or null otherwise.
 */
const readOptionalString = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const raw = properties[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/**
 * Recognise the `ExternalApi` synthetic-id `kind` segment from an
 * `exposes` edge's `toId`. The v1.5 R3 synthetic-id form is
 * `ExternalApi:{kind}/{path}`; we recover `kind` by splitting on
 * `:` and then on `/`.
 */
const recoverExternalApiKind = (toId: string): EndpointKind | null => {
  if (!toId.startsWith('ExternalApi:')) return null;
  const tail = toId.slice('ExternalApi:'.length);
  const slash = tail.indexOf('/');
  if (slash === -1) return null;
  const kind = tail.slice(0, slash);
  if (kind === 'rest' || kind === 'aura' || kind === 'invocable') return kind;
  return null;
};

/**
 * Recover the URL/path fragment from an `ExternalApi:` synthetic
 * `toId` — the part after the `kind/` prefix. Used as the
 * inbound-API endpoint's `url` field.
 */
const recoverExternalApiPath = (toId: string): string | null => {
  const colon = toId.indexOf(':');
  if (colon === -1) return null;
  const tail = toId.slice(colon + 1);
  const slash = tail.indexOf('/');
  if (slash === -1) return null;
  return tail.slice(slash + 1);
};

/**
 * Collect every inbound API endpoint by walking `exposes` edges
 * from ApexClass nodes. Each edge's `toId` is a synthetic
 * `ExternalApi:{kind}/{path}` and surfaces as one entry with the
 * source class plus the path as the URL.
 *
 * Implementation: we walk EVERY ApexClass node (the scan windows the SQL
 * `OFFSET` past the 500-row per-page cap — a `@RestResource` sorting past
 * position 500 by id used to be silently absent from an "every URL" catalog)
 * and batch the `exposes` edges with ONE `listEdgesForNodes` per chunk.
 */
const collectInboundApis = async (
  ctx: Context,
): Promise<Result<CollectedCategory, string>> => {
  const classesResult = await scanAllNodesOfTypes(ctx.graph, ['ApexClass']);
  if (!classesResult.ok) return err(classesResult.error.message);
  const classes = classesResult.value.nodes;
  const entries: EndpointEntry[] = [];
  const chunkSize = clampedNodeScanLimit();
  for (let i = 0; i < classes.length; i += chunkSize) {
    const ids = classes.slice(i, i + chunkSize).map((n) => n.id);
    const edgesResult = await listEdgesForNodes(ctx.graph, ids, {
      direction: 'out',
      edgeTypes: ['exposes'],
    });
    if (!edgesResult.ok) return err(edgesResult.error.message);
    for (const id of ids) {
      for (const edge of edgesResult.value.get(id) ?? []) {
        const kind = recoverExternalApiKind(edge.toId);
        if (kind === null) continue;
        entries.push({
          endpointKind: kind,
          direction: 'inbound',
          sourceComponentId: edge.fromId,
          url: recoverExternalApiPath(edge.toId),
        });
      }
    }
  }
  return ok({ entries, incompleteTypes: classesResult.value.incompleteTypes });
};

/**
 * Collect every outbound-message endpoint by walking the
 * OutboundMessage node family the v2.8 promotion produces. Each
 * node's `properties.endpointUrl` is the destination URL.
 */
const collectOutboundMessages = async (
  ctx: Context,
): Promise<Result<CollectedCategory, string>> => {
  const nodesResult = await scanAllNodesOfTypes(ctx.graph, ['OutboundMessage']);
  if (!nodesResult.ok) return err(nodesResult.error.message);
  return ok({
    entries: (nodesResult.value.nodes as readonly Node[]).map((node) => ({
      endpointKind: 'outbound-message' as const,
      direction: 'outbound' as const,
      sourceComponentId: node.id,
      url: readOptionalString(node.properties, 'endpointUrl'),
    })),
    incompleteTypes: nodesResult.value.incompleteTypes,
  });
};

/**
 * Collect every ExternalDataSource endpoint. Each node's
 * `properties.endpoint` (or `properties.url`) is the OData / cross-
 * org binding's URL. The v1.5 R2 producer uses `endpoint`; older
 * extractor variants may use `url`. Read both and prefer
 * `endpoint`.
 */
const collectExternalDataSources = async (
  ctx: Context,
): Promise<Result<CollectedCategory, string>> => {
  const nodesResult = await scanAllNodesOfTypes(ctx.graph, [
    'ExternalDataSource',
  ]);
  if (!nodesResult.ok) return err(nodesResult.error.message);
  return ok({
    entries: (nodesResult.value.nodes as readonly Node[]).map((node) => ({
      endpointKind: 'external-data-source' as const,
      direction: 'outbound' as const,
      sourceComponentId: node.id,
      url:
        readOptionalString(node.properties, 'endpoint') ??
        readOptionalString(node.properties, 'url'),
    })),
    incompleteTypes: nodesResult.value.incompleteTypes,
  });
};

/**
 * Collect every NamedCredential endpoint. Each node's
 * `properties.url` (or `properties.endpoint`) is the outbound HTTP
 * callout's URL. Read both and prefer `url`.
 */
const collectNamedCredentials = async (
  ctx: Context,
): Promise<Result<CollectedCategory, string>> => {
  const nodesResult = await scanAllNodesOfTypes(ctx.graph, ['NamedCredential']);
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const entries: EndpointEntry[] = [];
  for (const node of nodesResult.value.nodes as readonly Node[]) {
    // Inbound `references` edges = anything in the retrieved metadata
    // wired to this credential. A zero count is the grounded basis for
    // `orphaned: true` — so the catalog reports an unreferenced
    // credential as orphaned instead of implying it is in use.
    const inboundResult = await listEdges(ctx.graph, node.id, {
      direction: 'in',
      edgeType: 'references',
    });
    if (!inboundResult.ok) return err(inboundResult.error.message);
    const referenceCount = inboundResult.value.length;
    entries.push({
      endpointKind: 'named-credential' as const,
      direction: 'outbound' as const,
      sourceComponentId: node.id,
      url:
        readOptionalString(node.properties, 'url') ??
        readOptionalString(node.properties, 'endpoint'),
      referenceCount,
      orphaned: referenceCount === 0,
    });
  }
  return ok({ entries, incompleteTypes: nodesResult.value.incompleteTypes });
};

/**
 * One decoded Rest Action callout as the omni-integration-procedure
 * extractor persists it on an IP node's `properties.restEndpoints`.
 * Mirrors the extractor's `RestEndpoint` shape; re-declared locally to
 * avoid a cross-package type import from the extractors package (the
 * MCP package reads the graph, not the extractor source).
 */
interface OmniRestEndpoint {
  readonly stepName: string;
  readonly path: string;
  readonly method: string | null;
  readonly namedCredential: string | null;
}

/**
 * Narrow a node's `properties.restEndpoints` (which is `unknown` at the
 * JSON-backed type level) into the typed array. Defensive: drops any
 * element missing a non-empty string `path`, and normalises the
 * optional `method` / `namedCredential` to `string | null`.
 */
const readRestEndpoints = (
  properties: Readonly<Record<string, unknown>>,
): readonly OmniRestEndpoint[] => {
  const raw = properties['restEndpoints'];
  if (!Array.isArray(raw)) return [];
  const out: OmniRestEndpoint[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const path = rec['path'];
    if (typeof path !== 'string' || path.length === 0) continue;
    const stepName = rec['stepName'];
    const method = rec['method'];
    const namedCredential = rec['namedCredential'];
    out.push({
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
 * Collect every OmniStudio outbound REST callout. Walks
 * OmniIntegrationProcedure nodes and flattens each node's
 * `restEndpoints` array (one entry per Rest Action with a non-empty
 * `restPath`) into outbound `omni-rest` endpoint entries. The source
 * component is the IP node; the `url` is the verbatim REST path and
 * `namedCredential` the declared host alias (or `null`).
 *
 * Real-vault note: `restEndpoints` is an EXTRACTION-time property, so
 * an org refreshed before this extractor change surfaces nothing here
 * until a re-refresh repopulates the IP nodes.
 */
const collectOmniRestEndpoints = async (
  ctx: Context,
): Promise<Result<CollectedCategory, string>> => {
  const nodesResult = await scanAllNodesOfTypes(ctx.graph, [
    'OmniIntegrationProcedure',
  ]);
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const entries: EndpointEntry[] = [];
  for (const node of nodesResult.value.nodes as readonly Node[]) {
    for (const endpoint of readRestEndpoints(node.properties)) {
      entries.push({
        endpointKind: 'omni-rest',
        direction: 'outbound',
        sourceComponentId: node.id,
        url: endpoint.path,
        namedCredential: endpoint.namedCredential,
      });
    }
  }
  return ok({ entries, incompleteTypes: nodesResult.value.incompleteTypes });
};

/**
 * Collect one URL-bearing ALLOWLIST family (RemoteSiteSetting /
 * CspTrustedSite) into endpoint entries.
 *
 * Both families have the same shape — one node, one required URL element, one
 * `isActive` flag — so they share ONE collector rather than a second
 * near-identical copy (the duplication that lets two spellings of the same walk
 * drift apart). The URL property name differs per type and is passed in.
 *
 * The URL element is REQUIRED by both extractors, so `readOptionalString`
 * returning `null` here means a MALFORMED or pre-extractor node, not "this
 * allowlist entry names no host". Such a row is still LISTED with `url: null`:
 * dropping it would be the same silent omission this whole family exists to
 * close.
 */
const collectAllowlistFamily = async (
  ctx: Context,
  type: 'RemoteSiteSetting' | 'CspTrustedSite',
  urlProperty: string,
  endpointKind: EndpointKind,
): Promise<Result<CollectedCategory, string>> => {
  const nodesResult = await scanAllNodesOfTypes(ctx.graph, [type]);
  if (!nodesResult.ok) return err(nodesResult.error.message);
  return ok({
    entries: (nodesResult.value.nodes as readonly Node[]).map((node) => ({
      endpointKind,
      direction: 'outbound' as const,
      sourceComponentId: node.id,
      url: readOptionalString(node.properties, urlProperty),
      isActive: node.properties['isActive'] === true,
    })),
    incompleteTypes: nodesResult.value.incompleteTypes,
  });
};

/**
 * Deterministic entry comparator: sourceComponentId ASC, then url
 * ASC (nulls first). Stable across runs.
 */
const compareEntries = (a: EndpointEntry, b: EndpointEntry): number => {
  if (a.sourceComponentId !== b.sourceComponentId) {
    return a.sourceComponentId < b.sourceComponentId ? -1 : 1;
  }
  const ua = a.url ?? '';
  const ub = b.url ?? '';
  if (ua !== ub) return ua < ub ? -1 : 1;
  return 0;
};

/**
 * The `sfi.endpoint_catalog` MCP tool. Returns a structured table of
 * every URL / endpoint that participates in an integration (inbound
 * APIs + outbound messages + external data sources + named
 * credentials). No edges; no subscriber lists — just the URL axis.
 *
 * @example
 *   const r = await endpointCatalogHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.summary.totalEndpoints);
 */
export const endpointCatalogHandler = async (
  ctx: Context,
  input: EndpointCatalogInput,
): Promise<Result<McpResponse<EndpointCatalogOutput>, McpError>> => {
  // ENDPOINT-CATALOG-IGNORES-OBJECT-SCOPE: refuse an object / component scope
  // instead of silently returning the whole-org catalog (byte-identical for Contact
  // vs Account vs bare). No endpoint→object edge exists — mirror the closed
  // `integration_map` refusal. A bare call falls through, keeping today's golden.
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
        `endpoint_catalog cannot scope by object — endpoints aren't associated to a single object (\`${scopeKey}\`); drop objectApiName. ` +
        'It is ORG-WIDE; for endpoints on a specific object use `find_code_usages`.',
      path: 'objectApiName',
    });
  }

  const inboundResult = await collectInboundApis(ctx);
  if (!inboundResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${inboundResult.error}`,
    });
  }
  const outboundMsgResult = await collectOutboundMessages(ctx);
  if (!outboundMsgResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${outboundMsgResult.error}`,
    });
  }
  const externalDSResult = await collectExternalDataSources(ctx);
  if (!externalDSResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${externalDSResult.error}`,
    });
  }
  const namedCredResult = await collectNamedCredentials(ctx);
  if (!namedCredResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${namedCredResult.error}`,
    });
  }
  const omniRestResult = await collectOmniRestEndpoints(ctx);
  if (!omniRestResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${omniRestResult.error}`,
    });
  }
  const remoteSiteResult = await collectAllowlistFamily(
    ctx,
    'RemoteSiteSetting',
    'url',
    'remote-site',
  );
  if (!remoteSiteResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${remoteSiteResult.error}`,
    });
  }
  const cspResult = await collectAllowlistFamily(
    ctx,
    'CspTrustedSite',
    'endpointUrl',
    'csp-trusted-site',
  );
  if (!cspResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${cspResult.error}`,
    });
  }

  const inbound = [...inboundResult.value.entries].sort(compareEntries);
  const outboundMsg = [...outboundMsgResult.value.entries].sort(compareEntries);
  const externalDS = [...externalDSResult.value.entries].sort(compareEntries);
  const namedCred = [...namedCredResult.value.entries].sort(compareEntries);
  const omniRest = [...omniRestResult.value.entries].sort(compareEntries);
  const remoteSites = [...remoteSiteResult.value.entries].sort(compareEntries);
  const cspSites = [...cspResult.value.entries].sort(compareEntries);

  // Residual full-scan cap across the five categories. Empty in the normal
  // case; when it fires, `summary.totalEndpoints` is an undercount and must not
  // read as a complete tally.
  const incompleteTypes = [
    ...inboundResult.value.incompleteTypes,
    ...outboundMsgResult.value.incompleteTypes,
    ...externalDSResult.value.incompleteTypes,
    ...namedCredResult.value.incompleteTypes,
    ...omniRestResult.value.incompleteTypes,
    ...remoteSiteResult.value.incompleteTypes,
    ...cspResult.value.incompleteTypes,
  ];
  // ALWAYS-ON scope boundary first. `boundaries: []` used to mean "nothing was
  // omitted", which is the reading that let a certified `totalEndpoints: 34`
  // stand while 35 allowlist URLs in the same vault went unmentioned. The
  // residual full-scan cap, when it bites, is appended after it.
  const boundaries =
    incompleteTypes.length > 0
      ? [SCOPE_BOUNDARY, fullScanTruncationNote(incompleteTypes)]
      : [SCOPE_BOUNDARY];

  // The distinct, sorted host aliases the OmniStudio callout surface
  // references — surfaced so an architect can reconcile them against the
  // NamedCredential inventory above.
  const referencedNamedCredentials = [
    ...new Set(
      omniRest
        .map((e) => e.namedCredential)
        .filter((nc): nc is string => typeof nc === 'string' && nc.length > 0),
    ),
  ].sort();

  const inboundCount = inbound.length;
  const outboundCount =
    outboundMsg.length +
    externalDS.length +
    namedCred.length +
    omniRest.length +
    remoteSites.length +
    cspSites.length;

  // DERIVED from the emitted rows, never from a parallel tally — a hand-kept
  // second count is how `totalEndpoints` and the arrays drift apart.
  const byKind: Record<string, number> = {};
  for (const entry of [
    ...inbound,
    ...outboundMsg,
    ...externalDS,
    ...namedCred,
    ...omniRest,
    ...remoteSites,
    ...cspSites,
  ]) {
    byKind[entry.endpointKind] = (byKind[entry.endpointKind] ?? 0) + 1;
  }

  return ok({
    data: {
      inboundApis: inbound,
      outboundMessages: outboundMsg,
      externalDataSources: externalDS,
      namedCredentials: namedCred,
      omniRestEndpoints: omniRest,
      referencedNamedCredentials,
      remoteSiteSettings: remoteSites,
      cspTrustedSites: cspSites,
      summary: {
        totalEndpoints: inboundCount + outboundCount,
        inboundCount,
        outboundCount,
        byKind,
      },
      disclosure: ENDPOINT_CATALOG_DISCLOSURE,
      notCovered: UNCOVERED_URL_SURFACES,
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
