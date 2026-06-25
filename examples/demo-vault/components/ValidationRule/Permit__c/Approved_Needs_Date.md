---
apiName: Approved_Needs_Date
apiVersion: null
id: ValidationRule:Permit__c.Approved_Needs_Date
label: Approved_Needs_Date
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Permit__c
properties:
  active: true
  conditions:
    - conditionContextId: ConditionalContext:ValidationRule:Permit__c.Approved_Needs_Date.condition-0
      expression: "ISPICKVAL(Status__c,\"Approved\") && ISBLANK(Approved_Date__c)"
      fieldRefs:
        - CustomField:Permit__c.Status__c
        - CustomField:Permit__c.Approved_Date__c
      kind: formula
  description: An approved permit must record the date it was approved.
  errorConditionFormula: "ISPICKVAL(Status__c,\"Approved\") && ISBLANK(Approved_Date__c)"
  errorDisplayField: Approved_Date__c
  errorMessage: "When a permit Status is Approved, the Approved Date is required."
sourcePath: source/main/default/objects/Permit__c/validationRules/Approved_Needs_Date.validationRule-meta.xml
type: ValidationRule
---

# Approved_Needs_Date

**API Name:** `Approved_Needs_Date`  
**Type:** ValidationRule

An approved permit must record the date it was approved.

## Properties

| Key | Value |
| --- | --- |
| active | `true` |
| conditions | `[object Object]` |
| errorConditionFormula | `ISPICKVAL(Status__c,"Approved") && ISBLANK(Approved_Date__c)` |
| errorDisplayField | `Approved_Date__c` |
| errorMessage | `When a permit Status is Approved, the Approved Date is required.` |

## Incident edges

### firesWhen (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ConditionalContext:ValidationRule:Permit__c.Approved_Needs_Date.condition-0` | parsed | condition-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Permit__c` | declared | validation-rule-extractor |

### references (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Permit__c.Approved_Date__c` | parsed | formula-tokenizer |
| `CustomField:Permit__c.Status__c` | parsed | formula-tokenizer |
