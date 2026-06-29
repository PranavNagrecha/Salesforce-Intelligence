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
  whatIfChangeMethodSignatureHandler,
  whatIfChangeMethodSignatureInputSchema,
} from '../../src/tools/what-if-change-method-signature.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T11:00:00Z',
  sourceOrg: 'me@example.com',
  components: {
    ApexClass: 4,
    ApexTrigger: 1,
    Flow: 1,
    LightningComponentBundle: 1,
  },
  edges: {
    callsApex: 6,
    coversTest: 1,
  },
  sourceTreeHash: 'sha256:fixture',
  // Complete coverage for every family a method-signature change can break
  // (METHOD_SIGNATURE_REQUIRED_COVERAGE). The R2 trust gate downgrades a
  // `safe` verdict to `review` whenever the vault cannot prove it scanned
  // these families, so the safe path is only reachable — and testable — when
  // coverage is declared complete. See the unknown-coverage test below for
  // the downgrade behaviour.
  coverageComputedAt: '2026-05-28T11:00:00Z',
  coverage: (
    [
      'ApexClass',
      'ApexTrigger',
      'Flow',
      'LightningComponentBundle',
      'AuraDefinitionBundle',
    ] as const
  ).map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
  })),
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'SomeClass',
  label: null,
  parentId: null,
  sourcePath: 'unused.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

// =============================================================================
// Suite 1: target class with multiple callers — Apex class caller,
// Apex trigger caller, Flow caller, LWC caller, and a test class via
// callsApex + isTest, plus a separate test class via coversTest.
// The methodName filter narrows to one specific method.
// =============================================================================

const TARGET_CLASS = 'ApexClass:OpportunityService';
const APEX_CALLER = 'ApexClass:OpportunityHandler';
const TRIGGER_CALLER = 'ApexTrigger:OpportunityTrigger';
const FLOW_CALLER = 'Flow:OpportunityAutomation';
const LWC_CALLER = 'LightningComponentBundle:opportunityCard';
const TEST_VIA_CALLS = 'ApexClass:OpportunityServiceTest';
const TEST_VIA_COVERS = 'ApexClass:OpportunityCoverageTest';

const richSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TARGET_CLASS,
      type: 'ApexClass',
      apiName: 'OpportunityService',
    }),
    makeNode({
      id: APEX_CALLER,
      type: 'ApexClass',
      apiName: 'OpportunityHandler',
    }),
    makeNode({
      id: TRIGGER_CALLER,
      type: 'ApexTrigger',
      apiName: 'OpportunityTrigger',
    }),
    makeNode({
      id: FLOW_CALLER,
      type: 'Flow',
      apiName: 'OpportunityAutomation',
    }),
    makeNode({
      id: LWC_CALLER,
      type: 'LightningComponentBundle',
      apiName: 'opportunityCard',
    }),
    makeNode({
      id: TEST_VIA_CALLS,
      type: 'ApexClass',
      apiName: 'OpportunityServiceTest',
      properties: { isTest: true },
    }),
    makeNode({
      id: TEST_VIA_COVERS,
      type: 'ApexClass',
      apiName: 'OpportunityCoverageTest',
      properties: { isTest: true },
    }),
  ],
  edges: [
    // Direct method call with matching methodName.
    makeEdge({
      fromId: APEX_CALLER,
      toId: TARGET_CLASS,
      edgeType: 'callsApex',
      properties: { methodName: 'processOpp' },
    }),
    // Trigger calling with matching methodName.
    makeEdge({
      fromId: TRIGGER_CALLER,
      toId: TARGET_CLASS,
      edgeType: 'callsApex',
      properties: { methodName: 'processOpp' },
    }),
    // Same caller as APEX_CALLER but different methodName — should NOT
    // surface (dedupe by id but filter by methodName first).
    makeEdge({
      fromId: APEX_CALLER,
      toId: TARGET_CLASS,
      edgeType: 'callsApex',
      properties: { methodName: 'otherMethod' },
    }),
    // Flow caller — methodName is NOT in the Flow edge properties; the
    // tool should accept it anyway because Flow XML declares actions
    // at the class level. CR-CAP-08: the real flow.ts extractor emits
    // Flow callsApex at confidence 'parsed' (it parses the <actionCalls>
    // XML), NOT 'declared'. Seed the realistic value so the per-item
    // confidence assertion guards real behaviour.
    makeEdge({
      fromId: FLOW_CALLER,
      toId: TARGET_CLASS,
      edgeType: 'callsApex',
      confidence: 'parsed',
      source: 'flow-extractor',
    }),
    // LWC caller with declared confidence.
    makeEdge({
      fromId: LWC_CALLER,
      toId: TARGET_CLASS,
      edgeType: 'callsApex',
      confidence: 'declared',
      source: 'lwc-aura-vf-scanner',
      properties: { methodName: 'processOpp' },
    }),
    // Test caller via callsApex (isTest = true on the source node).
    makeEdge({
      fromId: TEST_VIA_CALLS,
      toId: TARGET_CLASS,
      edgeType: 'callsApex',
      properties: { methodName: 'processOpp' },
    }),
    // Test class via coversTest edge (no callsApex edge — the
    // @TestVisible / @TestSetup convention).
    makeEdge({
      fromId: TEST_VIA_COVERS,
      toId: TARGET_CLASS,
      edgeType: 'coversTest',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
  ],
};

// =============================================================================
// Suite 2: Target class exists but no callers — `safe` verdict path.
// =============================================================================

const TARGET_UNUSED = 'ApexClass:UnusedService';

const unusedSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TARGET_UNUSED,
      type: 'ApexClass',
      apiName: 'UnusedService',
    }),
  ],
  edges: [],
};

// A PHANTOM class: referenced by a callsApex edge but its own node was never
// retrieved (managed-package / out-of-scope). "What breaks if I change a method
// in OpportunityService" hits this when only the Test class was retrieved.
const PHANTOM_CLASS = 'ApexClass:Pkg_OpportunityService';
const phantomSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'ApexClass:Pkg_Caller', type: 'ApexClass', apiName: 'Pkg_Caller' }),
  ],
  edges: [
    makeEdge({ fromId: 'ApexClass:Pkg_Caller', toId: PHANTOM_CLASS, edgeType: 'callsApex' }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(
    join(tmpdir(), 'sfi-mcp-what-if-change-method-signature-'),
  );
  const dbPath = join(tempDir, 'wcms.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [richSeed, unusedSeed, phantomSeed]);
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

describe('whatIfChangeMethodSignatureHandler', () => {
  it('explains a phantom class (referenced but not retrieved) instead of a bare not-found', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: 'Pkg_OpportunityService',
      methodName: 'doWork',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toMatch(/referenced by/);
    expect(result.error.message).toMatch(/never retrieved|managed-package/);
  });

  it('returns a plain not-found for a genuinely unknown class', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: 'TotallyUnknownClass',
      methodName: 'x',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/no ApexClass with id/);
  });

  it('surfaces every direct caller with matching methodName', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // Direct method-name callers: APEX_CALLER, TRIGGER_CALLER, LWC_CALLER,
    // TEST_VIA_CALLS. Plus the Flow caller (Flow callers bypass methodName
    // filter). Plus TEST_VIA_COVERS (via coversTest). Total 6.
    const ids = data.callingClasses.map((c) => c.componentId).sort();
    expect(ids).toEqual(
      [
        APEX_CALLER,
        TRIGGER_CALLER,
        FLOW_CALLER,
        LWC_CALLER,
        TEST_VIA_CALLS,
        TEST_VIA_COVERS,
      ].sort(),
    );
  });

  it('classifies test callers as test-class-update', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(
      result.value.data.callingClasses.map((c) => [c.componentId, c]),
    );
    expect(byId.get(TEST_VIA_CALLS)?.category).toBe('test-class-update');
    expect(byId.get(TEST_VIA_COVERS)?.category).toBe('test-class-update');
    // Non-test callers should be code-needs-update.
    expect(byId.get(APEX_CALLER)?.category).toBe('code-needs-update');
    expect(byId.get(TRIGGER_CALLER)?.category).toBe('code-needs-update');
    expect(byId.get(LWC_CALLER)?.category).toBe('code-needs-update');
    expect(byId.get(FLOW_CALLER)?.category).toBe('code-needs-update');
  });

  it('stamps per-caller confidence from the edge: Apex=heuristic, LWC=declared, Flow=parsed', async () => {
    // CR-CAP-08 regression guard. The tool stamps item.confidence from
    // edge.confidence, so the three real upstream tiers must survive
    // round-trip and NOT collapse to one blanket "heuristic" tier.
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(
      result.value.data.callingClasses.map((c) => [c.componentId, c]),
    );
    // Apex caller / trigger caller come from the heuristic apex-scanner.
    expect(byId.get(APEX_CALLER)?.confidence).toBe('heuristic');
    expect(byId.get(TRIGGER_CALLER)?.confidence).toBe('heuristic');
    // LWC caller is the declarative @salesforce/apex import.
    expect(byId.get(LWC_CALLER)?.confidence).toBe('declared');
    // Flow caller is parsed out of the <actionCalls> XML by flow.ts —
    // it is 'parsed', NOT 'declared' and NOT 'heuristic'.
    expect(byId.get(FLOW_CALLER)?.confidence).toBe('parsed');
  });

  it('emits a parallel testClassesNeedingUpdate list with both test classes', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect([...data.testClassesNeedingUpdate].sort()).toEqual(
      [TEST_VIA_CALLS, TEST_VIA_COVERS].sort(),
    );
  });

  it('dedupes callers with multiple call-sites to the same target method', async () => {
    // APEX_CALLER has two callsApex edges to TARGET_CLASS (processOpp +
    // otherMethod). With methodName=processOpp, only one entry should
    // surface — the dedupe runs after the methodName filter.
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const apexCallerEntries = result.value.data.callingClasses.filter(
      (c) => c.componentId === APEX_CALLER,
    );
    expect(apexCallerEntries.length).toBe(1);
  });

  it('returns safe verdict when no callers exist', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_UNUSED,
      methodName: 'anything',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.callingClasses.length).toBe(0);
    expect(data.testClassesNeedingUpdate.length).toBe(0);
    expect(data.verdict).toBe('safe');
  });

  it('downgrades safe to review under unknown coverage, naming the gap', async () => {
    // Same no-callers case, but the vault never recorded which families it
    // scanned. R2: `safe` is only honest when coverage is proven complete, so
    // an unknown-coverage vault downgrades to `review` (not permission to
    // change) and the caveat must name a family that could be hiding a caller.
    const unknownCoverageCtx: Context = {
      ...ctx,
      manifest: { ...FIXTURE_MANIFEST, coverage: [] },
    };
    const result = await whatIfChangeMethodSignatureHandler(unknownCoverageCtx, {
      classApiName: TARGET_UNUSED,
      methodName: 'anything',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.callingClasses.length).toBe(0);
    expect(data.verdict).toBe('review');
    expect(data.coverageCaveat?.missingCoverage).toContain('Flow');
  });

  it('returns risky verdict when at least one caller exists', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('risky');
  });

  it('echoes newSignature verbatim into the response when provided', async () => {
    const newSig = 'processOpp(Opportunity opp, Boolean isUpdate)';
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
      newSignature: newSig,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.newSignature).toBe(newSig);
    expect(result.value.data.methodName).toBe('processOpp');
  });

  it('surfaces newSignature as null when omitted', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.newSignature).toBeNull();
  });

  it('returns invalid-query for a non-ApexClass prefix', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: 'ApexTrigger:NotAClass',
      methodName: 'foo',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown classApiName', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: 'ApexClass:NoSuch',
      methodName: 'someMethod',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('emits the verbatim honesty-axis disclosure including the dynamic-Apex caveat', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('heuristic confidence');
    expect(result.value.data.disclosure).toContain('Type.forName');
    expect(result.value.data.disclosure).toContain('coversTest');
  });

  it('disclosure is per-source-honest: admits Flow=parsed and LWC=declared, not a blanket all-heuristic claim', async () => {
    // CR-CAP-08: the old disclosure made a blanket "callers identified
    // via the apex-scanner are at heuristic confidence" claim, which is
    // false — Flow callers are parsed (flow.ts) and LWC callers are
    // declared. The disclosure must admit the mixed tiers.
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const disclosure = result.value.data.disclosure;
    expect(disclosure).toContain('parsed');
    expect(disclosure).toContain('declared');
    // No blanket "all callers ... heuristic" / "via the apex-scanner ...
    // heuristic" sweep that erases the parsed/declared tiers.
    expect(disclosure).not.toMatch(/all callers[^.]*heuristic/i);
  });

  it('echoes the manifest vaultState into the response envelope', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx, {
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });
});

describe('whatIfChangeMethodSignatureInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = whatIfChangeMethodSignatureInputSchema.safeParse({
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an input with newSignature', () => {
    const parsed = whatIfChangeMethodSignatureInputSchema.safeParse({
      classApiName: TARGET_CLASS,
      methodName: 'processOpp',
      newSignature: 'processOpp(Opportunity opp)',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty classApiName', () => {
    const parsed = whatIfChangeMethodSignatureInputSchema.safeParse({
      classApiName: '',
      methodName: 'foo',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty methodName', () => {
    const parsed = whatIfChangeMethodSignatureInputSchema.safeParse({
      classApiName: TARGET_CLASS,
      methodName: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing methodName', () => {
    const parsed = whatIfChangeMethodSignatureInputSchema.safeParse({
      classApiName: TARGET_CLASS,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing classApiName', () => {
    const parsed = whatIfChangeMethodSignatureInputSchema.safeParse({
      methodName: 'foo',
    });
    expect(parsed.success).toBe(false);
  });
});

// =============================================================================
// Suite 2 (P4-C5 method-level): a caller that invokes MULTIPLE methods of the
// same target now produces ONE callsApex edge carrying methods[]. The tool must
// catch that caller for EVERY method in the set — before P4-C5 the lossy dedup
// kept a single methodName, so a query for the dropped method missed the caller.
// =============================================================================

describe('whatIfChangeMethodSignatureHandler: methods[] edge (P4-C5)', () => {
  const REPO = 'ApexClass:Repo';
  const SERVICE = 'ApexClass:Service';
  let dir2: string;
  let store2: GraphStore;
  let ctx2: Context;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-mcp-wcms-methods-'));
    const opened = await openGraph(join(dir2, 'm.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store2 = opened.value;
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: REPO, type: 'ApexClass', apiName: 'Repo' }),
        makeNode({ id: SERVICE, type: 'ApexClass', apiName: 'Service' }),
      ],
      edges: [
        // ONE post-P4-C5 edge: Service calls BOTH Repo.save and Repo.deleteRecord.
        makeEdge({
          fromId: SERVICE,
          toId: REPO,
          edgeType: 'callsApex',
          properties: { methods: ['deleteRecord', 'save'], methodName: 'deleteRecord' },
        }),
      ],
    };
    const imported = await importExtractionResults(store2, [seed]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx2 = { vaultRoot: dir2, manifest: FIXTURE_MANIFEST, graph: store2 };
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('catches the multi-method caller when changing the FIRST method (save)', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx2, {
      classApiName: 'Repo',
      methodName: 'save',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.callingClasses.map((c) => c.componentId)).toContain(
      SERVICE,
    );
  });

  it('catches the SAME caller when changing the OTHER method (deleteRecord) — the pre-P4-C5 miss', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx2, {
      classApiName: 'Repo',
      methodName: 'deleteRecord',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.callingClasses.map((c) => c.componentId)).toContain(
      SERVICE,
    );
  });

  it('does NOT surface the caller for a method it never calls', async () => {
    const result = await whatIfChangeMethodSignatureHandler(ctx2, {
      classApiName: 'Repo',
      methodName: 'neverCalled',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.data.callingClasses.map((c) => c.componentId),
    ).not.toContain(SERVICE);
  });
});
