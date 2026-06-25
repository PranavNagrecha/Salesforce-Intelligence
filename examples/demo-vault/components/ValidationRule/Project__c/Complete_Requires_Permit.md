---
apiName: Complete_Requires_Permit
apiVersion: null
id: ValidationRule:Project__c.Complete_Requires_Permit
label: Complete_Requires_Permit
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  active: true
  conditions:
    - conditionContextId: ConditionalContext:ValidationRule:Project__c.Complete_Requires_Permit.condition-0
      expression: "ISPICKVAL(Status__c,\"Complete\") && NOT(Permit_Approved__c)"
      fieldRefs:
        - CustomField:Project__c.Status__c
        - CustomField:Project__c.Permit_Approved__c
      kind: formula
  description: A project cannot be marked Complete unless its permit has been approved.
  errorConditionFormula: "ISPICKVAL(Status__c,\"Complete\") && NOT(Permit_Approved__c)"
  errorDisplayField: Status__c
  errorMessage: You cannot set Status to Complete until the permit is approved (Permit Approved must be checked).
sourcePath: source/main/default/objects/Project__c/validationRules/Complete_Requires_Permit.validationRule-meta.xml
type: ValidationRule
---

# Complete_Requires_Permit

**API Name:** `Complete_Requires_Permit`  
**Type:** ValidationRule

A project cannot be marked Complete unless its permit has been approved.

## Properties

| Key | Value |
| --- | --- |
| active | `true` |
| conditions | `[object Object]` |
| errorConditionFormula | `ISPICKVAL(Status__c,"Complete") && NOT(Permit_Approved__c)` |
| errorDisplayField | `Status__c` |
| errorMessage | `You cannot set Status to Complete until the permit is approved (Permit Approved must be checked).` |

## Incident edges

### firesWhen (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ConditionalContext:ValidationRule:Project__c.Complete_Requires_Permit.condition-0` | parsed | condition-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | validation-rule-extractor |

### references (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Permit_Approved__c` | parsed | formula-tokenizer |
| `CustomField:Project__c.Status__c` | parsed | formula-tokenizer |
