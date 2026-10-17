---
apiName: VerdantPortal
apiVersion: null
id: Network:VerdantPortal
label: VerdantPortal
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  allowInternalUserLogin: false
  enableGuestChatter: false
  enableGuestFileAccess: true
  enableGuestMemberVisibility: false
  memberPermissionSetCount: 1
  memberPermissionSets:
    - Customer_Portal_Access
  memberProfileCount: 1
  memberProfiles:
    - Customer Community User
  picassoSite: VerdantPortal1
  selfRegProfile: null
  selfRegistration: false
  site: VerdantPortal
  status: Live
  urlPathPrefix: portal
sourcePath: source/main/default/networks/VerdantPortal.network-meta.xml
type: Network
---

# VerdantPortal

**API Name:** `VerdantPortal`  
**Type:** Network

## Properties

| Key | Value |
| --- | --- |
| allowInternalUserLogin | `false` |
| enableGuestChatter | `false` |
| enableGuestFileAccess | `true` |
| enableGuestMemberVisibility | `false` |
| memberPermissionSetCount | `1` |
| memberPermissionSets | `Customer_Portal_Access` |
| memberProfileCount | `1` |
| memberProfiles | `Customer Community User` |
| picassoSite | `VerdantPortal1` |
| selfRegProfile | `null` |
| selfRegistration | `false` |
| site | `VerdantPortal` |
| status | `Live` |
| urlPathPrefix | `portal` |

## Incident edges

### references (outgoing, 4)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomSite:VerdantPortal` | declared | network-extractor |
| `ExperienceBundle:VerdantPortal1` | declared | network-extractor |
| `PermissionSet:Customer_Portal_Access` | declared | network-extractor |
| `Profile:Customer Community User` | declared | network-extractor |
