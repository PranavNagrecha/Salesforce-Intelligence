---
apiName: Project__c.Share_Projects_To_Ops
apiVersion: null
id: SharingRule:Project__c.Share_Projects_To_Ops
label: Share Projects To Ops
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  accessLevel: Edit
  booleanFilter: 1
  criteriaItemCount: 1
  ruleType: criteria
  sharedFromName: null
  sharedFromType: null
  sharedToName: Ops_Group
  sharedToType: group
sourcePath: source/main/default/sharingRules/Project__c.sharingRules-meta.xml
type: SharingRule
---

# Share Projects To Ops

**API Name:** `Project__c.Share_Projects_To_Ops`  
**Type:** SharingRule

## Properties

| Key | Value |
| --- | --- |
| accessLevel | `Edit` |
| booleanFilter | `1` |
| criteriaItemCount | `1` |
| ruleType | `criteria` |
| sharedFromName | `null` |
| sharedFromType | `null` |
| sharedToName | `Ops_Group` |
| sharedToType | `group` |

## Incident edges

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | sharing-rule-extractor |

### sharedWith (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `Group:Ops_Group` | declared | sharing-rule-extractor |
