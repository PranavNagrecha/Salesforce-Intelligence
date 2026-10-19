---
apiName: projectSummaryCard
apiVersion: 61
id: LightningComponentBundle:projectSummaryCard
label: projectSummaryCard
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  apexCallCount: 0
  apiVersion: 61
  fieldAccessCount: 2
  hasController: true
  hasTemplate: true
  isExposed: true
  jsFileBytes: 134
  targetConfigCount: 0
  targets:
    - lightning__RecordPage
    - lightning__FlowScreen
sourcePath: source/main/default/lwc/projectSummaryCard
type: LightningComponentBundle
---

# projectSummaryCard

**API Name:** `projectSummaryCard`  
**Type:** LightningComponentBundle

## Properties

| Key | Value |
| --- | --- |
| apexCallCount | `0` |
| apiVersion | `61` |
| fieldAccessCount | `2` |
| hasController | `true` |
| hasTemplate | `true` |
| isExposed | `true` |
| jsFileBytes | `134` |
| targetConfigCount | `0` |
| targets | `lightning__RecordPage,lightning__FlowScreen` |

## Incident edges

### readsFrom (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Status__c` | declared | lwc-extractor |
| `CustomField:Project__c.Utility_Provider__c` | declared | lwc-extractor |

### references (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Flow:Project_Site_Survey` | declared | flow-extractor |
