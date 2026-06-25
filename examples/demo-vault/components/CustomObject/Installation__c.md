---
apiName: Installation__c
apiVersion: null
id: CustomObject:Installation__c
label: Installation
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  deploymentStatus: Deployed
  description: null
  enableActivities: false
  enableHistory: false
  enableReports: false
  enableSearch: false
  label: Installation
  nameFieldLabel: Installation Name
  nameFieldType: Text
  pluralLabel: Installations
  sharingModel: Private
  visibility: Public
sourcePath: source/main/default/objects/Installation__c/Installation__c.object-meta.xml
type: CustomObject
---

# Installation

**API Name:** `Installation__c`  
**Type:** CustomObject

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `false` |
| enableHistory | `false` |
| enableReports | `false` |
| enableSearch | `false` |
| nameFieldLabel | `Installation Name` |
| nameFieldType | `Text` |
| pluralLabel | `Installations` |
| sharingModel | `Private` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### lookupTo (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Service_Visit__c.Installation__c` | declared | custom-field-extractor |
| `CustomField:Warranty_Claim__c.Installation__c` | declared | custom-field-extractor |

### parentOf (outgoing, 6)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Installation__c.Crew_Lead__c` | declared | custom-field-extractor |
| `CustomField:Installation__c.Install_Date__c` | declared | custom-field-extractor |
| `CustomField:Installation__c.Panels_Installed__c` | declared | custom-field-extractor |
| `CustomField:Installation__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Installation__c.Status__c` | declared | custom-field-extractor |
| `Layout:Installation__c.Installation Layout` | declared | layout-extractor |

### triggersOn (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Flow:Installation_On_Complete` | declared | flow-extractor |
