# Demo Org Spec — "Verdant Energy" (synthetic, public, leak-free)

This is the **frozen contract** for the public demo vault. Every metadata file under
`examples/demo-vault/source/main/default/` is authored to this spec. The org is a
**fictional residential solar + battery installer**. All names are invented; there is
**zero real customer/org data**. It exists to let anyone try `sf-intelligence` in ~90
seconds without a Salesforce org, and to back all public eval/screenshots/website demos.

**Public-interface-pure:** authored from standard Salesforce metadata shapes only —
never copied from any of the maintainer's real private org vaults, nor from any
local real-org-derived reference fixture. Standard synthetic fixtures may be
consulted only as XML-shape references.

**Layout:** standard SFDX under `examples/demo-vault/source/main/default/`. Build with
`sfi refresh --no-pull` (no org/network). Verify: `status: success`, `errors: []`.

**Truth SoT (AUDIT-F7):** `truth/manifest.json` is the independent, hand-authored
correctness contract (not dumped from DuckDB). Gate:
`node sf-intelligence-qa/scripts/verdant-truth.mjs`. Update truth when design-goal
facts change; rebuild the vault when source changes.

API version for every `-meta.xml`: `<apiVersion>61.0</apiVersion>` where applicable.

## Design goals (each maps to moat tools the demo must showcase)

| Demo question | Tool(s) | Needs in the org |
| --- | --- | --- |
| "What happens when I save a Project?" | `what_happens_on_save`, `order_of_execution` | VR + record-triggered flows + trigger + approval on `Project__c` |
| "What breaks if I delete `Invoice__c.Amount__c`?" | `get_impact`, `safe_to_delete_field` | roll-up + formula + flow + apex referencing it |
| "Why can't an Installer see an Invoice?" | `why_cant_user_see_record`, `effective_permissions` | OWD + profiles + permsets + sharing rules + roles |
| "Which Apex has governor-limit risk?" | `governor_limit_risks`, `find_hardcoded_values` | SOQL-in-loop + hardcoded Id in a batch class |
| "Explain `Project__c.Margin_Percent__c`" | `explain_field`, `explain_formula`, `field_360` | formula field with cross-references |
| "What's the CPQ/OmniStudio footprint?" | `omniscript_flow`, `cpq_dependency_map` | OmniStudio sliver + SBQQ__ records |

## Standard objects referenced (NOT authored — they exist in Salesforce)

`Account`, `Contact`, `Opportunity`, `User`, `Case`.

## Custom objects (12) — exact API names, OWD, record types, fields

Field notation: `Name__c (Type[, detail])`. Lookups/MD name the target.

1. **Project__c** — label "Project"; sharingModel **Private**; RecordTypes: `Residential`, `Commercial`.
   - `Account__c` (Lookup → Account)
   - `Opportunity__c` (Lookup → Opportunity)
   - `Status__c` (Picklist: Draft, Approved, Permitting, Installing, Complete, Cancelled)
   - `System_Size_kW__c` (Number 6,2)
   - `Contract_Value__c` (Currency 16,2)
   - `Total_Invoiced__c` (Roll-Up Summary SUM of `Invoice__c.Amount__c`)
   - `Permit_Approved__c` (Checkbox)
   - `Expected_Completion__c` (Date)
   - `Is_Complete__c` (Formula Checkbox = `ISPICKVAL(Status__c,"Complete")`)
   - `Margin_Percent__c` (Formula Percent = `(Contract_Value__c - Total_Invoiced__c) / Contract_Value__c`)
   - `Risk_Score__c` (Number 3,0)
2. **Site_Survey__c** — sharingModel Private.
   - `Project__c` (Lookup → Project__c)
   - `Roof_Type__c` (Picklist: Asphalt, Metal, Tile, Flat)
   - `Shading_Factor__c` (Percent 3,0)
   - `Survey_Date__c` (Date)
   - `Surveyor__c` (Lookup → User)
3. **Installation__c** — sharingModel Private.
   - `Project__c` (Lookup → Project__c)
   - `Install_Date__c` (Date)
   - `Crew_Lead__c` (Lookup → User)
   - `Status__c` (Picklist: Scheduled, InProgress, Completed, Failed)
   - `Panels_Installed__c` (Number 4,0)
4. **Solar_Panel__c** — sharingModel ReadWrite (Public Read/Write); catalog.
   - `Manufacturer__c` (Picklist: SunGrid, HelioMax, Voltaic)
   - `Wattage__c` (Number 4,0)
   - `Unit_Cost__c` (Currency 8,2)
   - `Active__c` (Checkbox)
5. **Battery__c** — sharingModel ReadWrite; catalog.
   - `Manufacturer__c` (Picklist: PowerCell, EnerStore)
   - `Capacity_kWh__c` (Number 5,1)
   - `Unit_Cost__c` (Currency 8,2)
6. **Equipment_Allocation__c** — junction; `Project__c` is Master-Detail.
   - `Project__c` (Master-Detail → Project__c)
   - `Solar_Panel__c` (Lookup → Solar_Panel__c)
   - `Battery__c` (Lookup → Battery__c)
   - `Quantity__c` (Number 4,0)
   - `Line_Total__c` (Formula Currency = `Quantity__c * Solar_Panel__r.Unit_Cost__c`)
7. **Permit__c** — sharingModel Private.
   - `Project__c` (Lookup → Project__c)
   - `Jurisdiction__c` (Text 80)
   - `Status__c` (Picklist: Submitted, Approved, Rejected)
   - `Submitted_Date__c` (Date)
   - `Approved_Date__c` (Date)
8. **Incentive__c** — sharingModel Private.
   - `Project__c` (Lookup → Project__c)
   - `Type__c` (Picklist: Federal_Tax_Credit, State_Rebate, Utility_Rebate)
   - `Amount__c` (Currency 10,2)
   - `Approved__c` (Checkbox)
9. **Invoice__c** — `Project__c` is Master-Detail.
   - `Project__c` (Master-Detail → Project__c)
   - `Amount__c` (Currency 12,2)
   - `Due_Date__c` (Date)
   - `Status__c` (Picklist: Draft, Sent, Paid, Overdue)
   - `Total_Paid__c` (Roll-Up Summary SUM of `Payment__c.Amount__c`)
   - `Balance__c` (Formula Currency = `Amount__c - Total_Paid__c`)
10. **Payment__c** — `Invoice__c` is Master-Detail.
    - `Invoice__c` (Master-Detail → Invoice__c)
    - `Amount__c` (Currency 12,2)
    - `Payment_Date__c` (Date)
    - `Method__c` (Picklist: ACH, Card, Check, Wire)
11. **Service_Visit__c** — sharingModel Private.
    - `Installation__c` (Lookup → Installation__c)
    - `Visit_Date__c` (Date)
    - `Reason__c` (Picklist: Inspection, Repair, Warranty, Upgrade)
    - `Technician__c` (Lookup → User)
    - `Resolved__c` (Checkbox)
12. **Warranty_Claim__c** — sharingModel Private.
    - `Installation__c` (Lookup → Installation__c)
    - `Claim_Date__c` (Date)
    - `Issue__c` (LongTextArea 2000)
    - `Status__c` (Picklist: Open, In_Review, Approved, Denied)

## Automation

**Validation rules** (`objects/<Obj>/validationRules/`):
- `Project__c.Complete_Requires_Permit` — error if `ISPICKVAL(Status__c,"Complete") && NOT(Permit_Approved__c)`.
- `Payment__c.Amount_Positive` — error if `Amount__c <= 0`.
- `Permit__c.Approved_Needs_Date` — error if `ISPICKVAL(Status__c,"Approved") && ISBLANK(Approved_Date__c)`.

**Record-triggered Flows** (`flows/`):
- `Project_On_Approve` — trigger: Project__c, after save, when `Status__c` changes to `Approved` → create `Permit__c` (Status Submitted, link Project).
- `Installation_On_Complete` — trigger: Installation__c, after save, when `Status__c = Completed` → create `Service_Visit__c` (Reason Inspection) + update parent `Project__c.Status__c = Complete`.

**Workflow rule (legacy, for SOE demo)** (`workflows/Opportunity.workflow-meta.xml`):
- `Opportunity.High_Value_Flag` — rule on Opportunity (Amount > 100000) with a field update.

**Apex** (`classes/`, `triggers/`):
- `ProjectTrigger.trigger` (on Project__c, before insert/update + after update) → delegates to handler.
- `ProjectTriggerHandler.cls` — validation/derivation (sets `Risk_Score__c`).
- `PaymentService.cls` — `applyPayment(...)`; updates Invoice/Project; references `Payment__c.Amount__c`, `Invoice__c.Total_Paid__c`.
- `IncentiveBatch.cls` — `Database.Batchable`; **intentional SOQL-in-loop** + a **hardcoded 15-char Id** literal `a01000000000001` (for governor-limit + hardcoded-value demos).
- `ProjectTriggerHandlerTest.cls` — has `System.assert` calls (real test).
- `PaymentServiceTest.cls` — **no asserts** (for `meaningful_test_audit` demo).

**Approval process** (`approvalProcesses/Project__c.Discount_Approval.approvalProcess-meta.xml`):
- `Project__c` approval when `Contract_Value__c > 50000` (one step, manager approver).

## Security

**Profiles** (`profiles/`): `Verdant_Sales_Rep`, `Verdant_Installer`, `Verdant_Read_Only`.
- Give each realistic object/field perms over the custom objects (e.g. Sales Rep CRU on Project/Invoice; Installer R on Project, CRU on Installation/Service_Visit; Read Only R-only). Include FLS entries referencing real field API names from above.

**Permission sets** (`permissionsets/`): `Project_Manager` (edit Project/Permit), `Finance_Team` (edit Invoice/Payment).

**Permission set assignments** (`permissionsetassignments/` if extractor supports, else note): assign `Project_Manager` + `Finance_Team` to sample users (use invented usernames like `pm@verdant.example.com`).

**Roles** (`roles/`): `Sales_VP` → `Sales_Manager` → `Sales_Rep`; `Ops_Director` → `Ops_Manager` → `Installer` (use `<parentRole>`).

**Groups** (`groups/`): `Finance_Group`, `Ops_Group`.

**Queues** (`queues/`): `Permit_Review_Queue` (Permit__c), `Warranty_Queue` (Warranty_Claim__c).

**Sharing rules** (`sharingRules/`): `Project__c.sharingRules-meta.xml` — criteria/owner rule sharing Project to `Ops_Group` (Read/Write). `Invoice__c.sharingRules-meta.xml` — share to `Finance_Group` (Read).

**Layouts** (`layouts/`): `Project__c-Residential Layout.layout-meta.xml`, `Installation__c-Installation Layout.layout-meta.xml`. **Record types**: under `objects/Project__c/recordTypes/` `Residential` + `Commercial`.

## OmniStudio + CPQ sliver

- OmniScript `omniScripts/Customer_Intake_English_1.os-meta.xml` (intake form; root `<OmniScript>`).
- IntegrationProcedure `omniIntegrationProcedures/Project_Provision_1.oip-meta.xml`.
- DataTransform `omniDataTransforms/Quote_To_Project_Map_1.rpt-meta.xml`.
- CPQ: `objects/SBQQ__ProductRule__c/` + a couple `SBQQ__`-prefixed records (or customMetadata) to trip the heuristic CPQ detector. Keep minimal — presence over depth.

## R6/R6B Fixture Coverage (added R7-F5)

The following metadata families were added to cover R6/R6B extractor gaps. Each has
one minimal-but-valid synthetic stub. All names are Verdant Energy fictional; zero
real org data.

| Metadata family | DX folder | File(s) added | Extractor |
| --- | --- | --- | --- |
| SamlSsoConfig | `samlssoconfigs/` | `Verdant_Energy_SSO.samlssoconfig-meta.xml` | `extractSamlSsoConfig` |
| StandardValueSet | `standardValueSets/` | `Status__c.standardValueSet-meta.xml` | `extractStandardValueSet` |
| MutingPermissionSet | `mutingpermissionsets/` | `Sales_Muting.mutingpermissionset-meta.xml` | `extractMutingPermissionSet` |
| Network | `networks/` | `VerdantPortal.network-meta.xml` | `extractNetwork` |
| CustomSite | `sites/` | `VerdantPortal.site-meta.xml` | `extractCustomSite` |
| ExperienceBundle | `experiences/` | `VerdantPortal1.site-meta.xml` + `views/home.json` | `extractExperienceBundle` |
| Bot | `bots/Verdant_Support_Agent/` | `Verdant_Support_Agent.bot-meta.xml` | `extractBot` |
| BotVersion | `bots/Verdant_Support_Agent/` | `v1.botVersion-meta.xml` | `extractBotVersion` |
| GenAiPlannerBundle | `genAiPlannerBundles/Verdant_Support_Agent_v1/` | `Verdant_Support_Agent_v1.genAiPlannerBundle-meta.xml` | `extractGenAiPlannerBundle` |
| WaveDashboard | `wave/` | `Ops_Overview.wdash-meta.xml` | `extractWaveDashboard` |
| WaveXmd | `wave/` | `Project_Pipeline.xmd-meta.xml` | `extractWaveXmd` |
| Skill | `skills/` | `Solar_Installation.skill-meta.xml` | `extractSkill` |
| TimeSheetTemplate | `timeSheetTemplates/` | `Field_Crew_Weekly.timeSheetTemplate-meta.xml` | `extractTimeSheetTemplate` |
| AuthProvider | `authproviders/` | `Verdant_SSO_Provider.authprovider-meta.xml` | `extractAuthProvider` |
| NamedCredential | `namedCredentials/` | `Verdant_Permitting_API.namedCredential-meta.xml` | `extractNamedCredential` |
| ConnectedApp | `connectedApps/` | `Verdant_Marketing_Suite.connectedApp-meta.xml` | `extractConnectedApp` |
| Certificate | `certs/` | `Verdant_Community.crt-meta.xml` + `Verdant_Community.crt` | `extractCertificate` |
| TransactionSecurityPolicy | `transactionSecurityPolicies/` | `Block_Suspicious_Login.transactionSecurityPolicy-meta.xml` | `extractTransactionSecurityPolicy` |
| PlatformEventChannel | `platformEventChannels/` | `Verdant_Event_Channel__chn.platformEventChannel-meta.xml` | `extractPlatformEventChannel` |
| PlatformEventChannelMember | `platformEventChannelMembers/` | `Verdant_Event_Member__chn.platformEventChannelMember-meta.xml` | `extractPlatformEventChannelMember` |
| GlobalValueSet | `globalValueSets/` | `Solar_Equipment_Types.globalValueSet-meta.xml` | `extractGlobalValueSet` |
| NetworkAccess | `networkAccesses/` | `Office_VPN.networkAccess-meta.xml` | `extractNetworkAccess` |

### Supported types NOT yet stubbed in this vault

These types have extractors on this branch but no demo-vault fixture yet:

| Type | Reason |
| --- | --- |
| `GenAiFunction`, `GenAiPlugin`, `GenAiPromptTemplate` | Covered by BotVersion→GenAiPlannerBundle chain above; standalone stubs deferred |
| `WaveDataflow` | CRMA dataflow JSON is large; WaveDashboard + WaveXmd cover the CRMA read path |
| `AssignmentRule`, `AutoResponseRule`, `EscalationRule` | Exist in v1.3 builder fixtures; deferred as low-priority for demo story |
| `CustomApplication`, `CustomTab`, `CustomLabel`, `StaticResource`, `PathAssistant`, `QuickAction` | Exist in v1.2/v1.3 builder fixtures; present in some builder synthetics but not yet ported to demo-vault |
| `Letterhead`, `EmailTemplate` | Low demo-story priority |
| `OmniUiCard` | OmniStudio tier partially covered; deferred |
| `DuplicateRule`, `MatchingRule` | Low demo-story priority |
| `FieldServiceSettings` | Single-singleton extractor; deferred |
| `PresenceUserConfig`, `ServiceChannel`, `QueueRoutingConfig`, `EntitlementProcess`, `MilestoneType` | Service Cloud tier; deferred |
| `InstalledPackage`, `ReportType`, `Report`, `Dashboard` | Complex/large; low demo priority |
| `PermissionSetGroup`, `ScopingRule`, `RestrictionRule`, `ValidationRule`, `RecordType`, `BusinessProcess`, `CompactLayout`, `FieldSet`, `Index`, `ListView`, `WebLink` | Sub-object types extracted from objects/; already implicit via objects/ stubs |
| `AuraDefinitionBundle`, `LightningComponentBundle`, `VisualforceComponent`, `VisualforcePage`, `FlexiPage`, `DecisionTable` | UI/markup tier; deferred |
| `ExternalDataSource`, `ExternalService`, `CspTrustedSite`, `RemoteSiteSetting`, `SessionSettings` | Integration/security tier; NetworkAccess + NamedCredential + ConnectedApp + AuthProvider cover the priority surface |
