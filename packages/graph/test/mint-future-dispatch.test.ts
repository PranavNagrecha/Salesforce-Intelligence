/// <reference types="vitest/globals" />

import type { Edge, Node } from '@sf-intelligence/contracts';

import { mintFutureDispatchEdges } from '../src/import.js';

const makeClass = (apiName: string, hasFutureMethod = false): Node => ({
  id: `ApexClass:${apiName}`,
  type: 'ApexClass',
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: 'x.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { hasFutureMethod },
});

const makeTrigger = (apiName: string, hasFutureMethod = false): Node => ({
  id: `ApexTrigger:${apiName}`,
  type: 'ApexTrigger',
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: 'x.trigger',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { hasFutureMethod },
});

const callsApex = (from: string, to: string, methods: string[]): Edge => ({
  fromId: from,
  toId: to,
  edgeType: 'callsApex',
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: { methods, methodName: methods[0] ?? '' },
});

const dispatchesOf = (edges: readonly Edge[], from: string): readonly Edge[] =>
  edges.filter((e) => e.edgeType === 'dispatchesAsync' && e.fromId === from);

describe('mintFutureDispatchEdges — CR-CAP-09', () => {
  it('mints exactly one heuristic class-granular dispatchesAsync edge when the target class has a @future method', () => {
    const nodes = [makeClass('ClassA'), makeClass('ClassB', true)];
    const edges: Edge[] = [
      callsApex('ApexClass:ClassA', 'ApexClass:ClassB', ['futureMethod']),
    ];
    mintFutureDispatchEdges(nodes, edges);
    const minted = dispatchesOf(edges, 'ApexClass:ClassA');
    expect(minted).toHaveLength(1);
    const e = minted[0]!;
    expect(e.toId).toBe('ApexClass:ClassB');
    expect(e.confidence).toBe('heuristic');
    expect(e.properties['dispatchMechanism']).toBe('future');
    expect(e.properties['granularity']).toBe('class');
  });

  it('does NOT mint when the target class has no @future method (synchronous helper)', () => {
    const nodes = [makeClass('ClassC'), makeClass('ClassD', false)];
    const edges: Edge[] = [
      callsApex('ApexClass:ClassC', 'ApexClass:ClassD', ['run']),
    ];
    mintFutureDispatchEdges(nodes, edges);
    expect(dispatchesOf(edges, 'ApexClass:ClassC')).toHaveLength(0);
  });

  it('does NOT double-mint when a declared inline-constructor dispatchesAsync already exists for (from,to)', () => {
    const nodes = [makeClass('ClassA'), makeClass('ClassB', true)];
    const edges: Edge[] = [
      // declared inline-constructor edge (e.g. System.enqueueJob(new ClassB()))
      {
        fromId: 'ApexClass:ClassA',
        toId: 'ApexClass:ClassB',
        edgeType: 'dispatchesAsync',
        confidence: 'declared',
        source: 'apex-class',
        properties: { dispatchMechanism: 'enqueueJob' },
      },
      // ALSO calls a @future method of the same target
      callsApex('ApexClass:ClassA', 'ApexClass:ClassB', ['futureMethod']),
    ];
    mintFutureDispatchEdges(nodes, edges);
    const dispatches = dispatchesOf(edges, 'ApexClass:ClassA');
    expect(dispatches).toHaveLength(1);
    // The surviving edge is the declared inline-constructor one, NOT downgraded.
    expect(dispatches[0]!.confidence).toBe('declared');
    expect(dispatches[0]!.properties['dispatchMechanism']).toBe('enqueueJob');
  });

  it('does NOT mint for ApexTrigger targets (triggers cannot hold @future)', () => {
    // A trigger node mislabeled with hasFutureMethod=true must be ignored —
    // the future-set is guarded to ApexClass nodes only.
    const nodes = [makeClass('ClassE'), makeTrigger('SomeTrigger', true)];
    const edges: Edge[] = [
      callsApex('ApexClass:ClassE', 'ApexTrigger:SomeTrigger', ['x']),
    ];
    mintFutureDispatchEdges(nodes, edges);
    expect(dispatchesOf(edges, 'ApexClass:ClassE')).toHaveLength(0);
  });
});
