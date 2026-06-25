---
apiName: Verdant_Sales_Rep
apiVersion: null
id: Profile:Verdant_Sales_Rep
label: Verdant_Sales_Rep
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  applicationVisibilities: []
  classGrantCount: 0
  custom: true
  description: null
  fieldGrantCount: 27
  flowGrantCount: 0
  layoutAssignments: []
  loginHoursDefined: false
  loginIpRanges: []
  objectGrantCount: 6
  recordTypeVisibilities: []
  tabVisibilities: []
  userLicense: Salesforce
  userPermissions: []
sourcePath: source/main/default/profiles/Verdant_Sales_Rep.profile-meta.xml
type: Profile
---

# Verdant_Sales_Rep

**API Name:** `Verdant_Sales_Rep`  
**Type:** Profile

## Properties

| Key | Value |
| --- | --- |
| applicationVisibilities | `` |
| classGrantCount | `0` |
| custom | `true` |
| fieldGrantCount | `27` |
| flowGrantCount | `0` |
| layoutAssignments | `` |
| loginHoursDefined | `false` |
| loginIpRanges | `` |
| objectGrantCount | `6` |
| recordTypeVisibilities | `` |
| tabVisibilities | `` |
| userLicense | `Salesforce` |
| userPermissions | `` |

## Incident edges

### grantedBy (outgoing, 33)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Battery__c.Capacity_kWh__c` | declared | profile-extractor |
| `CustomField:Battery__c.Manufacturer__c` | declared | profile-extractor |
| `CustomField:Battery__c.Unit_Cost__c` | declared | profile-extractor |
| `CustomField:Incentive__c.Amount__c` | declared | profile-extractor |
| `CustomField:Incentive__c.Approved__c` | declared | profile-extractor |
| `CustomField:Incentive__c.Project__c` | declared | profile-extractor |
| `CustomField:Incentive__c.Type__c` | declared | profile-extractor |
| `CustomField:Invoice__c.Amount__c` | declared | profile-extractor |
| `CustomField:Invoice__c.Due_Date__c` | declared | profile-extractor |
| `CustomField:Invoice__c.Status__c` | declared | profile-extractor |
| `CustomField:Project__c.Account__c` | declared | profile-extractor |
| `CustomField:Project__c.Contract_Value__c` | declared | profile-extractor |
| `CustomField:Project__c.Expected_Completion__c` | declared | profile-extractor |
| `CustomField:Project__c.Opportunity__c` | declared | profile-extractor |
| `CustomField:Project__c.Permit_Approved__c` | declared | profile-extractor |
| `CustomField:Project__c.Risk_Score__c` | declared | profile-extractor |
| `CustomField:Project__c.Status__c` | declared | profile-extractor |
| `CustomField:Project__c.System_Size_kW__c` | declared | profile-extractor |
| `CustomField:Site_Survey__c.Project__c` | declared | profile-extractor |
| `CustomField:Site_Survey__c.Roof_Type__c` | declared | profile-extractor |
| `CustomField:Site_Survey__c.Shading_Factor__c` | declared | profile-extractor |
| `CustomField:Site_Survey__c.Survey_Date__c` | declared | profile-extractor |
| `CustomField:Site_Survey__c.Surveyor__c` | declared | profile-extractor |
| `CustomField:Solar_Panel__c.Active__c` | declared | profile-extractor |
| `CustomField:Solar_Panel__c.Manufacturer__c` | declared | profile-extractor |
| `CustomField:Solar_Panel__c.Unit_Cost__c` | declared | profile-extractor |
| `CustomField:Solar_Panel__c.Wattage__c` | declared | profile-extractor |
| `CustomObject:Battery__c` | declared | profile-extractor |
| `CustomObject:Incentive__c` | declared | profile-extractor |
| `CustomObject:Invoice__c` | declared | profile-extractor |
| `CustomObject:Project__c` | declared | profile-extractor |
| `CustomObject:Site_Survey__c` | declared | profile-extractor |
| `CustomObject:Solar_Panel__c` | declared | profile-extractor |
