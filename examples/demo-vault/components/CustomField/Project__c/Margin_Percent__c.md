---
apiName: Margin_Percent__c
apiVersion: null
id: CustomField:Project__c.Margin_Percent__c
label: Margin Percent
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Percent
  defaultValue: null
  description: null
  externalId: false
  formula: (Contract_Value__c - Total_Invoiced__c) / Contract_Value__c
  inlineHelpText: null
  label: Margin Percent
  length: null
  picklistValues: null
  precision: 5
  referenceTo: null
  relationshipName: null
  required: false
  scale: 2
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/Margin_Percent__c.field-meta.xml
type: CustomField
---

# Margin Percent

**API Name:** `Margin_Percent__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Percent` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `(Contract_Value__c - Total_Invoiced__c) / Contract_Value__c` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `5` |
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
| `CustomObject:Project__c` | declared | custom-field-extractor |

### references (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Contract_Value__c` | parsed | formula-tokenizer |
| `CustomField:Project__c.Total_Invoiced__c` | parsed | formula-tokenizer |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |
