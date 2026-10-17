---
generatedAt: 2026-10-17T16:10:41.527Z
kind: org-card
refreshedAt: 2026-10-17T16:10:41.527Z
sourceTreeHash: 937e69c4140fa1b350bf5c90b68d850e6b314bf005122976ccf07520ce92cb33
---

# Org card — demo-org

Offline snapshot of one Salesforce org. Source-tree hash `937e69c4140fa1b350bf5c90b68d850e6b314bf005122976ccf07520ce92cb33`; vault refreshed 2026-10-17T16:10:41.527Z. Answers ground in THIS snapshot — verify freshness with `sfi.health_check` before trusting time-sensitive claims.

## Coverage & blind spots

Coverage status: **partial** — 42 metadata families retrieved.
- Partial (retrieved with errors/limits): Dashboard, Report, AssignmentRule, AuraDefinitionBundle, AutoResponseRule, BusinessProcess, CompactLayout, CspTrustedSite, CustomApplication, CustomLabel, CustomMetadataRecord, CustomPermission, CustomSettingRecord, CustomTab, DecisionTable, DuplicateRule, EmailTemplate, EntitlementProcess, EscalationRule, ExternalDataSource, ExternalService, FieldServiceSettings, FieldSet, FlexiPage, GenAiFunction, GenAiPlugin, GenAiPromptTemplate, Index, InstalledPackage, Letterhead, ListView, MatchingRule, MilestoneType, OmniUiCard, PathAssistant, PermissionSetGroup, PresenceUserConfig, QueueRoutingConfig, QuickAction, RemoteSiteSetting, ReportType, RestrictionRule, ScopingRule, SecuritySettings, ServiceChannel, SessionSettings, SharingSet, StaticResource, VisualforceComponent, VisualforcePage, WaveDataflow, WebLink
- NOT modeled (1 families — absence of these is NEVER evidence): certs

## Scale

141 components, 361 dependency edges.

| Type | Count |
| --- | --- |
| CustomField | 64 |
| CustomObject | 13 |
| Role | 6 |
| ApexClass | 5 |
| OmniScript | 4 |
| Flow | 3 |
| Profile | 3 |
| ValidationRule | 3 |
| Group | 2 |
| Layout | 2 |
| PermissionSet | 2 |
| Queue | 2 |
| RecordType | 2 |
| SharingRule | 2 |
| ApexTrigger | 1 |
| ApprovalProcess | 1 |
| AuthProvider | 1 |
| Bot | 1 |
| BotVersion | 1 |
| Certificate | 1 |
| ConnectedApp | 1 |
| CustomSite | 1 |
| ExperienceBundle | 1 |
| GenAiPlannerBundle | 1 |
| GlobalValueSet | 1 |
| LightningComponentBundle | 1 |
| MutingPermissionSet | 1 |
| NamedCredential | 1 |
| Network | 1 |
| NetworkAccess | 1 |
| OmniDataTransform | 1 |
| OmniIntegrationProcedure | 1 |
| PlatformEventChannel | 1 |
| PlatformEventChannelMember | 1 |
| SamlSsoConfig | 1 |
| Skill | 1 |
| StandardValueSet | 1 |
| TimeSheetTemplate | 1 |
| TransactionSecurityPolicy | 1 |
| WaveDashboard | 1 |
| WaveXmd | 1 |
| WorkflowRule | 1 |

## Where the org's gravity is (top objects by inbound dependencies)

Inbound dependency edges per object (structural containment excluded), over 13 scanned objects:

| Object | Inbound refs |
| --- | --- |
| `CustomObject:Project__c` | 20 |
| `CustomObject:Invoice__c` | 6 |
| `CustomObject:Installation__c` | 5 |
| `CustomObject:Battery__c` | 4 |
| `CustomObject:Incentive__c` | 4 |
| `CustomObject:Permit__c` | 4 |
| `CustomObject:Solar_Panel__c` | 4 |
| `CustomObject:Payment__c` | 3 |
| `CustomObject:Service_Visit__c` | 3 |
| `CustomObject:Site_Survey__c` | 3 |
| `CustomObject:Warranty_Claim__c` | 3 |
| `CustomObject:Equipment_Allocation__c` | 1 |
| `CustomObject:SBQQ__ProductRule__c` | 0 |

## Automation density

| Automation | Total | Active |
| --- | --- | --- |
| Flow | 3 | 3 |
| ApexTrigger | 1 | 1 |
| WorkflowRule | 1 | 1 |
| ApprovalProcess | 1 | 1 |

## Permissions posture

3 profiles, 2 permission sets. 0 of 5 scanned containers hold View All Data / Modify All Data (god-mode — see `sfi.permission_risk_report`).

## Integration surface

AuthProvider: 1 · ConnectedApp: 1 · NamedCredential: 1 · NetworkAccess: 1

## Naming conventions (observed, heuristic)

- `Custom fields on Invoice__c use PascalCase naming (4 of 6 fields)` (4/6 fields)
- `Custom fields on Service_Visit__c use PascalCase naming (4 of 5 fields)` (4/5 fields)
- `Custom fields on Equipment_Allocation__c use PascalCase naming (3 of 5 fields)` (3/5 fields)
- `Custom fields on Permit__c use PascalCase naming (3 of 5 fields)` (3/5 fields)

## Data-shape facts

Not captured — run `sfi refresh --with-data-shape` (opt-in live plane) to capture approximate counts and fill rates.

## How to ask

1. Vague question → `sfi.resolve` the name you mean, then ask; `sfi.list_analyses` shows what else is available.
2. Informal component name → `sfi.resolve` first; never guess a canonical id.
3. Cite canonical ids (`CustomObject:Account`, `CustomField:Account.Industry`).
4. Check `sfi.coverage_report` before any absence-based claim (not modeled ≠ none).
5. Record-level data (counts, samples) needs the opt-in live plane — vault answers are metadata-only.
