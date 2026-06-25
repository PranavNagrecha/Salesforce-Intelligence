---
apiName: Survey_Date__c
apiVersion: null
id: CustomField:Site_Survey__c.Survey_Date__c
label: Survey Date
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Site_Survey__c
properties:
  dataType: Date
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Survey Date
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Site_Survey__c/fields/Survey_Date__c.field-meta.xml
type: CustomField
---

# Survey Date

**API Name:** `Survey_Date__c`  
**Type:** CustomField

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

### grantedBy (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Site_Survey__c` | declared | custom-field-extractor |
