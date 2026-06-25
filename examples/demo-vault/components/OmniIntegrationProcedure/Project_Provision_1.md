---
apiName: Project_Provision_1
apiVersion: null
id: OmniIntegrationProcedure:Project_Provision_1
label: Project Provision
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  chainedIpCount: 1
  dataRaptorCount: 1
  description: null
  elementCount: 4
  isActive: true
  isIntegProcdSignatureAvl: false
  isIntegrationProcedure: true
  isManagedUsingStdDesigner: false
  isMetadataCacheDisabled: false
  isOmniScriptEmbeddable: false
  isTestProcedure: false
  isWebCompEnabled: false
  language: Procedure
  omniProcessKey: Project_Provision
  omniProcessType: Integration Procedure
  restEndpointCount: 0
  subType: Provision
  type: Project
  uniqueName: Project_Provision_1
  versionNumber: 1
sourcePath: source/main/default/omniIntegrationProcedures/Project_Provision_1.oip-meta.xml
type: OmniIntegrationProcedure
---

# Project Provision

**API Name:** `Project_Provision_1`  
**Type:** OmniIntegrationProcedure

## Properties

| Key | Value |
| --- | --- |
| chainedIpCount | `1` |
| dataRaptorCount | `1` |
| elementCount | `4` |
| isActive | `true` |
| isIntegProcdSignatureAvl | `false` |
| isIntegrationProcedure | `true` |
| isManagedUsingStdDesigner | `false` |
| isMetadataCacheDisabled | `false` |
| isOmniScriptEmbeddable | `false` |
| isTestProcedure | `false` |
| isWebCompEnabled | `false` |
| language | `Procedure` |
| omniProcessKey | `Project_Provision` |
| omniProcessType | `Integration Procedure` |
| restEndpointCount | `0` |
| subType | `Provision` |
| type | `Project` |
| uniqueName | `Project_Provision_1` |
| versionNumber | `1` |

## Incident edges

### dispatchesOmniAction (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `OmniDataTransform:Quote_To_Project_Map` | parsed | omni-integration-procedure |
| `OmniIntegrationProcedure:Permit_Submit` | parsed | omni-integration-procedure |
