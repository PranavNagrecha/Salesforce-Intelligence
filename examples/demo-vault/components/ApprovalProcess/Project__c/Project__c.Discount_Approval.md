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
  allowRecall: true
  allowedSubmitters:
    - name: null
      type: owner
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
  finalApprovalActions: []
  finalApprovalRecordLock: false
  finalRejectionActions: []
  finalRejectionRecordLock: false
  initialSubmissionActions: []
  nextAutomaticApprover: null
  recallActions: []
  recordEditability: AdminOnly
  stepCount: 1
  steps:
    - approvalActions: []
      approvers: "[{\"name\":null,\"type\":\"userHierarchyField\"}]"
      entryCriteriaFormula: null
      entryCriteriaItemCount: 0
      ifCriteriaNotMet: null
      label: Manager Approval
      name: step_1_manager
      rejectBehaviorType: null
      rejectionActions: []
      stepIndex: 0
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
| allowRecall | `true` |
| allowedSubmitters | `[object Object]` |
| conditions | `[object Object]` |
| defaultEmailTemplate | `null` |
| enableMobileDeviceAccess | `false` |
| entryCriteriaFormula | `null` |
| entryCriteriaItemCount | `1` |
| finalApprovalActions | `` |
| finalApprovalRecordLock | `false` |
| finalRejectionActions | `` |
| finalRejectionRecordLock | `false` |
| initialSubmissionActions | `` |
| nextAutomaticApprover | `null` |
| recallActions | `` |
| recordEditability | `AdminOnly` |
| stepCount | `1` |
| steps | `[object Object]` |

## Incident edges

### firesWhen (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ConditionalContext:ApprovalProcess:Project__c.Discount_Approval.condition-0` | declared | condition-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | approval-process-extractor |
