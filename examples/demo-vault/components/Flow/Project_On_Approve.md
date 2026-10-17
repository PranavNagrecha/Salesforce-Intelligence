---
apiName: Project_On_Approve
apiVersion: 61
id: Flow:Project_On_Approve
label: Project On Approve
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  actionCalls: []
  conditions:
    - conditionContextId: ConditionalContext:Flow:Project_On_Approve.condition-0
      expression: Status__c EqualTo Approved
      fieldRefs:
        - CustomField:Project__c.Status__c
      kind: flow-recordtrigger
  description: "When a Project is approved, create a Permit record (Submitted) linked back to the Project."
  elementsWithoutFault: 1
  entryRequiresRecordChange: null
  faultableElementCount: 1
  flowExtractionWarnings: []
  formulaComparisons: []
  formulaValueRefs: []
  hasImmediateConnector: true
  hasUnhandledFaults: true
  interviewLabel: "Project On Approve {!$Flow.CurrentDateTime}"
  label: Project On Approve
  processType: AutoLaunchedFlow
  recordTriggerType: CreateAndUpdate
  runAsyncAfterCommit: false
  runInMode: null
  scheduleFrequency: null
  scheduleStartDate: null
  scheduleStartTime: null
  scheduledPathCount: 0
  scheduledPathTypes: []
  status: Active
  triggerObject: Project__c
  triggerOrder: null
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
| actionCalls | `` |
| conditions | `[object Object]` |
| elementsWithoutFault | `1` |
| entryRequiresRecordChange | `null` |
| faultableElementCount | `1` |
| flowExtractionWarnings | `` |
| formulaComparisons | `` |
| formulaValueRefs | `` |
| hasImmediateConnector | `true` |
| hasUnhandledFaults | `true` |
| interviewLabel | `Project On Approve {!$Flow.CurrentDateTime}` |
| runAsyncAfterCommit | `false` |
| runInMode | `null` |
| scheduleFrequency | `null` |
| scheduleStartDate | `null` |
| scheduleStartTime | `null` |
| scheduledPathCount | `0` |
| scheduledPathTypes | `` |
| triggerOrder | `null` |

## Incident edges

### firesWhen (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ConditionalContext:Flow:Project_On_Approve.condition-0` | declared | condition-extractor |

### readsFrom (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Id` | declared | flow-extractor |

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
