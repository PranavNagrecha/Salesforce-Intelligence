---
apiName: Equipment_Allocation__c
apiVersion: null
id: CustomObject:Equipment_Allocation__c
label: Equipment Allocation
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
  label: Equipment Allocation
  nameFieldLabel: Equipment Allocation Name
  nameFieldType: AutoNumber
  pluralLabel: Equipment Allocations
  sharingModel: ControlledByParent
  visibility: Public
sourcePath: source/main/default/objects/Equipment_Allocation__c/Equipment_Allocation__c.object-meta.xml
type: CustomObject
---

# Equipment Allocation

**API Name:** `Equipment_Allocation__c`  
**Type:** CustomObject

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `false` |
| enableHistory | `false` |
| enableReports | `false` |
| enableSearch | `false` |
| nameFieldLabel | `Equipment Allocation Name` |
| nameFieldType | `AutoNumber` |
| pluralLabel | `Equipment Allocations` |
| sharingModel | `ControlledByParent` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (outgoing, 5)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Equipment_Allocation__c.Battery__c` | declared | custom-field-extractor |
| `CustomField:Equipment_Allocation__c.Line_Total__c` | declared | custom-field-extractor |
| `CustomField:Equipment_Allocation__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Equipment_Allocation__c.Quantity__c` | declared | custom-field-extractor |
| `CustomField:Equipment_Allocation__c.Solar_Panel__c` | declared | custom-field-extractor |
