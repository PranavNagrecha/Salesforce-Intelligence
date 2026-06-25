---
apiName: Ops_Group
apiVersion: null
id: Group:Ops_Group
label: Ops Group
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  description: Operations team members who manage projects and installations.
  doesIncludeBosses: false
  doesSendEmailToMembers: false
  emails: []
  memberCount: 0
sourcePath: source/main/default/groups/Ops_Group.group-meta.xml
type: Group
---

# Ops Group

**API Name:** `Ops_Group`  
**Type:** Group

Operations team members who manage projects and installations.

## Properties

| Key | Value |
| --- | --- |
| doesIncludeBosses | `false` |
| doesSendEmailToMembers | `false` |
| emails | `` |
| memberCount | `0` |

## Incident edges

### sharedWith (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `SharingRule:Project__c.Share_Projects_To_Ops` | declared | sharing-rule-extractor |
