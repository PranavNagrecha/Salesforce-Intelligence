---
apiName: Invoice__c
apiVersion: null
id: CustomField:Payment__c.Invoice__c
label: Invoice
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Payment__c
properties:
  dataType: MasterDetail
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Invoice
  length: null
  picklistValues: null
  precision: null
  referenceTo: Invoice__c
  relationshipName: Payments
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Payment__c/fields/Invoice__c.field-meta.xml
type: CustomField
---

# Invoice

**API Name:** `Invoice__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `MasterDetail` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `null` |
| referenceTo | `Invoice__c` |
| relationshipName | `Payments` |
| required | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### lookupTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Invoice__c` | declared | custom-field-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Payment__c` | declared | custom-field-extractor |
