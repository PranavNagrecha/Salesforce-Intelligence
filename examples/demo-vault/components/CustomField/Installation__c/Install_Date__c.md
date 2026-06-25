---
apiName: Install_Date__c
apiVersion: null
id: CustomField:Installation__c.Install_Date__c
label: Install Date
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Installation__c
properties:
  dataType: Date
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Install Date
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Installation__c/fields/Install_Date__c.field-meta.xml
type: CustomField
---

# Install Date

**API Name:** `Install_Date__c`  
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

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Installation__c` | declared | custom-field-extractor |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Installation__c.Installation Layout` | declared | layout-extractor |
