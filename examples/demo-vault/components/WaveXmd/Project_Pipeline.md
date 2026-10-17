---
apiName: Project_Pipeline
apiVersion: null
id: WaveXmd:Project_Pipeline
label: Project_Pipeline
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  application: Verdant_Analytics
  dataset: Project_Pipeline
  datasetConnector: null
  datasetFullyQualifiedName: null
  dateCount: 0
  dimensionCount: 1
  measureCount: 1
  origin: null
  referencedFields:
    - Project__c.Contract_Value__c
    - Project__c.Status__c
  waveVisualization: null
  xmdType: User
sourcePath: source/main/default/wave/Project_Pipeline.xmd-meta.xml
type: WaveXmd
---

# Project_Pipeline

**API Name:** `Project_Pipeline`  
**Type:** WaveXmd

## Properties

| Key | Value |
| --- | --- |
| application | `Verdant_Analytics` |
| dataset | `Project_Pipeline` |
| datasetConnector | `null` |
| datasetFullyQualifiedName | `null` |
| dateCount | `0` |
| dimensionCount | `1` |
| measureCount | `1` |
| origin | `null` |
| referencedFields | `Project__c.Contract_Value__c,Project__c.Status__c` |
| waveVisualization | `null` |
| xmdType | `User` |

## Incident edges

### references (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Contract_Value__c` | declared | wave-xmd-extractor |
| `CustomField:Project__c.Status__c` | declared | wave-xmd-extractor |
