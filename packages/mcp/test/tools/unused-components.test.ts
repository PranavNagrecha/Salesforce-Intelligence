/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  unusedComponentsHandler,
  unusedComponentsInputSchema,
} from '../../src/tools/unused-components.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    ApexClass: 4,
    EmailTemplate: 3,
    GlobalValueSet: 1,
    CustomLabel: 1,
  },
  edges: { callsApex: 1 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Unused',
  label: null,
  parentId: null,
  sourcePath: 'unused.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Default edge-shape helper. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seeds. Graph holds:
//   - ApexClass:OrphanLogic — no incoming edges -> unused
//   - ApexClass:UsedLogic — has a callsApex incoming -> used
//   - ApexClass:OrphanTest — isTest=true, no callers -> EXEMPT, not unused
//   - ApexClass:UsedCaller — calls into UsedLogic (so it's the caller),
//     no incoming edges of its own -> unused
//   - EmailTemplate:Welcome, EmailTemplate:Goodbye, EmailTemplate:Used
//     where Welcome and Goodbye have no incoming edges -> both unused;
//     Used has a sendsEmail incoming -> used
//   - GlobalValueSet:OrphanSet — no incoming -> unused
//   - CustomLabel:OrphanLabel — no incoming -> unused
// =============================================================================

const ORPHAN_APEX = 'ApexClass:OrphanLogic';
const USED_APEX = 'ApexClass:UsedLogic';
const ORPHAN_TEST = 'ApexClass:OrphanTest';
const USED_CALLER = 'ApexClass:UsedCaller';

const apexSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: ORPHAN_APEX, apiName: 'OrphanLogic' }),
    makeNode({ id: USED_APEX, apiName: 'UsedLogic' }),
    makeNode({
      id: ORPHAN_TEST,
      apiName: 'OrphanTest',
      properties: { isTest: true },
    }),
    makeNode({ id: USED_CALLER, apiName: 'UsedCaller' }),
  ],
  edges: [
    // UsedCaller -> UsedLogic via callsApex. UsedLogic now has one
    // incoming non-parentOf edge; UsedCaller has none.
    makeEdge({
      fromId: USED_CALLER,
      toId: USED_APEX,
      edgeType: 'callsApex',
      source: 'apex-scanner',
    }),
  ],
};

const ORPHAN_TEMPLATE_A = 'EmailTemplate:WelcomeMessage';
const ORPHAN_TEMPLATE_B = 'EmailTemplate:Goodbye';
const USED_TEMPLATE = 'EmailTemplate:Used';
const WORKFLOW_RULE_ID = 'WorkflowRule:Account.SendNotification';

const emailSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ORPHAN_TEMPLATE_A,
      type: 'EmailTemplate',
      apiName: 'WelcomeMessage',
      label: 'Welcome Message',
    }),
    makeNode({
      id: ORPHAN_TEMPLATE_B,
      type: 'EmailTemplate',
      apiName: 'Goodbye',
    }),
    makeNode({
      id: USED_TEMPLATE,
      type: 'EmailTemplate',
      apiName: 'Used',
    }),
    makeNode({
      id: WORKFLOW_RULE_ID,
      type: 'WorkflowRule',
      apiName: 'Account.SendNotification',
    }),
  ],
  edges: [
    makeEdge({
      fromId: WORKFLOW_RULE_ID,
      toId: USED_TEMPLATE,
      edgeType: 'sendsEmail',
    }),
  ],
};

const ORPHAN_VALUE_SET = 'GlobalValueSet:OrphanSet';
const ORPHAN_LABEL = 'CustomLabel:OrphanLabel';
const labelsAndValueSetSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ORPHAN_VALUE_SET,
      type: 'GlobalValueSet',
      apiName: 'OrphanSet',
    }),
    makeNode({
      id: ORPHAN_LABEL,
      type: 'CustomLabel',
      apiName: 'OrphanLabel',
    }),
  ],
  edges: [],
};

// Entry-point components (Flow / ApexTrigger / ValidationRule). These fire on
// their own and carry no incoming edges; only the INACTIVE ones are "unused".
const ACTIVE_FLOW = 'Flow:ActiveRecordTriggered';
const OBSOLETE_FLOW = 'Flow:ObsoleteVersion';
const ACTIVE_TRIGGER = 'ApexTrigger:AccountTrigger';
const INACTIVE_TRIGGER = 'ApexTrigger:LegacyTrigger';
const ACTIVE_VR = 'ValidationRule:Account.RequireField';
const INACTIVE_VR = 'ValidationRule:Account.OldRule';
const entryPointSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACTIVE_FLOW, type: 'Flow', apiName: 'ActiveRecordTriggered', properties: { status: 'Active' } }),
    makeNode({ id: OBSOLETE_FLOW, type: 'Flow', apiName: 'ObsoleteVersion', properties: { status: 'Obsolete' } }),
    makeNode({ id: ACTIVE_TRIGGER, type: 'ApexTrigger', apiName: 'AccountTrigger', properties: { status: 'Active' } }),
    makeNode({ id: INACTIVE_TRIGGER, type: 'ApexTrigger', apiName: 'LegacyTrigger', properties: { status: 'Inactive' } }),
    makeNode({ id: ACTIVE_VR, type: 'ValidationRule', apiName: 'Account.RequireField', properties: { active: true } }),
    makeNode({ id: INACTIVE_VR, type: 'ValidationRule', apiName: 'Account.OldRule', properties: { active: false } }),
  ],
  edges: [],
};

// One shared graph store + Context across the suite.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-unused-components-'));
  const dbPath = join(tempDir, 'unused-components.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    apexSeed,
    emailSeed,
    labelsAndValueSetSeed,
    entryPointSeed,
  ]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('unusedComponentsHandler', () => {
  it('returns an empty list when types narrows to a type with no nodes', async () => {
    const result = await unusedComponentsHandler(ctx, {
      types: ['Letterhead'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.components).toEqual([]);
    expect(result.value.data.byType['Letterhead']).toBe(0);
    expect(result.value.data.truncated).toBe(false);
    // VaultState comes from the manifest.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('reports an orphan ApexClass and excludes the one with a caller', async () => {
    const result = await unusedComponentsHandler(ctx, {
      types: ['ApexClass'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.components.map((c) => c.id);
    expect(ids).toContain(ORPHAN_APEX);
    expect(ids).toContain(USED_CALLER);
    expect(ids).not.toContain(USED_APEX);
  });

  it('EXEMPTS test ApexClasses (isTest=true) from the unused list even with no callers', async () => {
    const result = await unusedComponentsHandler(ctx, {
      types: ['ApexClass'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.components.map((c) => c.id);
    // ORPHAN_TEST has no callers but must NOT appear because
    // isTest=true exempts it from the unused list.
    expect(ids).not.toContain(ORPHAN_TEST);
    // The byType counter must also reflect the exemption (not include
    // the exempted test class in the count).
    expect(result.value.data.byType['ApexClass']).toBe(2); // OrphanLogic + UsedCaller
  });

  it('flags unused EmailTemplates and skips one with a sendsEmail incoming', async () => {
    const result = await unusedComponentsHandler(ctx, {
      types: ['EmailTemplate'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.components.map((c) => c.id);
    expect(ids.sort()).toEqual([ORPHAN_TEMPLATE_B, ORPHAN_TEMPLATE_A]);
    expect(ids).not.toContain(USED_TEMPLATE);
    expect(result.value.data.byType['EmailTemplate']).toBe(2);
  });

  it('attaches a per-type invisibleReferencesNote that warns about runtime references', async () => {
    const result = await unusedComponentsHandler(ctx, {
      types: ['EmailTemplate'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.data.components[0];
    expect(entry).toBeDefined();
    expect(entry?.invisibleReferencesNote.length).toBeGreaterThan(20);
    // The EmailTemplate note specifically calls out alert references.
    expect(entry?.invisibleReferencesNote).toMatch(/alert|template|Email/i);
  });

  it('attaches a per-type invisibleReferencesNote with PermissionSet-specific text for that type', async () => {
    // Default types include PermissionSet; the type has no instances
    // here so the count is 0 but the note must still be addressable
    // for documentation. Explicitly scan ApexClass to get one entry
    // whose note we can inspect.
    const result = await unusedComponentsHandler(ctx, {
      types: ['ApexClass'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.data.components.find((c) => c.id === ORPHAN_APEX);
    expect(entry).toBeDefined();
    expect(entry?.invisibleReferencesNote).toMatch(
      /Dynamic Apex|reflective|Tooling API/,
    );
  });

  it("groups multi-type results by type ASC and id ASC", async () => {
    const result = await unusedComponentsHandler(ctx, {
      types: ['EmailTemplate', 'ApexClass'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.components.map((c) => c.id);
    // ApexClass entries come first (A < E in ASC type sort), then
    // EmailTemplate entries; within each type the ids sort ASC.
    expect(ids).toEqual([
      ORPHAN_APEX,
      USED_CALLER,
      ORPHAN_TEMPLATE_B, // EmailTemplate:Goodbye
      ORPHAN_TEMPLATE_A, // EmailTemplate:WelcomeMessage
    ]);
  });

  it('truncates the global list to limit and sets truncated=true', async () => {
    // Scan all the types that have unused entries. We've seeded:
    //   ApexClass:OrphanLogic, ApexClass:UsedCaller (2)
    //   EmailTemplate:WelcomeMessage, EmailTemplate:Goodbye (2)
    //   GlobalValueSet:OrphanSet (1)
    //   CustomLabel:OrphanLabel (1)
    // Total = 6. With limit=3 we expect truncated=true and 3 entries.
    const result = await unusedComponentsHandler(ctx, {
      types: ['ApexClass', 'EmailTemplate', 'GlobalValueSet', 'CustomLabel'],
      limit: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.components.length).toBe(3);
    expect(result.value.data.truncated).toBe(true);
    // byType counts are FULL counts, not the truncated slice.
    expect(result.value.data.byType['ApexClass']).toBe(2);
    expect(result.value.data.byType['EmailTemplate']).toBe(2);
    expect(result.value.data.byType['GlobalValueSet']).toBe(1);
    expect(result.value.data.byType['CustomLabel']).toBe(1);
  });

  it('uses the curated default types when the caller omits types', async () => {
    // The default set includes EmailTemplate and ApexClass; without
    // narrowing, every unused entry should appear (including the
    // labels/value sets we seeded). Validate by checking a known id
    // and the per-type count.
    const result = await unusedComponentsHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.components.map((c) => c.id);
    expect(ids).toContain(ORPHAN_APEX);
    expect(ids).toContain(ORPHAN_TEMPLATE_A);
    expect(ids).toContain(ORPHAN_VALUE_SET);
    expect(ids).toContain(ORPHAN_LABEL);
    expect(ids).not.toContain(ORPHAN_TEST);
    expect(ids).not.toContain(USED_APEX);
    expect(ids).not.toContain(USED_TEMPLATE);
  });

  it('handles an empty types array by returning empty result with truncated=false', async () => {
    const result = await unusedComponentsHandler(ctx, { types: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.components).toEqual([]);
    expect(Object.keys(result.value.data.byType)).toEqual([]);
    expect(result.value.data.truncated).toBe(false);
  });

  it('F7: grantedBy (profile access grant) is NOT usage — a granted-but-unreferenced class is unused', async () => {
    // Dedicated store so the shared apexSeed exact-order assertions stay intact.
    const dir = mkdtempSync(join(tmpdir(), 'sfi-uc-f7-'));
    const opened = await openGraph(join(dir, 'f7.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const seed: ExtractionResult = {
        nodes: [
          makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
          makeNode({ id: 'ApexClass:GrantedOnlyLogic', apiName: 'GrantedOnlyLogic' }),
          makeNode({ id: 'ApexClass:ReferencedLogic', apiName: 'ReferencedLogic' }),
        ],
        edges: [
          // Profile grants Apex-class access (grantedBy) — ACCESS, not usage.
          makeEdge({
            fromId: 'Profile:Admin',
            toId: 'ApexClass:GrantedOnlyLogic',
            edgeType: 'grantedBy',
            source: 'profile-extractor',
          }),
          // A real caller → ReferencedLogic is genuinely used.
          makeEdge({
            fromId: 'ApexClass:GrantedOnlyLogic',
            toId: 'ApexClass:ReferencedLogic',
            edgeType: 'callsApex',
            source: 'apex-scanner',
          }),
        ],
      };
      const imp = await importExtractionResults(s, [seed]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
      const result = await unusedComponentsHandler(localCtx, {
        types: ['ApexClass'],
        limit: 50,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ids = result.value.data.components.map((c) => c.id);
      // The class whose ONLY incoming edge is a profile access grant IS unused.
      expect(ids).toContain('ApexClass:GrantedOnlyLogic');
      // The class with a real inbound callsApex is NOT unused.
      expect(ids).not.toContain('ApexClass:ReferencedLogic');
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unusedComponentsHandler — entry-point types', () => {
  it('does NOT flag active Flows / triggers / validation rules even with no incoming edges', async () => {
    const result = await unusedComponentsHandler(ctx, {
      types: ['Flow', 'ApexTrigger', 'ValidationRule'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.components.map((c) => c.id);
    expect(ids).not.toContain(ACTIVE_FLOW);
    expect(ids).not.toContain(ACTIVE_TRIGGER);
    expect(ids).not.toContain(ACTIVE_VR);
  });

  it('flags only INACTIVE entry-point components as unused', async () => {
    const result = await unusedComponentsHandler(ctx, {
      types: ['Flow', 'ApexTrigger', 'ValidationRule'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.components.map((c) => c.id);
    expect(ids).toContain(OBSOLETE_FLOW);
    expect(ids).toContain(INACTIVE_TRIGGER);
    expect(ids).toContain(INACTIVE_VR);
    // byType reflects only the inactive ones (1 each), not the active.
    expect(result.value.data.byType['Flow']).toBe(1);
    expect(result.value.data.byType['ApexTrigger']).toBe(1);
    expect(result.value.data.byType['ValidationRule']).toBe(1);
  });
});

// =============================================================================
// CR-12 — page-to-exhaustion. scanType walks each type to the end, not just the
// first page. The `unused` verdict is destructive and byType is a tally, so an
// unused node sorted PAST the cap by id ASC used to be dropped (and byType
// saturated at the cap). With SFI_NODE_SCAN_LIMIT=2 the offset loop walks
// multiple pages. Uses a dedicated store so the shared exact-order assertions
// stay intact.
// =============================================================================
describe('unusedComponentsHandler — past-cap byType + enumeration (CR-12 de-cap)', () => {
  beforeEach(() => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '2';
  });

  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('enumerates an unused node past the cap and reports the FULL byType count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-uc-pastcap-'));
    const opened = await openGraph(join(dir, 'pastcap.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      // 4 ApexClasses, all unused (no incoming edges). id-ASC: Aaa, Bbb, Ccc,
      // Zzz — with a cap of 2 the single-page code saw only Aaa/Bbb, so Ccc/Zzz
      // were dropped and byType saturated at 2.
      const seed: ExtractionResult = {
        nodes: [
          makeNode({ id: 'ApexClass:Aaa', apiName: 'Aaa' }),
          makeNode({ id: 'ApexClass:Bbb', apiName: 'Bbb' }),
          makeNode({ id: 'ApexClass:Ccc', apiName: 'Ccc' }),
          makeNode({ id: 'ApexClass:Zzz', apiName: 'Zzz' }),
        ],
        edges: [],
      };
      const imp = await importExtractionResults(s, [seed]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = {
        vaultRoot: dir,
        manifest: FIXTURE_MANIFEST,
        graph: s,
      };
      const result = await unusedComponentsHandler(localCtx, {
        types: ['ApexClass'],
        limit: 50,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ids = result.value.data.components.map((c) => c.id);
      // The past-cap unused class must appear, and byType must be the FULL 4.
      expect(ids).toContain('ApexClass:Zzz');
      expect(ids).toContain('ApexClass:Ccc');
      expect(result.value.data.byType['ApexClass']).toBe(4);
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unusedComponentsInputSchema', () => {
  it('accepts an empty input (defaults applied at handler)', () => {
    const parsed = unusedComponentsInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('accepts a well-formed types array', () => {
    const parsed = unusedComponentsInputSchema.safeParse({
      types: ['EmailTemplate'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown type', () => {
    const parsed = unusedComponentsInputSchema.safeParse({
      types: ['NotARealType'],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a limit above 500', () => {
    const parsed = unusedComponentsInputSchema.safeParse({ limit: 501 });
    expect(parsed.success).toBe(false);
  });

  it('rejects limit=0', () => {
    const parsed = unusedComponentsInputSchema.safeParse({ limit: 0 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const parsed = unusedComponentsInputSchema.safeParse({ limit: 1.5 });
    expect(parsed.success).toBe(false);
  });

  it('accepts the empty types array (filter to nothing)', () => {
    const parsed = unusedComponentsInputSchema.safeParse({ types: [] });
    expect(parsed.success).toBe(true);
  });
});

describe('unusedComponentsHandler — coverage caveat (P13-STAGED-absence-battery)', () => {
  const completeCoverage = (): VaultManifest => ({
    ...FIXTURE_MANIFEST,
    coverage: [
      'ApexClass', 'ApexTrigger', 'AuraDefinitionBundle', 'CompactLayout',
      'Dashboard', 'EmailTemplate', 'FieldSet', 'FlexiPage', 'Flow', 'Layout',
      'LightningComponentBundle', 'ListView', 'QuickAction', 'Report',
      'SharingRule', 'ValidationRule', 'VisualforceComponent',
      'VisualforcePage', 'WorkflowRule',
    ].map((type) => ({
      type, requested: true, retrieved: 1, errored: false, neverModeled: false,
    })),
  });

  it('carries an unknown-coverage caveat when the manifest has no coverage rows', async () => {
    const result = await unusedComponentsHandler(ctx, { types: ['ApexClass'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.coverageCaveat).toBeDefined();
    expect(result.value.data.trust.completeness.status).toBe('partial');
  });

  it('omits the caveat and reports complete when every referrer family is covered', async () => {
    const result = await unusedComponentsHandler(
      { ...ctx, manifest: completeCoverage() },
      { types: ['ApexClass'] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.coverageCaveat).toBeUndefined();
    expect(result.value.data.trust.completeness.status).toBe('complete');
  });

  it('names mid-staged-build pending referrer families in the caveat', async () => {
    const base = completeCoverage();
    const staged = {
      ...base,
      coverage: (base.coverage ?? []).map((row) =>
        row.type === 'Report' || row.type === 'Dashboard'
          ? { ...row, retrieved: 0, pending: true }
          : row,
      ),
      staged: { tier: 1, totalTiers: 3, pendingTypes: ['Report', 'Dashboard'] },
    };
    const result = await unusedComponentsHandler(
      { ...ctx, manifest: staged },
      { types: ['ApexClass'] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.coverageCaveat?.missingCoverage).toContain('Report');
    expect(result.value.data.coverageCaveat?.missingCoverage).toContain('Dashboard');
    expect(result.value.data.coverageCaveat?.message).toContain('not checked');
  });
});
