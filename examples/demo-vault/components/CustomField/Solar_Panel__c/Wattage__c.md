---
apiName: Wattage__c
apiVersion: null
id: CustomField:Solar_Panel__c.Wattage__c
label: Wattage
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Solar_Panel__c
properties:
  dataType: Number
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Wattage
  length: null
  picklistValues: null
  precision: 4
  referenceTo: null
  relationshipName: null
  required: false
  scale: 0
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Solar_Panel__c/fields/Wattage__c.field-meta.xml
type: CustomField
---

# Wattage

**API Name:** `Wattage__c`  
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
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Solar_Panel__c` | declared | custom-field-extractor |
