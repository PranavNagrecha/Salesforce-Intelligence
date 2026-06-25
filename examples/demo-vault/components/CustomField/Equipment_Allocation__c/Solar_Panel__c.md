---
apiName: Solar_Panel__c
apiVersion: null
id: CustomField:Equipment_Allocation__c.Solar_Panel__c
label: Solar Panel
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Equipment_Allocation__c
properties:
  dataType: Lookup
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Solar Panel
  length: null
  picklistValues: null
  precision: null
  referenceTo: Solar_Panel__c
  relationshipName: Equipment_Allocations
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Equipment_Allocation__c/fields/Solar_Panel__c.field-meta.xml
type: CustomField
---

# Solar Panel

**API Name:** `Solar_Panel__c`  
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
| referenceTo | `Solar_Panel__c` |
| relationshipName | `Equipment_Allocations` |
| required | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### lookupTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Solar_Panel__c` | declared | custom-field-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Equipment_Allocation__c` | declared | custom-field-extractor |
