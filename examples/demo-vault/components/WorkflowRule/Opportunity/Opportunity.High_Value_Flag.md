---
apiName: Opportunity.High_Value_Flag
apiVersion: null
id: WorkflowRule:Opportunity.High_Value_Flag
label: High_Value_Flag
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Opportunity
properties:
  actionCount: 1
  active: true
  booleanFilter: null
  conditions:
    - conditionContextId: ConditionalContext:WorkflowRule:Opportunity.High_Value_Flag.condition-0
      expression: "Amount > 100000"
      fieldRefs:
        - CustomField:Opportunity.Amount
      kind: formula
  criteriaItemCount: 0
  description: "Flag opportunities over 100,000 for executive review (legacy workflow rule, kept for order-of-execution demo)."
  formula: "Amount > 100000"
  triggerType: onCreateOrTriggeringUpdate
sourcePath: source/main/default/workflows/Opportunity.workflow-meta.xml
type: WorkflowRule
---

# High_Value_Flag

**API Name:** `Opportunity.High_Value_Flag`  
**Type:** WorkflowRule

Flag opportunities over 100,000 for executive review (legacy workflow rule, kept for order-of-execution demo).

## Properties

| Key | Value |
| --- | --- |
| actionCount | `1` |
| active | `true` |
| booleanFilter | `null` |
| conditions | `[object Object]` |
| criteriaItemCount | `0` |
| formula | `Amount > 100000` |
| triggerType | `onCreateOrTriggeringUpdate` |

## Incident edges

### firesWhen (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ConditionalContext:WorkflowRule:Opportunity.High_Value_Flag.condition-0` | parsed | condition-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Opportunity` | declared | workflow-rule-extractor |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `WorkflowFieldUpdate:Opportunity.Flag_As_High_Value` | declared | workflow-rule-extractor |

### triggersOn (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Opportunity` | declared | workflow-rule-extractor |

### writesTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Opportunity.Description` | parsed | workflow-rule-extractor |
