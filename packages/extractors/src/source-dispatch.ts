/**
 * Source-path → metadata-type dispatch, shared by every consumer that has to
 * turn a DX source path into a component type: the refresh walker (which
 * picks the extractor), `sfi review-change --diff`, and the MCP
 * `sfi.review_change` `sourcePaths` input. It lived inside the CLI's refresh
 * pipeline, where the MCP server could not reach it; a second copy there
 * would drift the first time a family is added. One table, three callers.
 */

import type { ComponentType } from '@sf-intelligence/contracts';

import * as omnistudio from './omnistudio/index.js';

/**
 * Names whose direct child directories are dispatched as bundle units
 * (their basename becomes the bundle's API name; their children are NOT
 * walked further). LWC and Aura are the two v1.4 bundle types.
 *
 * Listed here rather than baked into a free-standing `if` inside
 * `walkDir` so a future bundle-shaped metadata type can be added by
 * extending this set and adding the matching dispatch branch in
 * `dispatchSourceFile` — no second edit to the walker required.
 *
 * Exported so consumers OUTSIDE the walker (e.g. `sfi review-change`'s
 * `git diff` path mapper, R6-29) that need to locate a bundle's parent
 * directory within an arbitrary path do not hand-maintain a second copy
 * of this list.
 */
export const BUNDLE_PARENT_DIRS: ReadonlySet<string> = new Set<string>(['lwc', 'aura']);

/**
 * Types whose ONE source file is a container the extractor fans out into many
 * components (`labels/CustomLabels.labels-meta.xml`, one
 * `sharingRules/{Obj}.sharingRules-meta.xml` per object, …). A path that
 * dispatches to one of these names a FILE, not a component: a consumer that
 * maps a changed path to a component must not invent `SharingRule:{Obj}`.
 */
export const CONTAINER_FILE_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'CustomLabel',
  'SharingRule',
  'WorkflowRule',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  'MatchingRule',
]);

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
export const dispatchSourceFile = (
  segments: readonly string[],
  fileName: string,
  isDirectory: boolean,
): ComponentType | null => {
  // v1.4 bundle directories. The unit of dispatch is the bundle dir
  // itself; `fileName` here is the bundle's basename (the LWC / Aura
  // API name). Short-circuit before the file-based dispatch matrix
  // because bundles can't match any file suffix.
  if (isDirectory) {
    const parentDir = segments[segments.length - 1];
    if (parentDir === 'lwc') return 'LightningComponentBundle';
    if (parentDir === 'aura') return 'AuraDefinitionBundle';
    // A managed-package (Vlocity) DataPack folder — `<Kind>/<Key>/` — is one
    // OmniStudio component; its extractor reads the main file and siblings.
    return omnistudio.dataPackComponentType(segments, fileName, true);
  }
  // The DataPack's main file itself (`<Kind>/<Key>/<Key>_DataPack.json`), for
  // callers that classify by file (deletion reconcile, review-change).
  const dataPackType = omnistudio.dataPackComponentType(segments, fileName, false);
  if (dataPackType !== null) return dataPackType;
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
  // Org security-settings tier. Salesforce delivers these under the generic
  // `settings/` container (shared by every `*Settings` metadata type), so the
  // discriminant is the FILENAME, not the directory — matching on `settings/`
  // alone would falsely claim coverage over the other settings files (Search,
  // Chatter, …).
  //
  // BUG FIXED (0.3.1): this matched `Session.settings-meta.xml` — a file
  // Salesforce NEVER emits. Session settings are a NESTED `<sessionSettings>`
  // block inside `Security.settings-meta.xml` (root `<SecuritySettings>`), so
  // the file was silently counted as an uncovered `settings` skip on every org
  // while the SessionSettings coverage row still read
  // `retrieveConfirmed: true, retrieved: 0` — a confirmed-empty claim that is
  // impossible for an org-level singleton.
  //
  // One file, two org-level singletons: `extractSecuritySettings` co-emits
  // `SecuritySettings:default` and `SessionSettings:default` (see
  // CO_EMITTED_TYPES for how `--types SessionSettings` still reaches it).
  if (segments.includes('settings') && fileName === 'Security.settings-meta.xml') return 'SecuritySettings';
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
