---
apiName: Sales_Manager
apiVersion: null
id: Role:Sales_Manager
label: Sales Manager
lastModifiedBy: null
lastModifiedDate: null
parentId: Role:Sales_VP
properties:
  caseAccessLevel: Edit
  contactAccessLevel: Edit
  description: Manages a team of solar sales reps.
  mayForecastManagerShare: false
  opportunityAccessLevel: Edit
sourcePath: source/main/default/roles/Sales_Manager.role-meta.xml
type: Role
---

# Sales Manager

**API Name:** `Sales_Manager`  
**Type:** Role

Manages a team of solar sales reps.

## Properties

| Key | Value |
| --- | --- |
| caseAccessLevel | `Edit` |
| contactAccessLevel | `Edit` |
| mayForecastManagerShare | `false` |
| opportunityAccessLevel | `Edit` |

## Incident edges

### inheritsFrom (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Role:Sales_Rep` | declared | role-extractor |

### inheritsFrom (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `Role:Sales_VP` | declared | role-extractor |
