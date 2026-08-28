/// <reference types="vitest/globals" />

/**
 * R6-16 — `sfi.review_change`: the deploy-gate review over a change set.
 *
 * Proves the classification table (deleted-with-dependents = blocking,
 * clean-component = safe, modified-with-heuristic-readers = review, …), the
 * grantedBy/parentOf dependent-exclusion (access ≠ usage), the coverage-caveat
 * behaviour (a zero-dependent result for an un-retrieved family reads "not
 * checked" → review), the tests_for_change composition, the most-dangerous-first
 * ordering, and the row-cap byte budget.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { DEFAULT_USAGE_SOURCE_FAMILIES } from '../../src/tools/coverage-trust.js';
import {
  classify,
  reviewChangeHandler,
  reviewChangeInputSchema,
} from '../../src/tools/review-change.js';

// ---------------------------------------------------------------------------
// Coverage rows (mirrors empty-traversal-coverage-caveat.test.ts). A requested,
// retrieved:0, un-confirmed row reads PARTIAL; retrieved:1 reads COMPLETE.
// ---------------------------------------------------------------------------

const coveredRow = (type: string): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 1,
  errored: false,
  neverModeled: false,
});
const partialRow = (type: string): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 0,
  errored: false,
  neverModeled: false,
});

// GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE: "complete" now means every family that
// could REFERENCE a changed component (its usage-source families) is attested —
// not merely the component's own family. So COMPLETE_COVERAGE covers the union of
// USAGE_SOURCE_FAMILIES for every type these tests exercise (Apex / field / flow
// / VF / compact-layout referrers + the placement planes CustomSite / CustomTab /
// CustomApplication / RecordType the false-safe cluster proved blind).
const FAMILIES = [
  'ApexClass',
  'ApexTrigger',
  'CustomField',
  'Flow',
  'CustomObject',
  'Profile',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  'CustomPermission',
  // REVIEW-CHANGE-SAFE-ON-DELETE-QUICKACTION
  'QuickAction',
  'Layout',
  // REVIEW-CHANGE-SAFE-ON-DELETE-DUPLICATE-RULE
  'DuplicateRule',
  'MatchingRule',
  // REVIEW-CHANGE-SAFE-ON-DELETE-CUSTOM-PERMISSION
  'PermissionSet',
  // Usage-source / placement families the destructive verdict now attests.
  'ValidationRule',
  'WorkflowRule',
  // Condition firers whose ConditionalContext readsFrom edges can carry a
  // `condition` blocker for a field.
  'ApprovalProcess',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  'SharingRule',
  'Report',
  'Dashboard',
  'ListView',
  'ReportType',
  'FlexiPage',
  'CustomSite',
  'CustomTab',
  'CustomApplication',
  'RecordType',
  // The changed components' OWN families (so the flip fixtures fail PRE-fix,
  // where the gate checked only the component's own coverage): a covered own
  // family + a MISSING referrer plane is exactly the false-safe the fix closes.
  'CompactLayout',
];
const COMPLETE_COVERAGE: readonly CoverageEntry[] = FAMILIES.map(coveredRow);
/** CustomField NOT retrieved, the rest covered → a field change with 0 deps = not-checked. */
const FIELD_PARTIAL_COVERAGE: readonly CoverageEntry[] = FAMILIES.map((t) =>
  t === 'CustomField' ? partialRow(t) : coveredRow(t),
);
/**
 * COMPLETE_COVERAGE with the named usage-source families dropped to `partial`
 * (retrieved:0, un-confirmed) — the "graph does not model this usage source"
 * shape the gate must NOT read as a proven "none". Used by the fixtures A/F/G
 * flip guards (omit the plane that would place the component).
 */
const coveragePartialFor = (...omit: readonly string[]): readonly CoverageEntry[] =>
  FAMILIES.map((t) => (omit.includes(t) ? partialRow(t) : coveredRow(t)));

const manifestWith = (coverage: readonly CoverageEntry[] | undefined): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-29T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 4, CustomField: 3 },
  edges: {},
  sourceTreeHash: 'sha256:fixture-review-change',
  ...(coverage !== undefined
    ? { coverage, coverageComputedAt: '2026-05-29T12:00:00.000Z' }
    : {}),
});

// ---------------------------------------------------------------------------
// Synthetic graph.
//   OrderService      ← CheckoutController (callsApex, declared)  [firm dependent]
//                     ← OrderServiceTest   (callsApex, declared)  [test + dependent]
//   LonelyService     — isolated (no incoming edges)
//   Account.Rating__c ← HeuristicReader    (readsFrom, heuristic) [heuristic-only reader]
//                     ← Account            (parentOf) — EXCLUDED
//   Account.Firm__c   ← FirmFlow           (readsFrom, parsed)    [firm reader]
//                     ← Account            (parentOf) — EXCLUDED
//   Account.Granted__c← Admin              (grantedBy) — EXCLUDED
//                     ← Account            (parentOf) — EXCLUDED
// ---------------------------------------------------------------------------

const makeNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const makeEdge = (
  o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({ confidence: 'declared', source: 'unit-test', properties: {}, ...o });

/**
 * A WIDE covering-test set: one production Apex class reached by 12 distinct
 * test classes. Exists so the per-component `selectedTests` sample cap (10)
 * actually BITES — a truncated test list that discloses no total is a deploy
 * gate that under-reports the suite an operator must run.
 */
const WIDE_TEST_COUNT = 12;
const wideTestApiName = (n: number): string => `WideServiceTest${String(n).padStart(2, '0')}`;
const wideTestId = (n: number): string => `ApexClass:${wideTestApiName(n)}`;

const SEED: ExtractionResult = {
  nodes: [
    makeNode({ id: 'ApexClass:OrderService', apiName: 'OrderService', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:CheckoutController', apiName: 'CheckoutController', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:OrderServiceTest', apiName: 'OrderServiceTest', properties: { isTest: true } }),
    makeNode({ id: 'ApexClass:LonelyService', apiName: 'LonelyService', properties: { isTest: false } }),
    // ---- REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO --------------------
    // A production class a test class exercises ONLY through `new Class_C()`.
    // The Apex extractor mints an instantiation as a `references` edge
    // (`mechanism: 'instantiation'`), NOT `callsApex`, and the covering-test
    // walk composed from `tests_for_change` traverses ONLY callsApex /
    // dispatchesAsync — so the walk finds no covering test and the gate
    // reported an AFFIRMATIVE `uncovered` (selectedTests [], testsToRun 0,
    // completeness `complete`, limitations []) while the SAME payload listed
    // the test class as a dependent.
    makeNode({ id: 'ApexClass:Silent_Batch_C', apiName: 'Silent_Batch_C', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:Silent_Batch_C_Test', apiName: 'Silent_Batch_C_Test', properties: { isTest: true } }),
    // R1 typed absence: this referrer carries NO extracted `isTest` property at
    // all. Never-extracted is NOT "known not a test", so the zero it produces
    // is equally unchecked.
    makeNode({ id: 'ApexClass:Unknown_Flag_C', apiName: 'Unknown_Flag_C', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:Unknown_Flag_C_Ref', apiName: 'Unknown_Flag_C_Ref', properties: {} }),
    // TWO HOPS. The shape that survived a DEPTH-1 version of this fix on the
    // owner's real vault: the changed class is instantiated by a PRODUCTION
    // class, and THAT class is the one a test dispatches. No direct referrer of
    // the changed class is a test, yet running the test does exercise it.
    //   Deep_Batch_C <-references/instantiation- Deep_Sched_C <-dispatchesAsync- Deep_Batch_C_Test
    makeNode({ id: 'ApexClass:Deep_Batch_C', apiName: 'Deep_Batch_C', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:Deep_Sched_C', apiName: 'Deep_Sched_C', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:Deep_Batch_C_Test', apiName: 'Deep_Batch_C_Test', properties: { isTest: true } }),
    // The MIRROR shape: the unwalked edge is the SECOND hop, not the first.
    //   Mixed_Target_C <-callsApex- Mixed_Helper_C <-references- Mixed_Helper_C_Test
    // The composed walk reaches Mixed_Helper_C and stops (not a test); it never
    // follows the `references` edge that makes the test real.
    makeNode({ id: 'ApexClass:Mixed_Target_C', apiName: 'Mixed_Target_C', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:Mixed_Helper_C', apiName: 'Mixed_Helper_C', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:Mixed_Helper_C_Test', apiName: 'Mixed_Helper_C_Test', properties: { isTest: true } }),
    // CONTROL: a production instantiation referrer that has NO test of its own
    // anywhere upstream. Nothing in this component's whole inbound Apex closure
    // is a test, so its zero really is a zero over the extracted edges and the
    // gate is allowed to say so.
    makeNode({ id: 'ApexClass:Prod_Only_C', apiName: 'Prod_Only_C', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:Prod_Only_C_Caller', apiName: 'Prod_Only_C_Caller', properties: { isTest: false } }),
    // 12 covering tests over one class — exercises the selectedTests sample cap.
    makeNode({ id: 'ApexClass:WideService', apiName: 'WideService', properties: { isTest: false } }),
    ...Array.from({ length: WIDE_TEST_COUNT }, (_, i) =>
      makeNode({
        id: wideTestId(i + 1),
        apiName: wideTestApiName(i + 1),
        properties: { isTest: true },
      }),
    ),
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    makeNode({ id: 'CustomField:Account.Rating__c', type: 'CustomField', apiName: 'Rating__c', parentId: 'CustomObject:Account' }),
    makeNode({ id: 'CustomField:Account.Firm__c', type: 'CustomField', apiName: 'Firm__c', parentId: 'CustomObject:Account' }),
    makeNode({ id: 'CustomField:Account.Granted__c', type: 'CustomField', apiName: 'Granted__c', parentId: 'CustomObject:Account' }),
    makeNode({ id: 'ApexClass:HeuristicReader', apiName: 'HeuristicReader', properties: { isTest: false } }),
    makeNode({ id: 'Flow:FirmFlow', type: 'Flow', apiName: 'FirmFlow' }),
    makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
    // REVIEW-CHANGE-LWC-SAFE-IGNORES-CONTROLLER-AND-PAGE-WIRE: an exposed LWC
    // with OUTBOUND wiring (its own controller + a CustomPermission gate) but
    // ZERO incoming dependents. PromoController is separate from OrderService so
    // the existing OrderService dependent-count assertions are unaffected.
    makeNode({ id: 'LightningComponentBundle:promoPanel', type: 'LightningComponentBundle', apiName: 'promoPanel' }),
    makeNode({ id: 'ApexClass:PromoController', apiName: 'PromoController', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:PromoControllerTest', apiName: 'PromoControllerTest', properties: { isTest: true } }),
    makeNode({ id: 'CustomPermission:See_promoPanel', type: 'CustomPermission', apiName: 'See_promoPanel' }),
    // ---- REVIEW-CHANGE-SAFE-ON-DELETE-QUICKACTION ------------------------
    // A laid-out Update QuickAction placed by a Layout (`references`, targetKind
    // quickAction — the edge the layout extractor emits). Its only OTHER
    // incoming edge is the structural parentOf from its object. On an
    // unrefreshed vault the layout edge is ABSENT (Lonely_Action models that
    // state); once refreshed it materializes and the delete genuinely flips.
    makeNode({ id: 'CustomObject:Widget__c', type: 'CustomObject', apiName: 'Widget__c' }),
    makeNode({ id: 'QuickAction:Widget__c.My_Action', type: 'QuickAction', apiName: 'Widget__c.My_Action' }),
    makeNode({ id: 'QuickAction:Widget__c.Lonely_Action', type: 'QuickAction', apiName: 'Widget__c.Lonely_Action' }),
    makeNode({ id: 'Layout:Widget__c.Widget Layout', type: 'Layout', apiName: 'Widget__c.Widget Layout' }),
    // ---- REVIEW-CHANGE-SAFE-ON-DELETE-DUPLICATE-RULE ---------------------
    // Active dup rule fires on insert (Allow + Report); its only edges are the
    // structural parentOf (from the object) and an OUTBOUND references to a
    // MatchingRule — so the inbound gate sees 0 dependents. Off_Dup_Rule is the
    // inactive control (must stay safe).
    makeNode({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
    makeNode({ id: 'DuplicateRule:Contact.My_Dup_Rule', type: 'DuplicateRule', apiName: 'Contact.My_Dup_Rule', parentId: 'CustomObject:Contact', properties: { isActive: true, actionOnInsert: 'Allow' } }),
    makeNode({ id: 'DuplicateRule:Contact.Off_Dup_Rule', type: 'DuplicateRule', apiName: 'Contact.Off_Dup_Rule', parentId: 'CustomObject:Contact', properties: { isActive: false } }),
    makeNode({ id: 'MatchingRule:Contact.My_Match', type: 'MatchingRule', apiName: 'Contact.My_Match', properties: { ruleStatus: 'Active' } }),
    // ---- REVIEW-CHANGE-SAFE-ON-DELETE-CUSTOM-PERMISSION -----------------
    // A CustomPermission granted by a PermissionSet AND a Profile. Both granter
    // edges are inbound `grantedBy` — for a CustomPermission (unlike a field's
    // FLS grant) they ARE breakage dependents: the granters reference it by name.
    makeNode({ id: 'CustomPermission:My_Perm', type: 'CustomPermission', apiName: 'My_Perm' }),
    makeNode({ id: 'PermissionSet:Reviewer_PS', type: 'PermissionSet', apiName: 'Reviewer_PS' }),
    makeNode({ id: 'Profile:Reviewer_Profile', type: 'Profile', apiName: 'Reviewer_Profile' }),
    // ---- GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE fixtures A / F / G -----------
    // Three components with ZERO inbound usage edges — a Screen Flow embedded on
    // a FlexiPage, a VF page placed as a site index/template, and a CompactLayout
    // assigned on an object. In each case the PLACEMENT edge is unmodelled (the
    // extractor gap the finding cites), so the inbound gate sees 0 dependents.
    // Whether the delete is `safe` or `review` must hinge on whether the vault
    // COVERS the family that could place them — not on the empty edge set alone.
    makeNode({ id: 'Flow:Orphan_Screen_Flow', type: 'Flow', apiName: 'Orphan_Screen_Flow', properties: { status: 'Active' } }),
    makeNode({ id: 'VisualforcePage:Orphan_Site_Page', type: 'VisualforcePage', apiName: 'Orphan_Site_Page' }),
    makeNode({ id: 'CompactLayout:Widget__c.Orphan_Compact', type: 'CompactLayout', apiName: 'Widget__c.Orphan_Compact', parentId: 'CustomObject:Widget__c' }),
    // ---- W11: INTEGRATION-ORPHAN-UNDER-THE-GATE --------------------------
    // My_NamedCred is an UNUSED callout credential (zero inbound references) —
    // the "AWS_US_East_1 is unused" orphan shape. Used_NamedCred is referenced
    // by an Apex `callout:` (an inbound `references` edge), so deleting it is
    // `blocking`. AuthProvider is the kin trust anchor (also gated).
    makeNode({ id: 'NamedCredential:My_NamedCred', type: 'NamedCredential', apiName: 'My_NamedCred' }),
    makeNode({ id: 'NamedCredential:Used_NamedCred', type: 'NamedCredential', apiName: 'Used_NamedCred' }),
    makeNode({ id: 'ApexClass:CalloutClient', apiName: 'CalloutClient', properties: { isTest: false } }),
    makeNode({ id: 'AuthProvider:My_AuthProvider', type: 'AuthProvider', apiName: 'My_AuthProvider' }),
    // ---- REVIEW-CHANGE-RECORD-TRIGGERED-AUTOMATION-FALSE-SAFE -------------
    // ACTIVE save-bound automation whose binding to Ticket__c is OUTBOUND
    // (`triggersOn`, for the Flow/Trigger) or STRUCTURAL (`parentOf` from the
    // object, for the VR) — never an inbound usage edge, so the inbound gate
    // sees 0 dependents and the table calls a delete bare `safe`. Deleting a
    // LIVE save participant must floor to `blocking` (never bare `safe`). The
    // matched inactive siblings are the state-driven controls (must stay safe).
    makeNode({ id: 'CustomObject:Ticket__c', type: 'CustomObject', apiName: 'Ticket__c' }),
    makeNode({ id: 'Flow:BeforeSave_Stamp_Priority', type: 'Flow', apiName: 'BeforeSave_Stamp_Priority', properties: { status: 'Active', triggerType: 'RecordBeforeSave', processType: 'AutoLaunchedFlow' } }),
    makeNode({ id: 'Flow:AfterSave_Sync_Status', type: 'Flow', apiName: 'AfterSave_Sync_Status', properties: { status: 'Active', triggerType: 'RecordAfterSave', processType: 'AutoLaunchedFlow' } }),
    // Obsolete record-triggered Flow — dead plane; delete must STAY safe.
    makeNode({ id: 'Flow:Obsolete_BeforeSave_Flow', type: 'Flow', apiName: 'Obsolete_BeforeSave_Flow', properties: { status: 'Obsolete', triggerType: 'RecordBeforeSave', processType: 'AutoLaunchedFlow' } }),
    // Active ApexTrigger (status Active) + inactive control (status Inactive).
    makeNode({ id: 'ApexTrigger:TicketTrigger', type: 'ApexTrigger', apiName: 'TicketTrigger', properties: { status: 'Active' } }),
    makeNode({ id: 'ApexTrigger:LegacyTicketTrigger', type: 'ApexTrigger', apiName: 'LegacyTicketTrigger', properties: { status: 'Inactive' } }),
    // Active ValidationRule on the object (inbound only parentOf) + inactive control.
    makeNode({ id: 'ValidationRule:Ticket__c.Require_Close_Reason', type: 'ValidationRule', apiName: 'Require_Close_Reason', parentId: 'CustomObject:Ticket__c', properties: { active: true } }),
    makeNode({ id: 'ValidationRule:Ticket__c.Legacy_Rule', type: 'ValidationRule', apiName: 'Legacy_Rule', parentId: 'CustomObject:Ticket__c', properties: { active: false } }),
  ],
  edges: [
    makeEdge({ fromId: 'ApexClass:CheckoutController', toId: 'ApexClass:OrderService', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:OrderServiceTest', toId: 'ApexClass:OrderService', edgeType: 'callsApex' }),
    // REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO: `new X()` instantiation
    // edges. Real vaults mint these as heuristic `references` from the Apex
    // scanner; the covering-test walk never follows them.
    makeEdge({ fromId: 'ApexClass:Silent_Batch_C_Test', toId: 'ApexClass:Silent_Batch_C', edgeType: 'references', confidence: 'heuristic', source: 'apex-scanner', properties: { mechanism: 'instantiation' } }),
    makeEdge({ fromId: 'ApexClass:Unknown_Flag_C_Ref', toId: 'ApexClass:Unknown_Flag_C', edgeType: 'references', confidence: 'heuristic', source: 'apex-scanner', properties: { mechanism: 'instantiation' } }),
    makeEdge({ fromId: 'ApexClass:Prod_Only_C_Caller', toId: 'ApexClass:Prod_Only_C', edgeType: 'references', confidence: 'heuristic', source: 'apex-scanner', properties: { mechanism: 'instantiation' } }),
    // TWO-HOP: unwalked edge FIRST, walked edge second.
    makeEdge({ fromId: 'ApexClass:Deep_Sched_C', toId: 'ApexClass:Deep_Batch_C', edgeType: 'references', confidence: 'heuristic', source: 'apex-scanner', properties: { mechanism: 'instantiation' } }),
    makeEdge({ fromId: 'ApexClass:Deep_Batch_C_Test', toId: 'ApexClass:Deep_Sched_C', edgeType: 'dispatchesAsync' }),
    // TWO-HOP MIRROR: walked edge FIRST, unwalked edge second.
    makeEdge({ fromId: 'ApexClass:Mixed_Helper_C', toId: 'ApexClass:Mixed_Target_C', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:Mixed_Helper_C_Test', toId: 'ApexClass:Mixed_Helper_C', edgeType: 'references', confidence: 'heuristic', source: 'apex-scanner', properties: { mechanism: 'instantiation' } }),
    // LWC → controller (outbound callsApex) + permission wire; test covers controller.
    makeEdge({ fromId: 'ApexClass:PromoControllerTest', toId: 'ApexClass:PromoController', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'LightningComponentBundle:promoPanel', toId: 'ApexClass:PromoController', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'LightningComponentBundle:promoPanel', toId: 'CustomPermission:See_promoPanel', edgeType: 'references' }),
    // Every WideServiceTest calls WideService → 12 covering tests at depth 1.
    ...Array.from({ length: WIDE_TEST_COUNT }, (_, i) =>
      makeEdge({ fromId: wideTestId(i + 1), toId: 'ApexClass:WideService', edgeType: 'callsApex' }),
    ),
    makeEdge({ fromId: 'ApexClass:HeuristicReader', toId: 'CustomField:Account.Rating__c', edgeType: 'readsFrom', confidence: 'heuristic', source: 'apex-scanner' }),
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Rating__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'Flow:FirmFlow', toId: 'CustomField:Account.Firm__c', edgeType: 'readsFrom', confidence: 'parsed', source: 'flow-extractor' }),
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Firm__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'Profile:Admin', toId: 'CustomField:Account.Granted__c', edgeType: 'grantedBy' }),
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Granted__c', edgeType: 'parentOf' }),
    // QuickAction: Layout places My_Action (references) + structural parentOf.
    makeEdge({ fromId: 'Layout:Widget__c.Widget Layout', toId: 'QuickAction:Widget__c.My_Action', edgeType: 'references', properties: { targetKind: 'quickAction' } }),
    makeEdge({ fromId: 'CustomObject:Widget__c', toId: 'QuickAction:Widget__c.My_Action', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'CustomObject:Widget__c', toId: 'QuickAction:Widget__c.Lonely_Action', edgeType: 'parentOf' }),
    // DuplicateRule: structural parentOf + OUTBOUND references to MatchingRule.
    makeEdge({ fromId: 'CustomObject:Contact', toId: 'DuplicateRule:Contact.My_Dup_Rule', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'DuplicateRule:Contact.My_Dup_Rule', toId: 'MatchingRule:Contact.My_Match', edgeType: 'references' }),
    makeEdge({ fromId: 'CustomObject:Contact', toId: 'DuplicateRule:Contact.Off_Dup_Rule', edgeType: 'parentOf' }),
    // CustomPermission: PermissionSet + Profile granters (grantedBy, inbound).
    makeEdge({ fromId: 'PermissionSet:Reviewer_PS', toId: 'CustomPermission:My_Perm', edgeType: 'grantedBy' }),
    makeEdge({ fromId: 'Profile:Reviewer_Profile', toId: 'CustomPermission:My_Perm', edgeType: 'grantedBy' }),
    // Compact layout's only edge is the structural parentOf (excluded) — its
    // placement assignment on the object XML is unmodelled, so 0 usage deps.
    makeEdge({ fromId: 'CustomObject:Widget__c', toId: 'CompactLayout:Widget__c.Orphan_Compact', edgeType: 'parentOf' }),
    // W11: Apex `callout:Used_NamedCred` → an inbound `references` dependency.
    makeEdge({ fromId: 'ApexClass:CalloutClient', toId: 'NamedCredential:Used_NamedCred', edgeType: 'references' }),
    // REVIEW-CHANGE-RECORD-TRIGGERED-AUTOMATION-FALSE-SAFE: save-firer bindings.
    // Flows / ApexTriggers bind OUTBOUND to their object via `triggersOn`; the
    // VRs bind via the object's structural `parentOf` (excluded as a dependent).
    // Every firer therefore has ZERO inbound usage edges — the whole point.
    makeEdge({ fromId: 'Flow:BeforeSave_Stamp_Priority', toId: 'CustomObject:Ticket__c', edgeType: 'triggersOn', properties: { triggerType: 'RecordBeforeSave' } }),
    makeEdge({ fromId: 'Flow:AfterSave_Sync_Status', toId: 'CustomObject:Ticket__c', edgeType: 'triggersOn', properties: { triggerType: 'RecordAfterSave' } }),
    makeEdge({ fromId: 'Flow:Obsolete_BeforeSave_Flow', toId: 'CustomObject:Ticket__c', edgeType: 'triggersOn', properties: { triggerType: 'RecordBeforeSave' } }),
    makeEdge({ fromId: 'ApexTrigger:TicketTrigger', toId: 'CustomObject:Ticket__c', edgeType: 'triggersOn' }),
    makeEdge({ fromId: 'ApexTrigger:LegacyTicketTrigger', toId: 'CustomObject:Ticket__c', edgeType: 'triggersOn' }),
    makeEdge({ fromId: 'CustomObject:Ticket__c', toId: 'ValidationRule:Ticket__c.Require_Close_Reason', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'CustomObject:Ticket__c', toId: 'ValidationRule:Ticket__c.Legacy_Rule', edgeType: 'parentOf' }),
  ],
};

let dir: string;
let store: GraphStore;
const ctxWith = (coverage: readonly CoverageEntry[] | undefined): Context => ({
  vaultRoot: dir,
  manifest: manifestWith(coverage),
  graph: store,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-review-change-'));
  const opened = await openGraph(join(dir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [SEED]);
  if (!imp.ok) throw new Error(imp.error.message);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

describe('reviewChangeHandler — classification', () => {
  it('deleted component WITH dependents = blocking (drives the exit-code gate)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('blocking');
    // CheckoutController + OrderServiceTest are firm dependents; nothing excluded.
    expect(c?.dependentCount).toBe(2);
    expect(r.value.data.overallVerdict).toBe('blocking');
    expect(r.value.data.summary.blocking).toBe(1);
    expect(r.value.data.recommendation).toMatch(/DEPLOY GATE/);
  });

  it('clean modified component (0 deps, family covered) = safe, no coverage caveat', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'LonelyService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('safe');
    expect(c?.dependentCount).toBe(0);
    expect(r.value.data.coverageCaveat).toBeUndefined();
    expect(r.value.data.overallVerdict).toBe('safe');
  });

  // REVIEW-CHANGE-LWC-SAFE-IGNORES-CONTROLLER-AND-PAGE-WIRE: a modified LWC with
  // ZERO incoming dependents is `safe` under the inbound-only gate, but its
  // outbound wiring (controller callsApex + permission ref) is real promotion
  // risk. FAILS pre-fix (verdict safe, selectedTests [], no outboundApex).
  it('modified frontend bundle floors at review, selects controller tests, surfaces outbound wiring', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [
        { type: 'LightningComponentBundle', apiName: 'promoPanel', changeKind: 'modified' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    // Not a bare `safe`: outbound wiring floors it at review.
    expect(c?.verdict).toBe('review');
    expect(c?.dependentCount).toBe(0); // no incoming dependents — the whole point
    // Outbound callsApex + permission/page wiring is surfaced.
    expect(c?.outboundApex).toContain('ApexClass:PromoController');
    expect(c?.outboundWires).toContain('CustomPermission:See_promoPanel');
    // The controller's covering test is selected for the LWC promotion.
    expect(c?.selectedTests).toContain('ApexClass:PromoControllerTest');
    expect(r.value.data.selectedTests).toContain('ApexClass:PromoControllerTest');
    expect(r.value.data.summary.testsToRun).toBeGreaterThanOrEqual(1);
    expect(r.value.data.overallVerdict).toBe('review');
  });

  it('modified field with HEURISTIC-only readers = review (not risky)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Rating__c', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('review');
    expect(c?.dependentCount).toBe(1); // parentOf excluded; only the heuristic reader
    expect(c?.weakestDependentConfidence).toBe('heuristic');
  });

  it('modified field with a FIRM (parsed) reader = risky', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Firm__c', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('risky');
    expect(c?.dependentCount).toBe(1);
    expect(c?.weakestDependentConfidence).toBe('parsed');
  });

  it('excludes grantedBy and parentOf from dependents (access ≠ usage)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Granted__c', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    // Only a Profile grantedBy edge + a parentOf edge → both excluded → 0 deps.
    expect(c?.dependentCount).toBe(0);
    expect(c?.verdict).toBe('safe');
  });

  it('deleted with 0 deps but PARTIAL coverage = review + top-level coverage caveat', async () => {
    const r = await reviewChangeHandler(ctxWith(FIELD_PARTIAL_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Granted__c', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0);
    expect(c?.verdict).toBe('review');
    expect(c?.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toEqual(
      expect.arrayContaining(['CustomField']),
    );
  });

  it('added component NOT in the vault = safe (forward refs not analysed)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'BrandNewService', changeKind: 'added' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('safe');
    expect(c?.inVault).toBe(false);
    expect(c?.reason).toMatch(/not analysed for their own contents|forward references/i);
  });

  it('added component that COLLIDES with an existing id = review', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'added' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('review');
    expect(c?.inVault).toBe(true);
    expect(c?.reason).toMatch(/name collision|already exists/i);
  });

  it('modified but NOT in vault = review + counted in notInVault', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'GhostClass', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('review');
    expect(c?.inVault).toBe(false);
    expect(r.value.data.summary.notInVault).toBe(1);
  });
});

describe('reviewChangeHandler — placement / active-rule / grant dependents', () => {
  // REVIEW-CHANGE-SAFE-ON-DELETE-QUICKACTION. The Layout→QuickAction
  // `references` edge exists in the extractor but realizes on a real vault only
  // after refresh, so the flip is exercised offline against a synthetic edge:
  // with a Layout placing it, deleting the QuickAction genuinely flips to
  // blocking (a real referrer, not a caveat). Lonely_Action models the
  // unrefreshed (edge-absent) state that the extractor+refresh resolves.
  it('deleting a QuickAction a Layout places (references edge) flips to blocking', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'QuickAction', apiName: 'Widget__c.My_Action', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).not.toBe('safe');
    expect(c?.verdict).toBe('blocking');
    // Only the Layout counts — the structural parentOf from Widget__c is excluded.
    expect(c?.dependentCount).toBe(1);
    expect(c?.dependents).toContain('Layout:Widget__c.Widget Layout');
  });

  // REVIEW-CHANGE-SAFE-ON-DELETE-DUPLICATE-RULE. An ACTIVE dup rule fires on
  // insert; its only edges are the excluded parentOf and an OUTBOUND
  // references, so the inbound gate saw 0 dependents and called delete `safe`.
  // The active-state floors it at review (never bare safe). FAILS pre-fix.
  it('deleting an ACTIVE DuplicateRule is not bare-safe (floors at review)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'DuplicateRule', apiName: 'Contact.My_Dup_Rule', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).not.toBe('safe');
    expect(c?.verdict).toBe('review');
    expect(c?.dependentCount).toBe(0); // inbound-blind — the point
    expect(c?.reason).toMatch(/active/i);
  });

  // An INACTIVE dup rule stays safe — the floor is state-driven, not a blanket
  // type floor (proves the fix is not camouflage).
  it('deleting an INACTIVE DuplicateRule stays safe', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'DuplicateRule', apiName: 'Contact.Off_Dup_Rule', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('safe');
  });

  // A modified ACTIVE DuplicateRule is also not bare-safe.
  it('modifying an ACTIVE DuplicateRule is not bare-safe (floors at review)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'DuplicateRule', apiName: 'Contact.My_Dup_Rule', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('review');
  });

  // REVIEW-CHANGE-SAFE-ON-DELETE-CUSTOM-PERMISSION. A CustomPermission's inbound
  // grantedBy granters (PermissionSet + Profile) ARE breakage dependents — the
  // granters reference it by name. Delete must genuinely flip to blocking.
  // FAILS pre-fix (grantedBy was globally excluded → 0 deps → safe).
  it('deleting a CustomPermission counts grantedBy granters as dependents (blocking)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CustomPermission', apiName: 'My_Perm', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).not.toBe('safe');
    expect(c?.verdict).toBe('blocking');
    expect(c?.dependentCount).toBe(2);
    expect(c?.dependents).toEqual(
      expect.arrayContaining(['PermissionSet:Reviewer_PS', 'Profile:Reviewer_Profile']),
    );
  });

  // A CustomField's grantedBy FLS grant stays EXCLUDED (access ≠ usage) — the
  // grant un-exclusion is scoped to CustomPermission only.
  it('a CustomField grantedBy grant is still excluded (access ≠ usage) after the CustomPermission fix', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Granted__c', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0);
    expect(c?.verdict).toBe('safe');
  });
});

// ===========================================================================
// REVIEW-CHANGE-RECORD-TRIGGERED-AUTOMATION-FALSE-SAFE (P0 destructive trust)
//
// An ACTIVE save-bound automation binds to its object OUTSIDE the inbound-
// dependent model: a record-triggered (before/after-save) Flow and an
// ApexTrigger bind OUTBOUND via `triggersOn`; a ValidationRule binds via the
// object's structural `parentOf` (excluded as a dependent). Each therefore has
// ZERO inbound usage edges, so the classification table under-called a delete
// bare `safe` — a false-safe destructive verdict on a live save participant.
// The firing-binding floor lifts a delete to `blocking` and a modify to
// `review`; an Inactive/Obsolete automation does NOT fire and keeps its table
// verdict (state-driven, not a blanket type floor). All controls use
// COMPLETE_COVERAGE so the flip is driven by the LIVENESS floor, not a coverage
// caveat (ApexTrigger / ValidationRule have EMPTY usage-source families, so a
// 0-dep delete is `safe` on ANY coverage pre-fix — the whole point).
// ===========================================================================
describe('reviewChangeHandler — active save-firer floor (record-triggered Flow / ApexTrigger / VR)', () => {
  // FAILS pre-fix: an Active RecordBeforeSave Flow with only an OUTBOUND
  // triggersOn binding shows 0 inbound dependents → table `safe`.
  it('deleting an ACTIVE before-save Flow (triggersOn a CustomObject) is not bare-safe (blocking)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'Flow', apiName: 'BeforeSave_Stamp_Priority', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0); // inbound-blind — the whole point
    expect(c?.verdict).not.toBe('safe');
    expect(c?.verdict).toBe('blocking');
    expect(c?.reason).toMatch(/fires on save|save transaction|record-triggered/i);
    expect(r.value.data.overallVerdict).toBe('blocking');
  });

  it('deleting an ACTIVE after-save Flow is also not bare-safe (blocking)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'Flow', apiName: 'AfterSave_Sync_Status', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('blocking');
  });

  // FAILS pre-fix: an Active ApexTrigger has EMPTY usage-source families, so a
  // 0-dep delete was bare `safe` on ANY coverage — now floored on liveness.
  it('deleting an ACTIVE ApexTrigger (triggersOn a CustomObject) is not bare-safe (blocking)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexTrigger', apiName: 'TicketTrigger', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0);
    expect(c?.verdict).not.toBe('safe');
    expect(c?.verdict).toBe('blocking');
    expect(c?.reason).toMatch(/ApexTrigger|fires on save/i);
  });

  // FAILS pre-fix: an Active VR's ONLY inbound edge is the structural parentOf
  // from its object (excluded as a dependent) → 0 deps → bare `safe`.
  it('deleting an ACTIVE ValidationRule on an object (inbound only parentOf) is not bare-safe (blocking)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [
        { type: 'ValidationRule', apiName: 'Ticket__c.Require_Close_Reason', changeKind: 'deleted' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0); // parentOf excluded — the whole point
    expect(c?.verdict).not.toBe('safe');
    expect(c?.verdict).toBe('blocking');
    expect(c?.reason).toMatch(/ValidationRule|save/i);
  });

  // MODIFY of a live save participant floors at `review` (never bare safe) — a
  // behaviour change, not a removal. Proves the delete/modify split.
  it('modifying an ACTIVE before-save Flow is not bare-safe (floors at review)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'Flow', apiName: 'BeforeSave_Stamp_Priority', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).not.toBe('safe');
    expect(c?.verdict).toBe('review');
  });

  // STATE-DRIVEN control 1: an OBSOLETE record-triggered Flow does NOT fire —
  // it stays `safe` (dead plane), proving the floor is not a blanket type floor.
  it('deleting an OBSOLETE record-triggered Flow stays safe (dead plane)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'Flow', apiName: 'Obsolete_BeforeSave_Flow', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('safe');
  });

  // STATE-DRIVEN control 2: an INACTIVE ApexTrigger does not fire → stays safe.
  it('deleting an INACTIVE ApexTrigger stays safe (dead plane)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexTrigger', apiName: 'LegacyTicketTrigger', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('safe');
  });

  // STATE-DRIVEN control 3: an INACTIVE ValidationRule does not fire → stays safe.
  it('deleting an INACTIVE ValidationRule stays safe (dead plane)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [
        { type: 'ValidationRule', apiName: 'Ticket__c.Legacy_Rule', changeKind: 'deleted' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('safe');
  });

  // CALIBRATION: a NON-record-triggered Active Flow (screen/scheduled — no save
  // triggerType, no triggersOn binding) is NOT a save participant, so it keeps
  // its table verdict. Orphan_Screen_Flow (status Active, no triggerType) stays
  // `safe` under full coverage — the floor targets save firers only.
  it('CALIBRATED: an Active screen Flow (no save trigger) is NOT floored — stays safe', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'Flow', apiName: 'Orphan_Screen_Flow', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('safe');
  });
});

describe('reviewChangeHandler — GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE (usage-source coverage)', () => {
  // The central honesty contract: a 0-inbound-usage-edge component is `safe` to
  // delete ONLY when the vault covers every family that could REFERENCE it. When
  // the family that would PLACE it (FlexiPage / CustomSite / CustomObject) was
  // not modelled, the empty edge set is "not checked", not proven "none" — the
  // verdict must FLIP to `review` with a coverageCaveat naming the plane. The
  // matched full-coverage control proves this is a calibrated contract, not a
  // blanket floor (both directions asserted, per the DoD).

  // ---- Fixture A: Screen Flow embedded on a FlexiPage, embed plane omitted ---
  it('FLIP: deleting a 0-edge Flow with FlexiPage coverage MISSING is not safe (review + caveat)', async () => {
    const r = await reviewChangeHandler(
      { ...ctxWith(coveragePartialFor('FlexiPage')) },
      { components: [{ type: 'Flow', apiName: 'Orphan_Screen_Flow', changeKind: 'deleted' }] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0); // inbound-blind — the whole point
    expect(c?.verdict).not.toBe('safe');
    expect(c?.verdict).toBe('review');
    // The caveat names the un-retrieved plane that could embed the flow.
    expect(c?.coverageCaveat).toBeDefined();
    expect(c?.coverageCaveat?.missingCoverage).toContain('FlexiPage');
    expect(r.value.data.overallVerdict).toBe('review');
  });

  it('STAYS SAFE: deleting the SAME 0-edge Flow with FULL coverage is safe, no caveat', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'Flow', apiName: 'Orphan_Screen_Flow', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0);
    expect(c?.verdict).toBe('safe');
    expect(c?.coverageCaveat).toBeUndefined();
    expect(r.value.data.overallVerdict).toBe('safe');
  });

  // ---- Fixture F: VF page placed as a site index/template, site plane omitted -
  it('FLIP: deleting a 0-edge VisualforcePage with CustomSite coverage MISSING is not safe', async () => {
    const r = await reviewChangeHandler(
      { ...ctxWith(coveragePartialFor('CustomSite')) },
      { components: [{ type: 'VisualforcePage', apiName: 'Orphan_Site_Page', changeKind: 'deleted' }] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0);
    expect(c?.verdict).toBe('review');
    expect(c?.coverageCaveat?.missingCoverage).toContain('CustomSite');
  });

  it('STAYS SAFE: deleting the SAME 0-edge VisualforcePage with FULL coverage is safe', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'VisualforcePage', apiName: 'Orphan_Site_Page', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('safe');
    expect(c?.coverageCaveat).toBeUndefined();
  });

  // ---- Fixture G: CompactLayout assigned on an object, assignment plane omitted
  it('FLIP: deleting a 0-edge CompactLayout with CustomObject coverage MISSING is not safe', async () => {
    const r = await reviewChangeHandler(
      { ...ctxWith(coveragePartialFor('CustomObject')) },
      { components: [{ type: 'CompactLayout', apiName: 'Widget__c.Orphan_Compact', changeKind: 'deleted' }] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0); // only parentOf inbound — excluded
    expect(c?.verdict).toBe('review');
    expect(c?.coverageCaveat?.missingCoverage).toContain('CustomObject');
  });

  it('STAYS SAFE: deleting the SAME 0-edge CompactLayout with FULL coverage is safe', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CompactLayout', apiName: 'Widget__c.Orphan_Compact', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('safe');
    expect(r.value.data.reviewed[0]?.coverageCaveat).toBeUndefined();
  });

  // Calibration proof that an IRRELEVANT coverage gap does NOT flip the verdict:
  // a CompactLayout is placed only by CustomObject / RecordType, so a missing
  // FlexiPage plane (which cannot place a compact layout) leaves it `safe`. This
  // is what separates the calibrated per-type contract from a blanket floor.
  it('CALIBRATED: a gap in an IRRELEVANT plane (FlexiPage) leaves a CompactLayout safe', async () => {
    const r = await reviewChangeHandler(
      { ...ctxWith(coveragePartialFor('FlexiPage')) },
      { components: [{ type: 'CompactLayout', apiName: 'Widget__c.Orphan_Compact', changeKind: 'deleted' }] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('safe');
    expect(r.value.data.reviewed[0]?.coverageCaveat).toBeUndefined();
  });
});

// ===========================================================================
// W11 — INTEGRATION-ORPHAN-UNDER-THE-GATE
// A callout NamedCredential that Apex uses returns `blocking` (the inbound
// `references` gate already catches it — the positive control). The residual:
// an UNUSED credential returned bare `safe` to delete even when the callout
// plane's coverage was UNKNOWN, AND over-fired to `review` when an IRRELEVANT
// plane (Report/Dashboard/Layout — which cannot reference a credential) was
// partial. The fix routes these types through the L1 gate with the precise
// callout-site families + the fail-harder `fireOnUnknownCoverage` stance.
// ===========================================================================
describe('reviewChangeHandler — W11 integration-orphan gate (NamedCredential / kin)', () => {
  // Callout-site families a credential can be referenced through, all COMPLETE,
  // with every other DEFAULT producer plane also covered so the ONLY partial
  // plane in the over-fire test is the irrelevant one.
  const CALLOUT_COMPLETE_UNIVERSE = [
    ...new Set([
      ...DEFAULT_USAGE_SOURCE_FAMILIES,
      'ExternalService',
      'OmniIntegrationProcedure',
      'NamedCredential',
      'ExternalDataSource',
    ]),
  ];

  // POSITIVE CONTROL: a referenced credential is `blocking` (unchanged) — the
  // gate never touches the has-dependents path.
  it('CONTROL: deleting a USED NamedCredential (Apex callout) is blocking', async () => {
    const r = await reviewChangeHandler(ctxWith(CALLOUT_COMPLETE_UNIVERSE.map(coveredRow)), {
      components: [{ type: 'NamedCredential', apiName: 'Used_NamedCred', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('blocking');
    expect(c?.dependentCount).toBe(1);
  });

  // FLIP (fail-harder on UNKNOWN coverage): an unused credential on a vault that
  // carries NO coverage rows must NOT be bare `safe` — the callout plane it
  // depends on is the most under-extracted. FAILS pre-fix (verdict `safe`, no
  // caveat, because review_change tolerated legacy vaults for every type).
  it('FLIP: unused NamedCredential on an UNKNOWN-coverage vault is review, not bare safe', async () => {
    const r = await reviewChangeHandler(ctxWith(undefined), {
      components: [{ type: 'NamedCredential', apiName: 'My_NamedCred', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0); // inbound-blind — the whole point
    expect(c?.verdict).not.toBe('safe');
    expect(c?.verdict).toBe('review');
    expect(c?.coverageCaveat).toBeDefined();
    // The caveat names the callout-usage plane, not the broad producer union.
    expect(c?.coverageCaveat?.missingCoverage).toContain('ApexClass');
    expect(r.value.data.overallVerdict).toBe('review');
  });

  // STAYS SAFE + precise calibration (over-fire fixed): with the callout-site
  // planes COMPLETE, a partial IRRELEVANT plane (Dashboard — which cannot
  // reference a credential) must leave the delete `safe`. FAILS pre-fix, where
  // the DEFAULT-union gate downgraded it to `review` on the Dashboard gap alone.
  it('STAYS SAFE: unused NamedCredential with callout planes covered is safe despite an irrelevant Dashboard gap', async () => {
    const coverage = CALLOUT_COMPLETE_UNIVERSE.map((t) =>
      t === 'Dashboard' ? partialRow(t) : coveredRow(t),
    );
    const r = await reviewChangeHandler(ctxWith(coverage), {
      components: [{ type: 'NamedCredential', apiName: 'My_NamedCred', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0);
    expect(c?.verdict).toBe('safe');
    expect(c?.coverageCaveat).toBeUndefined();
  });

  // STAYS SAFE (both callout planes fully attested): a genuinely-unused
  // credential on a fully-covered callout surface still reads `safe` — the gate
  // is calibrated, not a blanket floor on the type.
  it('STAYS SAFE: unused NamedCredential with the full callout surface covered is safe', async () => {
    const r = await reviewChangeHandler(ctxWith(CALLOUT_COMPLETE_UNIVERSE.map(coveredRow)), {
      components: [{ type: 'NamedCredential', apiName: 'My_NamedCred', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('safe');
    expect(c?.coverageCaveat).toBeUndefined();
  });

  // KIN: the same gate covers AuthProvider (and ExternalDataSource) — an unused
  // trust anchor on an unknown-coverage vault is review, not bare safe.
  it('KIN: unused AuthProvider on an UNKNOWN-coverage vault is review, not bare safe', async () => {
    const r = await reviewChangeHandler(ctxWith(undefined), {
      components: [{ type: 'AuthProvider', apiName: 'My_AuthProvider', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('review');
    expect(c?.coverageCaveat).toBeDefined();
  });
});

describe('reviewChangeHandler — tests_for_change composition', () => {
  it('maps covering tests to a modified Apex class and unions them', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.testCoverage).toBe('covered');
    expect(c?.selectedTests).toContain('ApexClass:OrderServiceTest');
    expect(r.value.data.selectedTests).toContain('ApexClass:OrderServiceTest');
    expect(r.value.data.summary.testsToRun).toBeGreaterThanOrEqual(1);
  });

  it('marks a non-Apex change as not-applicable for tests', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Firm__c', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.testCoverage).toBe('not-applicable');
  });

  it('counts an uncovered changed Apex class', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'LonelyService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.testCoverage).toBe('uncovered');
    expect(r.value.data.summary.uncoveredApex).toBe(1);
  });
});

describe('reviewChangeHandler — ordering and byte budget', () => {
  it('orders most-dangerous first', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [
        { type: 'ApexClass', apiName: 'LonelyService', changeKind: 'modified' }, // safe
        { type: 'ApexClass', apiName: 'OrderService', changeKind: 'deleted' }, // blocking
        { type: 'CustomField', apiName: 'Account.Firm__c', changeKind: 'modified' }, // risky
        { type: 'CustomField', apiName: 'Account.Rating__c', changeKind: 'modified' }, // review
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const verdicts = r.value.data.reviewed.map((c) => c.verdict);
    expect(verdicts).toEqual(['blocking', 'risky', 'review', 'safe']);
  });

  it('caps the inlined rows at `limit` while keeping full summary tallies + truncated flag', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [
        { type: 'ApexClass', apiName: 'OrderService', changeKind: 'deleted' }, // blocking
        { type: 'CustomField', apiName: 'Account.Firm__c', changeKind: 'modified' }, // risky
        { type: 'ApexClass', apiName: 'LonelyService', changeKind: 'modified' }, // safe
      ],
      limit: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed.length).toBe(1);
    // The blocking row survives the cap (sorts first) — the gate is never hidden.
    expect(r.value.data.reviewed[0]?.verdict).toBe('blocking');
    expect(r.value.data.summary.total).toBe(3);
    expect(r.value.data.summary.blocking).toBe(1);
    expect(r.value.data.summary.truncated).toBe(true);
    expect(r.value.data.overallVerdict).toBe('blocking');
  });

  it('surfaces the verbatim disclosure and boundaries', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/LAST VAULT REFRESH/);
    expect(r.value.data.disclosure).toMatch(/access.?usage|grantedBy/);
    expect(r.value.data.disclosure).toMatch(/SELECTION ≠ VALIDATION/);
    expect(r.value.data.boundaries.length).toBeGreaterThanOrEqual(3);
  });
});

describe('classify — pins every row of the table', () => {
  const base = { inVault: true, dependentCount: 0, allHeuristic: false, weakest: null, familyCovered: true } as const;

  it('deleted + deps → blocking', () => {
    expect(classify({ ...base, changeKind: 'deleted', dependentCount: 2, weakest: 'declared' }).verdict).toBe('blocking');
  });
  it('deleted + 0 deps + covered → safe', () => {
    expect(classify({ ...base, changeKind: 'deleted' }).verdict).toBe('safe');
  });
  it('deleted + 0 deps + NOT covered → review', () => {
    expect(classify({ ...base, changeKind: 'deleted', familyCovered: false }).verdict).toBe('review');
  });
  it('deleted + not in vault → review', () => {
    expect(classify({ ...base, changeKind: 'deleted', inVault: false }).verdict).toBe('review');
  });
  it('modified + firm deps → risky', () => {
    expect(classify({ ...base, changeKind: 'modified', dependentCount: 1, weakest: 'parsed' }).verdict).toBe('risky');
  });
  it('modified + heuristic-only deps → review', () => {
    expect(classify({ ...base, changeKind: 'modified', dependentCount: 1, allHeuristic: true, weakest: 'heuristic' }).verdict).toBe('review');
  });
  it('modified + 0 deps + covered → safe', () => {
    expect(classify({ ...base, changeKind: 'modified' }).verdict).toBe('safe');
  });
  it('modified + 0 deps + NOT covered → review', () => {
    expect(classify({ ...base, changeKind: 'modified', familyCovered: false }).verdict).toBe('review');
  });
  it('modified + not in vault → review', () => {
    expect(classify({ ...base, changeKind: 'modified', inVault: false }).verdict).toBe('review');
  });
  it('added + not in vault → safe', () => {
    expect(classify({ ...base, changeKind: 'added', inVault: false }).verdict).toBe('safe');
  });
  it('added + in vault (collision) → review', () => {
    expect(classify({ ...base, changeKind: 'added' }).verdict).toBe('review');
  });
});

describe('reviewChangeInputSchema', () => {
  it('accepts a well-formed change set', () => {
    expect(
      reviewChangeInputSchema.safeParse({
        components: [{ type: 'ApexClass', apiName: 'X', changeKind: 'modified' }],
      }).success,
    ).toBe(true);
  });
  it('rejects an empty component list', () => {
    expect(reviewChangeInputSchema.safeParse({ components: [] }).success).toBe(false);
  });
  it('rejects an unknown changeKind', () => {
    expect(
      reviewChangeInputSchema.safeParse({
        components: [{ type: 'ApexClass', apiName: 'X', changeKind: 'renamed' }],
      }).success,
    ).toBe(false);
  });

  // REVIEW-CHANGE-REJECTS-COMPONENTID: a host that forwards the canonical id
  // from sfi.resolve (`componentId: Type:ApiName`) must be accepted and
  // normalised to the SAME { type, apiName, changeKind } as the explicit pair.
  it('normalises a componentId selector to the same shape as the explicit pair', () => {
    const viaId = reviewChangeInputSchema.safeParse({
      components: [{ componentId: 'ApexClass:X', changeKind: 'deleted' }],
    });
    const viaPair = reviewChangeInputSchema.safeParse({
      components: [{ type: 'ApexClass', apiName: 'X', changeKind: 'deleted' }],
    });
    expect(viaId.success).toBe(true);
    expect(viaPair.success).toBe(true);
    if (!viaId.success || !viaPair.success) return;
    expect(viaId.data.components[0]).toEqual({
      type: 'ApexClass',
      apiName: 'X',
      changeKind: 'deleted',
    });
    expect(viaId.data.components[0]).toEqual(viaPair.data.components[0]);
  });

  it('splits a componentId on the FIRST colon (dotted apiName survives)', () => {
    const res = reviewChangeInputSchema.safeParse({
      components: [{ componentId: 'CustomField:Account.Industry__c', changeKind: 'modified' }],
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.components[0]).toEqual({
      type: 'CustomField',
      apiName: 'Account.Industry__c',
      changeKind: 'modified',
    });
  });

  it('accepts a mixed batch of pair and componentId selectors', () => {
    const res = reviewChangeInputSchema.safeParse({
      components: [
        { type: 'ApexClass', apiName: 'X', changeKind: 'modified' },
        { componentId: 'ApexClass:Y', changeKind: 'deleted' },
      ],
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.components).toEqual([
      { type: 'ApexClass', apiName: 'X', changeKind: 'modified' },
      { type: 'ApexClass', apiName: 'Y', changeKind: 'deleted' },
    ]);
  });

  it('rejects an entry with neither selector', () => {
    expect(
      reviewChangeInputSchema.safeParse({
        components: [{ changeKind: 'deleted' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a componentId with no colon', () => {
    expect(
      reviewChangeInputSchema.safeParse({
        components: [{ componentId: 'ApexClass', changeKind: 'deleted' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a componentId with a trailing colon (empty apiName)', () => {
    expect(
      reviewChangeInputSchema.safeParse({
        components: [{ componentId: 'ApexClass:', changeKind: 'deleted' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a componentId with a leading colon (empty type)', () => {
    expect(
      reviewChangeInputSchema.safeParse({
        components: [{ componentId: ':X', changeKind: 'deleted' }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2 — REVIEW-CHANGE-SELECTED-TESTS-SILENT-TRUNCATION
//
// The per-component covering-test list is sample-capped at TEST_SAMPLE_CAP (10).
// Pre-fix the row carried the truncated array and NOTHING else: no count, no
// flag. `testCoverage` is a three-value enum ('covered') and `summary.testsToRun`
// is the union across the WHOLE change set, so neither recovers the per-component
// total — an operator modifying a class with 12 covering tests was handed 10 and
// told by `recommendation` to run "the N selected test(s) before deploying".
// The row must disclose its true total the way `dependentCount` already does
// beside the identically sample-capped `dependents`.
// ---------------------------------------------------------------------------
describe('reviewChangeHandler — per-component covering-test truncation honesty', () => {
  it('discloses the TRUE covering-test count when the sample cap bites', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'WideService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.id).toBe('ApexClass:WideService');
    expect(c?.testCoverage).toBe('covered');
    // The cap really bites: 12 covering tests exist, 10 are inlined.
    expect(c?.selectedTests).toHaveLength(10);
    // …so the row MUST carry the total, exactly as `dependentCount` does.
    expect(c?.selectedTestCount).toBe(WIDE_TEST_COUNT);
    expect(c?.selectedTestCount).toBeGreaterThan(c?.selectedTests.length ?? 0);
  });

  it('neither testCoverage nor summary.testsToRun recovers the per-component total', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [
        { type: 'ApexClass', apiName: 'WideService', changeKind: 'modified' },
        { type: 'ApexClass', apiName: 'OrderService', changeKind: 'modified' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wide = r.value.data.reviewed.find((c) => c.id === 'ApexClass:WideService');
    const order = r.value.data.reviewed.find((c) => c.id === 'ApexClass:OrderService');
    // Both read 'covered' — the enum carries no number.
    expect(wide?.testCoverage).toBe('covered');
    expect(order?.testCoverage).toBe('covered');
    // The union is across the whole change set, so it is NOT either row's total.
    expect(r.value.data.summary.testsToRun).toBe(WIDE_TEST_COUNT + 1);
    expect(wide?.selectedTestCount).toBe(WIDE_TEST_COUNT);
    expect(order?.selectedTestCount).toBe(1);
  });

  it('an UNCAPPED row reports count === inlined length (the count is derived, not a constant)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.selectedTests).toEqual(['ApexClass:OrderServiceTest']);
    expect(c?.selectedTestCount).toBe(1);
  });

  it('a component with NO covering tests reports 0, not a truncation', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'LonelyService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.testCoverage).toBe('uncovered');
    expect(c?.selectedTests).toEqual([]);
    expect(c?.selectedTestCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REVIEW-CHANGE-UNCOVERED-IS-A-NOT-CHECKED-ZERO
//
// The measured real-org defect: the deploy gate returned, for a MODIFIED Apex
// class, `testCoverage: 'uncovered'` + `selectedTests: []` +
// `summary.testsToRun: 0` + `trust.completeness.status: 'complete'` +
// `trust.limitations: []`, while the SAME payload listed the class's own test
// class in `dependents`. The covering-test walk it composes traverses only
// `callsApex` / `dispatchesAsync`; a test that exercises the class through
// `new Class_C()` reaches it via a `references` edge (`mechanism:
// 'instantiation'`) the walk never follows — DIRECTLY, or with a production
// class in between. Measured on the owner's production vault (112 production
// Apex classes, of which the composed walk covers 74 and reports 38 as zero):
// 12 of those 38 have a test class as a DIRECT unwalked referrer, and a
// further 10 are reached by a test over a longer path whose first or last hop
// is unwalked. Under the closure rule 22 of the 38 become `unknown` and 16
// stay `uncovered` — so `uncovered` had been a NOT-CHECKED zero certified as a
// checked one, and a host reading the structured fields tells the developer
// "there are no tests to run".
// ---------------------------------------------------------------------------
describe('reviewChangeHandler — an unwalked test referrer makes the zero UNKNOWN, not "uncovered"', () => {
  it('does not certify `uncovered` when a test class reaches the change through an unwalked edge', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'Silent_Batch_C', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    // The walk really did find no covering test — that part is unchanged.
    expect(c?.selectedTests).toEqual([]);
    expect(r.value.data.summary.testsToRun).toBe(0);
    // …but the STATUS must not be an affirmative "no test covers this".
    expect(c?.testCoverage).toBe('unknown');
    // The blind spot is in a TYPED field a machine consumer cannot skip.
    expect(c?.uncheckedTestReferrers).toEqual(['ApexClass:Silent_Batch_C_Test']);
    // It is NOT counted as proven-unguarded Apex.
    expect(r.value.data.summary.uncoveredApex).toBe(0);
    expect(r.value.data.summary.unknownTestCoverage).toBe(1);
  });

  it('a payload that cannot decide test coverage does not report completeness `complete` with zero limitations', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'Silent_Batch_C', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.trust.completeness.status).not.toBe('complete');
    expect(r.value.data.trust.limitations.length).toBeGreaterThan(0);
    expect(r.value.data.trust.limitations.join(' ')).toMatch(/test coverage/i);
    // A host reads the recommendation aloud — the gap must be in the prose too.
    expect(r.value.data.recommendation).toMatch(/test coverage could not be determined/i);
    // …and the row's own reason names it.
    expect(r.value.data.reviewed[0]?.reason).toMatch(/instantiation|covering-test walk/i);
  });

  it('R1: a referrer whose `isTest` was NEVER EXTRACTED is unknown, not "known not a test"', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'Unknown_Flag_C', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.testCoverage).toBe('unknown');
    expect(c?.uncheckedTestReferrers).toEqual(['ApexClass:Unknown_Flag_C_Ref']);
  });

  it('TWO HOPS: a test that reaches the change THROUGH a production class still makes the zero unknown', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'Deep_Batch_C', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    // NO direct referrer of this class is a test — a depth-1 detector sees
    // only the production instantiator and certifies `uncovered`.
    expect(c?.dependents).toEqual(['ApexClass:Deep_Sched_C']);
    expect(c?.selectedTests).toEqual([]);
    expect(c?.testCoverage).toBe('unknown');
    // The class NAMED is the test to run, not the production class in between.
    expect(c?.uncheckedTestReferrers).toEqual(['ApexClass:Deep_Batch_C_Test']);
    expect(r.value.data.summary.uncoveredApex).toBe(0);
    expect(r.value.data.summary.unknownTestCoverage).toBe(1);
    expect(r.value.data.trust.completeness.status).not.toBe('complete');
    expect(r.value.data.trust.limitations.length).toBeGreaterThan(0);
  });

  it('TWO HOPS, mirrored: the unwalked edge is the SECOND hop and the zero is still unknown', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'Mixed_Target_C', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.selectedTests).toEqual([]);
    expect(c?.testCoverage).toBe('unknown');
    expect(c?.uncheckedTestReferrers).toEqual(['ApexClass:Mixed_Helper_C_Test']);
    expect(r.value.data.summary.uncoveredApex).toBe(0);
    expect(r.value.data.trust.limitations.length).toBeGreaterThan(0);
  });

  it('CONTROL: a production referrer with NO test anywhere upstream leaves the zero `uncovered`', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'Prod_Only_C', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.testCoverage).toBe('uncovered');
    expect(c?.uncheckedTestReferrers).toBeUndefined();
    expect(r.value.data.summary.uncoveredApex).toBe(1);
    expect(r.value.data.summary.unknownTestCoverage).toBe(0);
    expect(r.value.data.trust.completeness.status).toBe('complete');
    expect(r.value.data.trust.limitations).toEqual([]);
  });

  it('CONTROL: a class the walk DOES cover stays `covered` and certifies nothing extra', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.testCoverage).toBe('covered');
    expect(r.value.data.reviewed[0]?.uncheckedTestReferrers).toBeUndefined();
    expect(r.value.data.summary.unknownTestCoverage).toBe(0);
    expect(r.value.data.trust.limitations).toEqual([]);
  });
});
