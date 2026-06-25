---
apiName: Submitted_Date__c
apiVersion: null
id: CustomField:Permit__c.Submitted_Date__c
label: Submitted Date
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
  label: Submitted Date
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Permit__c/fields/Submitted_Date__c.field-meta.xml
type: CustomField
---

# Submitted Date

**API Name:** `Submitted_Date__c`  
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
