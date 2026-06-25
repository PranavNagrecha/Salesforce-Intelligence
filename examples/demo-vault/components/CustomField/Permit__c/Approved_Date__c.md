---
apiName: Approved_Date__c
apiVersion: null
id: CustomField:Permit__c.Approved_Date__c
label: Approved Date
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Permit__c
properties:
  dataType: Date
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Approved Date
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Permit__c/fields/Approved_Date__c.field-meta.xml
type: CustomField
---

# Approved Date

**API Name:** `Approved_Date__c`  
**Type:** CustomField

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
