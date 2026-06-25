---
apiName: Invoice__c.Share_Invoices_To_Finance
apiVersion: null
id: SharingRule:Invoice__c.Share_Invoices_To_Finance
label: Share Invoices To Finance
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Invoice__c
properties:
  accessLevel: Read
  booleanFilter: 1
  criteriaItemCount: 1
  ruleType: criteria
  sharedFromName: null
  sharedFromType: null
  sharedToName: Finance_Group
  sharedToType: group
sourcePath: source/main/default/sharingRules/Invoice__c.sharingRules-meta.xml
type: SharingRule
---

# Share Invoices To Finance

**API Name:** `Invoice__c.Share_Invoices_To_Finance`  
**Type:** SharingRule

## Properties

| Key | Value |
| --- | --- |
| accessLevel | `Read` |
| booleanFilter | `1` |
| criteriaItemCount | `1` |
| ruleType | `criteria` |
| sharedFromName | `null` |
| sharedFromType | `null` |
| sharedToName | `Finance_Group` |
| sharedToType | `group` |

## Incident edges

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Invoice__c` | declared | sharing-rule-extractor |

### sharedWith (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `Group:Finance_Group` | declared | sharing-rule-extractor |
