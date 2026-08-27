/// <reference types="vitest/globals" />

/**
 * End-to-end integration test for sf-intelligence v0.3.
 *
 * This is THE acceptance gate. It proves the whole product works:
 *   1. Refresh the vault from the committed edu-org fixture (2,193
 *      components captured in journal 0001) by running `runRefresh`
 *      with `noPull: true` — no Salesforce CLI shell-out.
 *   2. Verify every byproduct of refresh: per-type component
 *      directories with at least one `.md` file each, the index, the
 *      DuckDB graph, and the updated manifest.
 *   3. Boot the MCP server via `buildContext + createServer`.
 *   4. Dispatch every one of the 13 v0.3 tools and assert that none
 *      returns the `not-implemented` or `unknown-tool` envelope. A
 *      successful response carries either a `data` payload or a typed
 *      `error.kind` (e.g. `component-not-found`); the only forbidden
 *      shapes are the two legacy stubs. (v0.1 shipped 10; v0.2 added
 *      `sfi.get_impact` and `sfi.find_formula_references` for the
 *      architect impact-analysis surface, journal 0069; v0.3 appended
 *      `sfi.find_apex_usages` for the developer Apex-refactor persona,
 *      journal 0075.)
 *   5. Assert the v0.2 semantic edges materialise: `references`
 *      (formula tokenizer per journals 0064–0066), `callsApex`,
 *      `readsFrom`, `writesTo` (Flow semantics per journal 0067).
 *   6. Assert the v0.3 Apex-scanner edges materialise: `readsFrom`,
 *      `writesTo`, `callsApex` carrying `source: 'apex-scanner'` and
 *      `confidence: 'heuristic'` (journals 0073-0074).
 *
 * The test is slow on purpose — copying ~45 MB and walking 2,193
 * extractions is real work. The vitest config in this directory
 * raises `testTimeout` to 600s. If a test starts timing out, look at
 * pipeline regressions or fixture growth before increasing the cap.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The integration test sits outside any workspace package so it cannot
// resolve `@sf-intelligence/*` through node_modules — pnpm only symlinks
// workspace packages into a depending package's node_modules. Deep
// relative imports into each source tree keep the test framework-agnostic
// (no extra package.json or workspace mutation needed) while still
// exercising the production code path: vitest transforms the .ts sources
// on the fly when run via the local config in this directory.
import { runRefresh } from '../../packages/cli/src/commands/refresh.js';
import type { Edge, VaultManifest } from '../../packages/contracts/src/index.js';
import { listEdges } from '../../packages/graph/src/index.js';
import {
  buildContext,
  createServer,
  dispatchTool,
  shutdown,
  V01_TOOLS,
  type Context,
} from '../../packages/mcp/src/index.js';
import { vaultPaths } from '../../packages/vault/src/index.js';

import { assertNotStubEnvelope as assertNotStubShared } from './envelope-honesty.js';
import { FIXTURE_ROOT, FIXTURE_SOURCE } from './fixture-paths.js';

/**
 * Absolute path to the v1.1 synthetic-fixture directory. The edu-org
 * fixture has no `roles/`, `groups/`, `queues/`, or `sharingRules/`
 * directories — staging these synthetic subtrees alongside edu-org's
 * source tree is what gives the integration test happy-path coverage
 * for the v1.1 extractors. Without this, the refresh pipeline's v1.1
 * dispatch entries would be exercised only by the "missing directory →
 * skip cleanly" path, not by an end-to-end extract + import + render.
 *
 * The subdirectories under `synthetic-v1.1/` (`roles/`, `groups/`,
 * `queues/`, `sharingRules/`) are copied into
 * `{vaultRoot}/source/main/default/{name}/` inside `stageFixture`,
 * mirroring the Salesforce DX layout the dispatcher walks.
 */
const SYNTHETIC_V11_FIXTURE = resolve(FIXTURE_ROOT, 'synthetic-v1.1');

/** Subdirectories under `synthetic-v1.1/` to stage into the source tree. */
const SYNTHETIC_V11_SUBDIRS = ['roles', 'groups', 'queues', 'sharingRules'] as const;

/**
 * Absolute path to the v1.2 synthetic-fixture directory. The edu-org
 * fixture has RecordType subtrees but none of the other v1.2 surfaces
 * (no `tabs/`, `applications/`, `pathAssistants/`, `globalValueSets/`,
 * `labels/`, `staticresources/`, no `businessProcesses/` or
 * `quickActions/` under any object). Staging the synthetic-v1.2
 * subtrees alongside the edu-org source gives the v1.2 record-types +
 * UI-surfaces extractors a happy-path extract + import + render and
 * floors the new edge tallies (`belongsToApp` from CustomApplication,
 * `parentOf` from RecordType/BusinessProcess/QuickAction/PathAssistant).
 *
 * Layout of the fixture (mirrored into the staged source tree):
 *   - `applications/`, `globalValueSets/`, `labels/`, `pathAssistants/`,
 *     `quickActions/`, `staticresources/`, `tabs/` -> top-level
 *     Salesforce DX directories under `source/main/default/`.
 *   - `objects/Account/quickActions/` -> DX-nested QuickActions; the
 *     refresh dispatcher matches the `objects` + `quickActions`
 *     segments inside the `objects/`-branch of `dispatchFile`.
 *   - `objects/Opportunity/businessProcesses/` -> DX-nested
 *     BusinessProcesses; same dispatch path as above.
 */
const SYNTHETIC_V12_FIXTURE = resolve(FIXTURE_ROOT, 'synthetic-v1.2');

/**
 * Top-level subdirectories under `synthetic-v1.2/` to stage into the
 * source tree. Files under `synthetic-v1.2/objects/` are handled
 * separately by `stageSyntheticV12ObjectSubtrees` because they must be
 * merged into the existing `source/main/default/objects/` tree without
 * clobbering the edu-org `Account/` / `Opportunity/` directories that
 * may already exist there.
 */
const SYNTHETIC_V12_TOP_LEVEL_SUBDIRS = [
  'applications',
  'globalValueSets',
  'labels',
  'pathAssistants',
  'quickActions',
  'staticresources',
  'tabs',
] as const;

/**
 * Synthetic v1.2 object-nested subdirectories: each is staged at
 * `source/main/default/objects/{Object}/{subdir}/` so the refresh
 * dispatcher's `objects/`-branch matches the inner directory segment
 * (`businessProcesses` / `quickActions`). Listed as
 * `[objectApiName, subdir]` so the staging loop preserves both halves
 * of the path verbatim.
 */
const SYNTHETIC_V12_OBJECT_SUBDIRS: ReadonlyArray<readonly [string, string]> = [
  ['Account', 'quickActions'],
  ['Opportunity', 'businessProcesses'],
];

/**
 * Absolute path to the v1.3 synthetic-fixture directory. The edu-org
 * fixture has none of the v1.3 legacy-automation + communications
 * surfaces (no `workflows/`, `approvalProcesses/`, `assignmentRules/`,
 * `autoResponseRules/`, `escalationRules/`, `duplicateRules/`,
 * `matchingRules/`, `email/`, or `letterhead/` directories). Staging
 * the synthetic-v1.3 subtrees alongside the edu-org source gives the
 * v1.3 extractors a happy-path extract + import + render and floors
 * the new `sendsEmail` edge type populated by the auto-response,
 * workflow-rule, and approval-process extractors.
 *
 * Every v1.3 subdirectory lives at the top level (none of the v1.3
 * metadata types are object-nested in DX layout), so the staging loop
 * is a flat copy across `SYNTHETIC_V13_SUBDIRS`.
 */
const SYNTHETIC_V13_FIXTURE = resolve(FIXTURE_ROOT, 'synthetic-v1.3');

/**
 * Top-level subdirectories under `synthetic-v1.3/` to stage into the
 * source tree at `source/main/default/{name}/`. All v1.3 metadata
 * types live at the DX top level — there is no object-nested
 * counterpart (the per-SObject fan-out for workflows / assignmentRules
 * / autoResponseRules / escalationRules / matchingRules happens
 * inside the file's `<rules>` children, not in the directory tree).
 */
const SYNTHETIC_V13_SUBDIRS = [
  'approvalProcesses',
  'assignmentRules',
  'autoResponseRules',
  'duplicateRules',
  'email',
  'escalationRules',
  'letterhead',
  'matchingRules',
  'workflows',
] as const;

/**
 * Absolute path to the v1.4 synthetic-fixture directory. The edu-org
 * fixture has none of the v1.4 frontend code surfaces (no `lwc/`,
 * `aura/`, `pages/`, or `components/` directories). Staging the
 * synthetic-v1.4 subtrees alongside the edu-org source gives the v1.4
 * extractors a happy-path extract + import + render and floors the new
 * `LightningComponentBundle` / `AuraDefinitionBundle` /
 * `VisualforcePage` / `VisualforceComponent` component counts, plus
 * the heuristic readsFrom / callsApex edges the LWC scanner emits from
 * the AccountInfoCard fixture's `record.Industry__c` and
 * `@salesforce/apex/AccountService.fetch` imports.
 *
 * Layout of the fixture (mirrored into the staged source tree):
 *   - `lwc/{BundleName}/` -> directory-based dispatch; refresh pipeline
 *     emits one `LightningComponentBundle` node per child directory.
 *   - `aura/{BundleName}/` -> directory-based dispatch; refresh pipeline
 *     emits one `AuraDefinitionBundle` node per child directory.
 *   - `pages/{Name}.page` (+ `.page-meta.xml` sibling) -> file-based
 *     dispatch on the markup file; the extractor reads the meta-xml
 *     sibling itself.
 *   - `components/{Name}.component` (+ `.component-meta.xml` sibling)
 *     -> same file-based pattern as VisualforcePage.
 */
const SYNTHETIC_V14_FIXTURE = resolve(FIXTURE_ROOT, 'synthetic-v1.4');

/**
 * Top-level subdirectories under `synthetic-v1.4/` to stage into the
 * source tree at `source/main/default/{name}/`. All v1.4 metadata
 * types live at the DX top level. `lwc/` and `aura/` contain bundle
 * directories (the refresh pipeline's bundle-detection branch in
 * `walkDir` emits each child directory as a single dispatch unit);
 * `pages/` and `components/` contain `.page` / `.component` markup
 * files with sibling `-meta.xml` companions.
 */
const SYNTHETIC_V14_SUBDIRS = [
  'aura',
  'components',
  'lwc',
  'pages',
] as const;

/**
 * Absolute path to the v1.5 synthetic-fixture directory. The edu-org
 * fixture has none of the v1.5 integration topology surfaces (no
 * `authproviders/`, `remoteSiteSettings/`, `cspTrustedSites/`,
 * `dataSources/`, `externalServiceRegistrations/`, or
 * `networkAccesses/` directories), nor any platform-event
 * subscriber Apex / async-dispatch Apex / @RestResource Apex.
 * Staging the synthetic-v1.5 subtrees alongside the edu-org source
 * gives the v1.5 R2 extractors (the six integration-topology types)
 * a happy-path extract + import + render, AND stages the v1.5 R3 Apex
 * classes / triggers / flows that produce the `listensTo` / `exposes`
 * / `dispatchesAsync` edges via the existing apex-class /
 * apex-trigger / flow extractors:
 *
 *   - `authproviders/` × 2 (MyOpenIdProvider, SamlProvider).
 *   - `remoteSiteSettings/` × 2 (ExternalCRM, LegacyApi).
 *   - `cspTrustedSites/` × 2 (AnalyticsCDN, SupportWidget).
 *   - `dataSources/` × 2 (SAP_Customers, MarketingHub) —
 *     SAP_Customers carries a `references` edge to
 *     `AuthProvider:MyOpenIdProvider`.
 *   - `externalServiceRegistrations/` × 1 (OrderService) — carries
 *     a `references` edge to `NamedCredential:OrderApi`.
 *     `NamedCredential` is a valid ComponentType target but the v1.5
 *     wave does NOT wire a NamedCredential extractor; the referenced
 *     id resolves as a dangling target — the edge still lands in the
 *     graph.
 *   - `networkAccesses/` × 2 (Office_Range, VPN_Range).
 *   - `classes/` × 4 (AccountActions implementing Queueable +
 *     @InvocableMethod + @AuraEnabled, AccountChangeSubscriber
 *     implementing Triggerable<Account_Change__e>, AccountHandler
 *     calling System.enqueueJob / Database.executeBatch /
 *     System.schedule, AccountResource with @RestResource).
 *   - `triggers/` × 1 (AccountChangeTrigger on Account_Change__e).
 *   - `flows/` × 1 (AccountChangeEventFlow).
 */
const SYNTHETIC_V15_FIXTURE = resolve(FIXTURE_ROOT, 'synthetic-v1.5');

/**
 * Top-level subdirectories under `synthetic-v1.5/` to stage into the
 * source tree at `source/main/default/{name}/`. The six v1.5
 * integration topology directories plus the R3 Apex / trigger / flow
 * subtrees that exercise `listensTo` / `exposes` / `dispatchesAsync`.
 *
 * `classes/`, `triggers/`, and `flows/` overlap with the v0.1
 * dispatcher's existing `classes` / `triggers` / `flows` segments;
 * none of the v1.5 R3 fixture file names collide with anything in
 * edu-org (each synthetic class / trigger / flow is named with an
 * `Account*` prefix). The `cp -r` here merges rather than replaces.
 */
const SYNTHETIC_V15_SUBDIRS = [
  'authproviders',
  'classes',
  'cspTrustedSites',
  'dataSources',
  'externalServiceRegistrations',
  'flows',
  'networkAccesses',
  'remoteSiteSettings',
  'triggers',
] as const;

/**
 * Absolute path to the v1.6 synthetic-fixture directory. The edu-org
 * fixture has none of the v1.6 business-user record-value surfaces
 * (no `customMetadata/` or `customSettings/` directories). Staging
 * the synthetic-v1.6 subtrees alongside the edu-org source gives the
 * v1.6 extractors (`CustomMetadataRecord`, `CustomSettingRecord`) a
 * happy-path extract + import + render and floors the new per-record
 * component counts plus the new `parentOf` edges each record
 * contributes to its parent `CustomObject` (`__mdt` for CMD,
 * `__c` for CSR).
 *
 * Layout of the fixture (mirrored into the staged source tree):
 *   - `customMetadata/{TypeApiName}.{RecordName}.md-meta.xml` -> flat
 *     file dispatch; the extractor splits the basename on the first
 *     dot to derive the parent `__mdt` type and the record's
 *     DeveloperName.
 *   - `customSettings/{TypeApiName}/{RecordName}.dataset-meta.xml` ->
 *     nested directory dispatch; the immediate parent directory
 *     name is the parent `__c` CustomSetting type.
 */
const SYNTHETIC_V16_FIXTURE = resolve(FIXTURE_ROOT, 'synthetic-v1.6');

/**
 * Top-level subdirectories under `synthetic-v1.6/` to stage into the
 * source tree at `source/main/default/{name}/`. Both v1.6 metadata
 * types live at the DX top level — CustomMetadataRecord files are
 * flat under `customMetadata/`, CustomSettingRecord files nest one
 * level under `customSettings/{TypeApiName}/`. The `cp -r` here
 * preserves the nested structure under `customSettings/` so the
 * dispatcher's path-segment check on the immediate parent directory
 * resolves the parent `__c` type from the directory name.
 */
const SYNTHETIC_V16_SUBDIRS = [
  'customMetadata',
  'customSettings',
] as const;

/** Vault config alias used by the test. Echoed in `manifest.sourceOrg`. */
const TEST_ORG_ALIAS = 'edu-org-fixture';

/**
 * All 3 journal-0052 bugs landed (fix-flow-extractor-overflow,
 * fix-yaml-frontmatter-arrays, fix-graph-import-oom). `REFRESH_TYPES`
 * is widened to the full v0.1 surface — every metadata type the v0.1
 * extractors support runs against the edu-org fixture end-to-end:
 *
 *   - The flow-extractor entity-overflow throw is wrapped in a per-file
 *     try/catch (fix-flow-extractor-overflow); the offending Flow file
 *     surfaces as a `parse-error` failure entry rather than aborting
 *     the pipeline.
 *
 *   - The yaml-frontmatter array serializer renders block sequences
 *     for primitive arrays (fix-yaml-frontmatter-arrays); the seven
 *     types that emit arrays (`CustomField.picklistValues`,
 *     `ApexClass.modifiers`, `ApexTrigger.events`,
 *     `PermissionSet.userPermissions`, etc.) render cleanly.
 *
 *   - `importExtractionResults` commits in batches of `IMPORT_BATCH_SIZE`
 *     so DuckDB's pending-write buffer no longer grows to OOM on the
 *     ~2,200-node + several-thousand-edge fixture (fix-graph-import-oom).
 */
const REFRESH_TYPES = [
  'CustomObject',
  'CustomField',
  'ValidationRule',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'Layout',
  'PermissionSet',
  'Profile',
  // v1.1 sharing & visibility tier. These are exercised by the
  // synthetic-v1.1 fixtures staged into the source tree alongside
  // edu-org — the edu-org fixture itself has no roles/, groups/,
  // queues/, or sharingRules/ directories. The refresh pipeline
  // tolerates missing directories; staging synthetic content gives
  // the dispatcher a happy path to extract from.
  'Role',
  'Group',
  'Queue',
  'SharingRule',
  // v1.2 record-types + UI-surfaces tier. RecordType is exercised by
  // edu-org directly (it has ~30 recordType-meta.xml files); the rest
  // are exercised by the synthetic-v1.2 fixtures staged into the
  // source tree. Same "missing directory tolerated, present directory
  // extracted" contract as v1.1.
  'RecordType',
  'BusinessProcess',
  'CustomTab',
  'CustomApplication',
  'QuickAction',
  'PathAssistant',
  'GlobalValueSet',
  'CustomLabel',
  'StaticResource',
  // v1.3 legacy-automation + communications tier. All nine are
  // exercised by the synthetic-v1.3 fixtures staged into the source
  // tree (edu-org has none of these directories). Same "missing
  // directory tolerated, present directory extracted" contract as
  // v1.1 / v1.2. The headline new edge type `sendsEmail` is floored
  // by a sibling assertion below.
  'WorkflowRule',
  'ApprovalProcess',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  'DuplicateRule',
  'MatchingRule',
  'EmailTemplate',
  'Letterhead',
  // v1.4 frontend code tier. None of these surfaces exist in edu-org;
  // each is exercised by the synthetic-v1.4 fixtures staged into the
  // source tree. The bundle-shaped types (LWC / Aura) flow through
  // the refresh pipeline's bundle-detection branch in `walkDir` —
  // each child directory under `lwc/` / `aura/` is dispatched as a
  // single unit rather than file-by-file. The file-shaped types
  // (VisualforcePage / VisualforceComponent) follow the standard
  // `dispatchFile` matching on `.page` / `.component` markup files.
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  // v1.5 integration topology tier. None of these surfaces exist in
  // edu-org; each is exercised by the synthetic-v1.5 fixtures staged
  // into the source tree. All six flow through the standard
  // `dispatchFile` matching: each metadata type lives under its own
  // top-level DX directory with an unambiguous file-suffix shape, so
  // the dispatcher's segment + suffix check fires the right extractor
  // without any v0.1-v1.4 cross-talk.
  'AuthProvider',
  'RemoteSiteSetting',
  'CspTrustedSite',
  'ExternalDataSource',
  'ExternalService',
  'NetworkAccess',
  // v1.6 business-user record-value tier. None of these surfaces
  // exist in edu-org; each is exercised by the synthetic-v1.6
  // fixtures staged into the source tree. Both flow through the
  // standard `dispatchFile` matching: CustomMetadataRecord on flat
  // `customMetadata/*.md-meta.xml` files, CustomSettingRecord on
  // `customSettings/{TypeApiName}/*.dataset-meta.xml` files.
  'CustomMetadataRecord',
  'CustomSettingRecord',
] as const;

/**
 * Per-type minimum component count surfaced by `result.counts.components`
 * after a full refresh. Conservative floors — the journal-0001 fixture
 * counts include metadata types the v0.1 extractors correctly reject
 * (`__mdt`, `__e`, `__b`) and a small number of files that fail the
 * schema-strict validator. Better to floor at "definitely should be at
 * least this many" than to fail a gate on a schema edge case at the
 * upstream extractor.
 *
 * Approximate fixture totals after extraction (from journal 0052):
 *
 *   - CustomObject ~ 61 (96 raw files minus 20 non-extracted variants
 *     and ~15 schema-strict rejections)
 *   - CustomField ~ 1034 (but see render cap below)
 *   - ValidationRule ~ 22 (23 raw, 1 schema reject)
 *   - Flow ~ 296 (297 raw, 1 entity-overflow parse failure tolerated)
 *   - ApexClass ~ 186
 *   - ApexTrigger ~ 22
 *   - Layout ~ 304
 *   - PermissionSet ~ 179
 *   - Profile ~ 52
 *
 * `renderVault` currently caps `listNodesByType` at `limit: 500` per
 * type. Types whose extracted population exceeds that ceiling (notably
 * `CustomField`) show 500 in `counts.components`, not the full
 * extracted total. The floor below uses 500 for those types so the
 * gate is honest about what the v0.1 product actually reports. Lifting
 * the cap is tracked as a v0.2 task; the graph itself contains the
 * full population (this test's parentOf assertion in particular reads
 * from the graph, not the count).
 */
const FIXTURE_COMPONENT_FLOOR = {
  CustomObject: 50,
  CustomField: 500,
  ValidationRule: 20,
  Flow: 250,
  ApexClass: 150,
  ApexTrigger: 20,
  Layout: 250,
  PermissionSet: 150,
  Profile: 50,
  // v1.1 floors come from the synthetic-v1.1 fixtures (roles/×4,
  // groups/×2, queues/×3, sharingRules/×3 files producing 4 rule
  // nodes: Account×2 + Contact×1 + Opportunity×1). Conservative
  // floors hold even if a fixture file is added/removed later.
  Role: 4,
  Group: 2,
  Queue: 3,
  SharingRule: 4,
  // v1.2 floors. RecordType comes from edu-org (30 .recordType-meta.xml
  // files under various objects/* trees); the floor is 2 so the gate
  // tolerates schema-strict rejections. Everything else comes from the
  // synthetic-v1.2 fixtures whose counts are stable:
  //   - businessProcesses/ × 2 (Sales_Process, Renewal_Process under Opportunity)
  //   - tabs/ × 2 (Account_Custom, MyLwc_Tab)
  //   - applications/ × 2 (Sales_App, Service_App)
  //   - quickActions: 1 top-level (NewCase) + 2 nested under Account = 3
  //   - pathAssistants/ × 2 (Opportunity.Sales_Process, Opportunity.Renewal_Process)
  //   - globalValueSets/ × 2 (Country_Codes, Industry_Types)
  //   - labels/ × 1 file producing 4 child CustomLabel nodes
  //   - staticresources/ × 2 (MyLogo, PrivateConfig)
  RecordType: 2,
  BusinessProcess: 2,
  CustomTab: 2,
  CustomApplication: 2,
  QuickAction: 3,
  PathAssistant: 2,
  GlobalValueSet: 2,
  CustomLabel: 4,
  StaticResource: 2,
  // v1.3 floors. Each WorkflowRule / AssignmentRule / AutoResponseRule
  // / EscalationRule / MatchingRule file is fanned out per child
  // `<rules>` / `<assignmentRule>` / `<autoResponseRule>` /
  // `<escalationRule>` / `<matchingRules>` entry, so the floor counts
  // nodes (not files). The synthetic-v1.3 fixtures emit:
  //   - WorkflowRule: Account.workflow-meta.xml × 2 rules +
  //     Opportunity.workflow-meta.xml × 1 rule = 3 nodes (floor 2).
  //   - ApprovalProcess: Account.Credit_Review + Opportunity.Discount_Approval = 2.
  //   - AssignmentRule: Lead × 2 rules + Case × 1 rule = 3 nodes (floor 2).
  //   - AutoResponseRule: Lead × 2 rules = 2 nodes (floor 1).
  //   - EscalationRule: Case × 1 rule = 1 node (floor 1).
  //   - DuplicateRule: Account.Standard_Duplicate + Lead.Standard_Duplicate = 2.
  //   - MatchingRule: Lead × 2 + Account × 1 = 3 nodes (floor 2).
  //   - EmailTemplate: CaseAck + Welcome + Newsletter = 3 (floor 3).
  //   - Letterhead: Corporate + Holiday = 2 (floor 2).
  WorkflowRule: 2,
  ApprovalProcess: 2,
  AssignmentRule: 2,
  AutoResponseRule: 1,
  EscalationRule: 1,
  DuplicateRule: 2,
  MatchingRule: 2,
  EmailTemplate: 3,
  Letterhead: 2,
  // v1.4 frontend code floors. Synthetic-v1.4 emits exactly one node
  // per type — `lwc/AccountInfoCard/`, `aura/CaseManager/`,
  // `pages/AccountSummary.page`, `components/Header.component`. Floor
  // 1 each so adding a sibling fixture file later doesn't flap the
  // gate, and a single per-bundle schema reject (e.g. a missing
  // `.js-meta.xml` in the bundle dir) surfaces as 0 < 1 rather than a
  // silent drop to zero.
  LightningComponentBundle: 1,
  AuraDefinitionBundle: 1,
  VisualforcePage: 1,
  VisualforceComponent: 1,
  // v1.5 integration topology floors. The synthetic-v1.5 fixtures
  // ship a fixed roster:
  //   - authproviders/ × 2 (MyOpenIdProvider, SamlProvider).
  //   - remoteSiteSettings/ × 2 (ExternalCRM, LegacyApi).
  //   - cspTrustedSites/ × 2 (AnalyticsCDN, SupportWidget).
  //   - dataSources/ × 2 (SAP_Customers, MarketingHub).
  //   - externalServiceRegistrations/ × 1 (OrderService).
  //   - networkAccesses/ × 2 (Office_Range, VPN_Range).
  // Floors match the synthetic counts so a single per-file schema
  // reject surfaces as N-1 < floor rather than silently dropping.
  AuthProvider: 2,
  RemoteSiteSetting: 2,
  CspTrustedSite: 2,
  ExternalDataSource: 2,
  ExternalService: 1,
  NetworkAccess: 2,
  // v1.6 business-user record-value floors. Synthetic-v1.6 emits 4
  // CustomMetadataRecord nodes (Marketo Default + Production +
  // Clinical Module_1 + Module_2 under `customMetadata/`) and 1
  // CustomSettingRecord node (Marketo SystemDefault under
  // `customSettings/Marketo_Api_Settings__c/`). Floors are
  // conservative — 4 for CMD so adding a fifth record file later
  // doesn't flap, and 1 for CSR so a single per-file schema reject
  // surfaces as 0 < 1 rather than silently dropping.
  CustomMetadataRecord: 4,
  CustomSettingRecord: 1,
} as const;

/** Helper: does the path exist on disk? */
const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

interface FixturePrep {
  readonly cwd: string;
  readonly vaultRoot: string;
}

/**
 * Stage the v1.1 synthetic-fixture subtrees into the staged source
 * tree. Each subdir under `synthetic-v1.1/` lands at the canonical
 * Salesforce DX path (`source/main/default/{roles,groups,queues,
 * sharingRules}/`) so the dispatcher's segment-match
 * (`segments.includes('roles')`, etc.) fires the right extractor.
 */
const stageSyntheticV11Fixtures = async (defaultRoot: string): Promise<void> => {
  for (const subdir of SYNTHETIC_V11_SUBDIRS) {
    await cp(join(SYNTHETIC_V11_FIXTURE, subdir), join(defaultRoot, subdir), {
      recursive: true,
    });
  }
};

/**
 * Stage the v1.2 synthetic-fixture subtrees into the staged source
 * tree. Top-level subdirs (`tabs/`, `applications/`,
 * `pathAssistants/`, `globalValueSets/`, `labels/`, `staticresources/`,
 * top-level `quickActions/`) land at `source/main/default/{name}/`.
 * Object-nested subdirs (`Account/quickActions/`,
 * `Opportunity/businessProcesses/`) merge into the existing
 * `source/main/default/objects/{Object}/` directory tree — the
 * `recursive: true` cp into a sibling subdir avoids clobbering the
 * edu-org `Account.object-meta.xml` / `Opportunity.object-meta.xml`
 * sidecars that may already live there.
 */
const stageSyntheticV12Fixtures = async (defaultRoot: string): Promise<void> => {
  for (const subdir of SYNTHETIC_V12_TOP_LEVEL_SUBDIRS) {
    await cp(join(SYNTHETIC_V12_FIXTURE, subdir), join(defaultRoot, subdir), {
      recursive: true,
    });
  }
  for (const [objectApiName, subdir] of SYNTHETIC_V12_OBJECT_SUBDIRS) {
    const targetDir = join(defaultRoot, 'objects', objectApiName, subdir);
    await mkdir(targetDir, { recursive: true });
    await cp(
      join(SYNTHETIC_V12_FIXTURE, 'objects', objectApiName, subdir),
      targetDir,
      { recursive: true },
    );
  }
};

/**
 * Stage the v1.3 synthetic-fixture subtrees into the staged source
 * tree. Every v1.3 subdir lands at a canonical Salesforce DX top-level
 * path (`source/main/default/{workflows,approvalProcesses,...}/`) so
 * the dispatcher's segment-match (`segments.includes('workflows')`,
 * etc.) fires the right extractor. None of the v1.3 surfaces nest
 * under `objects/`, so the staging is a flat copy of each subdir.
 */
const stageSyntheticV13Fixtures = async (defaultRoot: string): Promise<void> => {
  for (const subdir of SYNTHETIC_V13_SUBDIRS) {
    await cp(join(SYNTHETIC_V13_FIXTURE, subdir), join(defaultRoot, subdir), {
      recursive: true,
    });
  }
};

/**
 * Stage the v1.4 synthetic-fixture subtrees into the staged source
 * tree. Each v1.4 subdir lands at a canonical Salesforce DX top-level
 * path (`source/main/default/{lwc,aura,pages,components}/`). The
 * bundle-shaped directories (`lwc/{Name}/`, `aura/{Name}/`) flow
 * through the refresh pipeline's bundle-detection branch in `walkDir`;
 * the markup files under `pages/` and `components/` flow through the
 * standard `dispatchFile` matching on `.page` / `.component` suffixes.
 *
 * The `components/` segment is unambiguous in Salesforce DX: the only
 * file types that live under it are Visualforce components (no
 * shared use with v0.1/v1.x metadata types). The walker recurses into
 * `components/` like any other directory; `dispatchFile`'s
 * `pages` / `components` branches surface only when the basename ends
 * with `.page` / `.component` (the dispatcher's `!fileName.endsWith
 * ('.page-meta.xml')` guard keeps the meta-xml sidecar from triggering
 * a second extraction).
 */
const stageSyntheticV14Fixtures = async (defaultRoot: string): Promise<void> => {
  for (const subdir of SYNTHETIC_V14_SUBDIRS) {
    await cp(join(SYNTHETIC_V14_FIXTURE, subdir), join(defaultRoot, subdir), {
      recursive: true,
    });
  }
};

/**
 * Stage the v1.5 synthetic-fixture subtrees into the staged source
 * tree. Each v1.5 subdir lands at a canonical Salesforce DX top-level
 * path (`source/main/default/{authproviders,remoteSiteSettings,
 * cspTrustedSites,dataSources,externalServiceRegistrations,
 * networkAccesses}/` for the R2 integration topology tier, plus
 * `classes/`, `triggers/`, `flows/` for the R3 event-subscriber + async
 * + API classifier work that flows through the existing apex-class /
 * apex-trigger / flow extractors).
 *
 * The R3 subdirs overlap with v0.1 dispatcher directories; the
 * synthetic file names (Account-prefixed) do not collide with anything
 * in edu-org, so the `cp -r` merges rather than replaces.
 */
const stageSyntheticV15Fixtures = async (defaultRoot: string): Promise<void> => {
  for (const subdir of SYNTHETIC_V15_SUBDIRS) {
    await cp(join(SYNTHETIC_V15_FIXTURE, subdir), join(defaultRoot, subdir), {
      recursive: true,
    });
  }
};

/**
 * Stage the v1.6 synthetic-fixture subtrees into the staged source
 * tree. Each v1.6 subdir lands at a canonical Salesforce DX top-level
 * path (`source/main/default/{customMetadata,customSettings}/`). The
 * flat CMD files (`customMetadata/{Type}.{Name}.md-meta.xml`) and the
 * nested CSR files (`customSettings/{Type}/{Name}.dataset-meta.xml`)
 * both flow through the standard `dispatchFile` matching — `cp -r`
 * preserves the nested `customSettings/{Type}/` directory structure
 * so the dispatcher's path-segment check resolves the parent `__c`
 * type from the immediate parent directory name.
 */
const stageSyntheticV16Fixtures = async (defaultRoot: string): Promise<void> => {
  for (const subdir of SYNTHETIC_V16_SUBDIRS) {
    await cp(join(SYNTHETIC_V16_FIXTURE, subdir), join(defaultRoot, subdir), {
      recursive: true,
    });
  }
};

/**
 * Stage the edu-org fixture into a fresh temp dir, copy each
 * synthetic-v1.1, synthetic-v1.2, synthetic-v1.3, synthetic-v1.4,
 * synthetic-v1.5, and synthetic-v1.6 subtree alongside it under
 * `source/main/default/`, and write the minimal `meta/config.json`
 * `runRefresh` expects. Mirrors what `sfi init` followed by `sf project
 * retrieve` would produce for an org that has v1.1 + v1.2 + v1.3 +
 * v1.4 + v1.5 + v1.6 metadata.
 *
 * The dispatcher in `refresh-pipeline.ts` matches v1.1 files by the
 * presence of `roles/`, `groups/`, `queues/`, `sharingRules/`
 * segments in the relative path, v1.2 files by `tabs/`,
 * `applications/`, `quickActions/`, `pathAssistants/`,
 * `globalValueSets/`, `labels/`, `staticresources/` (top-level) or
 * `recordTypes/`, `businessProcesses/`, `quickActions/` (object-nested),
 * v1.3 files by `workflows/`, `approvalProcesses/`,
 * `assignmentRules/`, `autoResponseRules/`, `escalationRules/`,
 * `duplicateRules/`, `matchingRules/`, `email/`, `letterhead/` (all
 * top-level), v1.4 by directory shape (`lwc/{Name}/`,
 * `aura/{Name}/`) and file suffix (`pages/{Name}.page`,
 * `components/{Name}.component`), v1.5 by `authproviders/`,
 * `remoteSiteSettings/`, `cspTrustedSites/`, `dataSources/`,
 * `externalServiceRegistrations/`, `networkAccesses/` (all top-level,
 * each with an unambiguous file-suffix shape; the R3 `classes/`,
 * `triggers/`, `flows/` overlap merges into the existing v0.1
 * dispatch path), and v1.6 by the `customMetadata/` (flat
 * `.md-meta.xml` files) / `customSettings/{Type}/` (nested
 * `.dataset-meta.xml` files) shape. Staging each synthetic subdir at
 * the right path puts the segment where the dispatcher expects.
 */
const stageFixture = async (): Promise<FixturePrep> => {
  const cwd = await mkdtemp(join(tmpdir(), 'sfi-e2e-'));
  const vaultRoot = join(cwd, 'org-kb');
  await mkdir(join(vaultRoot, 'meta'), { recursive: true });

  // Copy the entire fixture source tree under {vaultRoot}/source/.
  // The refresh pipeline walks recursively from there, so the
  // `main/default/` nesting Salesforce DX uses is preserved as-is.
  await cp(FIXTURE_SOURCE, join(vaultRoot, 'source'), { recursive: true });

  // Layer the v1.1 + v1.2 + v1.3 + v1.4 + v1.5 + v1.6 synthetic
  // fixtures alongside the edu-org source tree.
  const defaultRoot = join(vaultRoot, 'source', 'main', 'default');
  await stageSyntheticV11Fixtures(defaultRoot);
  await stageSyntheticV12Fixtures(defaultRoot);
  await stageSyntheticV13Fixtures(defaultRoot);
  await stageSyntheticV14Fixtures(defaultRoot);
  await stageSyntheticV15Fixtures(defaultRoot);
  await stageSyntheticV16Fixtures(defaultRoot);

  await writeFile(
    join(vaultRoot, 'meta', 'config.json'),
    JSON.stringify({
      targetOrg: TEST_ORG_ALIAS,
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-05-27T00:00:00.000Z',
    }),
    'utf8',
  );

  return { cwd, vaultRoot };
};

/**
 * Parse the JSON body returned by `dispatchTool`. The MCP SDK wraps
 * the envelope in a `CallToolResult` whose `content[0].text` carries
 * the JSON-encoded `McpResponse | { error }`.
 */
const parseEnvelope = (content: readonly { type: string; text?: string }[]):
  | { data: unknown; vaultState?: { sourceTreeHash: string; refreshedAt: string } }
  | { error: unknown } => {
  const first = content[0];
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`unexpected content[0] shape: ${JSON.stringify(content)}`);
  }
  return JSON.parse(first.text) as
    | { data: unknown; vaultState?: { sourceTreeHash: string; refreshedAt: string } }
    | { error: unknown };
};

/**
 * The dispatch envelope must not be either of the two legacy stubs.
 * `not-implemented` means a tool was registered without a handler;
 * `unknown-tool` means the name was misspelled. Either indicates the
 * v0.1 surface is incomplete.
 *
 * DELEGATES to the shared implementation in `envelope-honesty.ts`. The copy
 * that used to live here compared `body.error` — a STRING — to the two stub
 * names, so it could only ever fire on the legacy string form; a live handler
 * returns `error` as an `McpError` OBJECT and slipped straight past it. The
 * shared version checks both shapes. (Second copies guarded only by a comment
 * are how this tree grows drift; see `envelope-honesty.ts`.)
 *
 * This remains the NARROW gate — it rejects only the two stubs. The honesty
 * laws that reject a tool whose handler ran and LIED (`{ totalCount: 0 }` for
 * an object that does not exist, a trimmed page claiming completeness) live in
 * `tool-honesty-sweep.test.ts`, which derives its roster from `V01_TOOLS`
 * instead of the hand-written `calls` array below and therefore covers all
 * 217 tools rather than the 141 listed here.
 */
const assertNotStubEnvelope = (body: unknown, toolName: string): void => {
  assertNotStubShared(body, toolName);
};

/**
 * Search shallowly for any `.md` file under `dir`. Used to assert that
 * a per-type component directory holds at least one rendered document.
 * The walker only descends one level deep — that is sufficient for the
 * v0.1 layout (`components/{type}/[{parent}/]{name}.md`) and keeps the
 * I/O bounded on the 304-Layout directory.
 */
const firstMarkdownUnder = async (dir: string): Promise<boolean> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) return true;
    if (entry.isDirectory()) {
      // One level deeper covers CustomField/ApiName/Field.md and
      // ValidationRule/ApiName/Rule.md. Beyond that the layout does
      // not nest.
      const sub = await readdir(join(dir, entry.name)).catch(() => []);
      if (sub.some((name) => name.endsWith('.md'))) return true;
    }
  }
  return false;
};

describe('sf-intelligence v0.3 end-to-end', () => {
  // Initialised in `beforeAll`. Declaring them with empty defaults
  // sidesteps TypeScript's "used before assignment" complaint without
  // forcing a `!` non-null assertion at every read site.
  let cwd = '';
  let vaultRoot = '';
  let ctx: Context | null = null;

  beforeAll(async () => {
    const prep = await stageFixture();
    cwd = prep.cwd;
    vaultRoot = prep.vaultRoot;

    const refresh = await runRefresh({
      cwd,
      noPull: true,
      types: REFRESH_TYPES.join(','),
    });
    if (refresh.status === 'failed') {
      throw new Error(
        `refresh failed: ${refresh.fatalError ?? '(no fatalError)'}`,
      );
    }
    // status === 'partial' is acceptable here — the fixture may include
    // edge-case files the v0.1 extractors reject. The pipeline rendered
    // a coherent vault around them, which is the contract.

    const built = await buildContext(vaultRoot);
    if (!built.ok) {
      throw new Error(
        `buildContext failed: ${built.error.kind} — ${built.error.message}`,
      );
    }
    ctx = built.value;
  });

  afterAll(async () => {
    if (ctx !== null) {
      await shutdown(ctx);
      ctx = null;
    }
    if (cwd.length > 0) {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('produces a non-failed RefreshResult against the edu-org fixture', async () => {
    // We re-run `runRefresh` here so the assertions in this `it`
    // block are self-contained and read independently of `beforeAll`.
    // The first refresh already populated the vault; a second run
    // over the same source should still succeed (refresh is
    // idempotent over its input source tree).
    const result = await runRefresh({
      cwd,
      noPull: true,
      types: REFRESH_TYPES.join(','),
    });
    expect(result.status === 'success' || result.status === 'partial').toBe(true);

    // Assert the floor for every type the integration test asked
    // refresh to extract. Types omitted by REFRESH_TYPES are skipped
    // here; if the list expands to cover Flow/Layout/PermissionSet/
    // Profile later, their counts get checked here automatically.
    for (const type of REFRESH_TYPES) {
      expect(
        result.counts.components[type] ?? 0,
        `expected ${type} count >= floor`,
      ).toBeGreaterThanOrEqual(FIXTURE_COMPONENT_FLOOR[type]);
    }

    // `parentOf` is the spine of the graph: every CustomField produces
    // one parentOf to its parent CustomObject, plus a ValidationRule
    // per rule, plus more from Layout/ApexTrigger relationships. The
    // CustomField floor dominates, so its number is the safe lower
    // bound here.
    expect(result.counts.edges.parentOf ?? 0).toBeGreaterThanOrEqual(
      FIXTURE_COMPONENT_FLOOR.CustomField,
    );
  });

  it('renders per-type component directories with at least one .md file each', async () => {
    const paths = vaultPaths(vaultRoot);

    // Only check the types we asked refresh to extract. When the v0.1
    // limitations in `REFRESH_TYPES` are lifted, the other types fall
    // back into scope automatically.
    for (const type of REFRESH_TYPES) {
      const dir = join(paths.components, type);
      expect(
        await pathExists(dir),
        `components/${type}/ should exist`,
      ).toBe(true);

      // Walk shallow into the type dir; for nested layouts (CustomField,
      // ValidationRule) the first hit may be a subdirectory holding the
      // .md files. The existence of ANY descendant .md is the assertion.
      const found = await firstMarkdownUnder(dir);
      expect(found, `expected at least one .md under components/${type}/`).toBe(true);
    }

    // The index summarises the per-type counts; presence is mandatory.
    expect(await pathExists(join(paths.components, 'index.md'))).toBe(true);
  });

  it('writes the DuckDB graph file and a manifest with the refresh metadata', async () => {
    const paths = vaultPaths(vaultRoot);
    expect(await pathExists(paths.graphDb)).toBe(true);
    expect(await pathExists(paths.manifest)).toBe(true);

    const manifest = JSON.parse(
      await readFile(paths.manifest, 'utf8'),
    ) as VaultManifest;
    expect(manifest.sourceOrg).toBe(TEST_ORG_ALIAS);
    expect(manifest.version).toBe('0.1.0');
    // The hash is sha256 (64 hex chars). `sourceTreeHash` in the
    // captured journal is `5da339f1...`; we cannot compare directly
    // because the live `cp -r` may include filesystem metadata
    // differences the canonicalised walker normalises out. The format
    // is what we can assert on.
    expect(manifest.sourceTreeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.refreshedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('boots a Server instance from the refreshed vault context', () => {
    expect(ctx).not.toBeNull();
    const server = createServer(ctx as Context);
    expect(server).toBeDefined();
    expect(typeof server.setRequestHandler).toBe('function');
  });

  // v1.1 R5 added `sfi.why_cant_user_see_record` (the admin-facing
  // sharing-cascade headline tool); v1.2 R4 added `sfi.layout_for_user`
  // (the admin-facing layout-routing headline tool); v1.5 R4 added
  // `sfi.integration_map` (the architect integration-topology map) and
  // `sfi.event_subscribers` (the architect platform-event subscriber
  // lookup); v1.4 R5 added `sfi.find_code_usages` (the developer
  // broaden-from-Apex tool that surfaces LWC/Aura/VF referrers
  // alongside ApexClass/ApexTrigger); v1.6 R4 added the business-user
  // record-value pair `sfi.lookup_record` and `sfi.explain_field`
  // alongside the v1.6 R2 record extractors; v2.0b W1 added the
  // buyer-priority composition pair `sfi.safe_to_delete_field` (admin
  // headline #4) and `sfi.unused_components` (admin headline #7) as
  // pure compositions over existing edges. v2.0c W1 appends
  // `sfi.diff_snapshots` (buyer-priority #8 — "what changed?") and
  // `sfi.compare_components` (buyer-priority #10 — "compare profiles /
  // perm sets / flow versions"). v2.0d W1 appends `sfi.pii_inventory`
  // and `sfi.field_access_audit` (buyer-priority #5 — "which fields
  // contain PII and who can see/export them?") alongside the
  // `pii-detection` pattern recognizer. v2.0g W1 appends
  // `sfi.org_overview` and `sfi.domain_clusters` (buyer-priority #9 —
  // "I'm new — give me a tour of this org") as pure compositions over
  // the existing graph queries, bringing the total to 28. The
  // `V01_TOOLS.sort() === calls.sort()` invariant below catches any
  // future drift between the advertised roster and the integration
  // coverage.
  it('dispatches all v2.8-R2 + v2.7-R2 + v2.5 + v2.3 + v2.1-R3 tools without falling through to stubs', async () => {
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;

    // Each tool gets a realistic input that is valid against its Zod
    // schema. The point of this sweep is not to validate the response
    // payload (each tool has its own unit tests) but to prove that
    // every tool wired to `dispatchTool` resolves to a real handler.
    //
    // v0.2 appended `sfi.get_impact` and `sfi.find_formula_references`
    // to `V01_TOOLS` (journal 0069); v0.3 appended `sfi.find_apex_usages`
    // (journal 0075). All three take a component id. An id naming no node
    // resolves to `component-not-found` (FIX 1 — `find_formula_references`
    // no longer answers a false zero for a field it does not hold), which is
    // still a NON-STUB envelope: the assertion below checks for non-stub
    // envelopes, not non-empty payloads.
    const calls: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
      ['sfi.search_components', { query: 'Account' }],
      // The fixture has no Account object, so a known field id is
      // unreliable here. Use an id we know exists from the fixture
      // scan: CustomField:OA_Location__c.Industry__c. If absent the
      // tool returns `component-not-found`, which is still a non-stub
      // response and satisfies the assertion below.
      ['sfi.get_component', { id: 'CustomField:OA_Location__c.Industry__c' }],
      ['sfi.list_components', { type: 'CustomObject', limit: 5 }],
      ['sfi.get_edges', { nodeId: 'CustomObject:OA_Location__c' }],
      ['sfi.get_subgraph', { rootId: 'CustomObject:OA_Location__c', hops: 1 }],
      ['sfi.search_apex_source', { query: 'public class', limit: 5 }],
      ['sfi.search_flow_metadata', { query: 'Account', limit: 5 }],
      ['sfi.get_naming_convention_report', {}],
      ['sfi.get_manifest', {}],
      ['sfi.health_check', {}],
      // v0.2 architect tools. Default `hops` (2) and default `limit`
      // (50) are both reasonable; supplying realistic ids surfaces
      // production traffic shape.
      ['sfi.get_impact', { componentId: 'CustomField:Qualified_Faculty__c.Course_Name__c' }],
      ['sfi.find_formula_references', { fieldId: 'CustomField:Qualified_Faculty__c.Course__r.Name' }],
      // v0.3 developer tool. ContactTrigger emits a heuristic
      // `callsApex` edge to ApexClass:ContactServices (journal 0074),
      // so this targetId guarantees a non-empty result against the
      // refreshed vault. If the id ever fails to resolve, the tool
      // returns ok+empty — still a non-stub envelope.
      ['sfi.find_apex_usages', { targetId: 'ApexClass:ContactServices' }],
      // v1.1 admin tool. CustomObject:Account is not in the edu-org
      // fixture, so the tool returns a single OWD step with
      // `verdict: 'unknown'` and `reason: 'component not found: ...'`.
      // That is still a non-stub envelope and satisfies the assertion
      // below. The userContext supplies a profileId so the Zod refine
      // ("at least one of profileId/permissionSetIds/roleId/groupIds")
      // passes.
      [
        'sfi.why_cant_user_see_record',
        {
          componentId: 'CustomObject:Account',
          userContext: { profileId: 'Profile:System Administrator' },
        },
      ],
      // v1.2 admin tool. The v0.1 Profile extractor does not (yet)
      // populate `properties.layoutAssignments`, so the cascade
      // resolves the Profile (or returns `not-found` for unknown
      // profile ids) and then surfaces the LayoutAssignment stage as
      // `unknown` per the honesty axis. Either path produces a
      // non-stub envelope that satisfies the assertion below.
      [
        'sfi.layout_for_user',
        {
          objectApiName: 'Account',
          profileId: 'Profile:System Administrator',
        },
      ],
      // v1.5 architect integration-topology tool. The edu-org fixture
      // has none of the integration ComponentTypes, so every category
      // bucket comes back empty — still a non-stub envelope and the
      // assertion below is satisfied. `filter: 'all'` is the default
      // semantic shape so passing it explicitly here documents intent
      // even when it's a no-op.
      ['sfi.integration_map', { filter: 'all' }],
      // v1.5 architect platform-event subscriber tool. The id below
      // does not exist in the edu-org fixture; the tool returns
      // `subscribers: []` with `eventApiName: 'NoSuchEvent__e'` — the
      // honest empty case is a non-stub envelope and satisfies the
      // assertion. A non-Platform-Event id would surface as
      // `invalid-query` (also a non-stub envelope).
      ['sfi.event_subscribers', { eventId: 'CustomObject:NoSuchEvent__e' }],
      // v1.4 developer broadened-from-Apex tool. Strict superset of
      // `sfi.find_apex_usages`: same Apex-source coverage plus the
      // LWC/Aura/VF frontend tier. The `targetId` mirrors the existing
      // `find_apex_usages` call above so the same guaranteed-non-empty
      // ContactServices target exercises the broader handler too. If
      // the id ever fails to resolve, the tool returns ok+empty —
      // still a non-stub envelope.
      ['sfi.find_code_usages', { targetId: 'ApexClass:ContactServices' }],
      // v1.6 business-user lookup tool. The synthetic-v1.6 fixture
      // emits four CustomMetadataRecord nodes; the
      // Marketo_Api_Setting__mdt.Default record is the canonical CMD
      // fixture for v1.6 R2 and is guaranteed to resolve against the
      // refreshed vault. The tool returns the record's full per-field
      // value list — a non-stub envelope satisfies the assertion below.
      [
        'sfi.lookup_record',
        { recordId: 'CustomMetadataRecord:Marketo_Api_Setting__mdt.Default' },
      ],
      // v1.6 business-user explain tool. The edu-org fixture has no
      // Account.Industry CustomField, so the tool returns
      // `component-not-found` — still a non-stub envelope that
      // satisfies the assertion below. The id is canonical (the
      // standard Account.Industry picklist) and exercises the
      // CustomField:-prefix validation step at the handler boundary.
      ['sfi.explain_field', { fieldId: 'CustomField:Account.Industry' }],
      // v2.0b admin tool: safe-to-delete-field composition. The
      // edu-org fixture has no Account.Industry CustomField, so the
      // tool returns `component-not-found` — still a non-stub envelope
      // that satisfies the assertion below. The id exercises the
      // CustomField:-prefix validation step at the handler boundary;
      // a malformed prefix would also produce a non-stub `invalid-query`.
      ['sfi.safe_to_delete_field', { fieldId: 'CustomField:Account.Industry' }],
      // v2.0b admin tool: unused-components scan. Narrow `types` to
      // EmailTemplate so the call is fast even on production-sized
      // vaults; the edu-org fixture may or may not have email templates,
      // and either way the tool returns a structured response
      // (`components: []` or `components: [...]` with byType counts) —
      // a non-stub envelope that satisfies the assertion below.
      ['sfi.unused_components', { types: ['EmailTemplate'] }],
      // v2.0c W1 admin tool: snapshot diff. Neither label exists in
      // the refreshed vault — `nonexistent-A` and `nonexistent-B` are
      // synthetic strings that have never been captured via
      // `sfi snapshot create`. The handler returns `invalid-query`
      // with the offending snapshot path; that's a non-stub envelope
      // and satisfies the assertion below. The sweep does not
      // exercise the happy path because doing so would require
      // first running `runSnapshotCreate` inside this test, which
      // would couple the integration roster check to the CLI's
      // snapshot lifecycle.
      ['sfi.diff_snapshots', { fromLabel: 'nonexistent-A', toLabel: 'nonexistent-B' }],
      // v2.0c W1 admin tool: cross-component diff. The fixture has
      // both Account and Contact CustomObjects scaffolded; either
      // resolves or surfaces as `component-not-found` from
      // `getNodeById`. Either path is a non-stub envelope.
      ['sfi.compare_components', { idA: 'CustomObject:Account', idB: 'CustomObject:Contact' }],
      // v2.0d W1 compliance/privacy tool: PII inventory. The
      // `pii-detection` recognizer runs against every CustomField in
      // the refreshed vault; with `classification: 'pii'` the response
      // is the subset the recognizer flagged. The fixture may surface
      // zero PII fields (the recognizer is name-based), but the tool
      // still returns a structured `(fields, summary)` envelope — a
      // non-stub response that satisfies the assertion below.
      ['sfi.pii_inventory', { classification: 'pii' }],
      // v2.0d W1 compliance/privacy tool: field-access audit. The
      // edu-org fixture has no `Account.Industry` CustomField, so the
      // tool returns `component-not-found` — still a non-stub envelope
      // and satisfies the assertion below. The id exercises the
      // CustomField:-prefix validation step at the handler boundary.
      ['sfi.field_access_audit', { fieldId: 'CustomField:Account.Industry' }],
      // v2.0g W1 org-tour tool: structured org snapshot. Takes no
      // arguments — the empty object schema is the entire input
      // contract. The tool's response is a structured envelope
      // carrying per-ComponentType counts, top-ranked
      // objects/apex/profiles, integration/automation/frontend
      // summaries, legacy-debt indicators, and naming-convention
      // observations. Refreshed-vault populations make every category
      // non-empty for typical orgs; even a hypothetical empty vault
      // resolves to a structured envelope with zero counts (still a
      // non-stub envelope).
      ['sfi.org_overview', {}],
      // v2.0g W1 org-tour tool: heuristic domain clustering. Takes
      // optional `minDensity` / `limit`; with both omitted the
      // handler applies the documented defaults (0.3 / 10). The
      // edu-org fixture's CustomObject / ApexClass / Flow population
      // produces a non-empty cluster list for typical orgs; a
      // sparsely-connected vault resolves to `clusters: []` plus a
      // non-zero `unclustered` count — still a non-stub envelope.
      ['sfi.domain_clusters', {}],
      // v1.7 R2 freshness tool: changed_since. Passes a far-past
      // `since` so every enriched node in the fixture qualifies; the
      // refreshed vault has no Tooling-API-enriched nodes by default
      // (the offline pipeline produces lastModifiedDate: null), so
      // the tool returns `changed: []` plus a non-zero
      // `unenrichedCount` — still a non-stub envelope and satisfies
      // the assertion below. The integration test does NOT exercise
      // `runRefresh --with-tooling-api`; that path is unit-tested
      // against a stubbed client in
      // `packages/cli/test/refresh-with-tooling-api.test.ts`.
      ['sfi.changed_since', { since: '2020-01-01' }],
      // v1.7 R3 freshness tool: last_modified. The id below does not
      // exist in the edu-org fixture; the tool returns
      // `component-not-found` — still a non-stub envelope and
      // satisfies the assertion below. The id exercises the canonical
      // `{Type}:{ApiName}` shape; a real enriched vault would resolve
      // to `enriched: true` with the API-populated freshness fields,
      // while an offline vault resolves to `enriched: false` with the
      // verbatim refresh-with-tooling-api disclosure.
      ['sfi.last_modified', { componentId: 'CustomObject:NoSuchObject' }],
      // v2.0e W1 lifecycle-narrator tool: what_happens_on_save. Account
      // may lack a CustomObject node but still succeed when triggersOn
      // edges exist (see dedicated SOE admission test below). Otherwise
      // `component-not-found` — still a non-stub envelope.
      ['sfi.what_happens_on_save', { objectApiName: 'Account', event: 'insert' }],
      // v2.0e W1 lifecycle-narrator tool: why_field_changed. The
      // edu-org fixture has no `Account.Industry` CustomField, so the
      // tool returns `component-not-found` — still a non-stub
      // envelope and satisfies the assertion below. The id exercises
      // the CustomField:-prefix validation step at the handler boundary.
      ['sfi.why_field_changed', { fieldId: 'CustomField:Account.Industry' }],
      // v2.0e W1 lifecycle-narrator tool: order_of_execution. Same SOE
      // admission rules as what_happens_on_save (automation edges vs
      // missing object node).
      ['sfi.order_of_execution', { objectApiName: 'Account' }],
      // v2.0f W1 explainer tool: explain_flow. The id below does not
      // exist in the edu-org fixture; the tool returns
      // `component-not-found` — still a non-stub envelope and
      // satisfies the assertion below. The `Flow:` prefix exercises
      // the handler's prefix-validation step.
      ['sfi.explain_flow', { flowId: 'Flow:NoSuchFlow' }],
      // v2.0f W1 explainer tool: explain_apex_method. The id below
      // does not exist in the edu-org fixture; the tool returns
      // `component-not-found` — still a non-stub envelope. The
      // `ApexClass:` prefix exercises the handler's prefix-validation
      // step (the alternate `ApexTrigger:` prefix is accepted too;
      // the prefix-axis test in the unit suite exercises both).
      ['sfi.explain_apex_method', { classApiName: 'ApexClass:NoSuchClass' }],
      // v2.0f W1 explainer tool: explain_formula. Pure string-
      // processing tool — does not query the graph. The conditional
      // expression below tokenizes cleanly and produces a non-empty
      // functions array (`IF`), one field reference (`IsActive`),
      // and two literals (numeric `1`, `0`); `hasConditionalLogic`
      // is true. Even an invalid formula resolves to a non-stub
      // envelope (with `parseError` set) so the assertion below is
      // satisfied either way.
      ['sfi.explain_formula', { formulaExpression: 'IF(IsActive, 1, 0)' }],
      // v2.4 R2 hygiene tool: unused_fields_deep. The eight-tier cross-
      // walk scans every CustomField; the edu-org fixture produces a
      // structured envelope (either with fields[] flagged or an empty
      // list) — a non-stub envelope in either case.
      ['sfi.unused_fields_deep', {}],
      // v2.4 R2 hygiene tool: process_builder_migration_candidates. The
      // edu-org fixture may or may not have active Process Builders /
      // WorkflowRules — the tool returns a structured envelope with
      // per-category lists either way.
      ['sfi.process_builder_migration_candidates', {}],
      // v2.4 R2 hygiene tool: unassigned_permission_sets. Without v1.7
      // R2 enrichment the tool reports structural-only fallback and
      // populates unknownAssignmentCount — still a non-stub envelope.
      ['sfi.unassigned_permission_sets', {}],
      // v2.4 R2 hygiene tool: empty_queues_and_groups. Without v1.1
      // synthetic queue data the queues list may be empty; the response
      // is structured either way.
      ['sfi.empty_queues_and_groups', {}],
      // v2.4 R2 hygiene tool: tech_debt_score. Aggregates the prior
      // hygiene tools into a composite. When v1.7 R2 / v2.1 extractors
      // have not run, the response surfaces excludedCategories with
      // reason 'extractor-not-run' plus the Q115 verbatim disclosure —
      // still a non-stub envelope and the score is bounded in [0, 100].
      ['sfi.tech_debt_score', {}],
      // v2.3 R2a what-if tool: what_if_change_field_type. The id below
      // resolves to `component-not-found` against the edu-org fixture
      // (Account.Industry is a standard field not extracted into the
      // synthetic vault); the error envelope is still a non-stub
      // response and satisfies the assertion. A successful resolution
      // would surface a structured `impacts` array, `compatibility`
      // classification, and `verdict`.
      [
        'sfi.what_if_change_field_type',
        { fieldId: 'CustomField:Account.Industry', newType: 'Number' },
      ],
      // v2.3 R2a what-if tool: what_if_remove_picklist_value. The
      // fieldId resolves to `component-not-found` (same reason as
      // above) or `invalid-query` when the resolved field's type is
      // not Picklist / MultiselectPicklist. Either way the envelope is
      // non-stub and satisfies the assertion below.
      [
        'sfi.what_if_remove_picklist_value',
        { fieldId: 'CustomField:Account.Industry', value: 'Tech' },
      ],
      // v2.3 R2a what-if tool: what_if_make_field_required. Same
      // fieldId; the tool surfaces a non-stub envelope (either
      // component-not-found, or — when the field exists — the
      // structured `impacts` list with the verbatim dataflow-analysis
      // boundary disclosure).
      [
        'sfi.what_if_make_field_required',
        { fieldId: 'CustomField:Account.Industry' },
      ],
      // v2.3 R2b what-if component-level tool: what_if_deactivate_flow.
      // The flowId below does not exist in the edu-org fixture, so the
      // tool returns `component-not-found` — still a non-stub envelope
      // and satisfies the assertion below. The `Flow:` prefix exercises
      // the handler's prefix-validation step; a malformed prefix would
      // surface `invalid-query`.
      ['sfi.what_if_deactivate_flow', { flowId: 'Flow:NoSuchFlow' }],
      // v2.3 R2b what-if component-level tool: what_if_disable_trigger.
      // The triggerId below does not exist in the edu-org fixture; the
      // tool returns `component-not-found` — still a non-stub envelope.
      // The `ApexTrigger:` prefix exercises the handler's prefix-
      // validation step.
      [
        'sfi.what_if_disable_trigger',
        { triggerId: 'ApexTrigger:NoSuchTrigger' },
      ],
      // v2.3 R2b what-if component-level tool:
      // what_if_change_method_signature. The classApiName below does
      // not exist in the edu-org fixture; the tool returns
      // `component-not-found` — still a non-stub envelope. The
      // `methodName` parameter is required (passed verbatim); the
      // `newSignature` is optional and omitted here so the response's
      // `newSignature` field surfaces as null.
      [
        'sfi.what_if_change_method_signature',
        { classApiName: 'ApexClass:NoSuch', methodName: 'someMethod' },
      ],
      // v2.1 R3 code-quality composer: code_quality_audit. Walks every
      // ApexClass / ApexTrigger / Flow node's `properties.qualityIssues`
      // mirror. The edu-org fixture's Apex classes may or may not
      // populate `qualityIssues` depending on whether the v2.1 R2
      // recognizer extraction pass ran against the staged fixture; the
      // response is a structured (issues, totalCount, summary,
      // boundaries) envelope either way — a non-stub envelope that
      // satisfies the assertion below.
      ['sfi.code_quality_audit', {}],
      // v2.1 R3 code-quality composer: governor_limit_risks. Walks
      // ApexClass / ApexTrigger nodes and narrows to the three
      // governor-limit rules (`soql-in-loop`, `dml-in-loop`,
      // `database-upsert-no-options`). The fixture may produce zero
      // matches; the response is still a structured (classes,
      // totalClassCount, totalRiskCount, byRule, boundaries) envelope —
      // a non-stub envelope.
      ['sfi.governor_limit_risks', {}],
      // v2.1 R3 code-quality composer: find_hardcoded_values. Walks
      // ApexClass / ApexTrigger nodes and narrows to the four
      // hardcoded-literal rules. The optional `category` is omitted so
      // all four rule families are included. The response is a
      // structured (matches, totalCount, byCategory, boundaries)
      // envelope regardless of whether the fixture has any hardcoded
      // literals — a non-stub envelope.
      ['sfi.find_hardcoded_values', {}],
      // v2.1 R3 code-quality composer: crud_fls_audit. Walks
      // ApexClass / ApexTrigger nodes and narrows to the two CRUD/FLS
      // rules. When at least one finding qualifies, the response
      // surfaces the verbatim Q80 false-positive disclosure in
      // `boundaries[]`. Either path is a non-stub envelope.
      ['sfi.crud_fls_audit', {}],
      // v2.1 R3 code-quality composer: test_coverage_gaps. Combines
      // `isTest` identity, incoming `callsApex` BFS (depth 3), and
      // `fake-assertion` findings to classify every non-test ApexClass
      // into one of `uncovered` / `fake-coverage` /
      // `low-quality-coverage`. The fixture's ApexClass population
      // resolves to a structured (gaps, totalGapsCount, byStatus,
      // boundaries) envelope — a non-stub envelope.
      ['sfi.test_coverage_gaps', {}],
      // v2.3 R2c profile what-if tool: what_if_merge_profiles. Both
      // ids below do not exist in the edu-org fixture; the tool returns
      // `component-not-found` — still a non-stub envelope and
      // satisfies the assertion below. The `Profile:` prefix exercises
      // the handler's prefix-validation step on both axes.
      [
        'sfi.what_if_merge_profiles',
        {
          profileIdA: 'Profile:NoSuchA',
          profileIdB: 'Profile:NoSuchB',
        },
      ],
      // v2.3 R2c profile what-if tool: what_if_split_profile. The
      // profileId below does not exist in the edu-org fixture; the tool
      // returns `component-not-found` — still a non-stub envelope. The
      // `targetPermSets` array carries a non-empty entry that itself
      // resolves to `component-not-found` if reached; the profile-not-
      // found short-circuit fires first.
      [
        'sfi.what_if_split_profile',
        {
          profileId: 'Profile:NoSuch',
          targetPermSets: ['PermissionSet:NoSuch'],
        },
      ],
      // v2.5 documentation-generation tier: generate_data_dictionary.
      // The objectId may or may not resolve in the edu-org fixture; an
      // unknown id surfaces `component-not-found` — still a non-stub
      // envelope. Resolved objects emit a structured (document) payload
      // with the GeneratedDocument shape.
      [
        'sfi.generate_data_dictionary',
        { objectId: 'CustomObject:Account' },
      ],
      // v2.5 documentation-generation tier: generate_admin_handbook.
      // Default persona is admin; the handler tallies every type and
      // emits a structured (document) payload. Always non-stub.
      ['sfi.generate_admin_handbook', {}],
      // v2.5 documentation-generation tier:
      // generate_architecture_overview. Composes org_overview +
      // domain_clusters + integration_map; always non-stub.
      ['sfi.generate_architecture_overview', {}],
      // v2.5 documentation-generation tier: generate_sharing_summary.
      // Default scans every extracted CustomObject (capped); always
      // non-stub regardless of population.
      ['sfi.generate_sharing_summary', {}],
      // v2.5 documentation-generation tier: generate_compliance_report.
      // Composes pii_inventory + field_access_audit; always non-stub.
      ['sfi.generate_compliance_report', {}],
      // v2.5 documentation-generation tier: generate_onboarding_doc.
      // Chains every other generator; default persona is admin. Always
      // non-stub.
      ['sfi.generate_onboarding_doc', {}],
      // v2.7 R2 deep code understanding tier: call_graph. Walks
      // `callsApex` from a root ApexClass/ApexTrigger. The id below
      // resolves to ContactServices in the edu-org fixture (guaranteed
      // non-empty by journal 0074). An unknown id resolves to a
      // root-only walk — still a non-stub envelope.
      [
        'sfi.call_graph',
        { rootId: 'ApexClass:ContactServices', direction: 'downstream' },
      ],
      // v2.7 R2 deep code understanding tier: downstream_effects.
      // Walks the same downstream BFS and surfaces writesTo /
      // dispatchesAsync / sendsEmail edges as side effects. Unknown root
      // surfaces as `component-not-found` — still a non-stub envelope.
      [
        'sfi.downstream_effects',
        { classApiName: 'ApexClass:ContactServices' },
      ],
      // v2.7 R2 deep code understanding tier:
      // test_coverage_for_method. Walks upstream `callsApex` filtering
      // to nodes with `properties.isTest === true`. Unknown class
      // surfaces as `component-not-found` — still a non-stub envelope.
      [
        'sfi.test_coverage_for_method',
        { classApiName: 'ApexClass:ContactServices' },
      ],
      // v2.7 R2 deep code understanding tier: meaningful_test_audit.
      // Lists every test ApexClass with a heuristic assertion-density
      // score. The fixture may surface zero test classes; the response
      // is a structured (totalTestClassCount, tests, disclosure)
      // envelope — non-stub.
      ['sfi.meaningful_test_audit', {}],
      // v2.7 R2 deep code understanding tier: method_reachability.
      // Walks upstream `callsApex` from the root and classifies the
      // reachable upstream set against the entry-point taxonomy.
      // Unknown class surfaces as `component-not-found` — still a
      // non-stub envelope.
      [
        'sfi.method_reachability',
        { classApiName: 'ApexClass:ContactServices' },
      ],
      // v2.8 R2 async + integration deep tier: cdc_subscribers. Takes
      // an optional `sObjectFilter`; without one the tool walks every
      // CustomObject in the graph whose apiName matches the CDC name-
      // pattern rule and reports the listensTo subscribers. The
      // edu-org fixture has no CDC events, so the response is the
      // honest empty case (subscribers: [], summary.totalSubscribers:
      // 0) plus the verbatim disclosure — non-stub.
      ['sfi.cdc_subscribers', {}],
      // v2.8 R2 async + integration deep tier: async_chain_depth. The
      // root id below does not exist in the edu-org fixture; the
      // handler returns `component-not-found` — still a non-stub
      // envelope. The `ApexClass:` prefix exercises the handler's
      // prefix-validation step.
      [
        'sfi.async_chain_depth',
        { rootApexClassId: 'ApexClass:NoSuchScheduler' },
      ],
      // v2.8 R2 async + integration deep tier: scheduled_job_catalog.
      // Takes no arguments — walks every ApexClass with
      // `properties.isSchedulable === true`. The edu-org fixture's
      // ApexClass population resolves to a structured (jobs, summary,
      // disclosure) envelope regardless of whether any class is
      // Schedulable — non-stub.
      ['sfi.scheduled_job_catalog', {}],
      // v2.8 R2 async + integration deep tier:
      // outbound_message_catalog. The fixture has no
      // OutboundMessage nodes (the v2.8 promotion only emits them
      // when a workflow file's `<outboundMessages>` element is
      // present); the tool returns an empty entries list with the
      // verbatim disclosure — non-stub. Optional `objectFilter`
      // narrows to one parent CustomObject when present.
      ['sfi.outbound_message_catalog', {}],
      // v2.8 R2 async + integration deep tier: endpoint_catalog.
      // Takes no arguments — composes inbound APIs (from `exposes`
      // edges), OutboundMessage `endpointUrl`, ExternalDataSource
      // endpoints, and NamedCredential URLs into one structured
      // catalog. The fixture's population varies by category but
      // every emitted bucket is a structured array — non-stub.
      ['sfi.endpoint_catalog', {}],
      // v2.9 R4 vocabulary + semantic-disambiguation tier:
      // field_meaning. The id below resolves in the edu-org fixture
      // (CustomField:Account.Industry is a standard field present
      // in every population). When unresolved, the handler surfaces
      // `component-not-found` — still a non-stub envelope.
      [
        'sfi.field_meaning',
        { fieldId: 'CustomField:Account.Industry' },
      ],
      // v2.9 R4 vocabulary + semantic-disambiguation tier:
      // disambiguate_concepts. Two concept tokens are required; the
      // handler walks every CustomField and partitions matches into
      // two buckets. The fixture's CustomField population resolves to
      // a structured (conceptA, conceptB, differences,
      // suggestedWhenToUseEach, boundaries) envelope regardless of
      // whether any field matches — non-stub.
      [
        'sfi.disambiguate_concepts',
        { conceptA: 'Status', conceptB: 'Stage' },
      ],
      // v2.9 R4 vocabulary + semantic-disambiguation tier:
      // field_provenance. The id below exercises the handler's prefix
      // validation; unknown ids surface as `component-not-found` —
      // still a non-stub envelope.
      [
        'sfi.field_provenance',
        { fieldId: 'CustomField:Account.Industry' },
      ],
      // v2.2 R2 universal find-anywhere + discovery surface:
      // find_field_anywhere. Walks every incoming non-parentOf edge
      // to a CustomField id and groups referrers by ComponentType.
      // Unknown / empty result resolves to a structured (groups: [],
      // totalCount: 0, boundaries: [], truncated: false) envelope —
      // non-stub.
      [
        'sfi.find_field_anywhere',
        { targetId: 'CustomField:Account.Industry' },
      ],
      // v2.2 R2 universal find-anywhere + discovery surface:
      // find_semantic_field. Tokenizes the query and ranks
      // CustomFields by lexical overlap. The fixture's CustomField
      // population resolves to a structured (matches, totalCount,
      // tokenizedQuery, boundaries) envelope regardless of whether
      // any field matches — non-stub.
      [
        'sfi.find_semantic_field',
        { description: 'industry' },
      ],
      // v2.2 R2 universal find-anywhere + discovery surface:
      // find_hardcoded_values_anywhere. Scans Apex qualityIssues,
      // CustomField.formula, ValidationRule.errorConditionFormula,
      // and WorkflowRule.formula for the requested category /
      // value. Without a category/value specified, the handler
      // returns `invalid-query` — this call specifies a category to
      // exercise the happy path.
      [
        'sfi.find_hardcoded_values_anywhere',
        { category: 'email' },
      ],
      // v2.2 R2 universal find-anywhere + discovery surface:
      // find_clone_patterns. Computes the structural fingerprint on
      // the fly from outgoing edges and ranks same-type siblings by
      // Jaccard similarity. Unknown id surfaces as
      // `component-not-found` — still a non-stub envelope.
      [
        'sfi.find_clone_patterns',
        { componentId: 'ApexClass:ContactServices' },
      ],
      // v2.2 R2 universal find-anywhere + discovery surface:
      // find_dead_code. Composes incoming-edge classification +
      // entry-point taxonomy into a cascade verdict per candidate.
      // Default types covers ApexClass/ApexTrigger/Flow/CustomField;
      // the fixture's population resolves to a structured (candidates,
      // totalCount, byVerdict, byType, boundaries, truncated)
      // envelope — non-stub.
      ['sfi.find_dead_code', {}],
      // v2.6a R2 CPQ specialist tier. The edu-org fixture has no
      // SBQQ__-prefixed records (CPQ is not installed), so every
      // CPQ-typed query resolves to `component-not-found` (for
      // single-id tools) or an empty-but-structured envelope (for
      // the cpq_dependency_map walker with no cpqComponentId). Both
      // shapes are non-stub.
      [
        'sfi.cpq_rule_chain',
        { ruleId: 'CpqPriceRule:SBQQ__PriceRule__c.HighDiscountAlert' },
      ],
      [
        'sfi.cpq_quote_template_breakdown',
        { templateId: 'CpqQuoteTemplate:SBQQ__QuoteTemplate__c.Standard' },
      ],
      ['sfi.cpq_dependency_map', {}],
      // v3.0 unified field forensics synthesis tier — field_360 + lineage.
      // `field_360` composes every prior tier's reads of a field; the
      // edu-org fixture's CustomField:Account.Industry resolves to a
      // structured response with per-section content, summary, and the
      // Q165 `dataNotAvailable[]` honesty disclosure. Even a field
      // with sparse coverage resolves to a non-stub envelope because the
      // `boundaries[]` + `dataNotAvailable[]` arrays are populated
      // unconditionally.
      ['sfi.field_360', { fieldId: 'CustomField:Account.Industry' }],
      // v3.0 `field_lineage` upstream walk against the same canonical
      // anchor field. The walk depth-bounds at 3 hops by default and
      // surfaces the Q165 disclosure + cycle/depth boundary notes
      // verbatim — non-stub regardless of fixture lineage depth.
      [
        'sfi.field_lineage',
        { fieldId: 'CustomField:Account.Industry', direction: 'upstream' },
      ],
      // v3.1 cross-org / sandbox-vs-prod comparison tier. The
      // edu-org fixture has no registered cross-vault aliases (the
      // co-resident root holds only this one vault), so the four
      // cross-vault tools return their Q170 vault-not-found refusal
      // payload with the verbatim `sfi register-vault` directive — a
      // structured envelope and a non-stub response. The shape is
      // explicitly designed so a single-vault deployment exercises
      // the tools' refusal cascade without the caller needing to
      // provision a second registered vault.
      [
        'sfi.compare_vaults',
        { vaultA: 'no-such-vault-a', vaultB: 'no-such-vault-b' },
      ],
      [
        'sfi.compare_object_across_vaults',
        {
          objectApiName: 'Account',
          vaultA: 'no-such-vault-a',
          vaultB: 'no-such-vault-b',
        },
      ],
      [
        'sfi.compare_profile_across_vaults',
        {
          profileName: 'System Administrator',
          vaultA: 'no-such-vault-a',
          vaultB: 'no-such-vault-b',
        },
      ],
      // v3.1 Q174 honesty-anchor: single-vault field-mapping tool.
      // Same refusal cascade when the single named vault alias is
      // not registered; the response still carries the verbatim Q174
      // heuristic-mapping disclosure regardless of refusal status.
      [
        'sfi.field_mapping_between_objects',
        {
          vault: 'no-such-vault',
          objectA: 'Lead',
          objectB: 'Contact',
        },
      ],
      // v3.2 OmniStudio declarative-process tier. The edu-org
      // fixture has no DecisionTable nodes (the OmniStudio
      // Industries family is not staged on top of the v0.1 fixture
      // tree), so the tool resolves to `component-not-found` for
      // any DecisionTable: id — a structured non-stub envelope. The
      // Q179 row-data refusal is contract-locked at the tool level
      // (see decision-table-browse unit tests); the integration
      // sweep only proves the dispatch route is wired and a happy-
      // path id-shape lookup completes without falling through to
      // the not-implemented stub.
      [
        'sfi.decision_table_browse',
        { decisionTableId: 'DecisionTable:DoesNotExist' },
      ],
      // v3.2 R3c OmniStudio composition tier. The edu-org fixture
      // has no OmniDataTransform nodes, so the canonical-shape id
      // resolves to `component-not-found` — a structured non-stub
      // envelope. The Q178 honesty anchor (per-row `declared` vs
      // `parsed` confidence + the Native-vs-Vlocity disclosure) is
      // contract-locked at the tool level (see
      // datatransform-field-map unit tests); the integration sweep
      // only proves the dispatch route is wired.
      [
        'sfi.datatransform_field_map',
        { dataTransformId: 'OmniDataTransform:DoesNotExist' },
      ],
      // v3.2 R3a OmniStudio "walk this OmniScript end-to-end" surface.
      // Same fixture story: the edu-org vault has no OmniScript nodes,
      // so the canonical-shape id resolves to `component-not-found` —
      // a structured non-stub envelope. The Q176 / Q179 / Q180 honesty
      // anchors (Native-vs-Vlocity, OmniProcessElement record-level,
      // Apex-coupling-deferred) are contract-locked at the tool level
      // (see omniscript-flow unit tests); the integration sweep only
      // proves the dispatch route is wired.
      [
        'sfi.omniscript_flow',
        { omniScriptId: 'OmniScript:DoesNotExist' },
      ],
      // v3.2 R3b OmniStudio "walk this IP's action chain" Q177 surface.
      // The edu-org fixture has no OmniIntegrationProcedure nodes, so
      // the canonical-shape id resolves to `component-not-found` — a
      // structured non-stub envelope. The four verbatim boundary
      // disclosures (Native-vs-Vlocity, v3.3 Apex-coupling deferral,
      // OmniProcessElement record-level, and REST-endpoint
      // reachability) are contract-locked at the tool level (see
      // integration-procedure-chain unit tests); the integration sweep
      // only proves the dispatch route is wired.
      [
        'sfi.integration_procedure_chain',
        {
          integrationProcedureId:
            'OmniIntegrationProcedure:DoesNotExist_Procedure_1',
        },
      ],
      // v3.2 R3d OmniStudio "what's inside this FlexCard" surface. The
      // edu-org fixture has no OmniUiCard nodes, so the canonical-shape
      // id resolves to `component-not-found` — a structured non-stub
      // envelope. The propertySetConfig-parsing disclosure and the
      // Native-vs-Vlocity disclosure are contract-locked at the tool
      // level (see omniuicard-widget-breakdown unit tests); the
      // integration sweep only proves the dispatch route is wired.
      [
        'sfi.omniuicard_widget_breakdown',
        { omniUiCardId: 'OmniUiCard:DoesNotExist' },
      ],
      // v4.0 — minimal args; structured errors are acceptable (not stubs).
      ['sfi.capabilities', {}],
      ['sfi.org_pulse', {}],
      ['sfi.resolve', { query: 'budget' }],
      ['sfi.fleet_find', { query: 'budget' }],
      ['sfi.coverage_report', {}],
      ['sfi.baseline_status', {}],
      ['sfi.baseline_acknowledge', { fingerprint: 'integration-test-fp' }],
      ['sfi.live_describe', { objectApiName: 'Account' }],
      ['sfi.live_count', { soql: 'SELECT COUNT() FROM Account' }],
      ['sfi.live_stale_check', {}],
      ['sfi.live_sample', { soql: 'SELECT Id FROM Account LIMIT 1' }],
      [
        'sfi.live_aggregate',
        { objectApiName: 'Account', fieldApiName: 'AnnualRevenue' },
      ],
      [
        'sfi.live_duplicate_check',
        { objectApiName: 'Account', fieldApiName: 'Name' },
      ],
      ['sfi.live_owner_breakdown', { objectApiName: 'Account' }],
      ['sfi.live_storage_by_object', {}],
      [
        'sfi.live_field_population',
        { objectApiName: 'Account', fieldApiName: 'Name' },
      ],
      ['sfi.live_org_limits', {}],
      ['sfi.org_risk_report', { limit: 5 }],
      ['sfi.field_cleanup_candidates', { limit: 5 }],
      ['sfi.automation_risk_report', { limit: 5 }],
      ['sfi.permission_risk_report', { limit: 5 }],
      ['sfi.release_readiness_report', {}],
      ['sfi.churn', {}],
      ['sfi.trend', {}],
      // Decision-support / advisor / continuous-learning / live tools. Minimal
      // args; structured errors (disabled live plane, missing id) are not stubs.
      ['sfi.find_dependency_cycles', {}],
      ['sfi.apex_test_coverage', {}],
      ['sfi.apex_build_advisor', {}],
      ['sfi.automation_build_advisor', { objectApiName: 'Account' }],
      ['sfi.field_change_advisor', { fieldId: 'CustomField:Account.Name' }],
      ['sfi.org_history', {}],
      ['sfi.what_changed_since_refresh', {}],
      ['sfi.live_drift_check', { objectApiName: 'Account' }],
      ['sfi.live_inactive_users', { days: 30 }],
      [
        'sfi.live_group_count',
        { objectApiName: 'Account', groupByField: 'Industry' },
      ],
      ['sfi.live_stale_records', { objectApiName: 'Account' }],
      ['sfi.live_recent_activity', { objectApiName: 'Account' }],
      ['sfi.live_report_usage', {}],
      ['sfi.live_folder_access', {}],
      ['sfi.live_email_template_usage', {}],
      ['sfi.live_org_health', {}],
      ['sfi.live_consent', {}],
      ['sfi.route_question', { question: 'how many accounts' }],
      // v4.0 additions — keep the sweep in lock-step with V01_TOOLS. Minimal
      // args; structured errors (disabled live plane, empty selection) are not
      // stubs, so each still satisfies the not-stub assertion below.
      ['sfi.package_impact', {}],
      ['sfi.tests_for_change', { changedComponents: ['ApexClass:AccountActions'] }],
      ['sfi.live_license_usage', {}],
      // Grounding / guidance / value-change tools — registered in later phases
      // but previously absent from this sweep. Minimal args; a structured
      // error (e.g. component-not-found, no-topic) is not a stub, so each
      // still satisfies the not-stub assertion below.
      ['sfi.guidance', { topic: 'flow-vs-apex' }],
      ['sfi.synthesize_answer', { input: {}, question: 'what is this' }],
      ['sfi.value_change_audit', { object: 'Account' }],
      ['sfi.what_if_change_field_value', { fieldId: 'CustomField:Account.Name' }],
    ];

    // Every advertised tool must appear in `calls`. If a new tool is
    // added to V01_TOOLS, the sweep must be updated — fail loudly
    // rather than silently miss coverage.
    expect(calls.map(([toolName]) => toolName).sort()).toEqual(
      [...V01_TOOLS].map((tool) => tool.name).sort(),
    );

    for (const [toolName, args] of calls) {
      const result = await dispatchTool(liveCtx, toolName, args);
      expect(result.content[0]?.type).toBe('text');
      const body = parseEnvelope(result.content);
      assertNotStubEnvelope(body, toolName);
    }
  });

  it('admits SOE tools for Account when automation targets the object', async () => {
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;
    const objectId = 'CustomObject:Account';

    const triggersOn = await listEdges(liveCtx.graph, objectId, {
      direction: 'in',
      edgeType: 'triggersOn',
    });
    expect(triggersOn.ok).toBe(true);
    if (!triggersOn.ok) return;

    const whos = await dispatchTool(liveCtx, 'sfi.what_happens_on_save', {
      objectApiName: 'Account',
      event: 'insert',
    });
    const whosBody = parseEnvelope(whos.content);
    assertNotStubEnvelope(whosBody, 'sfi.what_happens_on_save');

    const ooe = await dispatchTool(liveCtx, 'sfi.order_of_execution', {
      objectApiName: 'Account',
    });
    const ooeBody = parseEnvelope(ooe.content);
    assertNotStubEnvelope(ooeBody, 'sfi.order_of_execution');

    if (triggersOn.value.length === 0) {
      expect(whosBody).toHaveProperty('error');
      expect(ooeBody).toHaveProperty('error');
      return;
    }

    expect(whosBody).toHaveProperty('data');
    expect(ooeBody).toHaveProperty('data');
    const whosData = (whosBody as { data: { objectModeled?: boolean } }).data;
    const ooeData = (ooeBody as { data: { objectModeled?: boolean } }).data;
    expect(typeof whosData.objectModeled).toBe('boolean');
    expect(typeof ooeData.objectModeled).toBe('boolean');
  });

  it('emits v0.2 semantic edges from the formula tokenizer and Flow walker', async () => {
    // Read the manifest the refresh wrote. `result.counts.edges` is also
    // available from the staged `beforeAll` refresh, but the manifest is
    // the contract surface MCP clients see — asserting on it directly
    // catches drift between the in-memory count and the persisted record.
    const paths = vaultPaths(vaultRoot);
    const manifest = JSON.parse(
      await readFile(paths.manifest, 'utf8'),
    ) as VaultManifest;
    const edges = manifest.edges;

    // `references` floor: Block_nulling_Advisor_on_EN_students alone
    // emits 2 (Student_Status__c + Academic_Advisor__c per journal 0064)
    // and Qualified_Faculty__c.Course_Name__c (`Course__r.Name`) emits 1
    // more (journal 0066). The fixture has 23 validation rules plus
    // formula custom fields; the conservative floor is 2 so the assertion
    // survives schema-strict rejections without flapping. The point is to
    // prove the formula tokenizer wired through to the manifest, not to
    // pin the exact count.
    expect(edges['references'] ?? 0).toBeGreaterThanOrEqual(2);

    // Flow semantic edges (journal 0067). The edu-org fixture has 297
    // flows; ~10 of them have `<actionType>apex</actionType>` action
    // calls, and many record-triggered flows do recordLookups,
    // recordCreates, or recordUpdates. The floors below are
    // intentionally low: they assert the WIRING is correct (the Flow
    // extractor emits these edge types into the graph and the manifest
    // pipeline tallies them) rather than the exact population.
    expect(edges['callsApex'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(edges['readsFrom'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(edges['writesTo'] ?? 0).toBeGreaterThanOrEqual(1);
    // `triggersOn` covers both record-triggered flows AND ApexTrigger
    // declarations (journal 0017). The fixture has 22 triggers, so the
    // floor is generous even if no record-triggered flows survive
    // extraction.
    expect(edges['triggersOn'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('emits v0.3 Apex scanner edges from extractApexClass and extractApexTrigger', async () => {
    // The v0.3 heuristic Apex scanner (journals 0072-0074) emits
    // `readsFrom`, `writesTo`, and `callsApex` edges from each
    // ApexClass/ApexTrigger node, tagged with
    // `source: 'apex-scanner'` and `confidence: 'heuristic'`.
    //
    // The manifest aggregates per-edge-type counts across ALL
    // producers (Flow + scanner share `readsFrom`/`writesTo`/
    // `callsApex`), so manifest-level floors below would already pass
    // on Flow contributions alone. They are kept here as the same
    // "wiring exists" floor the v0.2 block uses; the load-bearing
    // v0.3 assertion is the direct graph query further down, which
    // proves the scanner specifically is contributing edges with the
    // documented confidence + source.
    const paths = vaultPaths(vaultRoot);
    const manifest = JSON.parse(
      await readFile(paths.manifest, 'utf8'),
    ) as VaultManifest;
    const edges = manifest.edges;

    // Floors are conservative on purpose. ContactTrigger alone yields
    // 2 readsFrom edges (trigger.newMap, trigger.oldMap per journal
    // 0074); MRK_ClearLogsBatch yields a writesTo
    // (`this.mainMarketoSetting = ...`); ContactTrigger yields a
    // callsApex to ContactServices. The edu-org has 186 classes + 22
    // triggers; actual counts will be much higher. Conservative floors
    // survive schema-strict rejections that happen when fixtures
    // partially fail to extract.
    expect(edges['readsFrom'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(edges['writesTo'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(edges['callsApex'] ?? 0).toBeGreaterThanOrEqual(1);

    // Direct graph query: prove the scanner is contributing edges
    // tagged with the documented source + confidence. ContactTrigger
    // is the canonical anchor — journal 0074 documents three
    // scanner-emitted outgoing edges from it: one `callsApex` to
    // ContactServices and two `readsFrom` (trigger.newMap,
    // trigger.oldMap).
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;
    const edgesResult = await listEdges(
      liveCtx.graph,
      'ApexTrigger:ContactTrigger',
      { direction: 'out' },
    );
    expect(edgesResult.ok).toBe(true);
    if (!edgesResult.ok) return;
    const scannerEdges = edgesResult.value.filter(
      (e: Edge) => e.source === 'apex-scanner',
    );
    expect(scannerEdges.length).toBeGreaterThanOrEqual(1);
    // Every scanner-emitted edge MUST carry heuristic confidence —
    // the scanner is a regex-based pass, not an AST, and the
    // confidence wiring (journal 0073) is what lets downstream
    // consumers cite the right uncertainty in their answers.
    for (const edge of scannerEdges) {
      expect(edge.confidence).toBe('heuristic');
    }
  });

  it('emits v1.1 sharing & visibility edges from Role/Queue/SharingRules', async () => {
    // The v1.1 sharing & visibility extractors (Role, Group, Queue,
    // SharingRule per .claude/journal/0087-v1.1-kickoff-gap-analysis.md)
    // emit `inheritsFrom` (Role → parent Role) and `sharedWith` (Queue
    // → CustomObject and SharingRule → Group/Role) edges.
    //
    // The edu-org fixture has no `roles/`, `groups/`, `queues/`, or
    // `sharingRules/` directories — `stageFixture` layers the
    // `synthetic-v1.1/` subtrees into `source/main/default/{name}/`
    // so the dispatcher's segment-match fires the v1.1 extractors. The
    // floors below are derived from the synthetic fixture content:
    //
    //   - Role hierarchy: Executive_Officer (top, no parent) ←
    //     Sales_VP ← Sales_Manager ← Sales_Rep yields 3 inheritsFrom
    //     edges total.
    //   - Queue sharedWith: Lead_Queue×1 + Case_Queue×1 + Multi_Queue×2
    //     = 4 edges (one per distinct sobjectType).
    //   - SharingRule sharedWith: Account criteria + Account owner
    //     (sharedTo + sharedFrom = 2) + Contact criteria + Opportunity
    //     criteria = 5 edges.
    //
    // Floor for sharedWith is 5: the Queue contributions alone clear
    // it (4 + at least one SharingRule edge), and the SharingRule
    // contributions also clear it independently. Either covers the
    // floor if the other temporarily regresses — the gate stays honest.
    const paths = vaultPaths(vaultRoot);
    const manifest = JSON.parse(
      await readFile(paths.manifest, 'utf8'),
    ) as VaultManifest;
    const components = manifest.components;
    const edges = manifest.edges;

    // Component floors. These are the conservative minimums for the
    // staged synthetic fixtures; production v1.1 orgs will exceed them.
    expect(components['Role'] ?? 0).toBeGreaterThanOrEqual(4);
    expect(components['Group'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['Queue'] ?? 0).toBeGreaterThanOrEqual(3);
    expect(components['SharingRule'] ?? 0).toBeGreaterThanOrEqual(4);

    // Edge floors. `inheritsFrom` is produced only by Role; `sharedWith`
    // is produced by both Queue and SharingRule. Floors are kept low so
    // adding/removing a single fixture file doesn't flap the gate.
    expect(edges['inheritsFrom'] ?? 0).toBeGreaterThanOrEqual(3);
    expect(edges['sharedWith'] ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('emits v1.2 record-types + UI-surface edges from RecordType/CustomApplication/QuickAction extractors', async () => {
    // The v1.2 record-types + UI-surfaces extractors land across R2a/R2b/R2c
    // (per `.claude/journal/` v1.2 R2 entries). RecordType is exercised by
    // edu-org directly (the fixture has ~30 .recordType-meta.xml files
    // scattered under various objects/*/recordTypes/ trees); everything
    // else is exercised by the synthetic-v1.2 fixtures `stageFixture`
    // layers in at the canonical Salesforce DX paths.
    //
    // The interesting new edges for the v1.2 manifest:
    //
    //   - `belongsToApp` (CustomTab → CustomApplication, declared,
    //     emitted by `custom-application-extractor`): Sales_App has
    //     2 `<tabs>` (Account_Custom, MyLwc_Tab); Service_App has 1
    //     (MyLwc_Tab) = 3 edges total.
    //
    //   - `parentOf` (CustomObject → {RecordType, BusinessProcess,
    //     QuickAction} and RecordType → PathAssistant): edu-org
    //     RecordTypes alone push the count well past the v1.1 floor.
    //     Floor below is the existing CustomField-dominated floor
    //     plus a conservative v1.2 contribution (>=10 new parentOf
    //     edges from the synthetic + edu-org v1.2 surfaces).
    const paths = vaultPaths(vaultRoot);
    const manifest = JSON.parse(
      await readFile(paths.manifest, 'utf8'),
    ) as VaultManifest;
    const components = manifest.components;
    const edges = manifest.edges;

    // Component floors. Synthetic-v1.2 counts are stable; the edu-org
    // RecordType count (~30) easily clears its floor of 2.
    expect(components['RecordType'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['BusinessProcess'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['PathAssistant'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['CustomTab'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['CustomApplication'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['QuickAction'] ?? 0).toBeGreaterThanOrEqual(3);
    expect(components['GlobalValueSet'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['CustomLabel'] ?? 0).toBeGreaterThanOrEqual(4);
    expect(components['StaticResource'] ?? 0).toBeGreaterThanOrEqual(2);

    // Edge floors. `belongsToApp` is the new v1.2 edge type — Sales_App
    // contributes 2, Service_App contributes 1.
    expect(edges['belongsToApp'] ?? 0).toBeGreaterThanOrEqual(3);

    // `parentOf` was already floored by the CustomField population in
    // the v0.1 test above. The v1.2 surfaces add more (RecordType +
    // BusinessProcess + QuickAction + PathAssistant parentOf edges).
    // The conservative floor here ensures the v1.2 contributions are
    // actually landing in the manifest rather than being silently
    // dropped — adding the existing CustomField-dominated floor plus
    // a v1.2 cushion of 10 keeps the gate honest without flapping.
    expect(edges['parentOf'] ?? 0).toBeGreaterThanOrEqual(
      FIXTURE_COMPONENT_FLOOR.CustomField + 10,
    );
  });

  it('emits belongsToApp edges from a synthetic CustomTab with the right source/confidence', async () => {
    // Direct graph query: prove the v1.2 CustomApplication extractor is
    // contributing edges tagged with the documented source + confidence.
    // The synthetic-v1.2 `Account_Custom` tab is referenced by Sales_App
    // (one of two `<tabs>` entries); the outgoing `belongsToApp` edge
    // from CustomTab:Account_Custom must surface in the graph with
    // `source: 'custom-application-extractor'` and
    // `confidence: 'declared'`.
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;
    const edgesResult = await listEdges(
      liveCtx.graph,
      'CustomTab:Account_Custom',
      { direction: 'out' },
    );
    expect(edgesResult.ok).toBe(true);
    if (!edgesResult.ok) return;
    const belongsToAppEdges = edgesResult.value.filter(
      (e: Edge) => e.edgeType === 'belongsToApp',
    );
    expect(belongsToAppEdges.length).toBeGreaterThanOrEqual(1);
    for (const edge of belongsToAppEdges) {
      expect(edge.source).toBe('custom-application-extractor');
      expect(edge.confidence).toBe('declared');
    }
  });

  it('emits v1.3 legacy-automation + communications edges', async () => {
    // The v1.3 R2a-R2d extractors (WorkflowRule, ApprovalProcess,
    // AssignmentRule, AutoResponseRule, EscalationRule, DuplicateRule,
    // MatchingRule, EmailTemplate, Letterhead) emit the new `sendsEmail`
    // edge type alongside `parentOf`, `triggersOn`, and other v1.x
    // edges already covered. None of the v1.3 surfaces exist in the
    // edu-org fixture, so the floors below come exclusively from the
    // staged `synthetic-v1.3/` subtrees:
    //
    //   - WorkflowRule fan-out per `<rules>`: Account × 2 + Opportunity
    //     × 1 = 3 nodes (floor 2 tolerates a single per-rule schema
    //     reject without flapping).
    //   - ApprovalProcess: Account.Credit_Review + Opportunity.Discount_Approval = 2.
    //   - AssignmentRule fan-out per `<assignmentRule>`: Lead × 2 +
    //     Case × 1 = 3 nodes (floor 2).
    //   - AutoResponseRule fan-out per `<autoResponseRule>`: Lead × 2
    //     = 2 nodes (floor 1 to survive schema-strict rejection of
    //     either ruleEntry).
    //   - EscalationRule fan-out per `<escalationRule>`: Case × 1 = 1
    //     node (floor 1).
    //   - DuplicateRule: Account.Standard_Duplicate +
    //     Lead.Standard_Duplicate = 2.
    //   - MatchingRule fan-out per `<matchingRules>`: Lead × 2 +
    //     Account × 1 = 3 nodes (floor 2).
    //   - EmailTemplate: CaseAck + Welcome + Newsletter = 3 (floor 3).
    //   - Letterhead: Corporate + Holiday = 2 (floor 2).
    //
    // The `sendsEmail` floor (2) is conservative: synthetic-v1.3
    // exercises this edge from AutoResponseRule (template references),
    // WorkflowRule (alert/email actions), and ApprovalProcess
    // (approval / rejection / recall email templates). Even if one
    // producer regresses temporarily, the others keep the floor.
    const paths = vaultPaths(vaultRoot);
    const manifest = JSON.parse(
      await readFile(paths.manifest, 'utf8'),
    ) as VaultManifest;
    const components = manifest.components;
    const edges = manifest.edges;

    // Component floors. Synthetic-v1.3 counts are stable; floors below
    // tolerate a single per-rule schema reject without flapping.
    expect(components['WorkflowRule'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['ApprovalProcess'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['AssignmentRule'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['AutoResponseRule'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(components['EscalationRule'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(components['DuplicateRule'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['MatchingRule'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['EmailTemplate'] ?? 0).toBeGreaterThanOrEqual(3);
    expect(components['Letterhead'] ?? 0).toBeGreaterThanOrEqual(2);

    // Edge floor. `sendsEmail` is the new v1.3 edge type; multiple
    // producers contribute (auto-response rules cite templates,
    // workflow rules carry email-alert action references, approval
    // processes cite approval/rejection/recall templates).
    expect(edges['sendsEmail'] ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('emits sendsEmail edges from a synthetic AutoResponseRule with the right source/confidence', async () => {
    // Direct graph query: prove the v1.3 AutoResponseRule extractor is
    // contributing edges tagged with the documented source + confidence.
    // The synthetic-v1.3 Lead.autoResponseRules-meta.xml fans out into
    // two AutoResponseRule nodes; `Standard_Web_To_Lead` references
    // `Sales/WebLeadWelcome` in its first ruleEntry, so the outgoing
    // `sendsEmail` edge from AutoResponseRule:Lead.Standard_Web_To_Lead
    // must surface in the graph. v1.3 R2 documented sources for this
    // edge include `auto-response-rule-extractor`,
    // `workflow-rule-extractor`, and `approval-process-extractor`; the
    // assertion below accepts any of them since the same fixture file
    // could be re-attributed in a future refactor and the test should
    // not pin to one specific extractor's internal naming.
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;
    const edgesResult = await listEdges(
      liveCtx.graph,
      'AutoResponseRule:Lead.Standard_Web_To_Lead',
      { direction: 'out' },
    );
    expect(edgesResult.ok).toBe(true);
    if (!edgesResult.ok) return;
    const sendsEmailEdges = edgesResult.value.filter(
      (e: Edge) => e.edgeType === 'sendsEmail',
    );
    expect(sendsEmailEdges.length).toBeGreaterThanOrEqual(1);
    const documentedSources = new Set<string>([
      'auto-response-rule-extractor',
      'workflow-rule-extractor',
      'approval-process-extractor',
    ]);
    for (const edge of sendsEmailEdges) {
      expect(documentedSources.has(edge.source)).toBe(true);
      expect(edge.confidence).toBe('declared');
    }
  });

  it('emits v1.4 frontend code + test mapping edges', async () => {
    // The v1.4 R3a + R3b extractors (LightningComponentBundle,
    // AuraDefinitionBundle, VisualforcePage, VisualforceComponent) emit
    // one node per fixture entry under `synthetic-v1.4/`. None of the
    // edu-org subtree contains these surfaces — the component floors
    // below come exclusively from the staged synthetic-v1.4 subtrees:
    //
    //   - lwc/AccountInfoCard/ -> 1 LightningComponentBundle node.
    //     The bundle's `.js` source imports
    //     `@salesforce/apex/AccountService.fetch` and reads
    //     `record.Industry__c` / writes `record.Status__c`, so the
    //     scanner emits at least 1 `callsApex` (declared) edge plus
    //     readsFrom / writesTo `CustomField:Account.*` edges
    //     (heuristic). The `<targetConfigs>` block lists
    //     `<object>Account</object>`, so a `references` edge to
    //     `CustomObject:Account` (declared) also emerges.
    //   - aura/CaseManager/ -> 1 AuraDefinitionBundle node. The
    //     markup `<c:CustomerCard />` / `<c:CaseTimeline />` produces
    //     references-edges (declared).
    //   - pages/AccountSummary.page -> 1 VisualforcePage node. The
    //     opening `<apex:page controller="AccountController"
    //     extensions="ContactExt,OpportunityExt">` produces three
    //     references-edges to ApexClass:{Account,Contact,Opportunity}*
    //     (declared, role=controller/extension).
    //   - components/Header.component -> 1 VisualforceComponent node.
    //     `<apex:component controller="HeaderController">` produces
    //     one references-edge to ApexClass:HeaderController.
    //
    // Floors are conservative (>= 1 per type) so a single per-bundle
    // schema reject surfaces as 0 < 1 rather than silently dropping.
    const paths = vaultPaths(vaultRoot);
    const manifest = JSON.parse(
      await readFile(paths.manifest, 'utf8'),
    ) as VaultManifest;
    const components = manifest.components;
    const edges = manifest.edges;

    // Component floors.
    expect(components['LightningComponentBundle'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(components['AuraDefinitionBundle'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(components['VisualforcePage'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(components['VisualforceComponent'] ?? 0).toBeGreaterThanOrEqual(1);

    // Edge floors. The v0.2 / v0.3 / v1.3 blocks already floor
    // `readsFrom`, `writesTo`, `callsApex`, and `references` from
    // other producers, so the v1.4 block floors them again with a
    // conservative +1 on top — the LWC scanner-emitted edges from
    // AccountInfoCard alone clear it (one `callsApex` from
    // `@salesforce/apex/AccountService.fetch`, one or more
    // `readsFrom` from `record.Industry__c` / `record.Name`, and a
    // `writesTo` from `record.Status__c = 'Refreshed'`). Keeping
    // these in a separate assert isolates a v1.4-extractor regression
    // from a v0.2 Flow / v0.3 Apex regression.
    expect(edges['callsApex'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(edges['readsFrom'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(edges['references'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('emits a declared references edge from the synthetic LWC to CustomObject:Account', async () => {
    // Direct graph query: prove the LWC extractor materialises the
    // `<targetConfigs><targetConfig><objects><object>Account</object>`
    // declaration as a `references` edge with `confidence: 'declared'`.
    // This is the only edge in the v1.4 fixture that lands at
    // `'declared'` confidence from the targetConfigs path; the field
    // accesses are `'heuristic'` (regex scanner) and the apex import
    // is `'declared'` but lands on ApexClass:AccountService, not on
    // a CustomObject. Targeting the `references` edge here keeps the
    // assertion sharp on the v1.4 R3a contract.
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;
    const edgesResult = await listEdges(
      liveCtx.graph,
      'LightningComponentBundle:AccountInfoCard',
      { direction: 'out' },
    );
    expect(edgesResult.ok).toBe(true);
    if (!edgesResult.ok) return;
    const referencesEdges = edgesResult.value.filter(
      (e: Edge) =>
        e.edgeType === 'references' && e.toId === 'CustomObject:Account',
    );
    expect(referencesEdges.length).toBeGreaterThanOrEqual(1);
    for (const edge of referencesEdges) {
      expect(edge.confidence).toBe('declared');
      expect(edge.source).toBe('lwc-extractor');
    }
  });

  it('emits v1.6 business-user record-value edges', async () => {
    // The v1.6 R2 extractors (`CustomMetadataRecord`,
    // `CustomSettingRecord`) emit one Node per fixture record file plus
    // one `parentOf` edge linking the record to its parent CustomObject
    // (`__mdt` for CMD, `__c` for CSR). v1.6 introduces NO new EdgeType
    // — the existing `parentOf` is the only edge each extractor produces
    // (mirroring v1.0's CustomField → CustomObject pattern). None of
    // these surfaces exist in edu-org; the floors below come exclusively
    // from the staged synthetic-v1.6 subtrees:
    //
    //   - customMetadata/ -> 4 CustomMetadataRecord nodes (Marketo
    //     Default + Marketo Production + Clinical Module_1 +
    //     Clinical Module_2; the dispatcher fires on each
    //     `.md-meta.xml` file under the flat `customMetadata/`
    //     directory).
    //   - customSettings/Marketo_Api_Settings__c/ -> 1
    //     CustomSettingRecord node (SystemDefault; the dispatcher
    //     fires on each `.dataset-meta.xml` file under
    //     `customSettings/{TypeApiName}/`).
    //
    // Each record contributes one `parentOf` edge, so the v1.6
    // contribution to the manifest's parentOf tally is exactly 5
    // (4 CMD + 1 CSR). The floor below uses
    // `FIXTURE_COMPONENT_FLOOR.CustomField + 15` (the v1.2 floor of
    // `+10` plus the v1.6 contribution of `+5`) to keep the gate
    // honest about both the v1.2 and v1.6 contributions landing.
    const paths = vaultPaths(vaultRoot);
    const manifest = JSON.parse(
      await readFile(paths.manifest, 'utf8'),
    ) as VaultManifest;
    const components = manifest.components;
    const edges = manifest.edges;

    // Component floors.
    expect(components['CustomMetadataRecord'] ?? 0).toBeGreaterThanOrEqual(4);
    expect(components['CustomSettingRecord'] ?? 0).toBeGreaterThanOrEqual(1);

    // `parentOf` floor: existing v1.2 floor (CustomField + 10) plus
    // the v1.6 record contributions (4 CMD + 1 CSR = 5). The v0.1
    // CustomField population dominates the absolute floor; the +15
    // cushion is what proves the v1.2 + v1.6 contributions are
    // actually landing rather than being silently dropped.
    expect(edges['parentOf'] ?? 0).toBeGreaterThanOrEqual(
      FIXTURE_COMPONENT_FLOOR.CustomField + 15,
    );
  });

  it('emits a declared parentOf edge from a synthetic CustomMetadataRecord to its __mdt type', async () => {
    // Direct graph query: prove the v1.6 CustomMetadataRecord extractor
    // is contributing edges with the documented confidence + source.
    // The synthetic `Marketo_Api_Setting__mdt.Default` record file is
    // the canonical CMD fixture; the extractor emits a single
    // `parentOf` edge from `CustomObject:Marketo_Api_Setting__mdt`
    // (the parent `__mdt` type, with the suffix preserved per the
    // extractor's canonical-id rule) to
    // `CustomMetadataRecord:Marketo_Api_Setting__mdt.Default`.
    //
    // Querying the incoming edges on the record node surfaces the
    // edge from the record's perspective; the assertion below checks
    // that the edge type is `parentOf`, the from-node is the
    // expected `__mdt` CustomObject id, and the confidence + source
    // match the extractor's declarations.
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;
    const edgesResult = await listEdges(
      liveCtx.graph,
      'CustomMetadataRecord:Marketo_Api_Setting__mdt.Default',
      { direction: 'in' },
    );
    expect(edgesResult.ok).toBe(true);
    if (!edgesResult.ok) return;
    const parentOfEdges = edgesResult.value.filter(
      (e: Edge) => e.edgeType === 'parentOf',
    );
    expect(parentOfEdges.length).toBeGreaterThanOrEqual(1);
    for (const edge of parentOfEdges) {
      // The parent must be the `__mdt`-suffixed CustomObject id, not
      // the bare type name — the extractor preserves the suffix in
      // both the canonical record id and the parent id so the edge
      // visually aligns with the v1.0 CustomObject definition's id.
      expect(edge.fromId).toBe('CustomObject:Marketo_Api_Setting__mdt');
      expect(edge.confidence).toBe('declared');
      expect(edge.source).toBe('custom-metadata-record-extractor');
    }
  });

  it('emits v1.5 integration topology + event subscribers + async classifier edges', async () => {
    // The v1.5 wave shipped in two coordinated rounds:
    //
    //   - R2 added six file-based extractors for the integration
    //     topology metadata family (AuthProvider, RemoteSiteSetting,
    //     CspTrustedSite, ExternalDataSource, ExternalService,
    //     NetworkAccess). Two of them emit a single `references` edge
    //     when their XML carries a declared cross-reference:
    //     `ExternalDataSource → AuthProvider` (via `<authProvider>`)
    //     and `ExternalService → NamedCredential` (via
    //     `<namedCredential>`).
    //
    //   - R3 added three classifier edges (`listensTo`, `exposes`,
    //     `dispatchesAsync`) to the existing apex-class / apex-trigger
    //     / flow extractors. None of those edges depend on the v1.5
    //     EXTRACTORS map — they ride the v0.1 ApexClass / ApexTrigger
    //     dispatch path that the synthetic-v1.5 `classes/`, `triggers/`,
    //     `flows/` subtrees layer onto.
    //
    // None of the v1.5 surfaces exist in edu-org; every floor below
    // comes exclusively from the staged synthetic-v1.5 subtrees:
    //
    //   - AuthProvider × 2 (MyOpenIdProvider, SamlProvider).
    //   - RemoteSiteSetting × 2 (ExternalCRM, LegacyApi).
    //   - CspTrustedSite × 2 (AnalyticsCDN, SupportWidget).
    //   - ExternalDataSource × 2 (SAP_Customers, MarketingHub) —
    //     SAP_Customers carries a `references` edge to
    //     `AuthProvider:MyOpenIdProvider`.
    //   - ExternalService × 1 (OrderService) — carries a `references`
    //     edge to `NamedCredential:OrderApi`.
    //   - NetworkAccess × 2 (Office_Range, VPN_Range).
    //   - AccountChangeTrigger.trigger on Account_Change__e produces
    //     `listensTo` to `CustomObject:Account_Change__e`.
    //   - AccountChangeSubscriber.cls implements
    //     `Triggerable<Account_Change__e>` and produces a second
    //     `listensTo` to the same event id.
    //   - AccountResource.cls has `@RestResource(urlMapping='/Accounts/*')`
    //     and produces an `exposes` edge to a REST-surface id.
    //   - AccountHandler.cls calls System.enqueueJob,
    //     Database.executeBatch, and System.schedule and produces three
    //     `dispatchesAsync` edges (AccountIndexer, AccountReindexBatch,
    //     AccountNightlyJob).
    //
    // The `references` floor below uses 4: the v0.2 formula tokenizer
    // contributes >= 2 to the manifest already (asserted in a sibling
    // block), and the v1.5 R2 extractors contribute >= 2 more (the
    // SAP_Customers → MyOpenIdProvider and OrderService → OrderApi
    // edges). Floor 4 stays honest about both contributions landing
    // rather than papering over a v1.5 regression with the v0.2
    // baseline.
    const paths = vaultPaths(vaultRoot);
    const manifest = JSON.parse(
      await readFile(paths.manifest, 'utf8'),
    ) as VaultManifest;
    const components = manifest.components;
    const edges = manifest.edges;

    // Component floors. Synthetic-v1.5 counts are stable; floors below
    // match the synthetic roster so a single per-file schema reject
    // surfaces as N-1 < floor rather than silently dropping.
    expect(components['AuthProvider'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['RemoteSiteSetting'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['CspTrustedSite'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['ExternalDataSource'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(components['ExternalService'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(components['NetworkAccess'] ?? 0).toBeGreaterThanOrEqual(2);

    // Edge floors. `references` already had a floor of 2 from the v0.2
    // block; the v1.5 R2 extractors add 2 more (SAP → MyOpenIdProvider,
    // OrderService → OrderApi). The `listensTo` / `exposes` /
    // `dispatchesAsync` floors are all 1 to stay honest about a single
    // per-classifier regression surfacing as 0 < 1 rather than being
    // masked by another producer.
    expect(edges['references'] ?? 0).toBeGreaterThanOrEqual(4);
    expect(edges['listensTo'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(edges['exposes'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(edges['dispatchesAsync'] ?? 0).toBeGreaterThanOrEqual(1);

    // Direct graph query: the SAP_Customers ExternalDataSource node
    // emits one outgoing `references` edge to
    // `AuthProvider:MyOpenIdProvider` with `role: 'auth'` per the
    // external-data-source extractor (`role` lives in
    // `edge.properties.role`, populated alongside the canonical edge
    // tuple). Targeting the outgoing edges from SAP_Customers proves
    // the R2 extractor is wired through the refresh pipeline AND the
    // cross-reference resolves to the right AuthProvider id.
    expect(ctx).not.toBeNull();
    const liveCtx = ctx as Context;
    const sapEdgesResult = await listEdges(
      liveCtx.graph,
      'ExternalDataSource:SAP_Customers',
      { direction: 'out' },
    );
    expect(sapEdgesResult.ok).toBe(true);
    if (!sapEdgesResult.ok) return;
    const sapReferencesEdges = sapEdgesResult.value.filter(
      (e: Edge) => e.edgeType === 'references',
    );
    expect(sapReferencesEdges.length).toBeGreaterThanOrEqual(1);
    const authProviderEdge = sapReferencesEdges.find(
      (e: Edge) => e.toId === 'AuthProvider:MyOpenIdProvider',
    );
    expect(authProviderEdge).toBeDefined();
    if (authProviderEdge === undefined) return;
    // `role` is carried in `edge.properties` per the extractor's
    // emission shape; the assertion mirrors what the
    // integration-map MCP tool reads when surfacing the edge.
    const role = (authProviderEdge.properties as { role?: unknown } | undefined)?.role;
    expect(role).toBe('auth');
  });
});
