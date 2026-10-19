# Extractor gaps: good first issues

Each section below is one self-contained job: a metadata element that carries a reference today but never becomes a graph edge, so a verdict tool (where-used, dead code, safe-to-delete, unused components, effective permissions) answers wrongly. They come from the 2026-10 gap analysis; the three largest (Flow screens and non-Apex actions, component markup field bindings, Classic layout related lists) shipped in 0.6.0 and are the worked examples to copy.

Rules that apply to every one of them:

- Mint an edge only to a component id you can derive from the metadata. Never build an id by splitting a token on a dot and treating the prefix as an object; resolve it through what the vault declares (a variable's object type, a lookup field's owning object, a relationship index). When it does not resolve, record the token on the node (`unresolvedX`) and mint nothing.
- Fixtures use `Demo_` / `Acme_` names only. No real org data, ever.
- Run the whole `extractors` and `graph` test suites, not only the test you add.
- Update the extractor's JSDoc and the `docs/` page that describes that metadata type; `node scripts/verify-doc-sync.mjs` must pass.
- Add `changelog.d/<slug>.md` with one `### Fixed` bullet written for an admin.

Open an issue from `.github/ISSUE_TEMPLATE/extractor-gap.md` and paste the section in.

## 1. Flow: formula resources and text templates that read fields but are never consumed by a data operation

- **Where it is dropped today:** packages/extractors/src/flow-dataflow.ts (formulas are indexed only to trace DML sources; `textTemplates` never read)
- **Edge to mint:** Flow → CustomField `readsFrom` for each `{!$Record.Field}` / `{!var.Field}` token whose variable resolves (the same dataflow index the Flow screen extractor uses); confidence parsed
- **Unresolvable case:** a token whose variable has no object type mints nothing and is listed in `unresolvedFormulaRefs`
- **Verdict this corrects:** where-used and safe-to-delete miss a field read only in a displayed formula
- **Fixture and test:** flow with a formula reading `{!Demo_Rec.Demo_Field__c}` and a text template; assert one readsFrom edge per field

## 2. Flow: dynamic choice sets (`object`, `displayField`, `valueField`, `filters[].field`, `picklistField`), `transforms`, `collectionProcessors`, `customErrors[].fieldSelection`, `recordLookups[].queriedFields`

- **Where it is dropped today:** packages/extractors/src/flow.ts (not read); listed as unmodeled in packages/extractors/src/flow-graph.ts
- **Edge to mint:** Flow → CustomField `readsFrom` (choice sets, collection processors, queriedFields) and `writesTo` (transforms, custom error field selection); confidence declared where the element names the object
- **Unresolvable case:** a choice set whose `object` is absent mints nothing
- **Verdict this corrects:** fields read only to populate a picker or filter a collection read as unused
- **Fixture and test:** flow with one dynamicChoiceSet and one collectionProcessor on `Demo_Obj__c`; assert the readsFrom edges

## 3. CustomField: `lookupFilter.filterItems[].field` / `valueField`

- **Where it is dropped today:** packages/extractors/src/custom-field.ts (zero hits for `lookupFilter`)
- **Edge to mint:** CustomField (the lookup) → CustomField `references` for each filter field, confidence declared; the filter's source object is the lookup's `referenceTo`
- **Unresolvable case:** a filter field on an object not in the vault stays a property `lookupFilterUnresolved`
- **Verdict this corrects:** deleting a field used in a lookup filter breaks the filter; delete_impact is silent
- **Fixture and test:** a lookup field with a filterItems block; assert one references edge per filter field

## 4. Report: `crossFilters` (`relatedTable`, `criteriaItems.column`)

- **Where it is dropped today:** packages/extractors/src/enterprise-metadata.ts (cross filters removed before the sweep)
- **Edge to mint:** Report → CustomField `references` for each cross-filter criteria column, resolved through the related table
- **Unresolvable case:** unresolvable related table → `unresolvedCrossFilters`
- **Verdict this corrects:** a field used only in a cross filter reads as unused
- **Fixture and test:** report with one cross filter; assert the edge

## 5. PathAssistant: `fieldName` (the picklist), `entityName`, `recordTypeName`, `steps[].picklistValueName`

- **Where it is dropped today:** packages/extractors/src/path-assistant.ts (properties only; edges are `parentOf`)
- **Edge to mint:** PathAssistant → CustomField `readsFrom` (the picklist), → RecordType `references`; confidence declared
- **Unresolvable case:** none needed: both are declared api names
- **Verdict this corrects:** the picklist driving a Path has no edge, so safe_to_delete_field and what_if_remove_picklist_value cannot see the Path
- **Fixture and test:** path assistant on `Demo_Obj__c.Demo_Stage__c`; assert field and record type edges

## 6. DecisionTable: `sourceObject`, `conditionCriteria`, `decisionTableParameters[].fieldName`

- **Where it is dropped today:** packages/extractors/src/decision-table.ts (`edges: []`)
- **Edge to mint:** DecisionTable → CustomObject `references`, → CustomField `readsFrom` per parameter field; confidence declared
- **Unresolvable case:** parameter without a resolvable object → `unresolvedParameters`
- **Verdict this corrects:** objects and fields consumed by a Business Rules Engine table have no inbound edge
- **Fixture and test:** decision table with two parameters; assert object + two field edges

## 7. Workflow outbound message: `fields` (payload field list)

- **Where it is dropped today:** packages/extractors/src/workflow-rule.ts (read for display only)
- **Edge to mint:** OutboundMessage → CustomField `readsFrom` per payload field on the rule's object; confidence declared
- **Unresolvable case:** none: the object is the workflow's object
- **Verdict this corrects:** a field whose only consumer is an outbound-message payload reads as unused; integration impact missed
- **Fixture and test:** workflow with an outbound message listing two fields; assert the two readsFrom edges

## 8. Workflow field update: fields READ inside the update `formula`

- **Where it is dropped today:** packages/extractors/src/workflow-rule.ts (file emits no readsFrom edges)
- **Edge to mint:** FieldUpdate → CustomField `readsFrom` via the shared condition/formula extractor (packages/extractors/src/condition-extractor.ts, already used for rule criteria)
- **Unresolvable case:** unresolvable traversal → the extractor's existing unresolved list
- **Verdict this corrects:** field_lineage and where-used miss the read side of a field update
- **Fixture and test:** field update whose formula reads `Demo_A__c` and sets `Demo_B__c`; assert readsFrom A and writesTo B

## 9. CustomObject: `searchLayouts.*AdditionalFields`, `customHelpPage`

- **Where it is dropped today:** packages/extractors/src/custom-object.ts (only list-view buttons are read)
- **Edge to mint:** CustomObject → CustomField `references` (search result columns), → VisualforcePage `references` (help page); confidence declared
- **Unresolvable case:** none
- **Verdict this corrects:** fields shown only in search or lookup result columns, and a VF help page, read as unused
- **Fixture and test:** object with searchLayouts naming two fields and a customHelpPage; assert three edges

## 10. OmniScript: `saveURLPatterns` field writes

- **Where it is dropped today:** packages/extractors/src/omniscript.ts (zero hits; the external reviewer's finding)
- **Edge to mint:** OmniScript → CustomField `writesTo` per pattern that names a field; confidence parsed
- **Unresolvable case:** a pattern that does not name a field mints nothing
- **Verdict this corrects:** where-used missed an OmniScript that writes the field
- **Fixture and test:** OmniScript with one save pattern; assert the writesTo edge

## 11. EmailTemplate: Visualforce page the template renders (`visualforcePageRef`)

- **Where it is dropped today:** packages/extractors/src/email-template.ts (property stored, no edge)
- **Edge to mint:** EmailTemplate → VisualforcePage `references`, confidence declared
- **Unresolvable case:** none
- **Verdict this corrects:** a VF email-template page referenced only by a template is an unused_components false positive
- **Fixture and test:** template with a pageRef; assert the edge

## 12. CustomObject, CustomApplication: record page overrides (`actionOverrides` → FlexiPage or VF page), app default pages, `utilityBar`

- **Where it is dropped today:** packages/extractors/src/custom-object.ts, custom-application.ts, record-page-overrides.ts (captured, no `FlexiPage:` edge anywhere)
- **Edge to mint:** CustomObject/CustomApplication → FlexiPage `references` (or VisualforcePage for VF-type overrides); confidence declared
- **Unresolvable case:** none
- **Verdict this corrects:** the org's default record page has zero inbound edges and reads as unused; delete_impact on the page finds no dependents
- **Fixture and test:** object with a Lightning record page override and an app with a utility bar; assert both edges

## 13. FlexiPage: custom components placed on the page (`componentInstance.componentName` = `c:…`)

- **Where it is dropped today:** packages/extractors/src/enterprise-metadata.ts (only embedded flow interviews are handled)
- **Edge to mint:** FlexiPage → LightningComponentBundle / AuraDefinitionBundle `references`; confidence declared
- **Unresolvable case:** a component not in the vault stays a referenced-but-absent stub
- **Verdict this corrects:** an LWC placed only on a Lightning page is an unused_components false positive
- **Fixture and test:** flexipage with one `c:demoWidget` instance; assert the edge

## 14. Layout: `quickActionList.quickActionListItems.quickActionName`, `relatedContent.relatedContentItems.layoutItem.{component,page,field}`, `feedLayout`

- **Where it is dropped today:** packages/extractors/src/layout.ts (zero hits)
- **Edge to mint:** Layout → QuickAction / VisualforcePage / CustomField `references` (`usedInLayout` for fields); confidence declared
- **Unresolvable case:** none
- **Verdict this corrects:** Classic-publisher quick actions and mobile-card pages placed only via these blocks have no inbound edge
- **Fixture and test:** layout with a quick action list and a related-content page; assert the edges

## 15. Bot (Einstein): `botDialogs[].botSteps[].botInvocation.invocableAction` (apex / flow + name), `botVariableOperation`, `conversationRecordLookup`

- **Where it is dropped today:** packages/extractors/src/bot.ts (only counts are extracted)
- **Edge to mint:** Bot → ApexClass (invocable) / Flow `callsApex` / `references`; confidence declared
- **Unresolvable case:** an action name that matches no class or flow stays a stub
- **Verdict this corrects:** invocable Apex or an autolaunched flow called only by a bot reads as dead
- **Fixture and test:** bot with one apex step and one flow step; assert both edges

## 16. ExperienceBundle: the page tree under `experiences/<name>/views|routes|config/*.json` (component names, flow names, audience field criteria)

- **Where it is dropped today:** packages/extractors/src/experience-bundle.ts (explicitly out of scope; files are counted, not read)
- **Edge to mint:** ExperienceBundle → LightningComponentBundle / Flow / VisualforcePage `references`; audience criteria → CustomField `readsFrom`; confidence declared
- **Unresolvable case:** unknown component names stay stubs
- **Verdict this corrects:** LWC, flows and VF used only in a community read as unused
- **Fixture and test:** bundle with one view naming `c:demoWidget` and one route with a flow; assert the edges

## 17. Profile, PermissionSet: `tabSettings` / `tabVisibilities`, `applicationVisibilities`, `layoutAssignments`, `recordTypeVisibilities` as EDGES

- **Where it is dropped today:** packages/extractors/src/permission-set.ts, profile.ts (parsed to properties only)
- **Edge to mint:** Profile/PermissionSet → CustomTab / CustomApplication / Layout / RecordType `grantedBy` (access, not usage; the tools already treat grantedBy that way)
- **Unresolvable case:** none
- **Verdict this corrects:** find_component_usages(Layout | CustomTab | CustomApplication) and unused_components cannot see profile assignments
- **Fixture and test:** profile with one layout assignment and one tab setting; assert the two grantedBy edges

## 18. QuickAction: `targetRecordType`, `targetParentField`

- **Where it is dropped today:** packages/extractors/src/quick-action.ts (zero hits)
- **Edge to mint:** QuickAction → RecordType `references`, → CustomField `references`; confidence declared
- **Unresolvable case:** none
- **Verdict this corrects:** a record type used only as a quick-action default has no inbound edge
- **Fixture and test:** quick action with a target record type; assert the edge

## 19. Wave (CRM Analytics): `.wdash` / `.wdf` JSON bodies (`sfdcDigest.fields`, dataset references)

- **Where it is dropped today:** packages/extractors/src/wave.ts (deliberately out of scope)
- **Edge to mint:** WaveDataflow → CustomField `readsFrom` per digest field; WaveDashboard → WaveDataset `references`; confidence declared
- **Unresolvable case:** unknown datasets stay stubs
- **Verdict this corrects:** CRM Analytics field consumers are invisible to where-used and safe-to-delete
- **Fixture and test:** dataflow JSON with one sfdcDigest naming two fields; assert the edges

## 20. AuthProvider, SamlSsoConfig: `registrationHandler`, `executionUser`, `samlJitHandlerId`

- **Where it is dropped today:** packages/extractors/src/auth-provider.ts, saml-sso-config.ts (no edges)
- **Edge to mint:** AuthProvider/SamlSsoConfig → ApexClass `references`; confidence declared (verify whether the retrieved value is a name or an 18-character id before minting)
- **Unresolvable case:** an id-shaped value mints nothing and is recorded as `handlerUnresolved`
- **Verdict this corrects:** find_component_usages on the handler class shows nothing; dead-code only hedges it via its interface
- **Fixture and test:** auth provider naming a handler class; assert the edge

## 21. ConnectedApp: `profileName`, `permissionsetName` (pre-authorized), `canvasConfig`

- **Where it is dropped today:** packages/extractors/src/connected-app.ts (no edges)
- **Edge to mint:** ConnectedApp → Profile / PermissionSet `references`; confidence declared
- **Unresolvable case:** none
- **Verdict this corrects:** app_access and persona tools cannot answer which profiles are pre-authorized for an app
- **Fixture and test:** connected app with one pre-authorized profile; assert the edge

## 22. Profile, PermissionSet: `customMetadataTypeAccesses`, `customSettingAccesses`, `externalDataSourceAccesses`

- **Where it is dropped today:** packages/extractors/src/permission-set.ts, profile.ts (zero hits)
- **Edge to mint:** Profile/PermissionSet → CustomObject (the CMDT / custom setting) / ExternalDataSource `grantedBy`; confidence declared
- **Unresolvable case:** none
- **Verdict this corrects:** effective_permissions and persona tools answer "nobody is granted this" for grants that exist
- **Fixture and test:** permission set with one customMetadataTypeAccess; assert the grantedBy edge
