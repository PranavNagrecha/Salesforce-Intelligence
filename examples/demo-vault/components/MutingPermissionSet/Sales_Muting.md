---
apiName: Sales_Muting
apiVersion: null
id: MutingPermissionSet:Sales_Muting
label: null
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  description: Deny dangerous permissions for the field Sales team
  mutedApexClassCount: 0
  mutedApexClasses: []
  mutedCustomPermissionCount: 1
  mutedCustomPermissions:
    - SkipValidation
  mutedFieldCount: 0
  mutedFieldPermissions: []
  mutedObjectCount: 1
  mutedObjectPermissions:
    - allowCreate: false
      allowDelete: true
      allowEdit: true
      allowRead: false
      modifyAllRecords: true
      object: Project__c
      viewAllRecords: false
  mutedUserPermissionCount: 1
  mutedUserPermissions:
    - ModifyAllData
sourcePath: source/main/default/mutingpermissionsets/Sales_Muting.mutingpermissionset-meta.xml
type: MutingPermissionSet
---

# Sales_Muting

**API Name:** `Sales_Muting`  
**Type:** MutingPermissionSet

Deny dangerous permissions for the field Sales team

## Properties

| Key | Value |
| --- | --- |
| mutedApexClassCount | `0` |
| mutedApexClasses | `` |
| mutedCustomPermissionCount | `1` |
| mutedCustomPermissions | `SkipValidation` |
| mutedFieldCount | `0` |
| mutedFieldPermissions | `` |
| mutedObjectCount | `1` |
| mutedObjectPermissions | `[object Object]` |
| mutedUserPermissionCount | `1` |
| mutedUserPermissions | `ModifyAllData` |

## Incident edges
