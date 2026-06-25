---
apiName: Panels_Installed__c
apiVersion: null
id: CustomField:Installation__c.Panels_Installed__c
label: Panels Installed
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Installation__c
properties:
  dataType: Number
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Panels Installed
  length: null
  picklistValues: null
  precision: 4
  referenceTo: null
  relationshipName: null
  required: false
  scale: 0
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Installation__c/fields/Panels_Installed__c.field-meta.xml
type: CustomField
---

# Panels Installed

**API Name:** `Panels_Installed__c`  
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
| precision | `4` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `0` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Installation__c` | declared | custom-field-extractor |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Installation__c.Installation Layout` | declared | layout-extractor |
