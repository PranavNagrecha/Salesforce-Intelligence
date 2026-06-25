---
apiName: Roof_Type__c
apiVersion: null
id: CustomField:Site_Survey__c.Roof_Type__c
label: Roof Type
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Site_Survey__c
properties:
  dataType: Picklist
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Roof Type
  length: null
  picklistValues:
    - Asphalt
    - Metal
    - Tile
    - Flat
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Site_Survey__c/fields/Roof_Type__c.field-meta.xml
type: CustomField
---

# Roof Type

**API Name:** `Roof_Type__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Picklist` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `Asphalt,Metal,Tile,Flat` |
| precision | `null` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `null` |
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
