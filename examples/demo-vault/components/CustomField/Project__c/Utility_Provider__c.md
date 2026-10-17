---
apiName: Utility_Provider__c
apiVersion: null
id: CustomField:Project__c.Utility_Provider__c
label: Utility Provider
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Text
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Utility Provider
  length: 80
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/Utility_Provider__c.field-meta.xml
type: CustomField
---

# Utility Provider

**API Name:** `Utility_Provider__c`  
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

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### writesTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `LightningComponentBundle:projectSummaryCard` | declared | lwc-extractor |
