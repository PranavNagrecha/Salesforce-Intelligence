/// <reference types="vitest/globals" />

import type { Edge, Node } from '@sf-intelligence/contracts';

import { canonicalizeApexCallEdgeTargets } from '../src/import.js';

const makeClass = (apiName: string): Node => ({
  id: `ApexClass:${apiName}`,
  type: 'ApexClass',
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: 'x.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

describe('canonicalizeApexCallEdgeTargets — GRF-01', () => {
  it('rewrites callsApex targets to the vaulted class id casing', () => {
    const nodes = [makeClass('pkb_Controller'), makeClass('Caller')];
    const edges: Edge[] = [
      {
        fromId: 'ApexClass:Caller',
        toId: 'ApexClass:pkb_controller',
        edgeType: 'callsApex',
        confidence: 'heuristic',
        source: 'apex-scanner',
        properties: {},
      },
    ];
    canonicalizeApexCallEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('ApexClass:pkb_Controller');
  });
});
