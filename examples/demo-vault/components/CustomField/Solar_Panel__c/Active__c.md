---
apiName: Active__c
apiVersion: null
id: CustomField:Solar_Panel__c.Active__c
label: Active
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Solar_Panel__c
properties:
  dataType: Checkbox
  defaultValue: "false"
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Active
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Solar_Panel__c/fields/Active__c.field-meta.xml
type: CustomField
---

# Active

**API Name:** `Active__c`  
**Type:** CustomField

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

### grantedBy (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Solar_Panel__c` | declared | custom-field-extractor |
