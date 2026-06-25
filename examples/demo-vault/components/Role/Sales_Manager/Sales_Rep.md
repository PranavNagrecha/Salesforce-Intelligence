---
apiName: Sales_Rep
apiVersion: null
id: Role:Sales_Rep
label: Sales Rep
lastModifiedBy: null
lastModifiedDate: null
parentId: Role:Sales_Manager
properties:
  caseAccessLevel: Read
  contactAccessLevel: Edit
  description: Sells residential solar and battery systems.
  mayForecastManagerShare: false
  opportunityAccessLevel: Edit
sourcePath: source/main/default/roles/Sales_Rep.role-meta.xml
type: Role
---

# Sales Rep

**API Name:** `Sales_Rep`  
**Type:** Role

Sells residential solar and battery systems.

## Properties

| Key | Value |
| --- | --- |
| caseAccessLevel | `Read` |
| contactAccessLevel | `Edit` |
| mayForecastManagerShare | `false` |
| opportunityAccessLevel | `Edit` |

## Incident edges

### inheritsFrom (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `Role:Sales_Manager` | declared | role-extractor |
