---
apiName: Approved__c
apiVersion: null
id: CustomField:Incentive__c.Approved__c
label: Approved
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Incentive__c
properties:
  dataType: Checkbox
  defaultValue: "false"
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Approved
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Incentive__c/fields/Approved__c.field-meta.xml
type: CustomField
---

# Approved

**API Name:** `Approved__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Checkbox` |
| defaultValue | `false` |
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
