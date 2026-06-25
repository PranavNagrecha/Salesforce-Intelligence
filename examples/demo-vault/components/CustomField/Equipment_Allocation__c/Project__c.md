---
apiName: Project__c
apiVersion: null
id: CustomField:Equipment_Allocation__c.Project__c
label: Project
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Equipment_Allocation__c
properties:
  dataType: MasterDetail
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Project
  length: null
  picklistValues: null
  precision: null
  referenceTo: Project__c
  relationshipName: Equipment_Allocations
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Equipment_Allocation__c/fields/Project__c.field-meta.xml
type: CustomField
---

# Project

**API Name:** `Project__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `MasterDetail` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `null` |
| referenceTo | `Project__c` |
| relationshipName | `Equipment_Allocations` |
| required | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### lookupTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Equipment_Allocation__c` | declared | custom-field-extractor |
