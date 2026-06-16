/// <reference types="vitest/globals" />

import type { ComponentId, ComponentType, Node } from '@sf-intelligence/contracts';

import {
  soundnessFromNodes,
  soundnessFromDynamicApexIds,
} from '../../src/tools/soundness.js';

/** Minimal Apex node; `qualityIssues` carries the persisted dynamic-apex signal. */
const apexNode = (id: string, qualityIssues: unknown[]): Node => ({
  id: id as ComponentId,
  type: 'ApexClass' as ComponentType,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: `src/${id}.cls`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { qualityIssues },
});

const DYNAMIC_ISSUE = { rule: 'dynamic-apex', severity: 'info', location: 'line 4', explanation: 'x', confidence: 'heuristic' };
const SOQL_LOOP_ISSUE = { rule: 'soql-in-loop', severity: 'high', location: 'line 9', explanation: 'y', confidence: 'heuristic' };

describe('soundnessFromNodes', () => {
  it('is complete when no node carries the dynamic-apex signal', () => {
    const s = soundnessFromNodes([apexNode('ApexClass:Clean', [SOQL_LOOP_ISSUE]), apexNode('ApexClass:Bare', [])]);
    expect(s.complete).toBe(true);
    expect(s.blindSpots).toEqual([]);
    expect(s.staticCoverage).toBe('full');
  });

  it('is INCOMPLETE with a dynamic-apex blind spot when a node uses dynamic Apex', () => {
    const s = soundnessFromNodes([
      apexNode('ApexClass:Dyn', [DYNAMIC_ISSUE]),
      apexNode('ApexClass:Clean', [SOQL_LOOP_ISSUE]),
    ]);
    expect(s.complete).toBe(false);
    expect(s.staticCoverage).toBe('partial');
    expect(s.blindSpots).toHaveLength(1);
    expect(s.blindSpots[0]?.kind).toBe('dynamic-apex');
    expect(s.blindSpots[0]?.componentIds).toEqual(['ApexClass:Dyn']);
    expect(s.blindSpots[0]?.note).toMatch(/dynamic Apex/i);
  });

  it('lists every dynamic class, sorted + de-duplicated, with a canonical componentIds key', () => {
    const s = soundnessFromNodes([
      apexNode('ApexClass:Zed', [DYNAMIC_ISSUE]),
      apexNode('ApexClass:Abe', [DYNAMIC_ISSUE]),
      apexNode('ApexClass:Abe', [DYNAMIC_ISSUE]),
    ]);
    expect(s.blindSpots[0]?.componentIds).toEqual(['ApexClass:Abe', 'ApexClass:Zed']);
    // canonical id key only — never `id`/`classId`
    expect(Object.keys(s.blindSpots[0] ?? {})).toContain('componentIds');
  });

  it('treats a missing/garbled qualityIssues property as no blind spot (best-effort)', () => {
    const weird: Node = { ...apexNode('ApexClass:X', []), properties: { qualityIssues: 'not-an-array' } };
    expect(soundnessFromNodes([weird]).complete).toBe(true);
  });
});

describe('soundnessFromDynamicApexIds', () => {
  it('empty → complete; non-empty → partial with those ids', () => {
    expect(soundnessFromDynamicApexIds([]).complete).toBe(true);
    const s = soundnessFromDynamicApexIds(['ApexClass:A' as ComponentId, 'ApexClass:A' as ComponentId]);
    expect(s.complete).toBe(false);
    expect(s.blindSpots[0]?.componentIds).toEqual(['ApexClass:A']);
  });
});
