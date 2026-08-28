/**
 * Handler for the `sfi.review_change` MCP tool (R6-16).
 *
 * The daily deploy gate: given a CHANGE SET — a list of change entries a host
 * assembled from a PR / package.xml / `git diff`, each selecting its component
 * with either `{ type, apiName }` or a single `componentId` (`Type:ApiName`) —
 * it
 * turns the offline engine into a pre-deploy review. For each component it
 * composes THREE existing signals (it does not reimplement any of them):
 *
 *   (a) IMPACT — who depends on this. The single-hop INCOMING-edge query that
 *       `sfi.get_impact` / `sfi.promotion_readiness` build on
 *       (`listEdges(direction: 'in')`), EXCLUDING `grantedBy` (a Profile /
 *       PermissionSet FLS grant is ACCESS, not a breakage dependency) and
 *       `parentOf` (a field's parent object is structural, not a dependent) —
 *       the "access ≠ usage" honesty rule the destructive suite already
 *       enforces. The surviving distinct dependents are the blast radius. ONE
 *       exception to the grantedBy exclusion: for a CustomPermission the
 *       inbound `grantedBy` granters (Profile / PermissionSet) reference it BY
 *       NAME, so they ARE breakage dependents and are counted
 *       (REVIEW-CHANGE-SAFE-ON-DELETE-CUSTOM-PERMISSION).
 *   (b) TESTS-TO-RUN — the minimal covering test set, from
 *       `sfi.tests_for_change`'s handler (composed, not duplicated). Only
 *       ApexClass / ApexTrigger components map to tests; everything else is
 *       `not-applicable`.
 *   (c) RISK VERDICT — one of `blocking` / `risky` / `review` / `safe` from the
 *       shared `Verdict` vocabulary + coverage-caveat machinery in
 *       `coverage-trust.ts`. The classification table is explicit below.
 *
 * plus (d) an ordered overall summary (most dangerous first) and a coverage
 * caveat when the vault does not fully model a family named in the changeset —
 * so an empty dependent set for an un-retrieved family reads "not checked", not
 * a proven "nothing depends on it".
 *
 * ## Per-component classification table (verbatim contract)
 *
 * `inVault` = a node exists at `{type}:{apiName}`; `deps` = distinct dependents
 * after the grantedBy/parentOf filter; `allHeuristic` = every surviving
 * incoming edge carries `confidence: 'heuristic'`; `familyCovered` = for a
 * delete/modify with 0 deps, the vault covers every family that could REFERENCE
 * this component (its usage-source families — GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE);
 * for an added component, the component's own family is covered (or unknowable →
 * treated as covered, never false-flagged).
 *
 * | changeKind | condition                                   | verdict  |
 * |------------|---------------------------------------------|----------|
 * | deleted    | deps ≥ 1                                     | blocking |
 * | deleted    | deps = 0, inVault, familyCovered            | safe     |
 * | deleted    | deps = 0, inVault, NOT familyCovered        | review   |
 * | deleted    | NOT inVault                                  | review   |
 * | modified   | deps ≥ 1, NOT allHeuristic                   | risky    |
 * | modified   | deps ≥ 1, allHeuristic                       | review   |
 * | modified   | deps = 0, inVault, familyCovered            | safe     |
 * | modified   | deps = 0, inVault, NOT familyCovered        | review   |
 * | modified   | NOT inVault                                  | review   |
 * | added      | NOT inVault (a genuine new component)        | safe     |
 * | added      | inVault (name collides with an existing id)  | review   |
 *
 * The rationale for each row:
 *   - A DELETED component with ANY dependent is a hard blocker: removing it
 *     breaks its dependents (even a heuristic dependent blocks — a false
 *     positive fails CLOSED, which is the safe direction for a deploy gate; the
 *     reason names the weakest confidence so the operator can dismiss it).
 *   - A MODIFIED component with FIRM (declared/parsed) dependents is `risky`
 *     (real callers/automation may break); with HEURISTIC-ONLY readers it is
 *     `review` (the scanner's inference may be a false positive — verify).
 *   - A zero-dependent DELETE/MODIFY is `safe` only when the vault covers every
 *     family that COULD reference this component (its usage-source families —
 *     GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE); otherwise the absence of dependents
 *     is "not checked" (a family that could hold the reference was never
 *     retrieved / modeled), not proven "none" → `review`, with a `coverageCaveat`
 *     naming the un-retrieved planes. A well-modeled component of a coverage-gap
 *     org is NOT enough — absence of edges is only as strong as the coverage of
 *     the families that produce them.
 *   - An ADDED component absent from the vault is `safe` for the graph — nothing
 *     in the current vault can depend on something new — but its OWN forward
 *     references are NOT analysed (the new source was never extracted); that
 *     boundary is disclosed. An ADDED component whose id ALREADY exists is a
 *     name collision (likely a mislabel or an overwrite) → `review`.
 *   - A component the vault does not contain under a `modified`/`deleted` label
 *     is `review`: either its family is not modeled, or the vault has drifted
 *     from the target org — never fabricate a verdict for a node we cannot see.
 *
 * Frontend-bundle OUTBOUND adjustment (applied AFTER the table above, so the
 * table itself — pinned by `classify`'s unit test — is unchanged): a modified/
 * added LightningComponentBundle / Aura / Visualforce bundle has (almost) no
 * INCOMING dependents, so the table calls it `safe`; but its promotion risk is
 * OUTBOUND — the Apex controller it `callsApex` and the CustomPermission /
 * FlexiPage it `references`. Such a bundle is floored at `review` (never a bare
 * `safe`), `outboundApex` / `outboundWires` name the wiring, and `selectedTests`
 * carries the covering tests of the called controllers (the bundle has no Apex
 * tests of its own). REVIEW-CHANGE-LWC-SAFE-IGNORES-CONTROLLER-AND-PAGE-WIRE.
 *
 * Active-rule adjustment (also AFTER the table, same rationale — leaves
 * `classify`'s table intact): an Active DuplicateRule / MatchingRule fires on
 * record save regardless of who references it — its only inbound edge is the
 * excluded structural `parentOf`, and any MatchingRule link is OUTBOUND — so
 * the inbound gate sees 0 dependents and the table calls a delete/modify
 * `safe`. Removing or deactivating a LIVE rule changes runtime dedup/matching
 * behaviour, so a live rule is floored at `review` (never bare `safe`). The
 * floor is STATE-driven: an inactive rule keeps its table verdict.
 * REVIEW-CHANGE-SAFE-ON-DELETE-DUPLICATE-RULE.
 *
 * Firing-binding adjustment (also AFTER the table, same rationale): an ACTIVE
 * record-triggered (before/after-save) Flow, an ACTIVE ApexTrigger, or an
 * ACTIVE ValidationRule PARTICIPATES in its object's save transaction — but its
 * binding to that object is INVISIBLE to the inbound-dependent gate. A Flow /
 * ApexTrigger binds OUTBOUND via `triggersOn` → CustomObject, and a
 * ValidationRule binds via the object's structural `parentOf` (excluded as a
 * dependent), so the inbound gate sees 0 dependents and the table calls a
 * delete/modify bare `safe` — a false-safe destructive verdict on a live save
 * participant, the highest blast radius. Deleting such a node removes live
 * save-time automation (floored at `blocking`); modifying it changes save-time
 * behaviour (floored at `review`). Liveness reuses the shared `isActiveSoeFirer`
 * predicate (Flow status Active/absent, ApexTrigger status not Inactive,
 * ValidationRule active:true/absent) — an Inactive / Obsolete automation does
 * NOT fire, so it keeps its table verdict (mirrors the dead-plane honesty). The
 * floor only RAISES severity; a real inbound dependent (already `blocking` /
 * `risky`) is left unchanged.
 * REVIEW-CHANGE-RECORD-TRIGGERED-AUTOMATION-FALSE-SAFE.
 *
 * ## Honesty boundaries (verbatim in `disclosure`)
 *   - Analysis is against the LAST VAULT REFRESH of the target org — which may
 *     have drifted from what is actually deployed; re-refresh before trusting a
 *     `safe`.
 *   - Dependents are DIRECT (single-hop) incoming edges only; the full
 *     transitive blast radius is `sfi.get_impact`.
 *   - ADDED components are not analysed for their own contents — only
 *     name-collision + tests mapping.
 *   - Test selection is CLASS-granular and inherits every `tests_for_change`
 *     blind spot (dynamic dispatch, reflection, managed-package tests, depth-3
 *     cap). Selection ≠ validation.
 *
 * ## Cross-vault mode — `againstVault` (R7-C2)
 *
 * The release-manager question is "will this changeset break anything in PROD?"
 * — which the DEFAULT mode cannot answer, because it resolves the changeset
 * against the CURRENT (usually sandbox) vault's graph. When `againstVault` (a
 * registered vault alias OR a path to an `org-kb`) is supplied, the tool opens
 * THAT vault READ-ONLY via the shared cross-vault machinery
 * (`openVaultReadOnly`, the same helper `compare_vaults` uses — never a second
 * writer lock) and computes EVERY signal — dependents, verdict, selected tests,
 * coverage caveat — against ITS graph instead. Composes R6-16 (this tool) with
 * R6-12 (the cross-vault registry + extractor-version caveat).
 *
 * Disclosures unique to this mode (all absent in the default path, which stays
 * byte-identical):
 *   - `againstVault` — the target's alias/path + its `lastRefreshedAt`, and a
 *     prominent `disclosure` prefix: impact is against that vault (its last
 *     refresh), NOT the current one; a `blocking`/`risky` verdict means the
 *     change would break something in THAT org.
 *   - `absentInAgainstVault` — changeset ids labelled modified/deleted that do
 *     NOT exist in the target: relative to it they would be ADDED, so nothing
 *     there can depend on them, but their OWN forward references were not
 *     analysed (same boundary as an added component).
 *   - `extractorVersionCaveat` — present only when the current vault and the
 *     against-vault report different sf-intelligence product versions: a
 *     verdict / edge-set difference MAY reflect an EXTRACTOR change, not a real
 *     difference in the target org (mirrors R6-12).
 */

import { basename, resolve } from 'node:path';

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listEdgesForNodes } from '@sf-intelligence/graph';
import {
  findRegistryRoot,
  loadManifest,
  resolveVault,
  type ExtendedVaultManifest,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { familyWasExtracted } from './absence-disclosure.js';
import {
  resolveAccessParity,
  type AccessParityResult,
} from './access-parity.js';
import {
  buildEnumerationCoverageCaveatFor,
  buildUsageSourceCoverageCaveat,
  offlineTrust,
  type CoverageCaveat,
  type Verdict,
} from './coverage-trust.js';
import { openVaultReadOnly } from './cross-vault-open.js';
import { isActiveSoeFirer } from './soe-active.js';
import {
  testsForChangeHandler,
  type PerChangeCoverage,
} from './tests-for-change.js';

/** The three change kinds a host derives from a diff / manifest / PR. */
export const CHANGE_KINDS = ['added', 'modified', 'deleted'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** Hard cap on the change-set size (matches `tests_for_change` / `meaningful_test_audit`). */
const MAX_CHANGE_SET = 500;

/** Default number of detailed `reviewed[]` rows inlined (summary counts stay full). */
const DEFAULT_LIMIT = 100;

/** Per-component sample caps that bound the response independent of the row cap. */
const DEPENDENT_SAMPLE_CAP = 8;
const TEST_SAMPLE_CAP = 10;

/** Union-of-tests cap so a wide change set can't unbound the top-level list. */
const SELECTED_TESTS_CAP = 200;

/**
 * Types for which an inbound `grantedBy` edge IS a breakage dependency rather
 * than mere access. A Profile / PermissionSet that grants a CustomPermission
 * references it BY NAME (`<customPermissions>`), so deleting the permission
 * breaks those granters (a coordinated deploy fails, or the grant is silently
 * dropped) — the granters are genuine dependents. For a CustomField, by
 * contrast, a `grantedBy` FLS grant is access, not usage (a field with 40
 * grants is NOT "depended on by 40 components"), so it stays excluded.
 * REVIEW-CHANGE-SAFE-ON-DELETE-CUSTOM-PERMISSION.
 */
const GRANTED_BY_IS_DEPENDENCY_TYPES: ReadonlySet<string> = new Set(['CustomPermission']);

/**
 * Whether an inbound edge of `edgeType` counts as a breakage dependent of a
 * changed component of type `changedType` (the "access ≠ usage" honesty rule
 * the destructive suite enforces).
 *   - `parentOf` is ALWAYS excluded (the structural object→field / object→rule
 *     parent is not a dependent).
 *   - `grantedBy` is excluded EXCEPT for {@link GRANTED_BY_IS_DEPENDENCY_TYPES}
 *     (CustomPermission), where the granter references the target by name and a
 *     delete genuinely breaks it.
 *   - every other inbound edge counts.
 */
const isDependencyEdge = (edgeType: string, changedType: string): boolean => {
  if (edgeType === 'parentOf') return false;
  if (edgeType === 'grantedBy') return GRANTED_BY_IS_DEPENDENCY_TYPES.has(changedType);
  return true;
};

/** Apex component types `tests_for_change` can map to a covering test set. */
const APEX_TYPES: ReadonlySet<string> = new Set(['ApexClass', 'ApexTrigger']);

/**
 * REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO.
 *
 * The edge types the covering-test walk this gate composes
 * (`tests_for_change`'s `COVERAGE_EDGE_TYPES`) actually traverses. Anything
 * NOT in this set is a path by which a real test class can exercise a changed
 * component WITHOUT the walk ever seeing it — most commonly a plain
 * `new SomeClass()`, which the Apex edge builder mints as a `references` edge
 * (`properties.mechanism === 'instantiation'`), deliberately NOT as
 * `callsApex` (a constructor is not a method call).
 *
 * The consequence measured on a real production vault: for a modified Apex
 * class the gate returned `testCoverage: 'uncovered'`, `selectedTests: []`,
 * `summary.testsToRun: 0`, `trust.completeness.status: 'complete'` and
 * `trust.limitations: []` — while the SAME payload listed that class's own
 * test class in `dependents`. `uncovered` is an AFFIRMATIVE claim ("no test
 * reaches this"); the walk had only failed to look. A host reading the
 * structured fields tells the developer there are no tests to run.
 *
 * So: a zero produced while an unwalked path from a test exists is
 * `'unknown'`, never `'uncovered'`, the tests are named in a typed field, and
 * the gap downgrades the response's completeness. The walk itself is not
 * widened here — that would mean changing `tests_for_change`'s traversal,
 * which this tool composes and must not reimplement.
 */
const COVERAGE_WALK_EDGE_TYPES: ReadonlySet<string> = new Set([
  'callsApex',
  'dispatchesAsync',
]);

/** Node-id prefix for the only referrer family that can BE an Apex test. */
const APEX_CLASS_ID_PREFIX = 'ApexClass:';

/** Node-id prefix for the other Apex family the reverse search passes through. */
const APEX_TRIGGER_ID_PREFIX = 'ApexTrigger:';

/**
 * Sentinel property proving the refresh CLASSIFIED a class's test-ness. Read
 * through {@link familyWasExtracted} (`hasOwnProperty`) so a vault that never
 * extracted `isTest` is `unknown`, not silently "known not to be a test" —
 * `props['isTest'] !== true` alone collapses NEVER-SCANNED into SCANNED-AND-
 * CLEAN, which is the same defect one layer down.
 */
const IS_TEST_PROPERTY = 'isTest';

/**
 * Node-expansion budget for the reverse search, shared across every row of one
 * request. Bounds the extra graph work on a hub class. Exhausting it NEVER
 * upgrades a zero to a proven one: any not-yet-expanded node that was reached
 * through an unwalked edge is reported as an unchecked referrer instead.
 */
const UNCHECKED_REFERRER_NODE_BUDGET = 600;

/**
 * Decide whether a zero-covering-test result for `selfId` is a CHECKED zero.
 *
 * It is not, if any Apex test class reaches `selfId` over a reverse path that
 * uses at least ONE edge type {@link COVERAGE_WALK_EDGE_TYPES} does not
 * traverse. That is deliberately the whole transitive closure, not the direct
 * referrers: the shape measured on a real vault is TWO hops — a test class
 * `callsApex` a production class, and THAT class instantiates the changed one
 * (`references`, mechanism `instantiation`). A depth-1 check certifies such a
 * class `uncovered` while its eponymous test class exercises it.
 *
 * Reverse BFS from `selfId` over INBOUND edges whose source is an Apex node,
 * carrying one bit of state per visit: whether the path so far used an
 * unwalked edge. A class flagged `isTest: true` — or one carrying NO extracted
 * `isTest` property, because never-extracted is not "known not a test" (R1) —
 * is a SINK: recorded when reached dirty, never traversed THROUGH, matching
 * `tests_for_change`'s own "a test class is a coverage sink" rule. An edge
 * whose source class is not in the vault at all is treated the same way — a
 * referrer we cannot read is not a referrer we can rule out. `selfId` is
 * excluded outright (R3 self-match). A node reached over walked edges only is
 * still expanded, because the unwalked edge may be further upstream, but it is
 * never itself reported — the walk already had its chance at it.
 *
 * Returns the test classes that make the zero unproven. Empty ⇒ the zero is
 * checked (within {@link UNCHECKED_REFERRER_NODE_BUDGET} and the walk's own
 * depth-3 cap, both disclosed in `boundaries`).
 */
const collectUncheckedTestReferrers = async (
  selfId: ComponentId,
  inboundEdges: readonly Edge[],
  loadNode: (id: ComponentId) => Promise<Result<Node | null, McpError>>,
  loadInbound: (
    ids: readonly ComponentId[],
  ) => Promise<Result<ReadonlyMap<ComponentId, readonly Edge[]>, McpError>>,
  budget: { remaining: number },
): Promise<Result<readonly ComponentId[], McpError>> => {
  const dirtyTests = new Set<ComponentId>();
  const seenClean = new Set<ComponentId>([selfId]);
  const seenDirty = new Set<ComponentId>();
  let level: readonly { readonly dirty: boolean; readonly edges: readonly Edge[] }[] = [
    { dirty: false, edges: inboundEdges },
  ];
  while (level.length > 0) {
    const next: { id: ComponentId; dirty: boolean }[] = [];
    for (const cur of level) {
      for (const e of cur.edges) {
        const from = e.fromId;
        if (from === selfId) continue;
        const isClass = from.startsWith(APEX_CLASS_ID_PREFIX);
        if (!isClass && !from.startsWith(APEX_TRIGGER_ID_PREFIX)) continue;
        const dirty = cur.dirty || !COVERAGE_WALK_EDGE_TYPES.has(e.edgeType);
        if ((dirty ? seenDirty : seenClean).has(from)) continue;
        (dirty ? seenDirty : seenClean).add(from);
        if (isClass) {
          const res = await loadNode(from);
          if (!res.ok) return res;
          const referrer = res.value;
          const classified =
            referrer !== null && familyWasExtracted(referrer.properties, IS_TEST_PROPERTY);
          if (!classified || referrer?.properties[IS_TEST_PROPERTY] === true) {
            // Test, or test-ness never extracted: a SINK either way.
            if (dirty) dirtyTests.add(from);
            continue;
          }
        }
        next.push({ id: from, dirty });
      }
    }
    if (next.length === 0) break;
    if (next.length > budget.remaining) {
      // Out of budget. Everything reached over an unwalked edge and never
      // expanded is reported, so the zero stays unproven rather than being
      // silently certified. What is dropped is the CLEAN frontier — nodes
      // reachable only over `callsApex` / `dispatchesAsync`, which is exactly
      // the territory the composed walk owns and whose depth-3 cap `boundaries`
      // already discloses. Exhaustion can therefore only ever ADD `unknown`
      // rows, never manufacture an `uncovered` one.
      for (const n of next) if (n.dirty) dirtyTests.add(n.id);
      break;
    }
    budget.remaining -= next.length;
    const edgeRes = await loadInbound(next.map((n) => n.id));
    if (!edgeRes.ok) return edgeRes;
    level = next.map((n) => ({ dirty: n.dirty, edges: edgeRes.value.get(n.id) ?? [] }));
  }
  return ok(sortIds(dirtyTests));
};

/** The typed limitation a response carries when any row's coverage is unknown. */
const unknownTestCoverageLimitation = (rows: number): string =>
  `Test coverage could not be determined for ${rows} changed Apex component(s): an Apex test ` +
  'class reaches them over a path that uses at least one edge the covering-test walk does not ' +
  'traverse (a `new SomeClass()` is minted as `references`, not `callsApex`/`dispatchesAsync`), ' +
  'either directly or through a production class in between. Those rows read ' +
  '`testCoverage: "unknown"` and name the tests in `uncheckedTestReferrers`; ' +
  '`summary.testsToRun` and `selectedTests` UNDER-report what must run. Run those test classes ' +
  'too, or the full suite — an empty selection here is NOT "no tests cover this change".';

/** The `missingCoverage` marker for the same gap, for a machine consumer. */
const UNKNOWN_TEST_COVERAGE_MARKER =
  'test-coverage mapping (the callsApex / dispatchesAsync covering-test walk)';

/**
 * Frontend bundle types whose promotion risk is OUTBOUND, not inbound. A
 * modified LWC/Aura/VF rarely has incoming dependents (nothing edges TO the
 * bundle id), so the incoming-only gate calls it `safe`; its real risk is the
 * Apex controller it `callsApex`, plus the CustomPermission / FlexiPage wiring
 * it references (REVIEW-CHANGE-LWC-SAFE-IGNORES-CONTROLLER-AND-PAGE-WIRE).
 */
const FRONTEND_BUNDLE_TYPES: ReadonlySet<string> = new Set([
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
]);

/** Outbound `references` targets treated as UI/permission wiring for a bundle. */
const WIRE_REF_PREFIXES = ['CustomPermission:', 'FlexiPage:'] as const;

/**
 * Save-time behavioral rules whose runtime effect is INVISIBLE to the
 * inbound-dependent scan. An Active DuplicateRule / MatchingRule fires on
 * insert/update regardless of who "references" it: the rule's only inbound
 * edge is the structural `parentOf` from its object (excluded), and its
 * MatchingRule link is OUTBOUND — so the inbound gate sees 0 dependents and
 * calls a delete/deactivate of a LIVE rule `safe`. Removing or deactivating a
 * live rule changes runtime dedup/matching behaviour, a real dependency the
 * graph cannot express as an inbound edge. REVIEW-CHANGE-SAFE-ON-DELETE-DUPLICATE-RULE.
 */
const ACTIVE_BEHAVIORAL_RULE_TYPES: ReadonlySet<string> = new Set([
  'DuplicateRule',
  'MatchingRule',
]);

/**
 * Integration / callout-trust anchors whose zero-dependent DELETE/MODIFY must
 * fail HARDER than the default gate (W11 — INTEGRATION-ORPHAN-UNDER-THE-GATE).
 *
 * A NamedCredential / ExternalDataSource / AuthProvider is only ever referenced
 * on the callout plane (an Apex `callout:{alias}`, a declared ExternalService
 * binding, an OmniStudio Integration Procedure alias, or an `authProvider`
 * naming), which is the plane most prone to under-extraction — dynamic
 * `callout:` strings and managed-package Apex are invisible to the graph.
 * Deleting a live callout credential is an availability / security risk, so for
 * these types alone the completeness gate uses the fail-harder
 * `fireOnUnknownCoverage` stance (the same stance `safe_to_delete_field` /
 * `unused_components` take): an unused credential on a vault whose callout-usage
 * coverage is UNKNOWN (a pre-coverage / legacy vault) is `review`, never bare
 * `safe`. The precise callout-site families live in `USAGE_SOURCE_FAMILIES`
 * (coverage-trust.ts) so a KNOWN-complete callout plane still reads `safe`.
 */
const INTEGRATION_GATE_TYPES: ReadonlySet<string> = new Set([
  'NamedCredential',
  'ExternalDataSource',
  'AuthProvider',
]);

/**
 * True when the changed component is a save-time behavioral rule that is LIVE.
 * DuplicateRule liveness is `properties.isActive === true`; MatchingRule
 * liveness is `properties.ruleStatus` (`Active` / `Activating` are live; the
 * transient activation states and `Inactive` / `Draft` are not).
 */
const isActiveBehavioralRule = (type: string, node: Node | null): boolean => {
  if (node === null || !ACTIVE_BEHAVIORAL_RULE_TYPES.has(type)) return false;
  if (type === 'DuplicateRule') return node.properties['isActive'] === true;
  const status = node.properties['ruleStatus'];
  return status === 'Active' || status === 'Activating';
};

/**
 * Save-time automation types whose runtime binding to their object is OUTBOUND
 * (`triggersOn` → CustomObject, for a record-triggered Flow / ApexTrigger) or
 * STRUCTURAL (`parentOf` from the object, for a ValidationRule) — NEVER an
 * inbound usage edge. An ACTIVE such node PARTICIPATES in its object's save
 * transaction (a before/after-save Flow, an Apex before/after trigger, or a
 * ValidationRule that gates every save), so the inbound-dependent gate sees 0
 * dependents and the classification table calls a delete/modify bare `safe` —
 * a false-safe destructive verdict. Its firing is a real dependency the graph
 * cannot express as an inbound edge (the same shape as an Active DuplicateRule,
 * but the binding is on the OUTBOUND / structural side). Liveness reuses the
 * shared {@link isActiveSoeFirer} predicate (Flow status Active/absent,
 * ApexTrigger status not Inactive, ValidationRule active:true/absent), so an
 * Inactive / Obsolete automation is NOT a firing binding — it does not run, and
 * keeps its table verdict (mirrors the dead-plane honesty).
 * REVIEW-CHANGE-RECORD-TRIGGERED-AUTOMATION-FALSE-SAFE.
 */
const FIRING_BINDING_TYPES: ReadonlySet<string> = new Set([
  'Flow',
  'ApexTrigger',
  'ValidationRule',
]);

/** The save-time firing binding a changed node participates in, if any. */
interface FiringBinding {
  readonly kind: 'record-triggered-flow' | 'apex-trigger' | 'validation-rule';
  /** The CustomObject id the automation fires on, when resolvable; else null. */
  readonly objectId: ComponentId | null;
}

/**
 * Detect whether `node` is an ACTIVE automation that FIRES on its object's save
 * — a runtime binding the inbound-dependent gate is blind to. Returns the
 * binding (with the bound object id when resolvable) or `null`. See
 * {@link FIRING_BINDING_TYPES}. Only called for delete/modify of a
 * firing-binding type on an in-vault node; an `added` node has no live binding
 * yet.
 *
 *   - Flow — an ACTIVE record-SAVE Flow (`triggerType` RecordBeforeSave /
 *     RecordAfterSave) with an OUTBOUND `triggersOn` edge to a CustomObject.
 *     A scheduled / platform-event / screen Flow (no save triggerType) is NOT
 *     floored — it does not participate in a record's save transaction.
 *   - ApexTrigger — an ACTIVE trigger with an OUTBOUND `triggersOn` edge to a
 *     CustomObject (Apex triggers are inherently DML/save-time).
 *   - ValidationRule — an ACTIVE rule parented by a CustomObject (inbound
 *     `parentOf`, the edge the dependent filter excludes as structural). A live
 *     VR gates every save of its object.
 */
const detectFiringBinding = async (
  ctx: Context,
  type: string,
  node: Node,
  id: ComponentId,
  inboundEdges: readonly Edge[],
): Promise<Result<FiringBinding | null, McpError>> => {
  if (!FIRING_BINDING_TYPES.has(type) || !isActiveSoeFirer(node)) return ok(null);

  if (type === 'ValidationRule') {
    // A VR fires on save for the CustomObject that PARENTS it — inbound
    // `parentOf` from a CustomObject (excluded from dependents as structural).
    const parent = inboundEdges.find(
      (e) => e.edgeType === 'parentOf' && e.fromId.startsWith('CustomObject:'),
    );
    return ok(parent !== undefined ? { kind: 'validation-rule', objectId: parent.fromId } : null);
  }

  // Flow / ApexTrigger bind OUTBOUND via `triggersOn` → CustomObject.
  if (type === 'Flow') {
    const triggerType = node.properties['triggerType'];
    if (triggerType !== 'RecordBeforeSave' && triggerType !== 'RecordAfterSave') {
      return ok(null);
    }
  }
  const outRes = await listEdges(ctx.graph, id, { direction: 'out', edgeType: 'triggersOn' });
  if (!outRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${outRes.error.message}` });
  }
  const bind = outRes.value.find((e) => e.toId.startsWith('CustomObject:'));
  if (bind === undefined) return ok(null);
  return ok({
    kind: type === 'Flow' ? 'record-triggered-flow' : 'apex-trigger',
    objectId: bind.toId,
  });
};

/** Build the verdict reason for a floored active firing binding. */
const buildFiringBindingReason = (
  type: string,
  changeKind: ChangeKind,
  binding: FiringBinding,
): string => {
  const on = binding.objectId !== null ? ` for ${binding.objectId}` : '';
  const verb = changeKind === 'deleted' ? 'Deleting' : 'Modifying';
  const descriptor =
    binding.kind === 'record-triggered-flow'
      ? `Active record-triggered (before/after-save) Flow that fires on save${on}`
      : binding.kind === 'apex-trigger'
        ? `Active ApexTrigger that fires on save${on}`
        : `Active ValidationRule that gates every save${on}`;
  return (
    `${descriptor} — it PARTICIPATES in that object's save transaction via a firing binding the inbound-dependent gate is blind to ` +
    `(the binding is OUTBOUND \`triggersOn\` for a Flow/Trigger, or the structural \`parentOf\` from the object for a ValidationRule, so the gate shows 0 inbound dependents), NOT an inbound usage edge. ` +
    `${verb} or deactivating a live save participant changes production save-time behaviour — review the firing binding before deploying.`
  );
};

/** Verbatim honesty disclosure surfaced on every response. */
export const REVIEW_CHANGE_DISCLOSURE =
  'review_change is a pre-deploy gate over the LAST VAULT REFRESH of the target org — the vault can have DRIFTED from what is actually deployed, so a `safe` verdict is only as fresh as the last `sfi refresh`; re-refresh before trusting it. Dependents are DIRECT (single-hop) INCOMING edges, EXCLUDING grantedBy (a Profile/PermissionSet FLS grant is ACCESS, not a breakage dependency) and parentOf (a structural object→field parent) per the access≠usage rule — the full transitive blast radius is sfi.get_impact. ONE exception to the grantedBy exclusion: for a CustomPermission the inbound grantedBy granters (Profile/PermissionSet) reference it BY NAME, so they ARE counted as dependents (deleting the permission breaks those granters). A DELETED component with ANY dependent is `blocking` (removing it breaks its dependents; a heuristic-only dependent still blocks — a false positive fails CLOSED, the safe direction for a gate). An Active DuplicateRule / MatchingRule fires on record save regardless of inbound references (parentOf is structural; any MatchingRule link is outbound), so a delete/modify the inbound gate would call `safe` is floored at `review` (never bare `safe`) when the rule is LIVE — an inactive rule keeps its table verdict. Likewise an ACTIVE record-triggered (before/after-save) Flow, an ACTIVE ApexTrigger, or an ACTIVE ValidationRule PARTICIPATES in the save transaction of its object via a binding the inbound-dependent gate is blind to — the Flow/Trigger binds OUTBOUND (`triggersOn` → object) and the ValidationRule binds via the excluded structural `parentOf` — so the gate shows 0 dependents; deleting such a live save participant is floored at `blocking` and modifying one at `review` (never bare `safe`), while an inactive/Obsolete automation keeps its table verdict (it does not fire). A MODIFIED component with firm (declared/parsed) dependents is `risky`; with heuristic-only readers it is `review` (verify the scanner inference). ADDED components are NOT analysed for their own contents — only name-collision (id already in the vault) + tests mapping; their forward references were never extracted. A component the vault does not contain under a modified/deleted label is `review`, never fabricated. Test selection composes sfi.tests_for_change: CLASS granularity, dynamic dispatch / reflection / managed-package tests invisible, depth-3 capped — SELECTION ≠ VALIDATION (a selected test that merely runs the changed code does not prove correctness). That walk follows only `callsApex` / `dispatchesAsync`, so a test that exercises a class through a plain `new SomeClass()` (minted as `references`, mechanism `instantiation`) is INVISIBLE to it — DIRECTLY, or with a production class in between (a test calls a helper and the helper instantiates the changed class). Before reporting a zero this gate therefore reverse-searches the WHOLE inbound Apex closure of the component for a test class reachable over a path that uses at least one unwalked edge; when one exists the row reads `testCoverage: "unknown"` (NEVER `uncovered`), names those test classes in `uncheckedTestReferrers`, is counted in `summary.unknownTestCoverage` rather than `uncoveredApex`, and downgrades `trust.completeness` with a `trust.limitations` entry — an empty selected-test list is then "not checked", never "no tests cover this change". The reverse search is node-budgeted, and exhausting the budget reports the unexpanded unwalked referrers as `unknown` rather than certifying. A remaining `uncovered` is therefore a zero over the extracted Apex edges only: it is still NOT proof of no coverage where the extractor never saw the call at all (dynamic dispatch / `Type.forName` / reflection / managed-package tests) or where the covering chain exceeds the composed walk’s depth-3 cap. A zero-dependent DELETE/MODIFY is "not checked", not "none", unless the vault covers every family that COULD reference the component (its usage-source families — a VisualforcePage is placed by a CustomSite, a CompactLayout is assigned by a CustomObject, a Screen Flow is embedded on a FlexiPage); a gap in any of those planes is surfaced as coverageCaveat and downgrades an otherwise-safe verdict to `review`, because absence of inbound edges is only as strong as the coverage of the families that produce them. FRONTEND BUNDLES (LightningComponentBundle / Aura / Visualforce) carry OUTBOUND risk the inbound-dependent model misses: a modified/added bundle with (almost) no incoming dependents is floored at `review` (never a bare `safe`) when it `callsApex` a controller or `references` a CustomPermission / FlexiPage — `outboundApex` / `outboundWires` name them, and `selectedTests` carries the covering tests of the Apex controllers it calls (its own bundle has no Apex tests).';

/**
 * Zod schema for the `sfi.review_change` tool input.
 *
 *   - `components`: 1..500 change entries. Each carries `changeKind` plus its
 *     selector — EITHER the explicit `{ type, apiName }` pair OR a single
 *     `componentId` (`Type:ApiName`, the canonical id a host gets back from
 *     `sfi.resolve`). Both are normalised at the schema layer to the same
 *     `{ type, apiName, changeKind }`; the canonical id analysed is
 *     `${type}:${apiName}`. The pair wins when both are supplied.
 *   - `limit`: optional cap on the DETAILED `reviewed[]` rows (1..500,
 *     default 100). Summary tallies always cover the full set, and the
 *     most-dangerous components sort first, so the deploy-gate verdict is never
 *     hidden by the cap.
 *   - `againstVault`: optional registered vault alias OR path to an `org-kb`.
 *     When present, the changeset is resolved and its impact/verdict computed
 *     against THAT vault's dependency graph (e.g. PROD) instead of the current
 *     one — see the module JSDoc's cross-vault section. Omitted → default
 *     (current-vault) behaviour, byte-for-byte unchanged.
 *   - `checkAccessParity`: optional flag (default false). When true, an ADDITIVE
 *     `accessParity` section is emitted — the grant-completeness ("ships for
 *     nobody") check: each ADDED/MODIFIED CustomField / CustomObject that
 *     resolves to ZERO modeled grants is flagged as a feature that would deploy
 *     invisible (no permission set / profile grants it). Omitted / false →
 *     output is byte-for-byte unchanged; the section is absent.
 */
export const reviewChangeInputSchema = z.object({
  components: z
    .array(
      z
        .object({
          type: z.string().min(1).optional(),
          apiName: z.string().min(1).optional(),
          componentId: z.string().min(1).optional(),
          changeKind: z.enum(CHANGE_KINDS),
        })
        .superRefine((val, ctx) => {
          // Accept EITHER the explicit { type, apiName } pair OR a single
          // `componentId` (`Type:ApiName`) — hosts naturally forward the
          // canonical id from `sfi.resolve`. The pair wins when both are given.
          const hasPair = val.type !== undefined && val.apiName !== undefined;
          if (hasPair) return;
          if (val.componentId === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['type'],
              message:
                'each change entry needs `{ type, apiName }` OR `componentId` (`Type:ApiName`)',
            });
            return;
          }
          const idx = val.componentId.indexOf(':');
          if (idx <= 0 || idx >= val.componentId.length - 1) {
            ctx.addIssue({
              code: 'custom',
              path: ['componentId'],
              message:
                'componentId must be `Type:ApiName` (a colon that is neither the first nor last character)',
            });
          }
        })
        .transform((val) => {
          // Normalise to the canonical { type, apiName, changeKind } shape so
          // ALL downstream code (canonicalId, reviewed[] output) is byte-
          // unchanged whichever selector the host supplied.
          if (val.type !== undefined && val.apiName !== undefined) {
            return { type: val.type, apiName: val.apiName, changeKind: val.changeKind };
          }
          const id = val.componentId as string;
          const idx = id.indexOf(':');
          return { type: id.slice(0, idx), apiName: id.slice(idx + 1), changeKind: val.changeKind };
        }),
    )
    .min(1)
    .max(MAX_CHANGE_SET),
  limit: z.number().int().min(1).max(MAX_CHANGE_SET).optional(),
  againstVault: z.string().min(1).optional(),
  checkAccessParity: z.boolean().optional(),
});

/** Parsed input shape. */
export type ReviewChangeInput = z.infer<typeof reviewChangeInputSchema>;

/**
 * Whether a changed Apex component is reached by a test (or is not Apex at all).
 *
 *   - `covered` — the covering-test walk found at least one test class.
 *   - `uncovered` — the walk found none AND no test class reaches the
 *     component anywhere in its inbound Apex closure over a path using an
 *     edge the walk cannot follow. A zero over the EXTRACTED edges — see
 *     {@link ReviewChangeSummary.uncoveredApex} for what that still excludes.
 *   - `unknown` — the walk found none, but a class that is (or may be) a test
 *     reaches the component over such a path, directly or through production
 *     classes in between; see `uncheckedTestReferrers`. NOT a claim that no
 *     test covers this. REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO.
 *   - `not-applicable` — the component is not Apex, so no test maps to it.
 */
export type TestCoverageStatus = 'covered' | 'uncovered' | 'unknown' | 'not-applicable';

/** The review outcome for one component in the change set. */
export interface ReviewedComponent {
  readonly id: ComponentId;
  readonly type: string;
  readonly apiName: string;
  readonly changeKind: ChangeKind;
  /** Headline severity — one of blocking / risky / review / safe. */
  readonly verdict: ChangeVerdict;
  /** Human-readable justification for the verdict (names counts + confidence). */
  readonly reason: string;
  /** True when a node exists at this id in the vault. */
  readonly inVault: boolean;
  /** Distinct DIRECT dependents after the grantedBy/parentOf filter. */
  readonly dependentCount: number;
  /** Up to {@link DEPENDENT_SAMPLE_CAP} example dependents (sorted ASC). */
  readonly dependents: readonly ComponentId[];
  /** Weakest edge confidence among the surviving dependents; null when none. */
  readonly weakestDependentConfidence: Edge['confidence'] | null;
  /**
   * DISTINCT covering tests selected for this component — the FULL total, never
   * reduced by the {@link TEST_SAMPLE_CAP} sample below (the `dependentCount` /
   * `dependents` pair, one field up). Compare against `selectedTests.length` to
   * tell a complete list from a truncated sample: `testCoverage` is a
   * three-value enum that carries no number, and `summary.testsToRun` is the
   * union across the WHOLE change set, so neither recovers this row's total.
   * REVIEW-CHANGE-SELECTED-TESTS-SILENT-TRUNCATION.
   */
  readonly selectedTestCount: number;
  /**
   * Up to {@link TEST_SAMPLE_CAP} covering tests to run for this component
   * (sorted ASC) — a SAMPLE, not the whole set; `selectedTestCount` is the
   * total. For Apex, the component's own covering tests; for a frontend bundle
   * (LWC/Aura/VF), the covering tests of the Apex controllers it `callsApex`
   * (its outbound risk). The top-level `selectedTests` union (capped at
   * {@link SELECTED_TESTS_CAP}, total in `summary.testsToRun`) is the set to
   * run for the change set as a whole.
   */
  readonly selectedTests: readonly ComponentId[];
  readonly testCoverage: TestCoverageStatus;
  /**
   * Apex test classes that reach this component over a path using at least one
   * edge type the covering-test walk (`callsApex` / `dispatchesAsync`) does
   * not traverse — in practice a `new SomeClass()` instantiation, which the
   * Apex edge builder mints as `references` (`mechanism: 'instantiation'`).
   * The path may run THROUGH production classes, so a direct referrer of this
   * component is not necessarily listed; the test class at the far end is.
   * A class carrying no extracted `isTest` property counts as a possible test
   * (never-extracted is not "known not a test"). When the reverse search hits
   * its node budget, the unexpanded classes reached over an unwalked edge are
   * listed instead of being silently dropped.
   *
   * RUN THESE. They are exactly what `selectedTests` could not see.
   *
   * Present ONLY when non-empty, and non-empty IFF `testCoverage` is
   * `'unknown'` — the pair is the machine-readable form of "I found no
   * covering test, and here is what I could not look at".
   * REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO.
   */
  readonly uncheckedTestReferrers?: readonly ComponentId[];
  /**
   * Frontend bundles only: the Apex classes this bundle `callsApex` (outbound
   * risk the inbound-dependent gate misses). Sample-capped. Absent otherwise.
   */
  readonly outboundApex?: readonly ComponentId[];
  /**
   * Frontend bundles only: CustomPermission / FlexiPage wiring the bundle
   * `references` (placement / visibility gates). Sample-capped. Absent otherwise.
   */
  readonly outboundWires?: readonly ComponentId[];
  /** Present when this component's family is not fully covered by the vault. */
  readonly coverageCaveat?: CoverageCaveat;
}

/** Roll-up tallies across the FULL change set (never reduced by the row cap). */
export interface ReviewChangeSummary {
  readonly total: number;
  readonly blocking: number;
  readonly risky: number;
  readonly review: number;
  readonly safe: number;
  /** Union of covering tests across the whole set. */
  readonly testsToRun: number;
  /**
   * Changed Apex components no test reaches over ANY extracted inbound Apex
   * edge — neither the covering-test walk (`callsApex` / `dispatchesAsync`)
   * nor an unwalked `references` path from a test class. Rows whose coverage
   * could not be decided are counted in
   * {@link ReviewChangeSummary.unknownTestCoverage} instead, so this number
   * never launders a not-checked zero as a checked one.
   *
   * Still an UPPER BOUND on the truly unguarded surface, NOT a proof: coverage
   * the extractor never minted an edge for (dynamic dispatch, reflection,
   * managed-package tests) and chains longer than the composed walk's depth-3
   * cap are invisible to every search here. It over-reports risk, which is the
   * safe direction for a gate — it must never under-report it.
   */
  readonly uncoveredApex: number;
  /**
   * Changed Apex components whose test coverage could NOT be determined: a test
   * class reaches them only through an edge the covering-test walk does not
   * traverse (see each row's `uncheckedTestReferrers`). Disjoint from
   * `uncoveredApex`. Non-zero ⇒ `trust.completeness` is downgraded and
   * `trust.limitations` names the gap.
   * REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO.
   */
  readonly unknownTestCoverage: number;
  /** Components labelled modified/deleted but absent from the vault. */
  readonly notInVault: number;
  /** True when more components exist than the inlined `reviewed[]` rows. */
  readonly truncated: boolean;
}

/**
 * Describes the vault the review was computed AGAINST when `againstVault` is
 * supplied (R7-C2). Absent in the default (current-vault) path.
 */
export interface AgainstVaultInfo {
  /** The alias (registry) or directory basename (path) the caller named. */
  readonly alias: string;
  /** Absolute path to the against-vault's `org-kb`. */
  readonly path: string;
  /** How the `againstVault` string resolved. */
  readonly resolvedFrom: 'alias' | 'path';
  /** The against-vault's last refresh (its `meta/manifest.json`), or null. */
  readonly lastRefreshedAt: string | null;
  /** The against-vault's source-tree hash, or null. */
  readonly sourceTreeHash: string | null;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ReviewChangeOutput {
  /** Reviewed components, most-dangerous first, capped at `limit`. */
  readonly reviewed: readonly ReviewedComponent[];
  /** The most severe verdict across the FULL set. */
  readonly overallVerdict: ChangeVerdict;
  readonly summary: ReviewChangeSummary;
  /** Union of covering tests to run (sorted ASC, capped). */
  readonly selectedTests: readonly ComponentId[];
  readonly recommendation: string;
  /** Present when a family in the changeset is not fully modeled by the vault. */
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * Grant-completeness ("ships for nobody") check. Present ONLY when the caller
   * sets `checkAccessParity: true` (additive — absent by default, so the default
   * response is byte-for-byte unchanged). Each ADDED/MODIFIED custom
   * field/object that resolves to ZERO modeled grants is a candidate feature
   * that would deploy invisible (no permission set / profile grants it).
   */
  readonly accessParity?: AccessParityResult;
  readonly trust: TrustSummary;
  readonly disclosure: string;
  readonly boundaries: readonly string[];
  /**
   * R7-C2: present ONLY when `againstVault` was supplied — the vault whose
   * graph produced every dependent / verdict / test below (NOT the current
   * vault). Absent in the default path.
   */
  readonly againstVault?: AgainstVaultInfo;
  /**
   * R7-C2: present ONLY in `againstVault` mode — changeset ids labelled
   * modified/deleted that are ABSENT from the against-vault. Relative to it
   * they would be ADDED (nothing there depends on them), and their OWN
   * contents were not analysed. Full set (never trimmed by `limit`).
   */
  readonly absentInAgainstVault?: readonly ComponentId[];
  /**
   * R7-C2: present ONLY when the current vault and the against-vault report
   * different sf-intelligence product versions — a verdict / edge-set
   * difference MAY reflect an EXTRACTOR change, not a real org difference
   * (mirrors R6-12).
   */
  readonly extractorVersionCaveat?: string;
}

/**
 * The verdicts `review_change` can actually produce.
 *
 * It classifies CHANGE risk from dependency STRUCTURE, so it uses the five
 * structural words only. `already-inactive` is a RUNTIME-STATE verdict owned by
 * the `what_if_*` deactivation tools ("this component does not run today"), and
 * a changeset review has no such axis. Excluding it keeps `VERDICT_RANK` and
 * the summary tally EXHAUSTIVE BY CONSTRUCTION — the alternative was carrying a
 * bucket that is permanently zero, which would show up in every caller's
 * summary as a category this tool never assigns.
 *
 * Derived from the shared union with `Exclude`, never re-listed, so a future
 * member added to `Verdict` is a compile error here rather than a silent gap.
 */
type ChangeVerdict = Exclude<Verdict, 'already-inactive'>;

/** Severity rank for the "most dangerous first" sort (lower = worse). */
const VERDICT_RANK: Readonly<Record<ChangeVerdict, number>> = {
  blocking: 0,
  risky: 1,
  review: 2,
  unknown: 3,
  safe: 4,
};

const sortIds = (ids: Iterable<ComponentId>): ComponentId[] =>
  [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Weakest (most cautious) confidence across a set of edges. `heuristic` is
 * weaker than `parsed`, which is weaker than `declared`. Returns null for an
 * empty set. Used both for the `risky` vs `review` split on a MODIFIED
 * component and to name the confidence in the verdict reason.
 */
const CONFIDENCE_RANK: Readonly<Record<Edge['confidence'], number>> = {
  heuristic: 0,
  parsed: 1,
  declared: 2,
};

const weakestConfidence = (edges: readonly Edge[]): Edge['confidence'] | null => {
  let weakest: Edge['confidence'] | null = null;
  for (const e of edges) {
    if (weakest === null || CONFIDENCE_RANK[e.confidence] < CONFIDENCE_RANK[weakest]) {
      weakest = e.confidence;
    }
  }
  return weakest;
};

/** Build the canonical id a change entry resolves against. */
const canonicalId = (type: string, apiName: string): ComponentId =>
  `${type}:${apiName}` as ComponentId;

/**
 * Internal result of {@link runReviewCore}: the assembled response data PLUS
 * the FULL (pre-`limit`) reviewed array, which the `againstVault` augmentation
 * needs to compute `absentInAgainstVault` over the whole set (not just the
 * inlined rows), and the `vaultState` of the graph actually walked.
 */
interface CoreReview {
  readonly data: ReviewChangeOutput;
  readonly reviewedFull: readonly ReviewedComponent[];
  readonly vaultState: McpResponse<ReviewChangeOutput>['vaultState'];
}

/**
 * The per-component review over ONE graph — the `ctx` passed in, which is
 * either the server's own vault or, in `againstVault` mode, a shadow context
 * whose `graph` / `manifest` belong to the against-vault. Composes
 * `get_impact`'s underlying incoming-edge query, `tests_for_change`, and the
 * coverage-trust verdict machinery into a per-component deploy review. Returns
 * the FULL reviewed array alongside the response so the caller can disclose
 * cross-vault-absent ids without re-walking the graph.
 */
const runReviewCore = async (
  ctx: Context,
  components: ReviewChangeInput['components'],
  limitInput: number | undefined,
  checkAccessParity: boolean,
): Promise<Result<CoreReview, McpError>> => {
  const limit = limitInput ?? DEFAULT_LIMIT;

  // Pre-pass: resolve every component's node ONCE, and for FRONTEND bundles
  // (LWC/Aura/VF) also read the OUTBOUND wiring the inbound-dependent gate is
  // blind to — the Apex controllers the bundle `callsApex`, and the
  // CustomPermission / FlexiPage placement it `references`. The Apex callees
  // are folded into the tests_for_change scoring below so a bundle's verdict can
  // select the controller's covering tests
  // (REVIEW-CHANGE-LWC-SAFE-IGNORES-CONTROLLER-AND-PAGE-WIRE).
  interface Prepared {
    readonly change: ReviewChangeInput['components'][number];
    readonly id: ComponentId;
    readonly node: Node | null;
    readonly outboundApex: readonly ComponentId[];
    readonly outboundWires: readonly ComponentId[];
  }
  const prepared: Prepared[] = [];
  const frontendCalleeApexIds = new Set<ComponentId>();
  // One node cache for the whole core pass, shared with the unwalked-referrer
  // detector below (a referrer named by several changed components is fetched
  // once). Mirrors `tests_for_change`'s own `loadNode`.
  const nodeCache = new Map<ComponentId, Node | null>();
  const loadNode = async (nodeId: ComponentId): Promise<Result<Node | null, McpError>> => {
    const cached = nodeCache.get(nodeId);
    if (cached !== undefined) return ok(cached);
    const res = await getNodeById(ctx.graph, nodeId);
    if (!res.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${res.error.message}` });
    }
    nodeCache.set(nodeId, res.value);
    return ok(res.value);
  };
  // Batched inbound-edge fetch for the unwalked-referrer reverse search — ONE
  // query per BFS level, not one per node. `listEdgesForNodes` is the shared
  // module that already reproduces N `listEdges(id, {direction:'in'})` calls.
  const loadInbound = async (
    ids: readonly ComponentId[],
  ): Promise<Result<ReadonlyMap<ComponentId, readonly Edge[]>, McpError>> => {
    const res = await listEdgesForNodes(ctx.graph, ids, { direction: 'in' });
    if (!res.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${res.error.message}` });
    }
    return ok(res.value);
  };
  // One node budget for the WHOLE request, so a wide change set of hub classes
  // cannot multiply the reverse search out.
  const referrerBudget = { remaining: UNCHECKED_REFERRER_NODE_BUDGET };
  for (const change of components) {
    const id = canonicalId(change.type, change.apiName);
    const nodeRes = await loadNode(id);
    if (!nodeRes.ok) return nodeRes;
    const node = nodeRes.value;
    let outboundApex: readonly ComponentId[] = [];
    let outboundWires: readonly ComponentId[] = [];
    if (
      node !== null &&
      FRONTEND_BUNDLE_TYPES.has(change.type) &&
      change.changeKind !== 'deleted'
    ) {
      const outRes = await listEdges(ctx.graph, id, { direction: 'out' });
      if (!outRes.ok) {
        return { ok: false, error: { kind: 'internal', message: `graph query failed: ${outRes.error.message}` } };
      }
      const apexSet = new Set<ComponentId>();
      const wireSet = new Set<ComponentId>();
      for (const e of outRes.value) {
        if (e.edgeType === 'callsApex' && e.toId.startsWith('ApexClass:')) {
          apexSet.add(e.toId);
          frontendCalleeApexIds.add(e.toId);
        } else if (
          e.edgeType === 'references' &&
          WIRE_REF_PREFIXES.some((p) => e.toId.startsWith(p))
        ) {
          wireSet.add(e.toId);
        }
      }
      outboundApex = sortIds(apexSet);
      outboundWires = sortIds(wireSet);
    }
    prepared.push({ change, id, node, outboundApex, outboundWires });
  }

  // Compose tests_for_change ONCE for every Apex component in the set PLUS the
  // Apex controllers frontend bundles call — it dedupes, buckets non-Apex/absent
  // ids, and applies the depth-3 covering walk we must not reimplement. Map its
  // per-change output back by id.
  const changesetApexIds = components
    .filter((c) => APEX_TYPES.has(c.type))
    .map((c) => canonicalId(c.type, c.apiName));
  const changesetApexSet = new Set<ComponentId>(changesetApexIds);
  const apexIdsToScore = [
    ...new Set<ComponentId>([...changesetApexIds, ...frontendCalleeApexIds]),
  ];
  const perChangeById = new Map<ComponentId, PerChangeCoverage>();
  const selectedTestsUnion = new Set<ComponentId>();
  if (apexIdsToScore.length > 0) {
    const tfc = await testsForChangeHandler(ctx, { changedComponents: apexIdsToScore });
    if (!tfc.ok) return tfc;
    for (const pc of tfc.value.data.perChange) perChangeById.set(pc.id, pc);
    for (const t of tfc.value.data.selectedTests) selectedTestsUnion.add(t.id);
  }
  // `uncoveredApex` / `unknownTestCoverage` are tallied in the review loop
  // below, NOT from `tfc.uncoveredChanges`: a zero-covering-test result splits
  // into a PROVEN-unguarded class and one whose coverage the walk could not
  // decide, and only the per-component inbound edge set tells them apart
  // (REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO). Both count the changeset's
  // OWN Apex only — a callee pulled in for a frontend bundle is a dependency,
  // not a changed component — and each id at most once, so a duplicated change
  // entry cannot inflate either tally.
  let uncoveredApex = 0;
  let unknownTestCoverage = 0;
  const talliedApexIds = new Set<ComponentId>();

  // Per-type coverage caveat cache — consulted ONLY for a zero-dependent result,
  // to distinguish a proven "none" from an absence the vault could never have
  // shown.
  //
  // GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE: for a delete/modify the honest question
  // is NOT "is the component's OWN family covered?" (a fully-modeled node says
  // nothing about who might reference it — the false-safe the extractor-gap
  // cluster kept regenerating) but "are the families that could REFERENCE this
  // component all covered?". A zero-dependent delete/modify whose usage-source
  // families are not all retrieved is "not checked", not proven "none", so the
  // caveat downgrades it to `review` (fixtures A/F/G). Absence of edges is only
  // as strong as the coverage behind the families that produce them. An ADDED
  // component's own forward references are never analysed anyway, so it keeps the
  // prior own-family staleness check (its verdict is name-collision-driven).
  const usageCaveatCache = new Map<string, CoverageCaveat | undefined>();
  const zeroDependentCaveat = (
    type: string,
    changeKind: ChangeKind,
  ): CoverageCaveat | undefined => {
    if (changeKind === 'added') {
      return buildEnumerationCoverageCaveatFor(
        ctx,
        [type],
        `The \`${type}\` family a change targets`,
      );
    }
    if (!usageCaveatCache.has(type)) {
      usageCaveatCache.set(
        type,
        buildUsageSourceCoverageCaveat(
          ctx,
          type,
          `Whether \`${type}\` is still referenced (the families that could reference it)`,
          // W11: integration / callout-trust anchors fail harder — an unused
          // credential on an UNKNOWN-coverage vault is `review`, never bare
          // `safe`, because its only referrers live on the under-extracted
          // callout plane. All other types keep the legacy-vault-tolerant stance.
          INTEGRATION_GATE_TYPES.has(type)
            ? { fireOnUnknownCoverage: true }
            : undefined,
        ),
      );
    }
    return usageCaveatCache.get(type);
  };

  const reviewed: ReviewedComponent[] = [];
  for (const { change, id, node, outboundApex, outboundWires } of prepared) {
    const inVault = node !== null;

    // (a) IMPACT — direct incoming edges minus access/structural edges.
    let dependentEdges: readonly Edge[] = [];
    let inboundEdges: readonly Edge[] = [];
    if (inVault) {
      const edgesRes = await listEdges(ctx.graph, id, { direction: 'in' });
      if (!edgesRes.ok) {
        return { ok: false, error: { kind: 'internal', message: `graph query failed: ${edgesRes.error.message}` } };
      }
      inboundEdges = edgesRes.value;
      dependentEdges = edgesRes.value.filter((e) => isDependencyEdge(e.edgeType, change.type));
    }
    const dependentIds = new Set<ComponentId>(dependentEdges.map((e) => e.fromId));
    const dependentCount = dependentIds.size;
    const weakest = weakestConfidence(dependentEdges);
    const allHeuristic = weakest === 'heuristic';

    // (a') FIRING BINDING — is this an ACTIVE save-time automation whose object
    // binding is OUTBOUND (`triggersOn`) or structural (`parentOf`), invisible
    // to the inbound-dependent gate? Only queried for delete/modify of an
    // in-vault firing-binding type (Flow / ApexTrigger / ValidationRule); the
    // outbound `triggersOn` walk is skipped for every other component.
    // REVIEW-CHANGE-RECORD-TRIGGERED-AUTOMATION-FALSE-SAFE.
    let firing: FiringBinding | null = null;
    if (node !== null && change.changeKind !== 'added' && FIRING_BINDING_TYPES.has(change.type)) {
      const firingRes = await detectFiringBinding(ctx, change.type, node, id, inboundEdges);
      if (!firingRes.ok) return firingRes;
      firing = firingRes.value;
    }

    const isFrontendBundle = FRONTEND_BUNDLE_TYPES.has(change.type);
    const hasOutbound = outboundApex.length > 0 || outboundWires.length > 0;

    // (b) TESTS — from the composed tests_for_change output. A frontend bundle
    // has no Apex tests of its OWN; its covering tests are the covering tests of
    // the Apex controllers it calls (outbound), so a `safe`-looking LWC promotion
    // still surfaces the controller's test set to run.
    const pc = perChangeById.get(id);
    const isApex = APEX_TYPES.has(change.type);
    let selectedTests: readonly ComponentId[];
    if (isFrontendBundle && outboundApex.length > 0) {
      const s = new Set<ComponentId>();
      for (const calleeId of outboundApex) {
        const cpc = perChangeById.get(calleeId);
        if (cpc !== undefined) for (const t of cpc.coveringTests) s.add(t.id);
      }
      selectedTests = [...s];
    } else {
      selectedTests = pc !== undefined ? pc.coveringTests.map((t) => t.id) : [];
    }
    // DISTINCT + sorted ONCE, so the disclosed count and the inlined sample are
    // computed from the same array — the count can never over- or under-report
    // the truncation it exists to disclose.
    // REVIEW-CHANGE-SELECTED-TESTS-SILENT-TRUNCATION.
    const distinctSelectedTests = sortIds(new Set<ComponentId>(selectedTests));

    // (b') IS THE ZERO CHECKED? A zero-covering-test result is only "no test
    // reaches this" if no test class reaches the component through an edge the
    // walk cannot follow. Reuses `inboundEdges` already in hand — no extra edge
    // query. REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO.
    const walkFoundTests = pc !== undefined && pc.covered;
    let uncheckedTestReferrers: readonly ComponentId[] = [];
    if (isApex && inVault && !walkFoundTests) {
      const refRes = await collectUncheckedTestReferrers(
        id,
        inboundEdges,
        loadNode,
        loadInbound,
        referrerBudget,
      );
      if (!refRes.ok) return refRes;
      uncheckedTestReferrers = refRes.value;
    }
    const testCoverage: TestCoverageStatus = !isApex
      ? 'not-applicable'
      : walkFoundTests
        ? 'covered'
        : uncheckedTestReferrers.length > 0
          ? 'unknown'
          : 'uncovered';
    // Tally the changeset's own Apex once. A row whose coverage is UNKNOWN is
    // never counted as proven-unguarded, and never silently dropped either.
    if (isApex && pc !== undefined && !pc.covered && changesetApexSet.has(id) && !talliedApexIds.has(id)) {
      talliedApexIds.add(id);
      if (testCoverage === 'unknown') unknownTestCoverage += 1;
      else uncoveredApex += 1;
    }

    // (c) VERDICT — the classification table, then a frontend-bundle OUTBOUND
    // adjustment. A modified LWC/Aura/VF has (almost) no INCOMING dependents, so
    // the inbound gate calls it `safe`; but calling a production controller or
    // wiring a permission/page is real promotion risk. Floor such a bundle at
    // `review` and name the callees + selected tests.
    const caveat =
      dependentCount === 0
        ? zeroDependentCaveat(change.type, change.changeKind)
        : undefined;
    const familyCovered = caveat === undefined;
    const classified = classify({
      changeKind: change.changeKind,
      inVault,
      dependentCount,
      allHeuristic,
      weakest,
      familyCovered,
    });
    let verdict = classified.verdict;
    let reason = classified.reason;
    if (isFrontendBundle && change.changeKind !== 'deleted' && hasOutbound) {
      const parts: string[] = [];
      if (outboundApex.length > 0) {
        parts.push(`${outboundApex.length} Apex controller callee(s) (${outboundApex.join(', ')})`);
      }
      if (outboundWires.length > 0) {
        parts.push(`${outboundWires.length} permission/page wire(s) (${outboundWires.join(', ')})`);
      }
      const outboundPhrase = parts.join(' and ');
      if (VERDICT_RANK[verdict] > VERDICT_RANK.review) {
        verdict = 'review';
        reason = `Frontend bundle change with OUTBOUND wiring the inbound-dependent gate misses: ${outboundPhrase}. Review the callee(s)/wiring and run the selected covering test(s) — SELECTION ≠ VALIDATION.`;
      } else {
        reason = `${reason} Also carries outbound wiring: ${outboundPhrase}; run the selected covering test(s).`;
      }
    }

    // (c') ACTIVE-RULE adjustment (after the table, like the frontend-bundle
    // floor): an Active DuplicateRule / MatchingRule fires on save regardless of
    // inbound references, so a delete/modify the inbound gate calls `safe` (0
    // dependents) actually changes runtime behaviour. Floor a live rule at
    // `review` (never bare `safe`); inactive rules keep their table verdict, so
    // the floor is state-driven, not a blanket type floor.
    // REVIEW-CHANGE-SAFE-ON-DELETE-DUPLICATE-RULE.
    if (
      change.changeKind !== 'added' &&
      verdict === 'safe' &&
      isActiveBehavioralRule(change.type, node)
    ) {
      const behaviour = change.type === 'DuplicateRule' ? 'duplicate-detection' : 'matching';
      const verb = change.changeKind === 'deleted' ? 'Deleting' : 'Modifying';
      verdict = 'review';
      reason =
        `Active ${change.type} — it fires on record save regardless of inbound references (the inbound-dependent gate shows 0 dependents, but its runtime effect is real; parentOf is structural and any MatchingRule link is outbound). ` +
        `${verb} or deactivating a live rule changes runtime ${behaviour} behaviour — review before deploying.`;
    }

    // (c'') FIRING-BINDING floor (after the table + prior floors, same
    // rationale — leaves `classify`'s table intact for its unit test): an
    // ACTIVE record-triggered (before/after-save) Flow, an ACTIVE ApexTrigger,
    // or an ACTIVE ValidationRule PARTICIPATES in its object's save transaction
    // via a binding the inbound-dependent gate is blind to (OUTBOUND
    // `triggersOn` for the Flow/Trigger; the excluded structural `parentOf` for
    // the VR), so the table under-calls its delete/modify a bare `safe`.
    // Deleting a live save participant removes production behaviour (floor to
    // `blocking`); modifying one changes it (floor to at least `review`). The
    // floor only raises severity (never downgrades a real-dependent verdict) and
    // is STATE-driven — an Inactive/Obsolete automation is not a firing binding,
    // so it keeps its table verdict (mirrors the dead-plane / DuplicateRule
    // honesty). REVIEW-CHANGE-RECORD-TRIGGERED-AUTOMATION-FALSE-SAFE.
    if (change.changeKind !== 'added' && firing !== null) {
      const target: ChangeVerdict = change.changeKind === 'deleted' ? 'blocking' : 'review';
      if (VERDICT_RANK[target] < VERDICT_RANK[verdict]) {
        verdict = target;
        reason = buildFiringBindingReason(change.type, change.changeKind, firing);
      }
    }

    // The blind spot also goes in the PROSE the row carries, because a host
    // summarising `reviewed[]` reads `reason` aloud. No verdict floor is added:
    // an unwalked referrer is by construction an inbound edge, so the row
    // already has >=1 dependent and the table can never have called it `safe`.
    if (uncheckedTestReferrers.length > 0) {
      reason =
        `${reason} TEST COVERAGE UNKNOWN, not zero: ${uncheckedTestReferrers.length} Apex test ` +
        `class(es) (${uncheckedTestReferrers.slice(0, DEPENDENT_SAMPLE_CAP).join(', ')}) reach this ` +
        'component over a path using an edge the covering-test walk does not traverse (a ' +
        '`new SomeClass()` is minted as `references`, not `callsApex`) — directly or through a ' +
        'production class in between — so the empty selected-test list is "not checked", NEVER ' +
        '"no tests cover this". Run them.';
    }

    reviewed.push({
      id,
      type: change.type,
      apiName: change.apiName,
      changeKind: change.changeKind,
      verdict,
      reason,
      inVault,
      dependentCount,
      dependents: sortIds(dependentIds).slice(0, DEPENDENT_SAMPLE_CAP),
      weakestDependentConfidence: weakest,
      // DERIVED from the same array the sample is sliced from, so the count can
      // never drift from the truncation it discloses (mirrors dependentCount).
      selectedTestCount: distinctSelectedTests.length,
      selectedTests: distinctSelectedTests.slice(0, TEST_SAMPLE_CAP),
      testCoverage,
      ...(uncheckedTestReferrers.length > 0
        ? { uncheckedTestReferrers: uncheckedTestReferrers.slice(0, DEPENDENT_SAMPLE_CAP) }
        : {}),
      ...(isFrontendBundle && outboundApex.length > 0
        ? { outboundApex: outboundApex.slice(0, DEPENDENT_SAMPLE_CAP) }
        : {}),
      ...(isFrontendBundle && outboundWires.length > 0
        ? { outboundWires: outboundWires.slice(0, DEPENDENT_SAMPLE_CAP) }
        : {}),
      ...(caveat !== undefined ? { coverageCaveat: caveat } : {}),
    });
  }

  // Ordered most-dangerous first, then widest blast radius, then id.
  reviewed.sort(
    (a, b) =>
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      b.dependentCount - a.dependentCount ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const tally = { blocking: 0, risky: 0, review: 0, safe: 0, unknown: 0 };
  let notInVault = 0;
  for (const r of reviewed) {
    tally[r.verdict] += 1;
    if (!r.inVault && r.changeKind !== 'added') notInVault += 1;
  }
  const overallVerdict: ChangeVerdict = reviewed.reduce<ChangeVerdict>(
    (worst, r) => (VERDICT_RANK[r.verdict] < VERDICT_RANK[worst] ? r.verdict : worst),
    'safe',
  );

  // Top-level coverage caveat over the distinct families in the changeset.
  const distinctTypes = [...new Set(components.map((c) => c.type))];
  const coverageCaveat = buildEnumerationCoverageCaveatFor(
    ctx,
    distinctTypes,
    'One or more families in this changeset',
  );

  const truncated = reviewed.length > limit;
  const summary: ReviewChangeSummary = {
    total: reviewed.length,
    blocking: tally.blocking,
    risky: tally.risky,
    review: tally.review + tally.unknown,
    safe: tally.safe,
    testsToRun: selectedTestsUnion.size,
    uncoveredApex,
    unknownTestCoverage,
    notInVault,
    truncated,
  };

  // A response that could not decide the test dimension must not certify
  // `completeness: complete` with `limitations: []` — that pair is precisely
  // what a host reads as "the gate checked everything and found nothing to
  // run". The gap is downgraded in the machine-readable completeness AND named
  // verbatim in `limitations`, additively alongside any family-coverage caveat.
  // REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO.
  const testGap = unknownTestCoverage > 0;
  const baseCompleteness =
    coverageCaveat === undefined
      ? { status: 'complete' as const, missingCoverage: [] as readonly string[] }
      : { status: coverageCaveat.status, missingCoverage: coverageCaveat.missingCoverage };
  const missingCoverage = testGap
    ? [...baseCompleteness.missingCoverage, UNKNOWN_TEST_COVERAGE_MARKER]
    : baseCompleteness.missingCoverage;
  const trust = offlineTrust(
    ctx,
    missingCoverage.length === 0
      ? { status: 'complete' }
      : {
          status: testGap && baseCompleteness.status === 'complete' ? 'partial' : baseCompleteness.status,
          missingCoverage,
        },
    undefined,
    testGap ? [unknownTestCoverageLimitation(unknownTestCoverage)] : undefined,
  );

  // Additive grant-completeness ("ships for nobody") section — computed ONLY
  // when the caller opts in via `checkAccessParity`. Default (flag off) leaves
  // the response byte-for-byte identical to the R6-16 / R7-C2 output, so every
  // existing consumer and snapshot is unaffected. Runs against THIS ctx's graph
  // (the current vault, or the against-vault shadow context in cross-vault
  // mode), so a cross-vault parity check honestly reports the target's grants.
  let accessParity: AccessParityResult | undefined;
  if (checkAccessParity) {
    const parityRes = await resolveAccessParity(ctx, components);
    if (!parityRes.ok) return parityRes;
    accessParity = parityRes.value;
  }

  return ok({
    data: {
      reviewed: reviewed.slice(0, limit),
      overallVerdict,
      summary,
      selectedTests: sortIds(selectedTestsUnion).slice(0, SELECTED_TESTS_CAP),
      recommendation: buildRecommendation(summary, reviewed),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(accessParity !== undefined ? { accessParity } : {}),
      trust,
      disclosure: REVIEW_CHANGE_DISCLOSURE,
      boundaries: REVIEW_CHANGE_BOUNDARIES,
    },
    reviewedFull: reviewed,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/** Resolved against-vault: its on-disk path, manifest, and how it was named. */
interface ResolvedAgainstVault {
  readonly path: string;
  readonly alias: string;
  readonly resolvedFrom: 'alias' | 'path';
  readonly manifest: ExtendedVaultManifest;
}

/**
 * Resolve the `againstVault` string to an on-disk vault. Tries a REGISTERED
 * ALIAS first (via the registry rooted at the current vault — the same
 * mechanism `compare_vaults` uses); failing that, treats the string as a
 * filesystem PATH to an `org-kb`. Either way the vault's `meta/manifest.json`
 * must be readable — a string that is neither a known alias nor a readable
 * vault dir is a `component-not-found` carrying the register-vault directive,
 * NOT a silent empty review.
 */
const resolveAgainstVault = async (
  ctx: Context,
  against: string,
): Promise<Result<ResolvedAgainstVault, McpError>> => {
  const registryRoot = findRegistryRoot(ctx.vaultRoot);
  const aliasRes = await resolveVault(registryRoot, against);
  const path = aliasRes.ok ? aliasRes.value : resolve(against);
  const manifestRes = await loadManifest(path);
  if (!manifestRes.ok) {
    return err({
      kind: 'component-not-found',
      message:
        `--against target '${against}' is neither a registered vault alias nor a readable vault directory ` +
        `(no readable meta/manifest.json at '${path}'). Run \`sfi register-vault ${against} <path>\` ` +
        `(then \`sfi list-vaults\`), or pass a path to a refreshed org-kb.`,
      path: 'againstVault',
    });
  }
  return ok({
    path,
    alias: aliasRes.ok ? against : basename(path),
    resolvedFrom: aliasRes.ok ? 'alias' : 'path',
    manifest: manifestRes.value,
  });
};

/**
 * The prominent cross-vault disclosure prefix, prepended to the standard
 * `REVIEW_CHANGE_DISCLOSURE` so a host cannot miss that impact is against the
 * NAMED vault (its last refresh), not the current one.
 */
const buildAgainstVaultDisclosure = (
  info: AgainstVaultInfo,
  absentCount: number,
): string => {
  const when =
    info.lastRefreshedAt ?? 'an unknown time (its manifest carried no refresh timestamp)';
  const absentNote =
    absentCount > 0
      ? ` ${absentCount} changeset component(s) are ABSENT from '${info.alias}' — relative to it they would be ADDED, so nothing there can depend on them, but their OWN forward references were NOT analysed (see absentInAgainstVault).`
      : '';
  return (
    `IMPACT COMPUTED AGAINST vault '${info.alias}' (its last refresh ${when}), NOT the current vault. ` +
    `Every dependent, verdict, and selected test below is derived from '${info.alias}''s dependency graph — ` +
    `a \`blocking\` / \`risky\` verdict means the change would break something IN THAT vault (e.g. PROD).${absentNote}`
  );
};

/** The cross-vault boundary line, prepended to the standard boundaries. */
const buildAgainstVaultBoundary = (info: AgainstVaultInfo): string =>
  `Impact is computed against vault '${info.alias}' (last refresh ${info.lastRefreshedAt ?? 'unknown'}), ` +
  `resolved by ${info.resolvedFrom} — NOT the current vault. Re-refresh '${info.alias}' before trusting a ` +
  '`safe` verdict as safe-for-that-org.';

/**
 * R6-12-style extractor-version caveat: emitted only when the current vault and
 * the against-vault report different sf-intelligence product versions, because
 * a verdict / edge-set difference can then reflect an EXTRACTOR change rather
 * than a real difference in the target org.
 */
const buildExtractorVersionCaveat = (
  currentVersion: string,
  againstVersion: string,
  againstAlias: string,
): string =>
  `The current vault was extracted with sf-intelligence ${currentVersion}; the against-vault ` +
  `'${againstAlias}' with ${againstVersion}. A verdict or edge-set difference MAY reflect an EXTRACTOR ` +
  `change between versions rather than a real difference in '${againstAlias}'s org — re-refresh both ` +
  'vaults on the same product version before trusting a verdict as org-only.';

/**
 * The `sfi.review_change` MCP tool. In the DEFAULT path it reviews the
 * changeset against the current vault's graph — byte-for-byte the R6-16
 * behaviour. When `againstVault` is supplied it opens that vault (a registered
 * alias OR a path) READ-ONLY and computes every signal against ITS graph
 * instead (the release-manager "will this break PROD?" question), disclosing
 * the target, absent-in-target ids, and an extractor-version caveat.
 *
 * @example
 *   const r = await reviewChangeHandler(ctx, {
 *     components: [
 *       { type: 'ApexClass', apiName: 'OrderService', changeKind: 'deleted' },
 *       // `componentId` selector is equivalent to the { type, apiName } pair —
 *       // the canonical id a host forwards straight from `sfi.resolve`.
 *       { componentId: 'CustomField:Account.Industry__c', changeKind: 'modified' },
 *     ],
 *     againstVault: 'prod',
 *   });
 *   if (r.ok) console.log(r.value.data.overallVerdict);
 */
export const reviewChangeHandler = async (
  ctx: Context,
  input: ReviewChangeInput,
): Promise<Result<McpResponse<ReviewChangeOutput>, McpError>> => {
  // Default path — resolve against the current vault. Byte-identical to R6-16:
  // the CoreReview.data object is returned unchanged, with no cross-vault keys.
  if (input.againstVault === undefined) {
    const core = await runReviewCore(
      ctx,
      input.components,
      input.limit,
      input.checkAccessParity ?? false,
    );
    if (!core.ok) return core;
    return ok({ data: core.value.data, vaultState: core.value.vaultState });
  }

  // Cross-vault path — resolve + open the against-vault READ-ONLY and run the
  // SAME core against its graph via a shadow context.
  const resolved = await resolveAgainstVault(ctx, input.againstVault);
  if (!resolved.ok) return resolved;

  const opened = await openVaultReadOnly(ctx, resolved.value.path);
  if (!opened.ok) return opened;
  try {
    const shadowCtx: Context = {
      vaultRoot: resolved.value.path,
      manifest: resolved.value.manifest,
      graph: opened.value.store,
    };
    const core = await runReviewCore(
      shadowCtx,
      input.components,
      input.limit,
      input.checkAccessParity ?? false,
    );
    if (!core.ok) return core;

    const info: AgainstVaultInfo = {
      alias: resolved.value.alias,
      path: resolved.value.path,
      resolvedFrom: resolved.value.resolvedFrom,
      lastRefreshedAt: resolved.value.manifest.refreshedAt,
      sourceTreeHash: resolved.value.manifest.sourceTreeHash,
    };
    // Absent-in-target: ids the caller labelled modified/deleted that do NOT
    // exist in the against-vault. Computed over the FULL reviewed set (never
    // trimmed by `limit`) — an added-relative-to-target signal.
    const absent = sortIds(
      core.value.reviewedFull
        .filter((r) => !r.inVault && r.changeKind !== 'added')
        .map((r) => r.id),
    );
    // Extractor-version caveat: the current vault vs the against-vault (R6-12).
    const versionCaveat =
      ctx.manifest.version !== resolved.value.manifest.version
        ? buildExtractorVersionCaveat(
            ctx.manifest.version,
            resolved.value.manifest.version,
            info.alias,
          )
        : undefined;

    const augmented: ReviewChangeOutput = {
      ...core.value.data,
      recommendation: `Against vault '${info.alias}': ${core.value.data.recommendation}`,
      disclosure: `${buildAgainstVaultDisclosure(info, absent.length)} ${core.value.data.disclosure}`,
      boundaries: [buildAgainstVaultBoundary(info), ...core.value.data.boundaries],
      againstVault: info,
      ...(absent.length > 0 ? { absentInAgainstVault: absent } : {}),
      ...(versionCaveat !== undefined ? { extractorVersionCaveat: versionCaveat } : {}),
    };
    return ok({ data: augmented, vaultState: core.value.vaultState });
  } finally {
    await opened.value.dispose();
  }
};

/** Verbatim boundary lines (also folded into `trust.limitations`-style hosting). */
const REVIEW_CHANGE_BOUNDARIES: readonly string[] = [
  'Analysis is against the LAST VAULT REFRESH of the target org, which may drift from what is actually deployed. Re-run `sfi refresh` and re-review before trusting a `safe` verdict.',
  'Dependents are DIRECT (single-hop) incoming edges, excluding grantedBy (access, not a breakage dependency) and parentOf (structural). Use `sfi.get_impact` for the full transitive blast radius. Exception: for a CustomPermission the grantedBy granters (Profile / PermissionSet) reference it by name and ARE counted as dependents.',
  'Active DuplicateRule / MatchingRule are floored at `review` (never bare `safe`) on delete/modify: they fire on record save regardless of inbound references, so the inbound-dependent model alone would under-call them. An INACTIVE rule keeps its table verdict.',
  'Active save-time automation binds to its object OUTSIDE the inbound-dependent model: a record-triggered (before/after-save) Flow and an ApexTrigger bind OUTBOUND via `triggersOn`, and a ValidationRule binds via the structural `parentOf` from its object (excluded as a dependent). Such a live save participant shows 0 inbound dependents, so its delete is floored at `blocking` and its modify at `review` (never bare `safe`). An INACTIVE / Obsolete automation does not fire and keeps its table verdict.',
  'ADDED components are not analysed for their own contents — only name-collision (id already present) and test mapping. Their forward references were never extracted offline.',
  'Test selection composes `sfi.tests_for_change`: CLASS-granular, blind to dynamic dispatch / reflection / managed-package tests, depth-3 capped. SELECTION ≠ VALIDATION.',
  'The covering-test walk traverses only `callsApex` / `dispatchesAsync`. A test class that exercises a change through a plain `new SomeClass()` reaches it via a `references` edge the walk never follows — directly, or with one or more production classes in between. Before reporting a zero this gate reverse-searches the component’s WHOLE inbound Apex closure for a test reachable over a path using at least one unwalked edge; if one exists the row reports `testCoverage: "unknown"` with those tests in `uncheckedTestReferrers`, counts in `summary.unknownTestCoverage` (not `uncoveredApex`), and downgrades `trust.completeness` with a named `trust.limitations` entry. `summary.testsToRun` is then a FLOOR — run those test classes too, or the full suite.',
  'A remaining `uncovered` is a zero over the EXTRACTED Apex edges, not a proof of no coverage. Three boundaries survive: the composed walk is depth-3 capped, so a longer all-`callsApex` chain still reports uncovered; dynamic dispatch (`Type.forName`), reflection and managed-package tests are never extracted as edges at all, so no search here can see them; and the reverse search is node-budgeted (it fails toward `unknown`, never toward a false `uncovered`). Treat `summary.uncoveredApex` as an UPPER BOUND on the unguarded surface.',
  'Frontend bundles (LightningComponentBundle / Aura / Visualforce) are reviewed on OUTBOUND wiring too: a modified/added bundle that calls an Apex controller or references a CustomPermission / FlexiPage is floored at `review` (never bare `safe`), with `outboundApex` / `outboundWires` naming them and the controllers’ covering tests selected. Only `callsApex` and `references`→CustomPermission/FlexiPage wiring are composed; other outbound edges (e.g. a bundle’s own field reads) are not turned into verdicts.',
];

/** Inputs to the per-component classification. */
interface ClassifyInput {
  readonly changeKind: ChangeKind;
  readonly inVault: boolean;
  readonly dependentCount: number;
  readonly allHeuristic: boolean;
  readonly weakest: Edge['confidence'] | null;
  readonly familyCovered: boolean;
}

/** The classification table, isolated for the unit test to pin every row. */
export const classify = (i: ClassifyInput): { verdict: ChangeVerdict; reason: string } => {
  const depsPhrase = `${i.dependentCount} direct dependent(s)`;
  const confPhrase = i.weakest !== null ? ` (weakest edge confidence: ${i.weakest})` : '';

  if (i.changeKind === 'deleted') {
    if (!i.inVault) {
      return {
        verdict: 'review',
        reason:
          'Labelled deleted but no node exists at this id in the vault — either it is already absent, its family is not modeled, or the vault has drifted. Cannot assess dependents.',
      };
    }
    if (i.dependentCount >= 1) {
      return {
        verdict: 'blocking',
        reason: `Deleting a component with ${depsPhrase}${confPhrase} will break them. Resolve or migrate the dependents before deploying.`,
      };
    }
    return i.familyCovered
      ? { verdict: 'safe', reason: 'Deleted with no dependents among the covered families.' }
      : {
          verdict: 'review',
          reason:
            'No dependents found, but the vault does not fully cover every family that COULD reference this component — absence of dependents is "not checked", not proven "none" (see coverageCaveat). Verify the un-retrieved planes before deleting.',
        };
  }

  if (i.changeKind === 'modified') {
    if (!i.inVault) {
      return {
        verdict: 'review',
        reason:
          'Labelled modified but not present in the vault — its family may not be modeled, or the vault has drifted / this is a new file. Forward references are not analysed.',
      };
    }
    if (i.dependentCount >= 1) {
      return i.allHeuristic
        ? {
            verdict: 'review',
            reason: `Modified with ${depsPhrase}, all from HEURISTIC-only readers${confPhrase} — the scanner inference may be a false positive. Verify the readers manually.`,
          }
        : {
            verdict: 'risky',
            reason: `Modified with ${depsPhrase}${confPhrase} — callers / automation may break. Review them and run the selected tests.`,
          };
    }
    return i.familyCovered
      ? { verdict: 'safe', reason: 'Modified with no dependents among the covered families.' }
      : {
          verdict: 'review',
          reason:
            'No dependents found, but the vault does not fully cover every family that COULD reference this component — absence is "not checked" (see coverageCaveat). Verify the un-retrieved planes before deploying.',
        };
  }

  // added
  if (i.inVault) {
    const depsNote =
      i.dependentCount >= 1
        ? ` The existing component has ${depsPhrase}, so an overwrite would affect them.`
        : '';
    return {
      verdict: 'review',
      reason: `Labelled added but a component ALREADY exists at this id — a name collision. Confirm this is a genuinely new component and not a rename/overwrite.${depsNote}`,
    };
  }
  return {
    verdict: 'safe',
    reason:
      'New component — nothing in the current vault can depend on it. NOTE: added components are not analysed for their own contents (forward references not extracted); only name-collision and test mapping were checked.',
  };
};

/** Compose the single-line deploy recommendation from the tallies. */
const buildRecommendation = (
  summary: ReviewChangeSummary,
  reviewed: readonly ReviewedComponent[],
): string => `${buildVerdictRecommendation(summary, reviewed)}${buildUnknownTestSuffix(summary)}`;

/**
 * The sentence appended to EVERY recommendation when the test dimension could
 * not be decided. A host reads this line aloud, so "run the N selected test(s)"
 * must never be the last thing it says about a change set whose selection is
 * known to be short. REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO.
 */
const buildUnknownTestSuffix = (summary: ReviewChangeSummary): string =>
  summary.unknownTestCoverage === 0
    ? ''
    : ` TEST COVERAGE COULD NOT BE DETERMINED for ${summary.unknownTestCoverage} change(s): a test ` +
      'class reaches them over a path using an edge the covering-test walk does not traverse, so ' +
      `the ${summary.testsToRun} selected test(s) are a FLOOR, not the set — see ` +
      '`uncheckedTestReferrers` on those rows and run those test classes too (or the full suite).';

/** The verdict-driven half of the recommendation (the pre-existing table). */
const buildVerdictRecommendation = (
  summary: ReviewChangeSummary,
  reviewed: readonly ReviewedComponent[],
): string => {
  if (summary.blocking > 0) {
    const first = reviewed.find((r) => r.verdict === 'blocking');
    const lead = first !== undefined ? ` e.g. ${first.id} (${first.dependentCount} dependent(s))` : '';
    return `DEPLOY GATE: ${summary.blocking} blocking change(s) —${lead}. Resolve dependents before deploying.`;
  }
  if (summary.risky > 0) {
    return `${summary.risky} risky change(s) with firm dependents — review callers/automation and run the ${summary.testsToRun} selected test(s) before deploying.`;
  }
  if (summary.review > 0) {
    return `${summary.review} change(s) need manual review (uncertain dependents, heuristic-only readers, partial coverage, or not in vault). No hard blockers found.`;
  }
  return `All ${summary.total} change(s) look safe within the vault's coverage. SELECTION ≠ VALIDATION — still run the ${summary.testsToRun} selected test(s), and re-refresh if the vault may have drifted.`;
};
