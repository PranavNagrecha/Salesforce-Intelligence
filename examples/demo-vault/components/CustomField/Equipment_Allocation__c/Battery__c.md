---
apiName: Battery__c
apiVersion: null
id: CustomField:Equipment_Allocation__c.Battery__c
label: Battery
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
  label: Battery
  length: null
  picklistValues: null
  precision: null
  referenceTo: Battery__c
  relationshipName: Equipment_Allocations
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Equipment_Allocation__c/fields/Battery__c.field-meta.xml
type: CustomField
---

# Battery

**API Name:** `Battery__c`  
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
| referenceTo | `Battery__c` |
| relationshipName | `Equipment_Allocations` |
| required | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### lookupTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Battery__c` | declared | custom-field-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Equipment_Allocation__c` | declared | custom-field-extractor |
