/// <reference types="vitest/globals" />

import { buildReferencesEdges } from '../src/formula-references.js';

/**
 * `buildReferencesEdges` is the shared formula/reference scanner used by the
 * ValidationRule (errorConditionFormula) and CustomField (`<formula>`)
 * extractors. These guards pin its edge output — in particular the
 * `$Permission.{ApiName}` → `CustomPermission:{ApiName}` wiring (the guard for
 * CUSTOM-PERMISSION-DOLLAR-PERMISSION-UNGRAPHED). All identifiers are
 * synthetic.
 */
describe('buildReferencesEdges — $Permission custom-permission gate', () => {
  it('emits a CustomPermission reference edge for a $Permission.X formula gate (regression guard)', () => {
    // A ValidationRule errorConditionFormula that fires unless the running user
    // holds a custom permission — the canonical guard shape.
    const edges = buildReferencesEdges(
      'NOT($Permission.My_Custom_Perm)',
      'ValidationRule:Widget__c.Guarded_Rule',
      'Widget__c',
      'errorConditionFormula',
    );
    expect(edges).toEqual([
      {
        fromId: 'ValidationRule:Widget__c.Guarded_Rule',
        toId: 'CustomPermission:My_Custom_Perm',
        edgeType: 'references',
        confidence: 'parsed',
        source: 'formula-tokenizer',
        properties: {
          tokenizedFromField: 'errorConditionFormula',
          formulaLength: 'NOT($Permission.My_Custom_Perm)'.length,
          referenceKind: 'customPermission',
        },
      },
    ]);
  });

  it('wires BOTH field references and the $Permission gate from one formula', () => {
    const formula = 'AND(ISBLANK(Status__c), NOT($Permission.Skip_Widget_Validation))';
    const edges = buildReferencesEdges(
      formula,
      'ValidationRule:Widget__c.Status_Rule',
      'Widget__c',
      'errorConditionFormula',
    );
    // CustomField edge(s) sort before CustomPermission edge(s) ('F' < 'P').
    expect(edges.map((e) => e.toId)).toEqual([
      'CustomField:Widget__c.Status__c',
      'CustomPermission:Skip_Widget_Validation',
    ]);
    const permEdge = edges.find((e) => e.toId.startsWith('CustomPermission:'));
    expect(permEdge?.edgeType).toBe('references');
    expect(permEdge?.confidence).toBe('parsed');
    expect(permEdge?.properties['referenceKind']).toBe('customPermission');
  });

  it('deduplicates repeated $Permission.X references to a single edge', () => {
    const edges = buildReferencesEdges(
      'OR($Permission.My_Custom_Perm, NOT($Permission.My_Custom_Perm))',
      'CustomField:Widget__c.Guard__c',
      'Widget__c',
      'formula',
    );
    const permEdges = edges.filter((e) => e.toId.startsWith('CustomPermission:'));
    expect(permEdges).toHaveLength(1);
    expect(permEdges[0]?.toId).toBe('CustomPermission:My_Custom_Perm');
  });

  it('does NOT mint CustomPermission edges for other $Variable globals ($User/$Profile/$Setup/$Label)', () => {
    const edges = buildReferencesEdges(
      'IF($User.IsActive, $Profile.Name, $Setup.My_Setting__c.Val__c) & $Label.Some_Label',
      'CustomField:Widget__c.Computed__c',
      'Widget__c',
      'formula',
    );
    expect(edges.filter((e) => e.toId.startsWith('CustomPermission:'))).toEqual([]);
  });

  it('does NOT mint an edge from a multi-segment $Permission path (conservative anchor)', () => {
    // A deeper `$Permission.X.Y` shape (not the formula custom-permission form)
    // must NOT mis-capture the inner segment as a permission ApiName.
    const edges = buildReferencesEdges(
      '$Permission.CustomPermission.My_Custom_Perm',
      'CustomField:Widget__c.Computed__c',
      'Widget__c',
      'formula',
    );
    expect(edges.filter((e) => e.toId.startsWith('CustomPermission:'))).toEqual([]);
  });
});
