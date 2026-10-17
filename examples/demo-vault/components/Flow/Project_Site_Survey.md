---
apiName: Project_Site_Survey
apiVersion: 61
id: Flow:Project_Site_Survey
label: Project Site Survey
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  actionCalls: []
  conditions: []
  description: "Screen flow launched from a Project: the surveyor confirms system size and expected completion next to the project summary card."
  elementsWithoutFault: 0
  entryRequiresRecordChange: null
  faultableElementCount: 0
  flowExtractionWarnings: []
  formulaComparisons: []
  formulaValueRefs: []
  hasImmediateConnector: true
  hasUnhandledFaults: false
  interviewLabel: "Project Site Survey {!$Flow.CurrentDateTime}"
  label: Project Site Survey
  processType: Flow
  recordTriggerType: null
  runAsyncAfterCommit: false
  runInMode: null
  scheduleFrequency: null
  scheduleStartDate: null
  scheduleStartTime: null
  scheduledPathCount: 0
  scheduledPathTypes: []
  status: Active
  triggerObject: null
  triggerOrder: null
  triggerType: null
sourcePath: source/main/default/flows/Project_Site_Survey.flow-meta.xml
type: Flow
---

# Project Site Survey

**API Name:** `Project_Site_Survey`  
**Type:** Flow

Screen flow launched from a Project: the surveyor confirms system size and expected completion next to the project summary card.

## Flow details

- **Status:** `Active`
- **Process type:** `Flow`
- **Trigger object:** —
- **Trigger type:** —
- **Record trigger type:** —

## Properties

| Key | Value |
| --- | --- |
| actionCalls | `` |
| conditions | `` |
| elementsWithoutFault | `0` |
| entryRequiresRecordChange | `null` |
| faultableElementCount | `0` |
| flowExtractionWarnings | `` |
| formulaComparisons | `` |
| formulaValueRefs | `` |
| hasImmediateConnector | `true` |
| hasUnhandledFaults | `false` |
| interviewLabel | `Project Site Survey {!$Flow.CurrentDateTime}` |
| runAsyncAfterCommit | `false` |
| runInMode | `null` |
| scheduleFrequency | `null` |
| scheduleStartDate | `null` |
| scheduleStartTime | `null` |
| scheduledPathCount | `0` |
| scheduledPathTypes | `` |
| triggerOrder | `null` |

## Incident edges

### readsFrom (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Expected_Completion__c` | declared | flow-extractor |
| `CustomField:Project__c.System_Size_kW__c` | declared | flow-extractor |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `LightningComponentBundle:projectSummaryCard` | declared | flow-extractor |

### writesTo (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Expected_Completion__c` | declared | flow-extractor |
| `CustomField:Project__c.System_Size_kW__c` | declared | flow-extractor |
