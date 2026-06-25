---
apiName: Contract_Value__c
apiVersion: null
id: CustomField:Project__c.Contract_Value__c
label: Contract Value
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Currency
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Contract Value
  length: null
  picklistValues: null
  precision: 16
  referenceTo: null
  relationshipName: null
  required: false
  scale: 2
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/Contract_Value__c.field-meta.xml
type: CustomField
---

# Contract Value

**API Name:** `Contract_Value__c`  
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
| precision | `16` |
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
| `PermissionSet:Project_Manager` | declared | permission-set-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### readsFrom (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:IncentiveBatch` | parsed | apex-ast |
| `ApexClass:ProjectTriggerHandler` | parsed | apex-ast |

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Margin_Percent__c` | parsed | formula-tokenizer |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |
