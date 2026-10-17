---
apiName: Verdant_Event_Channel__chn
apiVersion: null
id: PlatformEventChannel:Verdant_Event_Channel__chn
label: Verdant Event Channel
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  channelType: event
  eventType: null
  label: Verdant Event Channel
sourcePath: source/main/default/platformEventChannels/Verdant_Event_Channel__chn.platformEventChannel-meta.xml
type: PlatformEventChannel
---

# Verdant Event Channel

**API Name:** `Verdant_Event_Channel__chn`  
**Type:** PlatformEventChannel

## Properties

| Key | Value |
| --- | --- |
| channelType | `event` |
| eventType | `null` |

## Incident edges

### parentOf (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `PlatformEventChannelMember:Verdant_Event_Member__chn` | declared | platform-event-channel-extractor |
