---
apiName: Balance__c
apiVersion: null
id: CustomField:Invoice__c.Balance__c
label: Balance
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Invoice__c
properties:
  dataType: Currency
  defaultValue: null
  description: "Outstanding balance on the invoice: amount billed minus total payments applied."
  externalId: false
  formula: Amount__c - Total_Paid__c
  inlineHelpText: null
  label: Balance
  length: null
  picklistValues: null
  precision: 12
  referenceTo: null
  relationshipName: null
  required: false
  scale: 2
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Invoice__c/fields/Balance__c.field-meta.xml
type: CustomField
---

# Balance

**API Name:** `Balance__c`  
**Type:** CustomField

Outstanding balance on the invoice: amount billed minus total payments applied.

## Properties

| Key | Value |
| --- | --- |
| dataType | `Currency` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `Amount__c - Total_Paid__c` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `12` |
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
| `CustomObject:Invoice__c` | declared | custom-field-extractor |

### references (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Invoice__c.Amount__c` | parsed | formula-tokenizer |
| `CustomField:Invoice__c.Total_Paid__c` | parsed | formula-tokenizer |
