---
apiName: Manufacturer__c
apiVersion: null
id: CustomField:Solar_Panel__c.Manufacturer__c
label: Manufacturer
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Solar_Panel__c
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
      label: SunGrid
      value: SunGrid
    - default: false
      isActive: true
      label: HelioMax
      value: HelioMax
    - default: false
      isActive: true
      label: Voltaic
      value: Voltaic
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Solar_Panel__c/fields/Manufacturer__c.field-meta.xml
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
| picklistValues | `SunGrid, HelioMax, Voltaic` |
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
| `CustomObject:Solar_Panel__c` | declared | custom-field-extractor |
