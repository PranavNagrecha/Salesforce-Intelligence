---
apiName: Service_Visit__c
apiVersion: null
id: CustomObject:Service_Visit__c
label: Service Visit
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  deploymentStatus: Deployed
  description: "A field service visit to a completed installation (inspection, repair, warranty, or upgrade)."
  enableActivities: true
  enableHistory: false
  enableReports: true
  enableSearch: false
  label: Service Visit
  nameFieldLabel: Service Visit Number
  nameFieldType: AutoNumber
  pluralLabel: Service Visits
  sharingModel: Private
  visibility: Public
sourcePath: source/main/default/objects/Service_Visit__c/Service_Visit__c.object-meta.xml
type: CustomObject
---

# Service Visit

**API Name:** `Service_Visit__c`  
**Type:** CustomObject

A field service visit to a completed installation (inspection, repair, warranty, or upgrade).

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `true` |
| enableHistory | `false` |
| enableReports | `true` |
| enableSearch | `false` |
| nameFieldLabel | `Service Visit Number` |
| nameFieldType | `AutoNumber` |
| pluralLabel | `Service Visits` |
| sharingModel | `Private` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (outgoing, 5)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Service_Visit__c.Installation__c` | declared | custom-field-extractor |
| `CustomField:Service_Visit__c.Reason__c` | declared | custom-field-extractor |
| `CustomField:Service_Visit__c.Resolved__c` | declared | custom-field-extractor |
| `CustomField:Service_Visit__c.Technician__c` | declared | custom-field-extractor |
| `CustomField:Service_Visit__c.Visit_Date__c` | declared | custom-field-extractor |

### writesTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Flow:Installation_On_Complete` | parsed | flow-extractor |
