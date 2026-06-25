---
apiName: Surveyor__c
apiVersion: null
id: CustomField:Site_Survey__c.Surveyor__c
label: Surveyor
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Site_Survey__c
properties:
  dataType: Lookup
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Surveyor
  length: null
  picklistValues: null
  precision: null
  referenceTo: User
  relationshipName: Site_Surveys
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Site_Survey__c/fields/Surveyor__c.field-meta.xml
type: CustomField
---

# Surveyor

**API Name:** `Surveyor__c`  
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
| referenceTo | `User` |
| relationshipName | `Site_Surveys` |
| required | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### lookupTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:User` | declared | custom-field-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Site_Survey__c` | declared | custom-field-extractor |
