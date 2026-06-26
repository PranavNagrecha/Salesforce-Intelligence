---
apiName: Status__c
apiVersion: null
id: CustomField:Installation__c.Status__c
label: Status
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Installation__c
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
    - default: true
      isActive: true
      label: Scheduled
      value: Scheduled
    - default: false
      isActive: true
      label: InProgress
      value: InProgress
    - default: false
      isActive: true
      label: Completed
      value: Completed
    - default: false
      isActive: true
      label: Failed
      value: Failed
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Installation__c/fields/Status__c.field-meta.xml
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
| picklistValues | `Scheduled, InProgress, Completed, Failed` |
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
| `CustomObject:Installation__c` | declared | custom-field-extractor |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Installation__c.Installation Layout` | declared | layout-extractor |
