---
apiName: Status__c
apiVersion: null
id: CustomField:Project__c.Status__c
label: Status
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Picklist
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Status
  length: null
  picklistValues:
    - Draft
    - Approved
    - Permitting
    - Installing
    - Complete
    - Cancelled
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/Status__c.field-meta.xml
type: CustomField
---

# Status

**API Name:** `Status__c`  
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
| picklistValues | `Draft,Approved,Permitting,Installing,Complete,Cancelled` |
| precision | `null` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 4)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Project_Manager` | declared | permission-set-extractor |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### readsFrom (incoming, 3)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:IncentiveBatch` | parsed | apex-ast |
| `ApexClass:ProjectTriggerHandler` | parsed | apex-ast |
| `ApexClass:ProjectTriggerHandlerTest` | parsed | apex-ast |

### references (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Is_Complete__c` | parsed | formula-tokenizer |
| `ValidationRule:Project__c.Complete_Requires_Permit` | parsed | formula-tokenizer |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |

### writesTo (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:ProjectTriggerHandlerTest` | parsed | apex-ast |
| `Flow:Installation_On_Complete` | parsed | flow-extractor |
