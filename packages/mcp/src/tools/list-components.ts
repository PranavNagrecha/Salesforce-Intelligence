/**
 * Handler for the `sfi.list_components` MCP tool.
 *
 * Surfaces the graph layer's `listNodesByType` query through the MCP
 * envelope. `type` is required for v0.1 — the underlying graph query needs
 * a type to scope its index scan and v0.1 explicitly avoids the "list
 * everything" mode (which would require COUNT(*) plumbing the graph layer
 * does not yet ship). Pagination follows the graph's defaults (limit=50,
 * max=500) and exposes a `hasMore` hint so clients can iterate without a
 * separate count call. The returned page is additionally byte-bounded so it
 * can never exceed the global MCP response-size guard: an oversized page is
 * trimmed to the largest id-ordered prefix that fits and `hasMore` is set.
 * Unknown component types are rejected at the Zod boundary (`invalid-query`)
 * rather than silently producing an empty list.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { STANDARD_OBJECT_FIELD_SNAPSHOT } from '@sf-intelligence/extractors';
import { countNodesByType, listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { buildEnumerationCoverageCaveat, type CoverageCaveat } from './coverage-trust.js';
import { argsFingerprint, decodeCursor, encodeCursor, PAGE_CURSOR_VERSION } from './page-cursor.js';

const LIST_COMPONENTS_TOOL = 'sfi.list_components';

const STANDARD_OBJECT_API_NAMES = new Set<string>(STANDARD_OBJECT_FIELD_SNAPSHOT);

/** Standard/custom object apiName from a `CustomObject:…` parent id. */
const objectApiNameFromParentId = (parentId: string): string | null =>
  parentId.startsWith('CustomObject:') ? parentId.slice('CustomObject:'.length) : null;

/** Metadata API retrieve rarely emits full standard-object field inventories. */
const isStandardObjectApiName = (apiName: string): boolean =>
  STANDARD_OBJECT_API_NAMES.has(apiName);

/**
 * The component types `sfi.list_components` accepts. Mirrors the
 * `ComponentType` union in `@sf-intelligence/contracts`; declared inline so
 * Zod can validate against a real enum rather than `z.string()` (clients
 * with a typo learn `invalid-query` instead of receiving `{ components: [] }`
 * and concluding the org has nothing of that type).
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
  // v1.1 — sharing & visibility tier. Order matches the contracts union
  // so a future automated comparison can be a textual diff.
  'Group',
  'Queue',
  'Role',
  'SharingRule',
  // v1.2 — record types + UI surfaces tier. Order matches the contracts
  // union for the same reason.
  'RecordType',
  'BusinessProcess',
  'CustomTab',
  'CustomApplication',
  'QuickAction',
  'PathAssistant',
  'GlobalValueSet',
  'CustomLabel',
  'StaticResource',
  // v1.3 — legacy automation + communications tier. Order matches the
  // contracts union for the same reason.
  'WorkflowRule',
  'ApprovalProcess',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  'DuplicateRule',
  'MatchingRule',
  'EmailTemplate',
  'Letterhead',
  // v1.4 — developer frontend + test mapping tier. Order matches the
  // contracts union for the same reason.
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  // v1.5 — integration topology + event/async/API surface tier. Order
  // matches the contracts union for the same reason.
  'AuthProvider',
  'RemoteSiteSetting',
  'CspTrustedSite',
  'ExternalDataSource',
  'ExternalService',
  'NetworkAccess',
  // v1.6 — business-user record-value tier. Order matches the contracts
  // union for the same reason.
  'CustomMetadataRecord',
  'CustomSettingRecord',
  // v2.0a — conditional-context tier. Synthetic; emitted by the seven
  // declarative firer extractors. Order matches the contracts union.
  'ConditionalContext',
  // v2.8 — async + integration deep tier. Promoted from dangling-by-
  // design v1.3 references. Order matches the contracts union.
  'OutboundMessage',
  // v3.2 — OmniStudio and decision-table tier.
  'OmniScript',
  'OmniIntegrationProcedure',
  'OmniDataTransform',
  'OmniUiCard',
  'DecisionTable',
  // v4.0 — enterprise safety coverage tier.
  'Report',
  'Dashboard',
  'ListView',
  'ReportType',
  'FlexiPage',
  'PermissionSetGroup',
  'MutingPermissionSet',
  'RestrictionRule',
  'ScopingRule',
  // v4.x — decomposed CustomObject child metadata. Order matches the
  // contracts union for the same reason.
  'CompactLayout',
  'WebLink',
  'FieldSet',
  'Index',
  'InstalledPackage',
] as const satisfies readonly ComponentType[];

/** Cap mirrored from `graph.listNodesByType`. */
const LIST_MAX_LIMIT = 500;

/** Default page size when the caller omits `limit`. */
const LIST_DEFAULT_LIMIT = 50;

/**
 * Serialized-payload budget for the returned `components` array, in bytes.
 * Sits below the global `MAX_RESPONSE_BYTES` (~45 KB) dispatch guard with
 * headroom for the envelope, `vaultState`, and the pagination fields, so a
 * full-`Node` page can NEVER trip that guard (which rejects the whole result
 * outright and hands the caller an opaque failure). When a page would exceed
 * this budget the handler returns the largest id-ordered prefix that fits and
 * sets `hasMore`.
 */
const LIST_PAYLOAD_BUDGET_BYTES = 38_000;

/**
 * Trim a node page to the largest id-ordered prefix whose serialized size fits
 * `budgetBytes`. `Node` rows vary widely in size (an ApexClass node is ~1.5 KB,
 * a CustomObject ~0.7 KB), so a fixed row-count cap cannot bound the payload —
 * only a byte budget can. Always keeps at least one row; if a single row is
 * itself larger than the whole budget it is returned identity-only (properties
 * dropped) so the enumeration still answers instead of tripping the guard.
 */
const fitNodesToBudget = (
  nodes: readonly Node[],
  budgetBytes: number,
): { readonly kept: readonly Node[]; readonly trimmed: boolean } => {
  const kept: Node[] = [];
  let used = 0;
  for (const node of nodes) {
    // +1 approximates the `,` separator between serialized array elements.
    const size = Buffer.byteLength(JSON.stringify(node), 'utf8') + 1;
    if (kept.length === 0 && size > budgetBytes) {
      kept.push({ ...node, properties: {} });
      return { kept, trimmed: nodes.length > 1 };
    }
    if (kept.length > 0 && used + size > budgetBytes) {
      return { kept, trimmed: true };
    }
    kept.push(node);
    used += size;
  }
  return { kept, trimmed: false };
};

/**
 * Zod schema for the `sfi.list_components` tool input.
 *
 *   - `type`: required for v0.1, must be a known `ComponentType`.
 *   - `parentId`: optional; narrows to children of one parent node.
 *   - `limit`: integer in [1, 500]; defaults to 50 in the handler.
 *   - `offset`: non-negative integer; defaults to 0 in the handler.
 */
/**
 * The v1.5 ApexClass async/interface/API boolean classifiers a caller can
 * filter on (P4-interface-impl). Each maps 1:1 to a `properties.<key>` boolean
 * the apex-class extractor populates, so a query like
 * `{ type: 'ApexClass', isBatchable: true }` lists every Batchable implementer.
 * The keys are a fixed allowlist — only these reach the graph's JSON filter.
 */
export const APEX_BOOLEAN_FILTERS = [
  'isQueueable',
  'isSchedulable',
  'isBatchable',
  'isRestResource',
  'hasFutureMethod',
  'hasInvocableMethod',
  'hasAuraEnabledMethod',
  'isTest',
] as const;

/**
 * An optional boolean that also accepts the strings `"true"` / `"false"`.
 * MCP hosts frequently stringify scalar arguments (especially when a client's
 * cached tool schema predates a new param), so a bare `z.boolean()` rejects a
 * perfectly valid `isBatchable: "true"`. The preprocess coerces only those two
 * literals; any other string still fails `z.boolean()`.
 */
const coercedOptionalBoolean = z
  .preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean(),
  )
  .optional();

export const listComponentsInputSchema = z.object({
  type: z.enum(COMPONENT_TYPES).optional(),
  parentId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor from a prior page's nextCursor. `o` already IS the
  // SQL offset (list_components pages listNodesByType directly), so this is a
  // SINGLE-axis cursor — no separate scan offset.
  cursor: z.string().min(1).optional(),
  // P4-interface-impl boolean filters (ApexClass only). String-coercing so a
  // host that stringifies the arg still works.
  isQueueable: coercedOptionalBoolean,
  isSchedulable: coercedOptionalBoolean,
  isBatchable: coercedOptionalBoolean,
  isRestResource: coercedOptionalBoolean,
  hasFutureMethod: coercedOptionalBoolean,
  hasInvocableMethod: coercedOptionalBoolean,
  hasAuraEnabledMethod: coercedOptionalBoolean,
  isTest: coercedOptionalBoolean,
});

/** Parsed input shape, inferred from `listComponentsInputSchema`. */
export type ListComponentsInput = z.infer<typeof listComponentsInputSchema>;

/**
 * Payload wrapped inside the `McpResponse` envelope on success.
 *
 *   - `components`: the page of nodes matching the filter, sorted by id.
 *   - `limit`: the actual limit applied (the Zod input default or the
 *     caller's value).
 *   - `offset`: the actual offset applied.
 *   - `hasMore`: heuristic — true when `components.length === limit`. A
 *     follow-up page may still come back empty; the client should treat
 *     this as a hint, not a guarantee. v0.2 will add a true `total` count.
 */
export interface ListComponentsOutput {
  readonly components: readonly Node[];
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  /**
   * B-GRAPH-BUILD: the TRUE total count of matching nodes in the graph, from
   * `countNodesByType` — always present, regardless of pagination. A caller that
   * needs the org-wide count for a type MUST read this field rather than
   * `components.length`, which is bounded by `limit` and further trimmed by the
   * byte-budget guard (`fitNodesToBudget`) to ~38 KB per page. For example,
   * `list_components(type='FlexiPage')` with the default limit=50 returns 39 nodes
   * in `components` (payload budget exhausted) but `totalCount: 86` — the
   * authoritative vault count. With a `parentId` or property filter the count
   * reflects the same narrow, so it is always exact for the given filter.
   */
  readonly totalCount: number;
  /** True only when the page was trimmed to fit the response-size budget. */
  readonly truncated?: boolean;
  /** Human-readable note describing the trim; present only when `truncated`. */
  readonly note?: string;
  /**
   * Set only when the FIRST page came back empty (FRESH-02). Distinguishes
   * "none in the org" (the type was retrieved, nothing found) from "not
   * retrieved" (the last refresh skipped this type) and "not modeled" — so an
   * empty list is never a silent `[]` the caller misreads as "the org has none".
   */
  readonly retrievalHint?: string;
  /**
   * Present when manifest coverage for `type` is not `complete` (scoped refresh,
   * errored retrieve, or not modeled). Surfaces on every page so a non-empty
   * inventory is never read as authoritative when the vault is partial.
   */
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * CR-22 opaque continuation token, present ONLY when more rows remain past
   * this page (over `limit` OR byte-trimmed). Echo it back as `cursor` to
   * resume. Absent on a final page so an in-budget response is byte-identical
   * to pre-CR-22.
   */
  readonly nextCursor?: string;
  /**
   * Cursor-aware pagination metadata, present ONLY when `nextCursor` is. Carries
   * the TRUE `totalCount` (from countNodesByType) — but ONLY for the unfiltered
   * `{type}` case; with a `parentId` or property filter the filtered total is
   * also exact (countNodesByType applies the same WHERE narrows). `returnedCount`
   * is this page's size; `hasMore` mirrors the legacy `hasMore`.
   */
  readonly pageInfo?: PageInfo;
  /**
   * Present ONLY for `type: 'CustomField'`. The TRUE count of formula (computed)
   * fields across the whole `{type}` (and `parentId` narrow), from
   * `countNodesByType({ isFormula: true })` — NOT a per-page tally, so it is
   * authoritative regardless of pagination. In DX-source format a formula field
   * carries its RETURN type (Text, Number, Checkbox, …) in `<type>`, never the
   * literal `'Formula'`, so a caller grouping by `dataType` alone would conclude
   * "No Formula fields were found"; this count makes the computed-vs-stored split
   * explicit (per-field, `properties.isFormula === true` flags the same fields).
   */
  readonly formulaFieldCount?: number;
}

/**
 * The `sfi.list_components` MCP tool. Returns a paginated slice of vault
 * nodes of a single `ComponentType`, optionally narrowed by `parentId`.
 * Input is already Zod-validated by `dispatchTool`; this handler enforces
 * the v0.1 "type is required" invariant and surfaces graph failures as
 * `internal` errors.
 *
 * @example
 *   const r = await listComponentsHandler(ctx, {
 *     type: 'CustomField',
 *     parentId: 'CustomObject:Account',
 *     limit: 25,
 *   });
 *   if (r.ok) console.log(r.value.data.components.length);
 */
export const listComponentsHandler = async (
  ctx: Context,
  input: ListComponentsInput,
): Promise<Result<McpResponse<ListComponentsOutput>, McpError>> => {
  // v0.1 keeps the "list all node types" mode off the table; the graph
  // query requires a type and the surface area for a list-all is large
  // enough that it belongs to v0.2 along with COUNT(*) support.
  if (input.type === undefined) {
    return err({
      kind: 'invalid-query',
      message: 'type is required for v0.1',
    });
  }

  const limit = input.limit ?? LIST_DEFAULT_LIMIT;

  // CR-22: the narrowing args this cursor binds to (everything except the paging
  // knobs limit/offset/cursor). A token can't be replayed against a different
  // type / parentId / property filter.
  const fingerprint = argsFingerprint({
    type: input.type,
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    ...Object.fromEntries(
      APEX_BOOLEAN_FILTERS.flatMap((k) =>
        input[k] !== undefined ? [[k, input[k]]] : [],
      ),
    ),
  });

  // Resolve the effective offset: an echoed cursor wins over an explicit offset.
  // `o` already IS the SQL offset (this handler pages listNodesByType directly),
  // so a resumed cursor reaches node 501+ natively — no separate scan axis.
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: LIST_COMPONENTS_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // P4-interface-impl: collect whichever async/interface boolean filters were
  // supplied into a single propertyEquals map for the DB-layer JSON filter.
  const propertyEquals: Record<string, boolean> = {};
  for (const key of APEX_BOOLEAN_FILTERS) {
    const v = input[key];
    if (v !== undefined) propertyEquals[key] = v;
  }
  const hasPropertyFilter = Object.keys(propertyEquals).length > 0;

  const queryResult = await listNodesByType(ctx.graph, input.type, {
    limit,
    offset,
    ...(input.parentId !== undefined
      ? { parentId: input.parentId as ComponentId }
      : {}),
    ...(hasPropertyFilter ? { propertyEquals } : {}),
  });

  if (!queryResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${queryResult.error.message}`,
    });
  }

  // Bound the serialized payload so a full-`Node` page can never trip the
  // global response-size guard (which would reject the whole result outright).
  // When the page is too large to serialize under budget, return the largest
  // id-ordered prefix that fits and flag `hasMore` so the caller can page on.
  const { kept, trimmed } = fitNodesToBudget(
    queryResult.value,
    LIST_PAYLOAD_BUDGET_BYTES,
  );

  // `hasMore` is a hint: a full page (length === limit) may have more rows
  // behind it, and a budget-trimmed page definitely does. A partial page that
  // was NOT trimmed is authoritative proof of end-of-list.
  const hasMore = queryResult.value.length === limit || trimmed;

  // FRESH-02: an empty first page is ambiguous — none in the org, or never
  // retrieved? Use coverage to say which, so the caller never reads a silent
  // `[]` as "the org has none of these".
  let retrievalHint: string | undefined;
  // Skip the coverage hint when a property filter is active: an empty result
  // means "no component matched the filter", NOT a type-coverage gap.
  if (offset === 0 && queryResult.value.length === 0 && !hasPropertyFilter) {
    const cov = summarizeCoverage(ctx.manifest, [input.type]);
    if (cov.notModeledTypes.includes(input.type)) {
      retrievalHint =
        `No \`${input.type}\` in the vault — this type is NOT modeled by the current build, so its absence means "not analyzed", never "none in the org".`;
    } else if (cov.missingCoverage.includes(input.type)) {
      retrievalHint =
        `No \`${input.type}\` retrieved into this vault — the last refresh did not pull this type (a scoped, errored, or empty retrieve that returned zero rows). A requested-but-empty retrieve is byte-identical to "the org has none", so this is reported as "not retrieved", not proof of absence. Run \`/sfi-refresh\` (widen \`--types\` to include ${input.type}) before concluding the org has none.`;
    } else {
      const parentApi =
        input.parentId !== undefined ? objectApiNameFromParentId(input.parentId) : null;
      if (
        input.type === 'CustomField' &&
        parentApi !== null &&
        isStandardObjectApiName(parentApi)
      ) {
        retrievalHint =
          `No \`CustomField\` rows for \`CustomObject:${parentApi}\` in this vault — standard-object field inventory is often incomplete (uncustomized standard fields are not emitted as \`.field-meta.xml\`). This is NOT proof the org has no fields on ${parentApi}; use describe-backed refresh overlay or the live plane.`;
      } else {
        retrievalHint =
          `The last refresh retrieved \`${input.type}\` and found none — this is "none in the org", not "not retrieved".`;
      }
    }
  }

  const coverageCaveat = buildEnumerationCoverageCaveat(ctx, input.type);

  // Formula-field classification (CustomField only). A formula field encodes its
  // RETURN type (Text, Number, Checkbox, …) in `<type>`, never the literal
  // `'Formula'`, so a caller that groups a CustomField listing by `dataType`
  // alone wrongly concludes "No Formula fields were found". Surface the TRUE
  // computed-field count over the whole `{type}` (and `parentId`) narrow — NOT
  // a per-page tally — via the derived `isFormula` property the extractor emits.
  // Only added when the type is CustomField and no property filter is active
  // (the boolean filters are ApexClass-only). A count failure is non-fatal: the
  // enumeration still answers, just without the breakdown.
  let formulaFieldCount: number | undefined;
  if (input.type === 'CustomField' && !hasPropertyFilter) {
    const formulaRes = await countNodesByType(ctx.graph, input.type, {
      ...(input.parentId !== undefined ? { parentId: input.parentId as ComponentId } : {}),
      propertyEquals: { isFormula: true },
    });
    if (formulaRes.ok) formulaFieldCount = formulaRes.value;
  }

  // B-GRAPH-BUILD: always fetch the TRUE total count via countNodesByType,
  // applying the SAME narrows as the page query. This is the authoritative
  // vault count for the given type (and optional parentId / property filter)
  // and is always emitted as `totalCount` at the top level of the response —
  // even on the first page, even when the page was NOT trimmed.
  //
  // Rationale: `components.length` is bounded by `limit` (default 50) and
  // further trimmed by `fitNodesToBudget` (~38 KB per page). For types with
  // large nodes (e.g. FlexiPage with many fieldRefs), the budget is exhausted
  // at ~39 nodes even though the org has 86. A cascade that reads
  // `components.length` for a count question reports 39, not 86. The top-level
  // `totalCount` is the only field that is always correct regardless of page
  // size, trimming, or pagination. If the count query fails, fall back to a
  // lower bound (offset + kept.length) rather than failing the whole
  // enumeration.
  const totalRes = await countNodesByType(ctx.graph, input.type, {
    ...(input.parentId !== undefined ? { parentId: input.parentId as ComponentId } : {}),
    ...(hasPropertyFilter ? { propertyEquals } : {}),
  });
  const totalCount = totalRes.ok ? totalRes.value : offset + kept.length;

  // CR-22: emit a continuation cursor ONLY when more rows remain (over `limit`
  // OR byte-trimmed). The next offset is `offset + kept.length` — `o` IS the SQL
  // offset, so the resumed page SQL-scans deeper (reaches node 501+ natively).
  // A final page omits nextCursor/pageInfo, so an in-budget response is
  // byte-identical to pre-CR-22 (except for the new top-level `totalCount`).
  let cursorFields: { readonly nextCursor: string; readonly pageInfo: PageInfo } | undefined;
  if (hasMore) {
    const nextOffset = offset + kept.length;
    const nextCursor = encodeCursor({
      v: PAGE_CURSOR_VERSION,
      t: LIST_COMPONENTS_TOOL,
      h: ctx.manifest.sourceTreeHash,
      o: nextOffset,
      ...(kept.length > 0 ? { k: (kept[kept.length - 1] as Node).id } : {}),
      q: fingerprint,
    });
    cursorFields = {
      nextCursor,
      pageInfo: {
        totalCount,
        returnedCount: kept.length,
        hasMore: true,
        nextCursor,
      },
    };
  }

  return ok({
    data: {
      components: kept,
      totalCount,
      limit,
      offset,
      hasMore,
      ...(retrievalHint !== undefined ? { retrievalHint } : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(formulaFieldCount !== undefined ? { formulaFieldCount } : {}),
      ...(trimmed
        ? {
            truncated: true as const,
            note:
              `Response trimmed to ${kept.length} of ${queryResult.value.length} ` +
              `fetched rows to stay under the ~45 KB MCP response limit. Use ` +
              `totalCount (${totalCount}) for the authoritative vault count; advance ` +
              `with offset += ${kept.length} (or narrow via parentId) for the rest.`,
          }
        : {}),
      ...(cursorFields !== undefined ? cursorFields : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
