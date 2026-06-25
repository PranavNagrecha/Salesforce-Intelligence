---
apiName: Sales_VP
apiVersion: null
id: Role:Sales_VP
label: Sales VP
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  caseAccessLevel: Edit
  contactAccessLevel: Edit
  description: Top of the sales role hierarchy at Verdant Energy.
  mayForecastManagerShare: true
  opportunityAccessLevel: Edit
sourcePath: source/main/default/roles/Sales_VP.role-meta.xml
type: Role
---

# Sales VP

**API Name:** `Sales_VP`  
**Type:** Role

Top of the sales role hierarchy at Verdant Energy.

## Properties

| Key | Value |
| --- | --- |
| caseAccessLevel | `Edit` |
| contactAccessLevel | `Edit` |
| mayForecastManagerShare | `true` |
| opportunityAccessLevel | `Edit` |

## Incident edges

### inheritsFrom (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Role:Sales_Manager` | declared | role-extractor |
