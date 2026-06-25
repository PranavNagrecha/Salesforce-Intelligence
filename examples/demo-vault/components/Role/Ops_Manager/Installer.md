---
apiName: Installer
apiVersion: null
id: Role:Installer
label: Installer
lastModifiedBy: null
lastModifiedDate: null
parentId: Role:Ops_Manager
properties:
  caseAccessLevel: None
  contactAccessLevel: Read
  description: Field technician installing panels and batteries.
  mayForecastManagerShare: false
  opportunityAccessLevel: None
sourcePath: source/main/default/roles/Installer.role-meta.xml
type: Role
---

# Installer

**API Name:** `Installer`  
**Type:** Role

Field technician installing panels and batteries.

## Properties

| Key | Value |
| --- | --- |
| caseAccessLevel | `None` |
| contactAccessLevel | `Read` |
| mayForecastManagerShare | `false` |
| opportunityAccessLevel | `None` |

## Incident edges

### inheritsFrom (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `Role:Ops_Manager` | declared | role-extractor |
