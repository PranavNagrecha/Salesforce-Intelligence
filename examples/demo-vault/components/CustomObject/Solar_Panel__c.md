---
apiName: Solar_Panel__c
apiVersion: null
id: CustomObject:Solar_Panel__c
label: Solar Panel
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
  label: Solar Panel
  nameFieldLabel: Solar Panel Name
  nameFieldType: Text
  pluralLabel: Solar Panels
  sharingModel: ReadWrite
  visibility: Public
sourcePath: source/main/default/objects/Solar_Panel__c/Solar_Panel__c.object-meta.xml
type: CustomObject
---

# Solar Panel

**API Name:** `Solar_Panel__c`  
**Type:** CustomObject

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `false` |
| enableHistory | `false` |
| enableReports | `false` |
| enableSearch | `false` |
| nameFieldLabel | `Solar Panel Name` |
| nameFieldType | `Text` |
| pluralLabel | `Solar Panels` |
| sharingModel | `ReadWrite` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 3)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### lookupTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Equipment_Allocation__c.Solar_Panel__c` | declared | custom-field-extractor |

### parentOf (outgoing, 4)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Solar_Panel__c.Active__c` | declared | custom-field-extractor |
| `CustomField:Solar_Panel__c.Manufacturer__c` | declared | custom-field-extractor |
| `CustomField:Solar_Panel__c.Unit_Cost__c` | declared | custom-field-extractor |
| `CustomField:Solar_Panel__c.Wattage__c` | declared | custom-field-extractor |
