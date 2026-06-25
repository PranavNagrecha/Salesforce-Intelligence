---
apiName: Amount__c
apiVersion: null
id: CustomField:Payment__c.Amount__c
label: Amount
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Payment__c
properties:
  dataType: Currency
  defaultValue: null
  description: Amount of this payment applied to the parent invoice.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Amount
  length: null
  picklistValues: null
  precision: 12
  referenceTo: null
  relationshipName: null
  required: true
  scale: 2
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Payment__c/fields/Amount__c.field-meta.xml
type: CustomField
---

# Amount

**API Name:** `Amount__c`  
**Type:** CustomField

Amount of this payment applied to the parent invoice.

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
| precision | `12` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `true` |
| scale | `2` |
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

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ValidationRule:Payment__c.Amount_Positive` | parsed | formula-tokenizer |
