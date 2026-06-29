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
  scheduledJobCatalogHandler,
  scheduledJobCatalogInputSchema,
} from '../../src/tools/scheduled-job-catalog.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 5 },
  edges: { dispatchesAsync: 3 },
  sourceTreeHash: 'sha256:scheduled-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'placeholder',
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
  confidence: 'declared',
  source: 'apex-class-extractor',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed 1: a Schedulable class (NightlyJob) invoked from two callers via
// System.schedule(...). One caller writes a literal cron expression in the
// edge properties; the other writes nothing (the v1.5 scanner does not
// extract cron strings, so cronExpression is null on those edges).
// =============================================================================

const NIGHTLY_JOB = 'ApexClass:NightlyJob';
const SCHEDULER_A = 'ApexClass:SchedulerSetupA';
const SCHEDULER_B = 'ApexClass:SchedulerSetupB';

const scheduledSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NIGHTLY_JOB,
      apiName: 'NightlyJob',
      properties: { isSchedulable: true, isTest: false },
    }),
    makeNode({ id: SCHEDULER_A, apiName: 'SchedulerSetupA' }),
    makeNode({ id: SCHEDULER_B, apiName: 'SchedulerSetupB' }),
  ],
  edges: [
    makeEdge({
      fromId: SCHEDULER_A,
      toId: NIGHTLY_JOB,
      edgeType: 'dispatchesAsync',
      properties: {
        dispatchMechanism: 'schedule',
        cronExpression: '0 0 2 * * ?',
      },
    }),
    makeEdge({
      fromId: SCHEDULER_B,
      toId: NIGHTLY_JOB,
      edgeType: 'dispatchesAsync',
      properties: { dispatchMechanism: 'schedule' },
    }),
  ],
};

// =============================================================================
// Seed 2: a Schedulable class with no known callers (the class is
// schedule-capable but no static call site exists in the codebase). Should
// surface in the catalog with an empty `scheduledByCalls` array.
// =============================================================================

const ORPHAN_SCHEDULABLE = 'ApexClass:OrphanSchedulable';

const orphanSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ORPHAN_SCHEDULABLE,
      apiName: 'OrphanSchedulable',
      properties: { isSchedulable: true },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 3: a non-Schedulable class (Queueable). The catalog should NOT
// surface it.
// =============================================================================

const QUEUEABLE_JOB = 'ApexClass:QueueableJob';

const queueableSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: QUEUEABLE_JOB,
      apiName: 'QueueableJob',
      properties: { isSchedulable: false, isQueueable: true },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 4: a Schedulable class with `enqueueJob`-mechanism inbound edges
// (NOT 'schedule'). The catalog should surface the class but should NOT
// surface those edges as scheduled callers.
// =============================================================================

const MIXED_DISPATCH = 'ApexClass:MixedDispatchTarget';
const MIXED_CALLER = 'ApexClass:MixedDispatchCaller';

const mixedSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: MIXED_DISPATCH,
      apiName: 'MixedDispatchTarget',
      properties: { isSchedulable: true, cronExpressions: ['0 0 4 * * ?'] },
    }),
    makeNode({ id: MIXED_CALLER, apiName: 'MixedDispatchCaller' }),
  ],
  edges: [
    makeEdge({
      fromId: MIXED_CALLER,
      toId: MIXED_DISPATCH,
      edgeType: 'dispatchesAsync',
      properties: { dispatchMechanism: 'enqueueJob' },
    }),
  ],
};

// =============================================================================
// Seed 5 (T7): two Flow nodes — one with a <start><schedule> block (the
// extractor stamped scheduleFrequency/StartDate/StartTime), one without
// (a record-triggered flow). Only the scheduled flow should surface in the
// scheduledFlows section.
// =============================================================================

const SCHEDULED_FLOW = 'Flow:ScheduledPaymentStatusUpdate';
const RECORD_FLOW = 'Flow:RecordTriggeredFlow';

const flowSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: SCHEDULED_FLOW,
      type: 'Flow',
      apiName: 'ScheduledPaymentStatusUpdate',
      sourcePath: 'unused.flow-meta.xml',
      properties: {
        scheduleFrequency: 'Weekly',
        scheduleStartDate: '2024-11-09',
        scheduleStartTime: '08:00:00.000Z',
      },
    }),
    makeNode({
      id: RECORD_FLOW,
      type: 'Flow',
      apiName: 'RecordTriggeredFlow',
      sourcePath: 'unused.flow-meta.xml',
      properties: {
        triggerObject: 'Account',
        scheduleFrequency: null,
        scheduleStartDate: null,
        scheduleStartTime: null,
      },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-scheduled-job-'));
  const opened = await openGraph(join(tempDir, 'scheduled.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    scheduledSeed,
    orphanSeed,
    queueableSeed,
    mixedSeed,
    flowSeed,
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

describe('scheduledJobCatalogHandler', () => {
  it('surfaces every Schedulable class with scheduled callers', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    const nightly = d.jobs.find((j) => j.classId === NIGHTLY_JOB);
    expect(nightly).toBeDefined();
    expect(nightly?.isSchedulable).toBe(true);
    expect(nightly?.scheduledByCalls).toHaveLength(2);
    const callers = nightly?.scheduledByCalls.map((c) => c.callerClassId);
    expect(callers).toContain(SCHEDULER_A);
    expect(callers).toContain(SCHEDULER_B);
  });

  it('surfaces an orphan Schedulable class with an empty scheduledByCalls list', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const orphan = result.value.data.jobs.find(
      (j) => j.classId === ORPHAN_SCHEDULABLE,
    );
    expect(orphan).toBeDefined();
    expect(orphan?.isSchedulable).toBe(true);
    expect(orphan?.scheduledByCalls).toEqual([]);
  });

  it('does NOT surface non-Schedulable classes (e.g. Queueable)', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.jobs.map((j) => j.classId);
    expect(ids).not.toContain(QUEUEABLE_JOB);
  });

  it('does NOT include enqueueJob-mechanism callers in scheduledByCalls', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mixed = result.value.data.jobs.find(
      (j) => j.classId === MIXED_DISPATCH,
    );
    expect(mixed).toBeDefined();
    // The Queueable-mechanism caller MUST NOT surface as a scheduled
    // caller — only the schedule-dispatch subset is included.
    expect(mixed?.scheduledByCalls).toEqual([]);
  });

  it('surfaces cronExpressions from the class properties when present', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mixed = result.value.data.jobs.find(
      (j) => j.classId === MIXED_DISPATCH,
    );
    expect(mixed?.cronExpressions).toEqual(['0 0 4 * * ?']);
  });

  it('surfaces cronExpression from the edge properties when set', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nightly = result.value.data.jobs.find((j) => j.classId === NIGHTLY_JOB);
    const callerA = nightly?.scheduledByCalls.find(
      (c) => c.callerClassId === SCHEDULER_A,
    );
    expect(callerA?.cronExpression).toBe('0 0 2 * * ?');
    const callerB = nightly?.scheduledByCalls.find(
      (c) => c.callerClassId === SCHEDULER_B,
    );
    // SCHEDULER_B's edge has no cronExpression; the value is null.
    expect(callerB?.cronExpression).toBeNull();
  });

  it('sorts the jobs array by classId ASC', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.jobs.map((j) => j.classId);
    expect(ids).toEqual([...ids].sort());
  });

  it('returns honest summary counts', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // 3 Schedulable classes: NightlyJob + OrphanSchedulable + MixedDispatchTarget.
    expect(d.summary.totalSchedulableClasses).toBe(3);
    // Only NightlyJob has known scheduled callers.
    expect(d.summary.classesWithKnownCallers).toBe(1);
  });

  it('returns an honest disclosure mentioning the Tooling API boundary', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('Tooling API');
    expect(result.value.data.disclosure).toContain('heuristic');
  });

  it('surfaces a scheduled Flow with its frequency/startDate/startTimeUtc (T7)', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flow = result.value.data.scheduledFlows.find(
      (f) => f.flowId === SCHEDULED_FLOW,
    );
    expect(flow).toBeDefined();
    expect(flow?.frequency).toBe('Weekly');
    expect(flow?.startDate).toBe('2024-11-09');
    expect(flow?.startTimeUtc).toBe('08:00:00.000Z');
  });

  it('does NOT surface a non-scheduled (record-triggered) Flow (T7)', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.scheduledFlows.map((f) => f.flowId);
    expect(ids).not.toContain(RECORD_FLOW);
  });

  it('counts scheduled flows in the summary (T7)', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.summary.totalScheduledFlows).toBe(1);
  });

  it('discloses the UTC framing and Flow-vs-Apex-cron distinction for scheduled flows (T7)', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const disc = result.value.data.flowScheduleDisclosure;
    expect(disc).toContain('UTC');
    expect(disc).toContain('timezone');
    expect(disc).toContain('CronTrigger');
  });

  it('carries vaultState from the manifest', async () => {
    const result = await scheduledJobCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe(
      'sha256:scheduled-fixture',
    );
  });
});

describe('scheduledJobCatalogInputSchema', () => {
  it('accepts an empty input', () => {
    expect(scheduledJobCatalogInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts but ignores extra properties', () => {
    expect(
      scheduledJobCatalogInputSchema.safeParse({ ignored: 'value' }).success,
    ).toBe(true);
  });
});
