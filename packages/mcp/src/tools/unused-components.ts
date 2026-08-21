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
import { firstNonEmpty, toObjectApiName } from './input-aliases.js';
import { COMPONENT_TYPES } from './list-components.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
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
 *     Contact"). Echoed in `appliedScope`.
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

/** The resolved scan scope: the types to walk and the optional object filter. */
interface ResolvedUnusedScope {
  readonly types: readonly ComponentType[];
  /** Canonical `CustomObject:{ApiName}` object filter, or null when unscoped. */
  readonly objectId: string | null;
  /** Bare object api name for `appliedScope`, or null when unscoped. */
  readonly object: string | null;
  /** Whether the caller narrowed the type set (array OR singular alias). */
  readonly typesExplicit: boolean;
}

/**
 * Resolve the scan scope from the (interchangeable) type + object args, NEVER
 * silently stripping one. Precedence for the TYPE axis: an explicit `types`
 * array (even empty — "scan nothing") wins; else a singular `type` /
 * `componentType` / `typeFilter` alias, validated against the scannable enum
 * (unknown → `invalid-query`, so a bad type is a reasoned error, not a silent
 * fall-through to the default Apex family); else the curated default set. The
 * OBJECT axis reads `object` / `objectApiName` (bare or `CustomObject:` form).
 */
const resolveUnusedScope = (
  input: UnusedComponentsInput,
): Result<ResolvedUnusedScope, McpError> => {
  const rawObject = firstNonEmpty(input.object, input.objectApiName);
  const object = rawObject === undefined ? null : toObjectApiName(rawObject);
  const objectId = object === null ? null : `CustomObject:${object}`;

  if (input.types !== undefined) {
    return ok({ types: input.types, objectId, object, typesExplicit: true });
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
      objectId,
      object,
      typesExplicit: true,
    });
  }
  return ok({
    types: DEFAULT_UNUSED_TYPES,
    objectId,
    object,
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
     *   - `coverage-unknown` — a legacy vault with no coverage rows; which of
     *                        the above applies cannot be determined.
     */
    readonly reason:
      | 'not-retrieved'
      | 'never-modeled'
      | 'confirmed-empty'
      | 'coverage-unknown';
    readonly note: string;
  }[];
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
 * Look up the invisible-references note for a node type, falling
 * back to the generic default when no specific entry is registered.
 */
const noteForType = (type: ComponentType): string =>
  INVISIBLE_REFERENCES_NOTES[type] ?? DEFAULT_INVISIBLE_REFERENCES_NOTE;

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
  const note = noteForType(type);
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
  });
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
): {
  readonly type: string;
  readonly reason:
    | 'not-retrieved'
    | 'never-modeled'
    | 'confirmed-empty'
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

  // Resolve the (interchangeable) type + object scope, NEVER silently stripping
  // one. An unknown singular `type` is `invalid-query`, not a wrong-family list.
  const scopeResult = resolveUnusedScope(input);
  if (!scopeResult.ok) return scopeResult;
  const { types, objectId, object, typesExplicit } = scopeResult.value;

  const allUnused: UnusedComponent[] = [];
  const byType: Record<string, number> = {};
  // UNUSED-UNCHECKED-ZERO-READS-AS-CLEAN: a scanned type with no instances to
  // scan produces `byType[type] = 0` — identical to "checked everything, all in
  // use". Record which zeros were never checked.
  const uncheckedTypes: {
    readonly type: string;
    readonly reason:
      | 'not-retrieved'
      | 'never-modeled'
      | 'confirmed-empty'
      | 'coverage-unknown';
    readonly note: string;
  }[] = [];

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
    if (result.value.vaultInstances === 0) {
      uncheckedTypes.push(classifyUncheckedType(ctx, type));
    }
  }

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
  const coverageCaveat = assertUsageCompleteness(ctx, {
    usageFamilies: UNUSED_REQUIRED_COVERAGE,
    blindPlaneTypes: types,
    purpose: 'Unused status',
    fireOnUnknownCoverage: true,
  }).caveat;

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
      trust,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
