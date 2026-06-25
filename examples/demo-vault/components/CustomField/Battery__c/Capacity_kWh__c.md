---
apiName: Capacity_kWh__c
apiVersion: null
id: CustomField:Battery__c.Capacity_kWh__c
label: Capacity (kWh)
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Battery__c
properties:
  dataType: Number
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Capacity (kWh)
  length: null
  picklistValues: null
  precision: 5
  referenceTo: null
  relationshipName: null
  required: false
  scale: 1
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Battery__c/fields/Capacity_kWh__c.field-meta.xml
type: CustomField
---

# Capacity (kWh)

**API Name:** `Capacity_kWh__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Number` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `5` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| scale | `1` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Battery__c` | declared | custom-field-extractor |
