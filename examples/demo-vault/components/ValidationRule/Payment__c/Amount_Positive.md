---
apiName: Amount_Positive
apiVersion: null
id: ValidationRule:Payment__c.Amount_Positive
label: Amount_Positive
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Payment__c
properties:
  active: true
  conditions:
    - conditionContextId: ConditionalContext:ValidationRule:Payment__c.Amount_Positive.condition-0
      expression: Amount__c <= 0
      fieldRefs:
        - CustomField:Payment__c.Amount__c
      kind: formula
  description: A payment amount must be greater than zero.
  errorConditionFormula: Amount__c <= 0
  errorDisplayField: Amount__c
  errorMessage: Payment Amount must be greater than zero.
sourcePath: source/main/default/objects/Payment__c/validationRules/Amount_Positive.validationRule-meta.xml
type: ValidationRule
---

# Amount_Positive

**API Name:** `Amount_Positive`  
**Type:** ValidationRule

A payment amount must be greater than zero.

## Properties

| Key | Value |
| --- | --- |
| active | `true` |
| conditions | `[object Object]` |
| errorConditionFormula | `Amount__c <= 0` |
| errorDisplayField | `Amount__c` |
| errorMessage | `Payment Amount must be greater than zero.` |

## Incident edges

### firesWhen (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ConditionalContext:ValidationRule:Payment__c.Amount_Positive.condition-0` | parsed | condition-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Payment__c` | declared | validation-rule-extractor |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Payment__c.Amount__c` | parsed | formula-tokenizer |
