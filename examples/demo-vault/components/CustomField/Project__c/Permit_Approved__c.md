---
apiName: Permit_Approved__c
apiVersion: null
id: CustomField:Project__c.Permit_Approved__c
label: Permit Approved
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Checkbox
  defaultValue: "false"
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Permit Approved
  length: null
  picklistValues: null
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/Permit_Approved__c.field-meta.xml
type: CustomField
---

# Permit Approved

**API Name:** `Permit_Approved__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Checkbox` |
| defaultValue | `false` |
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

### grantedBy (incoming, 4)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Project_Manager` | declared | permission-set-extractor |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ValidationRule:Project__c.Complete_Requires_Permit` | parsed | formula-tokenizer |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |
