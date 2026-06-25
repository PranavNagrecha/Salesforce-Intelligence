---
apiName: System_Size_kW__c
apiVersion: null
id: CustomField:Project__c.System_Size_kW__c
label: System Size (kW)
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Number
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: System Size (kW)
  length: null
  picklistValues: null
  precision: 6
  referenceTo: null
  relationshipName: null
  required: false
  scale: 2
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/System_Size_kW__c.field-meta.xml
type: CustomField
---

# System Size (kW)

**API Name:** `System_Size_kW__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Number` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `6` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `2` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 4)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Project_Manager` | declared | permission-set-extractor |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |
