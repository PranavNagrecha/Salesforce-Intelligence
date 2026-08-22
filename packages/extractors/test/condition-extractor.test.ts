/// <reference types="vitest/globals" />

import type { ComponentId } from '@sf-intelligence/contracts';

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

    it('does not clobber a numeric criteria value that matches a later filter index (H11)', () => {
      // Canonical corruptor: the value `2` in row 1 equals the index of
      // row 2. The old iterative reduce re-scanned its own output, so
      // substituting index `2` clobbered BOTH the trailing `2` token AND
      // the `2` inside row 1's rendered value, producing the corrupted
      // `(Account.AnnualRevenue greaterThan (Account.Status equals Open))
      //  AND (Account.Status equals Open)`. The single non-overlapping
      // pass leaves the value untouched.
      const sources: ConditionSource[] = [
        {
          kind: 'criteria',
          items: [
            {
              field: 'Account.AnnualRevenue',
              operation: 'greaterThan',
              value: '2',
            },
            { field: 'Account.Status', operation: 'equals', value: 'Open' },
          ],
          booleanFilter: '1 AND 2',
        },
      ];
      const result = extractConditions({
        parentId: PARENT_ID,
        sources,
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      expect(result.conditionNodes[0]!.properties.expression).toBe(
        '(Account.AnnualRevenue greaterThan 2) AND (Account.Status equals Open)',
      );
    });

    it('does not clobber a MULTI-DIGIT value that matches a multi-digit filter index (H11)', () => {
      // Multi-digit corruptor: row 1's value `10` equals the index of
      // row 10. The old reduce substituted index `10` into both the
      // standalone `10` token AND the `10` inside row 1's value, yielding
      // `(Score equals (TEN)) AND (TEN)`. The single non-overlapping pass
      // keeps the value `10` literal.
      const items = Array.from({ length: 10 }, (_, idx) =>
        idx === 0
          ? { field: 'Account.Score', operation: 'equals', value: '10' }
          : {
              field: `Account.F${idx + 1}`,
              operation: 'equals',
              value: idx === 9 ? 'TEN' : `v${idx + 1}`,
            },
      );
      const result = extractConditions({
        parentId: PARENT_ID,
        sources: [{ kind: 'criteria', items, booleanFilter: '1 AND 10' }],
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      const expression = result.conditionNodes[0]!.properties.expression as string;
      expect(expression).toBe(
        '(Account.Score equals 10) AND (Account.F10 equals TEN)',
      );
      // Guard against the doubly-substituted corruption form.
      expect(expression).not.toContain('(Account.F10 equals TEN))');
    });

    it('substitutes nested-parenthesized index tokens correctly', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'criteria',
          items: [
            { field: 'Account.A', operation: 'equals', value: 'x' },
            { field: 'Account.B', operation: 'equals', value: 'y' },
            { field: 'Account.C', operation: 'equals', value: 'z' },
          ],
          booleanFilter: '(1 OR 2) AND 3',
        },
      ];
      const result = extractConditions({
        parentId: PARENT_ID,
        sources,
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      expect(result.conditionNodes[0]!.properties.expression).toBe(
        '((Account.A equals x) OR (Account.B equals y)) AND (Account.C equals z)',
      );
    });

    it('leaves an out-of-range index token literal (no throw, no "(undefined)")', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'criteria',
          items: [
            { field: 'Account.A', operation: 'equals', value: 'x' },
            { field: 'Account.B', operation: 'equals', value: 'y' },
          ],
          booleanFilter: '1 AND 4',
        },
      ];
      const result = extractConditions({
        parentId: PARENT_ID,
        sources,
        parentSourcePath: PARENT_SOURCE,
        parentObjectApiName: PARENT_OBJECT,
      });
      const expression = result.conditionNodes[0]!.properties.expression as string;
      expect(expression).toBe('(Account.A equals x) AND 4');
      expect(expression).not.toContain('(undefined)');
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
          sourceName: null,
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

    // BUG 6 — a bare `and` / `or` conditionLogic (the DEFAULT for every
    // Flow decision) carries no index tokens, so the old index-substitution
    // pass returned the keyword verbatim, rendering the predicate as the
    // literal word "and". The expression must be the real `field op value`.
    it('renders a bare `and` decision as the actual predicate, not the word "and" (BUG 6)', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'flow-decision',
          conditions: [
            { field: '$Record.Status__c', operation: 'EqualTo', value: 'Approved' },
          ],
          conditionLogic: 'and',
          sourceName: null,
        },
      ];
      const result = extractConditions({
        parentId: 'Flow:Set_Status',
        sources,
        parentSourcePath: '/abs/Set_Status.flow-meta.xml',
        parentObjectApiName: 'Opportunity',
      });
      expect(result.conditionNodes[0]!.properties.expression).toBe(
        '$Record.Status__c EqualTo Approved',
      );
      expect(result.conditionNodes[0]!.properties.expression).not.toBe('and');
    });

    it('joins multi-condition bare-`and` decisions with AND (BUG 6)', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'flow-decision',
          conditions: [
            { field: '$Record.Amount', operation: 'GreaterThan', value: '1000000' },
            { field: '$Record.Stage', operation: 'EqualTo', value: 'Negotiation' },
          ],
          conditionLogic: 'and',
          sourceName: null,
        },
      ];
      const result = extractConditions({
        parentId: 'Flow:Watch_Deal',
        sources,
        parentSourcePath: '/abs/Watch_Deal.flow-meta.xml',
        parentObjectApiName: 'Opportunity',
      });
      expect(result.conditionNodes[0]!.properties.expression).toBe(
        '$Record.Amount GreaterThan 1000000 AND $Record.Stage EqualTo Negotiation',
      );
    });

    it('joins multi-condition bare-`or` decisions with OR, case-insensitively (BUG 6)', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'flow-decision',
          conditions: [
            { field: '$Record.Type', operation: 'EqualTo', value: 'A' },
            { field: '$Record.Type', operation: 'EqualTo', value: 'B' },
          ],
          // Uppercase keyword must still take the join path (case-insensitive).
          conditionLogic: 'OR',
          sourceName: null,
        },
      ];
      const result = extractConditions({
        parentId: 'Flow:Type_Branch',
        sources,
        parentSourcePath: '/abs/Type_Branch.flow-meta.xml',
        parentObjectApiName: 'Opportunity',
      });
      expect(result.conditionNodes[0]!.properties.expression).toBe(
        '$Record.Type EqualTo A OR $Record.Type EqualTo B',
      );
    });

    it('still index-substitutes real custom conditionLogic (BUG 6 guard)', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'flow-decision',
          conditions: [
            { field: '$Record.A', operation: 'EqualTo', value: 'x' },
            { field: '$Record.B', operation: 'EqualTo', value: 'y' },
          ],
          conditionLogic: '1 OR 2',
          sourceName: null,
        },
      ];
      const result = extractConditions({
        parentId: 'Flow:Custom_Logic',
        sources,
        parentSourcePath: '/abs/Custom_Logic.flow-meta.xml',
        parentObjectApiName: 'Opportunity',
      });
      expect(result.conditionNodes[0]!.properties.expression).toBe(
        '($Record.A EqualTo x) OR ($Record.B EqualTo y)',
      );
    });

    // BUG 7 — the decision's real name must survive onto the node + mirror as
    // `sourceName`, so explain_flow can label the row with it instead of the
    // synthetic `condition-N` handle.
    it('threads the flow-decision sourceName onto the node properties and mirror (BUG 7)', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'flow-decision',
          conditions: [
            { field: '$Record.Status__c', operation: 'EqualTo', value: 'Approved' },
          ],
          conditionLogic: 'and',
          sourceName: 'My_Decision (My_Outcome)',
        },
      ];
      const result = extractConditions({
        parentId: 'Flow:Set_Status',
        sources,
        parentSourcePath: '/abs/Set_Status.flow-meta.xml',
        parentObjectApiName: 'Opportunity',
      });
      expect(result.conditionNodes[0]!.properties.sourceName).toBe(
        'My_Decision (My_Outcome)',
      );
      expect(result.conditionsMirror[0]!.sourceName).toBe(
        'My_Decision (My_Outcome)',
      );
      // The synthetic id is UNCHANGED — firesWhen edges + downstream ids still
      // resolve; only a NEW property was added.
      expect(result.conditionNodes[0]!.id).toBe(
        'ConditionalContext:Flow:Set_Status.condition-0',
      );
    });

    it('omits sourceName entirely when the flow-decision has no name (BUG 7)', () => {
      const sources: ConditionSource[] = [
        {
          kind: 'flow-decision',
          conditions: [
            { field: '$Record.Status__c', operation: 'EqualTo', value: 'Approved' },
          ],
          conditionLogic: 'and',
          sourceName: null,
        },
      ];
      const result = extractConditions({
        parentId: 'Flow:Set_Status',
        sources,
        parentSourcePath: '/abs/Set_Status.flow-meta.xml',
        parentObjectApiName: 'Opportunity',
      });
      expect('sourceName' in result.conditionNodes[0]!.properties).toBe(false);
      expect('sourceName' in result.conditionsMirror[0]!).toBe(false);
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

  describe('flow-recordtrigger filterFormula — $Record merge-field refs', () => {
    // A record-triggered Flow entry condition uses the MERGE dialect
    // (`{!$Record.Field__c}`). Before this fix the shared formula tokenizer
    // bucketed the `$Record.*` path onto its `globalReferences` channel
    // (never `references`), so the filterFormula path resolved EMPTY
    // fieldRefs despite clearly referencing the trigger object's fields —
    // starving the coupled-field-write JOIN of Flow firers. These tests
    // assert the merge refs now resolve against the trigger object.
    const refsFor = (
      filterFormula: string,
      triggerObject: string | null,
    ): readonly string[] => {
      const result = extractConditions({
        parentId: 'Flow:Entry_Cond',
        sources: [
          {
            kind: 'flow-recordtrigger',
            filters: [],
            filterLogic: null,
            filterFormula,
          },
        ],
        parentSourcePath: '/abs/Entry_Cond.flow-meta.xml',
        parentObjectApiName: triggerObject,
      });
      return result.conditionNodes[0]!.properties.fieldRefs as readonly string[];
    };

    it('resolves a wrapped {!$Record.Field} merge ref to a trigger-object field', () => {
      // Was [] before the fix (tokenizer put $Record on globalReferences).
      expect(
        refsFor('NOT(ISBLANK({!$Record.SomeField__c}))', 'Ns__Obj__c'),
      ).toEqual(['CustomField:Ns__Obj__c.SomeField__c']);
    });

    it('resolves the $Record field inside ISPICKVAL with a string arg', () => {
      expect(
        refsFor("ISPICKVAL({!$Record.Status__c},'Submitted')", 'Ns__Obj__c'),
      ).toEqual(['CustomField:Ns__Obj__c.Status__c']);
    });

    it('resolves a bare (unwrapped) $Record.Field merge ref too', () => {
      // Some entry formulas appear bare (e.g. inside ISCHANGED); handle both.
      expect(refsFor('ISCHANGED($Record.Amount__c)', 'Ns__Obj__c')).toEqual([
        'CustomField:Ns__Obj__c.Amount__c',
      ]);
    });

    it('resolves $Record__Prior.<field> (the before-image) to the same object', () => {
      expect(
        refsFor('{!$Record__Prior.Stage__c} <> {!$Record.Stage__c}', 'Ns__Obj__c'),
      ).toEqual(['CustomField:Ns__Obj__c.Stage__c']);
    });

    it('dedups multiple references to the same field, preserving first order', () => {
      expect(
        refsFor(
          'AND(NOT(ISBLANK({!$Record.A__c})), {!$Record.B__c} > 0, {!$Record.A__c} <> "x")',
          'Ns__Obj__c',
        ),
      ).toEqual(['CustomField:Ns__Obj__c.A__c', 'CustomField:Ns__Obj__c.B__c']);
    });

    it('anchors a cross-object {!$Record.Rel__r.Field} path on the trigger object (not dropped)', () => {
      // resolveRecordGlobalField supports the dotted path, so we resolve it
      // rather than preserving verbatim — the cross-object nav is kept.
      expect(
        refsFor('NOT(ISBLANK({!$Record.Account__r.Name}))', 'Ns__Obj__c'),
      ).toEqual(['CustomField:Ns__Obj__c.Account__r.Name']);
    });

    it('preserves $Record verbatim when the flow has no trigger-object context', () => {
      // Null object context can\'t resolve $Record — keep it, do NOT drop.
      expect(
        refsFor('NOT(ISBLANK({!$Record.SomeField__c}))', null),
      ).toEqual(['CustomField:$Record.SomeField__c']);
    });

    it('returns [] for a filterFormula with no $Record reference', () => {
      // A global-only formula ($User is not the trigger record) resolves to
      // no trigger-object fields.
      expect(refsFor('NOT(ISBLANK({!$User.Email}))', 'Ns__Obj__c')).toEqual([]);
    });

    it('returns [] (no throw) for a malformed formula with no $Record ref', () => {
      // Regex extraction cannot throw the way tokenizing can — a broken
      // formula with no $Record ref simply yields no refs.
      expect(refsFor('NOT(ISBLANK(', 'Ns__Obj__c')).toEqual([]);
      expect(refsFor('', 'Ns__Obj__c')).toEqual([]);
    });

    it('sets parsed confidence and formula mode on the filterFormula path', () => {
      const result = extractConditions({
        parentId: 'Flow:Entry_Cond',
        sources: [
          {
            kind: 'flow-recordtrigger',
            filters: [],
            filterLogic: null,
            filterFormula: 'NOT(ISBLANK({!$Record.SomeField__c}))',
          },
        ],
        parentSourcePath: '/abs/Entry_Cond.flow-meta.xml',
        parentObjectApiName: 'Ns__Obj__c',
      });
      expect(result.conditionNodes[0]!.properties.mode).toBe('formula');
      expect(result.firesWhenEdges[0]!.confidence).toBe('parsed');
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

describe('condition field edges are minted only for structurally valid field ids', () => {
  /**
   * Found by probing a real vault: making condition fieldRefs into EDGES turned
   * things that are not fields into graph phantoms — 71 distinct bare Flow
   * variable / choice names (`AnotherSubmission`, `ChoiceRenameOrDelete`), an
   * unresolved `$Record`, and 87 multi-dot relationship traversals. As an inert
   * node property they were harmless; as edges they pollute the phantom roll-up,
   * and the taxonomy labels a bare PascalCase name a standard FIELD and offers a
   * "treat it as a standard field" remedy for a Flow variable.
   *
   * fieldRefs keeps every ref verbatim — the JOIN rules read it. Only the edges
   * are filtered.
   */
  it('drops bare names, globals and multi-dot traversals from edges but keeps them in fieldRefs', () => {
    const result = extractConditions({
      parentId: 'Flow:Some_Flow' as ComponentId,
      parentSourcePath: 'flows/Some_Flow.flow-meta.xml',
      parentObjectApiName: null,
      sources: [
        {
          kind: 'criteria',
          items: [
            { field: 'Widget__c.Status__c', operation: 'equals', value: 'Open' },
            { field: 'AnotherSubmission', operation: 'equals', value: 'true' },
            { field: '$Record', operation: 'equals', value: 'x' },
            {
              field: 'Widget__c.Parent__r.Code__c',
              operation: 'equals',
              value: 'A',
            },
          ],
          booleanFilter: null,
        },
      ],
    });

    // Every ref is still recorded verbatim — the honest account of what the
    // condition mentions.
    const refs = result.conditionsMirror[0]?.fieldRefs ?? [];
    expect(refs.length).toBe(4);

    // Only the one well-formed Object.Field id becomes an edge.
    expect(result.conditionFieldEdges.map((e) => e.toId)).toEqual([
      'CustomField:Widget__c.Status__c',
    ]);
    expect(result.conditionFieldEdges[0]?.edgeType).toBe('readsFrom');
  });
});

/**
 * FIX 15 (1) — `CustomField:<Rel>__r.<Field>__c` names no node and NO refresh on
 * any org could ever create it: a Salesforce object api name never ends in
 * `__r`. Minting it as a `readsFrom` edge published a citable component id for a
 * component that does not exist, and — worse — the REAL field it traverses to
 * gained no incoming edge at all, so `safe_to_delete_field` (a pure
 * `listEdges(field, 'in')` composition) certified a read field as deletable.
 *
 * The extractor cannot resolve the traversal itself: `extractConditions` is a
 * per-file function whose only object context is `parentObjectApiName`, and
 * knowing which object `<Rel>__r` reaches needs every object's lookup fields at
 * once. So it PARKS the verbatim path plus the resolution base on the node, and
 * `mintRelationshipTraversalEdges` in `@sf-intelligence/graph` resolves it into
 * a `readsFrom` onto the real `CustomField:` node — or drops it.
 *
 * INVARIANT PINNED BY THIS BLOCK: `properties.fieldRefs` is unchanged and
 * verbatim. It is the honest record of what the condition MENTIONS and the
 * multi-edge JOIN rules read it; the defect was republishing it as citable
 * component ids, not recording it.
 */
describe('FIX 15 — relationship-shaped refs are parked, never minted as edges', () => {
  const FLOW_ID = 'Flow:Enrolment_Guard' as ComponentId;
  const FLOW_SOURCE = 'flows/Enrolment_Guard.flow-meta.xml';

  const oneCriteriaSource = (
    fields: readonly string[],
  ): readonly ConditionSource[] => [
    {
      kind: 'criteria',
      items: fields.map((field) => ({
        field,
        operation: 'equals',
        value: 'x',
      })),
      booleanFilter: null,
    },
  ];

  it('mints NO readsFrom edge to CustomField:<Rel>__r.<Field>__c', () => {
    const result = extractConditions({
      parentId: FLOW_ID,
      parentSourcePath: FLOW_SOURCE,
      parentObjectApiName: 'Enrolment__c',
      sources: oneCriteriaSource(['Programme__r.Outcome__c']),
    });

    expect(result.conditionFieldEdges.map((e) => e.toId)).not.toContain(
      'CustomField:Programme__r.Outcome__c',
    );
    // Nothing else takes its place either — the extractor resolves nothing.
    expect(result.conditionFieldEdges).toEqual([]);
  });

  it('parks the VERBATIM dotted path on properties.unresolvedTraversalRefs', () => {
    const result = extractConditions({
      parentId: FLOW_ID,
      parentSourcePath: FLOW_SOURCE,
      parentObjectApiName: 'Enrolment__c',
      sources: oneCriteriaSource(['Programme__r.Outcome__c']),
    });

    expect(
      result.conditionNodes[0]!.properties['unresolvedTraversalRefs'],
    ).toEqual(['Programme__r.Outcome__c']);
  });

  it('parks the parent object as properties.objectApiName (the resolution base)', () => {
    const result = extractConditions({
      parentId: FLOW_ID,
      parentSourcePath: FLOW_SOURCE,
      parentObjectApiName: 'Enrolment__c',
      sources: oneCriteriaSource(['Programme__r.Outcome__c']),
    });

    expect(result.conditionNodes[0]!.properties['objectApiName']).toBe(
      'Enrolment__c',
    );
  });

  it('STILL records the ref verbatim in properties.fieldRefs (honest record preserved)', () => {
    const result = extractConditions({
      parentId: FLOW_ID,
      parentSourcePath: FLOW_SOURCE,
      parentObjectApiName: 'Enrolment__c',
      sources: oneCriteriaSource(['Programme__r.Outcome__c']),
    });

    expect(result.conditionNodes[0]!.properties.fieldRefs).toEqual([
      'CustomField:Programme__r.Outcome__c',
    ]);
    expect(result.conditionsMirror[0]!.fieldRefs).toEqual([
      'CustomField:Programme__r.Outcome__c',
    ]);
  });

  it('NO-REGRESSION: a same-object ref still mints its edge exactly as before', () => {
    const result = extractConditions({
      parentId: FLOW_ID,
      parentSourcePath: FLOW_SOURCE,
      parentObjectApiName: 'Enrolment__c',
      sources: oneCriteriaSource(['Outcome__c', 'Programme__r.Outcome__c']),
    });

    // Exactly one edge: the same-object field. The traversal mints none.
    expect(result.conditionFieldEdges.length).toBe(1);
    expect(result.conditionFieldEdges[0]!.toId).toBe(
      'CustomField:Enrolment__c.Outcome__c',
    );
    expect(result.conditionFieldEdges[0]!.edgeType).toBe('readsFrom');
    expect(result.conditionFieldEdges[0]!.confidence).toBe('declared');
    expect(result.conditionFieldEdges[0]!.fromId).toBe(
      'ConditionalContext:Flow:Enrolment_Guard.condition-0',
    );
    // Both refs stay verbatim in fieldRefs, in source order.
    expect(result.conditionNodes[0]!.properties.fieldRefs).toEqual([
      'CustomField:Enrolment__c.Outcome__c',
      'CustomField:Programme__r.Outcome__c',
    ]);
  });

  it('omits BOTH keys when the condition names no traversal (absent = checked, not empty)', () => {
    const result = extractConditions({
      parentId: FLOW_ID,
      parentSourcePath: FLOW_SOURCE,
      parentObjectApiName: 'Enrolment__c',
      sources: oneCriteriaSource(['Outcome__c']),
    });

    const props = result.conditionNodes[0]!.properties;
    expect('unresolvedTraversalRefs' in props).toBe(false);
    expect('objectApiName' in props).toBe(false);
  });

  it('walks MULTI-HOP paths to the resolver verbatim (resolveTraversalTarget handles them)', () => {
    const result = extractConditions({
      parentId: FLOW_ID,
      parentSourcePath: FLOW_SOURCE,
      parentObjectApiName: 'Enrolment__c',
      sources: oneCriteriaSource(['Programme__r.Faculty__r.Code__c']),
    });

    expect(result.conditionFieldEdges).toEqual([]);
    expect(
      result.conditionNodes[0]!.properties['unresolvedTraversalRefs'],
    ).toEqual(['Programme__r.Faculty__r.Code__c']);
  });

  it('objectApiName is explicit null — never a fabricated base — with no object context', () => {
    const result = extractConditions({
      parentId: FLOW_ID,
      parentSourcePath: FLOW_SOURCE,
      parentObjectApiName: null,
      sources: oneCriteriaSource(['Programme__r.Outcome__c']),
    });

    const props = result.conditionNodes[0]!.properties;
    expect(props['unresolvedTraversalRefs']).toEqual([
      'Programme__r.Outcome__c',
    ]);
    // null, not omitted and not a string: the base is UNKNOWN, so the graph
    // resolver's `typeof owningObject === 'string'` guard mints nothing.
    expect('objectApiName' in props).toBe(true);
    expect(props['objectApiName']).toBeNull();
  });

  it('dedups repeated traversals, preserving first-occurrence order', () => {
    const result = extractConditions({
      parentId: FLOW_ID,
      parentSourcePath: FLOW_SOURCE,
      parentObjectApiName: 'Enrolment__c',
      sources: oneCriteriaSource([
        'Programme__r.Outcome__c',
        'Faculty__r.Code__c',
        'Programme__r.Outcome__c',
      ]),
    });

    expect(
      result.conditionNodes[0]!.properties['unresolvedTraversalRefs'],
    ).toEqual(['Programme__r.Outcome__c', 'Faculty__r.Code__c']);
  });

  it('an OBJECT-segment ref that merely CONTAINS __r is untouched (suffix test, not substring)', () => {
    const result = extractConditions({
      parentId: FLOW_ID,
      parentSourcePath: FLOW_SOURCE,
      parentObjectApiName: 'Enrolment__c',
      sources: oneCriteriaSource(['Programme__rc__c.Outcome__c']),
    });

    expect(result.conditionFieldEdges.map((e) => e.toId)).toEqual([
      'CustomField:Programme__rc__c.Outcome__c',
    ]);
    expect(
      'unresolvedTraversalRefs' in result.conditionNodes[0]!.properties,
    ).toBe(false);
  });

  it('applies to the FORMULA surface too (validation-rule condition), at parsed confidence', () => {
    const result = extractConditions({
      parentId: 'ValidationRule:Enrolment__c.Guard' as ComponentId,
      parentSourcePath: 'objects/Enrolment__c/Enrolment__c.object-meta.xml',
      parentObjectApiName: 'Enrolment__c',
      sources: [
        {
          kind: 'formula',
          expression: 'ISBLANK(Programme__r.Outcome__c)',
        },
      ],
    });

    expect(result.conditionNodes[0]!.properties.fieldRefs).toEqual([
      'CustomField:Programme__r.Outcome__c',
    ]);
    expect(result.conditionFieldEdges).toEqual([]);
    expect(
      result.conditionNodes[0]!.properties['unresolvedTraversalRefs'],
    ).toEqual(['Programme__r.Outcome__c']);
    expect(result.conditionNodes[0]!.properties['objectApiName']).toBe(
      'Enrolment__c',
    );
  });
});
