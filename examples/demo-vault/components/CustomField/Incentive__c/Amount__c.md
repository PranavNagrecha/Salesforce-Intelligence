---
apiName: Amount__c
apiVersion: null
id: CustomField:Incentive__c.Amount__c
label: Amount
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Incentive__c
properties:
  dataType: Currency
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Amount
  length: null
  picklistValues: null
  precision: 10
  referenceTo: null
  relationshipName: null
  required: false
  scale: 2
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Incentive__c/fields/Amount__c.field-meta.xml
type: CustomField
---

# Amount

**API Name:** `Amount__c`  
**Type:** CustomField

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
| precision | `10` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
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
| `CustomObject:Incentive__c` | declared | custom-field-extractor |

### readsFrom (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:IncentiveBatch` | parsed | apex-ast |
