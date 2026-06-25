---
apiName: Ops_Manager
apiVersion: null
id: Role:Ops_Manager
label: Ops Manager
lastModifiedBy: null
lastModifiedDate: null
parentId: Role:Ops_Director
properties:
  caseAccessLevel: Edit
  contactAccessLevel: Edit
  description: Schedules and oversees installation crews.
  mayForecastManagerShare: false
  opportunityAccessLevel: Read
sourcePath: source/main/default/roles/Ops_Manager.role-meta.xml
type: Role
---

# Ops Manager

**API Name:** `Ops_Manager`  
**Type:** Role

Schedules and oversees installation crews.

## Properties

| Key | Value |
| --- | --- |
| caseAccessLevel | `Edit` |
| contactAccessLevel | `Edit` |
| mayForecastManagerShare | `false` |
| opportunityAccessLevel | `Read` |

## Incident edges

### inheritsFrom (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Role:Installer` | declared | role-extractor |

### inheritsFrom (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `Role:Ops_Director` | declared | role-extractor |
