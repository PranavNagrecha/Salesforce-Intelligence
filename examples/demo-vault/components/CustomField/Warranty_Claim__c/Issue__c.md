---
apiName: Issue__c
apiVersion: null
id: CustomField:Warranty_Claim__c.Issue__c
label: Issue
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Warranty_Claim__c
properties:
  dataType: LongTextArea
  defaultValue: null
  description: Free-text description of the warranty issue reported by the customer.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Issue
  length: 2000
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Warranty_Claim__c/fields/Issue__c.field-meta.xml
type: CustomField
---

# Issue

**API Name:** `Issue__c`  
**Type:** CustomField

Free-text description of the warranty issue reported by the customer.

## Properties

| Key | Value |
| --- | --- |
| dataType | `LongTextArea` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `2000` |
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
| `Profile:Verdant_Installer` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Warranty_Claim__c` | declared | custom-field-extractor |
