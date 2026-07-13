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

  it('respects ApexTrigger.status — Inactive is excluded, Active is included', () => {
    // The extractor emits status: Active | Inactive from the trigger XML.
    // An Inactive trigger must not appear in the active SOE steps; without this
    // check the inactive trigger inflates the after-triggers count on dense
    // standard objects (e.g. Contact) that have deactivated legacy triggers.
    expect(
      isActiveSoeFirer(
        makeNode({
          id: 'ApexTrigger:ContactTrigger',
          type: 'ApexTrigger',
          properties: { status: 'Active', events: ['after insert', 'after update'] },
        }),
      ),
    ).toBe(true);
    expect(
      isActiveSoeFirer(
        makeNode({
          id: 'ApexTrigger:InactiveLegacyTrigger',
          type: 'ApexTrigger',
          properties: { status: 'Inactive', events: ['after insert'] },
        }),
      ),
    ).toBe(false);
    // Missing status is treated as active (conservative prior for older vault data).
    expect(
      isActiveSoeFirer(
        makeNode({
          id: 'ApexTrigger:LegacyTrigger',
          type: 'ApexTrigger',
          properties: { events: ['after insert'] },
        }),
      ),
    ).toBe(true);
  });

  it('respects DuplicateRule.isActive — false is excluded, true is included, missing defaults active', () => {
    // DuplicateRule carries its own `<isActive>` XML element, distinct from the
    // `active` boolean the workflow/validation/approval trio use.
    expect(
      isActiveSoeFirer(
        makeNode({
          id: 'DuplicateRule:Account.Block_Domain_Dupes',
          type: 'DuplicateRule',
          properties: { isActive: true },
        }),
      ),
    ).toBe(true);
    expect(
      isActiveSoeFirer(
        makeNode({
          id: 'DuplicateRule:Account.Retired_Rule',
          type: 'DuplicateRule',
          properties: { isActive: false },
        }),
      ),
    ).toBe(false);
    expect(
      isActiveSoeFirer(
        makeNode({
          id: 'DuplicateRule:Account.LegacyRule',
          type: 'DuplicateRule',
          properties: {},
        }),
      ),
    ).toBe(true);
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

  it('records an inactive DuplicateRule with the isActive: false reason', () => {
    const collector = new Map();
    const inactiveRule = makeNode({
      id: 'DuplicateRule:Account.Retired_Rule',
      type: 'DuplicateRule',
      apiName: 'Account.Retired_Rule',
      properties: { isActive: false },
    });
    expect(skipInactiveSoeFirer(collector, inactiveRule)).toBe(true);
    expect(sortedInactiveConfigured(collector)).toEqual([
      {
        componentId: 'DuplicateRule:Account.Retired_Rule',
        componentType: 'DuplicateRule',
        apiName: 'Account.Retired_Rule',
        inactiveReason: 'isActive: false',
      },
    ]);
  });
});
