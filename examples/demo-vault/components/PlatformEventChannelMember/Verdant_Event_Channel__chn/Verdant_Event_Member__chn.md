---
apiName: Verdant_Event_Member__chn
apiVersion: null
id: PlatformEventChannelMember:Verdant_Event_Member__chn
label: null
lastModifiedBy: null
lastModifiedDate: null
parentId: PlatformEventChannel:Verdant_Event_Channel__chn
properties:
  eventChannel: Verdant_Event_Channel__chn
  selectedEntity: Project_Status_Changed__e
sourcePath: source/main/default/platformEventChannelMembers/Verdant_Event_Member__chn.platformEventChannelMember-meta.xml
type: PlatformEventChannelMember
---

# Verdant_Event_Member__chn

**API Name:** `Verdant_Event_Member__chn`  
**Type:** PlatformEventChannelMember

## Properties

| Key | Value |
| --- | --- |
| eventChannel | `Verdant_Event_Channel__chn` |
| selectedEntity | `Project_Status_Changed__e` |

## Incident edges

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PlatformEventChannel:Verdant_Event_Channel__chn` | declared | platform-event-channel-extractor |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project_Status_Changed__e` | declared | platform-event-channel-extractor |
