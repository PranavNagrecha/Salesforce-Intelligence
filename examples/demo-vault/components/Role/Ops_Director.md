---
apiName: Ops_Director
apiVersion: null
id: Role:Ops_Director
label: Ops Director
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  caseAccessLevel: Edit
  contactAccessLevel: Edit
  description: Top of the operations role hierarchy at Verdant Energy.
  mayForecastManagerShare: false
  opportunityAccessLevel: Read
sourcePath: source/main/default/roles/Ops_Director.role-meta.xml
type: Role
---

# Ops Director

**API Name:** `Ops_Director`  
**Type:** Role

Top of the operations role hierarchy at Verdant Energy.

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
| `Role:Ops_Manager` | declared | role-extractor |
