---
apiName: Payment__c
apiVersion: null
id: CustomObject:Payment__c
label: Payment
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  deploymentStatus: Deployed
  description: A payment applied against an Invoice. Child of Invoice via master-detail.
  enableActivities: false
  enableHistory: true
  enableReports: true
  enableSearch: false
  label: Payment
  nameFieldLabel: Payment Number
  nameFieldType: AutoNumber
  pluralLabel: Payments
  sharingModel: ControlledByParent
  visibility: Public
sourcePath: source/main/default/objects/Payment__c/Payment__c.object-meta.xml
type: CustomObject
---

# Payment

**API Name:** `Payment__c`  
**Type:** CustomObject

A payment applied against an Invoice. Child of Invoice via master-detail.

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `false` |
| enableHistory | `true` |
| enableReports | `true` |
| enableSearch | `false` |
| nameFieldLabel | `Payment Number` |
| nameFieldType | `AutoNumber` |
| pluralLabel | `Payments` |
| sharingModel | `ControlledByParent` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Finance_Team` | declared | permission-set-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (outgoing, 5)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Payment__c.Amount__c` | declared | custom-field-extractor |
| `CustomField:Payment__c.Invoice__c` | declared | custom-field-extractor |
| `CustomField:Payment__c.Method__c` | declared | custom-field-extractor |
| `CustomField:Payment__c.Payment_Date__c` | declared | custom-field-extractor |
| `ValidationRule:Payment__c.Amount_Positive` | declared | validation-rule-extractor |
