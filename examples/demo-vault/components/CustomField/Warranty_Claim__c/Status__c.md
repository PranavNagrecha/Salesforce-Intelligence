---
apiName: Status__c
apiVersion: null
id: CustomField:Warranty_Claim__c.Status__c
label: Status
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Warranty_Claim__c
properties:
  dataType: Picklist
  defaultValue: null
  description: Review status of the warranty claim.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Status
  length: null
  picklistValues:
    - Open
    - In_Review
    - Approved
    - Denied
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Warranty_Claim__c/fields/Status__c.field-meta.xml
type: CustomField
---

# Status

**API Name:** `Status__c`  
**Type:** CustomField

Review status of the warranty claim.

## Properties

| Key | Value |
| --- | --- |
| dataType | `Picklist` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `Open,In_Review,Approved,Denied` |
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
