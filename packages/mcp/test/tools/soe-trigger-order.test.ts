/// <reference types="vitest/globals" />

/**
 * FLOW-ORDER-IS-ALPHABETICAL.
 *
 * Both SOE composition tools sorted co-firing flows by ascending component id
 * and handed them consecutive `stepIndex` values, presenting an alphabetisation
 * as the execution sequence with no caveat anywhere. Salesforce guarantees no
 * order between two record-triggered flows in the same phase — except where the
 * flows declare distinct top-level `<Flow><triggerOrder>` values, which the
 * vault now extracts.
 *
 * What this file pins, as invariants rather than snapshots:
 *
 *  1. A vault whose Flow nodes carry NO `triggerOrder` key is "did not check",
 *     never "declares none" — it says so, and points at `sfi refresh`.
 *  2. On such a vault the step ORDER is unchanged (ascending id), so no shipped
 *     response silently reorders.
 *  3. A vault that DID extract it sorts declared-ascending-then-undeclared, and
 *     reports how many flows the claim rests on.
 *  4. The caveat appears ONLY when a phase actually holds two or more steps —
 *     one automation per phase has nothing to mis-order, and its response is
 *     byte-identical to before this existed.
 *  5. An object with NO record-triggered flows gets the ambiguity sentence and
 *     NOTHING about Flow Trigger Order coverage: its ambiguous phase is five
 *     validation rules, nothing was missed, and `sfi refresh` would change
 *     nothing. A vault-gap claim there is a fabricated caveat.
 */

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
  type GraphStore,
  importExtractionResults,
  openGraph,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { orderOfExecutionHandler } from '../../src/tools/order-of-execution.js';
import {
  buildWithinPhaseOrder,
  censusFlowTriggerOrders,
  collectAmbiguousPhases,
  isTriggerOrderCoverageGap,
  readFlowTriggerOrder,
  sortFlowFirersByTriggerOrder,
} from '../../src/tools/soe-trigger-order.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2 },
  edges: { triggersOn: 6 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

/**
 * A before-save flow node. `triggerOrder: undefined` OMITS the key entirely —
 * the shape a vault built before the extractor change holds, and the shape that
 * must never be read as "declares no order".
 */
const flowNode = (
  apiName: string,
  triggerOrder: number | null | undefined,
): Node =>
  makeNode({
    id: `Flow:${apiName}`,
    type: 'Flow',
    apiName,
    properties: {
      status: 'Active',
      triggerObject: 'Anon',
      triggerType: 'RecordBeforeSave',
      ...(triggerOrder === undefined ? {} : { triggerOrder }),
    },
  });

const flowEdge = (apiName: string, objectId: string): Edge =>
  makeEdge({
    fromId: `Flow:${apiName}`,
    toId: objectId,
    edgeType: 'triggersOn',
    properties: {
      triggerType: 'RecordBeforeSave',
      recordTriggerType: 'CreateAndUpdate',
    },
  });

/**
 * The same three co-firing before-save flows twice: once as a vault that
 * extracted the trigger order, once as a vault that predates the extractor.
 *
 * The ids are chosen so the two orders DISAGREE. Ascending id is Alpha, Beta,
 * Gamma; the declared trigger orders are Gamma 10, Alpha 300, Beta 600. A tool
 * that ignores the declaration cannot produce the declared sequence by luck.
 */
const EXTRACTED_OBJ = 'CustomObject:Extracted';
const PREDATES_OBJ = 'CustomObject:Predates';
const SOLO_OBJ = 'CustomObject:Solo';
const NO_FLOWS_OBJ = 'CustomObject:NoFlows';

const extractedSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: EXTRACTED_OBJ, apiName: 'Extracted' }),
    flowNode('AlphaExtracted', 300),
    flowNode('BetaExtracted', 600),
    flowNode('GammaExtracted', 10),
    flowNode('DeltaExtracted', null),
    flowNode('EpsilonExtracted', null),
  ],
  edges: [
    flowEdge('AlphaExtracted', EXTRACTED_OBJ),
    flowEdge('BetaExtracted', EXTRACTED_OBJ),
    flowEdge('GammaExtracted', EXTRACTED_OBJ),
    flowEdge('DeltaExtracted', EXTRACTED_OBJ),
    flowEdge('EpsilonExtracted', EXTRACTED_OBJ),
  ],
};

const predatesSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: PREDATES_OBJ, apiName: 'Predates' }),
    flowNode('AlphaPredates', undefined),
    flowNode('BetaPredates', undefined),
    flowNode('GammaPredates', undefined),
  ],
  edges: [
    flowEdge('AlphaPredates', PREDATES_OBJ),
    flowEdge('BetaPredates', PREDATES_OBJ),
    flowEdge('GammaPredates', PREDATES_OBJ),
  ],
};

/** One automation in every phase — nothing to mis-order anywhere. */
const soloSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: SOLO_OBJ, apiName: 'Solo' }),
    flowNode('OnlyFlowSolo', undefined),
  ],
  edges: [flowEdge('OnlyFlowSolo', SOLO_OBJ)],
};

/**
 * An ambiguous phase made ENTIRELY of validation rules, with ZERO
 * record-triggered flows on the object. This is the common real shape — most
 * objects in a real org have several validation rules and no flow — and it is
 * the one the zero-sample census got wrong: it reported "this vault never
 * extracted `<Flow><triggerOrder>`" and told the reader to re-run `sfi
 * refresh`, on a fully-refreshed vault, about a declaration that could not have
 * applied to a single step in the list.
 */
const noFlowsSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: NO_FLOWS_OBJ, apiName: 'NoFlows' }),
    ...['VR1', 'VR2', 'VR3'].map((name) =>
      makeNode({
        id: `ValidationRule:NoFlows.${name}`,
        type: 'ValidationRule',
        apiName: name,
        parentId: NO_FLOWS_OBJ,
        properties: { active: true },
      }),
    ),
  ],
  edges: ['VR1', 'VR2', 'VR3'].map((name) =>
    makeEdge({
      fromId: NO_FLOWS_OBJ,
      toId: `ValidationRule:NoFlows.${name}`,
      edgeType: 'parentOf',
    }),
  ),
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-soe-trigger-order-'));
  const opened = await openGraph(join(tempDir, 'graph.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    extractedSeed,
    predatesSeed,
    soloSeed,
    noFlowsSeed,
  ]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const apiNamesInPhase = (
  soe: readonly { readonly phase: string; readonly apiName: string }[],
  phase: string,
): readonly string[] => soe.filter((s) => s.phase === phase).map((s) => s.apiName);

describe('readFlowTriggerOrder — three states, never two', () => {
  it('an ABSENT key is "not extracted", not "declares none"', () => {
    const read = readFlowTriggerOrder(flowNode('X', undefined));
    expect(read.extracted).toBe(false);
    expect(read.value).toBeNull();
  });

  it('an explicit null is "extracted, declares none"', () => {
    const read = readFlowTriggerOrder(flowNode('X', null));
    expect(read.extracted).toBe(true);
    expect(read.value).toBeNull();
  });

  it('a number is the declared order', () => {
    expect(readFlowTriggerOrder(flowNode('X', 1))).toEqual({
      extracted: true,
      value: 1,
    });
  });

  it('treats a non-numeric stored value as declaring none, still extracted', () => {
    const node = makeNode({
      id: 'Flow:Junk',
      type: 'Flow',
      apiName: 'Junk',
      properties: { triggerOrder: 'five hundred' },
    });
    expect(readFlowTriggerOrder(node)).toEqual({ extracted: true, value: null });
  });
});

describe('sortFlowFirersByTriggerOrder', () => {
  it('orders declared ascending, undeclared last, id as the tiebreak', () => {
    const entries = [
      { firer: flowNode('Beta', 600) },
      { firer: flowNode('Zeta', null) },
      { firer: flowNode('Alpha', 300) },
      { firer: flowNode('Delta', null) },
      { firer: flowNode('Gamma', 10) },
    ];
    expect(
      sortFlowFirersByTriggerOrder(entries).map((e) => e.firer.apiName),
    ).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta', 'Zeta']);
  });

  it('is a NO-OP on a vault that never extracted the property', () => {
    // The byte-identity guarantee: with no key on any node the comparator can
    // only reach the id tiebreak, so the output is the ascending-id order these
    // tools already produced.
    const entries = ['Gamma', 'Alpha', 'Beta'].map((n) => ({
      firer: flowNode(n, undefined),
    }));
    expect(
      sortFlowFirersByTriggerOrder(entries).map((e) => e.firer.apiName),
    ).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('breaks a TIE on id rather than leaving it to insertion order', () => {
    const entries = [
      { firer: flowNode('Zeta', 500) },
      { firer: flowNode('Alpha', 500) },
    ];
    expect(
      sortFlowFirersByTriggerOrder(entries).map((e) => e.firer.apiName),
    ).toEqual(['Alpha', 'Zeta']);
  });

  it('does not mutate its input', () => {
    const entries = [{ firer: flowNode('Zeta', 1) }, { firer: flowNode('Alpha', 2) }];
    const before = entries.map((e) => e.firer.apiName);
    sortFlowFirersByTriggerOrder(entries);
    expect(entries.map((e) => e.firer.apiName)).toEqual(before);
  });
});

describe('censusFlowTriggerOrders', () => {
  it('counts declared vs undeclared on a fully extracted set', () => {
    expect(
      censusFlowTriggerOrders([
        flowNode('A', 1),
        flowNode('B', null),
        flowNode('C', null),
      ]),
    ).toEqual({ state: 'extracted', declared: 1, undeclared: 2 });
  });

  it('a set with ANY unextracted node reports NOT extracted', () => {
    // A partial census cannot support an order claim: one node from an older
    // import is enough to make "N of M declare one" a lie.
    expect(
      censusFlowTriggerOrders([flowNode('A', 1), flowNode('B', undefined)])
        .state,
    ).toBe('not-extracted');
  });

  it('an EMPTY set is NOT-APPLICABLE, never a vault gap', () => {
    // The defect this replaces: `extracted: false` on a zero-sample census made
    // "this object has no record-triggered flows" indistinguishable from "this
    // vault predates the extractor", and the callers turned the second reading
    // into a coverageCaveat pointing at `sfi refresh`.
    expect(censusFlowTriggerOrders([])).toEqual({
      state: 'not-applicable',
      declared: 0,
      undeclared: 0,
    });
    expect(isTriggerOrderCoverageGap(censusFlowTriggerOrders([]))).toBe(false);
  });

  it('only the not-extracted state is a coverage gap', () => {
    expect(
      isTriggerOrderCoverageGap({
        state: 'not-extracted',
        declared: 0,
        undeclared: 0,
      }),
    ).toBe(true);
    expect(
      isTriggerOrderCoverageGap({
        state: 'extracted',
        declared: 1,
        undeclared: 0,
      }),
    ).toBe(false);
  });
});

describe('collectAmbiguousPhases / buildWithinPhaseOrder', () => {
  const counts = {
    'before-save-flows': 3,
    'pre-save-triggers': 1,
    'pre-save-validation': 0,
    'duplicate-rules': 0,
    'after-triggers': 2,
    'post-save-assignment': 0,
    'post-save-workflows': 0,
    'post-save-flows': 0,
    'post-save-approval': 0,
    'post-save-rollup-recalc': 0,
    'post-save-async': 0,
  } as const;

  it('names only the phases holding two or more steps', () => {
    expect(collectAmbiguousPhases(counts)).toEqual([
      { phase: 'before-save-flows', steps: 3 },
      { phase: 'after-triggers', steps: 2 },
    ]);
  });

  it('emits NOTHING when no phase can be mis-ordered', () => {
    const single = { ...counts, 'before-save-flows': 1, 'after-triggers': 0 };
    expect(collectAmbiguousPhases(single)).toEqual([]);
    expect(
      buildWithinPhaseOrder(collectAmbiguousPhases(single), {
        state: 'extracted',
        declared: 1,
        undeclared: 0,
      }),
    ).toBeUndefined();
  });

  it('withholds the counts it cannot support when the vault did not extract', () => {
    const block = buildWithinPhaseOrder(collectAmbiguousPhases(counts), {
      state: 'not-extracted',
      declared: 0,
      undeclared: 0,
    });
    expect(block?.triggerOrderState).toBe('not-extracted');
    expect(block?.flowsDeclaringTriggerOrder).toBeUndefined();
    expect(block?.flowsWithoutTriggerOrder).toBeUndefined();
    expect(block?.caveat).toContain('did not check');
    expect(block?.caveat).toContain('sfi refresh');
  });

  it('says NOT APPLICABLE — never "vault gap" — with no flows on the object', () => {
    const block = buildWithinPhaseOrder(collectAmbiguousPhases(counts), {
      state: 'not-applicable',
      declared: 0,
      undeclared: 0,
    });
    expect(block?.triggerOrderState).toBe('not-applicable');
    expect(block?.flowsDeclaringTriggerOrder).toBeUndefined();
    expect(block?.flowsWithoutTriggerOrder).toBeUndefined();
    // The ambiguity is still disclosed — it is real, and it is about the
    // validation rules / triggers in the phase.
    expect(block?.caveat).toContain('NOT a guaranteed execution order');
    expect(block?.caveat).toContain('NO record-triggered flows');
    // But NOTHING that reads as a coverage gap or a remediation.
    expect(block?.caveat).not.toContain('sfi refresh');
    expect(block?.caveat).not.toContain('did not check');
    expect(block?.caveat).not.toContain('vault gap');
  });
});

describe('what_happens_on_save — within-phase order on a real graph', () => {
  it('SORTS by the declared trigger order, not by component id', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Extracted',
      event: 'insert',
      includeConceptReasoning: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = apiNamesInPhase(result.value.data.soe, 'before-save-flows');
    // Declared ascending (Gamma 10, Alpha 300, Beta 600), then the two that
    // declare none, in ascending id. Ascending id alone would have produced
    // Alpha, Beta, Delta, Epsilon, Gamma — so this cannot pass by accident.
    expect(names).toEqual([
      'GammaExtracted',
      'AlphaExtracted',
      'BetaExtracted',
      'DeltaExtracted',
      'EpsilonExtracted',
    ]);
    const block = result.value.data.withinPhaseOrder;
    expect(block?.determined).toBe(false);
    expect(block?.triggerOrderState).toBe('extracted');
    expect(block?.flowsDeclaringTriggerOrder).toBe(3);
    expect(block?.flowsWithoutTriggerOrder).toBe(2);
    expect(block?.ambiguousPhases).toContainEqual({
      phase: 'before-save-flows',
      steps: 5,
    });
    // An extracted vault has no coverage GAP to disclose.
    expect(result.value.data.coverageCaveat).toBeUndefined();
  });

  it('KEEPS the ascending-id order on a vault that predates extraction', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Predates',
      event: 'insert',
      includeConceptReasoning: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(apiNamesInPhase(result.value.data.soe, 'before-save-flows')).toEqual([
      'AlphaPredates',
      'BetaPredates',
      'GammaPredates',
    ]);
  });

  it('calls the gap a GAP on a vault that predates extraction', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Predates',
      event: 'insert',
      includeConceptReasoning: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const block = result.value.data.withinPhaseOrder;
    expect(block?.triggerOrderState).toBe('not-extracted');
    // "did not check" — never a claim that these flows declare no order.
    expect(block?.caveat).toContain('did not check');
    expect(result.value.data.coverageCaveat?.missingCoverage).toEqual([
      'Flow.triggerOrder',
    ]);
    expect(result.value.data.coverageCaveat?.status).toBe('unknown');
  });

  it('emits NOTHING when every phase holds at most one step', async () => {
    // The byte-identity guarantee for the overwhelming majority of responses.
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Solo',
      event: 'insert',
      includeConceptReasoning: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.withinPhaseOrder).toBeUndefined();
    expect(result.value.data.coverageCaveat).toBeUndefined();
  });

  it('NEVER claims a vault gap for an object with no record-triggered flows', async () => {
    // Three validation rules, zero flows. The phase IS ambiguous, so the
    // ambiguity must be disclosed — but the object has nothing Flow Trigger
    // Order could order, so a `Flow.triggerOrder` coverage claim would be
    // fabricated and its `sfi refresh` remediation would change nothing.
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'NoFlows',
      event: 'insert',
      includeConceptReasoning: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      apiNamesInPhase(result.value.data.soe, 'pre-save-validation'),
    ).toEqual(['VR1', 'VR2', 'VR3']);
    const block = result.value.data.withinPhaseOrder;
    expect(block?.ambiguousPhases).toContainEqual({
      phase: 'pre-save-validation',
      steps: 3,
    });
    expect(block?.triggerOrderState).toBe('not-applicable');
    expect(block?.caveat).toContain('NO record-triggered flows');
    expect(block?.caveat).not.toContain('sfi refresh');
    expect(result.value.data.coverageCaveat).toBeUndefined();
  });
});

describe('order_of_execution — the two SOE tools stay in lockstep', () => {
  it('sorts and discloses identically, naming the EVENT each phase belongs to', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'Extracted',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      apiNamesInPhase(result.value.data.byEvent.insert.soe, 'before-save-flows'),
    ).toEqual([
      'GammaExtracted',
      'AlphaExtracted',
      'BetaExtracted',
      'DeltaExtracted',
      'EpsilonExtracted',
    ]);
    const block = result.value.data.withinPhaseOrder;
    expect(block?.triggerOrderState).toBe('extracted');
    expect(block?.ambiguousPhases).toContainEqual({
      event: 'insert',
      phase: 'before-save-flows',
      steps: 5,
    });
    // delete/undelete carry no before-save flows at all, so they contribute no
    // ambiguous phase — the block must not over-claim across events.
    expect(block?.ambiguousPhases.some((phase) => phase.event === 'delete')).toBe(
      false,
    );
  });

  it('emits NOTHING for an object with at most one step per phase', async () => {
    const result = await orderOfExecutionHandler(ctx, { objectApiName: 'Solo' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.withinPhaseOrder).toBeUndefined();
    expect(result.value.data.coverageCaveat).toBeUndefined();
  });

  it('also withholds the fabricated gap for an object with no flows', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'NoFlows',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const block = result.value.data.withinPhaseOrder;
    expect(block?.triggerOrderState).toBe('not-applicable');
    expect(block?.caveat).toContain('NO record-triggered flows');
    expect(result.value.data.coverageCaveat).toBeUndefined();
  });
});
