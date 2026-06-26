---
generatedAt: 2026-06-25T15:19:46.650Z
kind: org-card
refreshedAt: 2026-06-25T15:19:46.650Z
sourceTreeHash: ec3078be5664a9ac51be30123be8bbf4b2747acc85fbd99aa38f2c22e45e8824
---

# Org card — demo-org

Offline snapshot of one Salesforce org. Source-tree hash `ec3078be5664a9ac51be30123be8bbf4b2747acc85fbd99aa38f2c22e45e8824`; vault refreshed 2026-06-25T15:19:46.650Z. Answers ground in THIS snapshot — verify freshness with `sfi.health_check` before trusting time-sensitive claims.

## Coverage & blind spots

Coverage status: **partial** — 19 metadata families retrieved.
- Partial (retrieved with errors/limits): AssignmentRule, AuraDefinitionBundle, AuthProvider, AutoResponseRule, BusinessProcess, CompactLayout, ConnectedApp, CspTrustedSite, CustomApplication, CustomLabel, CustomMetadataRecord, CustomSettingRecord, CustomTab, Dashboard, DecisionTable, DuplicateRule, EmailTemplate, EscalationRule, ExternalDataSource, ExternalService, FieldSet, FlexiPage, GlobalValueSet, Index, InstalledPackage, Letterhead, LightningComponentBundle, ListView, MatchingRule, MutingPermissionSet, NamedCredential, NetworkAccess, OmniUiCard, PathAssistant, PermissionSetGroup, QuickAction, RemoteSiteSetting, Report, ReportType, RestrictionRule, ScopingRule, StaticResource, VisualforceComponent, VisualforcePage, WebLink

## Scale

113 components, 323 dependency edges.

| Type | Count |
| --- | --- |
| CustomField | 63 |
| CustomObject | 13 |
| Role | 6 |
| ApexClass | 5 |
| Profile | 3 |
| ValidationRule | 3 |
| Flow | 2 |
| Group | 2 |
| Layout | 2 |
| PermissionSet | 2 |
| Queue | 2 |
| RecordType | 2 |
| SharingRule | 2 |
| ApexTrigger | 1 |
| ApprovalProcess | 1 |
| OmniDataTransform | 1 |
| OmniIntegrationProcedure | 1 |
| OmniScript | 1 |
| WorkflowRule | 1 |

## Where the org's gravity is (top objects by inbound dependencies)

Inbound dependency edges per object (structural containment excluded), over 13 scanned objects:

| Object | Inbound refs |
| --- | --- |
| `CustomObject:Project__c` | 17 |
| `CustomObject:Installation__c` | 5 |
| `CustomObject:Invoice__c` | 5 |
| `CustomObject:Battery__c` | 4 |
| `CustomObject:Incentive__c` | 4 |
| `CustomObject:Permit__c` | 4 |
| `CustomObject:Solar_Panel__c` | 4 |
| `CustomObject:Service_Visit__c` | 3 |
| `CustomObject:Site_Survey__c` | 3 |
| `CustomObject:Warranty_Claim__c` | 3 |
| `CustomObject:Payment__c` | 2 |
| `CustomObject:Equipment_Allocation__c` | 1 |
| `CustomObject:SBQQ__ProductRule__c` | 0 |

## Automation density

| Automation | Total | Active |
| --- | --- | --- |
| Flow | 2 | 2 |
| ApexTrigger | 1 | 1 |
| WorkflowRule | 1 | 1 |
| ApprovalProcess | 1 | 1 |

## Permissions posture

3 profiles, 2 permission sets. 0 of 5 scanned containers hold View All Data / Modify All Data (god-mode — see `sfi.permission_risk_report`).

## Integration surface

No integration components retrieved (auth providers, named credentials, external services…).

## Naming conventions (observed, heuristic)

- Custom fields on Invoice__c use PascalCase naming (4 of 6 fields) (4/6 fields)
- Custom fields on Service_Visit__c use PascalCase naming (4 of 5 fields) (4/5 fields)
- Custom fields on Equipment_Allocation__c use PascalCase naming (3 of 5 fields) (3/5 fields)
- Custom fields on Permit__c use PascalCase naming (3 of 5 fields) (3/5 fields)

## Data-shape facts

Not captured — run `sfi refresh --with-data-shape` (opt-in live plane) to capture approximate counts and fill rates.

## How to ask

1. Vague question → `sfi.route_question` first; it names the right tool(s).
2. Informal component name → `sfi.resolve` first; never guess a canonical id.
3. Cite canonical ids (`CustomObject:Account`, `CustomField:Account.Industry`).
4. Check `sfi.coverage_report` before any absence-based claim (not modeled ≠ none).
5. Record-level data (counts, samples) needs the opt-in live plane — vault answers are metadata-only.
