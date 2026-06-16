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
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Inclusive upper bound on `limit`. */
const CHANGED_SINCE_MAX_LIMIT = 500;

/** Default `limit` when the caller omits it. */
const CHANGED_SINCE_DEFAULT_LIMIT = 100;

/** Per-type page size — caps the per-type scan at the graph layer's max. */
const LIST_PAGE_SIZE = 500;

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
 * Zod schema for the `sfi.changed_since` tool input.
 *
 *   - `since`: required ISO 8601 timestamp (date-only `YYYY-MM-DD` or
 *     full `YYYY-MM-DDTHH:mm:ssZ`). The validator accepts any string
 *     that parses as a date; the runtime normalises non-Z-suffixed
 *     inputs to UTC midnight so the boundary is unambiguous.
 *   - `types`: optional array; when omitted, the handler scans every
 *     ComponentType in the v1.x contract.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100.
 */
export const changedSinceInputSchema = z.object({
  since: z.string().min(1).refine(
    (s) => !Number.isNaN(Date.parse(s)),
    { message: 'since must be a valid ISO 8601 date string' },
  ),
  types: z.array(z.enum(COMPONENT_TYPES)).optional(),
  limit: z.number().int().min(1).max(CHANGED_SINCE_MAX_LIMIT).optional(),
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
  const since = normalizeSince(input.since);

  const matched: ChangedComponent[] = [];
  let unenrichedCount = 0;

  for (const type of types) {
    const nodesResult = await listNodesByType(ctx.graph, type, {
      limit: LIST_PAGE_SIZE,
    });
    if (!nodesResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${nodesResult.error.message}`,
      });
    }
    for (const node of nodesResult.value) {
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
  }

  const sorted = [...matched].sort(compareByDateDescThenIdAsc);
  const truncated = sorted.length > limit;
  const changed = sorted.slice(0, limit);

  return ok({
    data: {
      since,
      changed,
      unenrichedCount,
      truncated,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
