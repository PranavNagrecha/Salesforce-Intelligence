---
apiName: Crew_Lead__c
apiVersion: null
id: CustomField:Installation__c.Crew_Lead__c
label: Crew Lead
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Installation__c
properties:
  dataType: Lookup
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Crew Lead
  length: null
  picklistValues: null
  precision: null
  referenceTo: User
  relationshipName: Installations
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Installation__c/fields/Crew_Lead__c.field-meta.xml
type: CustomField
---

# Crew Lead

**API Name:** `Crew_Lead__c`  
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
| relationshipName | `Installations` |
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
| `CustomObject:Installation__c` | declared | custom-field-extractor |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Installation__c.Installation Layout` | declared | layout-extractor |
