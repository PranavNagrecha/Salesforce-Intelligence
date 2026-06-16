/// <reference types="vitest/globals" />

import type { Node } from '@sf-intelligence/contracts';

import {
  isActiveSoeFirer,
  recordInactiveSoeFirer,
  skipInactiveSoeFirer,
  sortedInactiveConfigured,
} from '../../src/tools/soe-active.js';

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: 'Test',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

describe('isActiveSoeFirer', () => {
  it('treats only Active Flows as active', () => {
    expect(
      isActiveSoeFirer(
        makeNode({ id: 'Flow:A', type: 'Flow', properties: { status: 'Active' } }),
      ),
    ).toBe(true);
    expect(
      isActiveSoeFirer(
        makeNode({ id: 'Flow:D', type: 'Flow', properties: { status: 'Draft' } }),
      ),
    ).toBe(false);
    expect(
      isActiveSoeFirer(
        makeNode({ id: 'Flow:O', type: 'Flow', properties: { status: 'Obsolete' } }),
      ),
    ).toBe(false);
  });

  it('treats active:false rules as inactive', () => {
    expect(
      isActiveSoeFirer(
        makeNode({
          id: 'WorkflowRule:Obj.Rule',
          type: 'WorkflowRule',
          properties: { active: false },
        }),
      ),
    ).toBe(false);
    expect(
      isActiveSoeFirer(
        makeNode({
          id: 'ValidationRule:Obj.Rule',
          type: 'ValidationRule',
          properties: { active: false },
        }),
      ),
    ).toBe(false);
  });
});

describe('inactive collector', () => {
  it('dedupes and sorts inactive firers', () => {
    const collector = new Map();
    const draft = makeNode({
      id: 'Flow:DraftFlow',
      type: 'Flow',
      apiName: 'DraftFlow',
      properties: { status: 'Draft' },
    });
    expect(skipInactiveSoeFirer(collector, draft)).toBe(true);
    recordInactiveSoeFirer(collector, draft);
    expect(collector.size).toBe(1);
    expect(sortedInactiveConfigured(collector)).toEqual([
      {
        componentId: 'Flow:DraftFlow',
        componentType: 'Flow',
        apiName: 'DraftFlow',
        inactiveReason: 'status: Draft',
      },
    ]);
  });
});
