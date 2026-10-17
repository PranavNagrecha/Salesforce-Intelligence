---
apiName: Warranty_Queue
apiVersion: null
id: Queue:Warranty_Queue
label: Warranty Queue
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  description: Warranty claims awaiting triage.
  doesIncludeBosses: false
  doesSendEmailToMembers: false
  email: null
  memberChannels: []
  memberCount: 0
  memberEmails: []
  memberSource: user-direct
  queueMembersDeclared: false
  queueMembersUnparsed: false
  queueRoutingConfig: null
  sobjectTypeCount: 1
sourcePath: source/main/default/queues/Warranty_Queue.queue-meta.xml
type: Queue
---

# Warranty Queue

**API Name:** `Warranty_Queue`  
**Type:** Queue

Warranty claims awaiting triage.

## Properties

| Key | Value |
| --- | --- |
| doesIncludeBosses | `false` |
| doesSendEmailToMembers | `false` |
| email | `null` |
| memberChannels | `` |
| memberCount | `0` |
| memberEmails | `` |
| memberSource | `user-direct` |
| queueMembersDeclared | `false` |
| queueMembersUnparsed | `false` |
| queueRoutingConfig | `null` |
| sobjectTypeCount | `1` |

## Incident edges

### sharedWith (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Warranty_Claim__c` | declared | queue-extractor |
