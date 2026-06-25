---
apiName: Amount__c
apiVersion: null
id: CustomField:Invoice__c.Amount__c
label: Amount
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Invoice__c
properties:
  dataType: Currency
  defaultValue: null
  description: Total amount billed on this invoice before payments are applied.
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
sourcePath: source/main/default/objects/Invoice__c/fields/Amount__c.field-meta.xml
type: CustomField
---

# Amount

**API Name:** `Amount__c`  
**Type:** CustomField

Total amount billed on this invoice before payments are applied.

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

### grantedBy (incoming, 3)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Finance_Team` | declared | permission-set-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

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
