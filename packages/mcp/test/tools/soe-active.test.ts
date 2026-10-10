/// <reference types="vitest/globals" />

import type { Node } from '@sf-intelligence/contracts';

import {
  buildInactiveSummary,
  INACTIVE_NAMES_CAP,
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

  it('respects active:false on Assignment / AutoResponse / Escalation rules (they each emit an `active` boolean)', () => {
    // These three rule types carry a required `<active>` element (see the
    // extractors) just like the workflow/validation/approval trio. The reasoning
    // engine's coupled-field-write liveness gate relies on the shared predicate
    // marking a provably-inactive one of them as inactive.
    for (const type of ['AssignmentRule', 'AutoResponseRule', 'EscalationRule'] as const) {
      expect(
        isActiveSoeFirer(makeNode({ id: `${type}:Case.Rule`, type, properties: { active: false } })),
      ).toBe(false);
      expect(
        isActiveSoeFirer(makeNode({ id: `${type}:Case.Rule`, type, properties: { active: true } })),
      ).toBe(true);
      // Missing `active` defaults to live (conservative prior).
      expect(
        isActiveSoeFirer(makeNode({ id: `${type}:Case.Legacy`, type, properties: {} })),
      ).toBe(true);
    }
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

describe('buildInactiveSummary names', () => {
  // FAIL-BEFORE/PASS-AFTER: the default (roster omitted) summary carried only
  // counts, so "which automations on this object look relevant but do not run"
  // could not be answered without a second call the host rarely makes.
  it('names each inactive component even when the roster is omitted', () => {
    const collector = new Map();
    recordInactiveSoeFirer(
      collector,
      makeNode({ id: 'Flow:Invoice_Draft_Flow', type: 'Flow', apiName: 'Invoice_Draft_Flow', properties: { status: 'Draft' } }),
    );
    recordInactiveSoeFirer(
      collector,
      makeNode({ id: 'WorkflowRule:Invoice__c.Old_Rule', type: 'WorkflowRule', apiName: 'Invoice__c.Old_Rule', properties: { active: false } }),
    );
    const summary = buildInactiveSummary(sortedInactiveConfigured(collector), false, false);
    expect(summary.included).toBe(false);
    expect(summary.names).toEqual([
      'Flow:Invoice_Draft_Flow (status: Draft)',
      'WorkflowRule:Invoice__c.Old_Rule (active: false)',
    ]);
    expect(summary.namesTruncated).toBe(false);
  });

  it('caps the names list and says so', () => {
    const collector = new Map();
    for (let i = 0; i < INACTIVE_NAMES_CAP + 3; i += 1) {
      const name = `Flow_${String(i).padStart(2, '0')}`;
      recordInactiveSoeFirer(
        collector,
        makeNode({ id: `Flow:${name}`, type: 'Flow', apiName: name, properties: { status: 'Obsolete' } }),
      );
    }
    const summary = buildInactiveSummary(sortedInactiveConfigured(collector), false, false);
    expect(summary.total).toBe(INACTIVE_NAMES_CAP + 3);
    expect(summary.names).toHaveLength(INACTIVE_NAMES_CAP);
    expect(summary.namesTruncated).toBe(true);
  });
});
