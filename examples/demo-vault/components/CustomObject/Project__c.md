---
apiName: Project__c
apiVersion: null
id: CustomObject:Project__c
label: Project
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
  label: Project
  nameFieldLabel: Project Name
  nameFieldType: Text
  pluralLabel: Projects
  sharingModel: Private
  visibility: Public
sourcePath: source/main/default/objects/Project__c/Project__c.object-meta.xml
type: CustomObject
---

# Project

**API Name:** `Project__c`  
**Type:** CustomObject

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `false` |
| enableHistory | `false` |
| enableReports | `false` |
| enableSearch | `false` |
| nameFieldLabel | `Project Name` |
| nameFieldType | `Text` |
| pluralLabel | `Projects` |
| sharingModel | `Private` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 4)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Project_Manager` | declared | permission-set-extractor |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### lookupTo (incoming, 6)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Equipment_Allocation__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Incentive__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Installation__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Invoice__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Permit__c.Project__c` | declared | custom-field-extractor |
| `CustomField:Site_Survey__c.Project__c` | declared | custom-field-extractor |

### parentOf (outgoing, 17)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ApprovalProcess:Project__c.Discount_Approval` | declared | approval-process-extractor |
| `CustomField:Project__c.Account__c` | declared | custom-field-extractor |
| `CustomField:Project__c.Contract_Value__c` | declared | custom-field-extractor |
| `CustomField:Project__c.Expected_Completion__c` | declared | custom-field-extractor |
| `CustomField:Project__c.Is_Complete__c` | declared | custom-field-extractor |
| `CustomField:Project__c.Margin_Percent__c` | declared | custom-field-extractor |
| `CustomField:Project__c.Opportunity__c` | declared | custom-field-extractor |
| `CustomField:Project__c.Permit_Approved__c` | declared | custom-field-extractor |
| `CustomField:Project__c.Risk_Score__c` | declared | custom-field-extractor |
| `CustomField:Project__c.Status__c` | declared | custom-field-extractor |
| `CustomField:Project__c.System_Size_kW__c` | declared | custom-field-extractor |
| `CustomField:Project__c.Total_Invoiced__c` | declared | custom-field-extractor |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |
| `RecordType:Project__c.Commercial` | declared | record-type-extractor |
| `RecordType:Project__c.Residential` | declared | record-type-extractor |
| `SharingRule:Project__c.Share_Projects_To_Ops` | declared | sharing-rule-extractor |
| `ValidationRule:Project__c.Complete_Requires_Permit` | declared | validation-rule-extractor |

### readsFrom (incoming, 3)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:IncentiveBatch` | heuristic | apex-scanner |
| `ApexClass:ProjectTriggerHandlerTest` | heuristic | apex-scanner |
| `Flow:Installation_On_Complete` | parsed | flow-extractor |

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `OmniDataTransform:Quote_To_Project_Map_1` | declared | omni-data-transform |

### triggersOn (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexTrigger:ProjectTrigger` | declared | apex-trigger-extractor |
| `Flow:Project_On_Approve` | declared | flow-extractor |

### writesTo (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Flow:Installation_On_Complete` | parsed | flow-extractor |
