---
apiName: Method__c
apiVersion: null
id: CustomField:Payment__c.Method__c
label: Method
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Payment__c
properties:
  dataType: Picklist
  defaultValue: null
  description: How the payment was tendered.
  externalId: false
  formula: null
  inlineHelpText: null
  label: Method
  length: null
  picklistValues:
    - ACH
    - Card
    - Check
    - Wire
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Payment__c/fields/Method__c.field-meta.xml
type: CustomField
---

# Method

**API Name:** `Method__c`  
**Type:** CustomField

How the payment was tendered.

## Properties

| Key | Value |
| --- | --- |
| dataType | `Picklist` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `ACH,Card,Check,Wire` |
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
| `PermissionSet:Finance_Team` | declared | permission-set-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Payment__c` | declared | custom-field-extractor |
