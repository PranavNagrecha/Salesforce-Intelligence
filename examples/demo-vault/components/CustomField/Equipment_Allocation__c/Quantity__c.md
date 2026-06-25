---
apiName: Quantity__c
apiVersion: null
id: CustomField:Equipment_Allocation__c.Quantity__c
label: Quantity
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Equipment_Allocation__c
properties:
  dataType: Number
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Quantity
  length: null
  picklistValues: null
  precision: 4
  referenceTo: null
  relationshipName: null
  required: false
  scale: 0
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Equipment_Allocation__c/fields/Quantity__c.field-meta.xml
type: CustomField
---

# Quantity

**API Name:** `Quantity__c`  
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

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Equipment_Allocation__c` | declared | custom-field-extractor |

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Equipment_Allocation__c.Line_Total__c` | parsed | formula-tokenizer |
