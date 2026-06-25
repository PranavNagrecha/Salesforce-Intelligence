---
apiName: Reason__c
apiVersion: null
id: CustomField:Service_Visit__c.Reason__c
label: Reason
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Service_Visit__c
properties:
  dataType: Picklist
  defaultValue: null
  description: Why the service visit was performed.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Reason
  length: null
  picklistValues:
    - Inspection
    - Repair
    - Warranty
    - Upgrade
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Service_Visit__c/fields/Reason__c.field-meta.xml
type: CustomField
---

# Reason

**API Name:** `Reason__c`  
**Type:** CustomField

Why the service visit was performed.

## Properties

| Key | Value |
| --- | --- |
| dataType | `Picklist` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `Inspection,Repair,Warranty,Upgrade` |
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

### writesTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Flow:Installation_On_Complete` | parsed | flow-extractor |
