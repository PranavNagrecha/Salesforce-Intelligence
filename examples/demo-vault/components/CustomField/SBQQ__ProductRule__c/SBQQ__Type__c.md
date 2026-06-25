---
apiName: SBQQ__Type__c
apiVersion: null
id: CustomField:SBQQ__ProductRule__c.SBQQ__Type__c
label: Type
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:SBQQ__ProductRule__c
properties:
  dataType: Text
  defaultValue: null
  description: "Synthetic CPQ rule type (e.g. Validation, Selection, Alert)."
  externalId: false
  formula: null
  inlineHelpText: null
  label: Type
  length: 40
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/SBQQ__ProductRule__c/fields/SBQQ__Type__c.field-meta.xml
type: CustomField
---

# Type

**API Name:** `SBQQ__Type__c`  
**Type:** CustomField

Synthetic CPQ rule type (e.g. Validation, Selection, Alert).

## Properties

| Key | Value |
| --- | --- |
| dataType | `Text` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `40` |
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
| `CustomObject:SBQQ__ProductRule__c` | declared | custom-field-extractor |
