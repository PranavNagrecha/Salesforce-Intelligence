---
apiName: Project__c
apiVersion: null
id: CustomField:Permit__c.Project__c
label: Project
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Permit__c
properties:
  dataType: Lookup
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
  relationshipName: Permits
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Permit__c/fields/Project__c.field-meta.xml
type: CustomField
---

# Project

**API Name:** `Project__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Lookup` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `null` |
| referenceTo | `Project__c` |
| relationshipName | `Permits` |
| required | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Project_Manager` | declared | permission-set-extractor |

### lookupTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Permit__c` | declared | custom-field-extractor |

### writesTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Flow:Project_On_Approve` | parsed | flow-extractor |
