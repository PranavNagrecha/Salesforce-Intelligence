---
apiName: Finance_Team
apiVersion: null
id: PermissionSet:Finance_Team
label: Finance Team
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  applicationVisibilities: []
  classGrantCount: 0
  description: null
  fieldGrantCount: 9
  flowGrantCount: 0
  hasActivationRequired: false
  license: null
  objectGrantCount: 3
  tabVisibilities: []
  userPermissions: []
sourcePath: source/main/default/permissionsets/Finance_Team.permissionset-meta.xml
type: PermissionSet
---

# Finance Team

**API Name:** `Finance_Team`  
**Type:** PermissionSet

## Properties

| Key | Value |
| --- | --- |
| applicationVisibilities | `` |
| classGrantCount | `0` |
| fieldGrantCount | `9` |
| flowGrantCount | `0` |
| hasActivationRequired | `false` |
| license | `null` |
| objectGrantCount | `3` |
| tabVisibilities | `` |
| userPermissions | `` |

## Incident edges

### grantedBy (outgoing, 12)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Incentive__c.Amount__c` | declared | permission-set-extractor |
| `CustomField:Incentive__c.Approved__c` | declared | permission-set-extractor |
| `CustomField:Incentive__c.Type__c` | declared | permission-set-extractor |
| `CustomField:Invoice__c.Amount__c` | declared | permission-set-extractor |
| `CustomField:Invoice__c.Due_Date__c` | declared | permission-set-extractor |
| `CustomField:Invoice__c.Status__c` | declared | permission-set-extractor |
| `CustomField:Payment__c.Amount__c` | declared | permission-set-extractor |
| `CustomField:Payment__c.Method__c` | declared | permission-set-extractor |
| `CustomField:Payment__c.Payment_Date__c` | declared | permission-set-extractor |
| `CustomObject:Incentive__c` | declared | permission-set-extractor |
| `CustomObject:Invoice__c` | declared | permission-set-extractor |
| `CustomObject:Payment__c` | declared | permission-set-extractor |
