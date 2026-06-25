---
apiName: Line_Total__c
apiVersion: null
id: CustomField:Equipment_Allocation__c.Line_Total__c
label: Line Total
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Equipment_Allocation__c
properties:
  dataType: Currency
  defaultValue: null
  description: null
  externalId: false
  formula: "Quantity__c * Solar_Panel__r.Unit_Cost__c"
  inlineHelpText: null
  label: Line Total
  length: null
  picklistValues: null
  precision: 16
  referenceTo: null
  relationshipName: null
  required: false
  scale: 2
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Equipment_Allocation__c/fields/Line_Total__c.field-meta.xml
type: CustomField
---

# Line Total

**API Name:** `Line_Total__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Currency` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `Quantity__c * Solar_Panel__r.Unit_Cost__c` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `16` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `2` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Equipment_Allocation__c` | declared | custom-field-extractor |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Equipment_Allocation__c.Quantity__c` | parsed | formula-tokenizer |
