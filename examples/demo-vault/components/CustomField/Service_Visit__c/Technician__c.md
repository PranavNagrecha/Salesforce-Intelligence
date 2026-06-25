---
apiName: Technician__c
apiVersion: null
id: CustomField:Service_Visit__c.Technician__c
label: Technician
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
  label: Technician
  length: null
  picklistValues: null
  precision: null
  referenceTo: User
  relationshipName: Service_Visits
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Service_Visit__c/fields/Technician__c.field-meta.xml
type: CustomField
---

# Technician

**API Name:** `Technician__c`  
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
| `CustomObject:User` | declared | custom-field-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Service_Visit__c` | declared | custom-field-extractor |
