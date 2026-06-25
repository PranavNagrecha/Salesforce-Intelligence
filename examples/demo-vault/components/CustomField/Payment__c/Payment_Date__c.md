---
apiName: Payment_Date__c
apiVersion: null
id: CustomField:Payment__c.Payment_Date__c
label: Payment Date
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Payment__c
properties:
  dataType: Date
  defaultValue: null
  description: Date the payment was received.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Payment Date
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Payment__c/fields/Payment_Date__c.field-meta.xml
type: CustomField
---

# Payment Date

**API Name:** `Payment_Date__c`  
**Type:** CustomField

Date the payment was received.

## Properties

| Key | Value |
| --- | --- |
| dataType | `Date` |
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

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Finance_Team` | declared | permission-set-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Payment__c` | declared | custom-field-extractor |
