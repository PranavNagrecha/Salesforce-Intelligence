---
apiName: Due_Date__c
apiVersion: null
id: CustomField:Invoice__c.Due_Date__c
label: Due Date
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Invoice__c
properties:
  dataType: Date
  defaultValue: null
  description: Date by which the invoice balance is due.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Due Date
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Invoice__c/fields/Due_Date__c.field-meta.xml
type: CustomField
---

# Due Date

**API Name:** `Due_Date__c`  
**Type:** CustomField

Date by which the invoice balance is due.

## Properties

| Key | Value |
| --- | --- |
| dataType | `Date` |
| defaultValue | `null` |
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

### grantedBy (incoming, 3)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Finance_Team` | declared | permission-set-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Invoice__c` | declared | custom-field-extractor |
