---
apiName: Verdant_Read_Only
apiVersion: null
id: Profile:Verdant_Read_Only
label: Verdant_Read_Only
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  applicationVisibilities: []
  classGrantCount: 0
  custom: true
  description: null
  fieldGrantCount: 30
  flowGrantCount: 0
  layoutAssignments: []
  loginHoursDefined: false
  loginIpRanges: []
  objectGrantCount: 12
  recordTypeVisibilities: []
  tabVisibilities: []
  userLicense: Salesforce
  userPermissions: []
sourcePath: source/main/default/profiles/Verdant_Read_Only.profile-meta.xml
type: Profile
---

# Verdant_Read_Only

**API Name:** `Verdant_Read_Only`  
**Type:** Profile

## Properties

| Key | Value |
| --- | --- |
| applicationVisibilities | `` |
| classGrantCount | `0` |
| custom | `true` |
| fieldGrantCount | `30` |
| flowGrantCount | `0` |
| layoutAssignments | `` |
| loginHoursDefined | `false` |
| loginIpRanges | `` |
| objectGrantCount | `12` |
| recordTypeVisibilities | `` |
| tabVisibilities | `` |
| userLicense | `Salesforce` |
| userPermissions | `` |

## Incident edges

### grantedBy (outgoing, 42)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Incentive__c.Amount__c` | declared | profile-extractor |
| `CustomField:Incentive__c.Approved__c` | declared | profile-extractor |
| `CustomField:Incentive__c.Type__c` | declared | profile-extractor |
| `CustomField:Installation__c.Install_Date__c` | declared | profile-extractor |
| `CustomField:Installation__c.Panels_Installed__c` | declared | profile-extractor |
| `CustomField:Installation__c.Status__c` | declared | profile-extractor |
| `CustomField:Invoice__c.Amount__c` | declared | profile-extractor |
| `CustomField:Invoice__c.Due_Date__c` | declared | profile-extractor |
| `CustomField:Invoice__c.Status__c` | declared | profile-extractor |
| `CustomField:Payment__c.Amount__c` | declared | profile-extractor |
| `CustomField:Payment__c.Method__c` | declared | profile-extractor |
| `CustomField:Payment__c.Payment_Date__c` | declared | profile-extractor |
| `CustomField:Permit__c.Approved_Date__c` | declared | profile-extractor |
| `CustomField:Permit__c.Jurisdiction__c` | declared | profile-extractor |
| `CustomField:Permit__c.Status__c` | declared | profile-extractor |
| `CustomField:Permit__c.Submitted_Date__c` | declared | profile-extractor |
| `CustomField:Project__c.Account__c` | declared | profile-extractor |
| `CustomField:Project__c.Contract_Value__c` | declared | profile-extractor |
| `CustomField:Project__c.Expected_Completion__c` | declared | profile-extractor |
| `CustomField:Project__c.Permit_Approved__c` | declared | profile-extractor |
| `CustomField:Project__c.Risk_Score__c` | declared | profile-extractor |
| `CustomField:Project__c.Status__c` | declared | profile-extractor |
| `CustomField:Project__c.System_Size_kW__c` | declared | profile-extractor |
| `CustomField:Service_Visit__c.Reason__c` | declared | profile-extractor |
| `CustomField:Service_Visit__c.Resolved__c` | declared | profile-extractor |
| `CustomField:Service_Visit__c.Visit_Date__c` | declared | profile-extractor |
| `CustomField:Site_Survey__c.Roof_Type__c` | declared | profile-extractor |
| `CustomField:Site_Survey__c.Shading_Factor__c` | declared | profile-extractor |
| `CustomField:Warranty_Claim__c.Claim_Date__c` | declared | profile-extractor |
| `CustomField:Warranty_Claim__c.Status__c` | declared | profile-extractor |
| `CustomObject:Battery__c` | declared | profile-extractor |
| `CustomObject:Equipment_Allocation__c` | declared | profile-extractor |
| `CustomObject:Incentive__c` | declared | profile-extractor |
| `CustomObject:Installation__c` | declared | profile-extractor |
| `CustomObject:Invoice__c` | declared | profile-extractor |
| `CustomObject:Payment__c` | declared | profile-extractor |
| `CustomObject:Permit__c` | declared | profile-extractor |
| `CustomObject:Project__c` | declared | profile-extractor |
| `CustomObject:Service_Visit__c` | declared | profile-extractor |
| `CustomObject:Site_Survey__c` | declared | profile-extractor |
| `CustomObject:Solar_Panel__c` | declared | profile-extractor |
| `CustomObject:Warranty_Claim__c` | declared | profile-extractor |
