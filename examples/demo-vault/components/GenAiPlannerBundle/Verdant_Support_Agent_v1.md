---
apiName: Verdant_Support_Agent_v1
apiVersion: null
id: GenAiPlannerBundle:Verdant_Support_Agent_v1
label: Verdant Support Agent
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  capabilities:
    - Reasoning
    - Grounding
  description: Helps customers check solar project status and installation schedules
  functionCount: 0
  functionNames: []
  plannerType: AiCopilot__ReAct
  pluginCount: 1
  pluginNames:
    - Project_Inquiry
sourcePath: source/main/default/genAiPlannerBundles/Verdant_Support_Agent_v1/Verdant_Support_Agent_v1.genAiPlannerBundle-meta.xml
type: GenAiPlannerBundle
---

# Verdant Support Agent

**API Name:** `Verdant_Support_Agent_v1`  
**Type:** GenAiPlannerBundle

Helps customers check solar project status and installation schedules

## Properties

| Key | Value |
| --- | --- |
| capabilities | `Reasoning,Grounding` |
| functionCount | `0` |
| functionNames | `` |
| plannerType | `AiCopilot__ReAct` |
| pluginCount | `1` |
| pluginNames | `Project_Inquiry` |

## Incident edges

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `BotVersion:Verdant_Support_Agent.v1` | declared | bot-extractor |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `GenAiPlugin:Project_Inquiry` | declared | gen-ai-extractor |
