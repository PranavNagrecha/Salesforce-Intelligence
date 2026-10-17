---
apiName: Status__c
apiVersion: null
id: CustomField:Project__c.Status__c
label: Status
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Picklist
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Status
  length: null
  picklistValues:
    - default: true
      isActive: true
      label: Draft
      value: Draft
    - default: false
      isActive: true
      label: Approved
      value: Approved
    - default: false
      isActive: true
      label: Permitting
      value: Permitting
    - default: false
      isActive: true
      label: Installing
      value: Installing
    - default: false
      isActive: true
      label: Complete
      value: Complete
    - default: false
      isActive: true
      label: Cancelled
      value: Cancelled
  precision: null
  referenceTo: null
  relationshipName: null
  required: false
  restricted: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/Status__c.field-meta.xml
type: CustomField
---

# Status

**API Name:** `Status__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Picklist` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `Draft, Approved, Permitting, Installing, Complete, Cancelled` |
| precision | `null` |
| referenceTo | `null` |
| relationshipName | `null` |
| required | `false` |
| restricted | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 4)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Project_Manager` | declared | permission-set-extractor |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### readsFrom (incoming, 5)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:IncentiveBatch` | parsed | apex-ast |
| `ApexClass:ProjectTriggerHandler` | parsed | apex-ast |
| `ApexClass:ProjectTriggerHandlerTest` | parsed | apex-ast |
| `ConditionalContext:Flow:Project_On_Approve.condition-0` | declared | condition-extractor |
| `ConditionalContext:ValidationRule:Project__c.Complete_Requires_Permit.condition-0` | parsed | condition-extractor |

### references (incoming, 5)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Is_Complete__c` | parsed | formula-tokenizer |
| `SharingRule:Project__c.Share_Projects_To_Ops` | declared | sharing-rule-extractor |
| `ValidationRule:Project__c.Complete_Requires_Permit` | parsed | formula-tokenizer |
| `ValidationRule:Project__c.Complete_Requires_Permit` | declared | validation-rule-extractor |
| `WaveXmd:Project_Pipeline` | declared | wave-xmd-extractor |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |

### writesTo (incoming, 3)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:ProjectTriggerHandlerTest` | parsed | apex-ast |
| `Flow:Installation_On_Complete` | parsed | flow-extractor |
| `LightningComponentBundle:projectSummaryCard` | declared | lwc-extractor |
