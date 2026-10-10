/**
 * FAIL-BEFORE/PASS-AFTER — a component writing one field in several places
 * shares ONE graph key `(from, to, type, source)`; the first-writer-wins import
 * kept only the first edge's value. The merge folds every value into it.
 */
import type { Edge } from '@sf-intelligence/contracts';
import { describe, expect, it } from 'vitest';

import { edgeValueTiming, foldWriteValueEdges, mergeWriteValueEdges } from '../src/write-values.js';

const w = (properties: Record<string, unknown>, o: Partial<Edge> = {}): Edge => ({
  fromId: 'ApprovalProcess:Ticket__c.Review',
  toId: 'CustomField:Ticket__c.Status__c',
  edgeType: 'writesTo',
  confidence: 'parsed',
  source: 'approval-process-extractor',
  properties,
  ...o,
});

describe('mergeWriteValueEdges', () => {
  it('folds every literal, source, and kind of one graph key into the first edge', () => {
    const edges = [
      w({ hookType: 'initialSubmission', assignedValue: 'New', assignedValueKind: 'literal' }),
      w({ hookType: 'finalApproval', assignedValue: 'Closed', assignedValueKind: 'literal' }),
      w({ hookType: 'finalRejection', assignedValue: 'PRIORVALUE(Status__c)', assignedValueKind: 'formula' }),
    ];
    mergeWriteValueEdges(edges);
    expect(edges[0]?.properties).toMatchObject({
      hookType: 'initialSubmission',
      literalValues: ['New', 'Closed'],
      referenceValues: ['PRIORVALUE(Status__c)'],
      valueKinds: ['literal', 'formula'],
    });
  });

  it('leaves a single edge, other sources, and non-write edges untouched', () => {
    const single = w({ assignedValue: 'New', assignedValueKind: 'literal' });
    const other = w({ assignedValue: 'Closed', assignedValueKind: 'literal' }, { source: 'workflow-rule-extractor' });
    const read = w({ filterValue: 'X', filterValueKind: 'literal' }, { edgeType: 'readsFrom' });
    const edges = [single, other, read, { ...read }];
    mergeWriteValueEdges(edges);
    expect(edges[0]).toBe(single);
    expect(edges[1]).toBe(other);
    expect(edges[2]).toBe(read);
  });

  it('marks a key whose later edge states no value as partly unstated', () => {
    const edges = [w({ assignedValue: 'New', assignedValueKind: 'literal' }), w({})];
    mergeWriteValueEdges(edges);
    expect(edges[0]?.properties['valueKinds']).toEqual(['literal', 'unstated']);
  });
});

describe('mergeWriteValueEdges — no-value groups', () => {
  it('leaves a key whose edges state no value untouched (no valueKinds noise)', () => {
    const a = w({ operation: 'recordCreate' });
    const edges = [a, w({ operation: 'recordDelete' })];
    mergeWriteValueEdges(edges);
    expect(edges[0]).toBe(a);
    expect(edges[0]?.properties['valueKinds']).toBeUndefined();
  });
});

describe('mergeWriteValueEdges — time-triggered timing', () => {
  const rule = { fromId: 'WorkflowRule:Ticket__c.Expire', source: 'workflow-rule-extractor' };

  it('keeps which value a time trigger writes when an immediate and a timed update share a key', () => {
    const out = foldWriteValueEdges([
      w({ assignedValue: 'Pending', assignedValueKind: 'literal' }, rule),
      w({ assignedValue: 'Expired', assignedValueKind: 'literal', timeTriggered: true }, rule),
    ]);
    expect(out).toHaveLength(1);
    const edge = out[0] as Edge;
    expect(edge.properties['literalValues']).toEqual(['Pending', 'Expired']);
    expect(edgeValueTiming(edge)).toEqual({
      timeTriggered: 'partly',
      timeTriggeredValues: ['Expired'],
      immediateValues: ['Pending'],
    });
  });

  it('drops a first-edge timeTriggered flag when a later edge writes in the save', () => {
    const edges = [
      w({ assignedValue: 'Expired', assignedValueKind: 'literal', timeTriggered: true }, rule),
      w({ assignedValue: 'Pending', assignedValueKind: 'literal' }, rule),
    ];
    mergeWriteValueEdges(edges);
    expect(edges[0]?.properties['timeTriggered']).toBeUndefined();
    expect(edgeValueTiming(edges[0] as Edge).timeTriggered).toBe('partly');
  });

  it('reads an all-timed or untimed edge as such', () => {
    expect(edgeValueTiming(w({ timeTriggered: true })).timeTriggered).toBe('all');
    expect(edgeValueTiming(w({})).timeTriggered).toBe('none');
  });
});

describe('foldWriteValueEdges', () => {
  it('returns one write edge per key carrying every value', () => {
    const out = foldWriteValueEdges([
      w({ assignedValue: 'New', assignedValueKind: 'literal' }),
      w({ assignedValue: 'Closed', assignedValueKind: 'literal' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.properties['literalValues']).toEqual(['New', 'Closed']);
  });
});
