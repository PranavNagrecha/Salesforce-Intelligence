---
apiName: VerdantPortal
apiVersion: null
id: CustomSite:VerdantPortal
label: VerdantPortal
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  active: true
  favoriteIcon: null
  guestProfileConvention: heuristic
  guestProfileName: VerdantPortal Profile
  guestRecordDefaultOwner: "guest@verdantenergy.example"
  masterLabel: VerdantPortal
  siteType: ChatterNetwork
  urlPathPrefix: portal
sourcePath: source/main/default/sites/VerdantPortal.site-meta.xml
type: CustomSite
---

# VerdantPortal

**API Name:** `VerdantPortal`  
**Type:** CustomSite

## Properties

| Key | Value |
| --- | --- |
| active | `true` |
| favoriteIcon | `null` |
| guestProfileConvention | `heuristic` |
| guestProfileName | `VerdantPortal Profile` |
| guestRecordDefaultOwner | `guest@verdantenergy.example` |
| masterLabel | `VerdantPortal` |
| siteType | `ChatterNetwork` |
| urlPathPrefix | `portal` |

## Incident edges

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Network:VerdantPortal` | declared | network-extractor |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `Profile:VerdantPortal Profile` | heuristic | custom-site-extractor |
