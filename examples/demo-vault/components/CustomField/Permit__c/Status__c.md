---
apiName: Status__c
apiVersion: null
id: CustomField:Permit__c.Status__c
label: Status
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Permit__c
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
    - Submitted
    - Approved
    - Rejected
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Permit__c/fields/Status__c.field-meta.xml
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
| picklistValues | `Submitted,Approved,Rejected` |
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
| `PermissionSet:Project_Manager` | declared | permission-set-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Permit__c` | declared | custom-field-extractor |

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ValidationRule:Permit__c.Approved_Needs_Date` | parsed | formula-tokenizer |

### writesTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Flow:Project_On_Approve` | parsed | flow-extractor |
