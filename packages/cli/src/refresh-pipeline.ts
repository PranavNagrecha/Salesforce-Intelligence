import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

import type {
  ComponentType,
  Edge,
  EdgeType,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import {
  extractApexClass,
  extractApexTrigger,
  extractApprovalProcess,
  extractAssignmentRule,
  extractAuraDefinitionBundle,
  extractAuthProvider,
  extractAutoResponseRule,
  extractBot,
  extractBotVersion,
  extractBusinessProcess,
  extractCertificate,
  extractCompactLayout,
  extractConnectedApp,
  extractCspTrustedSite,
  extractCustomApplication,
  extractCustomField,
  extractCustomIndex,
  extractCustomLabel,
  extractCustomMetadataRecord,
  extractCustomObject,
  extractCustomPermission,
  extractCustomSettingRecord,
  extractCustomSite,
  extractCustomTab,
  extractDecisionTable,
  extractDashboard,
  extractDuplicateRule,
  extractEmailTemplate,
  extractEntitlementProcess,
  extractEscalationRule,
  extractExperienceBundle,
  extractFlexiPage,
  extractExternalDataSource,
  extractExternalService,
  extractFieldServiceSettings,
  extractFieldSet,
  extractFlow,
  extractGenAiFunction,
  extractGenAiPlannerBundle,
  extractGenAiPlugin,
  extractGenAiPromptTemplate,
  extractGlobalValueSet,
  extractGroup,
  extractInstalledPackage,
  extractLayout,
  extractLetterhead,
  extractLightningComponentBundle,
  extractListView,
  extractMatchingRule,
  extractMilestoneType,
  extractMutingPermissionSet,
  extractNamedCredential,
  extractNetwork,
  extractNetworkAccess,
  extractOmniDataTransform,
  extractOmniIntegrationProcedure,
  extractOmniScript,
  extractOmniUiCard,
  extractPathAssistant,
  extractPermissionSetGroup,
  extractPermissionSet,
  extractPresenceUserConfig,
  extractPlatformEventChannel,
  extractPlatformEventChannelMember,
  extractProfile,
  extractQueue,
  extractQueueRoutingConfig,
  extractQuickAction,
  extractRecordType,
  extractReport,
  extractReportType,
  extractRemoteSiteSetting,
  extractRestrictionRule,
  extractRole,
  extractSamlSsoConfig,
  extractScopingRule,
  extractServiceChannel,
  extractSessionSettings,
  extractSharingRules,
  extractSharingSet,
  extractSkill,
  extractStandardValueSet,
  extractStaticResource,
  extractTimeSheetTemplate,
  extractTransactionSecurityPolicy,
  extractValidationRule,
  extractVisualforceComponent,
  extractVisualforcePage,
  extractWaveDashboard,
  extractWaveDataflow,
  extractWaveXmd,
  extractWebLink,
  extractWorkflowRule,
  UNRESOLVED_PROFILE_PREFIX,
} from '@sf-intelligence/extractors';
import {
  listEdgesForNodes,
  listNodesByType,
  type GraphStore,
} from '@sf-intelligence/graph';
import {
  renderApexMarkdown,
  renderComponentMarkdown,
  renderFlowMarkdown,
  renderVaultIndex,
  serializeFrontmatter,
} from '@sf-intelligence/renderers';
import { componentPath } from '@sf-intelligence/vault';

/**
 * Per-file error captured by the refresh pipeline. The `path` is the
 * absolute path of the source file the extractor rejected; the embedded
 * `error` is whatever the extractor itself returned.
 */
export interface RefreshExtractionFailure {
  readonly path: string;
  readonly error: ExtractorError;
}

/**
 * Outcome of the walk-and-extract phase. `results` holds the successful
 * `ExtractionResult` per file; `failures` holds the per-file extractor
 * errors that were captured without aborting the pipeline.
 *
 * `skippedDirectories` records every unknown directory the dispatcher
 * refused to route a file into — the architectural-bug fix for the
 * silent-skip class. Keys are the closest known directory basename in
 * the path (the *first* path segment that participates in dispatch,
 * working back from the file); values are the count of files skipped
 * under that name. An empty map means every walked file matched a
 * supported `ComponentType`. A non-empty map flags that the retrieve
 * pulled metadata types this build doesn't yet cover; coverage is
 * incomplete and the user must be warned.
 */
export interface WalkResult {
  readonly results: readonly ExtractionResult[];
  readonly failures: readonly RefreshExtractionFailure[];
  readonly skippedDirectories: Readonly<Record<string, number>>;
  /**
   * P5-incremental-refresh: the per-file extraction cache to persist for the
   * NEXT refresh — one entry per successfully-extracted file, keyed by its
   * source-relative path. Populated for every walk; the caller decides whether
   * to persist it (only the `--incremental` path does).
   */
  readonly cache: ExtractCache;
  /** How many files reused a cached result instead of re-extracting. */
  readonly reusedCount: number;
}

/**
 * One cached file extraction (P5-incremental-refresh). Keyed by source-relative
 * path; reused when the file's `mtimeMs` AND `size` are unchanged. The graph is
 * still FULLY rebuilt from `results` every refresh, so a reused entry can never
 * leave the graph inconsistent — caching only skips the (expensive) per-file
 * parse, never the (cheap, correctness-critical) import/render.
 */
export interface ExtractCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly result: ExtractionResult;
}

/** Per-file extraction cache, keyed by source-relative path. */
export type ExtractCache = Map<string, ExtractCacheEntry>;

/**
 * Cache-format version (P5-incremental-refresh). Bumped when the extractor
 * graph changes shape so an on-disk cache from an older build is ignored. The
 * cache is ALSO keyed by the package version on disk, so a normal upgrade
 * invalidates it; this constant covers SAME-VERSION extractor changes, which
 * is exactly the case below.
 *
 * 1 -> 2 (REPORT-DASHBOARD-GRAPH-PERSISTENCE). The Report/Dashboard extractor
 * output changed shape three ways: node ids went from the bare
 * `Report:{DeveloperName}` to `Report:{LeafFolder}/{DeveloperName}`, the
 * freeform `description` property was replaced by a `descriptionPresent`
 * boolean, and new properties + `references` edges (source object / report
 * type / dashboard component report) were added.
 *
 * The package-version key does NOT cover this: the version is `0.3.0` on this
 * branch AND on the published release, so a user already on 0.3.0 would reuse
 * a cache whose Report entries still hold bare-name ids — silently
 * reinstating the very id collision the leaf-folder qualification exists to
 * prevent, and resurrecting cached `description` TEXT the redaction removed.
 * A cached-stale entry is not a stale answer here; it is a WRONG-shaped node
 * and a privacy regression. Hence the bump.
 */
export const EXTRACT_CACHE_VERSION = 2;

/** Counts of node types and edge types seen during a render pass. */
export interface RenderCounts {
  readonly components: Partial<Record<ComponentType, number>>;
  readonly edges: Partial<Record<EdgeType, number>>;
}

type Extractor = (path: string) => Promise<Result<ExtractionResult, ExtractorError>>;

/**
 * The metadata types the refresh pipeline understands. The v0.1 roster
 * (the nine `tests/fixtures/edu-org/package.xml` types) plus the v1.1
 * sharing & visibility tier (`Group`, `Queue`, `Role`, `SharingRule`)
 * plus the v1.2 record-types + UI-surfaces tier (`BusinessProcess`,
 * `CustomApplication`, `CustomLabel`, `CustomTab`, `GlobalValueSet`,
 * `PathAssistant`, `QuickAction`, `RecordType`, `StaticResource`) plus
 * the v1.3 legacy-automation + communications tier (`ApprovalProcess`,
 * `AssignmentRule`, `AutoResponseRule`, `DuplicateRule`, `EmailTemplate`,
 * `EscalationRule`, `Letterhead`, `MatchingRule`, `WorkflowRule`) plus
 * the v1.4 frontend code tier (`AuraDefinitionBundle`,
 * `LightningComponentBundle`, `VisualforceComponent`,
 * `VisualforcePage`) plus the v1.5 integration topology tier
 * (`AuthProvider`, `CspTrustedSite`, `ExternalDataSource`,
 * `ExternalService`, `NetworkAccess`, `RemoteSiteSetting` — each is a
 * file-based extractor surfaced by a top-level Salesforce DX directory;
 * `ExternalDataSource` carries a `references` edge to its declared
 * `AuthProvider` and `ExternalService` carries a `references` edge to
 * its declared `NamedCredential`, the other four produce zero outgoing
 * edges) plus the v1.6 business-user record-value tier
 * (`CustomMetadataRecord`, `CustomSettingRecord` — each carries a single
 * record's configured values and attaches to its parent `CustomObject`
 * via the existing `parentOf` edge; no new EdgeType is introduced) plus
 * the R6-17 Experience Cloud community tier (`Network`, `CustomSite`,
 * `ExperienceBundle` — the community definition, its site container, and
 * the Builder bundle's top-level meta; `Network` emits DECLARED
 * `references` to its site + bundle, `CustomSite` emits a HEURISTIC
 * `references` to its convention-named guest profile, and the bundle's
 * JSON page tree is out of scope by design) plus the Experience Cloud /
 * portal record-access singleton (`SharingSet` — `sharingSets/`, the
 * user-field-to-record-field matching that grants portal users records
 * without a sharing rule; emits `sharedWith` to each mapped object and
 * `grantedBy` from each granted profile, no new EdgeType).
 *
 * Directories that don't exist under `source/` are skipped cleanly by
 * `walkDir`'s readdir try/catch — orgs without the v1.1 / v1.2 / v1.3 /
 * v1.4 / v1.5 / v1.6 / R6-17 directories (the edu-org fixture has no v1.1
 * sharing tree, for instance) produce zero nodes of those types without
 * surfacing as failures.
 */
export const SUPPORTED_TYPES = [
  'ApexClass',
  'ApexTrigger',
  'ApprovalProcess',
  'AssignmentRule',
  'AuraDefinitionBundle',
  'AuthProvider',
  'AutoResponseRule',
  'Bot',
  'BotVersion',
  'BusinessProcess',
  'Certificate',
  'CompactLayout',
  'ConnectedApp',
  'CspTrustedSite',
  'CustomApplication',
  'CustomField',
  'CustomLabel',
  'CustomMetadataRecord',
  'CustomObject',
  'CustomPermission',
  'CustomSettingRecord',
  'CustomSite',
  'CustomTab',
  'DecisionTable',
  'Dashboard',
  'DuplicateRule',
  'EmailTemplate',
  'EntitlementProcess',
  'EscalationRule',
  'ExperienceBundle',
  'ExternalDataSource',
  'ExternalService',
  'FieldServiceSettings',
  'FieldSet',
  'FlexiPage',
  'Flow',
  'GenAiFunction',
  'GenAiPlannerBundle',
  'GenAiPlugin',
  'GenAiPromptTemplate',
  'GlobalValueSet',
  'Group',
  'Index',
  'InstalledPackage',
  'Layout',
  'Letterhead',
  'LightningComponentBundle',
  'ListView',
  'MatchingRule',
  'MilestoneType',
  'MutingPermissionSet',
  'NamedCredential',
  'Network',
  'NetworkAccess',
  'OmniDataTransform',
  'OmniIntegrationProcedure',
  'OmniScript',
  'OmniUiCard',
  'PathAssistant',
  'PermissionSet',
  'PermissionSetGroup',
  'PlatformEventChannel',
  'PlatformEventChannelMember',
  'PresenceUserConfig',
  'Profile',
  'Queue',
  'QueueRoutingConfig',
  'QuickAction',
  'RecordType',
  'RemoteSiteSetting',
  'Report',
  'ReportType',
  'RestrictionRule',
  'Role',
  'SamlSsoConfig',
  'ScopingRule',
  'ServiceChannel',
  'SessionSettings',
  'SharingRule',
  'SharingSet',
  'Skill',
  'StandardValueSet',
  'StaticResource',
  'TimeSheetTemplate',
  'TransactionSecurityPolicy',
  'ValidationRule',
  'VisualforceComponent',
  'VisualforcePage',
  'WaveDashboard',
  'WaveDataflow',
  'WaveXmd',
  'WebLink',
  'WorkflowRule',
] as const satisfies readonly ComponentType[];

type SupportedType = (typeof SUPPORTED_TYPES)[number];

/**
 * Lookup from supported type to its extractor function.
 *
 * The v1.4 frontend tier mixes file-based extractors
 * (`VisualforcePage`, `VisualforceComponent` — each takes the path to
 * the `.page` / `.component` markup file and reads the `-meta.xml`
 * sibling itself) with directory-based extractors
 * (`LightningComponentBundle`, `AuraDefinitionBundle` — each takes the
 * path to the bundle **directory**, deriving the bundle's API name
 * from the directory basename and reading the bundle's child files).
 * The two shapes share the same `(path) => Promise<Result<...>>`
 * signature, so they can sit in the same map; the dispatcher is what
 * decides whether to pass a file path or a directory path. See
 * `walkAndExtract` for that branch.
 */
const EXTRACTORS: Readonly<Record<SupportedType, Extractor>> = {
  ApexClass: extractApexClass,
  ApexTrigger: extractApexTrigger,
  ApprovalProcess: extractApprovalProcess,
  AssignmentRule: extractAssignmentRule,
  AuraDefinitionBundle: extractAuraDefinitionBundle,
  AuthProvider: extractAuthProvider,
  AutoResponseRule: extractAutoResponseRule,
  Bot: extractBot,
  BotVersion: extractBotVersion,
  BusinessProcess: extractBusinessProcess,
  Certificate: extractCertificate,
  CompactLayout: extractCompactLayout,
  ConnectedApp: extractConnectedApp,
  CspTrustedSite: extractCspTrustedSite,
  CustomApplication: extractCustomApplication,
  CustomField: extractCustomField,
  CustomLabel: extractCustomLabel,
  CustomMetadataRecord: extractCustomMetadataRecord,
  CustomObject: extractCustomObject,
  CustomPermission: extractCustomPermission,
  CustomSettingRecord: extractCustomSettingRecord,
  CustomSite: extractCustomSite,
  CustomTab: extractCustomTab,
  DecisionTable: extractDecisionTable,
  Dashboard: extractDashboard,
  DuplicateRule: extractDuplicateRule,
  EmailTemplate: extractEmailTemplate,
  EntitlementProcess: extractEntitlementProcess,
  EscalationRule: extractEscalationRule,
  ExperienceBundle: extractExperienceBundle,
  ExternalDataSource: extractExternalDataSource,
  ExternalService: extractExternalService,
  FieldServiceSettings: extractFieldServiceSettings,
  FieldSet: extractFieldSet,
  FlexiPage: extractFlexiPage,
  Flow: extractFlow,
  GenAiFunction: extractGenAiFunction,
  GenAiPlannerBundle: extractGenAiPlannerBundle,
  GenAiPlugin: extractGenAiPlugin,
  GenAiPromptTemplate: extractGenAiPromptTemplate,
  GlobalValueSet: extractGlobalValueSet,
  Group: extractGroup,
  Index: extractCustomIndex,
  InstalledPackage: extractInstalledPackage,
  Layout: extractLayout,
  Letterhead: extractLetterhead,
  LightningComponentBundle: extractLightningComponentBundle,
  ListView: extractListView,
  MatchingRule: extractMatchingRule,
  MilestoneType: extractMilestoneType,
  MutingPermissionSet: extractMutingPermissionSet,
  NamedCredential: extractNamedCredential,
  Network: extractNetwork,
  NetworkAccess: extractNetworkAccess,
  OmniDataTransform: extractOmniDataTransform,
  OmniIntegrationProcedure: extractOmniIntegrationProcedure,
  OmniScript: extractOmniScript,
  OmniUiCard: extractOmniUiCard,
  PathAssistant: extractPathAssistant,
  PermissionSet: extractPermissionSet,
  PermissionSetGroup: extractPermissionSetGroup,
  PlatformEventChannel: extractPlatformEventChannel,
  PlatformEventChannelMember: extractPlatformEventChannelMember,
  PresenceUserConfig: extractPresenceUserConfig,
  Profile: extractProfile,
  Queue: extractQueue,
  QueueRoutingConfig: extractQueueRoutingConfig,
  QuickAction: extractQuickAction,
  RecordType: extractRecordType,
  Report: extractReport,
  ReportType: extractReportType,
  RemoteSiteSetting: extractRemoteSiteSetting,
  RestrictionRule: extractRestrictionRule,
  Role: extractRole,
  SamlSsoConfig: extractSamlSsoConfig,
  ScopingRule: extractScopingRule,
  ServiceChannel: extractServiceChannel,
  SessionSettings: extractSessionSettings,
  SharingRule: extractSharingRules,
  SharingSet: extractSharingSet,
  Skill: extractSkill,
  StandardValueSet: extractStandardValueSet,
  StaticResource: extractStaticResource,
  TimeSheetTemplate: extractTimeSheetTemplate,
  TransactionSecurityPolicy: extractTransactionSecurityPolicy,
  ValidationRule: extractValidationRule,
  VisualforceComponent: extractVisualforceComponent,
  VisualforcePage: extractVisualforcePage,
  WaveDashboard: extractWaveDashboard,
  WaveDataflow: extractWaveDataflow,
  WaveXmd: extractWaveXmd,
  WebLink: extractWebLink,
  WorkflowRule: extractWorkflowRule,
};

/**
 * Dispatch a source path to the right metadata type based on its
 * directory path and file name. Returns `null` when no supported
 * metadata type matches. Most-specific matchers (nested `fields/`,
 * `validationRules/`, `recordTypes/`, `businessProcesses/`,
 * object-nested `quickActions/`) are tested before the parent
 * `objects/` matcher.
 *
 * v1.1 adds the sharing & visibility tier (`roles/`, `groups/`,
 * `queues/`, `sharingRules/`); the `SharingRules` Salesforce metadata
 * type maps to the `SharingRule` ComponentType (singular, per the
 * contracts union).
 *
 * v1.2 adds the record-types + UI-surfaces tier:
 *   - Nested under `objects/{Obj}/`: `recordTypes/`,
 *     `businessProcesses/`, and `quickActions/` (DX-nested QuickActions
 *     live alongside their parent CustomObject).
 *   - Top-level: `tabs/` (CustomTab), `applications/` (CustomApplication),
 *     `quickActions/` (Global QuickActions), `pathAssistants/`,
 *     `globalValueSets/`, `labels/` (CustomLabels — the file is literally
 *     `CustomLabels.labels-meta.xml`, one per project), and
 *     `staticresources/` (the `.resource-meta.xml` sidecar; the binary
 *     payload itself is not extracted).
 *
 * v1.3 adds the legacy-automation + communications tier (all top-level
 * Salesforce DX directories):
 *   - `workflows/` -> `WorkflowRule` (file suffix `.workflow-meta.xml`,
 *     one file per parent SObject; each file is fanned out into one
 *     WorkflowRule node per `<rules>` entry by the extractor).
 *   - `approvalProcesses/` -> `ApprovalProcess` (one file per process,
 *     suffix `.approvalProcess-meta.xml`).
 *   - `assignmentRules/` -> `AssignmentRule` (file suffix
 *     `.assignmentRules-meta.xml`, one file per parent SObject; fanned
 *     out per `<assignmentRule>` entry by the extractor).
 *   - `autoResponseRules/` -> `AutoResponseRule` (file suffix
 *     `.autoResponseRules-meta.xml`, same per-SObject fan-out shape).
 *   - `escalationRules/` -> `EscalationRule` (file suffix
 *     `.escalationRules-meta.xml`, Case-only in practice).
 *   - `duplicateRules/` -> `DuplicateRule` (one file per rule, suffix
 *     `.duplicateRule-meta.xml`).
 *   - `matchingRules/` -> `MatchingRule` (file suffix
 *     `.matchingRule-meta.xml`, fanned out per `<matchingRules>` entry).
 *   - `email/` -> `EmailTemplate` (suffix `.email-meta.xml`; templates
 *     live in folder subdirectories under `email/{Folder}/`).
 *   - `letterhead/` -> `Letterhead` (suffix `.letter-meta.xml`).
 *
 * v1.4 adds the frontend code tier, which mixes file-based and
 * directory-based shapes:
 *   - `pages/` -> `VisualforcePage` (file suffix `.page`, not
 *     `.page-meta.xml`; the extractor reads the companion meta-xml
 *     sibling itself, so the dispatcher must only fire on the markup
 *     file).
 *   - `components/` -> `VisualforceComponent` (file suffix
 *     `.component`, not `.component-meta.xml`; same companion-pattern
 *     as VisualforcePage).
 *   - `lwc/{bundleName}/` -> `LightningComponentBundle` — the unit of
 *     dispatch is the *bundle directory*, not any single file inside
 *     it. `walkAndExtract` recognises bundle dirs and emits them as
 *     paths flagged `isDirectory=true`; the dispatcher then returns
 *     `LightningComponentBundle`, and the extractor is invoked with
 *     the directory path. The dispatcher must NOT also fire on the
 *     bundle's child files (`.js`, `.html`, `.js-meta.xml`) — the
 *     walker's bundle-detection branch skips recursion into the
 *     bundle dir for exactly that reason.
 *   - `aura/{bundleName}/` -> `AuraDefinitionBundle` — same
 *     directory-as-unit pattern as LWC. The aura extractor accepts
 *     any of the markup variants (`.cmp` / `.app` / `.evt` /
 *     `.intf` / `.tokens`) inside the bundle.
 *
 * v1.5 adds the integration topology + event/async/API surface tier.
 * All six v1.5 metadata types are file-based and live at the DX top
 * level — none nest under `objects/` and none share a directory with a
 * v0.1-v1.4 metadata type, so the dispatch rules are flat suffix
 * matches against a single segment:
 *   - `authproviders/` -> `AuthProvider` (file suffix
 *     `.authprovider-meta.xml`; one SSO / OAuth provider per file).
 *   - `remoteSiteSettings/` -> `RemoteSiteSetting` (file suffix
 *     `.remoteSite-meta.xml`; one allowed outbound URL per file).
 *   - `cspTrustedSites/` -> `CspTrustedSite` (file suffix
 *     `.cspTrustedSite-meta.xml`; one CSP allowlist entry per file).
 *   - `dataSources/` -> `ExternalDataSource` (file suffix
 *     `.dataSource-meta.xml`; one Salesforce-Connect binding per file;
 *     carries a declared `references` edge to its `<authProvider>`).
 *   - `externalServiceRegistrations/` -> `ExternalService` (file suffix
 *     `.externalServiceRegistration-meta.xml`; one OpenAPI binding per
 *     file; carries a declared `references` edge to its
 *     `<namedCredential>`).
 *   - `networkAccesses/` -> `NetworkAccess` (file suffix
 *     `.networkAccess-meta.xml`; one IP-range trust-list entry per file).
 *
 * v1.6 adds the business-user record-value tier (file-based, no new
 * EdgeType — both attach via the existing `parentOf` edge to their
 * CustomObject parent):
 *   - `customMetadata/` -> `CustomMetadataRecord` (file suffix
 *     `.md-meta.xml`; filename shape `{TypeApiName}.{RecordName}.md-meta.xml`
 *     — the extractor splits the basename on the first dot to derive the
 *     parent `__mdt` type and the record's DeveloperName).
 *   - `customSettings/{TypeApiName}/` -> `CustomSettingRecord` (file
 *     suffix `.dataset-meta.xml`; CustomSetting records are rarely
 *     present in DX source — they typically live as data and require
 *     `sf data query` — so this dispatch handles the per-record XML
 *     shape when it IS present, with the parent `__c` type derived
 *     from the immediate parent directory name).
 *
 * `isDirectory` distinguishes the two shapes: only the bundle
 * dispatch branches consult it. File-shaped types ignore it.
 */
const dispatchFile = (
  segments: readonly string[],
  fileName: string,
  isDirectory: boolean,
): SupportedType | null => {
  // v1.4 bundle directories. The unit of dispatch is the bundle dir
  // itself; `fileName` here is the bundle's basename (the LWC / Aura
  // API name). Short-circuit before the file-based dispatch matrix
  // because bundles can't match any file suffix.
  if (isDirectory) {
    const parentDir = segments[segments.length - 1];
    if (parentDir === 'lwc') return 'LightningComponentBundle';
    if (parentDir === 'aura') return 'AuraDefinitionBundle';
    return null;
  }
  if (segments.includes('objects')) {
    if (segments.includes('fields') && fileName.endsWith('.field-meta.xml')) return 'CustomField';
    if (segments.includes('validationRules') && fileName.endsWith('.validationRule-meta.xml')) return 'ValidationRule';
    if (segments.includes('recordTypes') && fileName.endsWith('.recordType-meta.xml')) return 'RecordType';
    if (segments.includes('businessProcesses') && fileName.endsWith('.businessProcess-meta.xml')) return 'BusinessProcess';
    if (segments.includes('quickActions') && fileName.endsWith('.quickAction-meta.xml')) return 'QuickAction';
    if (segments.includes('listViews') && fileName.endsWith('.listView-meta.xml')) return 'ListView';
    if (segments.includes('compactLayouts') && fileName.endsWith('.compactLayout-meta.xml')) return 'CompactLayout';
    if (segments.includes('fieldSets') && fileName.endsWith('.fieldSet-meta.xml')) return 'FieldSet';
    if (segments.includes('webLinks') && fileName.endsWith('.webLink-meta.xml')) return 'WebLink';
    if (segments.includes('indexes') && fileName.endsWith('.index-meta.xml')) return 'Index';
    if (fileName.endsWith('.object-meta.xml')) return 'CustomObject';
    return null;
  }
  if (segments.includes('flows') && fileName.endsWith('.flow-meta.xml')) return 'Flow';
  if (segments.includes('classes') && fileName.endsWith('.cls') && !fileName.endsWith('.cls-meta.xml')) return 'ApexClass';
  if (segments.includes('triggers') && fileName.endsWith('.trigger') && !fileName.endsWith('.trigger-meta.xml')) return 'ApexTrigger';
  if (segments.includes('layouts') && fileName.endsWith('.layout-meta.xml')) return 'Layout';
  if (segments.includes('permissionsets') && fileName.endsWith('.permissionset-meta.xml')) return 'PermissionSet';
  if (segments.includes('profiles') && fileName.endsWith('.profile-meta.xml')) return 'Profile';
  if (segments.includes('reports') && fileName.endsWith('.report-meta.xml')) return 'Report';
  if (segments.includes('dashboards') && fileName.endsWith('.dashboard-meta.xml')) return 'Dashboard';
  if (segments.includes('reportTypes') && fileName.endsWith('.reportType-meta.xml')) return 'ReportType';
  if (segments.includes('flexipages') && fileName.endsWith('.flexipage-meta.xml')) return 'FlexiPage';
  // RestrictionRule / ScopingRule are TOP-LEVEL (`restrictionRules/{Name}.rule-meta.xml`,
  // `scopingRules/{Name}.rule-meta.xml`) — NOT nested under `objects/`, so they belong
  // here in the top-level dispatch, not inside the objects block above.
  if (segments.includes('restrictionRules') && fileName.endsWith('.rule-meta.xml')) return 'RestrictionRule';
  if (segments.includes('scopingRules') && fileName.endsWith('.rule-meta.xml')) return 'ScopingRule';
  if (segments.includes('permissionsetgroups') && fileName.endsWith('.permissionsetgroup-meta.xml')) return 'PermissionSetGroup';
  if (segments.includes('mutingpermissionsets') && fileName.endsWith('.mutingpermissionset-meta.xml')) return 'MutingPermissionSet';
  if (segments.includes('roles') && fileName.endsWith('.role-meta.xml')) return 'Role';
  if (segments.includes('groups') && fileName.endsWith('.group-meta.xml')) return 'Group';
  if (segments.includes('queues') && fileName.endsWith('.queue-meta.xml')) return 'Queue';
  if (segments.includes('sharingRules') && fileName.endsWith('.sharingRules-meta.xml')) return 'SharingRule';
  // Experience Cloud / portal record-access tier. `SharingSet` is a FLAT
  // top-level dispatch under its own `sharingSets/` directory — it does NOT
  // share the `sharingRules/` folder above, and `.sharingSet-meta.xml` never
  // satisfies `.sharingRules-meta.xml`'s `endsWith` check, so the two are
  // mutually exclusive and the order between them is immaterial. Folder +
  // suffix follow the Metadata API's directoryName/suffix convention for the
  // type; no SharingSet metadata was present in any vault reachable when this
  // shipped, so this pairing is documentation-derived, NOT confirmed against a
  // real retrieve — worth re-verifying on the first org that has one.
  if (segments.includes('sharingSets') && fileName.endsWith('.sharingSet-meta.xml')) return 'SharingSet';
  if (segments.includes('tabs') && fileName.endsWith('.tab-meta.xml')) return 'CustomTab';
  if (segments.includes('applications') && fileName.endsWith('.app-meta.xml')) return 'CustomApplication';
  if (segments.includes('quickActions') && fileName.endsWith('.quickAction-meta.xml')) return 'QuickAction';
  if (segments.includes('pathAssistants') && fileName.endsWith('.pathAssistant-meta.xml')) return 'PathAssistant';
  if (segments.includes('globalValueSets') && fileName.endsWith('.globalValueSet-meta.xml')) return 'GlobalValueSet';
  if (segments.includes('labels') && fileName.endsWith('.labels-meta.xml')) return 'CustomLabel';
  if (segments.includes('staticresources') && fileName.endsWith('.resource-meta.xml')) return 'StaticResource';
  if (segments.includes('installedPackages') && fileName.endsWith('.installedPackage-meta.xml')) return 'InstalledPackage';
  // CR-CAP-15: CustomPermission definitions live flat under
  // `customPermissions/{DeveloperName}.customPermission-meta.xml` — the grant
  // target a PermissionSet/Profile `<customPermissions>` block names (CR-CAP-10).
  if (segments.includes('customPermissions') && fileName.endsWith('.customPermission-meta.xml')) return 'CustomPermission';
  // Session-security tier. Salesforce delivers SessionSettings under the
  // generic `settings/` container (shared by every `*Settings` metadata
  // type), so the discriminant is the `Session.settings-meta.xml` filename,
  // NOT the directory — matching on `settings/` alone would falsely claim
  // coverage over the other settings files (Security, Search, etc.). One
  // org-level singleton; the extractor emits the fixed `SessionSettings:default`
  // node. Refresh-gated: only populates once a re-refresh retrieves the new type.
  if (segments.includes('settings') && fileName === 'Session.settings-meta.xml') return 'SessionSettings';
  // Finding #38: FieldServiceSettings shares the generic `settings/`
  // container with SessionSettings — same discriminant-by-filename
  // approach (`FieldService.settings-meta.xml`, per the Metadata API's
  // `[FeatureName].settings` file-naming convention: the member name
  // "FieldService" plus the `.settings` extension). One org-level
  // singleton; the extractor emits the fixed `FieldServiceSettings:default`
  // node.
  if (segments.includes('settings') && fileName === 'FieldService.settings-meta.xml') return 'FieldServiceSettings';
  // CR-CAP-18: platform-event publish/stream-routing topology. Both are flat
  // top-level dispatches under their own DX directory (singular Metadata-API
  // xmlName, no object-nested counterpart). The channel is the stream
  // container; the member binds one entity onto it with a declared filter.
  if (segments.includes('platformEventChannels') && fileName.endsWith('.platformEventChannel-meta.xml')) return 'PlatformEventChannel';
  if (segments.includes('platformEventChannelMembers') && fileName.endsWith('.platformEventChannelMember-meta.xml')) return 'PlatformEventChannelMember';
  if (segments.includes('workflows') && fileName.endsWith('.workflow-meta.xml')) return 'WorkflowRule';
  if (segments.includes('approvalProcesses') && fileName.endsWith('.approvalProcess-meta.xml')) return 'ApprovalProcess';
  if (segments.includes('assignmentRules') && fileName.endsWith('.assignmentRules-meta.xml')) return 'AssignmentRule';
  if (segments.includes('autoResponseRules') && fileName.endsWith('.autoResponseRules-meta.xml')) return 'AutoResponseRule';
  if (segments.includes('escalationRules') && fileName.endsWith('.escalationRules-meta.xml')) return 'EscalationRule';
  if (segments.includes('duplicateRules') && fileName.endsWith('.duplicateRule-meta.xml')) return 'DuplicateRule';
  if (segments.includes('matchingRules') && fileName.endsWith('.matchingRule-meta.xml')) return 'MatchingRule';
  if (segments.includes('email') && fileName.endsWith('.email-meta.xml')) return 'EmailTemplate';
  if (segments.includes('letterhead') && fileName.endsWith('.letter-meta.xml')) return 'Letterhead';
  // v1.4 file-based: VisualforcePage (`pages/{Name}.page`) +
  // VisualforceComponent (`components/{Name}.component`). The markup
  // file is the dispatch target; the extractor reads the companion
  // `-meta.xml` sibling itself. Excluding `-meta.xml` keeps the sidecar
  // from triggering a second (no-op) extraction.
  if (segments.includes('pages') && fileName.endsWith('.page') && !fileName.endsWith('.page-meta.xml')) return 'VisualforcePage';
  if (segments.includes('components') && fileName.endsWith('.component') && !fileName.endsWith('.component-meta.xml')) return 'VisualforceComponent';
  // v1.5 integration topology tier. All six metadata types are flat
  // file-based dispatches under their own DX directory; no
  // object-nested counterpart and no shared directory with any v0.1-v1.4
  // metadata type, so the segment + suffix check is unambiguous.
  if (segments.includes('authproviders') && fileName.endsWith('.authprovider-meta.xml')) return 'AuthProvider';
  if (segments.includes('remoteSiteSettings') && fileName.endsWith('.remoteSite-meta.xml')) return 'RemoteSiteSetting';
  if (segments.includes('cspTrustedSites') && fileName.endsWith('.cspTrustedSite-meta.xml')) return 'CspTrustedSite';
  if (segments.includes('dataSources') && fileName.endsWith('.dataSource-meta.xml')) return 'ExternalDataSource';
  if (segments.includes('externalServiceRegistrations') && fileName.endsWith('.externalServiceRegistration-meta.xml')) return 'ExternalService';
  if (segments.includes('networkAccesses') && fileName.endsWith('.networkAccess-meta.xml')) return 'NetworkAccess';
  // NamedCredential + ConnectedApp complete the integration/auth surface the
  // integration_map tool reports — both flat file-based dispatches under their
  // own DX directory. Previously unregistered, so they were never retrieved.
  if (segments.includes('namedCredentials') && fileName.endsWith('.namedCredential-meta.xml')) return 'NamedCredential';
  if (segments.includes('connectedApps') && fileName.endsWith('.connectedApp-meta.xml')) return 'ConnectedApp';
  // R6-01: SamlSsoConfig — flat top-level dispatch under `samlssoconfigs/`.
  // Suffix verified against the Metadata API Developer Guide ("SamlSsoConfig
  // components have the suffix .samlssoconfig and are stored in the
  // samlssoconfigs folder") — all-lowercase, NOT the camelCase
  // `.samlSsoConfig-meta.xml` a naive type-name transform would guess. The
  // extractor (`saml-sso-config.ts`) and contracts ComponentType were already
  // written and exported but never reachable: this dispatch line — plus the
  // SUPPORTED_TYPES/EXTRACTORS entries above — is what makes it retrieve and
  // extract. `value-change-risk.ts` / `value-change-audit.ts` already query
  // `listNodesByType(ctx.graph, 'SamlSsoConfig', ...)`, so wiring this in is
  // the whole fix; no consumer-side change is needed.
  if (segments.includes('samlssoconfigs') && fileName.endsWith('.samlssoconfig-meta.xml')) return 'SamlSsoConfig';
  // R6-22: Certificate — flat top-level dispatch under `certs/`. The
  // Metadata API retrieves TWO files per component: `{Name}.crt` (the actual
  // PEM/DER certificate or exported key content) and this `{Name}.crt-meta.xml`
  // sidecar (verified live against a production-scale sandbox: `sf project
  // retrieve start --metadata Certificate` landed exactly this pair for all 4
  // real certs). The strict `.crt-meta.xml` suffix check means the bare
  // `.crt` content file never matches ANY dispatch branch — it falls through
  // to `null` and is silently skipped by the walk, exactly like any other
  // non-metadata file. This is deliberate, not an oversight: the extractor
  // must never read key/cert material, so it must never even be dispatched.
  if (segments.includes('certs') && fileName.endsWith('.crt-meta.xml')) return 'Certificate';
  // R6-22: TransactionSecurityPolicy — flat top-level dispatch under
  // `transactionSecurityPolicies/`. Folder + `.transactionSecurityPolicy`
  // suffix verified against the Metadata API Developer Guide (not a live
  // vault — TransactionSecurityPolicy requires Salesforce Shield / Event
  // Monitoring and was unavailable ("not available in this organization",
  // per the retrieve warning) in the gate-vault fleet's accessible sandboxes).
  if (segments.includes('transactionSecurityPolicies') && fileName.endsWith('.transactionSecurityPolicy-meta.xml')) return 'TransactionSecurityPolicy';
  // v1.6 business-user record-value tier. CustomMetadataRecord files
  // live flat under `customMetadata/` with shape
  // `{TypeApiName}.{RecordName}.md-meta.xml`; CustomSettingRecord
  // files live nested under `customSettings/{TypeApiName}/` with
  // shape `{RecordName}.dataset-meta.xml`. Neither nests under any
  // other v1.x dispatch branch, so the order relative to v1.4 is not
  // semantically important — appended at the end to keep the v1.6
  // additions visually grouped.
  if (segments.includes('customMetadata') && fileName.endsWith('.md-meta.xml')) return 'CustomMetadataRecord';
  if (segments.includes('customSettings') && fileName.endsWith('.dataset-meta.xml')) return 'CustomSettingRecord';
  // v3.2 OmniStudio declarative-process tier. All five metadata types
  // are flat file-based dispatches under their own DX directory; no
  // object-nested counterpart and no shared directory with any v0.1-v1.6
  // metadata type, so the segment + suffix check is unambiguous.
  // The five sibling extractors (R2a-R2e) each add one line here.
  if (segments.includes('omniScripts') && fileName.endsWith('.os-meta.xml')) return 'OmniScript';
  if (segments.includes('omniIntegrationProcedures') && fileName.endsWith('.oip-meta.xml')) return 'OmniIntegrationProcedure';
  if (segments.includes('omniDataTransforms') && fileName.endsWith('.rpt-meta.xml')) return 'OmniDataTransform';
  // The OmniUiCard source-tree directory is `omniUiCard` (singular, no
  // trailing `s`), per the recon (journal 0157) and confirmed by the
  // Globex sandbox: 678 cards live under `omniUiCard/`. The
  // file suffix `.ouc-meta.xml` is unique to FlexCards.
  if (segments.includes('omniUiCard') && fileName.endsWith('.ouc-meta.xml')) return 'OmniUiCard';
  if (segments.includes('decisionTables') && fileName.endsWith('.decisionTable-meta.xml')) return 'DecisionTable';
  // R6-08: standard-picklist tier. Flat top-level dispatch under
  // `standardValueSets/` — suffix/folder verified against the Metadata API
  // Developer Guide ("StandardValueSet components have the suffix
  // .standardValueSet and are stored in the standardValueSets folder").
  // Unlike every other top-level type here, StandardValueSet is NOT
  // auto-included in a full org retrieve — the Metadata API requires each
  // standard value set to be named individually in the manifest (there is
  // no wildcard), so a vault only carries the ones `sfi refresh` explicitly
  // requests (see `refresh.ts`'s manifest-selection logic).
  if (segments.includes('standardValueSets') && fileName.endsWith('.standardValueSet-meta.xml')) return 'StandardValueSet';
  // R6-18: Service Cloud entitlement/SLA + Omni-Channel routing tier. All four
  // types are flat top-level dispatches under their own DX directory — folder
  // and suffix verified against REAL scoped retrieves from two live orgs
  // (`sf project retrieve start --metadata EntitlementProcess --metadata
  // MilestoneType --metadata ServiceChannel --metadata QueueRoutingConfig`),
  // not assumed from the Metadata API Developer Guide alone.
  if (segments.includes('entitlementProcesses') && fileName.endsWith('.entitlementProcess-meta.xml')) return 'EntitlementProcess';
  if (segments.includes('milestoneTypes') && fileName.endsWith('.milestoneType-meta.xml')) return 'MilestoneType';
  if (segments.includes('serviceChannels') && fileName.endsWith('.serviceChannel-meta.xml')) return 'ServiceChannel';
  if (segments.includes('queueRoutingConfigs') && fileName.endsWith('.queueRoutingConfig-meta.xml')) return 'QueueRoutingConfig';
  // R7-C7: Omni-Channel presence configuration — the R6-18 leftover. Flat
  // top-level dispatch under its own DX directory; folder/suffix verified
  // via real scoped retrieves (`sf project retrieve start --metadata
  // PresenceUserConfig`) from two live orgs.
  if (segments.includes('presenceUserConfigs') && fileName.endsWith('.presenceUserConfig-meta.xml')) return 'PresenceUserConfig';
  // R6-13: Agentforce / Einstein GenAI tier. Four flat file-based dispatches
  // under their own DX directory. Folders/suffixes verified against a live
  // Agentforce dev org's `sf org list metadata-types` describe (directoryName /
  // suffix): genAiFunctions/.genAiFunction, genAiPlugins/.genAiPlugin,
  // genAiPlannerBundles/.genAiPlannerBundle (nested folder-per-agent — the
  // segment check tolerates the nesting; apiName is basename-derived),
  // genAiPromptTemplates/.genAiPromptTemplate. None nests under any other
  // dispatch branch, so segment + suffix is unambiguous.
  if (segments.includes('genAiFunctions') && fileName.endsWith('.genAiFunction-meta.xml')) return 'GenAiFunction';
  if (segments.includes('genAiPlugins') && fileName.endsWith('.genAiPlugin-meta.xml')) return 'GenAiPlugin';
  if (segments.includes('genAiPlannerBundles') && fileName.endsWith('.genAiPlannerBundle-meta.xml')) return 'GenAiPlannerBundle';
  if (segments.includes('genAiPromptTemplates') && fileName.endsWith('.genAiPromptTemplate-meta.xml')) return 'GenAiPromptTemplate';
  // R7-C7: legacy Einstein Bot / Agentforce agent tier — the R6-13 leftover
  // ("Bot's nested folder-per-bot layout doesn't fit the flat generic
  // pattern"). Folder/suffixes verified against a real scoped retrieve
  // (`sf project retrieve start --metadata Bot`) from a production-scale
  // university sandbox: both `.bot-meta.xml` (the definition) AND every
  // `.botVersion-meta.xml` (one per version) land under the SAME nested
  // `bots/{BotName}/` directory from that single retrieve — no separate
  // `--metadata BotVersion` request is needed or issued. The `bots`
  // segment check tolerates the nesting exactly like `genAiPlannerBundles`
  // above; the two suffixes are mutually exclusive so check order does not
  // matter (`.botVersion-meta.xml` never satisfies `.bot-meta.xml`'s
  // `endsWith` check).
  if (segments.includes('bots') && fileName.endsWith('.bot-meta.xml')) return 'Bot';
  if (segments.includes('bots') && fileName.endsWith('.botVersion-meta.xml')) return 'BotVersion';
  // R6-17: Experience Cloud community tier. `Network` (`networks/`) is the
  // anchor. `CustomSite` (`sites/`) and `ExperienceBundle`
  // (`experiences/{Name}.site-meta.xml`) SHARE the `.site-meta.xml` suffix but
  // live in DIFFERENT directories — so the directory segment disambiguates
  // them (they are never co-located; the check order below is immaterial). The
  // ExperienceBundle *page tree* under `experiences/{Name}/…` is JSON, never
  // `.site-meta.xml`, so only the bundle's top-level meta dispatches here; the
  // JSON tree is suppressed from the skip-counter in `walkAndExtract` (page
  // content is out of scope by design — see the ExperienceBundle extractor).
  if (segments.includes('networks') && fileName.endsWith('.network-meta.xml')) return 'Network';
  if (segments.includes('sites') && fileName.endsWith('.site-meta.xml')) return 'CustomSite';
  if (segments.includes('experiences') && fileName.endsWith('.site-meta.xml')) return 'ExperienceBundle';
  // Finding #38: the two genuine flat-catalog FSL Metadata API types. Both
  // are top-level, one-file-per-record directories — folder/suffix per the
  // Metadata API / Field Service Developer Guide references (not verified
  // against a live FSL org; recommended, not required, before shipping —
  // see the ComponentType doc comment in @sf-intelligence/contracts).
  // `Skill` is shared with Omni-Channel/chat agent routing, not FSL-exclusive.
  if (segments.includes('skills') && fileName.endsWith('.skill-meta.xml')) return 'Skill';
  if (segments.includes('timeSheetTemplates') && fileName.endsWith('.timeSheetTemplate-meta.xml')) return 'TimeSheetTemplate';
  // Finding #45 CRMA slice: WaveDashboard / WaveDataflow / WaveXmd all live
  // under the shared DX `wave/` folder. Discriminate by sidecar suffix
  // (`.wdash-meta.xml` / `.wdf-meta.xml` / `.xmd-meta.xml`). The companion
  // content blobs (`.wdash` / `.wdf`) match no branch and are silently
  // skipped — deliberate, matching Certificate's `.crt` content-file skip:
  // JSON content is out of scope for v1 (see extractor JSDoc).
  if (segments.includes('wave') && fileName.endsWith('.wdash-meta.xml')) return 'WaveDashboard';
  if (segments.includes('wave') && fileName.endsWith('.wdf-meta.xml')) return 'WaveDataflow';
  if (segments.includes('wave') && fileName.endsWith('.xmd-meta.xml')) return 'WaveXmd';
  return null;
};

/**
 * Names whose direct child directories are dispatched as bundle units
 * (their basename becomes the bundle's API name; their children are NOT
 * walked further). LWC and Aura are the two v1.4 bundle types.
 *
 * Listed here rather than baked into a free-standing `if` inside
 * `walkDir` so a future bundle-shaped metadata type can be added by
 * extending this set and adding the matching dispatch branch in
 * `dispatchFile` — no second edit to the walker required.
 *
 * Exported so consumers OUTSIDE the walker (e.g. `sfi review-change`'s
 * `git diff` path mapper, R6-29) that need to locate a bundle's parent
 * directory within an arbitrary path do not hand-maintain a second copy
 * of this list.
 */
export const BUNDLE_PARENT_DIRS = new Set<string>(['lwc', 'aura']);

/**
 * A single entry the walker hands to the dispatch loop. File-shaped
 * extractors get `isDirectory: false`; the v1.4 bundle-shaped
 * extractors (`LightningComponentBundle`, `AuraDefinitionBundle`) get
 * `isDirectory: true` and `path` points at the bundle directory itself.
 */
interface WalkedEntry {
  readonly path: string;
  readonly isDirectory: boolean;
}

/**
 * Recursively walk `currentDir` in alphabetical order, appending each
 * regular file (or v1.4 bundle directory) to `found`. Hidden entries
 * (names starting with `.`) are skipped to mirror the source-tree-hash
 * walk.
 *
 * v1.4 bundle handling: when the current directory's basename matches
 * `BUNDLE_PARENT_DIRS` (`lwc`, `aura`), each child directory is pushed
 * to `found` as a bundle entry (`isDirectory: true`) and **not**
 * recursed into. Pushing the directory path with the `isDirectory`
 * flag lets `dispatchFile` route it to the bundle extractor while
 * keeping the bundle's own files (`.js`, `.html`, `.js-meta.xml`,
 * `.cmp`, etc.) invisible to the rest of the dispatch matrix — they
 * are read directly by the bundle extractor itself.
 */
const walkDir = async (currentDir: string, found: WalkedEntry[]): Promise<void> => {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  const sorted = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Resolve "is this the parent of a bundle directory?" once per
  // listing rather than per entry. Using `basename(currentDir)` is
  // both fewer string ops and immune to path-segment splits.
  const currentName = basename(currentDir);
  const isBundleParent = BUNDLE_PARENT_DIRS.has(currentName);
  for (const entry of sorted) {
    const abs = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (isBundleParent) {
        // Bundle directory: emit as a single dispatch unit; do NOT
        // recurse. The bundle extractor reads the children itself.
        found.push({ path: abs, isDirectory: true });
      } else {
        await walkDir(abs, found);
      }
    } else if (entry.isFile()) {
      found.push({ path: abs, isDirectory: false });
    }
  }
};

/** Path segments of `absPath` relative to `rootDir` (split on the platform separator). */
const relativeSegments = (rootDir: string, absPath: string): readonly string[] => {
  const rel = absPath.startsWith(`${rootDir}${sep}`) ? absPath.slice(rootDir.length + 1) : absPath;
  return rel.split(sep);
};

/**
 * Salesforce DX wrapper segments. `sf project retrieve` lays files out
 * under `source/main/default/{actual-type-dir}/`. The dispatcher is
 * indifferent — it does `segments.includes(...)` — but the skip-counter
 * needs a single attribution key per unknown file, so we walk past these
 * wrappers to find the actual DX directory name. If a top-level segment
 * happens to be named `main` or `default` *and* a DX type, the lookahead
 * is still correct because Salesforce's standard wrapper is always two
 * levels deep.
 */
const DX_WRAPPER_SEGMENTS = new Set<string>(['main', 'default']);

/**
 * File suffixes the dispatch matrix does NOT route directly but that
 * are nonetheless covered by their sibling extractor. The counter
 * suppresses these so the warning surface only flags real coverage
 * gaps, not the cosmetic noise of e.g. `.cls-meta.xml` companion
 * files that the ApexClass extractor reads as a sidecar.
 *
 *   - `.cls-meta.xml`     — sidecar of `.cls`  (ApexClass)
 *   - `.trigger-meta.xml` — sidecar of `.trigger` (ApexTrigger)
 *   - `.page-meta.xml`    — sidecar of `.page` (VisualforcePage)
 *   - `.component-meta.xml` — sidecar of `.component` (VisualforceComponent)
 *
 * Without this list, the warning on a healthy vault would surface
 * "classes: N files skipped" for every `*.cls-meta.xml` companion,
 * drowning out the real signal (e.g. `listViews/`, `compactLayouts/`,
 * `omniProcesses/`).
 */
const KNOWN_SIDECAR_SUFFIXES: readonly string[] = [
  '.cls-meta.xml',
  '.trigger-meta.xml',
  '.page-meta.xml',
  '.component-meta.xml',
];

/** Return true if `fileName` is a known sidecar handled by its sibling extractor. */
const isKnownSidecar = (fileName: string): boolean => {
  for (const suffix of KNOWN_SIDECAR_SUFFIXES) {
    if (fileName.endsWith(suffix)) return true;
  }
  return false;
};

/**
 * Pick the directory basename to attribute an unknown file to. The
 * heuristic balances "human-readable" with "specific enough to act on":
 *
 *   - Top-level DX directories that the dispatcher doesn't recognise
 *     (e.g. `omniProcesses`, `omniDataTransforms`) attribute to that
 *     directory name. These are the dominant case the
 *     architectural-bug-fix targets.
 *
 *   - Files nested under `objects/{ObjectApiName}/{innerType}/...` whose
 *     inner type is not one of the recognised sub-dispatches (i.e.
 *     `listViews/`, `compactLayouts/`, `webLinks/`, `actionOverrides/`,
 *     etc.) attribute to the inner-type basename rather than to
 *     `objects/`. Without this, every unknown nested-under-objects
 *     file would land under the same `objects` bucket, hiding the
 *     specific gap from operators.
 *
 *   - DX wrapper segments (`main`, `default`) are walked past so the
 *     attribution surfaces a directory name an operator can reason
 *     about, not the wrapping shape `sf project retrieve` emits.
 *
 *   - Files sitting directly under `source/` (no enclosing directory)
 *     attribute to the sentinel `(root)`.
 */
const skipAttributionKey = (dirSegments: readonly string[]): string => {
  // Strip DX wrappers from the head of the path so attribution keys
  // never include `main` or `default`.
  const stripped: string[] = [];
  for (const segment of dirSegments) {
    if (stripped.length === 0 && DX_WRAPPER_SEGMENTS.has(segment)) continue;
    stripped.push(segment);
  }
  if (stripped.length === 0) return '(root)';
  // Object-nested case: `objects/{ObjectApiName}/{innerType}/...`. When
  // the innerType is unknown, the bucket should be the innerType, not
  // `objects` (operators need to see which nested sub-dispatch is
  // missing). Three-segment minimum guards against attributing a stray
  // file at `objects/Foo/Foo.something-meta.xml` (no innerType) to a
  // bogus key.
  if (stripped[0] === 'objects' && stripped.length >= 3) {
    const innerType = stripped[2];
    if (innerType !== undefined && innerType !== '') return innerType;
  }
  // Default case: the first non-wrapper segment.
  return stripped[0] ?? '(root)';
};

/**
 * Resolve the {@link ComponentType} a source-tree path would dispatch to.
 * Used by coverage reporting to attribute extractor failures to a type, and
 * by `sfi review-change`'s `git diff` path mapper to resolve a changed file
 * (or bundle directory) to its component type.
 *
 * `fileName`/`dirSegments` are derived IDENTICALLY to `walkAndExtract`'s own
 * call site (the last path segment is always the dispatch unit's basename,
 * everything before it is the directory chain) regardless of `isDirectory`.
 * A prior version special-cased `isDirectory` to keep the bundle's own
 * basename inside `dirSegments`, which broke `dispatchFile`'s bundle branch:
 * it reads `segments[segments.length - 1]` expecting the PARENT dir
 * (`lwc`/`aura`), but got the bundle name itself (e.g. `myCmp`) and returned
 * `null` for every bundle directory (R6-29). Bundle dirs now resolve
 * correctly in both directions: `lwc/{bundle}/` -> `LightningComponentBundle`,
 * `aura/{bundle}/` -> `AuraDefinitionBundle`.
 */
export const componentTypeFromSourcePath = (
  sourceRoot: string,
  absPath: string,
  isDirectory = false,
): SupportedType | null => {
  const segments = relativeSegments(sourceRoot, absPath);
  const fileName = segments[segments.length - 1] ?? basename(absPath);
  const dirSegments = segments.slice(0, -1);
  return dispatchFile(dirSegments, fileName, isDirectory);
};

/**
 * The two folder-based analytics types this pass owns. They used to be parsed
 * and then DELETED (usage folded onto fields, nodes and edges dropped); they
 * are now PERSISTED as first-class nodes, redacted and capped. See
 * {@link applyReportDashboardPersistence}.
 */
const REPORT_DASHBOARD_TYPES: ReadonlySet<ComponentType> = new Set(['Report', 'Dashboard']);

/**
 * Per-field cap on how many report/dashboard NAMES are preserved by
 * {@link applyReportDashboardPersistence} (Finding #36). This is a
 * per-field name-list cap on the derived `usedInReports`/`usedInDashboards`
 * property, distinct from BOTH the org-wide `--with-reports` pull cap (top 500
 * by usage — see `REPORT_DASHBOARD_USAGE_CAVEAT`) AND the per-type node
 * persistence cap ({@link DEFAULT_REPORT_DASHBOARD_NODE_CAP}). It exists so a
 * field referenced by an unusually large number of reports doesn't balloon
 * that one `CustomField` node's properties; beyond-cap membership is disclosed
 * via the `usedInReportsTruncated` / `usedInDashboardsTruncated` total-count
 * property.
 *
 * UNCHANGED at 50 — its meaning, its consumers (`field_360`,
 * `safe_to_delete_field`, `find_field_anywhere`, `unused_fields_deep`,
 * `get_impact`), and the truncation disclosure are exactly as before.
 */
export const FOLDED_REPORT_DASHBOARD_NAME_CAP = 50;
const FOLDED_NAME_CAP = FOLDED_REPORT_DASHBOARD_NAME_CAP;

/**
 * Default per-type cap on how many Report / Dashboard NODES are persisted into
 * the graph by {@link applyReportDashboardPersistence}. A BLOW-UP GUARD, not
 * an operating point: it is set above observed real-org scale so a normal org
 * is never capped, and exists only so a pathological org cannot unbounded-grow
 * the vault. Override with `SFI_REPORT_NODE_CAP`; `0` disables node
 * persistence entirely and restores the exact pre-change "usage only" shape.
 *
 * SIZING EVIDENCE. Two real-org datapoints: 3,373 reports / 83 dashboards
 * (2026-06 changelog) and 4,277 reports / 81 dashboards (2026-08). So 3-4k is
 * TYPICAL, not exceptional. Measured marginal cost at the 4,277 + 81 shape
 * (synthetic corpus, ~15 field refs per report, real pipeline):
 *
 *   nodes + ecosystem edges (what ships)     +3.4 MB DuckDB, +11.4 MB Markdown, ~+23 s import
 *   …plus report->field edges (rejected)     +23.6 MB DuckDB, +16.2 MB Markdown, ~+110 s import
 *
 * The rejected row is why {@link applyReportDashboardPersistence} does NOT
 * persist report/dashboard -> `CustomField` edges: they were 64,155 of the
 * 68,513 rows (94%) for an answer the folded `usedInReports` property already
 * gives, uncapped, through a channel every consumer already reads.
 *
 * The import figure is the graph layer's row-at-a-time cold-import path
 * (~2 ms/row), not anything this pass controls; the only lever here is how
 * many rows it is handed. A DEFAULT `sfi refresh` pulls the top 500 per type
 * (`reportsCap()`), so its cost is ~1/8 of the numbers above; the 4,277 shape
 * is the uncapped `--with-reports` pull, already documented as slow.
 *
 * When the cap DOES bite, the drop is DISCLOSED, never silent — see
 * {@link ReportDashboardPersistStats}.
 */
export const DEFAULT_REPORT_DASHBOARD_NODE_CAP = 5000;

/**
 * Effective per-type node cap: `SFI_REPORT_NODE_CAP` when it parses to a
 * finite, non-negative integer, else {@link DEFAULT_REPORT_DASHBOARD_NODE_CAP}.
 * Mirrors `reportsCap()`'s env-override contract in `commands/refresh.ts`.
 */
export const reportDashboardNodeCap = (): number => {
  const raw = Number(process.env['SFI_REPORT_NODE_CAP']);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_REPORT_DASHBOARD_NODE_CAP;
};

/**
 * PRIVACY — the persisted-property ALLOW-LIST for a `Report` node.
 *
 * This is an allow-list, not a deny-list, and that is the whole guarantee: a
 * property key that is not named here CANNOT reach the graph, so no future
 * extractor change can silently start persisting report filter LITERALS,
 * descriptions, bucket bin boundaries, or anything else freeform. A deny-list
 * would fail open on exactly that change.
 *
 * What a report's XML contains that is NOT here, and why:
 *   - `<filter><criteriaItems><value>` — the literal an admin typed into a
 *     filter (a customer name, an email, an amount, a person). Record-level
 *     data, never metadata. The extractor already reduces it to a
 *     `hasValue` boolean; {@link sanitizeFilterItems} re-projects each item to
 *     `{field, operator, hasValue}` so even a regressed extractor cannot leak
 *     it through this pass.
 *   - `<description>` — freeform admin text. The extractor captures only
 *     `descriptionPresent` (a boolean), which IS allowed.
 *   - `<buckets><values>/<sourceValues>` — bucket bin boundaries are
 *     themselves value literals; never parsed, and `label` (the admin-typed
 *     `masterLabel`) is dropped here too.
 *   - `<name>` — the report's display name is NOT persisted as a property;
 *     the node's `apiName` (`{Folder}/{DeveloperName}`) is the identity.
 */
export const PERSISTED_REPORT_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'fieldRefs',
  'rawReferenceCount',
  'legacyAddressingRefsSkipped',
  'descriptionPresent',
  'reportType',
  'format',
  'booleanFilter',
  'filters',
  'groupings',
  'buckets',
  'crossFilters',
  'chart',
  'truncatedCounts',
]);

/** PRIVACY — the persisted-property allow-list for a `Dashboard` node. Same contract as {@link PERSISTED_REPORT_PROPERTY_KEYS}; notably omits `runningUser` (a real org username), which the extractor never reads in the first place. */
export const PERSISTED_DASHBOARD_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'fieldRefs',
  'rawReferenceCount',
  'legacyAddressingRefsSkipped',
  'descriptionPresent',
  'dashboardType',
  'componentReports',
  'truncatedCounts',
]);

/**
 * PRIVACY — the persisted-property allow-list for an EDGE emitted BY a
 * Report/Dashboard node.
 *
 * `sanitizeAnalyticsProperties` covers `node.properties`; without this, the
 * claim "a key that is not named here cannot persist" would be false for the
 * edge rows, which carry their own free-form `properties` bag. Nothing leaks
 * today (every current emitter writes api-names only), but an allow-list that
 * covers one of two persisted row shapes is a guarantee with a hole in it.
 *
 * `referenceKind` is the edge-kind discriminator; `reportType` is a Salesforce
 * api name (`AccountList`, `Widget_Metrics__c`). Both are metadata. Anything
 * else an emitter might add — a label, a filter value, a username — is dropped.
 */
export const PERSISTED_ANALYTICS_EDGE_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'referenceKind',
  'reportType',
]);

/** Per-item allow-list for `properties.filters` — field IDENTITY + operator + value PRESENCE, never the literal. */
const FILTER_ITEM_KEYS = ['field', 'operator', 'hasValue'] as const;
/** Per-item allow-list for `properties.groupings`. All three are structural. */
const GROUPING_ITEM_KEYS = ['field', 'dateGranularity', 'axis'] as const;
/** Per-item allow-list for `properties.buckets` — identity + source column. `label` (admin-typed `masterLabel`) and the bin boundaries are dropped. */
const BUCKET_ITEM_KEYS = ['field', 'sourceField'] as const;
/** Per-item allow-list for `properties.crossFilters` — related object + operation + condition PRESENCE, never the conditions' literals. */
const CROSS_FILTER_ITEM_KEYS = ['relatedObject', 'operation', 'hasConditions'] as const;
/** Allow-list for the singular `properties.chart` object. */
const CHART_KEYS = ['type', 'hasSummaryAxis'] as const;

/**
 * Re-project each element of a property array through a per-item key
 * allow-list, dropping every other key. `undefined` in, `undefined` out; a
 * non-array (or non-object element) is dropped rather than passed through, so
 * an unexpected shape fails CLOSED.
 */
const projectItems = (
  value: unknown,
  keys: readonly string[],
): readonly Readonly<Record<string, unknown>>[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Readonly<Record<string, unknown>>;
    const projected: Record<string, unknown> = {};
    for (const key of keys) {
      if (record[key] !== undefined) projected[key] = record[key];
    }
    out.push(projected);
  }
  return out;
};

/** {@link projectItems} for a singular object property (e.g. `chart`). */
const projectObject = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) projected[key] = record[key];
  }
  return projected;
};

/**
 * PRIVACY — reduce a Report / Dashboard node's properties to exactly the
 * allow-listed keys, with every nested list re-projected through its own
 * per-item allow-list.
 *
 * Two independent layers have to fail before a filter literal could persist:
 * the extractor would have to start capturing `<value>` (it captures a
 * `hasValue` boolean — see `extractReportDetail`'s binding privacy note) AND
 * that key would have to be added to both {@link PERSISTED_REPORT_PROPERTY_KEYS}
 * and {@link FILTER_ITEM_KEYS}. Neither is reachable by accident.
 */
const sanitizeAnalyticsProperties = (node: Node): Readonly<Record<string, unknown>> => {
  const allowed =
    node.type === 'Report' ? PERSISTED_REPORT_PROPERTY_KEYS : PERSISTED_DASHBOARD_PROPERTY_KEYS;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.properties)) {
    if (!allowed.has(key)) continue;
    if (key === 'filters') {
      const projected = projectItems(value, FILTER_ITEM_KEYS);
      if (projected !== undefined) out[key] = projected;
      continue;
    }
    if (key === 'groupings') {
      const projected = projectItems(value, GROUPING_ITEM_KEYS);
      if (projected !== undefined) out[key] = projected;
      continue;
    }
    if (key === 'buckets') {
      const projected = projectItems(value, BUCKET_ITEM_KEYS);
      if (projected !== undefined) out[key] = projected;
      continue;
    }
    if (key === 'crossFilters') {
      const projected = projectItems(value, CROSS_FILTER_ITEM_KEYS);
      if (projected !== undefined) out[key] = projected;
      continue;
    }
    if (key === 'chart') {
      const projected = projectObject(value, CHART_KEYS);
      if (projected !== undefined) out[key] = projected;
      continue;
    }
    out[key] = value;
  }
  return out;
};

/**
 * Sort a name set deterministically and cap it at {@link FOLDED_NAME_CAP},
 * returning the capped list plus (only when truncated) the true total count
 * so the cap is honestly disclosed rather than silently dropping members.
 */
const capFoldedNames = (
  names: ReadonlySet<string> | undefined,
): { readonly list: readonly string[]; readonly truncatedTotal?: number } => {
  if (names === undefined || names.size === 0) return { list: [] };
  const sorted = [...names].sort();
  if (sorted.length <= FOLDED_NAME_CAP) return { list: sorted };
  return { list: sorted.slice(0, FOLDED_NAME_CAP), truncatedTotal: sorted.length };
};

/** Per-type persistence accounting for one refresh — see {@link ReportDashboardPersistStats}. */
export interface ReportDashboardTypeStats {
  /**
   * DISTINCT node ids the extractors produced for this type. Deliberately not
   * a count of extraction OCCURRENCES: `nodes.id` is a primary key, so two
   * results carrying the same id yield ONE row. Counting occurrences would
   * make `persisted` over-report by exactly the number of duplicates — i.e.
   * it would be wrong precisely in the id-collision case this accounting
   * exists to expose.
   */
  readonly extracted: number;
  /** Nodes actually written to the graph (`min(extracted, cap)`). */
  readonly persisted: number;
  /** The per-type cap in force this run. */
  readonly cap: number;
  /**
   * Extraction occurrences beyond the first for an already-seen id — i.e. how
   * many nodes the primary key silently absorbed. Omitted when zero. Non-zero
   * means two source files resolved to ONE id and one of them is not in the
   * vault: a bug worth surfacing, never a rounding error to swallow.
   */
  readonly duplicateIds?: number;
}

/**
 * What {@link applyReportDashboardPersistence} actually persisted, per type.
 *
 * HONESTY: this is the disclosure channel for the node cap. `persisted <
 * extracted` means the graph holds a SUBSET, and the caller MUST route that
 * into the manifest's coverage rows (`decorateReportNodeCapCoverage` in
 * `commands/refresh.ts` forces the row `pending`, which is what makes every
 * downstream field tool keep hedging its report/dashboard absence claims). A
 * capped capture must never read as a complete one.
 *
 * The FIELD-USAGE fold is computed over the FULL extracted set BEFORE the cap
 * is applied, so "which reports use this field" keeps its pre-existing
 * coverage (all retrieved reports, up to the per-field 50-name cap) even when
 * the node set is capped. The cap costs navigability, not usage recall.
 */
export interface ReportDashboardPersistStats {
  readonly reports: ReportDashboardTypeStats;
  readonly dashboards: ReportDashboardTypeStats;
}

/** Return shape of {@link applyReportDashboardPersistence}. */
export interface ReportDashboardPersistOutcome {
  readonly results: readonly ExtractionResult[];
  readonly stats: ReportDashboardPersistStats;
}

/**
 * Persist Report / Dashboard as first-class graph nodes AND fold their field
 * usage onto the referenced `CustomField` nodes.
 *
 * REPORT-DASHBOARD-GRAPH-PERSISTENCE — this pass replaces the destructive
 * fold. The old behaviour parsed each report's filters, groupings, buckets,
 * cross-filters and chart, harvested the field usage, and then DELETED every
 * Report/Dashboard node and edge; a measured org collapsed 4,277 reports + 81
 * dashboards into at most 50 retained names per field, which made "which
 * reports break if I change this field", "what does this dashboard depend on"
 * and every other reporting-ecosystem question structurally unanswerable.
 *
 * What this pass does, in order:
 *
 *   1. HARVEST (unchanged, and over the FULL set — never the capped one): each
 *      Report/Dashboard `references` edge into a `CustomField:` target stamps
 *      `usedInReport` / `usedInDashboard` on that field plus the capped, sorted
 *      `usedInReports` / `usedInDashboards` name list and its
 *      `…Truncated` total. Every existing consumer of those properties
 *      (`safe_to_delete_field`, `field_360`, `unused_fields_deep`,
 *      `find_dead_code`, `find_field_anywhere`, `field_lineage`, `get_impact`)
 *      keeps working byte-identically, and there is ONE source of truth: the
 *      same edge harvest that now also backs the persisted nodes.
 *   2. REDACT: each surviving node's properties are reduced to an ALLOW-LIST
 *      ({@link sanitizeAnalyticsProperties}). Filter literals, descriptions,
 *      bucket bin boundaries and bucket labels cannot pass.
 *   3. DROP the analytics -> `CustomField` reference edges. THE COST DECISION,
 *      measured: at 4,277 reports those edges were 64,155 of 68,513 rows (94%)
 *      — ~+20 MB of DuckDB and ~+90 s of import — to answer "which reports use
 *      this field", which step 1's `usedInReports` property ALREADY answers,
 *      over EVERY extracted report (the node set is capped; the fold is not),
 *      through a channel every consumer above already reads. Persisting them
 *      would also make that answer INCONSISTENT: a field used only by
 *      cap-dropped reports would report `incomingEdgeCount: 0` while an
 *      identical field whose report sorted earlier reported N. The report's own
 *      `properties.fieldRefs` still lists its fields, so "what does this report
 *      depend on" is answerable from the node itself.
 *   4. CAP: at most {@link reportDashboardNodeCap} nodes per type survive,
 *      chosen by ascending node id. Ascending id — not "most edges" — because
 *      it is STABLE: a report gaining a column must not reshuffle which nodes
 *      are in the vault and churn the whole Markdown diff. The retrieve that
 *      produced these files is itself already usage-ranked (top-N by
 *      `LastRunDate`), so the set handed to this pass is the most-used one;
 *      within it, determinism beats a second ranking.
 *   5. PRUNE: edges incident to a node the cap dropped are removed, so the cap
 *      never mints a dangling edge that would read as a missing component.
 *   6. DISCLOSE: {@link ReportDashboardPersistStats} carries extracted vs
 *      persisted per type, which the caller routes into coverage.
 *
 * Pure transform; every other type passes through untouched. Returns the input
 * array by reference when no Report/Dashboard node was retrieved, so a no-op
 * is observably free.
 */
export const applyReportDashboardPersistence = (
  results: readonly ExtractionResult[],
): ReportDashboardPersistOutcome => {
  const cap = reportDashboardNodeCap();
  const analyticsNodeApiNames = new Map<string, string>();
  // DISTINCT ids per type (see {@link ReportDashboardTypeStats.extracted}),
  // plus the count of occurrences the id set absorbed.
  const idsByType = new Map<ComponentType, Set<string>>([
    ['Report', new Set()],
    ['Dashboard', new Set()],
  ]);
  const duplicatesByType = new Map<ComponentType, number>([
    ['Report', 0],
    ['Dashboard', 0],
  ]);
  for (const r of results) {
    for (const n of r.nodes) {
      if (!REPORT_DASHBOARD_TYPES.has(n.type)) continue;
      const seen = idsByType.get(n.type);
      if (seen !== undefined && seen.has(n.id)) {
        duplicatesByType.set(n.type, (duplicatesByType.get(n.type) ?? 0) + 1);
      }
      analyticsNodeApiNames.set(n.id, n.apiName);
      seen?.add(n.id);
    }
  }
  const typeStats = (type: ComponentType): ReportDashboardTypeStats => {
    const extracted = idsByType.get(type)?.size ?? 0;
    const duplicateIds = duplicatesByType.get(type) ?? 0;
    return {
      extracted,
      persisted: Math.min(extracted, cap),
      cap,
      ...(duplicateIds > 0 ? { duplicateIds } : {}),
    };
  };
  const stats: ReportDashboardPersistStats = {
    reports: typeStats('Report'),
    dashboards: typeStats('Dashboard'),
  };
  if (analyticsNodeApiNames.size === 0) return { results, stats };

  // Step 1 — HARVEST over the FULL extracted set (pre-cap). The field-usage
  // answer must not shrink just because the NODE set is capped.
  const reportNamesByField = new Map<string, Set<string>>();
  const dashboardNamesByField = new Map<string, Set<string>>();
  for (const r of results) {
    for (const e of r.edges) {
      if (e.edgeType !== 'references' || !analyticsNodeApiNames.has(e.fromId)) continue;
      if (!e.toId.startsWith('CustomField:')) continue;
      const sourceApiName = analyticsNodeApiNames.get(e.fromId) ?? e.fromId;
      const byField = e.fromId.startsWith('Report:')
        ? reportNamesByField
        : e.fromId.startsWith('Dashboard:')
          ? dashboardNamesByField
          : null;
      if (byField === null) continue;
      const names = byField.get(e.toId) ?? new Set<string>();
      names.add(sourceApiName);
      byField.set(e.toId, names);
    }
  }

  // Step 4 — CAP. Deterministic by ascending id (see the doc comment).
  const keptIds = new Set<string>();
  for (const ids of idsByType.values()) {
    for (const id of [...ids].sort().slice(0, cap)) keptIds.add(id);
  }
  return {
    results: results.map((r) => ({
      ...r,
      nodes: r.nodes
        .filter((n) => !REPORT_DASHBOARD_TYPES.has(n.type) || keptIds.has(n.id))
        .map((n): Node => {
          // Step 2 — REDACT (allow-list) for the surviving analytics nodes.
          if (REPORT_DASHBOARD_TYPES.has(n.type)) {
            return { ...n, properties: sanitizeAnalyticsProperties(n) };
          }
          if (n.type !== 'CustomField') return n;
          const reportNames = reportNamesByField.get(n.id);
          const dashboardNames = dashboardNamesByField.get(n.id);
          if (reportNames === undefined && dashboardNames === undefined) return n;
          const reportCap = capFoldedNames(reportNames);
          const dashboardCap = capFoldedNames(dashboardNames);
          return {
            ...n,
            properties: {
              ...n.properties,
              ...(reportNames !== undefined
                ? { usedInReport: true, usedInReports: reportCap.list }
                : {}),
              ...(reportCap.truncatedTotal !== undefined
                ? { usedInReportsTruncated: reportCap.truncatedTotal }
                : {}),
              ...(dashboardNames !== undefined
                ? { usedInDashboard: true, usedInDashboards: dashboardCap.list }
                : {}),
              ...(dashboardCap.truncatedTotal !== undefined
                ? { usedInDashboardsTruncated: dashboardCap.truncatedTotal }
                : {}),
            },
          };
        }),
      // Steps 3 + 5 — DROP analytics -> CustomField reference edges (the 94%
      // row layer step 1 already covers via `usedInReports`), and PRUNE any
      // edge incident to a cap-dropped node so the cap never mints a dangling
      // edge that would read as a missing component. Surviving analytics-
      // sourced edges are REDACTED through their own allow-list
      // ({@link PERSISTED_ANALYTICS_EDGE_PROPERTY_KEYS}) so the "unnamed keys
      // cannot persist" guarantee covers edge rows too, not just node rows.
      edges: r.edges
        .filter((e) => {
          const fromAnalytics = analyticsNodeApiNames.has(e.fromId);
          if (fromAnalytics && e.toId.startsWith('CustomField:')) return false;
          if (fromAnalytics && !keptIds.has(e.fromId)) return false;
          if (analyticsNodeApiNames.has(e.toId) && !keptIds.has(e.toId)) return false;
          return true;
        })
        .map((e): Edge => {
          if (!analyticsNodeApiNames.has(e.fromId)) return e;
          const properties: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(e.properties)) {
            if (PERSISTED_ANALYTICS_EDGE_PROPERTY_KEYS.has(key)) properties[key] = value;
          }
          return { ...e, properties };
        }),
    })),
    stats,
  };
};

/**
 * RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE: the Profile-Id key pair for
 * 15-vs-18-char resolution. A 15-char Salesforce Id is the exact case-sensitive
 * prefix of its 18-char form (the trailing 3 chars are a case-insensitivity
 * checksum), so a rule that hardcodes one width still matches a profile index
 * keyed on the other. Returns the distinct lookup keys for an id — its verbatim
 * form plus its 15-char truncation.
 */
const profileIdKeys = (id: string): readonly string[] =>
  id.length > 15 ? [id, id.slice(0, 15)] : [id];

/**
 * RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE: build an Id->apiName index
 * from every Profile node that carries its Salesforce Id
 * (`properties.salesforceId`), keyed by BOTH the 15- and 18-char forms (see
 * {@link profileIdKeys}).
 *
 * **Honesty**: real offline Profile metadata carries NO Salesforce Id — the
 * node's apiName is the file name — so this index is EMPTY on a normal vault
 * and every gated userCriteria id stays an honest `UnresolvedProfile:` stub.
 * The index lights up only when a Profile node is enriched with its Id (e.g. a
 * future Tooling-API pass keyed on the same salesforceId slot) or a caller
 * supplies the map directly. First-writer-wins on the (never-expected) case of
 * two profiles claiming one id, for a deterministic result.
 */
export const buildProfileIdIndex = (
  results: readonly ExtractionResult[],
): ReadonlyMap<string, string> => {
  const index = new Map<string, string>();
  for (const r of results) {
    for (const n of r.nodes) {
      if (n.type !== 'Profile') continue;
      const rawId = n.properties['salesforceId'];
      if (typeof rawId !== 'string' || rawId.length === 0) continue;
      for (const key of profileIdKeys(rawId)) {
        if (!index.has(key)) index.set(key, n.apiName);
      }
    }
  }
  return index;
};

/**
 * The `referenceKind` an `UnresolvedProfile:{id}` stub edge carries, mapped to
 * the `referenceKind` its RESOLVED `Profile:{apiName}` edge should carry. Two
 * stub sources feed {@link resolveRestrictionRuleProfileEdges}: RestrictionRule
 * / ScopingRule `<userCriteria>` gates
 * (`restrictionUserProfileUnresolved` → `restrictionUserProfile`) and
 * DuplicateRule `<duplicateRuleFilter>` `ProfileId` items
 * (`duplicateRuleProfileUnresolved` → `duplicateFilterProfile`, matching a
 * name-based duplicate profile edge). Membership in this map is also what marks
 * an edge as a resolvable profile-id stub, so a future stub source is opted in
 * by ADDING its pair here — no other change to the pass.
 */
const RESOLVED_PROFILE_REFERENCE_KIND: Readonly<Record<string, string>> = {
  restrictionUserProfileUnresolved: 'restrictionUserProfile',
  duplicateRuleProfileUnresolved: 'duplicateFilterProfile',
};

/**
 * RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE (+ DuplicateRule sibling
 * DUPLICATE-RULE-FILTER-PROFILE-UNGRAPHED): resolve each `UnresolvedProfile:{id}`
 * profile-id stub against an Id->apiName index, rewriting the resolvable ones
 * into real `Profile:{apiName}` `references` edges — so the rule appears in that
 * profile's usages and profile-retirement / sharing reviews see the constraint.
 * Covers BOTH stub sources (see {@link RESOLVED_PROFILE_REFERENCE_KIND}):
 * RestrictionRule / ScopingRule `<userCriteria>` gates and DuplicateRule
 * `<duplicateRuleFilter>` `ProfileId` items — the resolved edge takes the
 * source's mapped `referenceKind` and, for the duplicate case, preserves the
 * stub's `filterField` / `operation` so a resolved id-based edge reads exactly
 * like a name-based `duplicateFilterProfile` edge. Unresolvable ids stay
 * explicit `UnresolvedProfile:` stubs with their disclosure props; a
 * `Profile:{id}` node is NEVER minted from an opaque id.
 *
 * Node props are updated in lockstep with the edges ONLY for the
 * restriction/scoping disclosure shape (nodes carrying `unresolvedProfileIds`):
 * resolved ids move out of `unresolvedProfileIds` into a
 * `userCriteriaResolvedProfiles` {id: apiName} map (and `unresolvedProfileIds`
 * is dropped once every gated id resolves); `userCriteriaProfileIds` (the full
 * gated list) is left intact. DuplicateRule nodes carry no such disclosure
 * array, so only their edge is rewritten — their properties are untouched.
 *
 * Pure transform. Identity no-op (`=== results`) when there is nothing to
 * resolve — no profile-id stub present, or an empty index (the real offline
 * vault, where Profile metadata carries no Id). The index is built from Profile
 * nodes when not supplied.
 */
export const resolveRestrictionRuleProfileEdges = (
  results: readonly ExtractionResult[],
  profileIdIndex?: ReadonlyMap<string, string>,
): readonly ExtractionResult[] => {
  const index = profileIdIndex ?? buildProfileIdIndex(results);
  const isStubEdge = (e: Edge): boolean => {
    if (e.edgeType !== 'references' || !e.toId.startsWith(UNRESOLVED_PROFILE_PREFIX)) {
      return false;
    }
    const kind = e.properties['referenceKind'];
    return typeof kind === 'string' && RESOLVED_PROFILE_REFERENCE_KIND[kind] !== undefined;
  };
  // Nothing to resolve against, or no stub to rewrite — return the SAME array
  // ref so a no-op is observably free (mirrors applyReportDashboardPersistence).
  if (index.size === 0 || !results.some((r) => r.edges.some(isStubEdge))) return results;

  const resolveApiName = (profileId: string): string | undefined => {
    for (const key of profileIdKeys(profileId)) {
      const apiName = index.get(key);
      if (apiName !== undefined) return apiName;
    }
    return undefined;
  };

  return results.map((r) => {
    // id->apiName resolutions discovered on THIS result's edges, per rule node,
    // so node properties can be trimmed in lockstep with the edge rewrite.
    const resolvedByNode = new Map<string, Map<string, string>>();
    const edges = r.edges.map((e): Edge => {
      if (!isStubEdge(e)) return e;
      const profileId = e.toId.slice(UNRESOLVED_PROFILE_PREFIX.length);
      const apiName = resolveApiName(profileId);
      if (apiName === undefined) return e;
      const perNode = resolvedByNode.get(e.fromId) ?? new Map<string, string>();
      perNode.set(profileId, apiName);
      resolvedByNode.set(e.fromId, perNode);
      const stubKind = e.properties['referenceKind'] as string;
      const props: Record<string, unknown> = {
        referenceKind: RESOLVED_PROFILE_REFERENCE_KIND[stubKind] ?? stubKind,
        profileId,
        resolvedFromProfileId: true,
      };
      // Preserve the DuplicateRule filter context (`filterField` / `operation`).
      // Restriction/scoping stubs carry neither, so their resolved-edge shape is
      // byte-identical to before this generalization.
      const filterField = e.properties['filterField'];
      if (typeof filterField === 'string') props['filterField'] = filterField;
      if (e.properties['operation'] !== undefined) props['operation'] = e.properties['operation'];
      return { ...e, toId: `Profile:${apiName}`, properties: props };
    });
    if (resolvedByNode.size === 0) return r;
    const nodes = r.nodes.map((n): Node => {
      const resolved = resolvedByNode.get(n.id);
      if (resolved === undefined) return n;
      // Node-level disclosure trimming is restriction/scoping-specific — those
      // nodes carry an `unresolvedProfileIds` array. DuplicateRule nodes do NOT,
      // so leave their properties untouched (only the edge is rewritten).
      if (!Array.isArray(n.properties['unresolvedProfileIds'])) return n;
      const gated = n.properties['unresolvedProfileIds'];
      const stillUnresolved = Array.isArray(gated)
        ? (gated as readonly string[]).filter((id) => !resolved.has(id))
        : [];
      const resolvedMap: Record<string, string> = {};
      for (const id of [...resolved.keys()].sort()) resolvedMap[id] = resolved.get(id)!;
      const props: Record<string, unknown> = { ...n.properties };
      delete props['unresolvedProfileIds'];
      props['userCriteriaResolvedProfiles'] = resolvedMap;
      if (stillUnresolved.length > 0) props['unresolvedProfileIds'] = stillUnresolved;
      return { ...n, properties: props };
    });
    return { ...r, nodes, edges };
  });
};

/**
 * Walk every file under `sourceRoot`, dispatch each to its extractor (if
 * any), and accumulate results plus per-file failures. The `typeFilter`,
 * when present, restricts processing to a subset of metadata types.
 *
 * Per-file extractor errors are recorded in `failures` but do not abort
 * the walk — refresh is best-effort across the corpus.
 *
 * @example
 *   const w = await walkAndExtract('/path/org-kb/source', null);
 *   if (w.failures.length === 0) console.log('clean run');
 */
export const walkAndExtract = async (
  sourceRoot: string,
  typeFilter: ReadonlySet<SupportedType> | null,
  /**
   * P5-incremental-refresh: the previous refresh's per-file cache. When a file's
   * mtime+size match the cached entry, its result is reused (the parse is
   * skipped). Omit (or pass an empty map) for a full, non-incremental walk.
   */
  prevCache?: ExtractCache,
): Promise<WalkResult> => {
  const entries: WalkedEntry[] = [];
  await walkDir(sourceRoot, entries);
  const results: ExtractionResult[] = [];
  const failures: RefreshExtractionFailure[] = [];
  const cache: ExtractCache = new Map();
  let reusedCount = 0;
  // Skip-counter: keyed by the first non-wrapper directory segment of
  // each unknown file, value is the count under that key. Surfaced in
  // the returned `WalkResult.skippedDirectories` and propagated by
  // `runRefresh` into the manifest so post-refresh consumers (the
  // status command's `--skipped` flag, MCP `health_check`,
  // `get_manifest`) can warn the operator that the retrieve pulled
  // metadata types this build doesn't yet cover.
  const skippedDirectories: Record<string, number> = {};
  for (const entry of entries) {
    const segments = relativeSegments(sourceRoot, entry.path);
    const fileName = segments[segments.length - 1] ?? '';
    const dirSegments = segments.slice(0, -1);
    const type = dispatchFile(dirSegments, fileName, entry.isDirectory);
    if (type === null) {
      // Architectural-bug fix: previously `continue` here silently
      // dropped every unknown directory entry, so vaults could report
      // `kind: "fresh"` while invisibly missing 1k+ files from
      // metadata types not yet covered (e.g. OmniStudio's
      // `omniProcesses`, `omniDataTransforms`). We now record the
      // skip so the rest of the pipeline can surface the gap.
      //
      // Known sidecar files (`.cls-meta.xml`, `.trigger-meta.xml`,
      // `.page-meta.xml`, `.component-meta.xml`) are NOT counted —
      // their primary extractor reads them as a companion, so they
      // are covered even though the dispatcher walks past them.
      // Counting them would drown the real-gap signal in cosmetic
      // noise.
      // Static-resource CONTENT (the binary / unzipped bundle that sits next to
      // the dispatched `.resource-meta.xml`) is covered by its StaticResource
      // node, not a separate metadata type — so it must NOT be counted as an
      // "uncovered type" skip. Without this, every refresh of every org reports a
      // false `staticresources` gap (the warning is meant to flag REAL coverage
      // holes, so a permanent false positive erodes its signal). R6-17: the same
      // reasoning covers the ExperienceBundle page tree — its hundreds of
      // `experiences/{Name}/…/*.json` page/component files are OUT OF SCOPE by
      // design (the bundle's existence + meta is covered by its ExperienceBundle
      // node), so they must not flood the skip-counter with a false `experiences`
      // gap. Only the dispatched top-level `{Name}.site-meta.xml` is modeled.
      if (
        !isKnownSidecar(fileName) &&
        !dirSegments.includes('staticresources') &&
        !dirSegments.includes('experiences')
      ) {
        const key = skipAttributionKey(dirSegments);
        skippedDirectories[key] = (skippedDirectories[key] ?? 0) + 1;
      }
      continue;
    }
    if (typeFilter !== null && !typeFilter.has(type)) continue;

    // P5-incremental-refresh: reuse the cached result when the file's mtime+size
    // are unchanged. Bundle entries (directories — LWC/Aura) are NOT cached:
    // a directory's mtime doesn't reflect inner-file edits, so they always
    // re-extract (a small fraction of the corpus). On any stat failure, fall
    // through to a full extract (never trust a missing stat).
    const cacheKey = segments.join('/');
    if (!entry.isDirectory && prevCache !== undefined) {
      const prev = prevCache.get(cacheKey);
      if (prev !== undefined) {
        let st;
        try {
          st = await stat(entry.path);
        } catch {
          st = null;
        }
        if (st !== null && st.mtimeMs === prev.mtimeMs && st.size === prev.size) {
          results.push(prev.result);
          cache.set(cacheKey, prev);
          reusedCount += 1;
          continue;
        }
      }
    }

    const outcome = await EXTRACTORS[type](entry.path);
    if (outcome.ok) {
      results.push(outcome.value);
      // Cache the fresh result with the file's current mtime+size (files only).
      if (!entry.isDirectory) {
        try {
          const st = await stat(entry.path);
          cache.set(cacheKey, { mtimeMs: st.mtimeMs, size: st.size, result: outcome.value });
        } catch {
          // A file that vanished between extract and stat just isn't cached.
        }
      }
    } else {
      failures.push({ path: entry.path, error: outcome.error });
    }
  }
  return { results, failures, skippedDirectories, cache, reusedCount };
};

/** Wrap a renderer's frontmatter + body into the canonical Markdown document. */
const composeDocument = (frontmatter: Readonly<Record<string, unknown>>, body: string): string =>
  `---\n${serializeFrontmatter(frontmatter)}\n---\n\n${body}\n`;

/**
 * Split `parentId` ("{Type}:{ScopedApiName}") into just the api-name half,
 * or null if the node has no parent. `componentPath` puts a field under
 * its object's directory — for `CustomField:Account.Industry__c`, the
 * parent api name is `Account`, not the full id.
 */
const parentApiNameFor = (node: Node): string | null => {
  if (node.parentId === null) return null;
  const colon = node.parentId.indexOf(':');
  return colon === -1 ? node.parentId : node.parentId.slice(colon + 1);
};

/**
 * Render one node + edges to Markdown and write to disk. ApexClass /
 * ApexTrigger use the async renderer (reads the .cls source file); Flow
 * uses the dedicated flow renderer; everything else uses the generic
 * component renderer. Throws on renderer failure so the conductor
 * surfaces it as `status: 'failed'`.
 */
const writeNodeDocument = async (
  vaultRoot: string,
  node: Node,
  edges: Parameters<typeof renderComponentMarkdown>[1],
): Promise<void> => {
  const rendered =
    node.type === 'ApexClass' || node.type === 'ApexTrigger'
      ? await renderApexMarkdown(node, edges, vaultRoot)
      : node.type === 'Flow'
        ? renderFlowMarkdown(node, edges)
        : renderComponentMarkdown(node, edges);
  if (!rendered.ok) {
    throw new Error(`renderer failed for ${node.id}: ${rendered.error.message}`);
  }
  const outPath = componentPath(vaultRoot, node.type, parentApiNameFor(node), node.apiName);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, composeDocument(rendered.value.frontmatter, rendered.value.body), 'utf8');
};

/** Render and write `components/index.md` from every collected node. */
const writeIndex = async (vaultRoot: string, allNodes: readonly Node[]): Promise<void> => {
  const indexResult = renderVaultIndex(allNodes);
  if (!indexResult.ok) {
    throw new Error(`renderVaultIndex failed: ${indexResult.error.message}`);
  }
  const indexPath = join(vaultRoot, 'components', 'index.md');
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, composeDocument(indexResult.value.frontmatter, indexResult.value.body), 'utf8');
};

/**
 * Page size used to drain every supported type via `listNodesByType`. The
 * graph layer caps a single query at 500 (its `LIST_MAX_LIMIT`), so the
 * renderer paginates with `offset` to walk past that ceiling. Any type
 * with more than 500 nodes (e.g. OmniUiCard at 678 in Globex) needs
 * this loop to surface every node in the rendered vault.
 */
const RENDER_PAGE_SIZE = 500;

/**
 * Pull every node of every supported type out of the graph, render each
 * to its vault path, and report tally counts. Sorted by id so the render
 * order is byte-stable across machines and runs.
 *
 * Failures here are fatal: every imported node should map to a Markdown
 * file. A render failure leaves the vault inconsistent.
 *
 * **Pagination.** The graph layer's `listNodesByType` caps a single
 * query at 500 rows. Bulk render is the one writer-side caller that
 * legitimately wants ALL rows, so we paginate with `offset` in
 * 500-row pages until the type is drained. Per-page sort by id keeps
 * the within-page render order byte-stable; the overall walk visits
 * each type's nodes in ascending id order across all pages because
 * `listNodesByType` already sorts by id ASC.
 *
 * **Per-type progress (B11).** When an `onType` callback is supplied, it
 * fires once per supported type that produced at least one rendered node,
 * with the type name and its final count, the moment that type is drained.
 * `runRefresh` wires this to the CLI's stderr progress sink so a multi-minute
 * refresh streams a "ComponentType: N" line per type instead of a single
 * silent total. Types with zero nodes are not reported (no noise for the
 * dozens of families a given org doesn't use).
 *
 * @example
 *   const counts = await renderVault(store, '/path/org-kb');
 *   console.log(counts.components.CustomField);
 */
export const renderVault = async (
  store: GraphStore,
  vaultRoot: string,
  onType?: (type: ComponentType, count: number) => void,
): Promise<RenderCounts> => {
  const components: Partial<Record<ComponentType, number>> = {};
  const edges: Partial<Record<EdgeType, number>> = {};
  const allNodes: Node[] = [];

  for (const type of SUPPORTED_TYPES) {
    let offset = 0;
    while (true) {
      const nodesResult = await listNodesByType(store, type, {
        limit: RENDER_PAGE_SIZE,
        offset,
      });
      if (!nodesResult.ok) {
        throw new Error(`listNodesByType(${type}) failed: ${nodesResult.error.message}`);
      }
      const page = nodesResult.value;
      if (page.length === 0) break;
      const nodes = [...page].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      // CR-17: fetch every incident edge for the whole page in ONE batched
      // `listEdgesForNodes` query (direction='both', matching the old
      // per-node `listEdges(node.id)`), instead of an N+1 loop of one
      // `listEdges` per node. The helper partitions edges per node and sorts
      // each bucket by the deterministic `(toId, edgeType, fromId, source)`
      // total order, so `writeNodeDocument` gets a byte-stable input — the
      // renderers' `renderEdgeSubsection` re-sorts only by endpointId, and
      // this total order pins the otherwise-undefined intra-endpoint order.
      const pageEdges = await listEdgesForNodes(
        store,
        nodes.map((n) => n.id),
        { direction: 'both' },
      );
      if (!pageEdges.ok) {
        throw new Error(`listEdgesForNodes(${type}) failed: ${pageEdges.error.message}`);
      }
      for (const node of nodes) {
        const nodeEdges = pageEdges.value.get(node.id) ?? [];
        // Count outgoing edges only; BOTH-direction listing would double-count.
        for (const edge of nodeEdges) {
          if (edge.fromId === node.id) {
            edges[edge.edgeType] = (edges[edge.edgeType] ?? 0) + 1;
          }
        }
        await writeNodeDocument(vaultRoot, node, nodeEdges);
        components[type] = (components[type] ?? 0) + 1;
        allNodes.push(node);
      }
      // A short page means we've drained this type; no need to query again.
      if (page.length < RENDER_PAGE_SIZE) break;
      offset += page.length;
    }
    // Emit per-type progress the moment the type is fully drained, so the
    // stream reflects render order rather than waiting for the whole tally.
    const rendered = components[type];
    if (onType !== undefined && rendered !== undefined && rendered > 0) {
      onType(type, rendered);
    }
  }

  await writeIndex(vaultRoot, allNodes);
  return { components, edges };
};

/**
 * Bridge from a `--types` CLI string ("CustomObject,Flow") to the typed
 * Set the walker expects. Unknown type tokens are silently dropped —
 * the CLI surface is best-effort, not strict validation.
 *
 * @example
 *   parseTypeFilter('CustomObject,Flow')
 *   // => Set(['CustomObject', 'Flow'])
 */
export const parseTypeFilter = (
  raw: string | undefined,
): ReadonlySet<SupportedType> | null => {
  if (raw === undefined || raw.trim() === '') return null;
  const supported = new Set<SupportedType>();
  for (const t of raw.split(',').map((s) => s.trim())) {
    if (SUPPORTED_TYPES.includes(t as SupportedType)) {
      supported.add(t as SupportedType);
    }
  }
  return supported.size === 0 ? null : supported;
};
