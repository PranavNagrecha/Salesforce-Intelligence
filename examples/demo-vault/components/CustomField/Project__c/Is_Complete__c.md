---
apiName: Is_Complete__c
apiVersion: null
id: CustomField:Project__c.Is_Complete__c
label: Is Complete
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Checkbox
  defaultValue: null
  description: null
  externalId: false
  formula: "ISPICKVAL(Status__c,\"Complete\")"
  inlineHelpText: null
  label: Is Complete
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/Is_Complete__c.field-meta.xml
type: CustomField
---

# Is Complete

**API Name:** `Is_Complete__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Checkbox` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `ISPICKVAL(Status__c,"Complete")` |
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

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Status__c` | parsed | formula-tokenizer |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |
