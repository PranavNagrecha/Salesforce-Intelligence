---
apiName: Finance_Group
apiVersion: null
id: Group:Finance_Group
label: Finance Group
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  description: Finance team members who handle invoices and payments.
  doesIncludeBosses: false
  doesSendEmailToMembers: false
  emails: []
  memberCount: 0
sourcePath: source/main/default/groups/Finance_Group.group-meta.xml
type: Group
---

# Finance Group

**API Name:** `Finance_Group`  
**Type:** Group

Finance team members who handle invoices and payments.

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
| `SharingRule:Invoice__c.Share_Invoices_To_Finance` | declared | sharing-rule-extractor |
