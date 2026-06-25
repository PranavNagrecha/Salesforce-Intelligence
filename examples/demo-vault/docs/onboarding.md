<!-- onboarding handbook · generated 2026-06-25T15:19:46.808Z · source ec3078be5664a9ac51be30123be8bbf4b2747acc85fbd99aa38f2c22e45e8824 -->
# Welcome to demo-org

## What This Org Does

This is a structured tour of `demo-org` for a new admin.
Total CustomObjects: 13  
Total ApexClasses: 5  
Total Flows: 2

## Main Data Model

| Object | Inbound references |
| --- | --- |
| `CustomObject:Project__c` | 17 |
| `CustomObject:Installation__c` | 5 |
| `CustomObject:Invoice__c` | 5 |

## Common Workflows

Automations extracted: 1 workflow rules, 2 flows, 1 apex triggers.
Active ratio: 1.00

## How Security Works

Profiles: 3  
PermissionSets: 2  
Top profile (by grants): Verdant_Read_Only

## Naming Conventions

- Custom fields on Equipment_Allocation__c use PascalCase naming (3 of 5 fields)
- Custom fields on Invoice__c use PascalCase naming (4 of 6 fields)
- Custom fields on Permit__c use PascalCase naming (3 of 5 fields)
- Custom fields on Service_Visit__c use PascalCase naming (4 of 5 fields)

## Glossary

| Term | Source field | Objects |
| --- | --- | --- |
| Account | `Account__c` | 1 |
| Active | `Active__c` | 1 |
| Approved Date | `Approved_Date__c` | 1 |
| Approved | `Approved__c` | 1 |
| Balance | `Balance__c` | 1 |
| Battery | `Battery__c` | 1 |
| Capacity (kWh) | `Capacity_kWh__c` | 1 |
| Claim Date | `Claim_Date__c` | 1 |
| Contract Value | `Contract_Value__c` | 1 |
| Crew Lead | `Crew_Lead__c` | 1 |
| Due Date | `Due_Date__c` | 1 |
| Expected Completion | `Expected_Completion__c` | 1 |
| Install Date | `Install_Date__c` | 1 |
| Invoice | `Invoice__c` | 1 |
| Is Complete | `Is_Complete__c` | 1 |
| Issue | `Issue__c` | 1 |
| Jurisdiction | `Jurisdiction__c` | 1 |
| Line Total | `Line_Total__c` | 1 |
| Margin Percent | `Margin_Percent__c` | 1 |
| Method | `Method__c` | 1 |
| Opportunity | `Opportunity__c` | 1 |
| Panels Installed | `Panels_Installed__c` | 1 |
| Payment Date | `Payment_Date__c` | 1 |
| Permit Approved | `Permit_Approved__c` | 1 |
| Quantity | `Quantity__c` | 1 |
| Reason | `Reason__c` | 1 |
| Resolved | `Resolved__c` | 1 |
| Risk Score | `Risk_Score__c` | 1 |
| Roof Type | `Roof_Type__c` | 1 |
| Error Message | `SBQQ__ErrorMessage__c` | 1 |

## Key Contacts

Key Contacts data depends on v1.7 enrichment. Run `sfi refresh --with-tooling-api` to populate `lastModifiedBy` for the enriched types.

## Where To Go Next

- Run `sfi.org_overview` for a structured tour of the org.
- Run `sfi.unused_components` to find dead-weight components ripe for cleanup.
- Run `sfi.field_access_audit` on a specific field to investigate who can see it.
- Run `sfi.why_cant_user_see_record` when a user reports a missing record.

## Boundaries

Generated from offline vault on 2026-06-25T15:19:46.650Z; missing real-time data, debug logs, runtime metrics.

Section confidence is inherited from the source edges; spot-check heuristic entries before treating as authoritative.

Document is structure, not narrative; prose polish happens at the rendering layer.

## How To Regenerate

Re-run `sfi.generate_onboarding_doc({ personaFocus: 'admin' })` after the next `sfi refresh`.
