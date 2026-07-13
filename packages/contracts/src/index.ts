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
  | 'NetworkAccess' //           IP-range trust-list entry (`.networkAccess-meta.xml`). NOT the Experience Cloud community: that `Network` / `CustomSite` / `ExperienceBundle` family is now modeled as its own tier (R6-17, below). This type is the unrelated "Trusted IP Ranges" list — the two only share the XML-namespace `Network` prefix.
  // v1.6 — business-user record-value tier.
  // CR-CAP-15 — declarative custom-permission definition tier. A
  // CustomPermission is a named permission flag (`.customPermission-meta.xml`)
  // that Apex / Flow / validation rules gate on, and that PermissionSets /
  // Profiles grant via their `<customPermissions>` block (the grant side is
  // CR-CAP-10's `grantedBy` edge; no new EdgeType). Id format is flat
  // `CustomPermission:{DeveloperName}` (no parent scope — mirroring
  // RemoteSiteSetting / AuthProvider / CustomLabel) so a bare `<name>` grant
  // resolves to exactly this id. v0.1 extracts the definition node only; the
  // optional `<requiredPermission>` CustomPermission-implies-CustomPermission
  // dependency edges and the `<connectedApp>` reference are deferred.
  | 'CustomPermission' //        A declarative permission flag (`.customPermission-meta.xml`) checked by Apex/Flow/validation rules and granted by PermissionSet/Profile `<customPermissions>`. Id `CustomPermission:{DeveloperName}`. Carries `label`/`description`; the grant edge (`grantedBy`) is CR-CAP-10.
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
  // v2.9 — WorkflowAlert promotion. Each `<alerts>` entry in a
  // `*.workflow-meta.xml` file is promoted from a dangling-by-design
  // `references` target (pre-v2.9 only the name→template lookup was
  // captured) to a real ComponentType node so alert-level properties
  // (`senderType`, `description`, `template`, `ccEmails`) are queryable.
  // Id format `WorkflowAlert:{ObjectApiName}.{fullName}` mirrors the
  // `OutboundMessage:` and `WorkflowFieldUpdate:` scoping convention.
  // Parent edge is the existing `parentOf` from
  // `CustomObject:{ObjectApiName}`. The `WorkflowRule→WorkflowAlert`
  // `references` edge already existed (via the Alert action variant);
  // v2.9 gives that edge a real node target instead of a phantom stub.
  | 'WorkflowAlert' //        Email alert embedded inside `*.workflow-meta.xml`'s `<alerts>` collection. Carries `name` (fullName), `description`, `senderType` (CurrentUser | OrgWideEmailAddress | DefaultWorkflowUser), `template` (EmailTemplate path), and `ccEmails` (string array). Id `WorkflowAlert:{ObjectApiName}.{fullName}`. Parented by `CustomObject:{ObjectApiName}` via `parentOf`. Referenced by `WorkflowRule` via the existing Alert-variant `references` edge, which now resolves to a real node rather than a phantom stub.
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
  | 'InstalledPackage' // A managed/unlocked package installed in the org (`.installedPackage-meta.xml`). The fullName is the namespace prefix; `properties.versionNumber` is the installed version. Answers "what packages are installed?".
  // CR-CAP-18 — platform-event publish/stream-routing topology. A
  // PlatformEventChannel is the publish/stream container; a
  // PlatformEventChannelMember binds ONE entity onto that channel with an
  // optional declared per-member filter. This is the PUBLISH side (channel
  // routing), DISTINCT from the SUBSCRIBE side (`listensTo`, modeled from
  // Apex/Flow into the `__e` CustomObject). Ids preserve the `__chn` fullName
  // suffix: `PlatformEventChannel:{Name}__chn` / `PlatformEventChannelMember:{Name}__chn`.
  // Edges REUSE existing types (NO new EdgeType): channel→member is `parentOf`
  // (parent→child, member's parentId = the channel), member→event is
  // `references` (member → the `__e`/CDC `CustomObject` node) tagged
  // `properties.referenceKind: 'platformEventChannelMember'` and carrying the
  // verbatim declared `filterExpression`. For a `data` channel the
  // selectedEntity (CDC/standard entity) may be absent from an offline vault →
  // the `references` edge is dangling-by-design (importer stamps
  // `targetMissing`, mirroring `dispatchesOmniAction`). HONESTY: the
  // filterExpression is the DECLARED XML text, NOT runtime filter EVALUATION.
  // EDGE_TYPES tuple + EdgeTypesComplete guard are UNTOUCHED.
  | 'PlatformEventChannel' //       The publish/stream container (`.platformEventChannel-meta.xml`). Carries `channelType` (`event` | `data`) and `label`. Id `PlatformEventChannel:{Name}__chn`. Node-only; the member file owns the channel→member `parentOf` and member→event `references` edges.
  | 'PlatformEventChannelMember' // One entity bound onto a PlatformEventChannel (`.platformEventChannelMember-meta.xml`). Carries `eventChannel`, `selectedEntity`, and the optional declared `filterExpression`. Id `PlatformEventChannelMember:{Name}__chn`; `parentId` = its `PlatformEventChannel`. Emits `parentOf` (channel→member) + `references` (member→`CustomObject:{selectedEntity}`, carrying `filterExpression`). NO new EdgeType.
  // Session / MFA security tier. A SessionSettings node models the org-wide
  // session-security policy (`.sessionSettings-meta.xml`) — required-MFA,
  // strong-auth-for-UI-logins, and session-timeout. Exactly ONE per org
  // (org-level metadata), so the id is the fixed `SessionSettings:default`; no
  // parent scope and no edges of its own. It pairs with the already-extracted
  // (but previously unsurfaced) Profile `loginIpRanges` to answer login &
  // session security questions via `sfi.profile_security`. REFRESH-GATED:
  // `SessionSettings` is added to the retrieve manifest + extractor tier, so a
  // vault built before this type shipped will not carry the node until a
  // re-refresh pulls it. Per-weekday `loginHours` windows are a separate,
  // already-shipped Profile-only concern (read straight off the Profile's own
  // `<loginHours>` element into `properties.loginHours`) — NOT gated by this
  // tier.
  | 'SessionSettings' //            Org-wide session-security policy (`.sessionSettings-meta.xml`). Carries `mfaRequired`, `requiresStrongAuth`, and `sessionTimeoutMinutes`. Id `SessionSettings:default` (single org-level node; no parent scope, no edges of its own). Refresh-gated: needs a re-refresh with the new retrieve set to populate.
  // R6-08 — standard-picklist tier. Standard picklists (Industry, LeadSource,
  // OpportunityStage, …) were previously entirely unmodeled: zero
  // ComponentType, zero extraction. A StandardValueSet is Salesforce's org-wide
  // definition of one standard picklist's value set (`.standardValueSet-meta.xml`,
  // `standardValueSets/` folder — mirrors GlobalValueSet's shape but for
  // STANDARD, not custom, fields). Id `StandardValueSet:{Name}` (the file's own
  // API name, e.g. `StandardValueSet:LeadSource`) — flat, no parent scope,
  // mirroring GlobalValueSet/CustomLabel. EDGE-LESS: v0.1 extracts the node
  // only (value apiName + active flag per entry, mirrored as a `values[]`
  // array plus `valueCount`); no `usesValueSet`-style edge from the standard
  // CustomField to its StandardValueSet is emitted (unlike GlobalValueSet's
  // CustomField-side edge) — a standard field's implicit binding to its
  // StandardValueSet is not itself declared anywhere in metadata to read an
  // edge from. See `docs/vendor/salesforce-metadata/StandardValueSet.md`.
  | 'StandardValueSet' //          Org-wide standard-picklist value set (`.standardValueSet-meta.xml`). Carries `sorted`, `valueCount`, and `values` (array of `{ apiName, active }` — the Metadata API's `StandardValue` has no separate `label` field, so `apiName` doubles as the display value). Id `StandardValueSet:{Name}` (e.g. `StandardValueSet:LeadSource`). Node-only; no edges.
  // R6-18 — Service Cloud entitlement/SLA + Omni-Channel routing tier. Closes
  // the eval-refused "what's the SLA on this case" / "how are cases routed to
  // agents" gap. Both sub-families use the generic `extractEnterpriseMetadata`
  // pattern (mirroring `CustomPermission`'s flat-top-level shape) — verified
  // against real retrieves from two live orgs (a small services org and a
  // university sandbox), NOT assumed from docs alone.
  //
  // `EntitlementProcess` (`entitlementProcesses/`, `.entitlementProcess-meta.xml`
  // — folder/suffix confirmed via a real scoped retrieve) is Salesforce's SLA
  // definition for one SObject: `SObjectType`, `active`, `businessHours`
  // (name only — not a `BusinessHours` ComponentType; none exists in this
  // vault yet), `versionNumber`/`versionMaster` (entitlement VERSIONING: a
  // process can have multiple files, one per version, each independently
  // retrieved — this extractor does NOT merge versions, it models each file
  // as its own node keyed by the file's own `fullName`, which already embeds
  // the version distinction Salesforce assigns it). Its `<milestones>` blocks
  // repeat per milestone; the `<milestoneName>` child of each is promoted to
  // a `references` edge to `MilestoneType:{Name}` (`referenceKind:
  // 'entitlementMilestone'`). R7-C7 additionally captures each block's OWN
  // `minutesToComplete` / `useCriteriaStartTime` via a block-scoped parser
  // (`properties.milestones`) — R6-18 deliberately did NOT ship this: the
  // generic extractor's flat `extraProperties` reads only the FIRST
  // occurrence of a repeated element, which would have silently
  // misattributed one milestone's target minutes to a different milestone;
  // `timeTriggers` / `exitCriteriaFilterItems` remain out of scope. This is
  // the load-bearing honesty boundary: `sfi.lifecycle_process` /
  // `sfi.what_happens_on_save` can now say WHICH milestones apply to an
  // object, whether the process is active, AND each milestone's target
  // minutes — but NEVER whether a specific case is currently on-track or
  // breached (that is live, per-record timer data — still unmodeled).
  | 'EntitlementProcess' //        SLA/entitlement process definition (`entitlementProcesses/{fullName}.entitlementProcess-meta.xml`). Carries `SObjectType`, `active`, `businessHours`, `versionNumber`, `versionMaster`, `isVersionDefault`, `versionNotes`, `entryStartDateField`, `description`, `label` (top-level `<name>`, distinct from the file's own `fullName`/apiName), `milestoneName` (the deduplicated, sorted array of referenced milestone names, mirroring the emitted edges), and `milestones` (R7-C7: `{ milestoneName, minutesToComplete, useCriteriaStartTime }[]`, one entry per `<milestones>` block, each read scoped to its OWN block — correct per-milestone attribution, not a first-occurrence guess). Id `EntitlementProcess:{fullName}` — flat, no parent scope (multiple versions of the same process are multiple files/nodes; NOT merged). Emits one `references` edge per distinct `<milestoneName>` to `MilestoneType:{Name}` (`declared` confidence). `timeTriggers`, `exitCriteriaFilterItems`, and live on-track/breached status are NOT modeled.
  // `MilestoneType` (`milestoneTypes/`, `.milestoneType-meta.xml` — folder/
  // suffix confirmed via the same real retrieve) is the org-wide milestone
  // DEFINITION an `EntitlementProcess` references by name. Real org files
  // carry no `<name>` element at all (the fullName IS the name) — only
  // `<description>` and `<recurrenceType>`.
  | 'MilestoneType' //            Org-wide milestone definition (`milestoneTypes/{fullName}.milestoneType-meta.xml`). Carries `description` and `recurrenceType` (`none` | `recursIndependently` | `recursChained` in real org data). Id `MilestoneType:{fullName}` — flat, no parent scope. Node-only; the `EntitlementProcess -> MilestoneType` edge is emitted by the entitlement-process extractor. Real Metadata API files carry no separate `<name>`/`<label>` element — the node's own `apiName` (from the filename) IS the display name.
  //
  // Omni-Channel routing tier. `ServiceChannel` (`serviceChannels/`,
  // `.serviceChannel-meta.xml`) is the routable work-item TYPE (Case, Chat,
  // Voice Call, Messaging Session, …). The task brief assumed a
  // `salesforceObject` property name; real retrieves from both verification
  // orgs confirm the actual Metadata API field is `relatedEntityType` — used
  // here instead of the assumed name (corrected against ground truth, not
  // documentation guesswork). `capacityModel` (`STATUS_BASED` | `TAB_BASED`)
  // is ServiceChannel's own capacity-config field; the PER-ROUTING-CONFIG
  // capacity weighting lives on `QueueRoutingConfig`, not here.
  //
  // `QueueRoutingConfig` (`queueRoutingConfigs/`, `.queueRoutingConfig-meta.xml`)
  // is the routing behavior (LEAST_ACTIVE / MOST_AVAILABLE / EXTERNAL_ROUTING,
  // capacity weight/type, push timeout) a `Queue` opts into via its
  // `<queueRoutingConfig>` element. The existing `queue.ts` extractor already
  // READ that element into `properties.queueRoutingConfig` (a bare string) but
  // emitted no edge; R6-18 adds the `Queue -> QueueRoutingConfig` `references`
  // edge (declared confidence) so "how are cases routed to agents" can walk
  // from the Queue to its routing config. A `QueueRoutingConfig`'s own
  // `<queueOverflowAssignee>` (verified via a real file to hold a Queue
  // DEVELOPER NAME, e.g. `Agentforce_Fallback_Queue` — not the opaque record
  // ID the Metadata API Developer Guide's prose implies) is likewise promoted
  // to a `references` edge to `Queue:{Name}`, completing the overflow chain.
  | 'ServiceChannel' //            Omni-Channel routable work-item type (`serviceChannels/{fullName}.serviceChannel-meta.xml`). Carries `label`, `relatedEntityType` (required; e.g. `Case`, `LiveChatTranscript`, `MessagingSession`, `VoiceCall` — NOT `salesforceObject`, corrected against real retrieves), `capacityModel`, `isInterruptible`, `hasAutoAcceptEnabled`, `doesMinimizeWidgetOnAccept`, `hasAfterConvoWorkTimer`. Id `ServiceChannel:{fullName}` — flat, no parent scope. Node-only; no edges of its own.
  | 'QueueRoutingConfig' //        Omni-Channel routing behavior (`queueRoutingConfigs/{fullName}.queueRoutingConfig-meta.xml`). Carries `label`, `routingModel` (`LEAST_ACTIVE` | `MOST_AVAILABLE` | `EXTERNAL_ROUTING`), `routingPriority`, `capacityWeight`, `capacityType`, `pushTimeout`, `isAttributeBased`, `queueOverflowAssignee`. Id `QueueRoutingConfig:{fullName}` — flat, no parent scope. Emits a `references` edge to `Queue:{queueOverflowAssignee}` (`referenceKind: 'queueOverflowAssignee'`, declared) when set. The inbound `Queue -> QueueRoutingConfig` edge is emitted by `queue.ts`, not here.
  // R6-22 — security-surface tier (2 of 3; CustomSite tracked separately).
  // Certificate is org-wide TLS/signing key metadata (`.crt-meta.xml`,
  // `certs/` folder) retrieved as TWO files: the `.crt` content file (the
  // PEM/DER certificate or exported key material) and this `.crt-meta.xml`
  // sidecar. ONLY the sidecar is parsed — the content file is metadata-only
  // by design and is never read, matching this product's "never vault
  // record/secret data" rule extended to key material. Flat, no parent
  // scope, mirroring CustomPermission/RestrictionRule.
  | 'Certificate' //                A stored certificate/key (`.crt-meta.xml`, `certs/` folder). Carries `caSigned`, `expirationDate`, and `keySize` (metadata only — the paired `.crt` content file's key/cert material is NEVER read). `label` = `masterLabel`. Id `Certificate:{DeveloperName}`. Flat, no parent scope, no edges.
  // TransactionSecurityPolicy is an event-triggered security policy
  // (`.transactionSecurityPolicy-meta.xml`, `transactionSecurityPolicies/`
  // folder) — "when eventName X happens, take action Y". Its `<apexClass>`
  // names a class implementing `TxnSecurity.PolicyCondition`/`EventCondition`
  // that decides WHETHER the policy fires; that class is a real, resolvable
  // ApexClass node, so it is modeled as a `references` edge (declared — an
  // explicit metadata pointer) rather than a bare property string.
  | 'TransactionSecurityPolicy' // Event-triggered security policy (`.transactionSecurityPolicy-meta.xml`). Carries `eventName`, `active`, and `action` (`{ block, endSession, freezeUser, twoFactorAuthentication, notificationCount }` — omitted when no `<action>` block). Emits a `declared references` edge to `ApexClass:{apexClass}` (referenceKind `conditionClass`) when `<apexClass>` is present. Id `TransactionSecurityPolicy:{DeveloperName}`. Flat, no parent scope.
  | 'StandardValueSet' //           Org-wide standard-picklist value set (`.standardValueSet-meta.xml`). Carries `sorted`, `valueCount`, and `values` (array of `{ apiName, active }` — the Metadata API's `StandardValue` has no separate `label` field, so `apiName` doubles as the display value). Id `StandardValueSet:{Name}` (e.g. `StandardValueSet:LeadSource`). Node-only; no edges.
  // R6-13 — Agentforce / Einstein GenAI tier. The org's OWN generative-AI
  // surface, previously entirely unmodeled (zero ComponentType, zero
  // extraction) — the gap the "the backend your Salesforce AI can trust"
  // positioning could not see. Four flat file-based metadata families under
  // their own DX directories (`genAiFunctions/`, `genAiPlugins/`,
  // `genAiPlannerBundles/`, `genAiPromptTemplates/` — folders/suffixes verified
  // against a live Agentforce dev org's `sf org list metadata-types` describe).
  // All edges REUSE the generic `references` EdgeType tagged with a
  // `properties.referenceKind` discriminator (no new EdgeType — mirroring
  // CustomPermission / PlatformEventChannel); every edge is `declared` (an
  // explicit metadata pointer, not a heuristic). Legacy Einstein `Bot` /
  // `BotVersion` were deferred from the original R6-13 slice and landed as
  // R7-C7 (see below); `sfi.ai_exposure_report` composes both tiers.
  // Composed by `sfi.ai_exposure_report`. See `gen-ai.ts` / `bot.ts`.
  | 'GenAiFunction' //             One Agentforce action (`.genAiFunction-meta.xml`, `genAiFunctions/`). Carries `masterLabel` (label), `description`, `invocationTarget` + `invocationTargetType` (`apex` | `flow` | `api` | `externalService`). Id `GenAiFunction:{Name}`. Emits a declared `references` edge to `ApexClass:{invocationTarget}` (`apex`) or `Flow:{invocationTarget}` (`flow`); other invocation types are properties-only (no phantom edge).
  | 'GenAiPlugin' //               One Agentforce topic — a category of actions (`.genAiPlugin-meta.xml`, `genAiPlugins/`). Carries `masterLabel` (label), `description`, `pluginType` (`Topic` | `APICustomTopic`), `scope`, `language`, and `functionNames`. Id `GenAiPlugin:{Name}`. Emits one declared `references` edge per member `<genAiFunctions><functionName>` to `GenAiFunction:{name}` (referenceKind `genAiPluginFunction`).
  | 'GenAiPlannerBundle' //        One Agentforce agent / planner definition (`.genAiPlannerBundle-meta.xml`, nested `genAiPlannerBundles/{agent}/`). Carries `masterLabel` (label), `description`, `plannerType`, `capabilities`, `pluginNames`, `functionNames`. Id `GenAiPlannerBundle:{Name}` (basename-derived, so nesting is transparent). Emits declared `references` edges to its topics (`<genAiPlugins><genAiPluginName>` → `GenAiPlugin:{name}`, referenceKind `plannerBundlePlugin`) and loose knowledge actions (`<genAiFunctions><genAiFunctionName>` → `GenAiFunction:{name}`, referenceKind `plannerBundleFunction`). Requires Metadata API v64.0+ (replaced GenAiPlanner at v63.0).
  | 'GenAiPromptTemplate' //      One prompt template — the grounding surface (`.genAiPromptTemplate-meta.xml`, `genAiPromptTemplates/`). Carries `masterLabel` (label), `templateType`, `visibility`, `versionCount`, `groundingFieldRefs`, and (when present) `unresolvedGroundingRefs`. Id `GenAiPromptTemplate:{Name}`. Emits declared `references` edges for the object/field data the prompt grounds on: `<relatedEntity>`/`<relatedField>` (referenceKind `promptTemplateRelatedEntity`/`promptTemplateRelatedField`), grounding merge-fields `{!$Input:Ref.Field}` resolved via declared SObject `<inputs>` (`promptTemplateGroundingField`/`promptTemplateGroundingObject`), and `{!$Flow:..}`/`{!$Apex:..}`/`flow://`/`apex://` data providers (`promptTemplateDataProvider`). A merge-field whose input is undeclared/primitive/a relationship traversal is disclosed in `unresolvedGroundingRefs`, never minted as a phantom field edge.
  // R6-17 — Experience Cloud community tier. Guest-user over-exposure on
  // Experience Cloud sites is a notorious real-world Salesforce security
  // failure class, and the community family was previously excluded entirely
  // (see the NetworkAccess note above, now corrected). Three cooperating types
  // model the surface WITHOUT parsing the (huge) Builder page tree — the
  // `guest_exposure_report` tool composes them with the existing permissions
  // engine + PII classifier.
  | 'Network' //                   The Experience Cloud / community DEFINITION and the family anchor (`.network-meta.xml`, `networks/` folder). Carries the security posture: `status` (`Live`/`UnderConstruction`/…), `selfRegistration` (CRITICAL — `true` lets unauthenticated visitors create a login), and the guest-access switches present in the XML (`enableGuestFileAccess`, `enableGuestChatter`, `enableGuestMemberVisibility`, `allowInternalUserLogin` — each tri-state, an absent switch is `null`, never fabricated `false`), plus `urlPathPrefix` and member profile/perm-set counts. Id `Network:{Name}`. Emits DECLARED `references` edges to its `CustomSite` (`<site>`) and `ExperienceBundle` (`<picassoSite>`); both dangle-by-design when the target was not retrieved. No new EdgeType.
  | 'CustomSite' //                The site container fronting a Force.com site or an Experience Cloud community (`.site-meta.xml`, `sites/` folder). Carries `active`, `siteType` (`ChatterNetwork` = Experience Cloud), `masterLabel`, `urlPathPrefix`, `guestRecordDefaultOwner`. Id `CustomSite:{Name}`. Emits ONE HEURISTIC `references` edge to the site's auto-provisioned guest-user profile `Profile:{Site Label} Profile` — a NAMING CONVENTION (the XML carries no `<guestProfile>` element; verified against a real production org where each Site owns exactly one `UserType='Guest'` profile named `"{label} Profile"`), so the edge carries `confidence: 'heuristic'`. No new EdgeType.
  | 'ExperienceBundle' //         The Builder page tree's TOP-LEVEL meta only (`experiences/{Name}.site-meta.xml`, root `<ExperienceBundle>` — shares the `.site-meta.xml` suffix with CustomSite but a different directory + root). Carries `bundleLabel`, `type`, `urlPathPrefix`, and a best-effort `pageCount` (a count of `views/*.json`, no content parsed). The full JSON page tree (pages/components/audience rules — hundreds of files) is DELIBERATELY out of scope (`pageContentModeled: false`); this models the community's existence + size, not its pages. Id `ExperienceBundle:{Name}`. Node-only; the `Network` → `ExperienceBundle` wiring edge is emitted by the Network extractor.
  // R7-C7 — Agentforce / Service Cloud extraction leftovers R6-13 and R6-18
  // deferred. Three families, verified against REAL scoped retrieves
  // (`sf project retrieve start --metadata Bot --metadata PresenceUserConfig
  // --metadata EntitlementProcess`) from two live orgs (a production-scale
  // university sandbox with 5 Bots / 15 BotVersions / 4 PresenceUserConfigs,
  // and a small services org with 2 PresenceUserConfigs + 1 EntitlementProcess
  // — that org reported `Bot` as "not available"). Real files corrected two
  // assumptions in this tier's brief against ground truth rather than
  // shipping a documentation guess: (1) neither `Bot` nor `BotVersion` carry
  // any `status`/`active`/`versionNumber` element in real retrieves — a
  // version's identity IS its own `fullName` (mirrors the `MilestoneType`
  // precedent: no separate `<name>`, the file's own name is the display
  // name); (2) modern (Agentforce-template) BotVersions carry ZERO
  // `<botIntents>` and instead reference a `GenAiPlannerBundle` via
  // `<conversationDefinitionPlanners><genAiPlannerName>` — the legacy
  // dialog/intent tree and the R6-13 Agentforce planner tree coexist in one
  // metadata type, generationally.
  //
  // `Bot` (`bots/{BotName}/{BotName}.bot-meta.xml`) is the bot/agent
  // DEFINITION — nested folder-per-bot, like `GenAiPlannerBundle`, but unlike
  // that type the FILE's own basename embeds the full bot name, so its
  // apiName is basename-derived (nesting transparent) exactly like
  // `GenAiPlannerBundle`. See `bot.ts`.
  | 'Bot' //                       Einstein Bot / Agentforce agent definition (`bots/{BotName}/{BotName}.bot-meta.xml`). Carries `label` (top-level `<label>`, distinct from `botMlDomain.label`), `description`, `type` (`Bot` | `ExternalCopilot` | `InternalCopilot`), `agentType`/`agentTemplate` (Agentforce-template bots only), `botSource`, `botUser` (a username — NOT a `User` ComponentType edge; no such node type exists in this vault, mirroring `QueueRoutingConfig.userOverflowAssignee`), `richContentEnabled`, `logPrivateConversationData`, `sessionTimeout`, `contextVariableCount` (COUNT of `<contextVariables>` blocks), `contextVariableFieldRefs` (resolvable mapped fields), and `botMlDomain` (`{ label, name }`, omitted when absent). Id `Bot:{BotName}`. Emits DECLARED `references` edges for each resolvable `<contextVariableMappings>` field (`referenceKind: 'botContextVariableField'`, with `includeInPrompt` when the variable opts into the LLM prompt). The `Bot` → `BotVersion` `parentOf` edge is emitted by the BotVersion extractor (mirrors `PlatformEventChannel`/`Member`'s child-owns-the-parent-edge split, since Bot's own file cannot enumerate its version files without a directory scan). Composed as an AI surface by `sfi.ai_exposure_report`.
  // `BotVersion` (`bots/{BotName}/{fullName}.botVersion-meta.xml`, e.g.
  // `bots/Foo/v3.botVersion-meta.xml`) is one version of that bot. Unlike
  // `Bot`, the FILE's own basename does NOT embed the bot name (real files
  // are named bare `v1.botVersion-meta.xml`, `v2.botVersion-meta.xml`, …) —
  // taking the basename alone as apiName would COLLIDE across every bot in
  // the org (every bot has its own "v1"). The apiName is instead
  // `{BotName}.{fileBasename}` (the immediate parent DIRECTORY name +
  // the file's own version suffix — verified to match Salesforce's own
  // retrieve-manifest `fullName` for this type EXACTLY, e.g.
  // `University_Semantic_Search_Agent.v7`), mirroring the dot-joined
  // convention `PathAssistant`/`deriveDotSplitObjectAndApiName` already use
  // for a DIFFERENT nesting shape (object.name-in-filename) — here the
  // disambiguating half comes from the DIRECTORY instead.
  | 'BotVersion' //                One version of a Bot (`bots/{BotName}/{fullName}.botVersion-meta.xml`). Id `BotVersion:{BotName}.{fullName}` (dot-joined, directory-disambiguated — see above). `parentId` = `Bot:{BotName}`. Carries `dialogCount` (COUNT of `<botDialogs>` blocks — the full dialog/message trees are NOT extracted; out of scope by design, matching the R6-24 report-detail value-omission discipline extended to conversational content), `intentCount` (COUNT of legacy `<botIntents>` blocks — 0 on every Agentforce-template bot verified), `entryDialog`, `toneType`, `knowledgeFallbackEnabled`, `citationsEnabled` (each a raw XML string, omitted when the element is absent — never defaulted), and `plannerNames` (the `<conversationDefinitionPlanners><genAiPlannerName>` targets, deduplicated + sorted). Emits a DECLARED `parentOf` edge FROM `Bot:{BotName}` TO this node, and one DECLARED `references` edge per `plannerNames` entry to `GenAiPlannerBundle:{name}` (`referenceKind: 'botVersionPlanner'`) — the real, verified link between the legacy Bot metadata type and the R6-13 Agentforce GenAI tier. `sfi.ai_exposure_report` composes Bot (not BotVersion) as a surface: context-variable fields + the union of every version's planner reach.
  //
  // `PresenceUserConfig` (`presenceUserConfigs/{fullName}.presenceUserConfig-meta.xml`)
  // is an Omni-Channel presence configuration: a capacity model + decline/
  // sound toggles bound to a set of assigned Profiles and/or individual
  // Users. R6-18 deferred this because the `<assignments><users>` sub-block
  // has no `User` ComponentType to target. Real retrieves confirm the shape:
  // ONE `<assignments>` block wrapping optional `<profiles><profile>`
  // (repeatable) and optional `<users><user>` (repeatable) — either, both,
  // or neither may be present (the org-default config in both verification
  // orgs carries NO `<assignments>` block at all).
  | 'PresenceUserConfig' //        Omni-Channel presence configuration (`presenceUserConfigs/{fullName}.presenceUserConfig-meta.xml`). Carries `label`, `capacity`, `enableAutoAccept`, `enableDecline`, `enableDeclineReason`, `enableDisconnectSound`, `enableRequestSound` (each a raw XML string, omitted when absent). `<assignments><profiles><profile>` names ARE a real `Profile` node — each emits a DECLARED `references` edge (`referenceKind: 'presenceProfileAssignment'`), mirrored onto `properties.assignedProfiles`. `<assignments><users><user>` names a username/email with NO corresponding ComponentType in this vault — captured VERBATIM (every occurrence, not just the first) as the `assignedUsernames` property array with NO edge minted, consistent with `QueueRoutingConfig.userOverflowAssignee`'s existing precedent of never fabricating a `User:` node/edge from an unconfirmed id shape. Id `PresenceUserConfig:{fullName}` — flat, no parent scope.
  // Finding #38 — Field Service tier, corrected recipe. The report's
  // suggested action ("recognize ServiceTerritory/WorkOrder/etc. via the
  // cpq.ts namespace recipe") does NOT survive verification: those objects
  // (`ServiceTerritory`, `WorkOrder`, `ServiceAppointment`, `ServiceResource`,
  // `OperatingHours`, …) are documented under Object Reference, not Metadata
  // API — standard SObjects holding record DATA, retrievable only via
  // SOQL/REST, never `sf project retrieve`. There is also no `FSL__`
  // namespace in modern (native) Field Service — that belonged to the
  // legacy pre-Winter'18 managed package. The generic CustomObject/
  // CustomField/ValidationRule/Layout/RecordType extractors already model
  // any org-added customization on those standard objects once their API
  // names are added to `STANDARD_OBJECTS_TO_MODEL`
  // (`packages/cli/src/commands/refresh.ts`) — zero new extractor code for
  // that half. The three ComponentTypes below are the genuine FSL Metadata
  // API types (per the Metadata API / Field Service Developer Guides),
  // fixture-buildable from documented XML schema, small-flat-XML shaped
  // (mirroring `SessionSettings`/`CspTrustedSite`/`ExternalDataSource`, NOT
  // `cpq.ts`'s namespace-recognition recipe). Explicitly OUT of this tier:
  // territory hierarchy, resource-to-territory assignment, and scheduling-
  // policy/work-rule records — those are live org DATA, not metadata; a
  // future `sfi.live_fsl_*` tool is the honest way to answer them, not an
  // extractor.
  | 'FieldServiceSettings' //      Org-wide Field Service configuration (`settings/FieldService.settings-meta.xml`, root `<FieldServiceSettings>`). Carries `fieldServiceEnabled` (`<fieldServiceOrgPref>`), `workOrdersEnabled` (`<enableWorkOrders>`), `schedulingOptimizationEnabled` (`<o2EngineEnabled>`) — each tri-state (`null` when the element is absent, never defaulted). Id `FieldServiceSettings:default` (single org-level node; no parent scope, no edges of its own). Refresh-gated: needs a re-refresh with the new retrieve set to populate.
  | 'Skill' //                     A skill definition used for FSL skill-based routing AND Omni-Channel/chat agent routing — the type is shared, not FSL-exclusive (`skills/{fullName}.skill-meta.xml`, root `<Skill>`, API v28.0+). Carries `description`, `skillType` (v58.0+), `assignedProfiles` (deduplicated + sorted `<assignments><profiles><profile>` values — each ALSO emits a DECLARED `references` edge to `Profile:{name}`, referenceKind `skillProfileAssignment`), and `assignedUsernames` (deduplicated + sorted `<assignments><users><user>` values — NO ComponentType exists for a bare username in this vault, so captured verbatim with no edge, mirroring `PresenceUserConfig`'s precedent). Both array properties omitted when empty. Id `Skill:{fullName}` — flat, no parent scope. `label` falls back to the API name when `<label>` is absent.
  | 'TimeSheetTemplate' //         An FSL time-sheet generation template (`timeSheetTemplates/{fullName}.timeSheetTemplate-meta.xml`, root `<TimeSheetTemplate>`, API v46.0+). Carries the six documented-required elements — `active`, `frequency`, `masterLabel` (also used as `label`), `startDate`, `workWeekStartDay`, `workWeekEndDay` — plus optional `description` and `assignedTo` (deduplicated + sorted `<timeSheetTemplateAssignments><assignedTo>` values). `assignedTo` mints NO edge: the Field Service Developer Guide describes the value only as "the IDs of the user profiles" without confirming whether real orgs populate a Profile developer name or an opaque record Id, and this codebase's honesty discipline does not fabricate a `Profile:` edge from an unconfirmed id shape — an `[ORG]` retrieve would resolve the ambiguity. Id `TimeSheetTemplate:{fullName}` — flat, no parent scope.
  // Finding #45 — CRM Analytics (Wave / Tableau CRM) slice. Three genuine
  // Metadata API types, fixture-buildable from documented XML schemas. Adding
  // them to SUPPORTED_TYPES automatically discloses coverage/blindspot via
  // `buildCoverageEntries` (dynamic notModeled, not a hardcoded family list).
  // WaveDashboard/WaveDataflow content blobs (`.wdash`/`.wdf` JSON) are out of
  // scope for v1 — node + top-level meta only (`contentModeled: false`), same
  // precedent as ExperienceBundle's page tree. WaveXmd field customizations
  // emit `references` → `CustomField:{Object}.{Field}` so safe_to_delete_field
  // / unused_fields_deep see CRMA consumption. Data Cloud (DataStream /
  // CalculatedInsight) is deferred to v1.1 ([ORG]-gated).
  | 'WaveDashboard' //             A CRM Analytics dashboard (`wave/{Name}.wdash-meta.xml`, root `<WaveDashboard>`, MetadataWithContent, API v37.0+). Carries `application`, `masterLabel` (also `label`), `description`, `templateAssetSourceName`, `dateVersion` — each null when absent. `contentModeled: false` (the companion `.wdash` JSON blob is not parsed). Id `WaveDashboard:{Name}` — flat, no parent scope, zero edges.
  | 'WaveDataflow' //              A CRM Analytics dataflow/recipe definition (`wave/{Name}.wdf-meta.xml`, root `<WaveDataflow>`, MetadataWithContent, API v37.0+). Carries `application`, `masterLabel`, `description`, `dataflowType` (`User` | `Prepared`). `contentModeled: false` (the companion `.wdf` JSON blob is not parsed). Id `WaveDataflow:{Name}` — flat, no parent scope, zero edges.
  | 'WaveXmd' //                   Extended metadata for a CRM Analytics dataset (`wave/{Name}.xmd-meta.xml`, root `<WaveXmd>`, plain Metadata, API v39.0+). Carries `application`, `dataset` (also used as `label` when present), `datasetConnector`, `datasetFullyQualifiedName`, `origin`, `xmdType` (`<type>`), `waveVisualization`, plus `dimensionCount`/`measureCount`/`dateCount`. Dimension/measure customizations whose `<origin>` or `<field>` is Object.Field-shaped each emit a DECLARED `references` edge to `CustomField:{Object}.{Field}` (`referenceKind: 'waveXmdFieldCustomization'`), mirrored onto `properties.referencedFields` (sorted; omitted when empty). Id `WaveXmd:{Name}` — flat, no parent scope.

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
  // CR-CAP-12 — Group membership topology. Group -> a member it contains, one
  // edge per `<related>` row in the `*.group-meta.xml`. The member target uses
  // the SAME variant-prefix logic the sharing-rules `sharedWith` table uses:
  // a `User` row → a dangling `User:{ref}` id (no User ComponentType, so the
  // target is dangling-by-design); a `Role` row → `Role:{ref}`; a
  // `RoleAndSubordinates` row → `Role:{ref}` carrying
  // `properties.inheritance: 'subordinates'`; a nested `Group` row →
  // `Group:{ref}` (enabling membership transitivity); a `Territory` row →
  // a `Territory:{ref}` synthetic carrying `properties.resolvable: false` so
  // consumers disclose it. Confidence `declared` (the `<related>` row is the
  // declaration) — matching the sharing-rules `sharedWith` sibling, which emits
  // the same kind of parsed-from-XML target as `declared` for consistency. The
  // kept `Group` node `properties.memberCount` is additive, not replaced. See
  // `docs/vendor/salesforce-metadata/Group.md`.
  | 'hasMember'
  // v1.2 — record types + UI surfaces tier.
  | 'belongsToApp' //      CustomTab -> CustomApplication (declared, tab/app membership)
  | 'usesValueSet' //      CustomField -> GlobalValueSet (declared, value-set reference)
  // v1.3 — legacy automation + communications tier.
  | 'sendsEmail' //        WorkflowRule / ApprovalProcess / AutoResponseRule / AssignmentRule / EscalationRule -> EmailTemplate (declared, alert / notification template reference)
  // v1.4 — developer frontend + test mapping tier.
  | 'coversTest' //        ApexClass (@isTest) -> ApexClass (covered); declared via @TestVisible/@TestSetup, heuristic from callsApex inference
  // v1.5 — integration topology + event/async/API surface tier.
  | 'exposes' //           ApexClass with @RestResource / @AuraEnabled / @InvocableMethod -> synthetic `ExternalApi:{kind}/{path}` target (declared; the annotation IS the declaration, the synthetic id is a graph-store convention not a ComponentType — see PLAN-v1.5.md §3).
  | 'dispatchesAsync' //   ApexClass (caller) -> ApexClass (Queueable / Schedulable / Batchable / @future job); declared when the dispatch shape names the target class in-line (`System.enqueueJob(new MyQueueable())`), heuristic when it passes a constructed local variable the scanner can still resolve. The @future variant is minted at GRAPH-BUILD time (CR-CAP-09, `mintFutureDispatchEdges`) by joining a `callsApex` edge to a target class with `hasFutureMethod === true`; it is `heuristic` and CLASS-GRANULAR (`properties.dispatchMechanism: 'future'`, `granularity: 'class'`) — it fires when the target class has SOME @future method, not necessarily the invoked one (method-level precision gated on CR-CAP-06). Does NOT replace `callsApex` — a caller emits both edges in parallel.
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
  | 'dispatchesOmniAction' //  {Caller} -> {OmniIntegrationProcedure | OmniDataTransform | OmniScript | OmniUiCard}. Caller can be `OmniScript` (Integration Procedure Action, DataRaptor Extract / Transform Action, navigate-to-OmniScript step), `OmniIntegrationProcedure` (Remote Action calling nested IP, DataRaptor Extract / Transform Action, chained IP Action), or `OmniUiCard` (Action widget whose `actionList[].stateAction.type` is `OmniScript` or `Integration Procedure`). Confidence: `declared` when the target name is in a top-level XML element (e.g., the `<bundle>` element of a DataRaptor Extract Action child), `parsed` when the target name is inside the `propertySetConfig` JSON blob (e.g., `integrationProcedureKey`, `actionList[].stateAction.omniType.Name`). Dangling references (target name present but no matching component in the vault) are emitted with `properties.targetMissing: true` so impact-analysis tools can surface them. The reserved Apex-to-OmniProcess edge `implementsOmniInterface` (for `implements omnistudio.VlocityOpenInterface` on Apex classes) is a v3.3 follow-up — NOT in v3.2. See PLAN-v3.2.md §4 and the per-type vendored docs.

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
  'hasMember',
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
    | 'unsupported-version'
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
  /**
   * CR-P3-3: true ONLY when the Metadata API CONFIRMED-CLEAN retrieved this
   * type — i.e. the org's `sf org list metadata-types` describe was non-null
   * AND listed this type, AND `sf project retrieve` for it returned with no
   * error (the type landed in `retrieveWithFallback.succeeded`). This is the
   * one honest signal that disambiguates "retrieved, the org genuinely has
   * zero of this type" (confirmed-empty, COMPLETE) from "not-retrieved /
   * silently-dropped / describe-blind" (the byte-identical
   * {requested:true,retrieved:0,errored:false,neverModeled:false} row), which
   * stays partial.
   *
   * HONESTY: absence === false. Old manifests (pre-signal), `--no-pull`
   * rebuilds (no retrieve ran), describe-blind pulls (could not prove the org
   * supports the type), and in-memory backfilled rows all leave this unset, so
   * they keep firing absence caveats until a full live `sfi refresh`
   * repopulates coverage. It is NEVER set from `requested` alone (`requested`
   * only means "in package.xml", which does not prove the retrieve completed)
   * and NEVER for a capped/dropped (`pending`) type.
   */
  readonly retrieveConfirmed?: boolean;
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
  | 'unknown' //              referenced, but not by automation and not a pure grant target

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
