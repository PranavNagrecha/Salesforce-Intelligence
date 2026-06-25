---
apiName: Incentive__c
apiVersion: null
id: CustomObject:Incentive__c
label: Incentive
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
  label: Incentive
  nameFieldLabel: Incentive Name
  nameFieldType: Text
  pluralLabel: Incentives
  sharingModel: Private
  visibility: Public
sourcePath: source/main/default/objects/Incentive__c/Incentive__c.object-meta.xml
type: CustomObject
---

# Incentive

**API Name:** `Incentive__c`  
**Type:** CustomObject

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `false` |
| enableHistory | `false` |
| enableReports | `false` |
| enableSearch | `false` |
| nameFieldLabel | `Incentive Name` |
| nameFieldType | `Text` |
| pluralLabel | `Incentives` |
| sharingModel | `Private` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 3)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Finance_Team` | declared | permission-set-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (outgoing, 4)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Incentive__c.Amount__c` | declared | custom-field-extractor |
| `CustomField:Incentive__c.Approved__c` | declared | custom-field-extractor |
| `CustomField:Incentive__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Incentive__c.Type__c` | declared | custom-field-extractor |

### readsFrom (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:IncentiveBatch` | heuristic | apex-scanner |
