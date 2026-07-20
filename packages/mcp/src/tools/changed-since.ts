/**
 * Handler for the `sfi.changed_since` MCP tool.
 *
 * The v1.7 freshness headline answers the buyer-priority gap "when was
 * X modified?". Given a `since` date (ISO 8601), enumerate every vault
 * node whose `properties.lastModifiedDate` is at or after that
 * timestamp. Optional `types` filter narrows the scan to a subset of
 * ComponentTypes; optional `limit` truncates the response.
 *
 * **Honesty axis** — the tool surfaces the partial-data shape via the
 * `unenrichedCount` field. Every node whose `properties.lastModifiedDate`
 * is `null` (i.e. not yet enriched via `sfi refresh --with-tooling-api`)
 * is counted in `unenrichedCount` so the consumer can surface a
 * "rerun refresh with --with-tooling-api for full coverage" suggestion
 * rather than silently dropping the unenriched fraction. The tool
 * remains FULLY FUNCTIONAL against an un-enriched vault: it returns
 * `changed: []` plus the full `unenrichedCount` so the caller sees
 * the gap explicitly.
 *
 * v1.7 covers the six ComponentTypes the R2 dispatch table enriches
 * (ApexClass, ApexTrigger, Flow, Layout, CustomField, ValidationRule);
 * other types may receive freshness enrichment in v1.7+ R3 (ProfileSet,
 * EmailTemplate, etc.). The handler does NOT enforce that constraint —
 * any node with a non-null `lastModifiedDate` participates, regardless
 * of whether it was the enricher's output or a future v1.7 pass.
 *
 * Implementation notes:
 *   - The scan iterates the requested ComponentTypes (defaulting to
 *     ALL types in the v1.x contract) and pages through
 *     `listNodesByType` at the graph layer's max page size (500). A
 *     real org with >500 nodes per type loses tail coverage past that
 *     page — surfaced as a future-tier limit, not a v1.7 axis.
 *   - The `since` comparison is a string compare (ISO 8601 lex-sorts
 *     correctly for the same offset). v1.7 normalises `since` to UTC
 *     so a caller passing a local-time date does not silently flap the
 *     boundary.
 *   - Result sort: `lastModifiedDate DESC` then `id ASC`.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

/** Inclusive upper bound on `limit`. */
const CHANGED_SINCE_MAX_LIMIT = 500;

/** Default `limit` when the caller omits it. */
const CHANGED_SINCE_DEFAULT_LIMIT = 100;

const CHANGED_SINCE_TOOL = 'sfi.changed_since';

/**
 * Full superset of ComponentTypes for Zod validation. Mirrors the
 * contracts `ComponentType` union; declared inline so the validator
 * rejects typos with `invalid-query` rather than silently returning an
 * empty list for a never-existed type.
 */
const COMPONENT_TYPES = [
  'CustomObject',
  'CustomField',
  'ValidationRule',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'Layout',
  'Profile',
  'PermissionSet',
  'PermissionSetAssignment',
  'NamedCredential',
  'ConnectedApp',
  'Group',
  'Queue',
  'Role',
  'SharingRule',
  'RecordType',
  'BusinessProcess',
  'CustomTab',
  'CustomApplication',
  'QuickAction',
  'PathAssistant',
  'GlobalValueSet',
  'CustomLabel',
  'StaticResource',
  'WorkflowRule',
  'ApprovalProcess',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  'DuplicateRule',
  'MatchingRule',
  'EmailTemplate',
  'Letterhead',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  'AuthProvider',
  'RemoteSiteSetting',
  'CspTrustedSite',
  'ExternalDataSource',
  'ExternalService',
  'NetworkAccess',
  'CustomMetadataRecord',
  'CustomSettingRecord',
] as const satisfies readonly ComponentType[];

/**
 * Natural "since my last refresh" tokens a host reaches for when the router
 * ranked `changed_since` for a refresh-relative ask
 * (CHANGED-SINCE-REJECTS-LAST-REFRESH-TOKEN). Each resolves to the vault's
 * `manifest.refreshedAt` — the moment this vault was built — so the answer is
 * grounded in a real timestamp rather than hard-failing on ISO validation.
 *
 * The separator is normalised (hyphen ≡ underscore ≡ space) so `last-refresh`,
 * `last_refresh`, and `last refresh` are all accepted — the residual the
 * hyphen-only fix left open.
 */
const REFRESH_SINCE_TOKENS: ReadonlySet<string> = new Set([
  'last-refresh',
  'lastrefresh',
  'refresh',
]);

/**
 * Whether `raw` is a refresh-relative `since` token. Case-insensitive, and any
 * run of hyphen / underscore / whitespace collapses to a single `-` so the
 * hyphen, underscore, and SPACE forms (`last refresh`) all resolve.
 */
const isRefreshToken = (raw: string): boolean =>
  REFRESH_SINCE_TOKENS.has(raw.trim().toLowerCase().replace(/[\s_-]+/g, '-'));

/**
 * Zod schema for the `sfi.changed_since` tool input.
 *
 *   - `since`: required — an ISO 8601 timestamp (date-only `YYYY-MM-DD` or
 *     full `YYYY-MM-DDTHH:mm:ssZ`), OR the natural token `last-refresh` /
 *     `last refresh` / `last_refresh` / `refresh` (separator-insensitive) which
 *     the handler resolves to the vault's `refreshedAt`. The runtime normalises
 *     non-Z-suffixed inputs to UTC so the boundary is unambiguous; the resolved
 *     boundary is echoed back as `since`.
 *   - `types`: optional array; when omitted, the handler scans every
 *     ComponentType in the v1.x contract.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100.
 */
export const changedSinceInputSchema = z.object({
  since: z.string().min(1).refine(
    (s) => isRefreshToken(s) || !Number.isNaN(Date.parse(s)),
    { message: 'since must be a valid ISO 8601 date string, or the token "last-refresh"' },
  ),
  types: z.array(z.enum(COMPONENT_TYPES)).optional(),
  limit: z.number().int().min(1).max(CHANGED_SINCE_MAX_LIMIT).optional(),
  // CR-22: page cursor for walking the full changed list when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `changedSinceInputSchema`. */
export type ChangedSinceInput = z.infer<typeof changedSinceInputSchema>;

/** One entry in the `changed` array. */
export interface ChangedComponent {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly lastModifiedDate: string;
  readonly lastModifiedBy: {
    readonly id: string;
    readonly name: string;
  };
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ChangedSinceOutput {
  /** The normalised `since` boundary (ISO 8601 UTC). */
  readonly since: string;
  readonly changed: readonly ChangedComponent[];
  /**
   * Count of nodes (within the requested `types`) whose
   * `lastModifiedDate` is `null`. The non-zero value tells the caller
   * the answer is partial — run `sfi refresh --with-tooling-api` for
   * full coverage.
   */
  readonly unenrichedCount: number;
  /** True when the response slice was trimmed to `limit`. */
  readonly truncated: boolean;
  /**
   * Honesty disclosure, present ONLY when a pathological type's full scan hit
   * FULL_SCAN_MAX_NODES (so the enumeration may be incomplete). Absent on a
   * normal full scan, keeping that response byte-identical to pre-CR-22.
   */
  readonly boundaries?: readonly string[];
  /**
   * Page size applied to this response. Present ONLY on a PAGED response
   * (`truncated` or a resumed `offset > 0`); omitted on a whole-fits no-cursor
   * call so that response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned change. Present only when paged (see `limit`). */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when `truncated`. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated.
   * Echo it back as `cursor` to resume. Absent on a complete page so an
   * in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

/**
 * Normalise `since` to a UTC ISO 8601 string the comparison can use.
 * Accepts either a date-only `YYYY-MM-DD` (assumed UTC midnight) or a
 * full timestamp. Returns the canonical UTC ISO string.
 */
const normalizeSince = (raw: string): string => {
  // The Zod refine already verified `Date.parse(raw)` is finite.
  return new Date(raw).toISOString();
};

/**
 * Comparator: lastModifiedDate DESC, then id ASC.
 *
 * This is already a STRICT TOTAL order (CR-22): `id` is the unique node
 * ComponentId, so no two distinct ChangedComponents compare equal — the id-ASC
 * secondary key resolves every date tie uniquely. No further tiebreak is needed
 * for a dup-free / skip-free offset resume.
 */
const compareByDateDescThenIdAsc = (a: ChangedComponent, b: ChangedComponent): number => {
  if (a.lastModifiedDate !== b.lastModifiedDate) {
    return a.lastModifiedDate < b.lastModifiedDate ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Extract the `lastModifiedBy.id` / `.name` pair from a node's properties.
 * The v1.7 enricher writes `{ id, name }` under `properties.lastModifiedBy`;
 * the v0.1 baseline writes the legacy string-only `lastModifiedBy` field
 * on the node. The tool reads BOTH so an un-enriched node with a legacy
 * string value still surfaces something useful (`{ id: legacy, name: '' }`).
 */
const extractLastModifiedBy = (
  legacy: string | null,
  properties: Readonly<Record<string, unknown>>,
): { id: string; name: string } => {
  const propsValue = properties['lastModifiedBy'];
  if (propsValue !== undefined && propsValue !== null && typeof propsValue === 'object') {
    const obj = propsValue as { id?: unknown; name?: unknown };
    const id = typeof obj.id === 'string' ? obj.id : '';
    const name = typeof obj.name === 'string' ? obj.name : '';
    if (id.length > 0 || name.length > 0) {
      return { id, name };
    }
  }
  if (typeof legacy === 'string' && legacy.length > 0) {
    return { id: legacy, name: '' };
  }
  return { id: '', name: '' };
};

/**
 * Extract the freshness `lastModifiedDate` for a node. Prefers
 * `properties.lastModifiedDate` (the v1.7 enricher's overlay) and
 * falls back to the legacy top-level `lastModifiedDate` field. Returns
 * `null` when neither source carries a value.
 */
const extractLastModifiedDate = (
  legacy: string | null,
  properties: Readonly<Record<string, unknown>>,
): string | null => {
  const propsValue = properties['lastModifiedDate'];
  if (typeof propsValue === 'string' && propsValue.length > 0) {
    return propsValue;
  }
  if (typeof legacy === 'string' && legacy.length > 0) {
    return legacy;
  }
  return null;
};

/**
 * The `sfi.changed_since` handler. Scans the requested types, decides
 * whether each node is past the `since` boundary, and returns the
 * structural answer with the partial-data axis surfaced via
 * `unenrichedCount`. See the module JSDoc for the honesty axis and the
 * partial-data rationale.
 *
 * @example
 *   const r = await changedSinceHandler(ctx, {
 *     since: '2026-05-01',
 *     types: ['ApexClass', 'Flow'],
 *   });
 *   if (r.ok) console.log(r.value.data.changed.length, r.value.data.unenrichedCount);
 */
export const changedSinceHandler = async (
  ctx: Context,
  input: ChangedSinceInput,
): Promise<Result<McpResponse<ChangedSinceOutput>, McpError>> => {
  const limit = input.limit ?? CHANGED_SINCE_DEFAULT_LIMIT;
  const types = input.types ?? COMPONENT_TYPES;

  // CHANGED-SINCE-REJECTS-LAST-REFRESH-TOKEN: resolve a natural "last refresh"
  // token to the vault's refresh timestamp. The resolution is transparent —
  // `since` in the output echoes the resolved boundary, so passing the token is
  // byte-identical to passing that ISO instant. (For the component TYPES the
  // refresh itself pulled in, use `what_changed_since_refresh`.)
  const rawSince = isRefreshToken(input.since)
    ? ctx.manifest.refreshedAt
    : input.since;
  if (Number.isNaN(Date.parse(rawSince))) {
    return err({
      kind: 'invalid-query',
      message: `cannot anchor "${input.since}" — the vault manifest has no valid refreshedAt; pass an explicit ISO 8601 date`,
      path: 'since',
    });
  }
  const since = normalizeSince(rawSince);

  const matched: ChangedComponent[] = [];
  let unenrichedCount = 0;

  // CR-22 B4: scan EVERY node of each requested type by paging the SQL OFFSET
  // forward (window-by-window) so a type with >500 nodes (CustomField trivially)
  // no longer silently drops nodes 501+ from BOTH `changed` and `unenrichedCount`
  // — the admitted scan-tail bug. The scan completes inside this call, so the
  // output list is then paged on the output axis below (no `s` scan cursor).
  const scan = await scanAllNodesOfTypes(ctx.graph, types);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }
  for (const node of scan.value.nodes) {
    const date = extractLastModifiedDate(node.lastModifiedDate, node.properties);
    if (date === null) {
      unenrichedCount += 1;
      continue;
    }
    if (date < since) continue;
    matched.push({
      id: node.id,
      type: node.type,
      apiName: node.apiName,
      lastModifiedDate: date,
      lastModifiedBy: extractLastModifiedBy(node.lastModifiedBy, node.properties),
    });
  }

  const sorted = [...matched].sort(compareByDateDescThenIdAsc);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers the NARROWING args — the normalised `since` boundary
  // and `types` — so a token minted for one query can't be replayed against
  // another. (`since` is normalised so the same instant always fingerprints
  // identically across calls.)
  const fingerprint = argsFingerprint({
    since,
    ...(input.types !== undefined ? { types: input.types } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: CHANGED_SINCE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(sorted, {
    offset,
    limit,
    keyOf: (c) => c.id,
    binding: {
      tool: CHANGED_SINCE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const changed = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  const isPaged = truncated || offset > 0;

  // A pathological type past FULL_SCAN_MAX_NODES leaves the scan incomplete;
  // disclose it via the response envelope (the existing shape has no boundaries
  // array, so surface it only when actually incomplete — a normal full scan
  // leaves this absent and the response byte-identical).
  const scanNote = scan.value.scanIncomplete
    ? fullScanTruncationNote(scan.value.incompleteTypes)
    : undefined;

  return ok({
    data: {
      since,
      changed,
      unenrichedCount,
      truncated,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + changed.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
      ...(scanNote !== undefined ? { boundaries: [scanNote] } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
