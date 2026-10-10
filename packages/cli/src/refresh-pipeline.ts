import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type {
  ComponentType,
  Edge,
  EdgeType,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { splitPathSegments } from '@sf-intelligence/core';
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
  extractSecuritySettings,
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
  BUNDLE_PARENT_DIRS,
  dispatchSourceFile,
  omnistudio,
  standardLookupTargets,
  UNRESOLVED_PROFILE_PREFIX,
} from '@sf-intelligence/extractors';
import {
  type DuplicateSourceSummary,
  listEdgesForNodes,
  listNodesByType,
  resolveDuplicateSourcePaths,
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
   * Present ONLY when this walk found the same component at more than one
   * source path — i.e. the vault's `source/` tree holds two copies of the same
   * retrieval target (a legacy flat tree beside the DX `main/default` tree).
   * The walk hands back the RESOLVED results (one copy per component, conflicts
   * flagged); this field is the roll-up the refresh writes to the manifest so
   * `health_check` and `get_manifest` can say the vault was assembled from more
   * than one retrieval. Absent on a normal vault.
   */
  readonly duplicateSourcePaths?: DuplicateSourceSummary;
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
  'SecuritySettings',
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
 * Types whose nodes are produced by ANOTHER type's extractor, because one
 * source file carries both.
 *
 * `settings/Security.settings-meta.xml` dispatches to `SecuritySettings`, whose
 * extractor co-emits `SessionSettings:default` from the same parse (the session
 * block is nested inside that file — Salesforce emits no session settings file
 * of its own). Without this map a `--types SessionSettings` run would filter out
 * the only file that can produce the node and extract nothing at all: the exact
 * silent-drop class this tier's bug belonged to.
 */
const CO_EMITTED_TYPES: Readonly<Partial<Record<SupportedType, readonly SupportedType[]>>> = {
  SecuritySettings: ['SessionSettings'],
};

/** True when `type`'s extractor also emits a node for a type the filter asked for. */
const coEmits = (
  type: SupportedType,
  typeFilter: ReadonlySet<SupportedType>,
): boolean => (CO_EMITTED_TYPES[type] ?? []).some((co) => typeFilter.has(co));

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
  // ONE file, TWO org-level singletons: `Security.settings-meta.xml` is
  // dispatched here and `extractSecuritySettings` co-emits BOTH
  // `SecuritySettings:default` and `SessionSettings:default` from a single
  // parse (the session block is nested inside it and has no file of its own).
  // The `SessionSettings` entry below stays bound to the session-only
  // extractor for registration parity; the walker never selects it, because no
  // file dispatches to that type. `--types SessionSettings` reaches the same
  // file through CO_EMITTED_TYPES and runs THIS entry, which emits both nodes.
  SecuritySettings: extractSecuritySettings,
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
 * The shared source-path dispatcher (`@sf-intelligence/extractors`), narrowed
 * to the types this walker has an extractor for. A dispatched type with no
 * registered extractor reads as "not a supported file" — the same outcome an
 * unrecognised path always had.
 */
export { BUNDLE_PARENT_DIRS };
const SUPPORTED_TYPE_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_TYPES);
const isSupportedType = (t: ComponentType): t is SupportedType => SUPPORTED_TYPE_SET.has(t);
const dispatchFile = (
  segments: readonly string[],
  fileName: string,
  isDirectory: boolean,
): SupportedType | null => {
  const t = dispatchSourceFile(segments, fileName, isDirectory);
  return t !== null && isSupportedType(t) ? t : null;
};


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

/** True when a directory holds a Vlocity DataPack main file (`*_DataPack.json`). */
const holdsDataPack = async (dir: string): Promise<boolean> => {
  try {
    return (await readdir(dir)).some((name) => omnistudio.isDataPackPath(name));
  } catch {
    return false;
  }
};

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
  const isDataPackParent = omnistudio.dataPackKindOfDir(currentName) !== null;
  for (const entry of sorted) {
    const abs = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (isBundleParent || (isDataPackParent && (await holdsDataPack(abs)))) {
        // Bundle directory (an LWC / Aura bundle, or a Vlocity DataPack
        // folder): emit as a single dispatch unit; do NOT recurse. The
        // extractor reads the children itself — and a DataPack's sibling
        // files (`…_PropertySet.json`, `…_Mappings.json`) are part of it.
        found.push({ path: abs, isDirectory: true });
      } else {
        await walkDir(abs, found);
      }
    } else if (entry.isFile()) {
      found.push({ path: abs, isDirectory: false });
    }
  }
};

/**
 * Path segments of `absPath` relative to `rootDir`, accepting either separator.
 *
 * Two callers with contradictory inputs meet here, which is why the hardcoded
 * `sep` was wrong in both directions:
 *
 *  - the refresh walk passes a native absolute path under a native `rootDir`;
 *  - `review-change` passes `rootDir: ''` and a path straight out of
 *    `git diff --name-only`, which emits FORWARD slashes on every platform.
 *
 * With `sep === '\\'` the second caller produced ONE segment, so every
 * `segments.includes('classes' | 'objects' | …)` test missed, every changed
 * file failed to dispatch to a type, the findings list came back empty, and the
 * deploy gate printed "Nothing to gate" and exited 0 with
 * `overallVerdict: 'safe'` — a field deletion with 40 dependents sails through.
 * A gate that passes because it parsed nothing is worse than one that fails.
 *
 * `splitPathSegments` also drops empty segments, which is what makes the
 * `rootDir: ''` caller work rather than yielding a leading `''`.
 */
const relativeSegments = (rootDir: string, absPath: string): readonly string[] => {
  const rootSegments = splitPathSegments(rootDir);
  const absSegments = splitPathSegments(absPath);
  const isUnderRoot =
    rootSegments.length > 0 &&
    rootSegments.length <= absSegments.length &&
    rootSegments.every((seg, i) => absSegments[i] === seg);
  return isUnderRoot ? absSegments.slice(rootSegments.length) : absSegments;
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

/** `source` of the edges {@link resolveRecordFilterPathEdges} mints. */
export const RECORD_FILTER_PATH_SOURCE = 'record-filter-path-resolver';

/** Rule types whose nodes carry `recordFilterPaths`. */
const RECORD_FILTER_RULE_TYPES: ReadonlySet<string> = new Set(['RestrictionRule', 'ScopingRule']);

/** The lookup field a relationship hop names: `Advisor__r` → `Advisor__c`, `Account` → `AccountId`. */
const relationshipLookupField = (segment: string): string =>
  /__r$/i.test(segment) ? `${segment.slice(0, -3)}__c` : `${segment}Id`;

/**
 * Resolve each RestrictionRule / ScopingRule `recordFilterPaths` entry
 * (`Advisor__r.Region__c`) through the vault's lookups and mint a parsed
 * `references` edge from the rule to every field the path tests: each lookup it
 * hops through and the field it ends on, on the RELATED object. Salesforce
 * refuses to delete a field a rule's filter names, so without these edges the
 * field read "no sharing referrer" while a rule tested it.
 *
 * A hop's target object comes from the lookup's `lookupTo` edges, or the
 * curated standard-relationship table for a standard lookup (`Account` →
 * `AccountId`); a polymorphic hop follows every target. Each minted edge carries
 * `recordFilterPath` and `pathRole` (`hop` | `tail`). A path whose hop has no
 * known target, or whose custom tail field is on no resolved object, is listed
 * in the node's `unresolvedRecordFilterPaths`; `safe_to_delete_field` hedges a
 * field such a path may end on rather than read it as unreferenced.
 *
 * Pure transform; the SAME array when no rule carries a path.
 */
export const resolveRecordFilterPathEdges = (
  results: readonly ExtractionResult[],
): readonly ExtractionResult[] => {
  const rulePaths = (n: Node): readonly string[] => {
    const paths = n.properties['recordFilterPaths'];
    return RECORD_FILTER_RULE_TYPES.has(n.type) &&
      n.parentId?.startsWith('CustomObject:') === true &&
      Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === 'string')
      : [];
  };
  if (!results.some((r) => r.nodes.some((n) => rulePaths(n).length > 0))) return results;

  // Case-insensitive: a filter may spell a field in any case.
  const fieldIds = new Map<string, string>();
  const lookupTo = new Map<string, Set<string>>();
  for (const r of results) {
    for (const n of r.nodes) {
      if (n.type === 'CustomField') fieldIds.set(n.id.toLowerCase(), n.id);
    }
    for (const e of r.edges) {
      if (e.edgeType !== 'lookupTo' || !e.toId.startsWith('CustomObject:')) continue;
      const key = e.fromId.toLowerCase();
      const targets = lookupTo.get(key) ?? new Set<string>();
      targets.add(e.toId.slice('CustomObject:'.length));
      lookupTo.set(key, targets);
    }
  }
  const fieldId = (object: string, field: string): string | undefined =>
    fieldIds.get(`customfield:${object}.${field}`.toLowerCase());
  const hopTargets = (object: string, field: string): readonly string[] => {
    const declared = lookupTo.get(`customfield:${object}.${field}`.toLowerCase());
    return declared !== undefined && declared.size > 0
      ? [...declared].sort()
      : standardLookupTargets(object, field);
  };

  return results.map((r) => {
    if (!r.nodes.some((n) => rulePaths(n).length > 0)) return r;
    const added: Edge[] = [];
    const nodes = r.nodes.map((n): Node => {
      const paths = rulePaths(n);
      if (paths.length === 0) return n;
      const ruleObject = (n.parentId as string).slice('CustomObject:'.length);
      const held = new Set(r.edges.filter((e) => e.fromId === n.id).map((e) => e.toId.toLowerCase()));
      const mint = (toId: string, path: string, pathRole: 'hop' | 'tail'): void => {
        if (held.has(toId.toLowerCase())) return;
        held.add(toId.toLowerCase());
        added.push({
          fromId: n.id,
          toId,
          edgeType: 'references',
          confidence: 'parsed',
          source: RECORD_FILTER_PATH_SOURCE,
          properties: { referenceKind: 'recordFilterPath', recordFilterPath: path, pathRole },
        });
      };
      const unresolved: string[] = [];
      for (const path of paths) {
        const segments = path.split('.');
        const tail = segments[segments.length - 1] as string;
        let objects: readonly string[] = [ruleObject];
        let resolved = true;
        for (const segment of segments.slice(0, -1)) {
          const lookupField = relationshipLookupField(segment);
          const next = new Set<string>();
          for (const object of objects) {
            const id = fieldId(object, lookupField);
            if (id !== undefined) mint(id, path, 'hop');
            for (const target of hopTargets(object, lookupField)) next.add(target);
          }
          if (next.size === 0) {
            resolved = false;
            break;
          }
          objects = [...next].sort();
        }
        if (resolved) {
          const tails = objects.map((o) => fieldId(o, tail)).filter((id): id is string => id !== undefined);
          // An absent STANDARD tail (`Id`, `Name`) is a field that cannot be
          // deleted; an absent custom one is a field this pass could not place.
          if (tails.length === 0 && /__c$/i.test(tail)) resolved = false;
          // Mark the tail edge only after the hops: same id held twice is one edge.
          for (const id of tails) mint(id, path, 'tail');
        }
        if (!resolved) unresolved.push(path);
      }
      return unresolved.length > 0
        ? { ...n, properties: { ...n.properties, unresolvedRecordFilterPaths: unresolved } }
        : n;
    });
    return added.length === 0 && nodes.every((n, i) => n === r.nodes[i])
      ? r
      : { ...r, nodes, edges: [...r.edges, ...added] };
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
    if (typeFilter !== null && !typeFilter.has(type) && !coEmits(type, typeFilter)) continue;

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
  // Resolve duplicate source paths BEFORE the results leave the walker, so the
  // graph import, the change-set diff (`--incremental-graph`) and the vault
  // renderer all see the SAME single copy per component. Doing it here rather
  // than only inside `importExtractionResults` matters for the incremental
  // path: a change-set computed from unresolved results would disagree with an
  // import that resolved them. The cache above deliberately keeps the RAW
  // per-file results, so the next refresh re-resolves from scratch.
  const resolvedDuplicates = resolveDuplicateSourcePaths(results);
  return {
    results: resolvedDuplicates.results,
    failures,
    skippedDirectories,
    ...(resolvedDuplicates.summary !== null
      ? { duplicateSourcePaths: resolvedDuplicates.summary }
      : {}),
    cache,
    reusedCount,
  };
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
