/// <reference types="vitest/globals" />

/**
 * SLICE-TRUNCATION HONESTY — the evidence slice gets CLIPPED at a cap, and a
 * rule starved by that clip used to be reported as `checkedClean`.
 *
 * The defect, precisely. `reasonAboutComponent` caps the assembled slice at
 * `SLICE_EDGE_CAP` (1-hop incident edges) and `JOIN_FANOUT_CAP` (five
 * second-hop expansions). Every cap site DOES set `sliceTruncated` — that half
 * was already honest. What was NOT honest is what the CLASSIFIER then did with
 * it: `classifyRuleCoverage` never read the flag, so an edge-shaped rule that
 * ran against a slice missing most of its evidence and matched nothing landed
 * in `rulesCheckedClean` / `conceptsCheckedClean` — the typed field whose
 * documented meaning is "really evaluated against a slice carrying the shape it
 * binds on, and matched nothing".
 *
 * A machine consumer reads that count. The prose caveat and the separate
 * `sliceTruncated` boolean are both skippable, and skipping them is exactly how
 * a wrong answer gets produced: "0 findings, all rules checked clean" over a
 * slice that dropped most of the graph.
 *
 * The fix must be PRECISE in both directions, so this file pins both:
 *   - a rule whose evaluation reads the SLICE EDGES cannot be certified clean
 *     over a clipped slice (it becomes unevaluable, typed `slice-truncated`);
 *   - a NODE-shaped rule — `runBind`'s node branch matches the ROOT NODE ONLY,
 *     and the root node is in the slice unconditionally — is provably NOT
 *     starved by an EDGE cap and must STAY `checkedClean`. Blanket-demoting
 *     every rule on truncation would trade one dishonest answer for another.
 *
 * Hermetic: a synthetic in-memory graph, fabricated ids only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ComponentId,
  ConceptRule,
  Edge,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  type GraphStore,
  importExtractionResults,
  openGraph,
} from '@sf-intelligence/graph';

import { CONCEPT_RULES } from '../../src/knowledge/loader.js';
import {
  classifyRuleCoverage,
  createSliceBudget,
  JOIN_FANOUT_CAP,
  reasonAboutComponent,
  type ReasonContext,
  SLICE_EDGE_CAP,
  UNEVALUABLE_REASONS,
  zeroUnevaluableCounts,
} from '../../src/knowledge/reason-component.js';
import { toCompletenessDigest } from '../../src/tools/concept-reasoning.js';

// ---------------------------------------------------------------------------
// Fixtures — fabricated ids only.
// ---------------------------------------------------------------------------

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
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
  source: 'synthetic-test',
  properties: {},
  ...overrides,
});

const COVERED_TYPES = [...new Set(CONCEPT_RULES.flatMap((r) => r.dependsOnCoverage))].sort();

/**
 * A manifest that CONFIRMS retrieval of every family every rule depends on, so
 * `vault-coverage-missing` can never fire here. Truncation is then the ONLY
 * thing that can move a rule out of the clean bucket — which is what makes the
 * control/treatment pair below a proof rather than a coincidence.
 */
const COVERED_MANIFEST = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'tester@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-truncation-honesty',
  coverage: COVERED_TYPES.map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
    retrieveConfirmed: true,
  })),
} as unknown as VaultManifest;

/** An EDGE-shaped rule: no sub-shape, one bound `edgeType`. Reads slice edges. */
const EDGE_RULE: ConceptRule = CONCEPT_RULES.find(
  (r) => r.bind.edgeType === 'triggersOn' && r.bind.join === undefined,
)!;

/**
 * A NODE-shaped rule: no `edgeType`, no sub-shape, a `componentTypes` gate.
 * `runBind`'s node branch scopes it to the ROOT NODE ONLY, so an EDGE cap
 * cannot starve it.
 */
const NODE_RULE: ConceptRule = CONCEPT_RULES.find(
  (r) =>
    r.bind.edgeType === undefined &&
    r.bind.join === undefined &&
    r.bind.aggregate === undefined &&
    r.bind.antiJoin === undefined &&
    r.bind.dualEdge === undefined &&
    r.bind.setDifference === undefined &&
    r.bind.crossObjectCascade === undefined &&
    r.bind.componentTypes !== undefined &&
    r.bind.componentTypes.includes('ApexClass'),
)!;

const HUB_OBJ = 'CustomObject:TruncHub__c' as ComponentId;
const SMALL_OBJ = 'CustomObject:TruncSmall__c' as ComponentId;
const OVER_CAP = SLICE_EDGE_CAP + 1;

/** A one-incident-edge slice: `triggersOn` is INCIDENT, so an edge rule is applicable. */
const sliceWithIncidentTriggersOn = (rootId: ComponentId) => ({
  nodes: [
    makeNode({ id: rootId, type: 'CustomObject', apiName: 'TruncHub__c' }),
    makeNode({ id: 'ApexTrigger:T0' as ComponentId, type: 'ApexTrigger', apiName: 'T0' }),
  ],
  edges: [
    makeEdge({
      fromId: 'ApexTrigger:T0' as ComponentId,
      toId: rootId,
      edgeType: 'triggersOn',
    }),
  ],
});

const classify = (args: {
  rootType: Node['type'];
  rules: readonly ConceptRule[];
  rootId: ComponentId;
  truncated: boolean;
  slice: { nodes: Node[]; edges: Edge[] };
}) =>
  classifyRuleCoverage({
    rootType: args.rootType,
    selectedRules: args.rules,
    interpretations: [],
    slice: args.slice,
    rootId: args.rootId,
    missingCoverageTypes: new Set<string>(),
    coverageKnown: true,
    sliceTruncated: args.truncated,
  });

// ---------------------------------------------------------------------------
// 1. The classifier — an edge-reading rule cannot be "clean" over a clipped slice
// ---------------------------------------------------------------------------

describe('classifyRuleCoverage — a truncated slice cannot certify a rule clean', () => {
  it('the fixtures are the shapes this file claims they are', () => {
    expect(EDGE_RULE, 'need one plain edge-shaped rule').toBeDefined();
    expect(NODE_RULE, 'need one plain node-shaped rule').toBeDefined();
    expect(EDGE_RULE.bind.edgeType).toBe('triggersOn');
    expect(NODE_RULE.bind.edgeType).toBeUndefined();
  });

  it('CONTROL — an UNtruncated slice still reports the edge rule checked-clean', () => {
    const report = classify({
      rootType: 'CustomObject',
      rules: [EDGE_RULE],
      rootId: HUB_OBJ,
      truncated: false,
      slice: sliceWithIncidentTriggersOn(HUB_OBJ),
    });
    expect(report.rulesCheckedClean).toBe(1);
    expect(report.rulesNotEvaluable).toBe(0);
  });

  it('an edge-reading rule that matched nothing over a TRUNCATED slice is UNEVALUABLE, not clean', () => {
    const report = classify({
      rootType: 'CustomObject',
      rules: [EDGE_RULE],
      rootId: HUB_OBJ,
      truncated: true,
      slice: sliceWithIncidentTriggersOn(HUB_OBJ),
    });
    // THE DEFECT: this used to be 1 — "evaluated against this component and
    // found nothing" — over a slice that had been clipped at the cap.
    expect(report.rulesCheckedClean, 'a clipped slice cannot certify a rule clean').toBe(0);
    expect(report.conceptsCheckedClean).toEqual([]);
    // And it must carry a TYPED marker, not merely a prose caveat: a consumer
    // reading only the counts must still see "unknown".
    expect(report.rulesNotEvaluable).toBe(1);
    const row = report.conceptsNotEvaluable[0]!;
    expect(row.ruleId).toBe(EDGE_RULE.id);
    expect(row.reason).toBe('slice-truncated');
    // Nothing was missing from the VAULT — this is a slice clip, and the empty
    // list must not imply a retrieval gap (whose remedy is the opposite advice).
    expect(row.missingCoverage).toEqual([]);
  });

  it('PRECISION — a NODE-shaped rule stays checked-clean: an EDGE cap cannot starve it', () => {
    const report = classify({
      rootType: 'ApexClass',
      rules: [NODE_RULE],
      rootId: 'ApexClass:TEST_Plain' as ComponentId,
      truncated: true,
      slice: {
        nodes: [
          makeNode({ id: 'ApexClass:TEST_Plain' as ComponentId, type: 'ApexClass', apiName: 'TEST_Plain' }),
        ],
        edges: [],
      },
    });
    // `runBind`'s node branch matches the ROOT NODE ONLY, and the root node is
    // in every slice unconditionally. Demoting this would manufacture a false
    // "unknown" — the opposite dishonesty, equally wrong.
    expect(report.rulesCheckedClean).toBe(1);
    expect(report.rulesNotEvaluable).toBe(0);
  });

  it('a rule that FIRED over a truncated slice stays FIRED — evidence is never demoted', () => {
    const report = classifyRuleCoverage({
      rootType: 'CustomObject',
      selectedRules: [EDGE_RULE],
      interpretations: [
        {
          ruleId: EDGE_RULE.id,
          concept: EDGE_RULE.concept,
          claim: 'fixture claim',
          groundedIn: ['ApexTrigger:T0' as ComponentId],
          confidence: 'parsed',
          coverageCaveat: 'slice truncated',
          modelVersion: 'test',
          provenance: 'offline_snapshot',
        },
      ],
      slice: sliceWithIncidentTriggersOn(HUB_OBJ),
      rootId: HUB_OBJ,
      missingCoverageTypes: new Set<string>(),
      coverageKnown: true,
      sliceTruncated: true,
    });
    expect(report.rulesFired).toBe(1);
    expect(report.rulesNotEvaluable).toBe(0);
    expect(report.rulesCheckedClean).toBe(0);
  });

  it('the four buckets stay an exact partition under truncation', () => {
    const report = classify({
      rootType: 'CustomObject',
      rules: CONCEPT_RULES,
      rootId: HUB_OBJ,
      truncated: true,
      slice: sliceWithIncidentTriggersOn(HUB_OBJ),
    });
    expect(
      report.rulesFired +
        report.rulesCheckedClean +
        report.rulesNotApplicable +
        report.rulesNotEvaluable,
    ).toBe(report.rulesConsidered);
  });

  it('the SUMMARY names the truncated rules rather than counting them as clean', () => {
    const report = classify({
      rootType: 'CustomObject',
      rules: [EDGE_RULE],
      rootId: HUB_OBJ,
      truncated: true,
      slice: sliceWithIncidentTriggersOn(HUB_OBJ),
    });
    expect(report.summary).toContain('truncated');
    expect(report.summary).not.toContain('1 were evaluated against this component and found nothing');
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end — the real cap, the real classifier, a control beside it
// ---------------------------------------------------------------------------

describe('reasonAboutComponent — hub-cap truncation reaches the coverage report', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: ReasonContext;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-reason-trunc-'));
    const opened = await openGraph(join(dir, 't.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;

    const nodes: Node[] = [
      makeNode({ id: HUB_OBJ, type: 'CustomObject', apiName: 'TruncHub__c' }),
      makeNode({ id: SMALL_OBJ, type: 'CustomObject', apiName: 'TruncSmall__c' }),
    ];
    const edges: Edge[] = [];
    // HUB: one past the cap, so the 1-hop assembly clips.
    for (let i = 0; i < OVER_CAP; i++) {
      const trig = `ApexTrigger:HubTrig${i}` as ComponentId;
      nodes.push(makeNode({ id: trig, type: 'ApexTrigger', apiName: `HubTrig${i}` }));
      edges.push(makeEdge({ fromId: trig, toId: HUB_OBJ, edgeType: 'triggersOn' }));
    }
    // CONTROL: the SAME shape, two edges. Same manifest, same rules.
    for (let i = 0; i < 2; i++) {
      const trig = `ApexTrigger:SmallTrig${i}` as ComponentId;
      nodes.push(makeNode({ id: trig, type: 'ApexTrigger', apiName: `SmallTrig${i}` }));
      edges.push(makeEdge({ fromId: trig, toId: SMALL_OBJ, edgeType: 'triggersOn' }));
    }
    const imp = await importExtractionResults(store, [{ nodes, edges }]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { graph: store, manifest: COVERED_MANIFEST as never, vaultRoot: dir };
  }, 120_000);

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('CONTROL — the un-truncated twin reports NO truncation-starved rule', async () => {
    const r = await reasonAboutComponent(ctx, SMALL_OBJ);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sliceTruncated).toBe(false);
    expect(r.value.truncatedExpansions).toEqual([]);
    expect(
      r.value.coverageReport.conceptsNotEvaluable.filter((x) => x.reason === 'slice-truncated'),
    ).toEqual([]);
    expect(r.value.coverageReport.rulesCheckedClean).toBeGreaterThan(0);
  });

  it('a hub past SLICE_EDGE_CAP demotes its edge-reading rules out of checked-clean', async () => {
    const hub = await reasonAboutComponent(ctx, HUB_OBJ);
    const small = await reasonAboutComponent(ctx, SMALL_OBJ);
    expect(hub.ok && small.ok).toBe(true);
    if (!hub.ok || !small.ok) return;

    expect(hub.value.sliceTruncated).toBe(true);
    // The ONE boundary records WHERE it clipped — six bare `break`s recorded
    // nothing but the bare boolean.
    expect(hub.value.truncatedExpansions).toContain('root-incident-edges');

    const starved = hub.value.coverageReport.conceptsNotEvaluable.filter(
      (x) => x.reason === 'slice-truncated',
    );
    expect(starved.length, 'the clip must be visible per-rule, not only as a boolean').toBeGreaterThan(0);
    // Same manifest, same rule set, same edge type — the ONLY difference is the
    // clip, so the clean count must be strictly lower on the truncated side.
    expect(hub.value.coverageReport.rulesCheckedClean).toBeLessThan(
      small.value.coverageReport.rulesCheckedClean,
    );
    // Not one starved rule may also be reported clean.
    for (const row of starved) {
      expect(hub.value.coverageReport.conceptsCheckedClean).not.toContain(row.concept);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The ONE boundary — the cap is applied in exactly one place, and it records
// ---------------------------------------------------------------------------

describe('SliceBudget — one boundary, and it cannot clip silently', () => {
  it('the reason taxonomy is exhaustive and zeroable without hand-listing it', () => {
    expect([...UNEVALUABLE_REASONS]).toContain('slice-truncated');
    // Every reason gets a zero. A consumer that builds its count-by-reason
    // record from a hand-written literal drifts the moment a reason is added —
    // which is exactly what happened, and why this factory exists.
    expect(Object.keys(zeroUnevaluableCounts()).sort()).toEqual([...UNEVALUABLE_REASONS].sort());
    for (const reason of UNEVALUABLE_REASONS) {
      expect(zeroUnevaluableCounts()[reason]).toBe(0);
    }
  });

  it('an untouched budget is not truncated and names no site', () => {
    const budget = createSliceBudget(0);
    expect(budget.truncated).toBe(false);
    expect(budget.expansions).toEqual([]);
  });

  it('admits exactly JOIN_FANOUT_CAP, then refuses AND records the site', () => {
    const budget = createSliceBudget(7);
    // `admitEdge` subtracts the 1-hop base itself — no caller re-derives it.
    expect(budget.admitEdge('join-second-ground-edges', 7 + JOIN_FANOUT_CAP - 1)).toBe(true);
    expect(budget.truncated).toBe(false);
    expect(budget.admitEdge('join-second-ground-edges', 7 + JOIN_FANOUT_CAP)).toBe(false);
    expect(budget.truncated).toBe(true);
    expect(budget.expansions).toEqual(['join-second-ground-edges']);
  });

  it('records every distinct site once, sorted — a boolean could name none', () => {
    const budget = createSliceBudget(0);
    budget.clip('root-incident-edges');
    expect(budget.admitItem('join-shared-keys', JOIN_FANOUT_CAP)).toBe(false);
    expect(budget.admitItem('join-shared-keys', JOIN_FANOUT_CAP + 5)).toBe(false);
    expect(budget.expansions).toEqual(['join-shared-keys', 'root-incident-edges']);
  });
});

// ---------------------------------------------------------------------------
// 4. The MACHINE consumer — the signal survives the digest projection
// ---------------------------------------------------------------------------

describe('toCompletenessDigest — the starved rules reach the consumer as COUNTS', () => {
  it('a clipped slice moves rules out of rulesCheckedClean and into the typed reason split', () => {
    const report = classify({
      rootType: 'CustomObject',
      rules: [EDGE_RULE],
      rootId: HUB_OBJ,
      truncated: true,
      slice: sliceWithIncidentTriggersOn(HUB_OBJ),
    });
    const digest = toCompletenessDigest(report);
    // A machine consumer reads THESE. It never reads the caveat, which is how
    // the wrong access-control answer got out.
    expect(digest.rulesCheckedClean).toBe(0);
    expect(digest.rulesNotEvaluable).toBe(1);
    expect(digest.rulesNotEvaluableByReason['slice-truncated']).toBe(1);
    // And the split still accounts for every unevaluable rule.
    expect(
      UNEVALUABLE_REASONS.reduce((n, r) => n + (digest.rulesNotEvaluableByReason[r] ?? 0), 0),
    ).toBe(digest.rulesNotEvaluable);
  });
});
