---
apiName: Manufacturer__c
apiVersion: null
id: CustomField:Battery__c.Manufacturer__c
label: Manufacturer
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Battery__c
properties:
  dataType: Picklist
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Manufacturer
  length: null
  picklistValues:
    - default: true
      isActive: true
      label: PowerCell
      value: PowerCell
    - default: false
      isActive: true
      label: EnerStore
      value: EnerStore
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Battery__c/fields/Manufacturer__c.field-meta.xml
type: CustomField
---

# Manufacturer

**API Name:** `Manufacturer__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Picklist` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `PowerCell, EnerStore` |
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
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Battery__c` | declared | custom-field-extractor |
