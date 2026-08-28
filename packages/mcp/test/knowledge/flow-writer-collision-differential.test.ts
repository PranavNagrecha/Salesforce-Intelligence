/// <reference types="vitest/globals" />

/**
 * DIFFERENTIAL GATE — `rule:automation/flow-field-writer-collision` (the concept
 * model) vs `sfi.automation_collisions` (the direct tool).
 *
 * WHY THIS FILE EXISTS. Both surfaces answer "which fields does more than one
 * automation write?" and each ships its own green suite:
 *   - `seed-concepts.test.ts` runs the RULE through the pure `interpret` engine
 *     over a hand-built slice; it never touches the tool.
 *   - `test/tools/automation-collisions.test.ts` runs the TOOL over a graph; it
 *     never touches the concept model.
 * Nothing ran BOTH over ONE vault, so their answers were free to diverge and
 * every gate stayed green. On a real vault they DO diverge (measured: the rule
 * flags fields on objects where the tool reports zero collisions). This file is
 * the missing gate: it runs both engines over the SAME graph and pins the
 * relationship between them.
 *
 * WHAT WAS ACTUALLY WRONG. Neither engine. They answer DIFFERENT questions and
 * both answer their own correctly:
 *
 *   RULE  — counts DISTINCT Flow nodes with `status === 'Active'` that carry a
 *           `writesTo` edge to the field, however the flow is invoked, whatever
 *           object it is wired to, on any execution path. Roots on the field
 *           NODE.
 *   TOOL  — counts automation reached from the object's own incoming
 *           `triggersOn` edges (Flow + ApexTrigger + WorkflowRule), buckets them
 *           by execution PATH (save vs delete), and lists INACTIVE writers too
 *           (severity `info`: "a dormant writer would collide if reactivated").
 *           Keys on the field ID, so it also reports on ids that exist only as
 *           an edge target.
 *
 * So the honest gate is not `ruleFields === toolFields` — that assertion is
 * FALSE by design and would have to be weakened until it asserted nothing.
 * The gate is two IMPLICATIONS over the shared scope plus a pinned table of
 * every reason they are allowed to differ:
 *
 *   INVARIANT A (tool ⇒ rule) — a save-path collision whose writer set holds
 *     >= 2 distinct ACTIVE Flow components, on a field that EXISTS as a node,
 *     MUST make the rule fire, and the rule must CITE every one of those flows.
 *     The rule's predicate is strictly weaker, so a miss is a rule defect.
 *   INVARIANT B (rule ⇒ tool) — when >= 2 of the flows the rule cites are
 *     ACTIVE and `triggersOn` the field's own object on the SAVE path, the tool
 *     MUST report a save-path collision on that field naming them. A miss is a
 *     tool defect.
 *
 * NON-VACUITY. Both invariants are satisfied by an empty vault, so they are
 * counted, not just checked — `comparisonsA` / `comparisonsB` are asserted
 * non-zero and pinned at their fixture values, the way `HonestyAudit.checks`
 * counts evaluations rather than passes. The DIVERGENCE table below is asserted
 * exhaustively for the same reason: an engine change that silently collapses a
 * divergence cause fails here.
 *
 * The shipped demo vault CANNOT settle this — it holds 2 flows whose write
 * targets are disjoint, so it produces ZERO comparisons in either direction.
 * That gap is asserted explicitly at the bottom rather than left silent.
 *
 * Synthetic placeholder components only — no real org names.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ComponentId, Edge, Node } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  listEdges,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type { ExtendedVaultManifest } from '@sf-intelligence/vault';

import { reasonAboutComponent } from '../../src/knowledge/reason-component.js';
import type { Context } from '../../src/server.js';
import {
  automationCollisionsHandler,
  type FieldCollision,
} from '../../src/tools/automation-collisions.js';
import { scanAllNodesOfTypes } from '../../src/tools/scan-all-nodes.js';

const RULE_ID = 'rule:automation/flow-field-writer-collision';

/**
 * `examples/demo-vault` — the only fully-built vault committed to this repo.
 *
 * Resolved LOCALLY rather than by importing `tests/integration/demo-vault-paths.ts`:
 * that module sits outside this package's `rootDir`, so importing it fails
 * `tsc --noEmit -p packages/mcp/tsconfig.json` (TS6059/TS6307) even though
 * vitest resolves it fine. The one behaviour that matters is copied
 * DELIBERATELY, not incidentally: it THROWS rather than returning a nullable
 * path, because a gate that quietly skips when its fixture is missing is
 * indistinguishable from a passing one.
 */
const demoVaultRoot = (): string => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'examples', 'demo-vault');
  if (!existsSync(join(root, 'graph', 'graph.duckdb'))) {
    throw new Error(
      `demo vault not found at ${root} (expected graph/graph.duckdb). ` +
        `This differential must NOT be skipped — a skipped gate reads as a passing one.`,
    );
  }
  return root;
};

const MANIFEST: ExtendedVaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-01-01T00:00:00.000Z',
  sourceOrg: 'differential-fixture',
  components: { CustomObject: 2, CustomField: 8, Flow: 8 },
  edges: { writesTo: 14, triggersOn: 6 },
  sourceTreeHash: 'sha256:flow-writer-differential',
  coverage: [
    { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false },
    { type: 'CustomField', requested: true, retrieved: 8, errored: false, neverModeled: false },
    { type: 'Flow', requested: true, retrieved: 8, errored: false, neverModeled: false },
    { type: 'ApexTrigger', requested: true, retrieved: 1, errored: false, neverModeled: false },
  ],
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: o.id.split(':')[1] ?? o.id,
  label: null,
  parentId: null,
  sourcePath: 'synthetic.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

const ALPHA = 'CustomObject:Alpha__c';
const BETA = 'CustomObject:Beta__c';

/** Fields that EXIST as nodes. `Ghost__c` deliberately does NOT — see DIVERGENCE 5. */
const F_AGREE = 'CustomField:Alpha__c.Agree__c';
const F_DORMANT = 'CustomField:Alpha__c.Dormant__c';
const F_SCREEN = 'CustomField:Alpha__c.ScreenOnly__c';
const F_CROSS = 'CustomField:Alpha__c.CrossObject__c';
const F_PATH = 'CustomField:Alpha__c.PathSplit__c';
const F_MIXED = 'CustomField:Alpha__c.MixedFamily__c';
const F_GHOST = 'CustomField:Alpha__c.Ghost__c';
const F_QUIET = 'CustomField:Alpha__c.Quiet__c';

const flowNode = (id: string, status: string, processType = 'AutoLaunchedFlow'): Node =>
  node({ id, type: 'Flow', properties: { status, processType } });

const fieldNode = (id: string): Node =>
  node({ id, type: 'CustomField', parentId: ALPHA, properties: { dataType: 'Text' } });

const writes = (flowId: string, fieldId: string): Edge =>
  edge({ fromId: flowId, toId: fieldId, edgeType: 'writesTo', confidence: 'parsed' });

const triggers = (flowId: string, objectId: string, triggerType: string): Edge =>
  edge({
    fromId: flowId,
    toId: objectId,
    edgeType: 'triggersOn',
    properties: { triggerType, recordTriggerType: 'CreateAndUpdate' },
  });

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-writer-diff-'));
  const opened = await openGraph(join(tempDir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;

  const nodes: Node[] = [
    node({ id: ALPHA, type: 'CustomObject' }),
    node({ id: BETA, type: 'CustomObject' }),

    // Record-triggered, after-save, ACTIVE — in BOTH engines' scope.
    flowNode('Flow:Alpha_After_A', 'Active'),
    flowNode('Flow:Alpha_After_B', 'Active'),
    // Record-triggered on Alpha but OBSOLETE — the tool lists it, the rule does not.
    flowNode('Flow:Alpha_After_Obsolete', 'Obsolete'),
    // Before-DELETE on Alpha, ACTIVE — a DELETE-path writer.
    flowNode('Flow:Alpha_BeforeDelete', 'Active'),
    // Screen flows: ACTIVE, no `triggersOn` edge at all — invisible to the tool.
    flowNode('Flow:Alpha_Screen_A', 'Active', 'Flow'),
    flowNode('Flow:Alpha_Screen_B', 'Active', 'Flow'),
    // Record-triggered on BETA, ACTIVE, writing an ALPHA field.
    flowNode('Flow:Beta_After', 'Active'),
    // A non-Flow writer wired to Alpha.
    node({
      id: 'ApexTrigger:Alpha_Trigger',
      type: 'ApexTrigger',
      properties: { status: 'Active', events: ['after insert', 'after update'] },
    }),

    fieldNode(F_AGREE),
    fieldNode(F_DORMANT),
    fieldNode(F_SCREEN),
    fieldNode(F_CROSS),
    fieldNode(F_PATH),
    fieldNode(F_MIXED),
    fieldNode(F_QUIET),
    // F_GHOST has NO node on purpose.
  ];

  const edges: Edge[] = [
    triggers('Flow:Alpha_After_A', ALPHA, 'RecordAfterSave'),
    triggers('Flow:Alpha_After_B', ALPHA, 'RecordAfterSave'),
    triggers('Flow:Alpha_After_Obsolete', ALPHA, 'RecordAfterSave'),
    triggers('Flow:Alpha_BeforeDelete', ALPHA, 'RecordBeforeDelete'),
    triggers('Flow:Beta_After', BETA, 'RecordAfterSave'),
    edge({ fromId: 'ApexTrigger:Alpha_Trigger', toId: ALPHA, edgeType: 'triggersOn' }),

    // AGREE: 2 active, record-triggered, save-path Flow writers. Both must fire.
    writes('Flow:Alpha_After_A', F_AGREE),
    writes('Flow:Alpha_After_B', F_AGREE),

    // DORMANT: 1 active + 1 obsolete, both wired to Alpha.
    writes('Flow:Alpha_After_A', F_DORMANT),
    writes('Flow:Alpha_After_Obsolete', F_DORMANT),

    // SCREEN: 2 active flows with no `triggersOn` edge.
    writes('Flow:Alpha_Screen_A', F_SCREEN),
    writes('Flow:Alpha_Screen_B', F_SCREEN),

    // CROSS: 1 writer wired to Alpha, 1 wired to Beta.
    writes('Flow:Alpha_After_A', F_CROSS),
    writes('Flow:Beta_After', F_CROSS),

    // PATH: an after-SAVE writer and a before-DELETE writer.
    writes('Flow:Alpha_After_A', F_PATH),
    writes('Flow:Alpha_BeforeDelete', F_PATH),

    // MIXED: one Flow + one ApexTrigger, both save-path, both active.
    writes('Flow:Alpha_After_A', F_MIXED),
    edge({
      fromId: 'ApexTrigger:Alpha_Trigger',
      toId: F_MIXED,
      edgeType: 'writesTo',
      confidence: 'heuristic',
    }),

    // GHOST: 2 active record-triggered writers onto a field with NO node.
    writes('Flow:Alpha_After_A', F_GHOST),
    writes('Flow:Alpha_After_B', F_GHOST),

    // QUIET: exactly one writer — neither engine may say anything.
    writes('Flow:Alpha_After_A', F_QUIET),
  ];

  const imported = await importExtractionResults(store, [{ nodes, edges }]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared probes — one call each, so the two engines are compared over identical
// inputs rather than over two hand-written expectations that can drift apart.
// ---------------------------------------------------------------------------

/** Every save-path collision the tool reports for one object. */
const toolCollisions = async (
  context: Context,
  objectApiName: string,
): Promise<readonly FieldCollision[]> => {
  const res = await automationCollisionsHandler(context, { object: objectApiName, limit: 200 });
  if (!res.ok) throw new Error(`tool refused ${objectApiName}: ${JSON.stringify(res.error)}`);
  return res.value.data.collisions;
};

/** The Flow ids the concept rule cites on one field, or null when it stays silent. */
const ruleFlowsFor = async (
  context: Context,
  fieldId: ComponentId,
): Promise<readonly string[] | null> => {
  const res = await reasonAboutComponent(context, fieldId, { ruleIds: [RULE_ID] });
  if (!res.ok) return null; // e.g. `component-not-found` for an edge-only field id
  const fired = res.value.interpretations.filter((i) => i.ruleId === RULE_ID);
  if (fired.length === 0) return null;
  return fired.flatMap((i) => i.groundedIn.filter((g) => g.startsWith('Flow:')));
};

/** Which of `flowIds` are ACTIVE and `triggersOn` `objectApiName` on the SAVE path. */
const saveWiredActiveFlows = async (
  context: Context,
  flowIds: readonly string[],
  objectApiName: string,
): Promise<readonly string[]> => {
  const out: string[] = [];
  for (const flowId of flowIds) {
    const trig = await listEdges(context.graph, flowId as ComponentId, {
      direction: 'out',
      edgeType: 'triggersOn',
    });
    if (!trig.ok) continue;
    const wired = trig.value.some(
      (e) =>
        e.toId === `CustomObject:${objectApiName}` &&
        (e.properties['triggerType'] === 'RecordAfterSave' ||
          e.properties['triggerType'] === 'RecordBeforeSave'),
    );
    if (wired) out.push(flowId);
  }
  return out;
};

/**
 * Run BOTH invariants over one vault. Returns the comparison COUNTS as well as
 * the violations, because "no violations" over zero comparisons asserts nothing.
 */
const runDifferential = async (
  context: Context,
): Promise<{
  comparisonsA: number;
  comparisonsB: number;
  violationsA: string[];
  violationsB: string[];
  edgeOnlyFieldIds: string[];
}> => {
  const objectScan = await scanAllNodesOfTypes(context.graph, ['CustomObject']);
  if (!objectScan.ok) throw new Error(objectScan.error.message);
  const fieldScan = await scanAllNodesOfTypes(context.graph, ['CustomField']);
  if (!fieldScan.ok) throw new Error(fieldScan.error.message);
  const fieldNodeIds = new Set(fieldScan.value.nodes.map((n) => n.id));

  let comparisonsA = 0;
  let comparisonsB = 0;
  const violationsA: string[] = [];
  const violationsB: string[] = [];
  const edgeOnlyFieldIds: string[] = [];

  // --- INVARIANT A: tool ⇒ rule -------------------------------------------
  for (const objectNode of objectScan.value.nodes) {
    const objectApiName = objectNode.id.slice('CustomObject:'.length);
    for (const collision of await toolCollisions(context, objectApiName)) {
      if (collision.collisionPath !== 'save') continue;
      const activeFlowWriters = collision.writers
        .filter((w) => w.componentType === 'Flow' && w.active)
        .map((w) => w.componentId);
      if (activeFlowWriters.length < 2) continue;
      if (!fieldNodeIds.has(collision.fieldId)) {
        // The rule roots on NODES and cannot reach an id that exists only as an
        // edge target. Recorded, never silently skipped (DIVERGENCE 5).
        edgeOnlyFieldIds.push(collision.fieldId);
        continue;
      }
      comparisonsA += 1;
      const cited = await ruleFlowsFor(context, collision.fieldId);
      if (cited === null) {
        violationsA.push(
          `${collision.fieldId}: tool names ${String(activeFlowWriters.length)} active Flow writers, rule silent`,
        );
        continue;
      }
      const missing = activeFlowWriters.filter((w) => !cited.includes(w));
      if (missing.length > 0) {
        violationsA.push(`${collision.fieldId}: rule did not cite ${missing.join(',')}`);
      }
    }
  }

  // --- INVARIANT B: rule ⇒ tool -------------------------------------------
  const saveCollisionFieldsByObject = new Map<string, Set<string>>();
  for (const objectNode of objectScan.value.nodes) {
    const objectApiName = objectNode.id.slice('CustomObject:'.length);
    const set = new Set<string>();
    for (const collision of await toolCollisions(context, objectApiName)) {
      if (collision.collisionPath === 'save') set.add(collision.fieldId);
    }
    saveCollisionFieldsByObject.set(objectApiName, set);
  }
  for (const field of fieldScan.value.nodes) {
    const cited = await ruleFlowsFor(context, field.id);
    if (cited === null) continue;
    const objectApiName = field.id.slice('CustomField:'.length).split('.')[0] ?? '';
    const wired = await saveWiredActiveFlows(context, cited, objectApiName);
    if (wired.length < 2) continue;
    comparisonsB += 1;
    if (!(saveCollisionFieldsByObject.get(objectApiName)?.has(field.id) ?? false)) {
      violationsB.push(
        `${field.id}: rule cites ${String(wired.length)} active save-wired flows, tool reports no save collision`,
      );
    }
  }

  return { comparisonsA, comparisonsB, violationsA, violationsB, edgeOnlyFieldIds };
};

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

describe('DIFFERENTIAL — concept rule vs sfi.automation_collisions over ONE vault', () => {
  it('INVARIANT A (tool ⇒ rule) and B (rule ⇒ tool) hold, and the comparison COUNT is non-zero', async () => {
    const result = await runDifferential(ctx);

    // Non-vacuity FIRST. An empty vault satisfies both implications; this suite
    // only means something if it actually compared something. The counts are
    // pinned at their fixture values so a change that stops exercising the
    // shared scope fails here instead of passing quietly.
    // `expect.soft` so a real INVARIANT violation is always reported even when
    // the comparison count drifted in the same run — a hard assert on the count
    // would hide the violation behind it, which is how a differential ends up
    // reporting the wrong cause.
    expect.soft(result.comparisonsA).toBe(1); // F_AGREE
    expect.soft(result.comparisonsB).toBe(1); // F_AGREE
    expect.soft(result.comparisonsA).toBeGreaterThan(0);
    expect.soft(result.comparisonsB).toBeGreaterThan(0);

    expect.soft(result.violationsA).toEqual([]);
    expect.soft(result.violationsB).toEqual([]);
    expect(result.violationsA.length + result.violationsB.length).toBe(0);
  });

  it('both engines fire on the shared-scope field and name the SAME two flows', async () => {
    const collisions = await toolCollisions(ctx, 'Alpha__c');
    const agree = collisions.find((c) => c.fieldId === F_AGREE && c.collisionPath === 'save');
    expect(agree).toBeDefined();
    const toolFlows = (agree?.writers ?? [])
      .filter((w) => w.componentType === 'Flow' && w.active)
      .map((w) => w.componentId)
      .sort();
    expect(toolFlows).toEqual(['Flow:Alpha_After_A', 'Flow:Alpha_After_B']);

    const ruleFlows = [...(await ruleFlowsFor(ctx, F_AGREE) ?? [])].sort();
    expect(ruleFlows).toEqual(toolFlows);
  });

  it('neither engine invents a finding on a field with exactly ONE writer', async () => {
    expect(await ruleFlowsFor(ctx, F_QUIET)).toBeNull();
    const collisions = await toolCollisions(ctx, 'Alpha__c');
    expect(collisions.some((c) => c.fieldId === F_QUIET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The DIVERGENCE table. Every case below is a place the two surfaces are ALLOWED
// to disagree, with the reason pinned. This is the other half of the gate: an
// unexplained disagreement fails INVARIANT A/B above, and an explained one that
// silently changes shape fails here.
// ---------------------------------------------------------------------------

describe('DIVERGENCE table — the reasons the two surfaces may differ, each pinned', () => {
  it('1 — ACTIVITY FILTER: an obsolete flow is a tool writer (severity info) but never a rule writer', async () => {
    const collisions = await toolCollisions(ctx, 'Alpha__c');
    const dormant = collisions.find((c) => c.fieldId === F_DORMANT);
    expect(dormant).toBeDefined();
    expect(dormant?.writers.map((w) => w.componentId).sort()).toEqual([
      'Flow:Alpha_After_A',
      'Flow:Alpha_After_Obsolete',
    ]);
    // The tool lists the dormant writer but does NOT claim it runs: the count
    // of writers that would actually execute today is 1. NOTE the severity is
    // `medium`, NOT `info` — `collisionSeverity` reserves `info` for a bucket
    // where EVERY writer is dormant, and rates a single-live-writer bucket
    // `medium` on the "it would collide if reactivated" reading. That is the
    // same grade a genuine two-active collision gets when a heuristic Apex
    // write drags its confidence down, so `activeWriterCount` — not
    // `severity` — is the field that separates a live race from a dead one.
    expect(dormant?.activeWriterCount).toBe(1);
    expect(dormant?.severity).toBe('medium');
    // The rule counts ACTIVE flows only, so one active writer is not a race.
    expect(await ruleFlowsFor(ctx, F_DORMANT)).toBeNull();
  });

  it('2 — INVOCATION SCOPE: two active screen flows are a rule finding and invisible to the tool', async () => {
    const ruleFlows = [...(await ruleFlowsFor(ctx, F_SCREEN) ?? [])].sort();
    expect(ruleFlows).toEqual(['Flow:Alpha_Screen_A', 'Flow:Alpha_Screen_B']);
    // The tool walks the object's incoming `triggersOn` edges; a flow with none
    // is not reachable from the object, so it reports nothing.
    const collisions = await toolCollisions(ctx, 'Alpha__c');
    expect(collisions.some((c) => c.fieldId === F_SCREEN)).toBe(false);
  });

  it('3 — CROSS-OBJECT WRITER: a flow wired to another object counts for the rule, not the tool', async () => {
    const ruleFlows = [...(await ruleFlowsFor(ctx, F_CROSS) ?? [])].sort();
    expect(ruleFlows).toEqual(['Flow:Alpha_After_A', 'Flow:Beta_After']);
    // Querying Alpha__c: Beta_After is not one of Alpha's firers.
    expect((await toolCollisions(ctx, 'Alpha__c')).some((c) => c.fieldId === F_CROSS)).toBe(false);
    // Querying Beta__c: the write target is not a Beta field, so it is filtered out.
    expect((await toolCollisions(ctx, 'Beta__c')).some((c) => c.fieldId === F_CROSS)).toBe(false);
  });

  it('4 — EXECUTION PATH: the tool splits save from delete; the rule has no path model', async () => {
    const ruleFlows = [...(await ruleFlowsFor(ctx, F_PATH) ?? [])].sort();
    expect(ruleFlows).toEqual(['Flow:Alpha_After_A', 'Flow:Alpha_BeforeDelete']);
    // The tool buckets them on DISJOINT paths, so neither bucket reaches 2.
    expect((await toolCollisions(ctx, 'Alpha__c')).some((c) => c.fieldId === F_PATH)).toBe(false);
    // The rule's own claim carries the hedge that makes this honest rather than
    // a false alarm — it never asserts the flows actually co-execute.
    const res = await reasonAboutComponent(ctx, F_PATH, { ruleIds: [RULE_ID] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const claim = res.value.interpretations[0]?.claim ?? '';
    expect(claim.toLowerCase()).toContain('does not assert the flows actually collide');
  });

  it('5 — ROOTABILITY: the tool reports on an edge-only field id the rule can never root on', async () => {
    const collisions = await toolCollisions(ctx, 'Alpha__c');
    const ghost = collisions.find((c) => c.fieldId === F_GHOST);
    expect(ghost).toBeDefined();
    expect(ghost?.activeWriterCount).toBe(2);
    // No CustomField node exists for it, so the rule cannot be asked at all.
    const res = await reasonAboutComponent(ctx, F_GHOST, { ruleIds: [RULE_ID] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('component-not-found');
  });

  it('6 — WRITER FAMILY: a Flow + ApexTrigger pair is a tool collision and not a rule finding', async () => {
    const collisions = await toolCollisions(ctx, 'Alpha__c');
    const mixed = collisions.find((c) => c.fieldId === F_MIXED);
    expect(mixed).toBeDefined();
    expect(mixed?.writers.map((w) => w.componentType).sort()).toEqual(['ApexTrigger', 'Flow']);
    // The rule binds `componentTypes: [Flow]`, so one Flow writer is not a race.
    expect(await ruleFlowsFor(ctx, F_MIXED)).toBeNull();
  });

  it('the table is EXHAUSTIVE for this fixture — every tool/rule disagreement has a pinned cause', async () => {
    const explained = new Set([F_DORMANT, F_SCREEN, F_CROSS, F_PATH, F_GHOST, F_MIXED]);
    const fieldScan = await scanAllNodesOfTypes(ctx.graph, ['CustomField']);
    if (!fieldScan.ok) throw new Error(fieldScan.error.message);

    const toolFields = new Set<string>();
    for (const objectApiName of ['Alpha__c', 'Beta__c']) {
      for (const c of await toolCollisions(ctx, objectApiName)) toolFields.add(c.fieldId);
    }
    const ruleFields = new Set<string>();
    for (const f of fieldScan.value.nodes) {
      if ((await ruleFlowsFor(ctx, f.id)) !== null) ruleFields.add(f.id);
    }

    // The raw sets DO differ — that is the measured bug report, reproduced.
    expect([...ruleFields].sort()).not.toEqual([...toolFields].sort());

    const disagreements = [
      ...[...ruleFields].filter((f) => !toolFields.has(f)),
      ...[...toolFields].filter((f) => !ruleFields.has(f)),
    ];
    // Non-vacuity: the fixture really does reproduce a disagreement.
    expect(disagreements.length).toBe(explained.size);
    expect(disagreements.filter((f) => !explained.has(f))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shipped demo vault, asserted honestly.
// ---------------------------------------------------------------------------

describe('FIXTURE GAP — the shipped demo vault cannot settle this differential', () => {
  it('holds no field written by two flows, so it yields ZERO comparisons in either direction', async () => {
    const { buildContext, shutdown } = await import('../../src/index.js');
    const built = await buildContext(demoVaultRoot());
    if (!built.ok) throw new Error(built.error.message);
    try {
      const result = await runDifferential(built.value);
      // The invariants hold — VACUOUSLY. Asserting only this would be the
      // exact "passes while asserting nothing" failure this file exists to end.
      expect(result.violationsA).toEqual([]);
      expect(result.violationsB).toEqual([]);
      // ...and here is the proof it asserted nothing. When the demo vault grows
      // a real two-flow write collision this pin flips and the maintainer must
      // move the real assertion here instead of leaving it on the synthetic
      // fixture above.
      expect(result.comparisonsA).toBe(0);
      expect(result.comparisonsB).toBe(0);
      expect(result.edgeOnlyFieldIds).toEqual([]);
    } finally {
      await shutdown(built.value);
    }
  }, 120_000);
});
