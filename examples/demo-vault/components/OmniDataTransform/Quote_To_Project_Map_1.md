---
apiName: Quote_To_Project_Map_1
apiVersion: null
id: OmniDataTransform:Quote_To_Project_Map_1
label: Maps an incoming solar quote payload onto Project__c fields for the Customer Intake provisioning flow.
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  active: true
  assignmentRulesUsed: false
  deletedOnSuccess: false
  description: Maps an incoming solar quote payload onto Project__c fields for the Customer Intake provisioning flow.
  errorIgnored: false
  expectedInputJson: null
  expectedOutputJson: null
  fieldLevelSecurityEnabled: true
  inputType: JSON
  interfaceClass: Transform
  isManagedUsingStdDesigner: false
  name: Quote_To_Project_Map
  nullInputsIncludedInOutput: false
  operationType: Transform
  outputType: SObject
  rollbackOnError: false
  sourceObject: null
  sourceObjectDefault: false
  transformItemCount: 4
  uniqueName: Quote_To_Project_Map_1
  versionNumber: 1
sourcePath: source/main/default/omniDataTransforms/Quote_To_Project_Map_1.rpt-meta.xml
type: OmniDataTransform
---

# Maps an incoming solar quote payload onto Project__c fields for the Customer Intake provisioning flow.

**API Name:** `Quote_To_Project_Map_1`  
**Type:** OmniDataTransform

Maps an incoming solar quote payload onto Project__c fields for the Customer Intake provisioning flow.

## Properties

| Key | Value |
| --- | --- |
| active | `true` |
| assignmentRulesUsed | `false` |
| deletedOnSuccess | `false` |
| errorIgnored | `false` |
| expectedInputJson | `null` |
| expectedOutputJson | `null` |
| fieldLevelSecurityEnabled | `true` |
| inputType | `JSON` |
| interfaceClass | `Transform` |
| isManagedUsingStdDesigner | `false` |
| name | `Quote_To_Project_Map` |
| nullInputsIncludedInOutput | `false` |
| operationType | `Transform` |
| outputType | `SObject` |
| rollbackOnError | `false` |
| sourceObject | `null` |
| sourceObjectDefault | `false` |
| transformItemCount | `4` |
| uniqueName | `Quote_To_Project_Map_1` |
| versionNumber | `1` |

## Incident edges

### references (outgoing, 3)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project` | parsed | omni-data-transform |
| `CustomObject:Project__c` | declared | omni-data-transform |
| `CustomObject:Quote` | parsed | omni-data-transform |
