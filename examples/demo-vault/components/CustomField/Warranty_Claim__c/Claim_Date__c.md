---
apiName: Claim_Date__c
apiVersion: null
id: CustomField:Warranty_Claim__c.Claim_Date__c
label: Claim Date
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Warranty_Claim__c
properties:
  dataType: Date
  defaultValue: null
  description: Date the warranty claim was filed.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Claim Date
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Warranty_Claim__c/fields/Claim_Date__c.field-meta.xml
type: CustomField
---

# Claim Date

**API Name:** `Claim_Date__c`  
**Type:** CustomField

Date the warranty claim was filed.

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
| `CustomObject:Warranty_Claim__c` | declared | custom-field-extractor |
