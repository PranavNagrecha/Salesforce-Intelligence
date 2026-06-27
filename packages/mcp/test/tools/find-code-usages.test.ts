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
  findCodeUsagesHandler,
  findCodeUsagesInputSchema,
} from '../../src/tools/find-code-usages.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 1,
    CustomField: 2,
    ApexClass: 2,
    ApexTrigger: 1,
    LightningComponentBundle: 2,
    AuraDefinitionBundle: 1,
    VisualforcePage: 1,
    VisualforceComponent: 1,
    Flow: 1,
  },
  edges: {
    readsFrom: 3,
    writesTo: 2,
    callsApex: 2,
    references: 3,
  },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName/etc. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Default edge-shape helper. Heuristic apex-scanner source by default. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

// =============================================================================
// Suite 1: mixed-source graph (field target).
//
// Field Industry__c is the target. Six code referrers:
//   - ApexClass A readsFrom (apex-scanner, heuristic)
//   - ApexClass B writesTo (apex-scanner, heuristic)
//   - ApexTrigger T writesTo (apex-scanner, heuristic)
//   - LWC bundle L readsFrom (lwc-aura-vf-scanner, heuristic — `@wire`
//     getRecord static fields list, but defaulted to heuristic per the
//     R3a report on schema-import vs body-text reads)
//   - AuraDefinitionBundle D readsFrom (lwc-aura-vf-scanner, heuristic)
//   - VisualforcePage P readsFrom (lwc-aura-vf-scanner, heuristic
//     attribute-expression hit)
// Flow F readsFrom must be filtered out (Flow is not in CODE_NODE_TYPES).
// =============================================================================

const FIELD_ID = 'CustomField:Account.Industry__c';
const APEX_A = 'ApexClass:AlphaService';
const APEX_B = 'ApexClass:BetaService';
const TRIGGER_T = 'ApexTrigger:AccountTrigger';
const LWC_L = 'LightningComponentBundle:accountTile';
const AURA_D = 'AuraDefinitionBundle:accountPanel';
const VF_PAGE_P = 'VisualforcePage:AccountReport';
const VF_COMPONENT_VC = 'VisualforceComponent:AccountRow';
const FLOW_F = 'Flow:AccountFlow';

const mixedSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: FIELD_ID, type: 'CustomField', apiName: 'Industry__c' }),
    makeNode({ id: APEX_A, type: 'ApexClass', apiName: 'AlphaService' }),
    makeNode({ id: APEX_B, type: 'ApexClass', apiName: 'BetaService' }),
    makeNode({
      id: TRIGGER_T,
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
    }),
    makeNode({
      id: LWC_L,
      type: 'LightningComponentBundle',
      apiName: 'accountTile',
    }),
    makeNode({
      id: AURA_D,
      type: 'AuraDefinitionBundle',
      apiName: 'accountPanel',
    }),
    makeNode({
      id: VF_PAGE_P,
      type: 'VisualforcePage',
      apiName: 'AccountReport',
    }),
    makeNode({
      id: VF_COMPONENT_VC,
      type: 'VisualforceComponent',
      apiName: 'AccountRow',
    }),
    makeNode({ id: FLOW_F, type: 'Flow', apiName: 'AccountFlow' }),
  ],
  edges: [
    // Apex-tier referrers.
    makeEdge({
      fromId: APEX_A,
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      properties: { line: 12 },
    }),
    makeEdge({
      fromId: APEX_B,
      toId: FIELD_ID,
      edgeType: 'writesTo',
      properties: { line: 34 },
    }),
    makeEdge({
      fromId: TRIGGER_T,
      toId: FIELD_ID,
      edgeType: 'writesTo',
      properties: { line: 5 },
    }),
    // v1.4 frontend tier referrers.
    makeEdge({
      fromId: LWC_L,
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'lwc-aura-vf-scanner',
      properties: { wirePath: 'Account.Industry' },
    }),
    makeEdge({
      fromId: AURA_D,
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'lwc-aura-vf-scanner',
      properties: { line: 7 },
    }),
    makeEdge({
      fromId: VF_PAGE_P,
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'lwc-aura-vf-scanner',
      properties: { line: 22 },
    }),
    // Flow source — same edgeType but Flow is intentionally NOT a code
    // node type, so the handler filters it out.
    makeEdge({
      fromId: FLOW_F,
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'flow-extractor',
      confidence: 'parsed',
    }),
  ],
};

// =============================================================================
// Suite 2: LWC -> ApexClass callsApex (the declared-confidence case
// per LwcAuraVfScannerSemantics.md). One LWC bundle imports
// `@salesforce/apex/OpportunityService.process`, producing a declared
// `callsApex` edge to the OpportunityService class.
// =============================================================================

const APEX_OPP = 'ApexClass:OpportunityService';
const LWC_CALLER = 'LightningComponentBundle:opportunityCard';

const lwcCallsApexSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: APEX_OPP,
      type: 'ApexClass',
      apiName: 'OpportunityService',
    }),
    makeNode({
      id: LWC_CALLER,
      type: 'LightningComponentBundle',
      apiName: 'opportunityCard',
    }),
  ],
  edges: [
    makeEdge({
      fromId: LWC_CALLER,
      toId: APEX_OPP,
      edgeType: 'callsApex',
      source: 'lwc-aura-vf-scanner',
      confidence: 'declared',
      properties: { methodName: 'process' },
    }),
  ],
};

// =============================================================================
// Suite 3: VF page -> controller ApexClass via `references` edge (the
// VF declared-controller case). The VF page declares
// `controller="OpportunityController"`, producing a declared
// `references` edge from the page to the class.
// =============================================================================

const APEX_CONTROLLER = 'ApexClass:OpportunityController';
const VF_PAGE_CALLER = 'VisualforcePage:OpportunityDetail';

const vfReferencesSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: APEX_CONTROLLER,
      type: 'ApexClass',
      apiName: 'OpportunityController',
    }),
    makeNode({
      id: VF_PAGE_CALLER,
      type: 'VisualforcePage',
      apiName: 'OpportunityDetail',
    }),
  ],
  edges: [
    makeEdge({
      fromId: VF_PAGE_CALLER,
      toId: APEX_CONTROLLER,
      edgeType: 'references',
      source: 'lwc-aura-vf-scanner',
      confidence: 'declared',
      properties: { role: 'controller' },
    }),
  ],
};

// =============================================================================
// Suite 4: many-referrers field for limit-truncation tests. Five LWC
// bundles all read from the same field. Used to verify stable
// truncation by id ASC.
// =============================================================================

const CROWDED_FIELD = 'CustomField:Account.Crowded__c';
const CROWDED_REFERRERS = [
  'LightningComponentBundle:r01',
  'LightningComponentBundle:r02',
  'LightningComponentBundle:r03',
  'LightningComponentBundle:r04',
  'LightningComponentBundle:r05',
];

const crowdedSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CROWDED_FIELD,
      type: 'CustomField',
      apiName: 'Crowded__c',
    }),
    ...CROWDED_REFERRERS.map((id) =>
      makeNode({
        id,
        type: 'LightningComponentBundle',
        apiName: id.replace('LightningComponentBundle:', ''),
      }),
    ),
  ],
  edges: CROWDED_REFERRERS.map((id) =>
    makeEdge({
      fromId: id,
      toId: CROWDED_FIELD,
      edgeType: 'readsFrom',
      source: 'lwc-aura-vf-scanner',
    }),
  ),
};

// One shared graph store + Context across the suite. Vitest's beforeAll
// is enough — all the seeds use distinct ids so there's no cross-test
// interference.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-find-code-usages-'));
  const dbPath = join(tempDir, 'find-code-usages.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    mixedSeed,
    lwcCallsApexSeed,
    vfReferencesSeed,
    crowdedSeed,
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

describe('findCodeUsagesHandler', () => {
  it('returns code-only referrers across Apex and frontend tiers, filters out Flow', async () => {
    const result = await findCodeUsagesHandler(ctx, { targetId: FIELD_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usages = result.value.data.usages;
    // Six code referrers (3 Apex tier + 3 frontend tier); Flow excluded.
    expect(usages.length).toBe(6);
    // Sorted by id ASC, then edgeType ASC.
    expect(usages.map((u) => [u.id, u.edgeType])).toEqual([
      [APEX_A, 'readsFrom'],
      [APEX_B, 'writesTo'],
      [TRIGGER_T, 'writesTo'],
      [AURA_D, 'readsFrom'],
      [LWC_L, 'readsFrom'],
      [VF_PAGE_P, 'readsFrom'],
    ]);
    expect(usages.map((u) => u.id)).not.toContain(FLOW_F);
    // type carries through from referrer node, source/properties from edge.
    const lwc = usages.find((u) => u.id === LWC_L);
    expect(lwc?.type).toBe('LightningComponentBundle');
    expect(lwc?.apiName).toBe('accountTile');
    expect(lwc?.source).toBe('lwc-aura-vf-scanner');
    expect(lwc?.properties).toEqual({ wirePath: 'Account.Industry' });
    // vaultState comes from manifest, not edge data.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-28T09:12:00Z');
  });

  it('honors nodeTypes: ["LightningComponentBundle"] for LWC-only narrowing', async () => {
    const result = await findCodeUsagesHandler(ctx, {
      targetId: FIELD_ID,
      nodeTypes: ['LightningComponentBundle'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usages = result.value.data.usages;
    // Only the LWC bundle should appear.
    expect(usages.length).toBe(1);
    expect(usages[0]?.id).toBe(LWC_L);
    expect(usages[0]?.type).toBe('LightningComponentBundle');
    // Apex, Aura, VF Page must all be filtered out.
    for (const u of usages) {
      expect(u.type).toBe('LightningComponentBundle');
    }
  });

  it('honors nodeTypes: ["ApexClass", "ApexTrigger"] (Apex-only subset, mimicking find_apex_usages)', async () => {
    const result = await findCodeUsagesHandler(ctx, {
      targetId: FIELD_ID,
      nodeTypes: ['ApexClass', 'ApexTrigger'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usages = result.value.data.usages;
    expect(usages.length).toBe(3);
    expect(usages.map((u) => u.id)).toEqual([APEX_A, APEX_B, TRIGGER_T]);
  });

  it('honors edgeTypes: ["callsApex"] and returns LWC -> ApexClass call as declared', async () => {
    const result = await findCodeUsagesHandler(ctx, {
      targetId: APEX_OPP,
      edgeTypes: ['callsApex'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usages = result.value.data.usages;
    expect(usages.length).toBe(1);
    expect(usages[0]?.id).toBe(LWC_CALLER);
    expect(usages[0]?.type).toBe('LightningComponentBundle');
    expect(usages[0]?.edgeType).toBe('callsApex');
    // The declared confidence is on the edge metadata; the handler does
    // not re-export it explicitly — but the source identifies it as the
    // LWC/Aura/VF scanner emission and properties carry the methodName.
    expect(usages[0]?.source).toBe('lwc-aura-vf-scanner');
    expect(usages[0]?.properties).toEqual({ methodName: 'process' });
  });

  it('honors edgeTypes: ["references"] and surfaces VF Page -> controller references', async () => {
    const result = await findCodeUsagesHandler(ctx, {
      targetId: APEX_CONTROLLER,
      edgeTypes: ['references'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usages = result.value.data.usages;
    expect(usages.length).toBe(1);
    expect(usages[0]?.id).toBe(VF_PAGE_CALLER);
    expect(usages[0]?.type).toBe('VisualforcePage');
    expect(usages[0]?.edgeType).toBe('references');
    expect(usages[0]?.source).toBe('lwc-aura-vf-scanner');
    expect(usages[0]?.properties).toEqual({ role: 'controller' });
  });

  it('truncates with stable id-ASC ordering when limit is below the referrer count', async () => {
    const result = await findCodeUsagesHandler(ctx, {
      targetId: CROWDED_FIELD,
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usages = result.value.data.usages;
    expect(usages.length).toBe(2);
    // Five referrers (r01..r05); limit=2 keeps the two smallest ids.
    expect(usages.map((u) => u.id)).toEqual([
      'LightningComponentBundle:r01',
      'LightningComponentBundle:r02',
    ]);
  });

  it('returns an empty list for an unknown targetId', async () => {
    const result = await findCodeUsagesHandler(ctx, {
      targetId: 'CustomField:Nope.Nope__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usages.length).toBe(0);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('an empty result discloses empty ≠ absent in boundaries, never a silent empty (P12-USAGE-tool-audit)', async () => {
    const result = await findCodeUsagesHandler(ctx, { targetId: 'CustomField:Nope.Nope__c' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const b = result.value.data.boundaries.join(' ');
    expect(b).toMatch(/NOT proof/i);
    expect(b).toMatch(/heuristic/i);
    expect(b).not.toMatch(/nothing uses it\b(?!.*NOT)/);
  });

  it('a non-empty result still carries the heuristic-confidence boundary', async () => {
    const result = await findCodeUsagesHandler(ctx, { targetId: FIELD_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usages.length).toBeGreaterThan(0);
    expect(result.value.data.boundaries.join(' ')).toMatch(/heuristic/i);
  });

  it('returns an empty list when edgeTypes is explicitly empty', async () => {
    // Per the Spec design choice: empty array means "filter to nothing",
    // not a Zod-level rejection. Predictable boundary semantics.
    const result = await findCodeUsagesHandler(ctx, {
      targetId: FIELD_ID,
      edgeTypes: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usages.length).toBe(0);
  });

  it('returns an empty list when nodeTypes is explicitly empty', async () => {
    // Same empty-array contract as edgeTypes: predictable boundary.
    const result = await findCodeUsagesHandler(ctx, {
      targetId: FIELD_ID,
      nodeTypes: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usages.length).toBe(0);
  });
});

describe('findCodeUsagesInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts limit at the upper bound (500)', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      limit: 500,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects limit greater than 500', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      limit: 501,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects limit=0', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      limit: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      limit: 1.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty targetId string', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({ targetId: '' });
    expect(parsed.success).toBe(false);
  });

  it('accepts the "references" edgeType (new in find_code_usages)', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      edgeTypes: ['references'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-code-emitted edgeType such as "triggersOn"', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      edgeTypes: ['triggersOn'],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the empty edgeTypes array (filter to nothing)', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      edgeTypes: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts all six code nodeTypes', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      nodeTypes: [
        'ApexClass',
        'ApexTrigger',
        'LightningComponentBundle',
        'AuraDefinitionBundle',
        'VisualforcePage',
        'VisualforceComponent',
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-code nodeType such as "Flow"', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      nodeTypes: ['Flow'],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-code nodeType such as "CustomField"', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      nodeTypes: ['CustomField'],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the empty nodeTypes array (filter to nothing)', () => {
    const parsed = findCodeUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      nodeTypes: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts offset and cursor (CR-22)', () => {
    expect(
      findCodeUsagesInputSchema.safeParse({
        targetId: FIELD_ID,
        offset: 2,
        cursor: 'abc',
      }).success,
    ).toBe(true);
  });
});

// =============================================================================
// CR-22 B4 — output cursor. find_code_usages emitted ONLY { usages, boundaries }
// pre-CR-22, so paging fields are spread CONDITIONALLY (B3 shape, not B1's
// always-on totalCount/hasMore). A whole-fits no-cursor call stays
// byte-identical; a truncated page resumes the full set with no gaps / dupes.
// =============================================================================
describe('findCodeUsagesHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call emits exactly { usages, boundaries }', async () => {
    const r = await findCodeUsagesHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(['boundaries', 'usages']);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await findCodeUsagesHandler(ctx, {
      targetId: FIELD_ID,
      limit: 500,
    });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.usages.map(
      (u) => `${u.id}|${u.edgeType}|${u.source}`,
    );
    expect(fullOrder.length).toBeGreaterThan(2);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof findCodeUsagesHandler>> =
        await findCodeUsagesHandler(
          ctx,
          cursor !== undefined
            ? { targetId: FIELD_ID, limit: 2, cursor }
            : { targetId: FIELD_ID, limit: 2 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const u of page.value.data.usages) {
        seen.push(`${u.id}|${u.edgeType}|${u.source}`);
      }
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 50) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor minted for a different nodeTypes filter', async () => {
    const first = await findCodeUsagesHandler(ctx, {
      targetId: FIELD_ID,
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    const replay = await findCodeUsagesHandler(ctx, {
      targetId: FIELD_ID,
      nodeTypes: ['LightningComponentBundle'],
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});
