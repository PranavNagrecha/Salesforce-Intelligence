import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

import type {
  ComponentType,
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
  extractBusinessProcess,
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
  extractCustomTab,
  extractDecisionTable,
  extractDashboard,
  extractDuplicateRule,
  extractEmailTemplate,
  extractEscalationRule,
  extractFlexiPage,
  extractExternalDataSource,
  extractExternalService,
  extractFieldSet,
  extractFlow,
  extractGlobalValueSet,
  extractGroup,
  extractInstalledPackage,
  extractLayout,
  extractLetterhead,
  extractLightningComponentBundle,
  extractListView,
  extractMatchingRule,
  extractMutingPermissionSet,
  extractNamedCredential,
  extractNetworkAccess,
  extractOmniDataTransform,
  extractOmniIntegrationProcedure,
  extractOmniScript,
  extractOmniUiCard,
  extractPathAssistant,
  extractPermissionSetGroup,
  extractPermissionSet,
  extractPlatformEventChannel,
  extractPlatformEventChannelMember,
  extractProfile,
  extractQueue,
  extractQuickAction,
  extractRecordType,
  extractReport,
  extractReportType,
  extractRemoteSiteSetting,
  extractRestrictionRule,
  extractRole,
  extractScopingRule,
  extractSharingRules,
  extractStaticResource,
  extractValidationRule,
  extractVisualforceComponent,
  extractVisualforcePage,
  extractWebLink,
  extractWorkflowRule,
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
 * invalidates it; this constant covers same-version extractor changes.
 */
export const EXTRACT_CACHE_VERSION = 1;

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
 * via the existing `parentOf` edge; no new EdgeType is introduced).
 *
 * Directories that don't exist under `source/` are skipped cleanly by
 * `walkDir`'s readdir try/catch — orgs without the v1.1 / v1.2 / v1.3 /
 * v1.4 / v1.5 / v1.6 directories (the edu-org fixture has no v1.1
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
  'BusinessProcess',
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
  'CustomTab',
  'DecisionTable',
  'Dashboard',
  'DuplicateRule',
  'EmailTemplate',
  'EscalationRule',
  'ExternalDataSource',
  'ExternalService',
  'FieldSet',
  'FlexiPage',
  'Flow',
  'GlobalValueSet',
  'Group',
  'Index',
  'InstalledPackage',
  'Layout',
  'Letterhead',
  'LightningComponentBundle',
  'ListView',
  'MatchingRule',
  'MutingPermissionSet',
  'NamedCredential',
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
  'Profile',
  'Queue',
  'QuickAction',
  'RecordType',
  'RemoteSiteSetting',
  'Report',
  'ReportType',
  'RestrictionRule',
  'Role',
  'ScopingRule',
  'SharingRule',
  'StaticResource',
  'ValidationRule',
  'VisualforceComponent',
  'VisualforcePage',
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
  BusinessProcess: extractBusinessProcess,
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
  CustomTab: extractCustomTab,
  DecisionTable: extractDecisionTable,
  Dashboard: extractDashboard,
  DuplicateRule: extractDuplicateRule,
  EmailTemplate: extractEmailTemplate,
  EscalationRule: extractEscalationRule,
  ExternalDataSource: extractExternalDataSource,
  ExternalService: extractExternalService,
  FieldSet: extractFieldSet,
  FlexiPage: extractFlexiPage,
  Flow: extractFlow,
  GlobalValueSet: extractGlobalValueSet,
  Group: extractGroup,
  Index: extractCustomIndex,
  InstalledPackage: extractInstalledPackage,
  Layout: extractLayout,
  Letterhead: extractLetterhead,
  LightningComponentBundle: extractLightningComponentBundle,
  ListView: extractListView,
  MatchingRule: extractMatchingRule,
  MutingPermissionSet: extractMutingPermissionSet,
  NamedCredential: extractNamedCredential,
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
  Profile: extractProfile,
  Queue: extractQueue,
  QuickAction: extractQuickAction,
  RecordType: extractRecordType,
  Report: extractReport,
  ReportType: extractReportType,
  RemoteSiteSetting: extractRemoteSiteSetting,
  RestrictionRule: extractRestrictionRule,
  Role: extractRole,
  ScopingRule: extractScopingRule,
  SharingRule: extractSharingRules,
  StaticResource: extractStaticResource,
  ValidationRule: extractValidationRule,
  VisualforceComponent: extractVisualforceComponent,
  VisualforcePage: extractVisualforcePage,
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
 */
const BUNDLE_PARENT_DIRS = new Set<string>(['lwc', 'aura']);

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
 * Used by coverage reporting to attribute extractor failures to a type.
 */
export const componentTypeFromSourcePath = (
  sourceRoot: string,
  absPath: string,
  isDirectory = false,
): SupportedType | null => {
  const segments = relativeSegments(sourceRoot, absPath);
  const fileName = isDirectory
    ? basename(absPath)
    : (segments[segments.length - 1] ?? basename(absPath));
  const dirSegments = isDirectory ? segments : segments.slice(0, -1);
  return dispatchFile(dirSegments, fileName, isDirectory);
};

/** Report / Dashboard usage is folded onto fields rather than kept as nodes. */
const FOLD_TO_FIELD_USAGE: ReadonlySet<ComponentType> = new Set(['Report', 'Dashboard']);

/**
 * Fold Report / Dashboard field usage onto the referenced `CustomField` nodes,
 * then drop the Report / Dashboard nodes and their edges.
 *
 * Reports and Dashboards are folder-based and high-volume (thousands on a large
 * org), and the only thing we need from them for analysis is "this field is used
 * by a report/dashboard" — so we deliberately do NOT persist a node per report.
 * This pass harvests each Report/Dashboard's `references` field-edges, stamps
 * `usedInReport` / `usedInDashboard` on the target `CustomField` nodes (so the
 * unused-field tools stop false-flagging a field whose only use is a report
 * column or dashboard component), and removes the heavyweight report/dashboard
 * nodes + edges so they never bloat the graph. Pure transform; every other type
 * (FlexiPage, etc.) passes through untouched. A no-op when no report/dashboard
 * was retrieved.
 */
export const foldReportDashboardUsageIntoFields = (
  results: readonly ExtractionResult[],
): readonly ExtractionResult[] => {
  const foldedNodeIds = new Set<string>();
  for (const r of results) {
    for (const n of r.nodes) {
      if (FOLD_TO_FIELD_USAGE.has(n.type)) foldedNodeIds.add(n.id);
    }
  }
  if (foldedNodeIds.size === 0) return results;

  const usedInReport = new Set<string>();
  const usedInDashboard = new Set<string>();
  for (const r of results) {
    for (const e of r.edges) {
      if (e.edgeType !== 'references' || !foldedNodeIds.has(e.fromId)) continue;
      if (!e.toId.startsWith('CustomField:')) continue;
      if (e.fromId.startsWith('Report:')) usedInReport.add(e.toId);
      else if (e.fromId.startsWith('Dashboard:')) usedInDashboard.add(e.toId);
    }
  }

  return results.map((r) => ({
    ...r,
    nodes: r.nodes
      .filter((n) => !FOLD_TO_FIELD_USAGE.has(n.type))
      .map((n): Node => {
        if (n.type !== 'CustomField') return n;
        const inReport = usedInReport.has(n.id);
        const inDashboard = usedInDashboard.has(n.id);
        if (!inReport && !inDashboard) return n;
        return {
          ...n,
          properties: {
            ...n.properties,
            ...(inReport ? { usedInReport: true } : {}),
            ...(inDashboard ? { usedInDashboard: true } : {}),
          },
        };
      }),
    edges: r.edges.filter(
      (e) => !foldedNodeIds.has(e.fromId) && !foldedNodeIds.has(e.toId),
    ),
  }));
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
      // holes, so a permanent false positive erodes its signal).
      if (!isKnownSidecar(fileName) && !dirSegments.includes('staticresources')) {
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
