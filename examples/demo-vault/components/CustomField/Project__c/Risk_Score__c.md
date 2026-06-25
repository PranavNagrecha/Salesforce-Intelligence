---
apiName: Risk_Score__c
apiVersion: null
id: CustomField:Project__c.Risk_Score__c
label: Risk Score
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Number
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Risk Score
  length: null
  picklistValues: null
  precision: 3
  referenceTo: null
  relationshipName: null
  required: false
  scale: 0
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/Risk_Score__c.field-meta.xml
type: CustomField
---

# Risk Score

**API Name:** `Risk_Score__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Number` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `3` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `0` |
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

### readsFrom (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:ProjectTriggerHandlerTest` | parsed | apex-ast |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |

### writesTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:ProjectTriggerHandler` | parsed | apex-ast |
