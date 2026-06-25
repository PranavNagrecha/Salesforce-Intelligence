---
apiName: Installation_On_Complete
apiVersion: 61
id: Flow:Installation_On_Complete
label: Installation On Complete
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  conditions: []
  description: "When an Installation is Completed, log an Inspection Service Visit and mark the parent Project Complete."
  elementsWithoutFault: 2
  faultableElementCount: 2
  flowExtractionWarnings: []
  hasUnhandledFaults: true
  interviewLabel: "Installation On Complete {!$Flow.CurrentDateTime}"
  label: Installation On Complete
  processType: AutoLaunchedFlow
  recordTriggerType: CreateAndUpdate
  runInMode: null
  status: Active
  triggerObject: Installation__c
  triggerType: RecordAfterSave
sourcePath: source/main/default/flows/Installation_On_Complete.flow-meta.xml
type: Flow
---

# Installation On Complete

**API Name:** `Installation_On_Complete`  
**Type:** Flow

When an Installation is Completed, log an Inspection Service Visit and mark the parent Project Complete.

## Flow details

- **Status:** `Active`
- **Process type:** `AutoLaunchedFlow`
- **Trigger object:** `Installation__c`
- **Trigger type:** `RecordAfterSave`
- **Record trigger type:** `CreateAndUpdate`

## Properties

| Key | Value |
| --- | --- |
| conditions | `` |
| elementsWithoutFault | `2` |
| faultableElementCount | `2` |
| flowExtractionWarnings | `` |
| hasUnhandledFaults | `true` |
| interviewLabel | `Installation On Complete {!$Flow.CurrentDateTime}` |
| runInMode | `null` |

## Incident edges

### readsFrom (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | parsed | flow-extractor |

### triggersOn (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Installation__c` | declared | flow-extractor |

### writesTo (outgoing, 5)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Status__c` | parsed | flow-extractor |
| `CustomField:Service_Visit__c.Installation__c` | parsed | flow-extractor |
| `CustomField:Service_Visit__c.Reason__c` | parsed | flow-extractor |
| `CustomObject:Project__c` | parsed | flow-extractor |
| `CustomObject:Service_Visit__c` | parsed | flow-extractor |
