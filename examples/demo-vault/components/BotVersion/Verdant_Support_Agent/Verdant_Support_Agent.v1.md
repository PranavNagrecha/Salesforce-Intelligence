---
apiName: Verdant_Support_Agent.v1
apiVersion: null
id: BotVersion:Verdant_Support_Agent.v1
label: null
lastModifiedBy: null
lastModifiedDate: null
parentId: Bot:Verdant_Support_Agent
properties:
  citationsEnabled: "false"
  dialogCount: 2
  entryDialog: Welcome
  intentCount: 0
  knowledgeFallbackEnabled: "false"
  plannerNames:
    - Verdant_Support_Agent_v1
  toneType: Professional
sourcePath: source/main/default/bots/Verdant_Support_Agent/v1.botVersion-meta.xml
type: BotVersion
---

# Verdant_Support_Agent.v1

**API Name:** `Verdant_Support_Agent.v1`  
**Type:** BotVersion

## Properties

| Key | Value |
| --- | --- |
| citationsEnabled | `false` |
| dialogCount | `2` |
| entryDialog | `Welcome` |
| intentCount | `0` |
| knowledgeFallbackEnabled | `false` |
| plannerNames | `Verdant_Support_Agent_v1` |
| toneType | `Professional` |

## Incident edges

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Bot:Verdant_Support_Agent` | declared | bot-extractor |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `GenAiPlannerBundle:Verdant_Support_Agent_v1` | declared | bot-extractor |
