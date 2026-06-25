---
apiName: Permit__c
apiVersion: null
id: CustomObject:Permit__c
label: Permit
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  deploymentStatus: Deployed
  description: null
  enableActivities: false
  enableHistory: false
  enableReports: false
  enableSearch: false
  label: Permit
  nameFieldLabel: Permit Name
  nameFieldType: Text
  pluralLabel: Permits
  sharingModel: Private
  visibility: Public
sourcePath: source/main/default/objects/Permit__c/Permit__c.object-meta.xml
type: CustomObject
---

# Permit

**API Name:** `Permit__c`  
**Type:** CustomObject

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `false` |
| enableHistory | `false` |
| enableReports | `false` |
| enableSearch | `false` |
| nameFieldLabel | `Permit Name` |
| nameFieldType | `Text` |
| pluralLabel | `Permits` |
| sharingModel | `Private` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Project_Manager` | declared | permission-set-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (outgoing, 6)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Permit__c.Approved_Date__c` | declared | custom-field-extractor |
| `CustomField:Permit__c.Jurisdiction__c` | declared | custom-field-extractor |
| `CustomField:Permit__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Permit__c.Status__c` | declared | custom-field-extractor |
| `CustomField:Permit__c.Submitted_Date__c` | declared | custom-field-extractor |
| `ValidationRule:Permit__c.Approved_Needs_Date` | declared | validation-rule-extractor |

### sharedWith (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Queue:Permit_Review_Queue` | declared | queue-extractor |

### writesTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Flow:Project_On_Approve` | parsed | flow-extractor |
