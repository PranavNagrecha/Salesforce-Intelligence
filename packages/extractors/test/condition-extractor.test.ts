/// <reference types="vitest/globals" />

import {
  extractConditions,
  type ConditionSource,
} from '../src/condition-extractor.js';

/**
 * v2.0a — Tests for the shared `extractConditions` helper.
 *
 * The helper is consumed by seven extractor extensions
 * (workflow-rule, validation-rule, approval-process, assignment-rule,
 * auto-response-rule, escalation-rule, flow); these tests cover the
 * helper's per-`ConditionSource` semantics in isolation so the
 * downstream extractor tests can focus on per-extractor wiring.
 */
describe('extractConditions', () => {
  const PARENT_ID = 'WorkflowRule:Account.Notify_Tier1';
  const PARENT_SOURCE = '/abs/Account.workflow-meta.xml';
  const PARENT_OBJECT = 'Account';

  describe('criteria-source kind', () => {
    it('emits one ConditionalContext + one firesWhen edge per criteria source', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'criteria',
          items: [
            { field: 'Account.Type', operation: 'equals', value: 'Tier 1' },
          ],
          booleanFilter: null,
        },
      ];
      const result = extractConditions({
        parentId: PARENT_ID,
        sources,
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      expect(result.conditionNodes).toHaveLength(1);
      expect(result.firesWhenEdges).toHaveLength(1);
      expect(result.conditionsMirror).toHaveLength(1);

      const node = result.conditionNodes[0]!;
      expect(node.id).toBe(
        'ConditionalContext:WorkflowRule:Account.Notify_Tier1.condition-0',
      );
      expect(node.type).toBe('ConditionalContext');
      expect(node.parentId).toBe(PARENT_ID);
      expect(node.sourcePath).toBe(PARENT_SOURCE);
      expect(node.properties).toEqual({
        kind: 'criteria',
        expression: 'Account.Type equals Tier 1',
        // The ConditionalContext node carries the canonical fieldRefs
        // array; the property mirror at conditionsMirror[] now mirrors
        // the same array per ConditionalContextSemantics.md.
        fieldRefs: ['CustomField:Account.Type'],
        synthesized: false,
        itemCount: 1,
        booleanFilter: null,
      });

      const edge = result.firesWhenEdges[0]!;
      expect(edge.edgeType).toBe('firesWhen');
      expect(edge.fromId).toBe(PARENT_ID);
      expect(edge.toId).toBe(node.id);
      expect(edge.confidence).toBe('declared');
      expect(edge.source).toBe('condition-extractor');
      expect(edge.properties).toEqual({ kind: 'criteria', conditionIndex: 0 });
    });

    it('joins multi-item criteria with default AND when booleanFilter is null', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'criteria',
          items: [
            { field: 'Account.Industry', operation: 'equals', value: 'Tech' },
            {
              field: 'Account.AnnualRevenue',
              operation: 'greaterThan',
              value: '1000000',
            },
          ],
          booleanFilter: null,
        },
      ];
      const result = extractConditions({
        parentId: PARENT_ID,
        sources,
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      expect(result.conditionNodes[0]!.properties.expression).toBe(
        'Account.Industry equals Tech AND Account.AnnualRevenue greaterThan 1000000',
      );
    });

    it('expands booleanFilter index-references into the rendered items', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'criteria',
          items: [
            {
              field: 'Account.Region__c',
              operation: 'equals',
              value: null,
            },
            {
              field: 'Account.BillingCountry',
              operation: 'notEqual',
              value: null,
            },
          ],
          booleanFilter: '1 OR 2',
        },
      ];
      const result = extractConditions({
        parentId: PARENT_ID,
        sources,
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      expect(result.conditionNodes[0]!.properties.expression).toBe(
        '(Account.Region__c equals) OR (Account.BillingCountry notEqual)',
      );
    });

    it('preserves dotted field paths and scopes single-segment names by parent', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'criteria',
          items: [
            { field: 'Industry', operation: 'equals', value: 'Tech' },
            {
              field: 'Account.Owner.Name',
              operation: 'equals',
              value: 'admin',
            },
          ],
          booleanFilter: null,
        },
      ];
      const result = extractConditions({
        parentId: PARENT_ID,
        sources,
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      expect(result.conditionNodes[0]!.properties.fieldRefs).toEqual([
        'CustomField:Account.Industry',
        'CustomField:Account.Owner.Name',
      ]);
    });
  });

  describe('$Record global resolution (P10-A3 phantom fix)', () => {
    const refsFor = (field: string, object: string | null): readonly string[] => {
      const result = extractConditions({
        parentId: 'Flow:Some_Record_Flow',
        sources: [
          {
            kind: 'criteria',
            items: [{ field, operation: 'equals', value: 'x' }],
            booleanFilter: null,
          },
        ],
        parentSourcePath: '/abs/Some_Record_Flow.flow-meta.xml',
        parentObjectApiName: object,
      });
      return result.conditionNodes[0]!.properties.fieldRefs as readonly string[];
    };

    it('resolves $Record.<field> to a real field on the flow start object', () => {
      // $Record IS the triggering record — not a phantom CustomField:$Record.*
      expect(refsFor('$Record.Status__c', 'Account')).toEqual([
        'CustomField:Account.Status__c',
      ]);
    });

    it('resolves $Record__Prior.<field> (the before-image) to the same object', () => {
      expect(refsFor('$Record__Prior.Status__c', 'Account')).toEqual([
        'CustomField:Account.Status__c',
      ]);
    });

    it('anchors a $Record cross-object path on the real object (no $Record prefix)', () => {
      expect(refsFor('$Record.Parent__r.Name', 'Account')).toEqual([
        'CustomField:Account.Parent__r.Name',
      ]);
    });

    it('leaves non-record globals ($User, $Organization) verbatim — not the flow object', () => {
      expect(refsFor('$User.Email', 'Account')).toEqual(['CustomField:$User.Email']);
      expect(refsFor('$Organization.Name', 'Account')).toEqual([
        'CustomField:$Organization.Name',
      ]);
    });

    it('keeps $Record verbatim when the flow has no record object context', () => {
      // A non-record flow (parentObjectApiName null) can\'t resolve $Record.
      expect(refsFor('$Record.Status__c', null)).toEqual([
        'CustomField:$Record.Status__c',
      ]);
    });
  });

  describe('formula-source kind', () => {
    it('emits a formula ConditionalContext with parsed confidence and tokenized field refs', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'formula',
          expression: 'AND(Amount > 100000, IsClosed = false)',
        },
      ];
      const result = extractConditions({
        parentId: PARENT_ID,
        sources,
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      expect(result.firesWhenEdges[0]!.confidence).toBe('parsed');
      expect(result.conditionNodes[0]!.properties.kind).toBe('formula');
      expect(result.conditionNodes[0]!.properties.fieldRefs).toEqual([
        'CustomField:Account.Amount',
        'CustomField:Account.IsClosed',
      ]);
    });

    it('returns an empty fieldRefs list when the tokenizer cannot parse the formula', () => {
      const sources: ConditionSource[] = [
        // Unbalanced paren — tokenizer returns err.
        { kind: 'formula', expression: 'IF(unclosed' },
      ];
      const result = extractConditions({
        parentId: PARENT_ID,
        sources,
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      expect(result.conditionNodes).toHaveLength(1);
      expect(result.conditionNodes[0]!.properties.fieldRefs).toEqual([]);
    });
  });

  describe('flow-decision-source kind', () => {
    it('emits a flow-decision ConditionalContext with declared confidence', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'flow-decision',
          conditions: [
            {
              field: '$Record.Status__c',
              operation: 'EqualTo',
              value: 'Approved',
            },
          ],
          conditionLogic: 'and',
        },
      ];
      const result = extractConditions({
        parentId: 'Flow:Set_Status',
        sources,
        parentSourcePath: '/abs/Set_Status.flow-meta.xml',
        parentObjectApiName: 'Opportunity',
      });
      expect(result.firesWhenEdges[0]!.confidence).toBe('declared');
      expect(result.firesWhenEdges[0]!.properties).toEqual({
        kind: 'flow-decision',
        conditionIndex: 0,
      });
      expect(result.conditionNodes[0]!.properties.kind).toBe('flow-decision');
      // `$Record.X` resolves to the flow's start object (P10-A3): `$Record` IS
      // the Opportunity-triggered record, so the ref is the real
      // CustomField:Opportunity.Status__c, not a phantom CustomField:$Record.*.
      expect(result.conditionNodes[0]!.properties.fieldRefs).toEqual([
        'CustomField:Opportunity.Status__c',
      ]);
    });
  });

  describe('flow-recordtrigger-source kind', () => {
    it('prefers filterFormula when both filters and filterFormula are present', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'flow-recordtrigger',
          filters: [
            { field: '$Record.Type', operation: 'EqualTo', value: 'A' },
          ],
          filterLogic: null,
          filterFormula: 'ISCHANGED($Record.Amount)',
        },
      ];
      const result = extractConditions({
        parentId: 'Flow:Watch_Amount',
        sources,
        parentSourcePath: '/abs/Watch_Amount.flow-meta.xml',
        parentObjectApiName: 'Opportunity',
      });
      const props = result.conditionNodes[0]!.properties;
      expect(props.expression).toBe('ISCHANGED($Record.Amount)');
      expect(props.kind).toBe('flow-recordtrigger');
      expect(props.mode).toBe('formula');
      expect(result.firesWhenEdges[0]!.confidence).toBe('parsed');
    });

    it('falls back to structured filters when filterFormula is null', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'flow-recordtrigger',
          filters: [
            { field: '$Record.Type', operation: 'EqualTo', value: 'A' },
          ],
          filterLogic: null,
          filterFormula: null,
        },
      ];
      const result = extractConditions({
        parentId: 'Flow:Watch_Type',
        sources,
        parentSourcePath: '/abs/Watch_Type.flow-meta.xml',
        parentObjectApiName: 'Opportunity',
      });
      expect(result.conditionNodes[0]!.properties.mode).toBe('criteria');
      expect(result.firesWhenEdges[0]!.confidence).toBe('declared');
    });
  });

  describe('multi-source emission', () => {
    it('emits N nodes / N edges / N mirror entries for N sources, source-order preserved', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'formula',
          expression: 'Amount > 0',
        },
        {
          kind: 'criteria',
          items: [{ field: 'Type', operation: 'equals', value: 'A' }],
          booleanFilter: null,
        },
      ];
      const result = extractConditions({
        parentId: PARENT_ID,
        sources,
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      expect(result.conditionNodes.map((n) => n.id)).toEqual([
        'ConditionalContext:WorkflowRule:Account.Notify_Tier1.condition-0',
        'ConditionalContext:WorkflowRule:Account.Notify_Tier1.condition-1',
      ]);
      expect(result.firesWhenEdges.map((e) => e.properties.conditionIndex)).toEqual([
        0, 1,
      ]);
      expect(result.conditionsMirror.map((m) => m.kind)).toEqual([
        'formula',
        'criteria',
      ]);
    });

    it('respects indexOffset for interleaved-source callers', () => {
      const result = extractConditions({
        parentId: PARENT_ID,
        sources: [
          {
            kind: 'criteria',
            items: [{ field: 'Type', operation: 'equals', value: 'A' }],
            booleanFilter: null,
          },
        ],
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
        indexOffset: 4,
      });
      expect(result.conditionNodes[0]!.id).toBe(
        'ConditionalContext:WorkflowRule:Account.Notify_Tier1.condition-4',
      );
      expect(result.firesWhenEdges[0]!.properties.conditionIndex).toBe(4);
    });

    it('returns empty arrays for an empty sources list', () => {
      const result = extractConditions({
        parentId: PARENT_ID,
        sources: [],
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      expect(result.conditionNodes).toEqual([]);
      expect(result.firesWhenEdges).toEqual([]);
      expect(result.conditionsMirror).toEqual([]);
    });
  });

  describe('synthetic id preserves the full parent id including suffixes', () => {
    it('preserves __mdt parent suffixes verbatim (no stripping)', () => {
      const result = extractConditions({
        parentId: 'ApprovalProcess:MyType__mdt.Some_Process',
        sources: [
          { kind: 'formula', expression: 'true' },
        ],
        parentSourcePath: '/abs/process.approvalProcess-meta.xml',
        parentObjectApiName: 'MyType__mdt',
      });
      expect(result.conditionNodes[0]!.id).toBe(
        'ConditionalContext:ApprovalProcess:MyType__mdt.Some_Process.condition-0',
      );
    });

    it('preserves __c parent suffixes verbatim', () => {
      const result = extractConditions({
        parentId: 'ValidationRule:MyObject__c.Some_Rule',
        sources: [
          { kind: 'formula', expression: 'true' },
        ],
        parentSourcePath: '/abs/rule.validationRule-meta.xml',
        parentObjectApiName: 'MyObject__c',
      });
      expect(result.conditionNodes[0]!.id).toBe(
        'ConditionalContext:ValidationRule:MyObject__c.Some_Rule.condition-0',
      );
    });
  });

  describe('label truncation', () => {
    it('truncates labels longer than 80 characters with an ellipsis', () => {
      const expression =
        'AND(Amount > 100000, IsClosed = false, Owner.Name = "verylongname", Region__c = "EMEA")';
      const result = extractConditions({
        parentId: PARENT_ID,
        sources: [{ kind: 'formula', expression }],
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      const label = result.conditionNodes[0]!.label;
      expect(label).not.toBeNull();
      expect(label!.length).toBeLessThanOrEqual(80);
      expect(label!.endsWith('…')).toBe(true);
    });

    it('normalizes multi-line whitespace in the label', () => {
      const expression = 'AND(\n  Amount > 0,\n  IsClosed = false\n)';
      const result = extractConditions({
        parentId: PARENT_ID,
        sources: [{ kind: 'formula', expression }],
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      // Label collapses runs of whitespace; properties.expression
      // preserves the original.
      expect(result.conditionNodes[0]!.label).not.toContain('\n');
      expect(result.conditionNodes[0]!.properties.expression).toBe(expression);
    });
  });
});
