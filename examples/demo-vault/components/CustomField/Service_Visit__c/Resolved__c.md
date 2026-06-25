---
apiName: Resolved__c
apiVersion: null
id: CustomField:Service_Visit__c.Resolved__c
label: Resolved
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Service_Visit__c
properties:
  dataType: Checkbox
  defaultValue: "false"
  description: Indicates the service visit issue has been resolved.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Resolved
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Service_Visit__c/fields/Resolved__c.field-meta.xml
type: CustomField
---

# Resolved

**API Name:** `Resolved__c`  
**Type:** CustomField

Indicates the service visit issue has been resolved.

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

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Service_Visit__c` | declared | custom-field-extractor |
