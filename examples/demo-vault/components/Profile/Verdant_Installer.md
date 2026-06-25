---
apiName: Verdant_Installer
apiVersion: null
id: Profile:Verdant_Installer
label: Verdant_Installer
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  applicationVisibilities: []
  classGrantCount: 0
  custom: true
  description: null
  fieldGrantCount: 25
  flowGrantCount: 0
  layoutAssignments: []
  loginHoursDefined: false
  loginIpRanges: []
  objectGrantCount: 7
  recordTypeVisibilities: []
  tabVisibilities: []
  userLicense: Salesforce
  userPermissions: []
sourcePath: source/main/default/profiles/Verdant_Installer.profile-meta.xml
type: Profile
---

# Verdant_Installer

**API Name:** `Verdant_Installer`  
**Type:** Profile

## Properties

| Key | Value |
| --- | --- |
| applicationVisibilities | `` |
| classGrantCount | `0` |
| custom | `true` |
| fieldGrantCount | `25` |
| flowGrantCount | `0` |
| layoutAssignments | `` |
| loginHoursDefined | `false` |
| loginIpRanges | `` |
| objectGrantCount | `7` |
| recordTypeVisibilities | `` |
| tabVisibilities | `` |
| userLicense | `Salesforce` |
| userPermissions | `` |

## Incident edges

### grantedBy (outgoing, 32)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Battery__c.Capacity_kWh__c` | declared | profile-extractor |
| `CustomField:Battery__c.Manufacturer__c` | declared | profile-extractor |
| `CustomField:Installation__c.Crew_Lead__c` | declared | profile-extractor |
| `CustomField:Installation__c.Install_Date__c` | declared | profile-extractor |
| `CustomField:Installation__c.Panels_Installed__c` | declared | profile-extractor |
| `CustomField:Installation__c.Project__c` | declared | profile-extractor |
| `CustomField:Installation__c.Status__c` | declared | profile-extractor |
| `CustomField:Project__c.Account__c` | declared | profile-extractor |
| `CustomField:Project__c.Expected_Completion__c` | declared | profile-extractor |
| `CustomField:Project__c.Permit_Approved__c` | declared | profile-extractor |
| `CustomField:Project__c.Status__c` | declared | profile-extractor |
| `CustomField:Project__c.System_Size_kW__c` | declared | profile-extractor |
| `CustomField:Service_Visit__c.Installation__c` | declared | profile-extractor |
| `CustomField:Service_Visit__c.Reason__c` | declared | profile-extractor |
| `CustomField:Service_Visit__c.Resolved__c` | declared | profile-extractor |
| `CustomField:Service_Visit__c.Technician__c` | declared | profile-extractor |
| `CustomField:Service_Visit__c.Visit_Date__c` | declared | profile-extractor |
| `CustomField:Site_Survey__c.Roof_Type__c` | declared | profile-extractor |
| `CustomField:Site_Survey__c.Shading_Factor__c` | declared | profile-extractor |
| `CustomField:Solar_Panel__c.Manufacturer__c` | declared | profile-extractor |
| `CustomField:Solar_Panel__c.Wattage__c` | declared | profile-extractor |
| `CustomField:Warranty_Claim__c.Claim_Date__c` | declared | profile-extractor |
| `CustomField:Warranty_Claim__c.Installation__c` | declared | profile-extractor |
| `CustomField:Warranty_Claim__c.Issue__c` | declared | profile-extractor |
| `CustomField:Warranty_Claim__c.Status__c` | declared | profile-extractor |
| `CustomObject:Battery__c` | declared | profile-extractor |
| `CustomObject:Installation__c` | declared | profile-extractor |
| `CustomObject:Project__c` | declared | profile-extractor |
| `CustomObject:Service_Visit__c` | declared | profile-extractor |
| `CustomObject:Site_Survey__c` | declared | profile-extractor |
| `CustomObject:Solar_Panel__c` | declared | profile-extractor |
| `CustomObject:Warranty_Claim__c` | declared | profile-extractor |
