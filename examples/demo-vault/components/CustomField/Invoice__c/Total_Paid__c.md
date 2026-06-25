---
apiName: Total_Paid__c
apiVersion: null
id: CustomField:Invoice__c.Total_Paid__c
label: Total Paid
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Invoice__c
properties:
  dataType: Summary
  defaultValue: null
  description: Sum of all Payment amounts applied to this invoice.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Total Paid
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Invoice__c/fields/Total_Paid__c.field-meta.xml
type: CustomField
---

# Total Paid

**API Name:** `Total_Paid__c`  
**Type:** CustomField

Sum of all Payment amounts applied to this invoice.

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
| `CustomObject:Invoice__c` | declared | custom-field-extractor |

### readsFrom (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:PaymentService` | parsed | apex-ast |

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Invoice__c.Balance__c` | parsed | formula-tokenizer |
