---
apiName: Total_Invoiced__c
apiVersion: null
id: CustomField:Project__c.Total_Invoiced__c
label: Total Invoiced
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Summary
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Total Invoiced
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/Total_Invoiced__c.field-meta.xml
type: CustomField
---

# Total Invoiced

**API Name:** `Total_Invoiced__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Summary` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `null` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Margin_Percent__c` | parsed | formula-tokenizer |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |
