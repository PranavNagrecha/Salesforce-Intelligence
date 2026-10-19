---
apiName: Demo_ProjectChangeTrigger
apiVersion: 61
id: ApexTrigger:Demo_ProjectChangeTrigger
label: Demo_ProjectChangeTrigger
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  events:
    - after insert
  isPlatformEventSubscriber: false
  lineCount: 5
  platformCalls:
    System: 1
  qualityIssues:
    - confidence: heuristic
      explanation: "Trigger 'Demo_ProjectChangeTrigger' has no recognizable recursion guard — risks the 16-trigger-execution-per-transaction governor limit on recursive saves. Add a static Boolean / Set<Id> guard or use a TriggerHandler framework."
      location: trigger
      rule: trigger-no-recursion-guard
      severity: medium
  sourceBytes: 190
  status: Active
  triggerObject: Project__ChangeEvent
sourcePath: source/main/default/triggers/Demo_ProjectChangeTrigger.trigger
type: ApexTrigger
---

# Demo_ProjectChangeTrigger

**API Name:** `Demo_ProjectChangeTrigger`  
**Type:** ApexTrigger

## Properties

| Key | Value |
| --- | --- |
| events | `after insert` |
| isPlatformEventSubscriber | `false` |
| lineCount | `5` |
| platformCalls | `[object Object]` |
| qualityIssues | `[object Object]` |
| sourceBytes | `190` |
| status | `Active` |
| triggerObject | `Project__ChangeEvent` |

## Source

```apex
trigger Demo_ProjectChangeTrigger on Project__ChangeEvent (after insert) {
    for (Project__ChangeEvent evt : Trigger.new) {
        System.debug(evt.ChangeEventHeader.changeType);
    }
}

```

## Incident edges

### readsFrom (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__ChangeEvent.ChangeEventHeader` | parsed | apex-ast |

### subscribesToChange (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__ChangeEvent` | declared | apex-trigger-extractor |

### triggersOn (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__ChangeEvent` | declared | apex-trigger-extractor |
