---
apiName: Invoice__c
apiVersion: null
id: CustomObject:Invoice__c
label: Invoice
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  deploymentStatus: Deployed
  description: An invoice billed against a Project for solar installation work. Child of Project via master-detail.
  enableActivities: true
  enableHistory: true
  enableReports: true
  enableSearch: false
  label: Invoice
  nameFieldLabel: Invoice Number
  nameFieldType: AutoNumber
  pluralLabel: Invoices
  sharingModel: ControlledByParent
  visibility: Public
sourcePath: source/main/default/objects/Invoice__c/Invoice__c.object-meta.xml
type: CustomObject
---

# Invoice

**API Name:** `Invoice__c`  
**Type:** CustomObject

An invoice billed against a Project for solar installation work. Child of Project via master-detail.

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `true` |
| enableHistory | `true` |
| enableReports | `true` |
| enableSearch | `false` |
| nameFieldLabel | `Invoice Number` |
| nameFieldType | `AutoNumber` |
| pluralLabel | `Invoices` |
| sharingModel | `ControlledByParent` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 3)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Finance_Team` | declared | permission-set-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### lookupTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Payment__c.Invoice__c` | declared | custom-field-extractor |

### parentOf (outgoing, 7)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Invoice__c.Amount__c` | declared | custom-field-extractor |
| `CustomField:Invoice__c.Balance__c` | declared | custom-field-extractor |
| `CustomField:Invoice__c.Due_Date__c` | declared | custom-field-extractor |
| `CustomField:Invoice__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Invoice__c.Status__c` | declared | custom-field-extractor |
| `CustomField:Invoice__c.Total_Paid__c` | declared | custom-field-extractor |
| `SharingRule:Invoice__c.Share_Invoices_To_Finance` | declared | sharing-rule-extractor |

### readsFrom (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:PaymentService` | heuristic | apex-scanner |
