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
 * Implementation notes:
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
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { firstNonEmpty } from './input-aliases.js';

/**
 * Hard cap on the per-category scan. Mirrors the
 * `OUTBOUND_MESSAGE_CATALOG_MAX_ENTRIES` ceiling so the v2.8
 * catalog tools share the same blast-radius cap.
 */
const ENDPOINT_CATALOG_MAX_PER_CATEGORY = 500;

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
 * `external-data-source`, `named-credential`, and `omni-rest`
 * (OmniStudio Integration Procedure Rest Action callouts).
 */
export type EndpointKind =
  | 'rest'
  | 'aura'
  | 'invocable'
  | 'outbound-message'
  | 'external-data-source'
  | 'named-credential'
  | 'omni-rest';

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
  readonly summary: {
    readonly totalEndpoints: number;
    readonly inboundCount: number;
    readonly outboundCount: number;
  };
  readonly disclosure: string;
}

/**
 * Verbatim honesty disclosure surfaced ALWAYS in the response.
 */
const ENDPOINT_CATALOG_DISCLOSURE =
  'URLs are captured verbatim from the source metadata; v2.8 does NOT probe, does NOT validate, and does NOT confirm that the destination exists or that the system is currently reachable. Runtime registrations (e.g., a NamedCredential resolved via custom metadata at runtime) may carry a stored URL that differs from the actual production destination.';

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
 * Implementation: we walk every ApexClass node and listEdges with
 * direction='out', edgeType='exposes'. This is O(N) over the
 * ApexClass population but bounded by the per-category cap.
 */
const collectInboundApis = async (
  ctx: Context,
): Promise<Result<readonly EndpointEntry[], string>> => {
  const classesResult = await listNodesByType(ctx.graph, 'ApexClass', {
    limit: ENDPOINT_CATALOG_MAX_PER_CATEGORY,
  });
  if (!classesResult.ok) return err(classesResult.error.message);
  const entries: EndpointEntry[] = [];
  for (const node of classesResult.value as readonly Node[]) {
    const edgesResult = await listEdges(ctx.graph, node.id, {
      direction: 'out',
      edgeType: 'exposes',
    });
    if (!edgesResult.ok) return err(edgesResult.error.message);
    for (const edge of edgesResult.value) {
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
  return ok(entries);
};

/**
 * Collect every outbound-message endpoint by walking the
 * OutboundMessage node family the v2.8 promotion produces. Each
 * node's `properties.endpointUrl` is the destination URL.
 */
const collectOutboundMessages = async (
  ctx: Context,
): Promise<Result<readonly EndpointEntry[], string>> => {
  const nodesResult = await listNodesByType(ctx.graph, 'OutboundMessage', {
    limit: ENDPOINT_CATALOG_MAX_PER_CATEGORY,
  });
  if (!nodesResult.ok) return err(nodesResult.error.message);
  return ok(
    (nodesResult.value as readonly Node[]).map((node) => ({
      endpointKind: 'outbound-message' as const,
      direction: 'outbound' as const,
      sourceComponentId: node.id,
      url: readOptionalString(node.properties, 'endpointUrl'),
    })),
  );
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
): Promise<Result<readonly EndpointEntry[], string>> => {
  const nodesResult = await listNodesByType(ctx.graph, 'ExternalDataSource', {
    limit: ENDPOINT_CATALOG_MAX_PER_CATEGORY,
  });
  if (!nodesResult.ok) return err(nodesResult.error.message);
  return ok(
    (nodesResult.value as readonly Node[]).map((node) => ({
      endpointKind: 'external-data-source' as const,
      direction: 'outbound' as const,
      sourceComponentId: node.id,
      url:
        readOptionalString(node.properties, 'endpoint') ??
        readOptionalString(node.properties, 'url'),
    })),
  );
};

/**
 * Collect every NamedCredential endpoint. Each node's
 * `properties.url` (or `properties.endpoint`) is the outbound HTTP
 * callout's URL. Read both and prefer `url`.
 */
const collectNamedCredentials = async (
  ctx: Context,
): Promise<Result<readonly EndpointEntry[], string>> => {
  const nodesResult = await listNodesByType(ctx.graph, 'NamedCredential', {
    limit: ENDPOINT_CATALOG_MAX_PER_CATEGORY,
  });
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const entries: EndpointEntry[] = [];
  for (const node of nodesResult.value as readonly Node[]) {
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
  return ok(entries);
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
): Promise<Result<readonly EndpointEntry[], string>> => {
  const nodesResult = await listNodesByType(
    ctx.graph,
    'OmniIntegrationProcedure',
    { limit: ENDPOINT_CATALOG_MAX_PER_CATEGORY },
  );
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const entries: EndpointEntry[] = [];
  for (const node of nodesResult.value as readonly Node[]) {
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
  return ok(entries);
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

  const inbound = [...inboundResult.value].sort(compareEntries);
  const outboundMsg = [...outboundMsgResult.value].sort(compareEntries);
  const externalDS = [...externalDSResult.value].sort(compareEntries);
  const namedCred = [...namedCredResult.value].sort(compareEntries);
  const omniRest = [...omniRestResult.value].sort(compareEntries);

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
    outboundMsg.length + externalDS.length + namedCred.length + omniRest.length;

  return ok({
    data: {
      inboundApis: inbound,
      outboundMessages: outboundMsg,
      externalDataSources: externalDS,
      namedCredentials: namedCred,
      omniRestEndpoints: omniRest,
      referencedNamedCredentials,
      summary: {
        totalEndpoints: inboundCount + outboundCount,
        inboundCount,
        outboundCount,
      },
      disclosure: ENDPOINT_CATALOG_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
