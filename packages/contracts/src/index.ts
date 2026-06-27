/**
 * @sf-intelligence/contracts
 *
 * Frozen types crossing package boundaries. This file is the schema for the
 * entire project. Workers may not modify this file. If a contract needs to
 * change, write a `needs_human` journal entry and stop.
 *
 * Conventions:
 *   - Types only. No runtime code. (Helpers like `ok`/`err` live in @sf-intelligence/core.)
 *   - Every interface is `readonly` on every field.
 *   - Every string-literal union is exhaustive at the time of the freeze;
 *     extending a union requires editing this file and bumping the
 *     contract version.
 */

// ============================================================================
// Result type
// ============================================================================

/**
 * A typed result. Use instead of throwing for expected errors.
 *
 * Constructed via `ok()` and `err()` helpers in `@sf-intelligence/core`.
 *
 * @example
 *   const parsed: Result<number, string> = parseNumber('42');
 *   if (parsed.ok) {
 *     console.log(parsed.value); // 42
 *   } else {
 *     console.error(parsed.error);
 *   }
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// ============================================================================
// Component identity
// ============================================================================

/**
 * The set of Salesforce metadata component types `sf-intelligence` knows about.
 *
 * The validation slice exercises only `CustomObject` and `CustomField`. v0.2
 * and v0.3 did not extend this union — only edge types. v1.1 added the
 * sharing & visibility tier (`Group`, `Queue`, `Role`, `SharingRule`). v1.2
 * added the record-types + UI-surfaces tier (`RecordType`, `BusinessProcess`,
 * `CustomTab`, `CustomApplication`, `QuickAction`, `PathAssistant`,
 * `GlobalValueSet`, `CustomLabel`, `StaticResource`). v1.3 added the
 * legacy-automation + communications tier (`WorkflowRule`, `ApprovalProcess`,
 * `AssignmentRule`, `AutoResponseRule`, `EscalationRule`, `DuplicateRule`,
 * `MatchingRule`, `EmailTemplate`, `Letterhead`). v1.4 adds the developer
 * frontend + test mapping tier (`LightningComponentBundle`,
 * `AuraDefinitionBundle`, `VisualforcePage`, `VisualforceComponent`); the
 * extractors land across v1.4 R2-R4 and `sfi.find_apex_usages` is broadened
 * to `sfi.find_code_usages` (alias preserved) in v1.4 R5. v1.5 adds the
 * integration topology + event/async/API surface tier (`AuthProvider`,
 * `RemoteSiteSetting`, `CspTrustedSite`, `ExternalDataSource`,
 * `ExternalService`, `NetworkAccess`) — the six metadata families that
 * answer the architect's "draw me our integration map" question.
 * `ExternalDataSource` carries a single `references` edge to its declared
 * `AuthProvider`; `ExternalService` carries a single `references` to its
 * declared `NamedCredential`; the other four produce zero edges of their
 * own. v1.5 also unlocks the reserved `listensTo` edge (Platform Event
 * subscribers; emitted by the existing apex-trigger / apex-class / flow
 * extractors against `__e`-suffixed CustomObject targets) and adds two
 * new EdgeTypes (`exposes`, `dispatchesAsync`) — see the `EdgeType` union
 * below. v1.6 adds the business-user record-value tier
 * (`CustomMetadataRecord`, `CustomSettingRecord`) — record (row)
 * instances of `__mdt` Custom Metadata Types and Custom Setting types,
 * attached to their parent type via the existing `parentOf` edge
 * (mirroring the v1.0 CustomField → CustomObject pattern; no new
 * EdgeType). Until those workers ship, the new members are valid targets
 * for ad-hoc graph nodes but produce no extractor output. v2.0a adds the
 * conditional-context tier: a single synthetic `ConditionalContext`
 * ComponentType that represents one extracted firing condition (criteria
 * block, formula expression, Flow decision, or Flow record-trigger
 * filter). Synthetic ids follow the pattern
 * `ConditionalContext:{ParentFirerId}.condition-{index}` (mirroring v1.5's
 * `ExternalApi:{kind}/{path}` convention); the new type pairs with the
 * v2.0a `firesWhen` EdgeType. See
 * `docs/vendor/salesforce-metadata/ConditionalContextSemantics.md` for
 * the full per-firer extraction rules and the deferred-extraction
 * boundary (Apex if-guards, per-step approval criteria, Process Builder,
 * UI conditional-rendering directives, time-based firing). v3.2 adds
 * the OmniStudio / Salesforce Industries declarative-process tier:
 * `OmniScript` (the user-facing no-code form flow,
 * `.os-meta.xml`), `OmniIntegrationProcedure` (the server-side
 * action-chain orchestrator, `.oip-meta.xml`), `OmniDataTransform`
 * (the DataRaptor mapping primitive, `.rpt-meta.xml`), `OmniUiCard`
 * (the FlexCard widget-canvas primitive, `.ouc-meta.xml`), and
 * `DecisionTable` (the declarative rule-table primitive,
 * `.decisionTable-meta.xml`). The recon (journal 0157) found
 * Globex's sandbox silently skipped 1,474 OmniStudio files
 * while reporting `kind: "fresh"`; v3.2 closes that extraction gap.
 * The v3.1 roadmap-closure framing was conditional on the buyer-
 * interview cohort; v3.2 corrects it to acknowledge the OmniStudio
 * extraction tier was missing from the cohort's question shapes.
 * The four v3.1 out-of-roadmap zones (live-state, record-level,
 * write-side, cross-org-deep-diff) remain intact. v3.2 ships the
 * 5 ComponentTypes plus one new EdgeType (`dispatchesOmniAction`)
 * for the intra-OmniStudio call chain; the Apex-to-OmniProcess
 * coupling edge (`implementsOmniInterface`) is a v3.3 follow-up,
 * NOT in v3.2. Recognizes Industries Native XML shapes only;
 * Vlocity-Legacy managed-package components (namespace
 * `vlocity_cmt__`) are NOT extracted by v3.2. See per-type docs
 * in `docs/vendor/salesforce-metadata/OmniScript.md`,
 * `.../OmniIntegrationProcedure.md`, `.../OmniDataTransform.md`,
 * `.../OmniUiCard.md`, `.../DecisionTable.md`.
 */
export type ComponentType =
  | 'CustomObject'
  | 'CustomField'
  | 'ValidationRule'
  | 'Flow'
  | 'ApexClass'
  | 'ApexTrigger'
  | 'Layout'
  | 'Profile'
  | 'PermissionSet'
  | 'PermissionSetAssignment'
  | 'NamedCredential'
  | 'ConnectedApp'
  // v1.1 — sharing & visibility tier.
  | 'Group'
  | 'Queue'
  | 'Role'
  | 'SharingRule'
  // v1.2 — record types + UI surfaces tier.
  | 'RecordType' //          per-object; governs which layout / picklist / process variant a user sees.
  | 'BusinessProcess' //     stage-gating variant referenced by a RecordType (Lead/Opportunity/Case).
  | 'CustomTab' //           a tab entry in the app navigator.
  | 'CustomApplication' //   the app shell — a collection of tabs + UI theme.
  | 'QuickAction' //         action buttons on layouts and related lists.
  | 'PathAssistant' //       sales/case path UI; tied to a RecordType via parentOf.
  | 'GlobalValueSet' //      org-wide picklist values reused across fields.
  | 'CustomLabel' //         translation / string resource.
  | 'StaticResource' //      image / zip / js asset referenced from VF or LWC.
  // v1.3 — legacy automation + communications tier.
  | 'WorkflowRule' //        per-object rule with field-update / email-alert / task / outbound-message actions.
  | 'ApprovalProcess' //     multi-step approval routing tied to a SObject (Lead/Opportunity/Case/Account).
  | 'AssignmentRule' //      Lead / Case routing rule with criteria → assigned User or Queue.
  | 'AutoResponseRule' //    Lead / Case auto-acknowledgement rule referencing an EmailTemplate.
  | 'EscalationRule' //      Case escalation rule with time-based criteria → owner change + notifications.
  | 'DuplicateRule' //       per-object duplicate detection rule that invokes one or more MatchingRules.
  | 'MatchingRule' //        per-object fuzzy-match definition consumed by DuplicateRule.
  | 'EmailTemplate' //       org-wide or folder-scoped email body (text / html / custom / visualforce).
  | 'Letterhead' //          HTML letterhead styling reused by custom-html email templates.
  // v1.4 — developer frontend + test mapping tier.
  | 'LightningComponentBundle' // LWC bundle (`.js` + `.html` + `.js-meta.xml`); modern Lightning UI surface.
  | 'AuraDefinitionBundle' //    Aura bundle (`.cmp`/`.app`/`.evt` + `.js` controller/helper + `*-meta.xml`); legacy Lightning UI surface.
  | 'VisualforcePage' //         `.page` file with companion `.page-meta.xml`; pre-Lightning UI surface.
  | 'VisualforceComponent' //    `.component` file with companion `.component-meta.xml`; reusable VF building block.
  // v1.5 — integration topology + event/async/API surface tier.
  | 'AuthProvider' //            SSO / OAuth provider registration (`.authprovider-meta.xml`); the directly-named target of `ExternalDataSource.authProvider` and (in many orgs) `NamedCredential.authProvider`.
  | 'SamlSsoConfig' //           SAML SSO setting (`.samlssoconfig-meta.xml`); its `identityMapping` (Username | FederationId | UserId) is the authoritative source of which User field the IdP asserts as the login subject — the value-change tier gates the FederationIdentifier verdict on it.
  | 'RemoteSiteSetting' //       Single allowed outbound URL (`.remoteSite-meta.xml`); the pre-Named-Credential mechanism for outbound HTTP callouts.
  | 'CspTrustedSite' //          CSP allowlist entry (`.cspTrustedSite-meta.xml`) for browser-side fetches from LWC and Lightning Experience.
  | 'ExternalDataSource' //      Salesforce-Connect (OData / cross-org) data-source binding (`.dataSource-meta.xml`); carries a `references` edge to its declared `AuthProvider` when set.
  | 'ExternalService' //         `ExternalServiceRegistration` — invoke-an-OpenAPI-endpoint binding (`.externalServiceRegistration-meta.xml`); carries a `references` edge to its declared `NamedCredential` when set.
  | 'NetworkAccess' //           IP-range trust-list entry (`.networkAccess-meta.xml`). NOT the Network / Experience Cloud Site (a separate `Community` / `ExperienceBundle` metadata family; v1.5 scope explicitly excludes it).
  // v1.6 — business-user record-value tier.
  | 'CustomMetadataRecord' //    A single record (row) of a `__mdt` Custom Metadata Type; holds runtime-readable configured values. Attached to its `CustomObject:{TypeApiName}` parent via the existing `parentOf` edge (mirroring v1.0's CustomField → CustomObject pattern; no new EdgeType).
  | 'CustomSettingRecord' //     A single record of a List or Hierarchy Custom Setting; extracted ONLY when present in the DX source tree (rare — records typically live as data, requiring `sf data query`). Attached to its `CustomObject:{TypeApiName}` parent via the existing `parentOf` edge.
  // v2.0a — conditional-context tier (the master primitive for "when does this fire?").
  | 'ConditionalContext' //     Synthetic component representing one extracted firing condition belonging to a declarative firer (WorkflowRule, ValidationRule, ApprovalProcess, AutoResponseRule, AssignmentRule, EscalationRule, Flow). Id format `ConditionalContext:{ParentFirerId}.condition-{index}` mirrors v1.5's `ExternalApi:{kind}/{path}` synthetic-id convention. Properties carry `kind` (criteria | formula | flow-decision | flow-recordtrigger), `expression` (raw string), `fieldRefs` (CustomField ids referenced), and a `synthesized` flag (for nested-guard conjunctions; reserved for the deferred v2.0a.1 apex-scanner extension). Pairs with the v2.0a `firesWhen` EdgeType. See `docs/vendor/salesforce-metadata/ConditionalContextSemantics.md`.
  // v2.8 — async + integration deep tier. OutboundMessage action targets
  // promoted from the dangling-by-design v1.3 references into a real
  // ComponentType so the `sfi.outbound_message_catalog` and
  // `sfi.endpoint_catalog` tools can enumerate them. Id format
  // `OutboundMessage:{ObjectApiName}.{Name}` mirrors the
  // `WorkflowFieldUpdate:` scoping convention; the parent edge is the
  // existing `parentOf` from `CustomObject:{ObjectApiName}` (mirroring
  // the v1.0 CustomField → CustomObject pattern; no new EdgeType).
  | 'OutboundMessage' //       SOAP-based outbound message embedded inside `*.workflow-meta.xml`'s `<outboundMessages>` collection. Carries `name`, `endpointUrl`, `includeSessionId`, `useDeadLetterQueue`, `integrationUser`, and `fields` (string array) properties. The endpoint URL is captured verbatim — v2.8 does NOT probe the URL, does NOT validate the destination exists, and does NOT confirm the message is actually invoked at runtime (the v2.8 honesty axis surfaced verbatim by `sfi.outbound_message_catalog`'s disclosure field). Triggered by `<outboundMessages>` child elements inside `*.workflow-meta.xml`. Pre-v2.8 these references dangled by design (per `WorkflowRule.md` § "outboundMessages"); v2.8 promotes them to real nodes so the integration catalog can list outbound destinations alongside RemoteSiteSetting and NamedCredential. See `docs/vendor/salesforce-metadata/AsyncTopologySemantics.md`.
  // v2.6a — CPQ specialist tier. Five typed CPQ ComponentTypes
  // recognized HEURISTICALLY from underlying CustomMetadataRecord /
  // CustomSettingRecord nodes when their apiName carries the `SBQQ__`
  // managed-package namespace prefix. The v2.6a specialization layer
  // sits on top of v1.6's record extractors — the original
  // `CustomMetadataRecord` / `CustomSettingRecord` nodes are NOT
  // re-extracted; a sibling node is emitted per recognized record so
  // the existing v1.6 lookup surfaces (`sfi.lookup_record`,
  // `sfi.explain_field`) continue to work uninterrupted. Confidence is
  // `heuristic` per the v2.1 recognizer convention — the SBQQ prefix
  // is the recognition signal, not a declared Salesforce metadata
  // marker. CPQ is a managed package; the namespace is its
  // structural fingerprint. Each CPQ ComponentType is parented by the
  // SBQQ__ CustomObject type definition via the existing `parentOf`
  // edge (no new EdgeType). Synthetic id format
  // `{CpqType}:{TypeApiName}.{RecordName}` mirrors v1.6's
  // CustomMetadataRecord scoping convention. See
  // `docs/vendor/salesforce-metadata/CpqSemantics.md`.
  | 'CpqProductRule' //        A CPQ Product Rule record — `SBQQ__ProductRule__c` namespace prefix on a CustomMetadataRecord or CustomSettingRecord. Product rules either validate (block) or filter (show / hide options) based on conditions. The sibling node carries the recognized record's `conditionsMet`, `evaluationOrder`, and `active` properties when present plus the raw `values[]` mirror so downstream tools can reconstruct the original record without a second graph hop. Heuristic confidence — the SBQQ__ prefix is the recognition signal.
  | 'CpqPriceRule' //          A CPQ Price Rule record — `SBQQ__PriceRule__c` namespace prefix. Price rules modify per-line pricing based on declared conditions; carry `conditionsMet`, `evaluationOrder`, `active`, and `calculatorEvaluationEvent` when present. Heuristic confidence (SBQQ__ prefix recognition).
  | 'CpqQuoteTemplate' //      A CPQ Quote Template record — `SBQQ__QuoteTemplate__c` namespace prefix. Quote templates declare the rendered output structure (sections, field mappings, page break behavior) for generated quote PDFs. Carry `templateContentReference` (the `SBQQ__Template__c` reference), `sectionCount`, `active`, and the raw values mirror. Heuristic confidence.
  | 'CpqLookupQuery' //        A CPQ Lookup Query record — `SBQQ__LookupQuery__c` namespace prefix. Lookup queries express a single condition evaluated against a Price Rule's lookup data source; carry `matchType`, `field`, and `value` when present plus the values mirror. Heuristic confidence.
  | 'CpqConfigurationAttribute' //  A CPQ Configuration Attribute record — `SBQQ__ConfigurationAttribute__c` namespace prefix. Configuration attributes are question-and-answer style prompts attached to a bundle that capture a sales-rep value used in subsequent Price / Product Rules. Carry `targetField`, `position`, `applyImmediatelyContext`, `displayOrder`, and `required` when present. Heuristic confidence.
  // v3.2 — OmniStudio / Salesforce Industries declarative-process tier.
  // Five ComponentTypes closing the extraction gap the recon (journal 0157)
  // surfaced in Globex: 1,474 silently-skipped Industries metadata
  // files; 22,087 OmniProcess SObject records with zero graph footprint
  // before v3.2. Recognized via Industries Native XML shapes (no managed-
  // package namespace prefix; standard `*-meta.xml` extensions in the
  // dedicated source-tree subdirectories `omniScripts/`,
  // `omniIntegrationProcedures/`, `omniDataTransforms/`, `omniUiCard/`,
  // `decisionTables/`). Vlocity-Legacy managed-package components
  // (namespace `vlocity_cmt__`) are NOT extracted by v3.2 — mid-migration
  // orgs may show partial coverage. The Q180 honesty anchor (skill's
  // `salesforce-industries-routing`) surfaces the Native-vs-Vlocity
  // boundary verbatim. See per-type vendored docs.
  | 'OmniScript' //                The user-facing no-code form flow. XML root `<OmniScript>`; file extension `.os-meta.xml`. Carries `<omniProcessElements>` children (steps, text blocks, inputs, action calls, navigate actions, Integration Procedure Actions, DataRaptor Extract Actions, Custom Lightning Web Components). Top-level `<omniProcessType>` is `OmniScript`. Each child carries `name`, `type`, `level`, `sequenceNumber`, `isActive`, and a `propertySetConfig` JSON blob (HTML-entity-escaped in the source XML). Properties surface `omniProcessType`, `omniProcessKey`, `versionNumber`, `language`, `subType`, `type` (the user-facing type discriminant, e.g., `AccountLinking`), `uniqueName`, `isActive`, `isWebCompEnabled`, `isOmniScriptEmbeddable`, `elementCount`. Emits `dispatchesOmniAction` edges for each Integration Procedure Action / DataRaptor Action / navigate-to-OmniScript child. See `docs/vendor/salesforce-metadata/OmniScript.md`.
  | 'OmniIntegrationProcedure' //  The server-side action-chain orchestrator. XML root `<OmniIntegrationProcedure>`; file extension `.oip-meta.xml`. Same `<omniProcessElements>` shape as OmniScript, but action child `type` values include `Rest Action`, `DataRaptor Extract Action`, `DataRaptor Transform Action`, `Response Action`, `Remote Action`, and nested `Integration Procedure Action`. Top-level `<omniProcessType>` is `Integration Procedure`. Properties: same as OmniScript plus `restEndpointCount` (count of Rest Action children with non-empty `restPath`), `dataRaptorCount`, `chainedIpCount`. Emits `dispatchesOmniAction` edges for each DataRaptor Extract/Transform action's `bundle` field, each Remote Action's `remoteClass.remoteMethod`, and each nested IP Action's `integrationProcedureKey`. See `docs/vendor/salesforce-metadata/OmniIntegrationProcedure.md`.
  | 'OmniDataTransform' //         The DataRaptor mapping primitive. XML root `<OmniDataTransform>`; file extension `.rpt-meta.xml`. Carries one-to-many `<omniDataTransformItem>` rows mapping `inputFieldName` → `outputFieldName`. Properties: `inputType` (typically `JSON` or `SObject`), `interfaceClass` (Extract / Load / Transform classification key), `transformItemCount`, `active`, `assignmentRulesUsed`, `nullInputsIncludedInOutput`, `description`. The optional `<expectedInputJson>` / `<expectedOutputJson>` elements carry sample payloads useful for downstream documentation; v3.2 surfaces them verbatim. Does NOT emit `dispatchesOmniAction` edges (DataRaptors are leaf-of-the-chain). See `docs/vendor/salesforce-metadata/OmniDataTransform.md`.
  | 'OmniUiCard' //                The FlexCard widget-canvas primitive. XML root `<OmniUiCard>`; file extension `.ouc-meta.xml`. Top-level XML elements are sparse (authorName, name, versionNumber, isActive, omniUiCardType); the bulk of the structural content lives inside a single `<propertySetConfig>` JSON blob (HTML-entity-escaped) containing a `states[]` array. Each state carries a `components` widget tree (Text, Block, Action, Datatable, Datatable Row, OmniScript embed, IP embed). The `<dataSourceConfig>` JSON declares the data source (`type`, `value`, `contextVariables`). Properties: `omniUiCardType` (`Parent` | `Child`), `authorName`, `versionNumber`, `isActive`, `isManagedUsingStdDesigner`, `stateCount`, `widgetCount`, `embeddedScriptCount`. Emits `dispatchesOmniAction` edges for each Action widget whose `actionList[].stateAction.type` is `OmniScript` or `Integration Procedure` (the target identity comes from `omniType.Name`). See `docs/vendor/salesforce-metadata/OmniUiCard.md`.
  | 'DecisionTable' //            The declarative rule-table primitive. XML root `<DecisionTable>`; file extension `.decisionTable-meta.xml`. Carries one-to-many `<decisionTableParameters>` rows tagged `usage: INPUT` or `usage: OUTPUT`. Properties: `setupName`, `dataSourceType` (`CsvUpload` | `SObject` | `Manual`), `sourceObject` (for `SObject` dataSourceType), `executionType` (`HBASE` | `OnPrem`), `usageType` (`Bre` for Business Rules Engine), `status` (`Draft` | `Active` | `Archived`), `type` (volume tier: `LowVolume` | `MediumVolume` | `HighVolume`), `conditionType` (`All` | `Any`), `conditionCriteria` (e.g., `1 AND 2 AND 3`), `doesConsiderNullValue`, `filterResultBy`, `inputParamCount`, `outputParamCount`. Row-level lookup data lives in CSV uploads or SObject records — NOT in the metadata XML. v3.2's extractor surfaces parameter shape only; row enumeration is the Q179 honesty anchor (out of scope per v3.1's record-level zone). Does NOT emit `dispatchesOmniAction` edges. See `docs/vendor/salesforce-metadata/DecisionTable.md`.
  // v4.0 — enterprise safety coverage tier.
  | 'Report'
  | 'Dashboard'
  | 'ListView'
  | 'ReportType'
  | 'FlexiPage'
  | 'PermissionSetGroup'
  | 'MutingPermissionSet'
  | 'RestrictionRule'
  | 'ScopingRule'
  // v4.x — decomposed CustomObject child metadata the dispatcher previously
  // skipped (the `compactLayouts/`, `webLinks/`, `fieldSets/`, `indexes/`
  // sub-trees — 135+ real components on a single mid-size org). Each is parented
  // by its CustomObject via `parentOf`; field-bearing children emit
  // `usedInLayout` (CompactLayout, FieldSet) or `references` (Index, WebLink
  // merge fields) edges so "where is field X used?" accounts for them.
  | 'CompactLayout' //  A compact-layout definition (`.compactLayout-meta.xml`) listing the few fields shown in the highlights panel / mobile card. `<fields>` are field API names; each emits a `usedInLayout` edge.
  | 'WebLink' //        An object button/link (`.webLink-meta.xml`). Carries `linkType`, `displayType`, `url`/`page` content. URL merge fields (`{!Object.Field}`) on the OWNING object emit heuristic `references` edges.
  | 'FieldSet' //       A field set (`.fieldSet-meta.xml`) — an ordered field group consumed by LWC/VF/managed packages. `<displayedFields>`/`<availableFields>` field API names each emit a `usedInLayout` edge.
  | 'Index' //          A custom index (`.index-meta.xml`). Indexed `<fields><name>` emit `references` edges (removing an indexed field breaks the index).
  | 'InstalledPackage'; // A managed/unlocked package installed in the org (`.installedPackage-meta.xml`). The fullName is the namespace prefix; `properties.versionNumber` is the installed version. Answers "what packages are installed?".

/**
 * A canonical component identifier.
 *
 * Format: `{ComponentType}:{ScopedApiName}` where `ScopedApiName` includes
 * any parent scope (e.g., `CustomField:Account.Industry__c`).
 *
 * Canonical IDs are stable across extraction runs and are the primary key
 * for the graph.
 *
 * @example
 *   const id: ComponentId = 'CustomField:Account.Industry__c';
 */
export type ComponentId = string;

// ============================================================================
// Confidence
// ============================================================================

/**
 * The confidence level of an extracted edge.
 *
 *   - `declared`: returned directly by Salesforce
 *     (e.g., MetadataComponentDependency).
 *   - `parsed`: produced by AST or XML parsing of source.
 *   - `heuristic`: produced by regex or dynamic-string analysis. May have
 *     false positives.
 *
 * Every edge carries a confidence. Renderers must surface confidence to
 * humans; consumers must not silently mix confidence levels.
 */
export type ConfidenceLevel = 'declared' | 'parsed' | 'heuristic';

// ============================================================================
// Enterprise trust contract
// ============================================================================

/**
 * Where a tool's answer came from. v4.0 keeps the MCP envelope stable and lets
 * higher-level tools expose this inside their tool-specific `data` payload.
 */
export type Provenance = 'offline_snapshot' | 'live_org' | 'hybrid';

/** A compact, reusable trust summary for enterprise-facing answers. */
export interface TrustSummary {
  readonly provenance: Provenance;
  readonly confidence: ConfidenceLevel | 'unknown';
  readonly freshness: Readonly<{
    readonly snapshotRefreshedAt?: string;
    readonly liveQueriedAt?: string;
  }>;
  readonly completeness: Readonly<{
    readonly status: 'complete' | 'partial' | 'unknown';
    readonly missingCoverage?: readonly string[];
  }>;
  readonly limitations: readonly string[];
}

// ============================================================================
// Graph nodes and edges
// ============================================================================

/**
 * A node in the org knowledge graph. One per Salesforce metadata component.
 *
 * @example
 *   const node: Node = {
 *     id: 'CustomField:Account.Industry__c',
 *     type: 'CustomField',
 *     apiName: 'Industry__c',
 *     label: 'Industry',
 *     parentId: 'CustomObject:Account',
 *     sourcePath: 'org-kb/source/objects/Account/fields/Industry__c.field-meta.xml',
 *     lastModifiedDate: '2026-04-12T14:33:08.000Z',
 *     lastModifiedBy: '005xx000001Sv2c',
 *     apiVersion: 62.0,
 *     properties: { dataType: 'Text', length: 255 }
 *   };
 */
export interface Node {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly label: string | null;
  readonly parentId: ComponentId | null;
  readonly sourcePath: string;
  /** ISO 8601 string, or null if not extracted (e.g., during validation slice). */
  readonly lastModifiedDate: string | null;
  readonly lastModifiedBy: string | null;
  readonly apiVersion: number | null;
  readonly properties: Readonly<Record<string, unknown>>;
}

/**
 * The set of edge types in the org knowledge graph.
 *
 * v1.0 shipped the 9 original edges. v1.1 added the sharing & visibility
 * pair (`inheritsFrom`, `sharedWith`). v1.2 added the record-types + UI-
 * surfaces pair (`belongsToApp`, `usesValueSet`). v1.3 added the legacy-
 * automation + communications singleton (`sendsEmail`). v1.4 adds the
 * developer test-mapping singleton (`coversTest`) — a directed edge from
 * a test class to a non-test class it covers. The LWC/Aura/VF frontend
 * extractors deliberately reuse the existing `readsFrom`, `writesTo`,
 * `callsApex`, and `references` edges rather than fragmenting per tier;
 * see PLAN-v1.4.md §3 for the rationale. v1.5 adds the integration
 * topology + event/async/API surface pair (`exposes`, `dispatchesAsync`)
 * and unlocks the production of the reserved-since-v1.0 `listensTo`
 * edge: `exposes` lands from an `ApexClass` to a synthetic
 * `ExternalApi:{kind}/{path}` target (the `kind` enum is `rest` /
 * `aura` / `invocable`; the synthetic prefix mirrors v1.1's
 * `Group:role/...` pattern and is deliberately NOT a `ComponentType`),
 * `dispatchesAsync` lands from a caller `ApexClass` to a job `ApexClass`
 * (Queueable / Schedulable / Batchable / `@future`), and `listensTo`
 * lands from any Platform Event subscriber (ApexTrigger, ApexClass
 * implementing `Triggerable<{EventName}__e>`, or platform-event-start
 * Flow) into the existing `__e`-suffixed `CustomObject` target node.
 * See PLAN-v1.5.md §3 for the synthetic-id design and the confidence
 * matrix. v1.7 adds the live-API enrichment singleton
 * (`dependsOnFromApi`) — the first edge family in the union whose
 * sole producer is an opt-in Tooling API enrichment pass rather than
 * an offline DX-source extractor. It sits alongside the DX-source
 * edges (the other 17) at `declared` confidence because the
 * `MetadataComponentDependency` endpoint IS the declaration. See
 * PLAN-v1.7.md §3 for the enrichment vs. extraction split and the
 * `properties.confirmedByApi` overlay on pre-existing `references`
 * edges. v2.0a adds the conditional-context tier singleton
 * (`firesWhen`) — a directed edge from a firer (WorkflowRule,
 * ValidationRule, ApprovalProcess, AutoResponseRule, AssignmentRule,
 * EscalationRule, Flow; later v2.0a.1 will extend to ApexClass /
 * ApexTrigger via the if-guard scanner) to the synthetic
 * `ConditionalContext:` target carrying the parsed condition surface.
 * v2.0a's seven extractor extensions emit `firesWhen` at `declared`
 * confidence (XML-extracted) or `parsed` confidence (formula-based,
 * resolved via the v0.2 formula tokenizer); the deferred Apex side
 * lands at `heuristic`. See PLAN-v2.0.md §3 v2.0a and
 * `docs/vendor/salesforce-metadata/ConditionalContextSemantics.md`.
 * v3.2 adds the OmniStudio declarative-process tier singleton
 * (`dispatchesOmniAction`) — a directed edge from any v3.2-tier
 * caller (OmniScript, OmniIntegrationProcedure, OmniUiCard) to the
 * OmniIntegrationProcedure / OmniDataTransform / sibling OmniScript
 * it invokes via an action child. Confidence is `declared` when the
 * target name is in a top-level XML element (e.g.,
 * `<bundle>ExtractContactMPPMapper</bundle>` for a DataRaptor
 * reference), and `parsed` when the target name is inside the
 * `propertySetConfig` JSON blob (e.g., `integrationProcedureKey`,
 * `actionList[].stateAction.omniType.Name`). The reserved namespace
 * edge `implementsOmniInterface` from Apex to OmniProcess is a v3.3
 * follow-up — explicitly out of scope for v3.2; the 16 of 141
 * vaulted Apex classes that carry `implements
 * omnistudio.VlocityOpenInterface` produce zero edges in v3.2.
 */
export type EdgeType =
  | 'parentOf' //          CustomObject -> CustomField
  | 'references' //        generic dependency
  | 'readsFrom' //         Apex or Flow reads a field
  | 'writesTo' //          Apex or Flow writes a field
  | 'triggersOn' //        Flow or Trigger listens to an event on an SObject
  | 'usedInLayout' //      Field is placed on a Layout
  | 'grantedBy' //         PermissionSet or Profile grants access to a component
  | 'callsApex' //         Flow calls an Apex action
  | 'listensTo' //         generic event listener; v1.5 production unlock — emitted by apex-trigger / apex-class (`implements Triggerable<{Event}__e>`) / flow (`<triggerType>PlatformEvent</triggerType>`) extractors against `__e`-suffixed CustomObject targets (Platform Event subscribers).
  // v1.1 — sharing & visibility tier.
  | 'inheritsFrom' //      Role -> parent Role (hierarchy)
  | 'sharedWith' //        SharingRule or Queue -> access target
  // v1.2 — record types + UI surfaces tier.
  | 'belongsToApp' //      CustomTab -> CustomApplication (declared, tab/app membership)
  | 'usesValueSet' //      CustomField -> GlobalValueSet (declared, value-set reference)
  // v1.3 — legacy automation + communications tier.
  | 'sendsEmail' //        WorkflowRule / ApprovalProcess / AutoResponseRule / AssignmentRule / EscalationRule -> EmailTemplate (declared, alert / notification template reference)
  // v1.4 — developer frontend + test mapping tier.
  | 'coversTest' //        ApexClass (@isTest) -> ApexClass (covered); declared via @TestVisible/@TestSetup, heuristic from callsApex inference
  // v1.5 — integration topology + event/async/API surface tier.
  | 'exposes' //           ApexClass with @RestResource / @AuraEnabled / @InvocableMethod -> synthetic `ExternalApi:{kind}/{path}` target (declared; the annotation IS the declaration, the synthetic id is a graph-store convention not a ComponentType — see PLAN-v1.5.md §3).
  | 'dispatchesAsync' //   ApexClass (caller) -> ApexClass (Queueable / Schedulable / Batchable / @future job); declared when the dispatch shape names the target class in-line (`System.enqueueJob(new MyQueueable())`), heuristic when it passes a constructed local variable the scanner can still resolve. Does NOT replace `callsApex` — a caller emits both edges in parallel.
  // v1.7 — Tooling API freshness + dependency tier.
  | 'dependsOnFromApi' //  Sourced from Tooling API's MetadataComponentDependency endpoint; declared confidence. Direction is `{Source} -> {Target}` per the API's response (typically ApexClass -> CustomField, Flow -> ApexClass, Layout -> CustomField). Emitted ONLY by the opt-in `tooling-api-dependency` enricher behind `sfi refresh --with-tooling-api`; absent from offline-only vaults by design. Does NOT replace `references` — when the API confirms a pre-existing extracted edge, the enricher adds `properties.confirmedByApi: true` to that edge instead of duplicating it. See PLAN-v1.7.md §3.
  // v2.0a — conditional-context tier (the master primitive for "when does this fire?").
  | 'firesWhen' //         Firer -> `ConditionalContext:{ParentFirerId}.condition-{index}`. Emitted by the seven v2.0a-extended declarative extractors (workflow-rule, validation-rule, approval-process, auto-response-rule, assignment-rule, escalation-rule, flow); the v2.0a.1 follow-up extends to ApexClass / ApexTrigger via the heuristic if-guard scanner. Confidence: `declared` for XML criteria items, `parsed` for formula expressions resolved via the v0.2 formula tokenizer, `heuristic` for the deferred Apex side. The synthetic-id pattern preserves the parent firer's full canonical id (including any `__c`/`__mdt` suffix) so consumers can resolve the parent without an extra graph query. See `docs/vendor/salesforce-metadata/ConditionalContextSemantics.md`.
  // v3.3 — schema relationship tier. CustomField (Lookup / Master-Detail) ->
  // the CustomObject its `referenceTo` names. Promotes the relationship from a
  // field PROPERTY to a first-class, traversable edge so dependency walks see
  // the data model — e.g. get_impact on an object lists the inbound lookups
  // pointing AT it. `properties.relationshipType` is "Lookup" or "MasterDetail";
  // a polymorphic lookup emits one edge per target. The target may be a standard
  // / managed object not in the vault (dangling, classified by the phantom taxonomy).
  | 'lookupTo'
  // v3.4 — UI-visibility tier. ListView -> Group / Role / synthetic Group
  // (AllInternalUsers etc.). A saved list view's `<sharedTo>` visibility scope:
  // which groups / roles the list view is shared with in the list-view picker.
  // DISTINCT from `sharedWith` (record-level access) — `visibleTo` grants
  // visibility of the saved VIEW, not access to the records it lists, so
  // record-access consumers (who_can_access_object) must NOT read it. Declared
  // confidence; `properties.sharedToType` is the source variant element and
  // `properties.inheritance` carries role-hierarchy inheritance when present.
  | 'visibleTo'
  // v3.2 — OmniStudio declarative-process tier edge (intra-OmniStudio call chain only).
  | 'dispatchesOmniAction'; //  {Caller} -> {OmniIntegrationProcedure | OmniDataTransform | OmniScript | OmniUiCard}. Caller can be `OmniScript` (Integration Procedure Action, DataRaptor Extract / Transform Action, navigate-to-OmniScript step), `OmniIntegrationProcedure` (Remote Action calling nested IP, DataRaptor Extract / Transform Action, chained IP Action), or `OmniUiCard` (Action widget whose `actionList[].stateAction.type` is `OmniScript` or `Integration Procedure`). Confidence: `declared` when the target name is in a top-level XML element (e.g., the `<bundle>` element of a DataRaptor Extract Action child), `parsed` when the target name is inside the `propertySetConfig` JSON blob (e.g., `integrationProcedureKey`, `actionList[].stateAction.omniType.Name`). Dangling references (target name present but no matching component in the vault) are emitted with `properties.targetMissing: true` so impact-analysis tools can surface them. The reserved Apex-to-OmniProcess edge `implementsOmniInterface` (for `implements omnistudio.VlocityOpenInterface` on Apex classes) is a v3.3 follow-up — NOT in v3.2. See PLAN-v3.2.md §4 and the per-type vendored docs.

/**
 * Every {@link EdgeType} as a runtime tuple — the single source the Zod input
 * enums and advertised JSON Schemas consume, so they can no longer drift from
 * the type. They previously re-listed the members by hand: v3.2 added
 * `dispatchesOmniAction` to the union but it was missed in `get_edges` /
 * `get_impact`, which then rejected an org's dominant OmniStudio edge while the
 * graph happily returned it. `satisfies` rejects an INVALID member; the
 * completeness guard below rejects a MISSING one — so an under-listing is now a
 * compile error, not a silent gap. Keep this in the union's declared order.
 */
export const EDGE_TYPES = [
  'parentOf',
  'references',
  'readsFrom',
  'writesTo',
  'triggersOn',
  'usedInLayout',
  'grantedBy',
  'callsApex',
  'listensTo',
  'inheritsFrom',
  'sharedWith',
  'belongsToApp',
  'usesValueSet',
  'sendsEmail',
  'coversTest',
  'exposes',
  'dispatchesAsync',
  'dependsOnFromApi',
  'firesWhen',
  'lookupTo',
  'visibleTo',
  'dispatchesOmniAction',
] as const satisfies readonly EdgeType[];

/**
 * Compile-time completeness guard for {@link EDGE_TYPES}: resolves to `true`
 * only when every `EdgeType` is listed; a missing member resolves it to a tuple
 * naming the gap, which breaks the `= true` assignment and fails the build.
 * Paired with the `satisfies` above, this makes `EDGE_TYPES` and `EdgeType`
 * provably the same set.
 */
type EdgeTypesComplete =
  Exclude<EdgeType, (typeof EDGE_TYPES)[number]> extends never
    ? true
    : ['EdgeType(s) missing from EDGE_TYPES:', Exclude<EdgeType, (typeof EDGE_TYPES)[number]>];
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time-only completeness assertion
const edgeTypesComplete: EdgeTypesComplete = true;

/**
 * A directed edge between two nodes.
 *
 * Every edge carries a `confidence` so consumers can distinguish ground
 * truth from inferred references.
 *
 * @example
 *   const edge: Edge = {
 *     fromId: 'ApexClass:AccountTriggerHandler',
 *     toId: 'CustomField:Account.Industry__c',
 *     edgeType: 'readsFrom',
 *     confidence: 'parsed',
 *     source: 'apex-ast-extractor',
 *     properties: { line: 42, column: 12 }
 *   };
 */
export interface Edge {
  readonly fromId: ComponentId;
  readonly toId: ComponentId;
  readonly edgeType: EdgeType;
  readonly confidence: ConfidenceLevel;
  /** Which extractor or parser produced this edge. */
  readonly source: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Extractor I/O
// ============================================================================

/**
 * The shape every extractor returns on success.
 *
 * Extractors are pure functions: given a file path or directory, they
 * produce nodes and edges. They never write to disk; the graph store
 * handles persistence.
 */
export interface ExtractionResult {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

/**
 * The error type extractors return when they cannot process input.
 *
 * Always returned via `Result`, never thrown.
 */
export interface ExtractorError {
  readonly kind:
    | 'file-not-found'
    | 'parse-error'
    | 'malformed-input'
    | 'unsupported-version';
  readonly message: string;
  readonly path: string;
  readonly cause?: unknown;
}

// ============================================================================
// Renderer I/O
// ============================================================================

/**
 * The output shape of a renderer.
 *
 * Renderers produce a single Markdown document with structured YAML
 * frontmatter. The frontmatter is what downstream tooling reads; the body
 * is what humans read.
 *
 * The caller (typically a CLI command or playbook) is responsible for
 * writing the output to disk at `path`.
 */
export interface RendererOutput {
  /** Relative path under `org-kb/` where this output should be written. */
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Markdown body, without the leading frontmatter delimiters. */
  readonly body: string;
}

export interface RendererError {
  readonly kind: 'missing-node' | 'invalid-input' | 'render-failure';
  readonly message: string;
  readonly nodeId?: ComponentId;
}

// ============================================================================
// Vault manifest
// ============================================================================

/**
 * The manifest at `org-kb/meta/manifest.json`. Describes what was extracted,
 * when, and from where. Committed to the admin's repo as a small, useful
 * diff signal across refreshes.
 *
 * @example
 *   const m: VaultManifest = {
 *     version: '0.1.0',
 *     refreshedAt: '2026-05-27T14:33:08Z',
 *     sourceOrg: 'admin@example.com',
 *     components: { CustomObject: 47, CustomField: 312 },
 *     edges: { parentOf: 312, usedInLayout: 580 },
 *     sourceTreeHash: 'sha256:abc123...'
 *   };
 */
export interface VaultManifest {
  readonly version: string;
  /** ISO 8601 timestamp of the most recent refresh. */
  readonly refreshedAt: string;
  /** The Salesforce CLI org alias that was retrieved from. */
  readonly sourceOrg: string;
  readonly components: Readonly<Partial<Record<ComponentType, number>>>;
  readonly edges: Readonly<Partial<Record<EdgeType, number>>>;
  /** sha256 of the canonicalized DX source tree. Used to detect staleness. */
  readonly sourceTreeHash: string;
  /** Optional v4.0 self-assessment of retrieve / extraction coverage. */
  readonly coverage?: readonly CoverageEntry[];
  /** ISO 8601 timestamp when `coverage` was computed. */
  readonly coverageComputedAt?: string;
  /** ISO 8601 timestamp when Tooling API enrichment last ran successfully. */
  readonly toolingApiEnrichedAt?: string;
  /** Metadata families touched by the most recent Tooling API enrichment run. */
  readonly toolingApiEnrichmentScope?: readonly string[];
}

/**
 * One metadata-family coverage row. `type` intentionally is not constrained to
 * ComponentType because the important enterprise signal is often "Salesforce has
 * a metadata family this product does not model yet".
 */
export interface CoverageEntry {
  readonly type: string;
  readonly requested: boolean;
  readonly retrieved: number;
  readonly errored: boolean;
  readonly errorReason?: string;
  readonly neverModeled: boolean;
  /**
   * True while a staged refresh (`sfi refresh --staged`) has not yet reached
   * the tier that retrieves this type. Distinguishes "queued by an in-progress
   * build" from an operator-scoped refresh that excluded the type. Pending
   * rows keep `retrieved: 0`, so readers that predate the flag partition them
   * as partial coverage — absence-claim caveats still fire.
   */
  readonly pending?: boolean;
}

// ============================================================================
// Pattern recognizer output
// ============================================================================

/**
 * A single observation from a pattern recognizer. Pattern recognizers do
 * not assert; they observe and report confidence.
 *
 * For naming conventions in v0.1: an observation might be "94% of custom
 * fields on standard objects use the `__c` suffix" (which is required
 * universally and would be 100%) or "78% of custom fields on Account use
 * the prefix `Acc_`" (which is a discovered convention).
 *
 * @example
 *   const obs: PatternObservation = {
 *     kind: 'naming-convention',
 *     scope: 'CustomField:Account.*',
 *     statement: 'Custom fields on Account follow the pattern Acc_<name>__c',
 *     evidence: { matching: 23, total: 28, examples: ['Acc_Revenue__c', 'Acc_Region__c'] },
 *     confidence: 'heuristic'
 *   };
 */
export interface PatternObservation {
  readonly kind: 'naming-convention' | 'permission-cluster' | 'unused-field';
  /** Glob-like scope expression. */
  readonly scope: string;
  /** Plain-English summary. */
  readonly statement: string;
  /** Evidence supporting the observation. */
  readonly evidence: Readonly<{
    readonly matching: number;
    readonly total: number;
    readonly examples: readonly string[];
  }>;
  readonly confidence: ConfidenceLevel;
}

// ============================================================================
// MCP tool I/O envelopes
// ============================================================================

/**
 * The shape every MCP tool's response uses. Wraps the tool-specific payload
 * with metadata about the vault state at query time, so callers can detect
 * when answers are stale relative to a known source-tree hash.
 */
export interface McpResponse<T> {
  readonly data: T;
  readonly vaultState: Readonly<{
    /** sha256 of the DX source tree at refresh time, copied from manifest. */
    readonly sourceTreeHash: string;
    /** Manifest refresh timestamp. */
    readonly refreshedAt: string;
  }>;
}

/**
 * The error envelope MCP tools return on failure. Not the JSON-RPC error
 * envelope — that wraps this.
 */
/**
 * How a referenced-but-unretrieved (phantom) component is classified — the P7
 * phantom taxonomy (see `docs/reports/phantom-taxonomy-audit.md`). Buckets are
 * mutually exclusive, in precedence order.
 */
export type PhantomClassification =
  | 'automation-critical' //   automation/code references it — a demand-retrieve candidate
  | 'blindspot-manifest' //    its whole ComponentType was never retrieved (widen the manifest)
  | 'managed-extension' //     managed-package member (namespaced) — stub forever
  | 'standard-field-phantom' // standard object or a field on one — stub forever
  | 'grant-only' //            only permission grants reference it — stub forever
  | 'unknown'; //              referenced, but not by automation and not a pure grant target

/** The knowledge tier the vault holds for a component: absent / L2 stub / L3 full. */
export type KnowledgeTier = 'absent' | 'stub' | 'full';

/**
 * A referenced-but-unretrieved component, classified ON DEMAND from its inbound
 * edges + the manifest coverage (P7-reference-stub-nodes). Surfaced in
 * {@link McpError.stub} when a lookup resolves to a phantom rather than a real
 * node, so a consumer gets a classified stub + remedy instead of a bare
 * not-found. (Computed on demand, NOT materialized into the graph — materialized
 * stub nodes would make the dangling edges resolve and break the targetMissing /
 * blindspot / taxonomy semantics that depend on them.)
 */
export interface ReferenceStub {
  readonly stub: true;
  readonly id: ComponentId;
  readonly classification: PhantomClassification;
  /** Always L2 here — referenced, but only stub-level knowledge is held. */
  readonly tier: 'stub';
  /** Distinct components that reference it. */
  readonly referenceCount: number;
  /** The inbound edge kinds (e.g. `grantedBy`, `triggersOn`). */
  readonly edgeKinds: readonly string[];
  /** Managed namespace prefix, when classification is `managed-extension`. */
  readonly namespace?: string;
  /** True only for `automation-critical` — the demand-retrieve candidate; others stay stub. */
  readonly demandRetrievable: boolean;
  /** The honest next step for this classification. */
  readonly remedy: string;
}

/**
 * One ranked candidate from the typo-tolerant resolver (FLD-04). Surfaced on
 * `component-not-found` for field tools so callers can self-correct without
 * invoking `sfi.resolve` separately.
 */
export interface ResolveSuggestion {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly score: number;
  readonly matchKind: string;
}

export interface McpError {
  readonly kind:
    | 'vault-missing'
    | 'vault-stale'
    | 'component-not-found'
    | 'invalid-query'
    | 'oversize'
    | 'internal';
  readonly message: string;
  /** Optional pointer to the offending input. */
  readonly path?: string;
  /**
   * Set on a `component-not-found` whose id is a PHANTOM (referenced but never
   * retrieved): the classified stub + remedy (P7-reference-stub-nodes). Absent
   * for a genuinely-unknown id.
   */
  readonly stub?: ReferenceStub;
  /**
   * FLD-04: typo-tolerant CustomField candidates when a field tool cannot find
   * the requested id. Heuristic — confirm before acting.
   */
  readonly resolveSuggestions?: readonly ResolveSuggestion[];
}

// ============================================================================
// Continuation-cursor pagination (CR-22)
// ============================================================================

/**
 * Decoded shape of a CR-22 continuation cursor. The cursor is an OPAQUE,
 * versioned, per-handler token: a caller receives `PageInfo.nextCursor` (a
 * base64url string), treats it as a black box, and echoes it back on the next
 * call. This is the post-decode struct the handler reasons over — never
 * something a caller constructs by hand.
 *
 * A cursor is bound to ONE specific query: the tool that minted it (`t`), the
 * vault it was minted against (`h` = `vaultState.sourceTreeHash`), and a
 * fingerprint of the narrowing args (`q`). On resume the handler re-validates
 * all three; ANY mismatch (different tool, refreshed vault, changed filters)
 * means the cursor is stale and the caller must restart without it.
 *
 * The cursor is emitted ONLY when a page was truncated (over the byte budget OR
 * over `limit`). A request with no cursor behaves exactly as today: offset 0,
 * default limit — so adding a cursor never moves an in-budget golden response.
 */
export interface PageCursorToken {
  /** Protocol version. Bumped if the encoding changes; a stale `v` is rejected. */
  readonly v: number;
  /** Tool name the cursor was minted for (e.g. `sfi.get_edges`). */
  readonly t: string;
  /** `sourceTreeHash` of the vault the cursor was minted against. */
  readonly h: string;
  /** Resume offset into the designated list (safe non-negative integer). */
  readonly o: number;
  /**
   * Optional total-order tiebreak key (e.g. the last row's edge-PK / id) of the
   * last item on the prior page. RESERVED for a future shift-tolerant resume —
   * it is stamped onto the cursor but NOT yet consulted on resume (resume uses
   * the `o` offset only). With offset-only resume, a front-deletion between
   * pages can still skip/dup; `k` exists so a later batch can wire key-anchored
   * resume without an encoding change. Validated as a string.
   */
  readonly k?: string;
  /**
   * Optional scan offset for tools that walk a capped node scan separately from
   * the page offset (safe non-negative integer).
   */
  readonly s?: number;
  /** Fingerprint of the query's narrowing args — guards against arg drift. */
  readonly q?: string;
  /**
   * Optional list/section identifier for the multi-list and section-cursor
   * variants (e.g. `'object'` vs `'system'`). Absent for a flat single list.
   */
  readonly listId?: string;
}

/**
 * Pagination metadata a cursor-aware handler attaches to its `data` payload.
 * `jsonResult` DETECTS this block (a `nextCursor`/`pageInfo`) and skips its own
 * approximate `nextOffset` computation — the handler's cursor wins.
 *
 * `nextCursor` is present ONLY on a truncated page. When the list is exhausted
 * it is `null` and `hasMore` is `false`, so a caller loops `while (hasMore)`.
 * `limit`/`offset` remain on the payload for backward compatibility.
 */
export interface PageInfo {
  /** Total items matching the query BEFORE paging (the designated list). */
  readonly totalCount: number;
  /** Items returned in THIS page. */
  readonly returnedCount: number;
  /** True when more items remain past this page. */
  readonly hasMore: boolean;
  /**
   * Opaque continuation token to fetch the next page, or `null` when exhausted.
   * Present ONLY on a truncated page; echo it back verbatim as the `cursor`
   * input. A caller MUST NOT parse or construct it.
   */
  readonly nextCursor: string | null;
}
