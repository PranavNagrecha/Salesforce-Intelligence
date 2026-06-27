/**
 * Handler for the `sfi.unused_components` MCP tool.
 *
 * The v2.0b headline tool — the buyer-facing answer to admin #7 on the
 * top-10 questions list: "what's unused in this org?". Composes one
 * per-type `listNodesByType` call followed by a per-instance
 * `listEdges(... { direction: 'in' })` check; instances with zero
 * incoming USAGE edges are classified as unused (`parentOf` structural
 * edges and `grantedBy` access grants do not count — see below).
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
 *     500-node pages) so a >500-of-a-type org is fully enumerated, and
 *     the per-instance `listEdges` is a single indexed lookup.
 *     Worst-case, the response is dominated by the CustomField scan
 *     (one DuckDB round-trip per field).
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
  McpError,
  McpResponse,
  Node,
  PageInfo,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { countNodesByType, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildCoverageCaveat,
  offlineTrust,
  type CoverageCaveat,
} from './coverage-trust.js';
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
 * The full superset of ComponentTypes Zod validates against. Mirrors
 * the `ComponentType` union in `@sf-intelligence/contracts`; declared
 * inline so Zod validates against a real enum rather than
 * `z.string()` (clients with a typo learn `invalid-query` instead of
 * receiving an empty list and concluding the org has nothing of that
 * type).
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
 * Zod schema for the `sfi.unused_components` tool input.
 *
 *   - `types`: optional array of `ComponentType` values to scan. When
 *     omitted, the handler falls back to `DEFAULT_UNUSED_TYPES`. An
 *     empty array means "scan nothing" — returns an empty response —
 *     which keeps the boundary predictable.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100 inside
 *     the handler when omitted.
 */
export const unusedComponentsInputSchema = z.object({
  types: z.array(z.enum(COMPONENT_TYPES)).optional(),
  limit: z.number().int().min(1).max(UNUSED_MAX_LIMIT).optional(),
  // CR-22: page cursor for walking the full unused list when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `unusedComponentsInputSchema`. */
export type UnusedComponentsInput = z.infer<
  typeof unusedComponentsInputSchema
>;

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
  /** Provenance / completeness for the absence claim. */
  readonly trust: TrustSummary;
}

/**
 * Referrer families whose absence can FAKE an "unused" verdict: a component
 * is unused only relative to what was retrieved, so incomplete coverage of
 * any family that can reference components must qualify the claim.
 */
const UNUSED_REQUIRED_COVERAGE: readonly string[] = [
  'ApexClass',
  'ApexTrigger',
  'AuraDefinitionBundle',
  'CompactLayout',
  'Dashboard',
  'EmailTemplate',
  'FieldSet',
  'FlexiPage',
  'Flow',
  'Layout',
  'LightningComponentBundle',
  'ListView',
  'QuickAction',
  'Report',
  'SharingRule',
  'ValidationRule',
  'VisualforceComponent',
  'VisualforcePage',
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
 * Decide whether a node is currently classified as "unused". The
 * decision skips `parentOf` (the owning object — structural, not a
 * dependency) and `grantedBy` (a Profile / PermissionSet ACCESS grant —
 * access is not usage: a component nobody references is still unused even
 * when profiles grant access to it; the same split the dead-code /
 * what-if tools make). Any OTHER incoming edge means the component is in
 * use.
 */
const isUnused = async (
  ctx: Context,
  id: ComponentId,
): Promise<Result<boolean, string>> => {
  const edgesResult = await listEdges(ctx.graph, id, { direction: 'in' });
  if (!edgesResult.ok) {
    return err(edgesResult.error.message);
  }
  for (const edge of edgesResult.value) {
    if (edge.edgeType === 'parentOf' || edge.edgeType === 'grantedBy') continue;
    return ok(false);
  }
  return ok(true);
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
 */
const scanType = async (
  ctx: Context,
  type: ComponentType,
): Promise<Result<readonly UnusedComponent[], string>> => {
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
  const nodes: Node[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await listNodesByType(ctx.graph, type, { limit, offset });
    if (!page.ok) {
      return err(page.error.message);
    }
    nodes.push(...page.value);
    if (page.value.length < limit || nodes.length >= totalRes.value) break;
  }
  const note = noteForType(type);
  const isEntryPoint = ENTRY_POINT_TYPES.has(type);
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
      const unusedResult = await isUnused(ctx, node.id);
      if (!unusedResult.ok) {
        return err(unusedResult.error);
      }
      unused = unusedResult.value;
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
  return ok([...out].sort(compareById));
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
  const types = input.types ?? DEFAULT_UNUSED_TYPES;

  const allUnused: UnusedComponent[] = [];
  const byType: Record<string, number> = {};

  for (const type of types) {
    const result = await scanType(ctx, type);
    if (!result.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${result.error}`,
      });
    }
    byType[type] = result.value.length;
    allUnused.push(...result.value);
  }

  const sorted = [...allUnused].sort(compareGlobally);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The one narrowing arg is `types`; argsFingerprint binds the token to it so a
  // token minted for one type set can't be replayed against another.
  const fingerprint = argsFingerprint(
    input.types !== undefined ? { types: input.types } : {},
  );
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

  const paged = paginateLegacy(sorted, {
    offset,
    limit,
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

  // "Unused" is an absence claim: it is only as strong as the coverage of the
  // families that could hold the reference. Incomplete referrer coverage
  // (errored retrieve, scoped refresh, mid-staged-build pending tiers) must
  // qualify the answer — P13-STAGED-absence-battery red without this.
  const coverageCaveat = buildCoverageCaveat(
    ctx,
    UNUSED_REQUIRED_COVERAGE,
    'Unused status',
  );

  return ok({
    data: {
      components,
      byType,
      truncated,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + components.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      trust: offlineTrust(
        ctx,
        coverageCaveat === undefined
          ? { status: 'complete' }
          : { status: 'partial', missingCoverage: coverageCaveat.missingCoverage },
      ),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
