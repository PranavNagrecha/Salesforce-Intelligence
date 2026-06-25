---
apiName: Shading_Factor__c
apiVersion: null
id: CustomField:Site_Survey__c.Shading_Factor__c
label: Shading Factor
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Site_Survey__c
properties:
  dataType: Percent
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Shading Factor
  length: null
  picklistValues: null
  precision: 3
  referenceTo: null
  relationshipName: null
  required: false
  scale: 0
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Site_Survey__c/fields/Shading_Factor__c.field-meta.xml
type: CustomField
---

# Shading Factor

**API Name:** `Shading_Factor__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Percent` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `3` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `0` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 3)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Site_Survey__c` | declared | custom-field-extractor |
