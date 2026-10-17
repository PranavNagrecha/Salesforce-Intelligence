---
apiName: Permit_Review_Queue
apiVersion: null
id: Queue:Permit_Review_Queue
label: Permit Review Queue
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  description: Permits awaiting jurisdiction review.
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
sourcePath: source/main/default/queues/Permit_Review_Queue.queue-meta.xml
type: Queue
---

# Permit Review Queue

**API Name:** `Permit_Review_Queue`  
**Type:** Queue

Permits awaiting jurisdiction review.

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
| `CustomObject:Permit__c` | declared | queue-extractor |
