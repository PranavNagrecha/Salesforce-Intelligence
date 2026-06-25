---
apiName: Visit_Date__c
apiVersion: null
id: CustomField:Service_Visit__c.Visit_Date__c
label: Visit Date
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Service_Visit__c
properties:
  dataType: Date
  defaultValue: null
  description: Date the service visit occurred or is scheduled.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Visit Date
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Service_Visit__c/fields/Visit_Date__c.field-meta.xml
type: CustomField
---

# Visit Date

**API Name:** `Visit_Date__c`  
**Type:** CustomField

Date the service visit occurred or is scheduled.

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

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Service_Visit__c` | declared | custom-field-extractor |
