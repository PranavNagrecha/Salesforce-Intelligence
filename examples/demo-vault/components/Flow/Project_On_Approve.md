---
apiName: Project_On_Approve
apiVersion: 61
id: Flow:Project_On_Approve
label: Project On Approve
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  conditions: []
  description: "When a Project is approved, create a Permit record (Submitted) linked back to the Project."
  elementsWithoutFault: 1
  faultableElementCount: 1
  flowExtractionWarnings: []
  hasUnhandledFaults: true
  interviewLabel: "Project On Approve {!$Flow.CurrentDateTime}"
  label: Project On Approve
  processType: AutoLaunchedFlow
  recordTriggerType: CreateAndUpdate
  runInMode: null
  status: Active
  triggerObject: Project__c
  triggerType: RecordAfterSave
sourcePath: source/main/default/flows/Project_On_Approve.flow-meta.xml
type: Flow
---

# Project On Approve

**API Name:** `Project_On_Approve`  
**Type:** Flow

When a Project is approved, create a Permit record (Submitted) linked back to the Project.

## Flow details

- **Status:** `Active`
- **Process type:** `AutoLaunchedFlow`
- **Trigger object:** `Project__c`
- **Trigger type:** `RecordAfterSave`
- **Record trigger type:** `CreateAndUpdate`

## Properties

| Key | Value |
| --- | --- |
| conditions | `` |
| elementsWithoutFault | `1` |
| faultableElementCount | `1` |
| flowExtractionWarnings | `` |
| hasUnhandledFaults | `true` |
| interviewLabel | `Project On Approve {!$Flow.CurrentDateTime}` |
| runInMode | `null` |

## Incident edges

### triggersOn (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | flow-extractor |

### writesTo (outgoing, 3)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Permit__c.Project__c` | parsed | flow-extractor |
| `CustomField:Permit__c.Status__c` | parsed | flow-extractor |
| `CustomObject:Permit__c` | parsed | flow-extractor |
