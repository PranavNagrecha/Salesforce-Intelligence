/**
 * Handler for the `sfi.unused_components` MCP tool.
 *
 * The v2.0b headline tool — the buyer-facing answer to admin #7 on the
 * top-10 questions list: "what's unused in this org?". Composes one
 * per-type `listNodesByType` call followed by a single batched
 * `listEdgesForNodes(... { direction: 'in' })` fetch of every scanned
 * node's incoming edges; instances with zero incoming USAGE edges are
 * classified as unused (`parentOf` structural edges and `grantedBy`
 * access grants do not count — see below).
 *
 * Per-type scope:
 *   - When `types` is omitted, the tool defaults to a curated subset
 *     of node types where "unused" is meaningful (a single test
 *     ApexClass without callers is normal; a Profile without an
 *     assignment is not necessarily unused). The default set is the
 *     `DEFAULT_UNUSED_TYPES` constant below.
 *   - When `types` is supplied, the tool scans exactly that set —
 *     callers wanting a narrow report (e.g. just EmailTemplates) get a
 *     fast, focused answer.
 *
 * Per-instance scope:
 *   - `parentOf` edges from a parent CustomObject (e.g.
 *     `CustomObject:Account -parentOf-> CustomField:Account.Industry__c`)
 *     do NOT count as "in use" — a field that nothing references is
 *     still unused even though its containing object emits a parentOf
 *     edge into it. `grantedBy` edges (Profile / PermissionSet access
 *     grants) likewise do NOT count: access is not usage, so a component
 *     nobody references is unused even when profiles grant access to it
 *     (the same split the dead-code / what-if tools make). The check
 *     skips both `parentOf` and `grantedBy` before counting.
 *   - ApexClass special-case: test classes (`properties.isTest === true`)
 *     are NEVER classified as unused regardless of how many callers they
 *     have. Tests are independently valuable; flagging an uncalled test
 *     as "unused" would be a misleading signal.
 *   - Entry-point special-case: Flows, ApexTriggers, ValidationRules, and
 *     WorkflowRules fire on their own (DML / schedule / platform event) via
 *     OUTGOING `triggersOn` / `firesWhen` edges, so the incoming-edge
 *     heuristic does not apply — a live record-triggered Flow has no inbound
 *     reference yet runs on every matching event. These types are classified
 *     as unused ONLY when their status is inactive (Flow Obsolete/InvalidDraft;
 *     trigger Inactive; validation/workflow rule active=false). This is what
 *     stops the tool reporting every active Flow in the org as "unused".
 *
 * **Unchecked zeros** (UNUSED-UNCHECKED-ZERO-READS-AS-CLEAN): a scanned type
 * with no instances in the vault yields `byType[type] = 0`, byte-identical to
 * "scanned every one, all in use". On a vault whose refresh never retrieved
 * Reports, `sfi.unused_components { types: ['Report'] }` answered
 * `{ byType: { Report: 0 }, components: [], truncated: false }` — a confident
 * "no unused reports" for a family that was never looked at. Every such zero is
 * now itemised in `uncheckedTypes` with the reason read off the manifest's
 * coverage row (`not-retrieved` / `never-modeled` / `confirmed-empty` /
 * `coverage-unknown`). This is the SCANNED axis; `coverageCaveat` below is the
 * REFERRER axis, and its wording does not vary with what you scanned.
 *
 * **Honesty axis** (per the v2.0b spec): the tool never claims
 * components are "definitively unused". Each entry carries a per-type
 * `invisibleReferencesNote` that names the categories of reference
 * the v1.x extractors cannot see — dynamic SOQL (`SELECT
 * {fieldName}`), reflective Apex (`Type.forName`), permission-set
 * assignments (user-level, not metadata), sub-flow references via
 * `Flow.Interview.createInterview`, etc. A `risky` verdict for these
 * tools always means "spot-check before deleting".
 *
 * Implementation notes:
 *   - The tool's per-instance work is bounded by the size of the
 *     curated default subset; each type is paged to EXHAUSTION (in
 *     500-node pages) so a >500-of-a-type org is fully enumerated. Every
 *     scanned node's INCOMING edges are then fetched in ONE batched
 *     `listEdgesForNodes` round-trip per type — not the former N+1
 *     `listEdges`-per-node loop (one DuckDB round-trip per field, which
 *     dominated the >60s tech-debt/org-risk composite on a large org).
 *   - Result truncation: per the contract, the `truncated` flag is
 *     true when the total unused-instance count exceeds `limit`. The
 *     emitted slice is sorted globally by (type, id ASC) and trimmed
 *     to `limit` entries.
 *   - `byType` carries the FULL per-type count (not the truncated
 *     slice's count), so callers can show "showing N of M unused
 *     fields" in the UI.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  McpError,
  McpResponse,
  Node,
  PageInfo,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  countNodesByType,
  danglingTargetSummary,
  listEdgesForNodes,
  listNodesByType,
} from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  assertUsageCompleteness,
  offlineTrust,
  type CoverageCaveat,
} from './coverage-trust.js';
import { firstNonEmpty, resolveExistingObjectScope } from './input-aliases.js';
import { COMPONENT_TYPES } from './list-components.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import {
  ANALYTICS_COVERAGE_TYPES,
  reportDashboardUsageDetail,
} from './report-dashboard-usage.js';
import { nodeScanLimit } from './scan-cap.js';

const UNUSED_COMPONENTS_TOOL = 'sfi.unused_components';

/**
 * Inclusive upper bound on `limit`. Mirrors the `LIST_MAX_LIMIT`
 * convention from the graph layer so every enumeration-style MCP tool
 * shares the same blast-radius cap.
 */
const UNUSED_MAX_LIMIT = 500;

/** Default `limit` when the caller omits it. */
const UNUSED_DEFAULT_LIMIT = 100;

/**
 * Hard ceiling on a single `listNodesByType` page. The graph layer rejects
 * `limit > 500`, so each page request is clamped here; `nodeScanLimit()` is
 * env-overridable (`SFI_NODE_SCAN_LIMIT`) so a test can drive the multi-page
 * offset loop without seeding 500+ nodes. `scanType` pages this type to
 * EXHAUSTION (not just the first 500), so an org with more than 500
 * ApexClasses or CustomFields of a type is fully enumerated — the per-type
 * `byType` count and the unused list are complete, not capped at 500.
 */
const PAGE_CAP = 500;
const pageSize = (): number => Math.min(nodeScanLimit(), PAGE_CAP);

/**
 * UNUSED-PAGE-CURSOR-SKIPS-TRIMMED-ROWS byte budgeting.
 *
 * The global response guard (`tool-dispatch`) measures the WHOLE envelope
 * against ~39 KB (a 40 KB budget less its ~1 KB reserve) and tail-truncates
 * `data.components` when it does not fit — AFTER this handler has already
 * minted `nextOffset` / `nextCursor` for the untrimmed page, so the resume
 * token points past the rows the guard deleted. `paginateLegacy`'s default
 * budget (38 KB) bounds only the array, leaving no room for the rest.
 *
 * `DATA_ENVELOPE_TARGET_BYTES` is the ceiling for the whole `data` object,
 * chosen with headroom under that ~39 KB reduction cap for the fields the
 * dispatcher adds around it (`contentPolicy`, `vaultState`,
 * `estimatedPayloadBytes` — measured at ~0.6 KB).
 * `PAGE_METADATA_RESERVE_BYTES` covers the pagination fields this handler adds
 * only when the page IS truncated (`limit`, `offset`, `nextOffset`,
 * `nextCursor`, `pageInfo`), which are therefore not in the pre-measured fixed
 * payload. `MIN_PAGE_BYTE_BUDGET` keeps a pathologically large coverage caveat
 * from starving the page to nothing.
 */
const DATA_ENVELOPE_TARGET_BYTES = 36_000;
const PAGE_METADATA_RESERVE_BYTES = 900;
const MIN_PAGE_BYTE_BUDGET = 8_000;

/**
 * The default set of ComponentTypes the tool scans when `types` is
 * omitted. Curated for the personas the buyer-priority #7 question
 * targets: an admin wants to know about leftover fields, classes,
 * permission containers, queues, message templates, labels, etc., not
 * about every PermissionSetAssignment row.
 */
const DEFAULT_UNUSED_TYPES: readonly ComponentType[] = [
  'CustomField',
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'PermissionSet',
  'Queue',
  'Group',
  'Role',
  'EmailTemplate',
  'Letterhead',
  'GlobalValueSet',
  'CustomLabel',
  'StaticResource',
  'ValidationRule',
  'WorkflowRule',
];

/**
 * The full superset of ComponentTypes Zod validates against. Imported from
 * the single source of truth in `list-components.ts`, which is proven
 * complete at COMPILE TIME (`satisfies readonly ComponentType[]` plus the
 * `ComponentTypesComplete` guard), rather than hand-copied.
 *
 * It WAS hand-copied, and had drifted to 47 of 101 while its own comment
 * claimed to be the full superset -- so this tool rejected 54 types the
 * extractors retrieve and model (`FlexiPage`, `CustomPermission`, every CPQ
 * and OmniStudio tier) with `invalid-query`. That is exactly the
 * LIST-COMPONENTS-ENUM-OMITS-RETRIEVED-TYPES failure `list-components.ts'
 * documents having already shipped once. Deriving it means a type added to
 * the contracts union fails the build until it is listed, instead of
 * silently becoming unqueryable here.
 *
 * NOTE: this is the VALIDATION superset only. The semantic default set is
 * `DEFAULT_UNUSED_TYPES` above and is deliberately narrower.
 */

/**
 * Zod schema for the `sfi.unused_components` tool input.
 *
 *   - `types`: optional array of `ComponentType` values to scan. When
 *     omitted, the handler falls back to `DEFAULT_UNUSED_TYPES`. An
 *     empty array means "scan nothing" — returns an empty response —
 *     which keeps the boundary predictable.
 *   - `type` / `componentType` / `typeFilter`: optional SINGULAR type
 *     alias — the shape a host reaches for ("unused WebLinks"). Folded
 *     into a one-element `types` scope by the handler; an unrecognized
 *     value is `invalid-query` (NEVER silently stripped to the default
 *     Apex family). Ignored when the array `types` is present.
 *   - `object` / `objectApiName`: optional OBJECT SCOPE — narrow the scan
 *     to the components parented by that object ("unused WebLinks on
 *     Contact"). Echoed in `appliedScope`, in the VAULT's casing. The object
 *     must EXIST: an api name no `CustomObject` node matches is
 *     `invalid-query`, never the empty list that reads as "nothing here to
 *     delete" (UNUSED-COMPONENTS-ANSWERS-FOR-NONEXISTENT-OBJECT).
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100 inside
 *     the handler when omitted.
 */
export const unusedComponentsInputSchema = z.object({
  types: z.array(z.enum(COMPONENT_TYPES)).optional(),
  // Singular type aliases — validated in the handler so an unknown value is a
  // reasoned `invalid-query`, not a silent fall-through to the default family.
  type: z.string().min(1).optional(),
  componentType: z.string().min(1).optional(),
  typeFilter: z.string().min(1).optional(),
  // Object scope — narrows the scan to that object's children.
  object: z.string().min(1).optional(),
  objectApiName: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(UNUSED_MAX_LIMIT).optional(),
  // CR-22: page cursor for walking the full unused list when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `unusedComponentsInputSchema`. */
export type UnusedComponentsInput = z.infer<
  typeof unusedComponentsInputSchema
>;

/** Fast membership set over the scannable ComponentType enum. */
const COMPONENT_TYPE_SET: ReadonlySet<string> = new Set(COMPONENT_TYPES);

/** The resolved TYPE scan scope: the types to walk. */
interface ResolvedUnusedScope {
  readonly types: readonly ComponentType[];
  /** Whether the caller narrowed the type set (array OR singular alias). */
  readonly typesExplicit: boolean;
}

/**
 * Resolve the TYPE scan scope from the (interchangeable) type args, NEVER
 * silently stripping one. Precedence: an explicit `types` array (even empty —
 * "scan nothing") wins; else a singular `type` / `componentType` / `typeFilter`
 * alias, validated against the scannable enum (unknown → `invalid-query`, so a
 * bad type is a reasoned error, not a silent fall-through to the default Apex
 * family); else the curated default set.
 *
 * The OBJECT axis is resolved SEPARATELY, in the handler, against the graph —
 * it needs a vault lookup this sync resolver cannot make. See
 * UNUSED-COMPONENTS-ANSWERS-FOR-NONEXISTENT-OBJECT there.
 */
const resolveUnusedScope = (
  input: UnusedComponentsInput,
): Result<ResolvedUnusedScope, McpError> => {
  if (input.types !== undefined) {
    return ok({ types: input.types, typesExplicit: true });
  }
  const singular = firstNonEmpty(
    input.type,
    input.componentType,
    input.typeFilter,
  );
  if (singular !== undefined) {
    if (!COMPONENT_TYPE_SET.has(singular)) {
      return err({
        kind: 'invalid-query',
        message: `\`${singular}\` is not a component type this tool scans for unused instances — pass a valid ComponentType (e.g. "WebLink", "CustomField", "ApexClass") via \`type\` or \`types\`, or omit to scan the curated default set`,
        path: 'type',
      });
    }
    return ok({
      types: [singular as ComponentType],
      typesExplicit: true,
    });
  }
  return ok({
    types: DEFAULT_UNUSED_TYPES,
    typesExplicit: false,
  });
};

/**
 * One entry in the response's `components` array. Carries the
 * instance's identity plus the per-type honesty note so a caller
 * rendering the unused list always sees the invisible-reference
 * caveat next to the item.
 */
export interface UnusedComponent {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly label: string;
  readonly invisibleReferencesNote: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface UnusedComponentsOutput {
  /**
   * Echoes the scope ACTUALLY applied so a host never assumes a `type` / `object`
   * filter it passed was silently stripped (the wrong-family bug this closes).
   * `types` is the concrete list scanned; `object` is the bare object filter (or
   * null); `mode` is `scoped` when the caller narrowed type or object, else
   * `default` (the curated set, no object filter).
   */
  readonly appliedScope: {
    readonly types: readonly string[];
    readonly object: string | null;
    readonly mode: 'default' | 'scoped';
  };
  readonly components: readonly UnusedComponent[];
  /** Per-type unused-instance counts (FULL counts, not truncated). */
  readonly byType: Readonly<Record<string, number>>;
  /** True when the global slice was trimmed to `limit`. */
  readonly truncated: boolean;
  /**
   * Page size applied to this response. Present ONLY on a PAGED response
   * (`truncated` or a resumed `offset > 0`); omitted on a whole-fits no-cursor
   * call so that response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned component. Present only when paged (see `limit`). */
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
  /**
   * Present when a REFERRER family this absence claim depends on has
   * incomplete coverage (errored retrieve, scoped refresh, or a staged build
   * whose tier has not reached it). "Unused" only means "no retrieved
   * metadata references it" — if Reports were never retrieved, a field used
   * only by reports would read unused. The caveat names the families.
   */
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * UNUSED-UNCHECKED-ZERO-READS-AS-CLEAN: present ONLY when a scanned type has
   * ZERO instances in this vault, i.e. its `byType` entry is 0 because nothing
   * was SCANNED, not because everything scanned was in use. Without it,
   * `byType: { "Report": 0 }` on a vault whose refresh never retrieved a single
   * Report is byte-identical to `byType: { "EmailTemplate": 0 }` on a vault
   * that checked every template and found them all used — the reader concludes
   * "no unused reports" either way.
   *
   * The existing `coverageCaveat` does NOT cover this: it is the REFERRER axis
   * ("a field used only by reports would read unused"), its wording is
   * identical whichever type you scanned, and it fires just as loudly on a
   * fully-scanned type. This is the SCANNED axis. Absent when every scanned
   * type had at least one instance (response byte-identical to before).
   */
  readonly uncheckedTypes?: readonly {
    readonly type: string;
    /**
     *   - `not-retrieved`  — requested but the refresh landed 0 rows, or the
     *                        pull was capped / staged / errored. A refresh can
     *                        close this.
     *   - `never-modeled`  — no extractor models this type at all. No refresh
     *                        on any org can close it.
     *   - `confirmed-empty`— the retrieve is confirmed clean and the org
     *                        genuinely holds none. The zero IS checked.
     *   - `referenced-but-absent` — the manifest calls the retrieve confirmed
     *                        clean, but the vault's OWN graph carries
     *                        declared/parsed edges naming specific members of
     *                        this family that no node exists for. The
     *                        certification is contradicted by the vault's own
     *                        references; the zero is NOT checked.
     *   - `coverage-unknown` — a legacy vault with no coverage rows; which of
     *                        the above applies cannot be determined.
     */
    readonly reason:
      | 'not-retrieved'
      | 'never-modeled'
      | 'confirmed-empty'
      | 'referenced-but-absent'
      | 'coverage-unknown';
    readonly note: string;
  }[];
  /**
   * UNUSED-FIELD-IGNORES-THE-REPORT-INDEX-ITS-SIBLING-READS: what this scan did
   * with the vault's FOLDED report/dashboard field-usage index, and how far
   * that index reaches.
   *
   * Present ONLY when the scan included a type the fold stamps (see
   * `ANALYTICS_STAMPED_TYPES`); a scan over types it never stamps serialises
   * byte-identically to before this field existed.
   *
   * Why it is typed rather than prose: the shipped answer listed 1,646 unused
   * fields on a real vault while 236 of them carried this very stamp with
   * NAMED reports, hedged only by a `coverageCaveat` that blamed the VAULT for
   * missing Report coverage. That framing points a reader at a refresh, which
   * changes nothing — the gap was that this tool never consulted the index its
   * sibling `sfi.safe_to_delete_field` reads. `excludedAsUsed` is the count
   * this scan removed BECAUSE the index named them; `indexCoverage` is how
   * much of the org's analytics metadata that index was built from, which is
   * the honest residual after the removal.
   */
  readonly analyticsIndexCheck?: {
    /** Scanned types whose rows were adjudicated against the index. */
    readonly consultedTypes: readonly string[];
    /** Rows the index removed from the unused list (already out of `byType`). */
    readonly excludedAsUsed: number;
    /** Per-type breakdown of `excludedAsUsed`. */
    readonly excludedByType: Readonly<Record<string, number>>;
    /**
     * Coverage of the `Report` / `Dashboard` families the index is folded
     * from. `complete` means a component the index does NOT name is a CHECKED
     * "no analytics usage"; anything else means it is NOT CHECKED.
     */
    readonly indexCoverage: 'complete' | 'partial' | 'unknown';
    readonly note: string;
  };
  /** Provenance / completeness for the absence claim. */
  readonly trust: TrustSummary;
}

/**
 * Referrer families whose absence can FAKE an "unused" verdict: a component
 * is unused only relative to what was retrieved, so incomplete coverage of
 * any family that can reference components must qualify the claim.
 *
 * GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE: includes the PLACEMENT-source families
 * whose omission the false-safe cluster proved blind — CustomSite (a site's
 * `<indexPage>` / `<siteTemplate>` / favicon placement of a VF page or
 * StaticResource), WebLink (an object's list-view / search-layout buttons),
 * RecordType and CustomTab (compact-layout / tab placement) — so an "unused"
 * claim over a vault that never retrieved those planes reads "not checked", not
 * a proven "none". Fed as the RETRIEVE axis into the SHARED
 * `assertUsageCompleteness` contract (`coverage-trust.ts`), the same completeness
 * helper `review_change`, `package_impact` and `safe_to_delete_field` use — which
 * ALSO folds in the EXTRACTOR-BLIND axis (known-blind planes for the scanned
 * types) that no retrieve list can express.
 */
const UNUSED_REQUIRED_COVERAGE: readonly string[] = [
  'ApexClass',
  'ApexTrigger',
  'AuraDefinitionBundle',
  'CompactLayout',
  'CustomSite',
  'CustomTab',
  'Dashboard',
  'EmailTemplate',
  'FieldSet',
  'FlexiPage',
  'Flow',
  'Layout',
  'LightningComponentBundle',
  'ListView',
  'QuickAction',
  'RecordType',
  'Report',
  'SharingRule',
  'ValidationRule',
  'VisualforceComponent',
  'VisualforcePage',
  'WebLink',
  'WorkflowRule',
];

/**
 * Per-type invisible-references notes. The reason text spells out what
 * the v1.x extractors cannot see for the given type, so callers can
 * surface the caveat next to every unused-component entry. A node
 * type not present here falls back to a generic note.
 */
const INVISIBLE_REFERENCES_NOTES: Readonly<Record<string, string>> =
  Object.freeze({
    ApexClass:
      'Dynamic Apex (Type.forName), reflective dispatch, and Tooling API references are invisible to the v1.x scanner; spot-check before deleting.',
    ApexTrigger:
      'Listed only because its status is Inactive — active triggers are excluded since they fire on every DML event regardless of incoming references. An inactive trigger does not execute, but confirm it is not pending reactivation before deleting.',
    CustomField:
      'Dynamic SOQL (SELECT {fieldName}), LWC record[fieldName], integration payloads, and report column references are invisible to the v1.x extractors.',
    CustomLabel:
      'Dynamic label references via System.Label.get() and integration string interpolation are invisible.',
    CustomSettingRecord:
      'Runtime Apex reads via the parent type API (MySetting__c.getInstance) bypass the metadata graph and are invisible.',
    EmailTemplate:
      'EmailAlert references in WorkflowRules or Apex Messaging.SingleEmailMessage calls in a separate file may be invisible; check email-alert metadata before deleting.',
    ExternalDataSource:
      'Runtime callouts against the data source via Apex / LWC may not appear as metadata references.',
    Flow:
      'Listed only because its status is Obsolete or InvalidDraft (deactivated) — Active and Draft flows are excluded since a record/schedule/event-triggered flow runs without any incoming reference. A deactivated flow does not run, but confirm no newer version supersedes it before deleting.',
    GlobalValueSet:
      'Picklist field references the value set via `usesValueSet`; if the value set is unused here, no field declared it. Confirm before deleting.',
    Group:
      'Group memberships are managed at runtime (Sales > Groups admin UI) and are NOT extracted by the v1.x sharing-rule extractor. A group with no metadata references may still have live members.',
    Letterhead:
      'EmailTemplate XML references the letterhead by name; templates extracted from a different file may reference this letterhead invisibly.',
    PermissionSet:
      'Permission set assignments are user-level data not extracted in v1.x; a PermissionSet with no metadata references may still be assigned to users.',
    Queue:
      'Queue assignments via AssignmentRule and lead-routing UI are partially extracted; runtime ownership assignments are invisible.',
    Role:
      'Role assignments are user-level data not extracted in v1.x; a Role with no metadata references may still be the owning role for many records.',
    StaticResource:
      'LWC and Aura bundles reference static resources via dynamic paths the v1.x scanners cannot fully resolve; spot-check the bundle source before deleting.',
    ValidationRule:
      'Listed only because it is inactive (active=false) — active rules are excluded since they fire on every save regardless of incoming references. An inactive rule does not execute, but confirm it is not pending reactivation before deleting.',
    WorkflowRule:
      'Listed only because it is inactive (active=false) — active rules are excluded since they fire on every save regardless of incoming references. An inactive workflow rule does not execute, but confirm before deleting.',
  });

/**
 * Fallback note used when a node type has no specific entry in
 * `INVISIBLE_REFERENCES_NOTES`. Keeps the contract surface stable —
 * every entry in the response has a non-empty `invisibleReferencesNote`.
 */
const DEFAULT_INVISIBLE_REFERENCES_NOTE =
  'The v1.x extractors may miss runtime references (dynamic dispatch, reflective access, integration payloads). Spot-check the org before deleting.';

/**
 * UNUSED-FIELD-IGNORES-THE-REPORT-INDEX-ITS-SIBLING-READS.
 *
 * Replaces the shipped `CustomField` note for the rows that WERE adjudicated
 * against the folded report/dashboard index. The shipped sentence ended
 * "…and report column references are invisible to the v1.x extractors", which
 * on a vault carrying the fold is FALSE — the index names the reports, the
 * sibling `sfi.safe_to_delete_field` quotes them by name, and a reader who
 * believes the sentence stops looking. What IS still true is the RESIDUAL:
 * only the analytics metadata actually folded into this vault is covered.
 */
const ANALYTICS_CHECKED_NOTES: Readonly<Record<string, string>> = Object.freeze(
  {
    CustomField:
      'Dynamic SOQL (SELECT {fieldName}), LWC record[fieldName] and integration payloads are invisible to the v1.x extractors. Report and dashboard columns were NOT assumed invisible: this scan read the vault\'s folded report/dashboard field-usage index and dropped every field it names, so a field still listed here carries no stamp from the analytics metadata that IS in this vault — see `analyticsIndexCheck` for how far that index reaches before reading it as "no report uses this".',
  },
);

/**
 * Look up the invisible-references note for a node type, falling
 * back to the generic default when no specific entry is registered.
 *
 * `analyticsChecked` is true only for a type whose rows were actually
 * adjudicated against the folded report/dashboard index (see
 * {@link ANALYTICS_STAMPED_TYPES}); those rows get a note that describes what
 * was checked rather than one that declares the whole analytics plane blind.
 */
const noteForType = (type: ComponentType, analyticsChecked: boolean): string => {
  if (analyticsChecked) {
    const checked = ANALYTICS_CHECKED_NOTES[type];
    if (checked !== undefined) return checked;
  }
  return INVISIBLE_REFERENCES_NOTES[type] ?? DEFAULT_INVISIBLE_REFERENCES_NOTE;
};

/**
 * Component types the refresh stamps with FOLDED report / dashboard field
 * usage — `usedInReport` / `usedInDashboard` plus the named
 * `usedInReports` / `usedInDashboards` lists (see `report-dashboard-usage.ts`
 * and the CLI's `applyReportDashboardPersistence`). Only these can be
 * adjudicated against the analytics index, so only for these does this tool
 * claim to have consulted it.
 *
 * The fold deliberately does NOT persist an analytics -> `CustomField` EDGE
 * layer (94% of all rows at real-org scale, for an answer the properties
 * already give), which is exactly why the incoming-edge heuristic this tool is
 * built on cannot see report usage at all — and why reading the property is
 * the fix rather than waiting for an edge.
 */
const ANALYTICS_STAMPED_TYPES: ReadonlySet<ComponentType> =
  new Set<ComponentType>(['CustomField']);

/**
 * True when the vault's folded report/dashboard index names this component.
 *
 * Adopts the SHARED `reportDashboardUsageDetail` read (`field_360`,
 * `field_lineage`, `safe_to_delete_field`, `unused_fields_deep` …) rather than
 * re-deriving a fourth notion of "an analytics surface uses this field" here:
 * this tool listing a field as unused while its sibling returns `blocking`
 * with three NAMED reports off the same property is the defect being fixed.
 */
const namedByAnalyticsIndex = (node: Node): boolean => {
  const usage = reportDashboardUsageDetail(node);
  return usage.usedInReport || usage.usedInDashboard;
};

/** How far the folded report/dashboard index this scan consulted reaches. */
type AnalyticsIndexCoverage = 'complete' | 'partial' | 'unknown';

/**
 * Tri-state reach of the folded index, read off the SHARED
 * `ANALYTICS_COVERAGE_TYPES` coverage rows (`report-dashboard-usage.ts`) — the
 * same two families `field_360`, `field_lineage` and `safe_to_delete_field`
 * gate their analytics claims on, so this tool cannot drift into a fourth
 * notion of "the analytics corpus is covered".
 *
 * `complete` is the ONLY state in which "the index does not name this
 * component" is a CHECKED "no report or dashboard uses it". `partial` is the
 * bounded/staged pull; `unknown` is a vault with no analytics coverage rows to
 * read at all.
 */
const analyticsIndexCoverage = (ctx: Context): AnalyticsIndexCoverage => {
  const summary = summarizeCoverage(ctx.manifest, ANALYTICS_COVERAGE_TYPES);
  if (!summary.coverageKnown || summary.status === 'unknown') return 'unknown';
  return summary.status === 'complete' ? 'complete' : 'partial';
};

/**
 * The RESIDUAL clause: what remains unchecked AFTER the index was consulted.
 * Kept as one function so the typed `analyticsIndexCheck.note` and the prose a
 * host reads out of `coverageCaveat.message` state the same residual rather
 * than drifting apart.
 */
const analyticsResidualClause = (coverage: AnalyticsIndexCoverage): string => {
  switch (coverage) {
    case 'complete':
      return 'Both analytics families are fully retrieved into this vault, so a component the index does NOT name is a CHECKED "no report or dashboard column references it".';
    case 'partial':
      return 'Analytics coverage is PARTIAL (a bounded or staged pull), so a component the index does not name is NOT CHECKED against the reports and dashboards outside that fold — widening the pull widens the index, it does not change that this tool reads it.';
    default:
      return 'This vault carries no analytics coverage rows, so how much of the org\'s reports and dashboards the index was folded from cannot be determined — a component the index does not name is NOT CHECKED.';
  }
};

/**
 * Build the typed disclosure of what the folded index did to this scan.
 *
 * UNUSED-FIELD-IGNORES-THE-REPORT-INDEX-ITS-SIBLING-READS: `undefined` when the
 * scan touched no type the fold stamps, so such a response serialises
 * byte-identically to before this field existed. Never emitted half-populated —
 * every key is computed from the scan that just ran.
 */
const buildAnalyticsIndexCheck = (
  ctx: Context,
  consultedTypes: readonly ComponentType[],
  excludedByType: Readonly<Record<string, number>>,
):
  | {
      readonly consultedTypes: readonly string[];
      readonly excludedAsUsed: number;
      readonly excludedByType: Readonly<Record<string, number>>;
      readonly indexCoverage: AnalyticsIndexCoverage;
      readonly note: string;
    }
  | undefined => {
  if (consultedTypes.length === 0) return undefined;
  const excludedAsUsed = Object.values(excludedByType).reduce(
    (sum, n) => sum + n,
    0,
  );
  const indexCoverage = analyticsIndexCoverage(ctx);
  return {
    consultedTypes: [...consultedTypes],
    excludedAsUsed,
    excludedByType,
    indexCoverage,
    note: `This scan adjudicated ${consultedTypes
      .map((t) => `\`${t}\``)
      .join(', ')} against the vault's FOLDED report/dashboard field-usage index (the \`usedInReport\` / \`usedInDashboard\` stamp the refresh writes onto the node, and the same evidence \`sfi.safe_to_delete_field\` cites by report name) and removed ${excludedAsUsed} component(s) the index names from the unused list. ${analyticsResidualClause(indexCoverage)}`,
  };
};

/**
 * Entry-point component types fire on their own — on DML, a schedule, or a
 * platform event — rather than by being referenced. Their relationship to the
 * org is modelled as OUTGOING edges (`triggersOn` / `firesWhen`), so a missing
 * INCOMING edge does NOT mean unused: a live record-triggered Flow or an active
 * trigger has no inbound reference yet runs on every matching event. For these
 * types the correct "dead weight" signal is an INACTIVE status, not the
 * incoming-edge heuristic that {@link isUnused} applies to reference types.
 */
const ENTRY_POINT_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'Flow',
  'ApexTrigger',
  'ValidationRule',
  'WorkflowRule',
]);

/**
 * For an entry-point node, decide whether it is INACTIVE (and therefore dead
 * weight an admin can clean up). Reads the status/active property the
 * extractors record. Returns `null` when activity cannot be determined — the
 * caller treats unknown as "in use" so live automation is never mislabelled
 * dead.
 *
 *   - Flow:           dead when status is `Obsolete` or `InvalidDraft`
 *                     (Active runs; Draft is work-in-progress, not dead).
 *   - ApexTrigger:    dead when status is `Inactive`.
 *   - ValidationRule / WorkflowRule: dead when `active === false`.
 */
const isInactiveEntryPoint = (
  type: ComponentType,
  properties: Readonly<Record<string, unknown>>,
): boolean | null => {
  switch (type) {
    case 'Flow': {
      const status = properties['status'];
      if (typeof status !== 'string') return null;
      return status === 'Obsolete' || status === 'InvalidDraft';
    }
    case 'ApexTrigger': {
      const status = properties['status'];
      if (typeof status !== 'string') return null;
      return status === 'Inactive';
    }
    case 'ValidationRule':
    case 'WorkflowRule': {
      const active = properties['active'];
      if (typeof active !== 'boolean') return null;
      return active === false;
    }
    default:
      return null;
  }
};

/**
 * Decide whether a node is "unused" from its already-fetched INCOMING edge set.
 * Skips `parentOf` (the owning object — structural, not a dependency) and
 * `grantedBy` (a Profile / PermissionSet ACCESS grant — access is not usage: a
 * component nobody references is still unused even when profiles grant access to
 * it; the same split the dead-code / what-if tools make). Any OTHER incoming
 * edge means the component is in use.
 *
 * Pure over the edge set so the caller can batch every node's incoming edges in
 * ONE `listEdgesForNodes` round-trip (see {@link scanType}) rather than an N+1
 * `listEdges`-per-node loop; the verdict is an existence check that does not
 * depend on edge order, so the batched path is byte-identical to the per-node
 * one.
 */
const isUnusedFromEdges = (incoming: readonly Edge[]): boolean => {
  for (const edge of incoming) {
    if (edge.edgeType === 'parentOf' || edge.edgeType === 'grantedBy') continue;
    return false;
  }
  return true;
};

/**
 * Apex-class test-class predicate. `properties.isTest === true`
 * indicates the v1.4 test-mapping extractor flagged the class as a
 * test class; uncalled tests are independently valuable and must NOT
 * be classified as unused.
 */
const isTestApexClass = (properties: Readonly<Record<string, unknown>>): boolean =>
  properties['isTest'] === true;

/**
 * Comparator for the deterministic per-type sort. `id` ASC so the
 * truncation point is stable across runs.
 */
const compareById = (a: UnusedComponent, b: UnusedComponent): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Comparator for the global slice sort. `type` ASC first, then `id`
 * ASC. Keeps a consistent per-type grouping in the global output so
 * callers can render the response without an extra group-by pass.
 *
 * This is already a STRICT TOTAL order (CR-22): `id` is the globally-unique
 * ComponentId (e.g. `CustomField:Account.Industry__c`) and each id belongs to
 * exactly one type, so (type ASC, id ASC) never ties two distinct rows. No
 * additional tiebreak is needed for a dup-free / skip-free offset resume.
 */
const compareGlobally = (a: UnusedComponent, b: UnusedComponent): number => {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  return compareById(a, b);
};

/**
 * Scan one component type for unused instances. Returns the
 * per-instance list (sorted by id ASC). Test ApexClasses are
 * excluded inside this loop so the caller's downstream logic does
 * not need to special-case ApexClass.
 *
 * When `objectScopeId` is a canonical `CustomObject:{ApiName}` id, the scan is
 * narrowed to nodes parented by that object (`parentId` match) BEFORE the
 * incoming-edge fetch — so an object-scoped query answers only that object's
 * children (fields, WebLinks, validation rules, …) and a type with no object
 * parent (e.g. ApexClass) honestly returns empty rather than the org-wide list.
 */
const scanType = async (
  ctx: Context,
  type: ComponentType,
  objectScopeId: string | null,
): Promise<
  Result<
    {
      readonly components: readonly UnusedComponent[];
      /**
       * How many instances of this type exist IN THE VAULT (before any object
       * scope). Zero means NOTHING WAS SCANNED, so a `byType` count of 0 is an
       * unchecked zero, not a clean bill of health — see `uncheckedTypes`.
       */
      readonly vaultInstances: number;
      /**
       * How many instances the FOLDED report/dashboard index removed from the
       * unused list — rows the incoming-edge heuristic called unused while the
       * vault's own analytics stamp names them. Always 0 for a type the fold
       * does not stamp (see {@link ANALYTICS_STAMPED_TYPES}).
       */
      readonly analyticsExcluded: number;
    },
    string
  >
> => {
  // Page this type to EXHAUSTION, not just the first 500. The `unused` verdict
  // is destructive and `byType` is a tally; a single `listNodesByType` page
  // caps at 500 (id ASC), so an org with > 500 of a type used to drop the tail
  // — `byType[type]` saturated at 500 and the per-type unused enumeration was
  // incomplete. `countNodesByType` is the loop's belt cross-check. The common
  // case (type under the cap) runs exactly one sub-cap page — byte-identical.
  const totalRes = await countNodesByType(ctx.graph, type);
  if (!totalRes.ok) {
    return err(totalRes.error.message);
  }
  const limit = pageSize();
  const allNodes: Node[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await listNodesByType(ctx.graph, type, { limit, offset });
    if (!page.ok) {
      return err(page.error.message);
    }
    allNodes.push(...page.value);
    if (page.value.length < limit || allNodes.length >= totalRes.value) break;
  }
  // Object scope: keep only this object's children (parentId match). A type with
  // no object parent (ApexClass, EmailTemplate, …) filters to empty — an honest
  // "no such component on that object", never the wrong-family org-wide list.
  const nodes =
    objectScopeId === null
      ? allNodes
      : allNodes.filter((n) => n.parentId === objectScopeId);
  const consultsAnalyticsIndex = ANALYTICS_STAMPED_TYPES.has(type);
  const note = noteForType(type, consultsAnalyticsIndex);
  const isEntryPoint = ENTRY_POINT_TYPES.has(type);

  // Reference types decide "unused" from their INCOMING edges. Fetch every
  // node's incoming edges in ONE batched `listEdgesForNodes` round-trip instead
  // of an N+1 `listEdges`-per-node loop (the CustomField scan alone was one
  // DuckDB round-trip per field — thousands on a large org, the dominant cost in
  // the >60s tech_debt_score/org_risk_report timeout). Entry-point types never
  // touch the edge set (their verdict is INACTIVE status), so they skip it.
  let incomingByNode: ReadonlyMap<ComponentId, readonly Edge[]> = new Map();
  if (!isEntryPoint) {
    const batched = await listEdgesForNodes(
      ctx.graph,
      nodes.map((n) => n.id),
      { direction: 'in' },
    );
    if (!batched.ok) {
      return err(batched.error.message);
    }
    incomingByNode = batched.value;
  }

  const out: UnusedComponent[] = [];
  let analyticsExcluded = 0;
  for (const node of nodes) {
    // Test-class exemption per the v2.0b spec.
    if (type === 'ApexClass' && isTestApexClass(node.properties)) {
      continue;
    }
    let unused: boolean;
    if (isEntryPoint) {
      // Entry points fire on their own; "dead" means inactive, not
      // unreferenced. Unknown activity is treated as in-use.
      unused = isInactiveEntryPoint(type, node.properties) === true;
    } else {
      unused = isUnusedFromEdges(incomingByNode.get(node.id) ?? []);
    }
    if (!unused) continue;
    // UNUSED-FIELD-IGNORES-THE-REPORT-INDEX-ITS-SIBLING-READS. The fold does
    // not emit an analytics -> field EDGE, so the incoming-edge verdict above
    // is structurally blind to report/dashboard usage; the stamp on the node
    // is where that evidence lives, and this tool now reads it before shipping
    // a delete recommendation its own sibling would refuse.
    if (consultsAnalyticsIndex && namedByAnalyticsIndex(node)) {
      analyticsExcluded += 1;
      continue;
    }
    out.push({
      id: node.id,
      type: node.type,
      apiName: node.apiName,
      label: node.label ?? '',
      invisibleReferencesNote: note,
    });
  }
  return ok({
    components: [...out].sort(compareById),
    vaultInstances: allNodes.length,
    analyticsExcluded,
  });
};

/**
 * UNUSED-CERTIFIED-ZERO-CONTRADICTED-BY-OWN-GRAPH.
 *
 * A family the vault holds ZERO nodes of, while the vault's OWN edges name
 * specific members of it. That is a self-contradiction the manifest cannot
 * see: the coverage row says `{requested: true, retrieved: 0,
 * retrieveConfirmed: true}` (which `summarizeCoverage` reads as COVERED, and
 * this tool then certified as "the 0 IS a checked zero"), while every retrieved
 * referrer in the graph points at members that were never brought back.
 *
 * Measured on a real vault: ZERO nodes of a folder-scoped family, 79 `declared`
 * edges from approval processes and workflow alerts naming 30 distinct members
 * of it. `sfi.retrieve_blindspot_report` reported that family `partial` in the
 * same run — the product held the true statement and the false one and shipped
 * the false one on the tool an architect builds a leave-behind list from.
 *
 * Why the upstream fact cannot be trusted for such a family: a bare wildcard
 * retrieve of a FOLDER-SCOPED metadata type returns nothing whether or not the
 * org holds any, so "retrieve completed, zero members" is guaranteed and can
 * never be evidence of absence. The graph's dangling references are the
 * arbiter and they win.
 */
interface ReferencedButAbsentFamily {
  /** Non-heuristic edges pointing at members of this family that do not exist. */
  readonly referenceEdges: number;
  /** Distinct missing member ids those edges name. */
  readonly distinctTargets: number;
}

/**
 * Confidence tiers whose dangling references are strong enough to unseat a
 * "confirmed-empty" certification. `heuristic` is DELIBERATELY excluded: that
 * is the unresolved-Apex-scanner phantom tier `sfi.retrieve_blindspot_report`
 * rolls up as documented noise, and a phantom must never be able to convert a
 * genuinely checked zero into a hedge — the false-positive direction is just as
 * dishonest as the false-negative one this fixes.
 */
const CONTRADICTING_CONFIDENCE: ReadonlySet<string> = new Set([
  'declared',
  'parsed',
]);

/**
 * Which of `candidates` are REFERENCED BUT ABSENT: zero nodes in the vault, yet
 * one or more non-heuristic edges name a member of them.
 *
 * Adopts the SHARED `danglingTargetSummary` graph query (the same anti-join
 * `sfi.retrieve_blindspot_report` is built on) rather than re-deriving a second
 * notion of "referenced but never retrieved" here — the two tools contradicting
 * each other on the same vault in the same run is the defect being fixed.
 *
 * Fails CLOSED: a graph error propagates to the caller as an error rather than
 * silently restoring the certified zero.
 */
const referencedButAbsentFamilies = async (
  ctx: Context,
  candidates: readonly string[],
): Promise<Result<ReadonlyMap<string, ReferencedButAbsentFamily>, McpError>> => {
  const out = new Map<string, ReferencedButAbsentFamily>();
  if (candidates.length === 0) return ok(out);
  const summary = await danglingTargetSummary(ctx.graph);
  if (!summary.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${summary.error.message}`,
    });
  }
  const wanted = new Set(candidates);
  const tallies = new Map<string, { edges: number; targets: number }>();
  for (const group of summary.value) {
    if (!wanted.has(group.targetType)) continue;
    if (!CONTRADICTING_CONFIDENCE.has(group.confidence)) continue;
    const prev = tallies.get(group.targetType) ?? { edges: 0, targets: 0 };
    tallies.set(group.targetType, {
      edges: prev.edges + group.edgeCount,
      // Groups are split by (edgeType, confidence), so distinct-target counts
      // can overlap across groups of the same family. Sum is the honest upper
      // bound on "at least this many members are named"; it is only ever used
      // to say the number is non-zero and to size the disclosure.
      targets: prev.targets + group.distinctTargets,
    });
  }
  for (const [type, tally] of tallies) {
    // Only a WHOLLY absent family is a contradiction of "the org holds none".
    // A family with nodes plus some dangling members (managed-package members,
    // a community context outside the retrieve scope) is the ordinary blind
    // spot `coverageCaveat` already covers — not a false certification.
    const count = await countNodesByType(ctx.graph, type as ComponentType);
    if (!count.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${count.error.message}`,
      });
    }
    if (count.value > 0) continue;
    out.set(type, {
      referenceEdges: tally.edges,
      distinctTargets: tally.targets,
    });
  }
  return ok(out);
};

/**
 * UNUSED-UNCHECKED-ZERO-READS-AS-CLEAN: classify WHY a scanned type produced no
 * instances to scan, from the manifest's per-type coverage row. A zero that
 * means "the refresh never retrieved this family" and a zero that means "the
 * org genuinely has none" are the same number and must not read the same.
 */
const classifyUncheckedType = (
  ctx: Context,
  type: ComponentType,
  /**
   * The vault's own contradiction of a clean-retrieve claim for this family,
   * when it has one. See {@link referencedButAbsentFamilies}.
   */
  contradiction: ReferencedButAbsentFamily | undefined,
): {
  readonly type: string;
  readonly reason:
    | 'not-retrieved'
    | 'never-modeled'
    | 'confirmed-empty'
    | 'referenced-but-absent'
    | 'coverage-unknown';
  readonly note: string;
} => {
  const coverage = summarizeCoverage(ctx.manifest, [type]);
  if (!coverage.coverageKnown) {
    return {
      type,
      reason: 'coverage-unknown',
      note: `\`${type}\`: 0 unused because ZERO instances were scanned — this vault holds no \`${type}\` at all, and its manifest carries no coverage rows, so whether the refresh skipped the family or the org genuinely has none cannot be determined. Re-run \`sfi refresh --no-pull\` to compute coverage before reading this 0 as "nothing unused".`,
    };
  }
  if (coverage.notModeledTypes.includes(type)) {
    return {
      type,
      reason: 'never-modeled',
      note: `\`${type}\`: 0 unused because ZERO instances were scanned — NO extractor in this product models \`${type}\`, on any org. This 0 is "never checked" BY CONSTRUCTION and no refresh can change it; it is not evidence that no unused \`${type}\` exists.`,
    };
  }
  if (coverage.coveredTypes.includes(type)) {
    // UNUSED-CERTIFIED-ZERO-CONTRADICTED-BY-OWN-GRAPH: the manifest calls the
    // retrieve confirmed-clean, but the graph names members of this family that
    // no node exists for. The vault contradicts its own coverage row, so the
    // certification does not ship.
    if (contradiction !== undefined) {
      return {
        type,
        reason: 'referenced-but-absent',
        note: `\`${type}\`: 0 unused, and that 0 is NOT a checked zero. ZERO \`${type}\` components exist in this vault, yet its own graph carries ${contradiction.referenceEdges} declared/parsed reference edge(s) naming up to ${contradiction.distinctTargets} distinct \`${type}\` member(s) that were never retrieved — the manifest's "retrieve confirmed, zero members" row is contradicted by the vault's own references. A folder-scoped metadata family is the usual cause: a bare wildcard retrieve returns nothing for one whether or not the org has any, so "retrieve completed, zero members" cannot be evidence of absence. Treat this 0 as NOT CHECKED. Run \`sfi.retrieve_blindspot_report\` to see which components reference the missing \`${type}\` members, then re-run \`/sfi-refresh\` (folder-qualified members) before reading this 0 as "nothing unused".`,
      };
    }
    return {
      type,
      reason: 'confirmed-empty',
      note: `\`${type}\`: 0 unused because this org holds no \`${type}\` at all — the retrieve is confirmed clean and returned zero members, so the 0 IS a checked zero (nothing to be unused).`,
    };
  }
  return {
    type,
    reason: 'not-retrieved',
    note: `\`${type}\`: 0 unused because ZERO instances were scanned — this vault's last refresh did NOT retrieve any \`${type}\` (not requested, capped, staged, or errored). This 0 means "NOT CHECKED", never "no unused \`${type}\`". Run \`/sfi-refresh\` and re-ask, or check \`sfi.coverage_report\`.`,
  };
};

/**
 * The `sfi.unused_components` MCP tool. Returns the per-type unused-
 * instance list across either the caller's chosen `types` or the
 * curated `DEFAULT_UNUSED_TYPES` subset. See the module JSDoc for
 * the per-type honesty notes and the test-class exemption rule.
 *
 * @example
 *   const r = await unusedComponentsHandler(ctx, {
 *     types: ['EmailTemplate', 'Letterhead'],
 *   });
 *   if (r.ok) console.log(r.value.data.byType);
 */
export const unusedComponentsHandler = async (
  ctx: Context,
  input: UnusedComponentsInput,
): Promise<Result<McpResponse<UnusedComponentsOutput>, McpError>> => {
  const limit = input.limit ?? UNUSED_DEFAULT_LIMIT;

  // Resolve the (interchangeable) type scope, NEVER silently stripping one. An
  // unknown singular `type` is `invalid-query`, not a wrong-family list.
  const scopeResult = resolveUnusedScope(input);
  if (!scopeResult.ok) return scopeResult;
  const { types, typesExplicit } = scopeResult.value;

  // UNUSED-COMPONENTS-ANSWERS-FOR-NONEXISTENT-OBJECT: resolve + VERIFY the
  // object scope against the VAULT before scanning.
  //
  // The object axis used to be a pure string coercion — `object` /
  // `objectApiName` became `CustomObject:{name}` with no lookup. `scanType`
  // then filtered on `parentId === thatId`, matched nothing, and the tool
  // returned `{ components: [], byType: { CustomField: 0, … } }` with
  // `appliedScope.object` echoing the caller's typo back as though it had been
  // applied. On THIS tool a zero is read as "nothing here to delete", so a
  // mistyped object name and a genuinely clean object produced the IDENTICAL
  // payload — the 0.3.2 `unused_fields_deep` shape verbatim: an unchecked zero
  // wearing a checked zero's clothes. The same coercion also broke the honest
  // case: `object: 'wIdGeT__C'` returned an empty list for the real
  // `Widget__c`, because `CustomObject:wIdGeT__C` matched no `parentId`.
  //
  // `resolveExistingObjectScope` is the shared resolver (flow_fault_audit,
  // flow_bulkification_audit, unused_fields_deep, …): `ok(null)` for a bare
  // org-wide call — byte-identical to before — a vault-cased id when the object
  // exists, and `invalid-query` naming the object when it does not.
  const objectScopeResult = await resolveExistingObjectScope(ctx.graph, {
    object: input.object,
    objectApiName: input.objectApiName,
  });
  if (!objectScopeResult.ok) return err(objectScopeResult.error);
  // `objectId` filters the scan (`parentId` match); `object` is the bare api
  // name echoed in `appliedScope` — both in the VAULT's exact casing, never the
  // caller's.
  const objectId = objectScopeResult.value?.componentId ?? null;
  const object = objectScopeResult.value?.object ?? null;

  const allUnused: UnusedComponent[] = [];
  const byType: Record<string, number> = {};
  // UNUSED-FIELD-IGNORES-THE-REPORT-INDEX-ITS-SIBLING-READS: which scanned
  // types were adjudicated against the folded report/dashboard index, and how
  // many rows it removed from each. Feeds the TYPED `analyticsIndexCheck`
  // disclosure and the caveat prose, which must never say the index was
  // consulted without saying by how much it moved the answer.
  const consultedAnalyticsTypes: ComponentType[] = [];
  const excludedByType: Record<string, number> = {};
  // UNUSED-UNCHECKED-ZERO-READS-AS-CLEAN: a scanned type with no instances to
  // scan produces `byType[type] = 0` — identical to "checked everything, all in
  // use". Record which zeros were never checked.
  const uncheckedTypes: {
    readonly type: string;
    readonly reason:
      | 'not-retrieved'
      | 'never-modeled'
      | 'confirmed-empty'
      | 'referenced-but-absent'
      | 'coverage-unknown';
    readonly note: string;
  }[] = [];

  // UNUSED-CERTIFIED-ZERO-CONTRADICTED-BY-OWN-GRAPH. Computed ONCE for both
  // axes before any scanning:
  //   - SCANNED axis  — a scanned family with zero instances whose members the
  //     graph nevertheless names cannot be certified a "checked zero".
  //   - REFERRER axis — a family in UNUSED_REQUIRED_COVERAGE that is wholly
  //     absent yet referenced is a retrieve gap `summarizeCoverage` scores as
  //     COVERED (its row reads `retrieved: 0, retrieveConfirmed: true`), so
  //     `assertUsageCompleteness` never names it. Everything whose only
  //     referrers live in that family then reads "unused" off a corpus that
  //     was never retrieved.
  const absentFamilies = await referencedButAbsentFamilies(ctx, [
    ...new Set<string>([...types, ...UNUSED_REQUIRED_COVERAGE]),
  ]);
  if (!absentFamilies.ok) return err(absentFamilies.error);
  const referencedButAbsent = absentFamilies.value;

  for (const type of types) {
    const result = await scanType(ctx, type, objectId);
    if (!result.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${result.error}`,
      });
    }
    byType[type] = result.value.components.length;
    allUnused.push(...result.value.components);
    // UNUSED-FIELD-IGNORES-THE-REPORT-INDEX-ITS-SIBLING-READS: record the
    // per-type adjudication for EVERY consulted type, including the ones the
    // index named nothing in — "consulted, removed 0" and "never consulted"
    // are different answers and must not share a shape.
    if (ANALYTICS_STAMPED_TYPES.has(type)) {
      consultedAnalyticsTypes.push(type);
      excludedByType[type] = result.value.analyticsExcluded;
    }
    if (result.value.vaultInstances === 0) {
      uncheckedTypes.push(
        classifyUncheckedType(ctx, type, referencedButAbsent.get(type)),
      );
    }
  }

  const analyticsIndexCheck = buildAnalyticsIndexCheck(
    ctx,
    consultedAnalyticsTypes,
    excludedByType,
  );

  const sorted = [...allUnused].sort(compareGlobally);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // Bind the token to the RESOLVED scope (types + object) so a token minted for
  // one scope can't be replayed against another.
  const fingerprint = argsFingerprint({ types: [...types], object });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: UNUSED_COMPONENTS_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // "Unused" is an absence claim: it is only as strong as the coverage of the
  // families that could hold the reference AND the extractor's ability to see
  // those references. Routed through the SHARED L1 completeness contract
  // (GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE) so this tool, review_change,
  // package_impact and safe_to_delete_field share ONE definition of "incomplete":
  //   - RETRIEVE axis — incomplete referrer coverage (errored retrieve, scoped
  //     refresh, mid-staged-build pending tiers) qualifies the answer, exactly as
  //     before (fireOnUnknownCoverage: a pre-coverage vault is not-provably-clean).
  //     P13-STAGED-absence-battery red without this.
  //   - EXTRACTOR-BLIND axis (residual) — a SCANNED type whose referrers include a
  //     KNOWN-BLIND plane (e.g. a StaticResource reached only via a dynamically
  //     built LWC/Aura resourceUrl) carries a structured `extractor-blind`
  //     blindSpot EVEN on a fully-covered vault, so its "unused" reads "not
  //     checked", not proven "none". `blindPlaneTypes` is the scanned type set.
  // Computed BEFORE pagination because its size feeds the page byte budget.
  const retrieveCaveat = assertUsageCompleteness(ctx, {
    usageFamilies: UNUSED_REQUIRED_COVERAGE,
    blindPlaneTypes: types,
    purpose: 'Unused status',
    fireOnUnknownCoverage: true,
  }).caveat;

  // REFERRER axis of UNUSED-CERTIFIED-ZERO-CONTRADICTED-BY-OWN-GRAPH. A
  // referrer family that is wholly absent yet referenced never reaches
  // `missingCoverage` on its own, because its coverage row reads COVERED. Fold
  // it in here so the machine-readable gap list, the `blindSpots` array and the
  // prose a host reads aloud all name it — and so `trust.completeness` below
  // (which is DERIVED from this caveat) can never say `complete` while an
  // absence verdict rests on a corpus that was never retrieved.
  const referrerGaps = UNUSED_REQUIRED_COVERAGE.filter((family) =>
    referencedButAbsent.has(family),
  );
  const referrerBlindSpots = referrerGaps.map((family) => ({
    plane: family,
    kind: 'not-retrieved' as const,
    detail: `The vault holds ZERO \`${family}\` components, yet its own graph carries ${referencedButAbsent.get(family)?.referenceEdges ?? 0} declared/parsed reference edge(s) naming members of \`${family}\` that were never retrieved. Anything whose only referrers live in \`${family}\` reads "unused" off a corpus that is not in this vault.`,
  }));
  const referrerSentence =
    referrerGaps.length === 0
      ? ''
      : ` The vault ALSO holds zero components of ${referrerGaps
          .map((f) => `\`${f}\``)
          .join(
            ', ',
          )} while its own references name specific members of ${referrerGaps.length === 1 ? 'that family' : 'those families'} — referenced but never retrieved, so treat absence of a reference FROM ${referrerGaps.length === 1 ? 'it' : 'them'} as "not checked", not "none".`;
  // UNUSED-FIELD-IGNORES-THE-REPORT-INDEX-ITS-SIBLING-READS (prose axis). The
  // shipped caveat named `Report` / `Dashboard` under "Un-retrieved families",
  // which tells a reader the remedy is a refresh. It is not: the vault ALREADY
  // held a folded report/dashboard field-usage index (236 of the 1,646 rows
  // this tool called unused on a real vault carried that stamp, with NAMED
  // reports its sibling `sfi.safe_to_delete_field` quotes back as `blocking`),
  // and the tool simply never read it. Now that it does, the caveat must say
  // so, name how far the answer moved, and describe the RESIDUAL — otherwise
  // the hedge keeps pointing at the wrong fix and keeps reading as boilerplate.
  //
  // Appended to an EXISTING caveat only: a vault with nothing to hedge does not
  // acquire one, and `analyticsIndexCheck` carries the same facts in a typed
  // field a machine consumer cannot skip.
  const analyticsSentence =
    analyticsIndexCheck === undefined
      ? ''
      : ` This answer DID consult the vault's folded report/dashboard field-usage index and removed ${analyticsIndexCheck.excludedAsUsed} component(s) it names from the unused list before reporting, so \`Report\` / \`Dashboard\` above is a RESIDUAL gap, not an unconsulted family. ${analyticsResidualClause(analyticsIndexCheck.indexCoverage)} See \`analyticsIndexCheck\`.`;
  const coverageCaveatBase: CoverageCaveat | undefined =
    referrerGaps.length === 0
      ? retrieveCaveat
      : retrieveCaveat === undefined
        ? {
            status: 'partial',
            missingCoverage: [...referrerGaps].sort(),
            message: `Unused status cannot be confirmed because the vault has incomplete coverage for: ${[
              ...referrerGaps,
            ]
              .sort()
              .join(', ')}.${referrerSentence}`,
            blindSpots: referrerBlindSpots,
          }
        : {
            ...retrieveCaveat,
            status: 'partial',
            missingCoverage: [
              ...new Set([...retrieveCaveat.missingCoverage, ...referrerGaps]),
            ].sort(),
            message: `${retrieveCaveat.message}${referrerSentence}`,
            blindSpots: [
              ...(retrieveCaveat.blindSpots ?? []),
              ...referrerBlindSpots,
            ],
          };
  const coverageCaveat: CoverageCaveat | undefined =
    coverageCaveatBase === undefined || analyticsSentence === ''
      ? coverageCaveatBase
      : {
          ...coverageCaveatBase,
          message: `${coverageCaveatBase.message}${analyticsSentence}`,
        };

  const scoped = typesExplicit || objectId !== null;

  // UNUSED-PAGE-CURSOR-SKIPS-TRIMMED-ROWS: `paginateLegacy`'s default byte
  // budget bounds the COMPONENTS ARRAY alone (38 KB), while the global response
  // guard in `tool-dispatch` measures the WHOLE envelope against ~39 KB. On a
  // large page the surrounding fields (byType, the multi-KB blind-plane
  // coverageCaveat, uncheckedTypes, trust, contentPolicy) pushed the envelope
  // over, so the guard tail-truncated `components` AFTER this handler had
  // already minted `nextOffset`/`nextCursor` for the untrimmed page — and the
  // guard's own note tells the caller "the handler's pagination is
  // authoritative". Measured: `{ limit: 500 }` returned 59 rows with a cursor
  // pointing at offset 118, so following it SKIPPED 59 unused components
  // outright, and page 2 skipped 63 more. A "what can I delete" list that
  // silently omits rows between its own pages is the worst shape this tool has.
  //
  // Fix: budget the page against what is actually LEFT for it, so the handler's
  // page fits the envelope and its cursor stays truthful.
  const trust = offlineTrust(
    ctx,
    coverageCaveat === undefined
      ? { status: 'complete' }
      : { status: 'partial', missingCoverage: coverageCaveat.missingCoverage },
  );
  const fixedPayloadBytes = Buffer.byteLength(
    JSON.stringify({
      appliedScope: { types: [...types], object, mode: scoped ? 'scoped' : 'default' },
      byType,
      truncated: true,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(uncheckedTypes.length > 0 ? { uncheckedTypes } : {}),
      ...(analyticsIndexCheck !== undefined ? { analyticsIndexCheck } : {}),
      trust,
    }),
    'utf8',
  );
  const pageByteBudget = Math.max(
    MIN_PAGE_BYTE_BUDGET,
    DATA_ENVELOPE_TARGET_BYTES - fixedPayloadBytes - PAGE_METADATA_RESERVE_BYTES,
  );

  const paged = paginateLegacy(sorted, {
    offset,
    limit,
    byteBudget: pageByteBudget,
    keyOf: (c) => c.id,
    binding: {
      tool: UNUSED_COMPONENTS_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const components = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  const isPaged = truncated || offset > 0;

  return ok({
    data: {
      appliedScope: {
        types: [...types],
        object,
        mode: scoped ? 'scoped' : 'default',
      },
      components,
      byType,
      truncated,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + components.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(uncheckedTypes.length > 0 ? { uncheckedTypes } : {}),
      ...(analyticsIndexCheck !== undefined ? { analyticsIndexCheck } : {}),
      trust,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
