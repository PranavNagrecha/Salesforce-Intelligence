---
apiName: ProjectTrigger
apiVersion: 61
id: ApexTrigger:ProjectTrigger
label: ProjectTrigger
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  events:
    - before insert
    - before update
    - after update
  isPlatformEventSubscriber: false
  lineCount: 8
  sourceBytes: 312
  status: Active
  triggerObject: Project__c
sourcePath: source/main/default/triggers/ProjectTrigger.trigger
type: ApexTrigger
---

# ProjectTrigger

**API Name:** `ProjectTrigger`  
**Type:** ApexTrigger

## Properties

| Key | Value |
| --- | --- |
| events | `before insert,before update,after update` |
| isPlatformEventSubscriber | `false` |
| lineCount | `8` |
| sourceBytes | `312` |
| status | `Active` |
| triggerObject | `Project__c` |

## Source

```apex
trigger ProjectTrigger on Project__c (before insert, before update, after update) {
    if (Trigger.isBefore) {
        ProjectTriggerHandler.handleBeforeSave(Trigger.new);
    }
    if (Trigger.isAfter && Trigger.isUpdate) {
        ProjectTriggerHandler.handleAfterUpdate(Trigger.new, Trigger.oldMap);
    }
}

```

## Incident edges

### callsApex (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:ProjectTriggerHandler` | parsed | apex-ast |

### triggersOn (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | apex-trigger-extractor |
