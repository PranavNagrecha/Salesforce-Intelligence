---
apiName: Project__c.Discount_Approval
apiVersion: null
id: ApprovalProcess:Project__c.Discount_Approval
label: Discount Approval
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  active: true
  conditions:
    - conditionContextId: ConditionalContext:ApprovalProcess:Project__c.Discount_Approval.condition-0
      expression: Project__c.Contract_Value__c greaterThan 50000
      fieldRefs:
        - CustomField:Project__c.Contract_Value__c
      kind: criteria
  defaultEmailTemplate: null
  description: "High-value Projects (Contract Value over 50,000) require manager approval before proceeding."
  enableMobileDeviceAccess: false
  entryCriteriaFormula: null
  entryCriteriaItemCount: 1
  nextAutomaticApprover: null
  recordEditability: AdminOnly
  stepCount: 1
sourcePath: source/main/default/approvalProcesses/Project__c.Discount_Approval.approvalProcess-meta.xml
type: ApprovalProcess
---

# Discount Approval

**API Name:** `Project__c.Discount_Approval`  
**Type:** ApprovalProcess

High-value Projects (Contract Value over 50,000) require manager approval before proceeding.

## Properties

| Key | Value |
| --- | --- |
| active | `true` |
| conditions | `[object Object]` |
| defaultEmailTemplate | `null` |
| enableMobileDeviceAccess | `false` |
| entryCriteriaFormula | `null` |
| entryCriteriaItemCount | `1` |
| nextAutomaticApprover | `null` |
| recordEditability | `AdminOnly` |
| stepCount | `1` |

## Incident edges

### firesWhen (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ConditionalContext:ApprovalProcess:Project__c.Discount_Approval.condition-0` | declared | condition-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | approval-process-extractor |
