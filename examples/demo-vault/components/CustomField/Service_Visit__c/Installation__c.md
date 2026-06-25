---
apiName: Installation__c
apiVersion: null
id: CustomField:Service_Visit__c.Installation__c
label: Installation
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Service_Visit__c
properties:
  dataType: Lookup
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Installation
  length: null
  picklistValues: null
  precision: null
  referenceTo: Installation__c
  relationshipName: Service_Visits
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Service_Visit__c/fields/Installation__c.field-meta.xml
type: CustomField
---

# Installation

**API Name:** `Installation__c`  
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
| referenceTo | `Installation__c` |
| relationshipName | `Service_Visits` |
| required | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |

### lookupTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Installation__c` | declared | custom-field-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Service_Visit__c` | declared | custom-field-extractor |

### writesTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Flow:Installation_On_Complete` | parsed | flow-extractor |
