---
apiName: Site_Survey__c
apiVersion: null
id: CustomObject:Site_Survey__c
label: Site Survey
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
  label: Site Survey
  nameFieldLabel: Site Survey Name
  nameFieldType: Text
  pluralLabel: Site Surveys
  sharingModel: Private
  visibility: Public
sourcePath: source/main/default/objects/Site_Survey__c/Site_Survey__c.object-meta.xml
type: CustomObject
---

# Site Survey

**API Name:** `Site_Survey__c`  
**Type:** CustomObject

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `false` |
| enableHistory | `false` |
| enableReports | `false` |
| enableSearch | `false` |
| nameFieldLabel | `Site Survey Name` |
| nameFieldType | `Text` |
| pluralLabel | `Site Surveys` |
| sharingModel | `Private` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 3)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (outgoing, 5)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Site_Survey__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Site_Survey__c.Roof_Type__c` | declared | custom-field-extractor |
| `CustomField:Site_Survey__c.Shading_Factor__c` | declared | custom-field-extractor |
| `CustomField:Site_Survey__c.Survey_Date__c` | declared | custom-field-extractor |
| `CustomField:Site_Survey__c.Surveyor__c` | declared | custom-field-extractor |
