---
apiName: Type__c
apiVersion: null
id: CustomField:Incentive__c.Type__c
label: Type
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Incentive__c
properties:
  dataType: Picklist
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Type
  length: null
  picklistValues:
    - default: true
      isActive: true
      label: Federal Tax Credit
      value: Federal_Tax_Credit
    - default: false
      isActive: true
      label: State Rebate
      value: State_Rebate
    - default: false
      isActive: true
      label: Utility Rebate
      value: Utility_Rebate
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Incentive__c/fields/Type__c.field-meta.xml
type: CustomField
---

# Type

**API Name:** `Type__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Picklist` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `Federal_Tax_Credit, State_Rebate, Utility_Rebate` |
| precision | `null` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `null` |
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
