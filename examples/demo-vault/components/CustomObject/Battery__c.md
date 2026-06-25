---
apiName: Battery__c
apiVersion: null
id: CustomObject:Battery__c
label: Battery
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
  label: Battery
  nameFieldLabel: Battery Name
  nameFieldType: Text
  pluralLabel: Batteries
  sharingModel: ReadWrite
  visibility: Public
sourcePath: source/main/default/objects/Battery__c/Battery__c.object-meta.xml
type: CustomObject
---

# Battery

**API Name:** `Battery__c`  
**Type:** CustomObject

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `false` |
| enableHistory | `false` |
| enableReports | `false` |
| enableSearch | `false` |
| nameFieldLabel | `Battery Name` |
| nameFieldType | `Text` |
| pluralLabel | `Batteries` |
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
| `CustomField:Equipment_Allocation__c.Battery__c` | declared | custom-field-extractor |

### parentOf (outgoing, 3)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Battery__c.Capacity_kWh__c` | declared | custom-field-extractor |
| `CustomField:Battery__c.Manufacturer__c` | declared | custom-field-extractor |
| `CustomField:Battery__c.Unit_Cost__c` | declared | custom-field-extractor |
