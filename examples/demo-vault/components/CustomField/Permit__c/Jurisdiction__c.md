---
apiName: Jurisdiction__c
apiVersion: null
id: CustomField:Permit__c.Jurisdiction__c
label: Jurisdiction
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Permit__c
properties:
  dataType: Text
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Jurisdiction
  length: 80
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Permit__c/fields/Jurisdiction__c.field-meta.xml
type: CustomField
---

# Jurisdiction

**API Name:** `Jurisdiction__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Text` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `80` |
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
