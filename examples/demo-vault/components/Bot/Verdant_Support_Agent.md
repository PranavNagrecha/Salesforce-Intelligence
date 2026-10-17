---
apiName: Verdant_Support_Agent
apiVersion: null
id: Bot:Verdant_Support_Agent
label: Verdant Support Agent
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  agentTemplate: AiCopilot__AgentforceAgent
  agentType: EinsteinServiceAgent
  botMlDomain:
    label: Verdant Support Agent
    name: Verdant_Support_Agent
  botSource: None
  botUser: "agentuser@verdantenergy.example"
  contextVariableCount: 1
  description: Answers customer questions about solar projects and installations.
  logPrivateConversationData: false
  richContentEnabled: true
  sessionTimeout: 0
  type: ExternalCopilot
sourcePath: source/main/default/bots/Verdant_Support_Agent/Verdant_Support_Agent.bot-meta.xml
type: Bot
---

# Verdant Support Agent

**API Name:** `Verdant_Support_Agent`  
**Type:** Bot

Answers customer questions about solar projects and installations.

## Properties

| Key | Value |
| --- | --- |
| agentTemplate | `AiCopilot__AgentforceAgent` |
| agentType | `EinsteinServiceAgent` |
| botMlDomain | `[object Object]` |
| botSource | `None` |
| botUser | `agentuser@verdantenergy.example` |
| contextVariableCount | `1` |
| logPrivateConversationData | `false` |
| richContentEnabled | `true` |
| sessionTimeout | `0` |
| type | `ExternalCopilot` |

## Incident edges

### parentOf (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `BotVersion:Verdant_Support_Agent.v1` | declared | bot-extractor |
