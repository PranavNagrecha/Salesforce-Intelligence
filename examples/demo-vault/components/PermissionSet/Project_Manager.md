---
apiName: Project_Manager
apiVersion: null
id: PermissionSet:Project_Manager
label: Project Manager
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  applicationVisibilities: []
  classGrantCount: 0
  description: null
  fieldGrantCount: 13
  flowGrantCount: 0
  hasActivationRequired: false
  license: null
  objectGrantCount: 2
  tabVisibilities: []
  userPermissions: []
sourcePath: source/main/default/permissionsets/Project_Manager.permissionset-meta.xml
type: PermissionSet
---

# Project Manager

**API Name:** `Project_Manager`  
**Type:** PermissionSet

## Properties

| Key | Value |
| --- | --- |
| applicationVisibilities | `` |
| classGrantCount | `0` |
| fieldGrantCount | `13` |
| flowGrantCount | `0` |
| hasActivationRequired | `false` |
| license | `null` |
| objectGrantCount | `2` |
| tabVisibilities | `` |
| userPermissions | `` |

## Incident edges

### grantedBy (outgoing, 15)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Permit__c.Approved_Date__c` | declared | permission-set-extractor |
| `CustomField:Permit__c.Jurisdiction__c` | declared | permission-set-extractor |
| `CustomField:Permit__c.Project__c` | declared | permission-set-extractor |
| `CustomField:Permit__c.Status__c` | declared | permission-set-extractor |
| `CustomField:Permit__c.Submitted_Date__c` | declared | permission-set-extractor |
| `CustomField:Project__c.Account__c` | declared | permission-set-extractor |
| `CustomField:Project__c.Contract_Value__c` | declared | permission-set-extractor |
| `CustomField:Project__c.Expected_Completion__c` | declared | permission-set-extractor |
| `CustomField:Project__c.Opportunity__c` | declared | permission-set-extractor |
| `CustomField:Project__c.Permit_Approved__c` | declared | permission-set-extractor |
| `CustomField:Project__c.Risk_Score__c` | declared | permission-set-extractor |
| `CustomField:Project__c.Status__c` | declared | permission-set-extractor |
| `CustomField:Project__c.System_Size_kW__c` | declared | permission-set-extractor |
| `CustomObject:Permit__c` | declared | permission-set-extractor |
| `CustomObject:Project__c` | declared | permission-set-extractor |
