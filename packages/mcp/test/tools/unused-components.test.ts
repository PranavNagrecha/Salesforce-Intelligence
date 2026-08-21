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

  it('accepts offset and cursor (CR-22)', () => {
    expect(
      unusedComponentsInputSchema.safeParse({ offset: 1, cursor: 'abc' }).success,
    ).toBe(true);
  });
});

// =============================================================================
// CR-22 B4 — output cursor over the global unused list. A whole-fits no-cursor
// call is byte-identical; a truncated page resumes the full set with no gaps /
// dupes; byType stays the FULL per-type count.
// =============================================================================
describe('unusedComponentsHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call omits all paging fields', async () => {
    const r = await unusedComponentsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextOffset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d['truncated']).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await unusedComponentsHandler(ctx, { limit: 500 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.components.map((c) => c.id);
    expect(fullOrder.length).toBeGreaterThan(2);
    const fullByType = all.value.data.byType;

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof unusedComponentsHandler>> =
        await unusedComponentsHandler(
          ctx,
          cursor !== undefined ? { limit: 1, cursor } : { limit: 1 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      // byType stays the FULL per-type count regardless of page.
      expect(page.value.data.byType).toEqual(fullByType);
      for (const c of page.value.data.components) seen.push(c.id);
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 50) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor minted for a different types filter', async () => {
    const first = await unusedComponentsHandler(ctx, { limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    const replay = await unusedComponentsHandler(ctx, {
      types: ['EmailTemplate'],
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});

describe('unusedComponentsHandler — coverage caveat (P13-STAGED-absence-battery)', () => {
  const completeCoverage = (): VaultManifest => ({
    ...FIXTURE_MANIFEST,
    coverage: [
      'ApexClass', 'ApexTrigger', 'AuraDefinitionBundle', 'CompactLayout',
      'CustomSite', 'CustomTab', 'Dashboard', 'EmailTemplate', 'FieldSet',
      'FlexiPage', 'Flow', 'Layout', 'LightningComponentBundle', 'ListView',
      'QuickAction', 'RecordType', 'Report', 'SharingRule', 'ValidationRule',
      'VisualforceComponent', 'VisualforcePage', 'WebLink', 'WorkflowRule',
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

// UNUSED-UNCHECKED-ZERO-READS-AS-CLEAN. This tool tells a human something is
// safe to delete, so its zeros are load-bearing. Measured on a real vault whose
// refresh never retrieved Reports or Dashboards (`retrieved: 0, pending: true`
// on both coverage rows): `sfi.unused_components { types: ['Report'] }` returned
// `{ byType: { Report: 0 }, components: [], truncated: false }` — byte-identical
// to a type that WAS fully scanned and found entirely in use. The `coverageCaveat`
// did not close the gap: it is the REFERRER axis ("a field used only by reports
// would read unused"), its text is the same whichever type you scanned, and it
// fires just as loudly on a fully-scanned type.
describe('unusedComponentsHandler — unchecked zeros (scanned axis)', () => {
  it('flags a scanned type the vault never retrieved instead of reporting a clean 0', async () => {
    const notRetrieved: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        {
          type: 'Report',
          requested: true,
          retrieved: 0,
          pending: true,
          errored: false,
          neverModeled: false,
        },
      ],
    };
    const result = await unusedComponentsHandler(
      { ...ctx, manifest: notRetrieved },
      { types: ['Report'] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // The bare count is unchanged — and on its own, still reads as "none unused".
    expect(data.byType['Report']).toBe(0);
    // …which is why the zero must now be itemised as UNCHECKED.
    expect(data.uncheckedTypes).toBeDefined();
    expect(data.uncheckedTypes?.[0]?.type).toBe('Report');
    expect(data.uncheckedTypes?.[0]?.reason).toBe('not-retrieved');
    expect(data.uncheckedTypes?.[0]?.note).toContain('NOT CHECKED');
  });

  it('separates a CONFIRMED-empty family from a never-retrieved one', async () => {
    const confirmedEmpty: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        {
          type: 'Letterhead',
          requested: true,
          retrieved: 0,
          retrieveConfirmed: true,
          errored: false,
          neverModeled: false,
        },
      ],
    };
    const result = await unusedComponentsHandler(
      { ...ctx, manifest: confirmedEmpty },
      { types: ['Letterhead'] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.uncheckedTypes?.[0]?.reason).toBe('confirmed-empty');
    expect(result.value.data.uncheckedTypes?.[0]?.note).toContain('checked zero');
  });

  // UNUSED-PAGE-CURSOR-SKIPS-TRIMMED-ROWS. `paginateLegacy`'s default byte
  // budget (38 KB) bounds the components ARRAY, while the global response guard
  // measures the WHOLE envelope against ~39 KB and tail-truncates the array
  // AFTER this handler minted `nextOffset`/`nextCursor` for the untrimmed page.
  // Measured on a real vault: `sfi.unused_components { limit: 500 }` returned 59
  // rows carrying a cursor for offset 118, so following that cursor — which the
  // guard's own note calls authoritative — SKIPPED 59 unused components, and
  // page 2 skipped 63 more. The handler's page must fit the envelope so its
  // resume token stays truthful.
  it('keeps the page inside the response envelope so the cursor cannot skip rows', async () => {
    const bigDir = mkdtempSync(join(tmpdir(), 'sfi-unused-bigpage-'));
    try {
      const o = await openGraph(join(bigDir, 'g.db'));
      expect(o.ok).toBe(true);
      if (!o.ok) return;
      const bigStore = o.value;
      // 400 unreferenced classes — far more than one page can carry, so the
      // page-size decision (not the data volume) is what is under test.
      const nodes: Node[] = [];
      for (let i = 0; i < 400; i++) {
        const name = `UnreferencedServiceImplementation${String(i).padStart(4, '0')}`;
        nodes.push(
          makeNode({
            id: `ApexClass:${name}`,
            type: 'ApexClass',
            apiName: name,
            label: name,
            sourcePath: `classes/${name}.cls`,
          }),
        );
      }
      const imported = await importExtractionResults(bigStore, [{ nodes, edges: [] }]);
      expect(imported.ok).toBe(true);
      const bigCtx: Context = {
        vaultRoot: bigDir,
        manifest: FIXTURE_MANIFEST,
        graph: bigStore,
      };
      const r = await unusedComponentsHandler(bigCtx, {
        types: ['ApexClass'],
        limit: 500,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.value.data;
      expect(data.truncated).toBe(true);
      expect(data.components.length).toBeGreaterThan(10);
      // FAIL-BEFORE: the `data` object serialized to ~39 KB, so the global guard
      // halved `components` while `nextOffset` / `nextCursor` kept pointing past
      // the deleted rows.
      const dataBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
      expect(dataBytes).toBeLessThanOrEqual(36_000);
      // The resume point must be exactly where the returned page ends.
      expect(data.nextOffset).toBe(data.components.length);
      expect(data.pageInfo?.returnedCount).toBe(data.components.length);
      await closeGraph(bigStore);
    } finally {
      rmSync(bigDir, { recursive: true, force: true });
    }
  });

  it('omits `uncheckedTypes` entirely when every scanned type had instances', async () => {
    // ApexClass IS seeded in this fixture, so its 0-or-more count is a checked
    // number; the response must stay byte-identical to before.
    const result = await unusedComponentsHandler(ctx, { types: ['ApexClass'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.uncheckedTypes).toBeUndefined();
  });
});

// Perf regression guard: the "unused" verdict reads each scanned node's INCOMING
// edges. It MUST fetch them in one batched `listEdgesForNodes` round-trip per
// type, not an N+1 `listEdges`-per-node loop — that N+1 (one DuckDB round-trip
// per CustomField) was the dominant cost in the >60s tech_debt_score /
// org_risk_report timeout on a large org.
describe('unusedComponentsHandler — batched incoming-edge lookups (no N+1)', () => {
  const FIELD_COUNT = 60;
  let dir: string;
  let localStore: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-unused-perf-'));
    const opened = await openGraph(join(dir, 'perf.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    localStore = opened.value;
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Perf__c', type: 'CustomObject', apiName: 'Perf__c' }),
        ...Array.from({ length: FIELD_COUNT }, (_unused, i) =>
          makeNode({
            id: `CustomField:Perf__c.Dead${i}__c`,
            type: 'CustomField',
            apiName: `Dead${i}__c`,
            parentId: 'CustomObject:Perf__c',
          }),
        ),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(localStore, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: localStore };
  });

  afterAll(async () => {
    await closeGraph(localStore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('issues a bounded number of edge queries regardless of node count', async () => {
    const spy = vi.spyOn(localStore.connection, 'runAndReadAll');
    const result = await unusedComponentsHandler(localCtx, {
      types: ['CustomField'],
      limit: 500,
    });
    const edgeQueries = spy.mock.calls.filter(([sql]) =>
      String(sql).includes('FROM edges'),
    ).length;
    spy.mockRestore();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All 60 fields are unreferenced (only a structural parentOf), so all are unused.
    expect(result.value.data.byType['CustomField']).toBe(FIELD_COUNT);
    // ONE batched listEdgesForNodes for the whole type — not one per field.
    expect(edgeQueries).toBeLessThanOrEqual(2);
  });
});

// =============================================================================
// GUARD (UNUSED-COMPONENTS-SILENTLY-IGNORES-TYPE-AND-OBJECT): an admin "unused
// WebLinks on Widget__c" passes a SINGULAR `type` (WebLink) and an `object`
// filter, but both were Zod-stripped and the tool returned the org-wide Apex/…
// default leaderboard with no appliedScope. A type scope must now return ONLY
// that family, an object scope must narrow to that object's children, and an
// unknown type must be a reasoned invalid-query — never a wrong-family answer.
// =============================================================================
describe('unusedComponentsHandler — type + object scope (guard)', () => {
  const WIDGET = 'CustomObject:Widget__c';
  const GADGET = 'CustomObject:Gadget__c';
  const UNUSED_WEBLINK = 'WebLink:Widget__c.OldPrintButton';
  const USED_WEBLINK = 'WebLink:Widget__c.LiveDetailButton';
  const GADGET_WEBLINK = 'WebLink:Gadget__c.StrayLink';
  const LONELY_APEX = 'ApexClass:LonelyHelper';
  const LAYOUT = 'Layout:WidgetPage';

  let dir: string;
  let s: GraphStore;
  let scopeCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-uc-scope-'));
    const opened = await openGraph(join(dir, 'scope.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    s = opened.value;
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: WIDGET, type: 'CustomObject', apiName: 'Widget__c' }),
        makeNode({ id: GADGET, type: 'CustomObject', apiName: 'Gadget__c' }),
        makeNode({ id: UNUSED_WEBLINK, type: 'WebLink', apiName: 'OldPrintButton', parentId: WIDGET }),
        makeNode({ id: USED_WEBLINK, type: 'WebLink', apiName: 'LiveDetailButton', parentId: WIDGET }),
        makeNode({ id: GADGET_WEBLINK, type: 'WebLink', apiName: 'StrayLink', parentId: GADGET }),
        makeNode({ id: LONELY_APEX, apiName: 'LonelyHelper' }),
        makeNode({ id: LAYOUT, type: 'Layout', apiName: 'WidgetPage' }),
      ],
      edges: [
        makeEdge({ fromId: WIDGET, toId: UNUSED_WEBLINK, edgeType: 'parentOf' }),
        makeEdge({ fromId: WIDGET, toId: USED_WEBLINK, edgeType: 'parentOf' }),
        makeEdge({ fromId: GADGET, toId: GADGET_WEBLINK, edgeType: 'parentOf' }),
        // A layout placing the button — a real incoming USAGE edge → NOT unused.
        makeEdge({ fromId: LAYOUT, toId: USED_WEBLINK, edgeType: 'references' }),
      ],
    };
    const imp = await importExtractionResults(s, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    scopeCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
  });

  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('singular type: "WebLink" returns ONLY WebLinks (not the Apex/default leaderboard)', async () => {
    const r = await unusedComponentsHandler(scopeCtx, { type: 'WebLink' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.components.map((c) => c.id);
    expect(ids).toContain(UNUSED_WEBLINK);
    expect(ids).toContain(GADGET_WEBLINK);
    // The placed (referenced) button is in use — excluded.
    expect(ids).not.toContain(USED_WEBLINK);
    // Wrong-family answer is gone: the org-wide Apex list must NOT appear.
    expect(ids).not.toContain(LONELY_APEX);
    expect(r.value.data.byType['WebLink']).toBe(2);
    expect(r.value.data.appliedScope).toEqual({
      types: ['WebLink'],
      object: null,
      mode: 'scoped',
    });
  });

  it('natural type ≡ componentType ≡ typeFilter ≡ canonical types:["WebLink"] (byte-equal data)', async () => {
    const byType = await unusedComponentsHandler(scopeCtx, { type: 'WebLink' });
    const byComponentType = await unusedComponentsHandler(scopeCtx, { componentType: 'WebLink' });
    const byTypeFilter = await unusedComponentsHandler(scopeCtx, { typeFilter: 'WebLink' });
    const byArray = await unusedComponentsHandler(scopeCtx, { types: ['WebLink'] });
    expect(byType.ok && byComponentType.ok && byTypeFilter.ok && byArray.ok).toBe(true);
    if (!byType.ok || !byComponentType.ok || !byTypeFilter.ok || !byArray.ok) return;
    const canonical = JSON.stringify(byArray.value.data);
    expect(JSON.stringify(byType.value.data)).toBe(canonical);
    expect(JSON.stringify(byComponentType.value.data)).toBe(canonical);
    expect(JSON.stringify(byTypeFilter.value.data)).toBe(canonical);
  });

  it('object scope narrows the WebLink scan to that object (differs from unscoped)', async () => {
    const r = await unusedComponentsHandler(scopeCtx, {
      type: 'WebLink',
      object: 'Widget__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.components.map((c) => c.id);
    expect(ids).toEqual([UNUSED_WEBLINK]);
    // Gadget's WebLink is out of scope.
    expect(ids).not.toContain(GADGET_WEBLINK);
    expect(r.value.data.byType['WebLink']).toBe(1);
    expect(r.value.data.appliedScope).toEqual({
      types: ['WebLink'],
      object: 'Widget__c',
      mode: 'scoped',
    });
  });

  it('object scope alone narrows to that object (honest empty, NOT the Apex leaderboard)', async () => {
    // Widget__c has no default-type children (its WebLinks are not in the default
    // set), so the object-scoped default scan is an HONEST empty — never the
    // org-wide Apex list the pre-fix code returned when `object` was stripped.
    const r = await unusedComponentsHandler(scopeCtx, { objectApiName: 'Widget__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.components.map((c) => c.id);
    expect(ids).not.toContain(LONELY_APEX);
    expect(ids).toEqual([]);
    expect(r.value.data.appliedScope.object).toBe('Widget__c');
    expect(r.value.data.appliedScope.mode).toBe('scoped');
  });

  it('an unknown singular type is invalid-query (not a silent default-family answer)', async () => {
    const r = await unusedComponentsHandler(scopeCtx, { type: 'Frobnicate' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('a bare call stays org-wide over the default set with appliedScope mode: default', async () => {
    const r = await unusedComponentsHandler(scopeCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.components.map((c) => c.id);
    // Apex IS in the default set → the lonely class appears on a bare call.
    expect(ids).toContain(LONELY_APEX);
    // WebLink is NOT in the default set → bare call omits it (unchanged behavior).
    expect(ids).not.toContain(UNUSED_WEBLINK);
    expect(r.value.data.appliedScope.mode).toBe('default');
    expect(r.value.data.appliedScope.object).toBeNull();
  });
});
