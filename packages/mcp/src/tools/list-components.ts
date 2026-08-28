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
import {
  buildCoverageEntries,
  type ExtendedVaultManifest,
  summarizeCoverage,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { listValidationRuleDocsForParent } from './component-doc-fallback.js';
import { buildEnumerationCoverageCaveat, type CoverageCaveat } from './coverage-trust.js';
import { resolveExistingObjectScope, toCustomObjectId } from './input-aliases.js';
import { argsFingerprint, decodeCursor, encodeCursor, PAGE_CURSOR_VERSION } from './page-cursor.js';

const LIST_COMPONENTS_TOOL = 'sfi.list_components';

/**
 * LIST-COMPONENTS-PENDING-READ-AS-NEVER-PULLED.
 *
 * The folder-based analytics families. The default refresh DOES pull them
 * (usage-ranked and capped — `manifest.reportsCap` records org total vs
 * requested vs landed) but folds what it read onto the CustomField nodes the
 * reports reference (`properties.usedInReport` / `usedInDashboard`) instead of
 * minting `Report` / `Dashboard` NODES, and marks the coverage row `pending`.
 *
 * The bug this closes: an empty page for a `pending` type fell into the
 * `missingCoverage` branch and told the user "the last refresh did not pull
 * this type … widen `--types`" — false on both halves. The refresh pulled
 * hundreds of reports (which is exactly why `field_360` and
 * `safe_to_delete_field` correctly answer `usedInReport: true` on the same
 * vault), and `--types` is not the lever: the uncapped pull is
 * `sfi refresh --with-reports` (see `report-dashboard-usage.ts`).
 *
 * `coverage_report` already models the distinction with its own `pending[]`
 * bucket; this is that bucket, read here.
 */
const FOLDED_ANALYTICS_TYPES: Readonly<Record<string, 'reports' | 'dashboards'>> =
  Object.freeze({ Report: 'reports', Dashboard: 'dashboards' });

/** The remedy flag that actually mints nodes for a given type. */
const refreshRemedyFor = (type: string): string =>
  type in FOLDED_ANALYTICS_TYPES
    ? '`/sfi-refresh` with `sfi refresh --with-reports` (the uncapped folder pull; `--types` is NOT the lever for folder-based analytics — the default pull is usage-ranked and capped)'
    : `\`/sfi-refresh\` (widen \`--types\` to include ${type})`;

/**
 * The honest hint for a `pending` coverage row whose page came back empty:
 * retrieved-but-not-noded, NOT never-pulled. Every number is read off the
 * manifest — when `reportsCap` is absent the sentence says the pull volume is
 * unknown rather than inventing one.
 */
const pendingRetrievalHint = (
  manifest: ExtendedVaultManifest,
  type: string,
  retrievedRows: number,
): string => {
  const capKey = FOLDED_ANALYTICS_TYPES[type];
  const cap = capKey === undefined ? undefined : manifest.reportsCap?.[capKey];
  const volume =
    cap === undefined
      ? `The manifest records no pull volume for this type, so how much was read CANNOT be stated from this vault.`
      : `\`manifest.reportsCap.${capKey}\` records ${cap.retrieved} member(s) landed` +
        `${cap.requested === undefined ? '' : ` of ${cap.requested} requested`}` +
        ` against an org total of ${cap.total}.`;
  const folded =
    capKey === undefined
      ? ''
      : ` What it read was FOLDED onto the CustomField nodes those ${capKey} reference (\`properties.usedInReport\` / \`usedInDashboard\`) rather than minted as \`${type}\` nodes — which is why \`sfi.field_360\` and \`sfi.safe_to_delete_field\` can still report report/dashboard usage on a vault this enumeration finds empty.`;
  const rows =
    retrievedRows > 0
      ? ` The coverage row itself records ${retrievedRows} retrieved member(s).`
      : '';
  return (
    `No \`${type}\` NODES in this vault — but the last refresh DID retrieve this type: its coverage row is \`pending\` (requested, retrieved, and not turned into nodes), which is a BUILD outcome, not a retrieve gap. ` +
    `${volume}${rows}${folded} ` +
    `So absence here is "not enumerable from this vault", never proof the org has none. To mint \`${type}\` nodes run ${refreshRemedyFor(type)}.`
  );
};

const STANDARD_OBJECT_API_NAMES = new Set<string>(STANDARD_OBJECT_FIELD_SNAPSHOT);

/** Standard/custom object apiName from a `CustomObject:…` parent id. */
const objectApiNameFromParentId = (parentId: string): string | null =>
  parentId.startsWith('CustomObject:') ? parentId.slice('CustomObject:'.length) : null;

/** Metadata API retrieve rarely emits full standard-object field inventories. */
const isStandardObjectApiName = (apiName: string): boolean =>
  STANDARD_OBJECT_API_NAMES.has(apiName);

/**
 * The component types `sfi.list_components` accepts. This is the FULL
 * `ComponentType` set from `@sf-intelligence/contracts` — declared inline so
 * Zod can validate against a real enum rather than `z.string()` (clients with a
 * typo learn `invalid-query` instead of receiving `{ components: [] }` and
 * concluding the org has nothing of that type).
 *
 * LIST-COMPONENTS-ENUM-OMITS-RETRIEVED-TYPES: this array is the single source
 * of truth for the accepted `type` set — the advertised JSON Schema in
 * `roster.ts` spreads it, so the two can never advertise different sets. It had
 * silently drifted BEHIND the `ComponentType` union (missing `SamlSsoConfig`,
 * `Skill`, `ServiceChannel`, `Network`, `CustomSite`, the Bot / OmniStudio /
 * CPQ / GenAI / Wave tiers, …), so nodes those extractors retrieved and modeled
 * into the graph were rejected at the Zod boundary — an architect could not
 * `list_components { type: 'SamlSsoConfig' }` even with three configs vaulted.
 * The `satisfies` below proves every entry IS a `ComponentType`; the
 * {@link ComponentTypesComplete} guard proves every `ComponentType` IS listed,
 * so a new type added to the contracts union can never again ship retrievable
 * but unlistable — the build fails until it is added here. Order mirrors the
 * contracts union so a drift check can stay a textual diff.
 */
export const COMPONENT_TYPES = [
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
  // v1.1 — sharing & visibility tier.
  'Group',
  'Queue',
  'Role',
  'SharingRule',
  // v1.2 — record types + UI surfaces tier.
  'RecordType',
  'BusinessProcess',
  'CustomTab',
  'CustomApplication',
  'QuickAction',
  'PathAssistant',
  'GlobalValueSet',
  'CustomLabel',
  'StaticResource',
  // v1.3 — legacy automation + communications tier.
  'WorkflowRule',
  'ApprovalProcess',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  'DuplicateRule',
  'MatchingRule',
  'EmailTemplate',
  'Letterhead',
  // v1.4 — developer frontend + test mapping tier.
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  // v1.5 — integration topology + event/async/API surface tier.
  'AuthProvider',
  'SamlSsoConfig',
  'RemoteSiteSetting',
  'CspTrustedSite',
  'ExternalDataSource',
  'ExternalService',
  'NetworkAccess',
  // v1.6 — declarative custom-permission definition (CR-CAP-15) +
  // business-user record-value tier.
  'CustomPermission',
  'CustomMetadataRecord',
  'CustomSettingRecord',
  // v2.0a — conditional-context tier. Synthetic; emitted by the seven
  // declarative firer extractors.
  'ConditionalContext',
  // v2.8 — async + integration deep tier. Promoted from dangling-by-
  // design v1.3 references.
  'OutboundMessage',
  // v2.9 — WorkflowAlert promotion (email alerts inside *.workflow-meta.xml).
  'WorkflowAlert',
  // v2.6a — CPQ specialist tier (SBQQ__ namespace recognition).
  'CpqProductRule',
  'CpqPriceRule',
  'CpqQuoteTemplate',
  'CpqLookupQuery',
  'CpqConfigurationAttribute',
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
  // v4.x — decomposed CustomObject child metadata.
  'CompactLayout',
  'WebLink',
  'FieldSet',
  'Index',
  'InstalledPackage',
  // CR-CAP-18 — platform-event publish/stream-routing topology.
  'PlatformEventChannel',
  'PlatformEventChannelMember',
  // Org security-settings + standard-picklist tiers. One source file
  // (`settings/Security.settings-meta.xml`) produces BOTH security singletons.
  'SessionSettings',
  'SecuritySettings',
  'StandardValueSet',
  // R6-18 — Service Cloud entitlement/SLA + Omni-Channel routing tier.
  'EntitlementProcess',
  'MilestoneType',
  'ServiceChannel',
  'QueueRoutingConfig',
  // R6-22 — security-surface tier.
  'Certificate',
  'TransactionSecurityPolicy',
  // R6-13 — Agentforce / Einstein GenAI tier.
  'GenAiFunction',
  'GenAiPlugin',
  'GenAiPlannerBundle',
  'GenAiPromptTemplate',
  // R6-17 — Experience Cloud community tier.
  'Network',
  'CustomSite',
  'ExperienceBundle',
  // R7-C7 — Bot / presence extraction leftovers.
  'Bot',
  'BotVersion',
  'PresenceUserConfig',
  // Field Service tier.
  'FieldServiceSettings',
  'Skill',
  'TimeSheetTemplate',
  // CRM Analytics (Wave / Tableau CRM) slice.
  'WaveDashboard',
  'WaveDataflow',
  'WaveXmd',
  // Experience Cloud / portal record-access tier (user-field-to-record-field
  // matching that grants portal users records without a sharing rule).
  'SharingSet',
] as const satisfies readonly ComponentType[];

/**
 * LIST-COMPONENTS-ENUM-OMITS-RETRIEVED-TYPES compile-time completeness guard for
 * {@link COMPONENT_TYPES}: resolves to `true` only when every `ComponentType` is
 * listed above; a missing member resolves it to a tuple naming the gap, which
 * breaks the `= true` assignment and fails the build. Paired with the
 * `satisfies` above, this makes `COMPONENT_TYPES` and `ComponentType` provably
 * the same set — the roster-drift that let retrieved types (SamlSsoConfig,
 * Skill, ServiceChannel, …) be rejected as `invalid-query` can no longer recur:
 * the next unlisted type addition is a compile error, not a silent capability
 * gap. Mirrors the `EdgeTypesComplete` guard in `@sf-intelligence/contracts`.
 */
type ComponentTypesComplete =
  Exclude<ComponentType, (typeof COMPONENT_TYPES)[number]> extends never
    ? true
    : ['ComponentType(s) missing from COMPONENT_TYPES:', Exclude<ComponentType, (typeof COMPONENT_TYPES)[number]>];
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time-only completeness assertion
const componentTypesComplete: ComponentTypesComplete = true;

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
/**
 * Per-item size threshold above which a node's bulky properties are slimmed
 * for LIST output. Profile / PermissionSet nodes carry tens of KB of
 * declarative grants (`userPermissions`, `fieldPermissions`,
 * `recordTypeVisibilities`, …) in `properties`; shipping those verbatim means
 * ONE profile exhausts the whole page budget, so a 59-profile org listed 1
 * profile per page (the "1 of 59" bug). An enumeration needs identity plus
 * scalar flags — not the full grant dump — so scalar properties (booleans /
 * numbers / short strings, e.g. `isFormula`, `isBatchable`, `status`) are
 * preserved, bulky arrays / objects / long strings are dropped, and
 * `propertiesTruncated: true` marks the slimming so a caller knows to fetch
 * `get_component` for the full detail.
 */
const ITEM_SLIM_THRESHOLD_BYTES = 2_048;

/** Longest string property value the slimmed projection keeps verbatim. */
const SLIM_STRING_MAX_CHARS = 256;

const slimOversizedNode = (node: Node): Node => {
  if (Buffer.byteLength(JSON.stringify(node), 'utf8') <= ITEM_SLIM_THRESHOLD_BYTES) {
    return node;
  }
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.properties ?? {})) {
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      (typeof value === 'string' && value.length <= SLIM_STRING_MAX_CHARS)
    ) {
      compact[key] = value;
    }
  }
  compact['propertiesTruncated'] = true;
  return { ...node, properties: compact };
};

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

/**
 * LIST-COMPONENTS-SILENTLY-DROPS-OBJECT-SCOPE — the refusal message for an
 * argument this tool does not accept.
 *
 * Product copy, byte-for-byte the sentence `sfi.what_happens_on_save`,
 * `sfi.order_of_execution` and `sfi.lifecycle_process` already state. It is the
 * doctrine half of this fix: a scope-shaped argument that reaches a tool with no
 * key for it used to be stripped by Zod and the org-wide answer returned as
 * though it were the scoped one.
 *
 * The accepted-key list is DERIVED from the shape below rather than hand-listed
 * (the three sibling tools each maintain a second copy of their own key tuple,
 * which is free to drift from the shape it describes; this one cannot).
 */
const strictKeyErrorMap =
  (accepted: readonly string[]): z.ZodErrorMap =>
  (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return {
        message: `Unknown argument '${issue.keys.join("', '")}'. This tool accepts: ${accepted.join(', ')}. Refusing rather than ignoring it — a silently-dropped argument returns a confident answer to a question you did not ask.`,
      };
    }
    return { message: ctx.defaultError };
  };

const listComponentsShape = {
  type: z.enum(COMPONENT_TYPES).optional(),
  parentId: z.string().min(1).optional(),
  /**
   * LIST-COMPONENTS-SILENTLY-DROPS-OBJECT-SCOPE. `objectApiName` is the
   * canonical object-scope key across the rest of the product, so it is exactly
   * what a host LLM passes to narrow an enumeration to one object — and it was
   * not a key here, so Zod stripped it and the ORG-WIDE list came back
   * certified with a scoped `totalCount`. Resolved through the shared
   * `resolveExistingObjectScope`, which VERIFIES the object exists in the vault
   * (a typo is refused, not answered org-wide) and corrects its casing
   * (Salesforce api names are case-insensitive). The narrow it applies is
   * `parentId = CustomObject:<resolved>`; the applied id is echoed as
   * `appliedScope`.
   */
  // `.trim()` runs BEFORE `.min(1)`: `min` measures the RAW string, so a
  // whitespace-only scope (`'   '`) would clear a bare `.min(1)`, then get
  // trimmed to nothing downstream and resolve to NO scope — returning the
  // ORG-WIDE list under a scoped question. That is this tool's own defect
  // surviving on a degenerate input, so the scope keys are refused, not widened.
  objectApiName: z.string().trim().min(1).optional(),
  /** `objectApiName` alias — same resolver, same narrow. */
  object: z.string().trim().min(1).optional(),
  /** `objectApiName` alias — same resolver, same narrow. */
  objectId: z.string().trim().min(1).optional(),
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
  /** Flow metadata: exact match on `properties.triggerObject`. */
  triggerObject: z.string().min(1).optional(),
  /** Flow metadata: exact match on `properties.status` (e.g. Active). */
  status: z.string().min(1).optional(),
  /** Flow metadata: keep only record-triggered flows (`triggerType` starts with Record). */
  recordTriggered: coercedOptionalBoolean,
  /**
   * Keep only components that LACK a description — `properties.description` is
   * absent, null, or empty. Answers "which reports/objects/permission-sets have
   * no description". Only trustworthy for a type whose extractor captures
   * description; a type that carries no `<description>` in Salesforce source
   * (ListView, CustomPermission, MutingPermissionSet, CustomMetadata records)
   * will match ALL of its nodes — that means "this type has no description in
   * source", not "the org failed to fill them in".
   */
  missingDescription: coercedOptionalBoolean,
  /** Keep only components that HAVE a non-empty `properties.description`. */
  hasDescription: coercedOptionalBoolean,
};

export const listComponentsInputSchema = z
  .object(listComponentsShape, {
    errorMap: strictKeyErrorMap(Object.keys(listComponentsShape)),
  })
  .strict();

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
   * Present (always `true`) when at least one row on this page was slimmed to
   * scalar properties — bulky arrays/objects dropped, the row itself marked
   * `properties.propertiesTruncated: true`. Grant-heavy types (Profile,
   * PermissionSet) carry tens of KB of declarative grants per node; shipping
   * those verbatim meant ONE row exhausted the ~38 KB page budget and a
   * 59-profile org listed 1 profile per page (the "1 of 59" bug). Distinct
   * from `truncated` (rows DROPPED from the page): a slimmed page still
   * contains every row. Fetch `get_component` for a slimmed row's full detail.
   */
  readonly propertiesSlimmed?: true;
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
  /**
   * LIST-COMPONENTS-SILENTLY-DROPS-OBJECT-SCOPE. Present ONLY when the caller
   * named an object (`objectApiName` / `object` / `objectId`) and it resolved.
   * `componentId` is the id the narrow was actually applied with — the VAULT's
   * exact casing, which may differ from what was passed (`resolvedFrom` records
   * the caller's spelling when it did). A bare, unscoped call omits the key
   * entirely, so a caller can always tell a scoped answer from an org-wide one
   * rather than having to trust that its argument was honored.
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly componentId: string;
    /** The mechanism: an object scope becomes a `nodes.parent_id` narrow. */
    readonly narrowedBy: 'parentId';
    readonly resolvedFrom?: string;
  };
  /**
   * Present ONLY when a parent narrow (explicit `parentId` or a resolved object
   * scope) matched ZERO nodes while the type HAS nodes elsewhere in the vault.
   *
   * The narrow is PARENT-based, and whole metadata families are top-level in
   * the graph — ApexTrigger, ApexClass, Flow, Profile and friends carry no
   * `CustomObject:` parent — so a `CustomObject:` narrow can never match one.
   * The product's own router suggests `{ type: 'ApexTrigger', parentId:
   * 'CustomObject:<X>' }`, and on a real vault that returned an empty list
   * stamped "this is 'none in the org'" for an org holding 22 triggers.
   *
   * This is the TYPED half of that disclosure — `countWithoutParentNarrow` is
   * what the SAME query (every other filter intact) returns with the parent
   * narrow removed, so a machine consumer sees the zero is scoped rather than
   * absolute without having to parse `retrievalHint`.
   */
  readonly scopeCaveat?: {
    readonly parentId: string;
    readonly narrowedBy: 'parentId';
    readonly countWithoutParentNarrow: number;
    /** Always `true`: the zero above is a PARENT-scoped zero, not an org-wide one. */
    readonly parentScopedOnly: true;
  };
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

  // Description-presence filter. `missingDescription` and `hasDescription` are
  // mutually exclusive — a component cannot both have and lack a description —
  // so reject the contradiction rather than silently picking one (honesty: a
  // caller that asked for both gets told the query is invalid).
  if (input.missingDescription === true && input.hasDescription === true) {
    return err({
      kind: 'invalid-query',
      message:
        'missingDescription and hasDescription are mutually exclusive — pass at most one.',
    });
  }
  const descriptionPresence: 'present' | 'absent' | undefined =
    input.missingDescription === true
      ? 'absent'
      : input.hasDescription === true
        ? 'present'
        : undefined;

  // LIST-COMPONENTS-SILENTLY-DROPS-OBJECT-SCOPE (R4). `objectApiName` /
  // `object` / `objectId` are the canonical object-scope keys everywhere else
  // in the product, so a host narrowing an enumeration to one object passes
  // one of them here. They used to be stripped at the Zod boundary and the
  // ORG-WIDE list came back with a `totalCount` a reader takes for the scoped
  // one. Route them through the SHARED resolver rather than string-templating
  // `CustomObject:${name}`: it VERIFIES the object exists in this vault (a typo
  // is an `invalid-query`, never a confident empty answer), corrects casing
  // (Salesforce api names are case-insensitive), and refuses two selectors that
  // name different objects. A bare call resolves to `null` with no graph
  // round-trip, so the unscoped response shape is untouched.
  const objectScopeResult = await resolveExistingObjectScope(ctx.graph, input);
  if (!objectScopeResult.ok) return err(objectScopeResult.error);
  const objectScope = objectScopeResult.value;
  if (
    objectScope !== null &&
    input.parentId !== undefined &&
    input.parentId !== objectScope.componentId
  ) {
    return err({
      kind: 'invalid-query',
      message:
        `parentId '${input.parentId}' and the object scope '${objectScope.componentId}' name ` +
        'DIFFERENT parents. Refusing rather than picking one — a silently-dropped narrow ' +
        'returns a confident answer to a question you did not ask. Pass exactly one.',
      path: 'parentId',
    });
  }
  // The single parent narrow every branch below reads. `parentId` and a
  // resolved object scope are the SAME axis, so they are folded here once
  // instead of each call site deciding again.
  const effectiveParentId = objectScope?.componentId ?? input.parentId;
  // The caller's own spelling, when the vault spells it differently. Coerced
  // with the shared `toCustomObjectId` so this cannot drift from the resolver's
  // own coercion.
  const suppliedObjectName = input.objectApiName ?? input.object ?? input.objectId;
  const suppliedObjectId =
    suppliedObjectName === undefined ? undefined : toCustomObjectId(suppliedObjectName);
  const appliedScope =
    objectScope === null
      ? undefined
      : {
          object: objectScope.object,
          componentId: objectScope.componentId,
          narrowedBy: 'parentId' as const,
          ...(suppliedObjectId !== undefined && suppliedObjectId !== objectScope.componentId
            ? { resolvedFrom: suppliedObjectId }
            : {}),
        };

  const limit = input.limit ?? LIST_DEFAULT_LIMIT;
  const recordTriggered = input.recordTriggered === true;

  // CR-22: the narrowing args this cursor binds to (everything except the paging
  // knobs limit/offset/cursor). A token can't be replayed against a different
  // type / parentId / property filter.
  const fingerprint = argsFingerprint({
    type: input.type,
    ...(effectiveParentId !== undefined ? { parentId: effectiveParentId } : {}),
    ...(input.triggerObject !== undefined ? { triggerObject: input.triggerObject } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(recordTriggered ? { recordTriggered: true } : {}),
    ...(descriptionPresence !== undefined ? { descriptionPresence } : {}),
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

  const propertyStringEquals: Record<string, string> = {};
  if (input.triggerObject !== undefined) propertyStringEquals.triggerObject = input.triggerObject;
  if (input.status !== undefined) propertyStringEquals.status = input.status;
  const hasStringPropertyFilter = Object.keys(propertyStringEquals).length > 0;

  // Every narrow EXCEPT the parent one. Counting with this is what tells a
  // parent-scoped zero apart from an absolute one, and deriving `graphNarrow`
  // FROM it keeps the two from drifting into "the same filters, nearly".
  const narrowSansParent = {
    ...(hasPropertyFilter ? { propertyEquals } : {}),
    ...(hasStringPropertyFilter ? { propertyStringEquals } : {}),
    ...(recordTriggered ? { recordTriggered: true as const } : {}),
    ...(descriptionPresence !== undefined ? { descriptionPresence } : {}),
  };

  const graphNarrow = {
    ...(effectiveParentId !== undefined
      ? { parentId: effectiveParentId as ComponentId }
      : {}),
    ...narrowSansParent,
  };

  const queryResult = await listNodesByType(ctx.graph, input.type, {
    limit,
    offset,
    ...graphNarrow,
  });

  if (!queryResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${queryResult.error.message}`,
    });
  }

  let pageNodes = queryResult.value;
  let docFallbackNote: string | undefined;
  if (
    pageNodes.length === 0 &&
    offset === 0 &&
    input.type === 'ValidationRule' &&
    effectiveParentId !== undefined
  ) {
    const parentApi = objectApiNameFromParentId(effectiveParentId);
    if (parentApi !== null) {
      const docNodes = await listValidationRuleDocsForParent(ctx.vaultRoot, parentApi, {
        limit,
        offset: 0,
      });
      if (docNodes.length > 0) {
        pageNodes = [...docNodes];
        docFallbackNote =
          'Graph has no ValidationRule nodes for this parent (scoped/partial refresh), but rendered component docs exist on disk — listing those with doc-only confidence; run a full refresh to restore graph edges.';
      }
    }
  }

  // Bound the serialized payload so a full-`Node` page can never trip the
  // global response-size guard (which would reject the whole result outright).
  // Slim each oversized row FIRST: `fitNodesToBudget` measures the FULL
  // serialized node, so a grant-heavy Profile/PermissionSet node (~38 KB of
  // declarative grants in `properties`) exhausted the whole page budget by
  // itself — a 59-profile org listed exactly 1 profile per page (the
  // "1 of 59" bug). Slimming keeps identity + scalar flags per row (marked
  // `propertiesTruncated: true`) so the whole inventory fits one page. When
  // the slimmed page is STILL too large, return the largest id-ordered prefix
  // that fits and flag `hasMore` so the caller can page on.
  const slimmedPageNodes = pageNodes.map(slimOversizedNode);
  const { kept, trimmed } = fitNodesToBudget(
    slimmedPageNodes,
    LIST_PAYLOAD_BUDGET_BYTES,
  );

  // Whether any RETURNED row was slimmed — its per-row `propertiesTruncated:
  // true` marker survives the prefix-trim because slimming runs first. Echoed
  // as a top-level flag so a caller knows to use `get_component` for detail.
  const propertiesSlimmed = kept.some(
    (n) => n.properties?.['propertiesTruncated'] === true,
  );

  // `hasMore` is a hint: a full page (length === limit) may have more rows
  // behind it, and a budget-trimmed page definitely does. A partial page that
  // was NOT trimmed is authoritative proof of end-of-list.
  const hasMore = pageNodes.length === limit || trimmed;

  // FRESH-02: an empty first page is ambiguous — none in the org, or never
  // retrieved? Use coverage to say which, so the caller never reads a silent
  // `[]` as "the org has none of these".
  let retrievalHint: string | undefined;
  // LIST-COMPONENTS-PARENT-NARROW-CERTIFIED-AS-ORG-WIDE. An empty page under a
  // PARENT narrow has two very different causes and the tool used to certify
  // only the wrong one: "this parent has none" versus "this type is not
  // parented by an object at all, so no `CustomObject:` narrow could ever match
  // one of its nodes". Re-running the SAME query with the parent narrow removed
  // separates them exactly. Computed OUTSIDE the coverage guard below — it is a
  // fact about the SCOPE, not about coverage, so a property-filtered scoped
  // zero gets the same disclosure — and only on the empty-page path, so the
  // common case pays nothing.
  //
  // This is not hypothetical: the product's OWN router suggests
  // `{ type: 'ApexTrigger', parentId: 'CustomObject:<X>' }`, ApexTrigger nodes
  // are top-level, and on a real vault that returned `[]` stamped
  // "this is 'none in the org'" for an org holding 22 of them.
  let scopeCaveat: ListComponentsOutput['scopeCaveat'];
  if (offset === 0 && pageNodes.length === 0 && effectiveParentId !== undefined) {
    const sansParent = await countNodesByType(ctx.graph, input.type, narrowSansParent);
    if (sansParent.ok && sansParent.value > 0) {
      scopeCaveat = {
        parentId: effectiveParentId,
        narrowedBy: 'parentId',
        countWithoutParentNarrow: sansParent.value,
        parentScopedOnly: true,
      };
    }
  }
  // LIST-COMPONENTS-SCOPE-PROSE-LOST-TO-PROPERTY-FILTER. The parent-scoped-zero
  // sentence is emitted OUTSIDE the coverage guard for exactly the reason the
  // typed `scopeCaveat` above is: it is a fact about the SCOPE, not about
  // coverage. The coverage guard short-circuits whenever a property /
  // string-property / recordTriggered / description filter is active, so
  // `{type:'Flow', objectApiName:'<X>', status:'Active'}` used to return the
  // typed field with NO prose — and a prose-only host renders prose, so the
  // reader still heard a bare zero. This branch runs ONLY on the filtered path
  // (the guard below owns the unfiltered path unchanged), so precedence is
  // untouched. Deliberately NOT extended to the standard-object CustomField
  // sentence below: that one opens "No CustomField rows for CustomObject:X in
  // this vault", which is FALSE under a property filter — the rows exist, none
  // matched the filter. The scoped-zero sentence says "this same query", which
  // stays true with a filter attached.
  const parentApi =
    effectiveParentId !== undefined
      ? objectApiNameFromParentId(effectiveParentId)
      : null;
  const parentScopedZeroSentence = (): string =>
    `No \`${input.type}\` under \`${effectiveParentId ?? ''}\` — a PARENT-scoped zero, NOT "none in the org": ` +
    `${scopeCaveat?.countWithoutParentNarrow ?? 0} \`${input.type}\` node(s) match this same query in this vault with the parent narrow removed. ` +
    'The narrow matches `nodes.parent_id`, and whole metadata families are TOP-LEVEL in the graph ' +
    '(ApexTrigger, ApexClass, Flow, Profile and friends carry no object parent), so a `CustomObject:` ' +
    'parent can never match one of those no matter which object is named. Re-run without the parent ' +
    'narrow to see them, and reach for the association the type actually has: `triggerObject` for ' +
    'record-triggered Flows, `sfi.what_happens_on_save` / `sfi.object_360` for the automation bound ' +
    'to an object, `sfi.get_edges` for edge-based rather than parent-based association.';
  const hasNonScopeFilter =
    hasPropertyFilter ||
    hasStringPropertyFilter ||
    recordTriggered ||
    descriptionPresence !== undefined;
  if (offset === 0 && pageNodes.length === 0 && hasNonScopeFilter && scopeCaveat !== undefined) {
    retrievalHint = parentScopedZeroSentence();
  }
  // Skip the coverage hint when a property filter is active: an empty result
  // means "no component matched the filter", NOT a type-coverage gap.
  if (
    offset === 0 &&
    pageNodes.length === 0 &&
    !hasNonScopeFilter
  ) {
    const cov = summarizeCoverage(ctx.manifest, [input.type]);
    // LIST-COMPONENTS-PENDING-READ-AS-NEVER-PULLED: read the `pending` row
    // BEFORE the generic missingCoverage branch. `pending` types are folded
    // into `missingCoverage` (correctly — they are not enumerable), but their
    // REASON and their REMEDY are different, and the generic sentence stated
    // both wrongly: it claimed the refresh never pulled the type on a vault
    // whose manifest records hundreds of retrieved members.
    const pendingRow = buildCoverageEntries(ctx.manifest).find(
      (entry) => entry.type === input.type && entry.pending === true,
    );
    // A populated type under an unsatisfiable parent narrow OUTRANKS every
    // coverage sentence below it: `countWithoutParentNarrow > 0` is direct
    // proof the type IS in this vault, which contradicts "not modeled" /
    // "pending" / "not retrieved" outright. The standard-object CustomField
    // branch stays ahead of it — it is the same disclosure with a more
    // specific reason.
    if (
      input.type === 'CustomField' &&
      parentApi !== null &&
      isStandardObjectApiName(parentApi)
    ) {
      retrievalHint =
        `No \`CustomField\` rows for \`CustomObject:${parentApi}\` in this vault — standard-object field inventory is often incomplete (uncustomized standard fields are not emitted as \`.field-meta.xml\`). This is NOT proof the org has no fields on ${parentApi}; use describe-backed refresh overlay or the live plane.`;
    } else if (scopeCaveat !== undefined) {
      retrievalHint = parentScopedZeroSentence();
    } else if (cov.notModeledTypes.includes(input.type)) {
      retrievalHint =
        `No \`${input.type}\` in the vault — this type is NOT modeled by the current build, so its absence means "not analyzed", never "none in the org".`;
    } else if (pendingRow !== undefined) {
      retrievalHint = pendingRetrievalHint(
        ctx.manifest,
        input.type,
        pendingRow.retrieved,
      );
    } else if (cov.missingCoverage.includes(input.type)) {
      retrievalHint =
        `No \`${input.type}\` retrieved into this vault — the last refresh did not pull this type (a scoped, errored, or empty retrieve that returned zero rows). A requested-but-empty retrieve is byte-identical to "the org has none", so this is reported as "not retrieved", not proof of absence. Run ${refreshRemedyFor(input.type)} before concluding the org has none.`;
    } else if (effectiveParentId !== undefined) {
      // Empty narrow, empty type: the type really is absent from the vault, so
      // say that — but never as "none in the org" for the OBJECT, which this
      // query did not measure.
      retrievalHint =
        `No \`${input.type}\` under \`${effectiveParentId}\`, and none anywhere else in this vault either — the last refresh retrieved \`${input.type}\` and found zero. That is "none in the org" for the TYPE; this query measured a parent narrow, so it is not separately proof about that parent.`;
    } else {
      retrievalHint =
        `The last refresh retrieved \`${input.type}\` and found none — this is "none in the org", not "not retrieved".`;
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
      ...(effectiveParentId !== undefined ? { parentId: effectiveParentId as ComponentId } : {}),
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
  const totalRes = await countNodesByType(ctx.graph, input.type, graphNarrow);
  let totalCount = totalRes.ok ? totalRes.value : offset + kept.length;
  if (docFallbackNote !== undefined) {
    totalCount = pageNodes.length;
  }

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
      ...(docFallbackNote !== undefined ? { docFallbackNote } : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(formulaFieldCount !== undefined ? { formulaFieldCount } : {}),
      ...(appliedScope !== undefined ? { appliedScope } : {}),
      ...(scopeCaveat !== undefined ? { scopeCaveat } : {}),
      ...(propertiesSlimmed ? { propertiesSlimmed: true as const } : {}),
      ...(trimmed
        ? {
            truncated: true as const,
            note:
              `Response trimmed to ${kept.length} of ${pageNodes.length} ` +
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
