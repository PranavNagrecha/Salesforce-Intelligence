---
apiName: Customer_Intake_English_1
apiVersion: null
id: OmniScript:Customer_Intake_English_1
label: Customer Intake
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  allowSaveForLater: true
  currentLanguage: en_US
  elementCount: 5
  enableKnowledge: false
  isActive: true
  isManagedUsingStdDesigner: false
  isMetadataCacheDisabled: false
  isOmniScriptEmbeddable: true
  isTestProcedure: false
  isWebCompEnabled: true
  language: English
  name: Customer Intake
  omniProcessKey: Customer_Intake
  omniProcessType: OmniScript
  omniScriptExtractionWarnings: []
  scrollBehavior: auto
  stepChartPlacement: right
  subType: Intake
  type: Customer
  uniqueName: Customer_Intake_English_1
  versionNumber: 1
sourcePath: source/main/default/omniScripts/Customer_Intake_English_1.os-meta.xml
type: OmniScript
---

# Customer Intake

**API Name:** `Customer_Intake_English_1`  
**Type:** OmniScript

## Properties

| Key | Value |
| --- | --- |
| allowSaveForLater | `true` |
| currentLanguage | `en_US` |
| elementCount | `5` |
| enableKnowledge | `false` |
| isActive | `true` |
| isManagedUsingStdDesigner | `false` |
| isMetadataCacheDisabled | `false` |
| isOmniScriptEmbeddable | `true` |
| isTestProcedure | `false` |
| isWebCompEnabled | `true` |
| language | `English` |
| name | `Customer Intake` |
| omniProcessKey | `Customer_Intake` |
| omniProcessType | `OmniScript` |
| omniScriptExtractionWarnings | `` |
| scrollBehavior | `auto` |
| stepChartPlacement | `right` |
| subType | `Intake` |
| type | `Customer` |
| uniqueName | `Customer_Intake_English_1` |
| versionNumber | `1` |

## Incident edges

### dispatchesOmniAction (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `OmniDataTransform:Quote_To_Project_Map` | parsed | omniscript-extractor |
| `OmniIntegrationProcedure:Project_Provision` | parsed | omniscript-extractor |
