---
apiName: Unit_Cost__c
apiVersion: null
id: CustomField:Battery__c.Unit_Cost__c
label: Unit Cost
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Battery__c
properties:
  dataType: Currency
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Unit Cost
  length: null
  picklistValues: null
  precision: 8
  referenceTo: null
  relationshipName: null
  required: false
  scale: 2
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Battery__c/fields/Unit_Cost__c.field-meta.xml
type: CustomField
---

# Unit Cost

**API Name:** `Unit_Cost__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Currency` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `8` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `2` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Battery__c` | declared | custom-field-extractor |
