---
apiName: SBQQ__ErrorMessage__c
apiVersion: null
id: CustomField:SBQQ__ProductRule__c.SBQQ__ErrorMessage__c
label: Error Message
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:SBQQ__ProductRule__c
properties:
  dataType: Text
  defaultValue: null
  description: Synthetic CPQ rule error message shown when the rule fires.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Error Message
  length: 255
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/SBQQ__ProductRule__c/fields/SBQQ__ErrorMessage__c.field-meta.xml
type: CustomField
---

# Error Message

**API Name:** `SBQQ__ErrorMessage__c`  
**Type:** CustomField

Synthetic CPQ rule error message shown when the rule fires.

## Properties

| Key | Value |
| --- | --- |
| dataType | `Text` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `255` |
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
