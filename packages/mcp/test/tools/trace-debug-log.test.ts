/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  traceDebugLogHandler,
  traceDebugLogInputSchema,
} from '../../src/tools/trace-debug-log.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: 'x.xml', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

// WidgetTrigger / WidgetService exist; LegacySyncHandler deliberately does NOT.
// `Widget Post Save` is a Flow LABEL (the only identity a log gives a flow).
const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Widget__c', type: 'CustomObject', apiName: 'Widget__c' }),
    node({ id: 'ApexClass:WidgetService', type: 'ApexClass', apiName: 'WidgetService' }),
    node({
      id: 'ApexTrigger:WidgetTrigger',
      type: 'ApexTrigger',
      apiName: 'WidgetTrigger',
      properties: { triggerObject: 'Widget__c', status: 'Active' },
    }),
    node({
      id: 'ValidationRule:Widget__c.Widget_Must_Have_Owner',
      type: 'ValidationRule',
      apiName: 'Widget__c.Widget_Must_Have_Owner',
      parentId: 'CustomObject:Widget__c',
      properties: { active: true },
    }),
    node({
      id: 'Flow:Widget_Post_Save',
      type: 'Flow',
      apiName: 'Widget_Post_Save',
      label: 'Widget Post Save',
      properties: { status: 'Active', triggerObject: 'Widget__c' },
    }),
  ],
  edges: [
    edge({ fromId: 'ApexTrigger:WidgetTrigger', toId: 'CustomObject:Widget__c', edgeType: 'triggersOn' }),
  ],
};

/** A structurally real transaction: two trigger contexts, a flow, DB spans. */
const FULL_LOG = [
  '57.0 APEX_CODE,FINE;APEX_PROFILING,INFO;CALLOUT,INFO;DB,INFO;NBA,NONE;SYSTEM,DEBUG;VALIDATION,INFO;VISUALFORCE,NONE;WAVE,NONE;WORKFLOW,FINER',
  '09:00:00.001 (1000000)|EXECUTION_STARTED',
  '09:00:00.002 (2000000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001AAA|WidgetTrigger on Widget__c trigger event BeforeUpdate|__sfdc_trigger/WidgetTrigger',
  '09:00:00.003 (3000000)|METHOD_ENTRY|[1]|01p000000000001AAA|WidgetService.beforeUpdate(List<Widget__c>)',
  '09:00:00.004 (4000000)|SOQL_EXECUTE_BEGIN|[9]|Aggregations:0|SELECT Id FROM Widget__c WHERE Active__c = true',
  '09:00:00.014 (14000000)|SOQL_EXECUTE_END|[9]|Rows:42',
  '09:00:00.019 (20000000)|METHOD_EXIT|[1]|01p000000000001AAA|WidgetService.beforeUpdate(List<Widget__c>)',
  '09:00:00.021 (21000000)|CODE_UNIT_FINISHED|WidgetTrigger on Widget__c trigger event BeforeUpdate',
  '09:00:00.021 (21500000)|VALIDATION_RULE|03d000000000001AAA|Widget_Must_Have_Owner',
  '09:00:00.021 (21900000)|VALIDATION_PASS',
  '09:00:00.022 (22000000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001AAA|WidgetTrigger on Widget__c trigger event AfterUpdate|__sfdc_trigger/WidgetTrigger',
  '09:00:00.022 (22500000)|METHOD_ENTRY|[4]|01p000000000009AAA|LegacySyncHandler.push(List<Widget__c>)',
  '09:00:00.024 (24500000)|METHOD_EXIT|[4]|01p000000000009AAA|LegacySyncHandler.push(List<Widget__c>)',
  '09:00:00.025 (25000000)|CODE_UNIT_FINISHED|WidgetTrigger on Widget__c trigger event AfterUpdate',
  '09:00:00.026 (26000000)|FLOW_START_INTERVIEWS_BEGIN|1',
  '09:00:00.026 (26500000)|FLOW_START_INTERVIEW_BEGIN|1|Widget Post Save',
  '09:00:00.027 (27000000)|FLOW_ELEMENT_BEGIN|1|FlowRecordUpdate|Stamp_Widget',
  '09:00:00.027 (27500000)|DML_BEGIN|[EXTERNAL]|Op:Update|Type:Widget__c|Rows:42',
  '09:00:00.047 (47500000)|DML_END|[EXTERNAL]',
  '09:00:00.048 (48000000)|FLOW_ELEMENT_END|1|FlowRecordUpdate|Stamp_Widget',
  '09:00:00.048 (48500000)|FLOW_START_INTERVIEW_END|1|Widget Post Save',
  '09:00:00.049 (49000000)|FLOW_START_INTERVIEWS_END',
  '09:00:00.049 (49500000)|CODE_UNIT_STARTED|[EXTERNAL]|Flow:301000000000001AAA',
  '09:00:00.050 (50000000)|CODE_UNIT_FINISHED|Flow:301000000000001AAA',
  '09:00:00.051 (51000000)|CUMULATIVE_LIMIT_USAGE',
  '09:00:00.051 (51000000)|LIMIT_USAGE_FOR_NS|(default)|',
  '  Number of SOQL queries: 101 out of 100',
  '  Number of DML statements: 1 out of 150',
  '  Maximum CPU time: 4210 out of 10000',
  '',
  '09:00:00.051 (51000000)|CUMULATIVE_LIMIT_USAGE_END',
  '09:00:00.052 (52000000)|EXECUTION_FINISHED',
].join('\n');

/** The SAME transaction captured with WORKFLOW and VALIDATION set to NONE. */
const QUIET_LOG = [
  '57.0 APEX_CODE,FINE;APEX_PROFILING,NONE;CALLOUT,NONE;DB,INFO;NBA,NONE;SYSTEM,DEBUG;VALIDATION,NONE;VISUALFORCE,NONE;WAVE,NONE;WORKFLOW,NONE',
  '09:00:00.001 (1000000)|EXECUTION_STARTED',
  '09:00:00.002 (2000000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001AAA|WidgetTrigger on Widget__c trigger event BeforeUpdate|__sfdc_trigger/WidgetTrigger',
  '09:00:00.021 (21000000)|CODE_UNIT_FINISHED|WidgetTrigger on Widget__c trigger event BeforeUpdate',
  '09:00:00.052 (52000000)|EXECUTION_FINISHED',
].join('\n');

let tempDir: string;
let store: GraphStore;
let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-trace-debug-log-'));
  const o = await openGraph(join(tempDir, 'g.db'));
  if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]);
  if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const run = async (logText: string, extra: Record<string, unknown> = {}) => {
  const parsedInput = traceDebugLogInputSchema.parse({ logText, ...extra });
  const r = await traceDebugLogHandler(ctx, parsedInput);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.data;
};

describe('sfi.trace_debug_log — input contract', () => {
  it('accepts the natural aliases a host reaches for', () => {
    expect(traceDebugLogInputSchema.parse({ debugLog: 'x' })).toMatchObject({ logText: 'x' });
    expect(traceDebugLogInputSchema.parse({ log: 'x' })).toMatchObject({ logText: 'x' });
    expect(traceDebugLogInputSchema.parse({ content: 'x' })).toMatchObject({ logText: 'x' });
  });
  it('fails closed with a NAMED field when no log text is supplied', () => {
    expect(() => traceDebugLogInputSchema.parse({})).toThrow(/logText/);
  });
});

describe('sfi.trace_debug_log — timeline and transaction', () => {
  it('reports the entry point and total elapsed wall time', async () => {
    const d = await run(FULL_LOG);
    expect(d.logShape).toBe('apex-debug-log');
    expect(d.transaction.entryPoint).toBe(
      'WidgetTrigger on Widget__c trigger event BeforeUpdate',
    );
    expect(d.transaction.entryPointKind).toBe('trigger');
    expect(d.transaction.elapsedMs).toBe(51);
  });

  it('returns depth-tracked spans with start, duration and exclusive self time', async () => {
    const d = await run(FULL_LOG);
    const before = d.timeline.find((s) => s.name.endsWith('BeforeUpdate'));
    expect(before?.durationMs).toBe(19);
    expect(before?.startMs).toBe(1);
    const method = d.timeline.find((s) => s.kind === 'method');
    expect(method?.durationMs).toBe(17);
    expect(method?.selfMs).toBe(7); // 17ms wall minus the 10ms SOQL child
  });

  it('honours maxDepth and includeTimeline without touching the rollups', async () => {
    const shallow = await run(FULL_LOG, { maxDepth: 1 });
    expect(shallow.timeline.every((s) => s.depth <= 1)).toBe(true);
    const none = await run(FULL_LOG, { includeTimeline: false });
    expect(none.timeline).toEqual([]);
    expect(none.phases.length).toBeGreaterThan(0);
  });
});

describe('sfi.trace_debug_log — where the time went', () => {
  it('subtracts SOQL/DML/callout wait so CPU is separated from DB wait', async () => {
    const d = await run(FULL_LOG);
    const before = d.timeAttribution.find((a) => a.unit.endsWith('BeforeUpdate'));
    expect(before?.wallMs).toBe(19);
    expect(before?.soqlMs).toBe(10);
    expect(before?.cpuEstimateMs).toBe(9);
    expect(before?.soqlCount).toBe(1);
    const flow = d.timeAttribution.find((a) => a.kind === 'flow-interview');
    expect(flow?.dmlMs).toBe(20);
    expect(flow?.cpuEstimateMs).toBe(2);
  });

  it('ranks hot spots by EXCLUSIVE wall time and excludes DB/callout spans', async () => {
    const d = await run(FULL_LOG);
    expect(d.hotSpots.length).toBeGreaterThan(0);
    expect(d.hotSpots.some((h) => h.kind === 'soql' || h.kind === 'dml')).toBe(false);
    const method = d.hotSpots.find((h) => h.name.startsWith('WidgetService.beforeUpdate'));
    expect(method?.selfMs).toBe(7);
    expect(method?.componentId).toBe('ApexClass:WidgetService');
  });

  it('never double counts a nested unit into two phases', async () => {
    const d = await run(FULL_LOG);
    const phaseWall = d.phases.reduce((n, p) => n + p.wallMs, 0);
    expect(phaseWall).toBeLessThanOrEqual(d.transaction.elapsedMs ?? 0);
    expect(d.phases.map((p) => p.phase)).toEqual(
      expect.arrayContaining([
        'before-save-apex-triggers',
        'after-save-apex-triggers',
        'flows',
        'validation-rules',
      ]),
    );
  });
});

describe('sfi.trace_debug_log — automation firing order', () => {
  it('lists every automation in the order the log recorded it', async () => {
    const d = await run(FULL_LOG);
    expect(d.automationOrder.map((s) => s.kind)).toEqual([
      'apex-trigger',
      'validation-rule',
      'apex-trigger',
      'flow-interview',
      'flow-code-unit',
    ]);
    expect(d.automationOrder[0]?.componentId).toBe('ApexTrigger:WidgetTrigger');
    expect(d.automationOrder[0]?.identity).toBe('declared');
  });

  it('carries the flow element sequence on the interview step', async () => {
    const d = await run(FULL_LOG);
    const flow = d.automationOrder.find((s) => s.kind === 'flow-interview');
    expect(flow?.steps).toEqual(['FlowRecordUpdate: Stamp_Widget']);
  });
});

describe('sfi.trace_debug_log — honesty contract', () => {
  it('types a flow matched by MasterLabel HEURISTIC, never declared', async () => {
    const d = await run(FULL_LOG);
    const flow = d.componentResolution.find((r) => r.nameInLog === 'Widget Post Save');
    expect(flow?.identity).toBe('heuristic');
    expect(flow?.componentId).toBe('Flow:Widget_Post_Save');
    expect(flow?.why).toContain('MasterLabel');
  });

  it('types an id-only code unit UNRESOLVABLE and says no refresh can fix it', async () => {
    const d = await run(FULL_LOG);
    const idOnly = d.componentResolution.find((r) => r.nameInLog.startsWith('Flow:301'));
    expect(idOnly?.identity).toBe('unresolvable');
    expect(idOnly?.why).toContain('never stored in the vault');
    expect(d.boundaries.join(' ')).toContain('unresolvable OFFLINE ON ANY ORG');
  });

  it('separates "not a component in ANY org" from "not in this vault"', async () => {
    const d = await run(FULL_LOG);
    const element = d.hotSpots.find((h) => h.kind === 'flow-element');
    // A flow ELEMENT lives inside its Flow's XML — it is never its own node, so
    // calling it not-in-vault would invent a coverage gap no refresh can close.
    expect(element?.identity).toBe('not-a-component');
    expect(element?.componentId).toBeNull();
    const missing = d.hotSpots.find((h) => h.name.startsWith('LegacySyncHandler'));
    expect(missing?.identity).toBe('not-in-vault');
    const step = d.automationOrder.find((a) => a.kind === 'flow-code-unit');
    expect(step?.identity).toBe('unresolvable');
  });

  it('infers a validation rule OBJECT from its developer name, typed heuristic', async () => {
    const d = await run(FULL_LOG);
    const rule = d.componentResolution.find((r) => r.nameInLog === 'Widget_Must_Have_Owner');
    expect(rule?.identity).toBe('heuristic');
    expect(rule?.componentId).toBe('ValidationRule:Widget__c.Widget_Must_Have_Owner');
    expect(rule?.why).toContain('not its object');
    const step = d.automationOrder.find((a) => a.kind === 'validation-rule');
    expect(step?.componentId).toBe('ValidationRule:Widget__c.Widget_Must_Have_Owner');
  });

  it('reports a class named in the log but absent from the vault, never fabricates', async () => {
    const d = await run(FULL_LOG);
    const missing = d.componentResolution.find((r) => r.nameInLog === 'LegacySyncHandler');
    expect(missing).toBeDefined();
    expect(missing?.identity).toBe('not-in-vault');
    expect(missing?.componentId).toBeNull();
  });

  it('distinguishes NOT LOGGED from "did not happen"', async () => {
    const d = await run(QUIET_LOG);
    expect(d.automationOrder.filter((s) => s.kind === 'flow-interview')).toEqual([]);
    const workflow = d.capture.notLogged.find((c) => c.category === 'WORKFLOW');
    expect(workflow?.level).toBe('NONE');
    expect(workflow?.meaning).toContain('NOT LOGGED');
    expect(d.coverageCaveat).toContain('set to NONE');
    expect(d.coverageCaveat).toContain('their events were never written');
    expect(d.boundaries.join(' ')).toContain('NOT LOGGED in this transaction');
  });

  it('says an empty limit table means APEX_PROFILING=NONE, not zero consumption', async () => {
    const d = await run(QUIET_LOG);
    expect(d.limits).toEqual([]);
    expect(d.boundaries.join(' ')).toContain('APEX_PROFILING=NONE');
    expect(d.boundaries.join(' ')).toContain('not "nothing was consumed"');
  });

  it('emits NO coverageCaveat when the log is complete and fully captured', async () => {
    const clean = [
      // FINEST everywhere: this is what "fully captured" actually requires.
      // Levels are cumulative, so the old fixture (APEX_CODE=FINE, DB=INFO …)
      // was silently PARTIAL — it could not write HEAP_ALLOCATE,
      // VARIABLE_ASSIGNMENT or SOQL_EXECUTE_EXPLAIN — and the tool was right
      // to caveat it. DATA_ACCESS is declared too, as every real header does.
      '57.0 APEX_CODE,FINEST;APEX_PROFILING,FINEST;CALLOUT,FINEST;DATA_ACCESS,FINEST;DB,FINEST;NBA,FINEST;SYSTEM,FINEST;VALIDATION,FINEST;VISUALFORCE,FINEST;WAVE,FINEST;WORKFLOW,FINEST',
      '09:00:00.001 (1000000)|EXECUTION_STARTED',
      '09:00:00.002 (2000000)|EXECUTION_FINISHED',
    ].join('\n');
    const d = await run(clean);
    expect(d.capture.notLogged).toEqual([]);
    expect(d.capture.notDeclared).toEqual([]);
    expect(d.capture.partiallyCaptured).toEqual([]);
    expect(d.coverageCaveat).toBeNull();
  });

  it('names the log-creation boundary instead of omitting the question', async () => {
    const d = await run(FULL_LOG);
    expect(d.logCreation.modeledByThisProduct).toBe(false);
    expect(d.logCreation.boundary).toContain('TraceFlag');
    expect(d.logCreation.boundary).toContain('DebugLevel');
    expect(d.logCreation.platformRules.length).toBeGreaterThan(3);
    expect(d.logCreation.platformRules.join(' ')).toContain('NOT readings from your org');
  });

  it('refuses to treat a bare error banner as an event stream', async () => {
    const d = await run('FIELD_CUSTOM_VALIDATION_EXCEPTION, Close date is required');
    expect(d.logShape).toBe('not-a-debug-log');
    expect(d.timeline).toEqual([]);
    expect(d.boundaries.join(' ')).toContain('not an Apex debug-log event stream');
    expect(d.nextSteps.join(' ')).toContain('sfi.explain_debug_log');
  });
});

describe('sfi.trace_debug_log — limits and database', () => {
  it('returns the per-limit actual/allowed table with an exceeded flag', async () => {
    const d = await run(FULL_LOG);
    const soql = d.limits.find((l) => l.metric === 'SOQL queries');
    expect(soql).toMatchObject({ used: 101, allowed: 100, exceeded: true, pctUsed: 101 });
    expect(d.limitsSource).toBe('CUMULATIVE_LIMIT_USAGE');
  });

  it('rolls up SOQL/DML counts, ms and rows, and exposes repeat counts', async () => {
    const d = await run(FULL_LOG);
    expect(d.database.soqlCount).toBe(1);
    expect(d.database.soqlMs).toBe(10);
    expect(d.database.soqlRows).toBe(42);
    expect(d.database.dmlCount).toBe(1);
    expect(d.database.dmlMs).toBe(20);
    expect(d.database.slowestQueries[0]?.repeated).toBe(1);
  });
});

// =============================================================================
// W2F REVIEW — defects found by two independent reviews and a real-org corpus.
// Each produced a CONFIDENTLY FALSE answer, and the shipped suite passed on all
// of them. Measured figures in the comments come from real sandbox logs.
// =============================================================================

describe('sfi.trace_debug_log — elapsed time is the TRANSACTION, not the pasted file', () => {
  // Real logs carry a long pre-EXECUTION_STARTED prelude. Reporting the file
  // span made a 34.4 ms transaction read as 2,990 ms on a real 247 KB log — an
  // 87x overstatement of the one number "where did the time go" turns on, and
  // the divisor for every hotSpot percentage.
  const withPrelude = [
    '57.0 APEX_CODE,FINE;DB,INFO',
    '10:00:00.0 (1000000)|USER_INFO|[EXTERNAL]|005xx|someone|GMT|GMT+00:00',
    '10:00:02.0 (2000000000)|EXECUTION_STARTED',
    '10:00:02.0 (2010000000)|CODE_UNIT_STARTED|[EXTERNAL]|WidgetTrigger on Widget__c trigger event BeforeUpdate|__sfdc_trigger/WidgetTrigger',
    '10:00:02.0 (2030000000)|CODE_UNIT_FINISHED|WidgetTrigger on Widget__c trigger event BeforeUpdate|__sfdc_trigger/WidgetTrigger',
    '10:00:02.0 (2040000000)|EXECUTION_FINISHED',
  ].join('\n');

  it('reports the execution unit span, and keeps the file span under its own name', async () => {
    const d = await run(withPrelude);
    expect(d.transaction.elapsedMs).toBe(40); // 2.04s - 2.00s
    expect(d.transaction.fileSpanMs).toBe(2039); // includes the 2s prelude
    expect(d.transaction.elapsedIsFileSpan).toBe(false);
  });

  it('falls back to the file span and SAYS SO when no execution unit closed', async () => {
    const d = await run('57.0 APEX_CODE,FINE\n10:00:00.0 (1000000)|USER_INFO|[EXTERNAL]|005xx|x|GMT|GMT+00:00');
    expect(d.transaction.elapsedIsFileSpan).toBe(true);
  });
});

describe('sfi.trace_debug_log — a log with no transaction body says so', () => {
  it('does not present empty sections as "nothing fired"', async () => {
    // 4 of 18 real sandbox logs are a header plus one USER_INFO line. The tool
    // returned a full, confident, entirely empty analysis with zero caveats.
    const d = await run(
      '57.0 APEX_CODE,FINE\n10:00:00.0 (1000000)|USER_INFO|[EXTERNAL]|005xx|x|GMT|GMT+00:00',
    );
    expect(d.boundaries.join(' ')).toMatch(/NO execution unit/i);
    expect(d.boundaries.join(' ')).toMatch(/NOTHING WAS CAPTURED, not that nothing ran/i);
  });
});

describe('sfi.trace_debug_log — the limit table is the PEAK per namespace, not the first snapshot', () => {
  // A transaction writes CUMULATIVE_LIMIT_USAGE at the end of many code units.
  // Emitting one row per snapshot produced 2,418 rows / 312 KB on a real 1 MB
  // log; the global byte guard then kept the FIRST 10 — the reading nearest the
  // START of the transaction — so peak CPU 2,031/10,000 was reported as 134,
  // and three of four namespaces vanished entirely.
  const twoSnapshots = [
    '57.0 APEX_CODE,FINE;APEX_PROFILING,INFO',
    '10:00:00.0 (1000000)|EXECUTION_STARTED',
    '10:00:00.0 (2000000)|CUMULATIVE_LIMIT_USAGE',
    '10:00:00.0 (2000000)|LIMIT_USAGE_FOR_NS|(default)|',
    '  Number of SOQL queries: 3 out of 100',
    '  Maximum CPU time: 120 out of 10000',
    '',
    '10:00:00.0 (2000000)|CUMULATIVE_LIMIT_USAGE_END',
    '10:00:00.0 (8000000)|CUMULATIVE_LIMIT_USAGE',
    '10:00:00.0 (8000000)|LIMIT_USAGE_FOR_NS|(default)|',
    '  Number of SOQL queries: 33 out of 100',
    '  Maximum CPU time: 2031 out of 10000',
    '',
    '10:00:00.0 (8000000)|LIMIT_USAGE_FOR_NS|hed|',
    '  Number of SOQL queries: 29 out of 100',
    '',
    '10:00:00.0 (8000000)|CUMULATIVE_LIMIT_USAGE_END',
    '10:00:00.0 (9000000)|EXECUTION_FINISHED',
  ].join('\n');

  it('keeps the PEAK for each namespace+metric, and every namespace', async () => {
    const d = await run(twoSnapshots);
    const cpu = d.limits.find((l) => l.namespace === '(default)' && /CPU/i.test(l.metric));
    expect(cpu?.used).toBe(2031); // the peak, not the 120 of the first snapshot
    expect(cpu?.pctUsed).toBe(20.3);
    const soql = d.limits.find((l) => l.namespace === '(default)' && /SOQL/i.test(l.metric));
    expect(soql?.used).toBe(33);
    // The managed-package namespace must survive.
    expect(d.limits.some((l) => l.namespace === 'hed')).toBe(true);
    // One row per (namespace, metric) — never one per snapshot.
    const keys = d.limits.map((l) => `${l.namespace}|${l.metric}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sorts most-consumed first so a cap can never hide the limit that blew', async () => {
    const d = await run(twoSnapshots);
    const pct = d.limits.map((l) => l.pctUsed);
    expect([...pct].sort((a, b) => b - a)).toEqual(pct);
  });
});

describe('sfi.trace_debug_log — capture states are three different claims, not one', () => {
  it('NONE is "never written"; an undeclared category is only UNKNOWN', async () => {
    // Conflating them both overstated what the log said and filled the list
    // with noise, since real headers routinely omit NBA / WAVE / DATA_ACCESS.
    const d = await run(
      '57.0 APEX_CODE,FINE;WORKFLOW,NONE\n10:00:00.0 (1)|EXECUTION_STARTED\n10:00:00.0 (2)|EXECUTION_FINISHED',
    );
    expect(d.capture.notLogged.map((c) => c.category)).toEqual(['WORKFLOW']);
    expect(d.capture.notDeclared.map((c) => c.category)).toContain('VALIDATION');
    expect(d.capture.notDeclared.map((c) => c.category)).not.toContain('WORKFLOW');
    expect(d.boundaries.join(' ')).toMatch(/NOT DECLARED by this log's header/);
    expect(d.boundaries.join(' ')).toMatch(/weaker than NOT LOGGED/);
  });

  it('WORKFLOW=INFO is reported as PARTIALLY captured, not as a flow that ran nothing', async () => {
    const d = await run(
      [
        '57.0 APEX_CODE,DEBUG;WORKFLOW,INFO',
        '10:00:00.0 (1000000)|EXECUTION_STARTED',
        '10:00:00.0 (2000000)|FLOW_START_INTERVIEW_BEGIN|abc|Order Sync',
        '10:00:00.0 (9000000)|FLOW_START_INTERVIEW_END|abc|Order Sync',
        '10:00:00.0 (9500000)|EXECUTION_FINISHED',
      ].join('\n'),
    );
    expect(d.capture.partiallyCaptured.map((c) => c.category)).toContain('WORKFLOW');
    expect(d.boundaries.join(' ')).toMatch(/PARTIALLY captured/);
    expect(d.boundaries.join(' ')).toMatch(/WORKFLOW=INFO records that a flow ran but NOT its individual elements/);
    expect(d.coverageCaveat).not.toBeNull();
  });

  it('surfaces a declared category this build does not model instead of dropping it', async () => {
    // DATA_ACCESS is declared by 18 of 18 real headers and the string did not
    // appear anywhere in the response.
    const d = await run(
      '67.0 APEX_CODE,FINE;DATA_ACCESS,INFO\n10:00:00.0 (1)|EXECUTION_STARTED\n10:00:00.0 (2)|EXECUTION_FINISHED',
    );
    expect(JSON.stringify(d)).toMatch(/DATA_ACCESS/);
  });
});

describe('sfi.trace_debug_log — structural parse caveats reach the honesty surface', () => {
  it('an orphaned close is disclosed as affecting the durations below it', async () => {
    // The evidence existed in parseCaveats and was read by nothing, so a 300x
    // time-attribution error shipped with every honesty field reading clean.
    const d = await run(
      [
        '57.0 APEX_CODE,FINE',
        '10:00:00.0 (1000000)|CODE_UNIT_FINISHED|Ghost on Account trigger event BeforeInsert|__sfdc_trigger/Ghost',
        '10:00:00.0 (2000000)|EXECUTION_FINISHED',
      ].join('\n'),
    );
    expect(d.boundaries.join(' ')).toMatch(/LOG STRUCTURE \(orphan-close\)/);
    expect(d.boundaries.join(' ')).toMatch(/treat them as a FLOOR/);
  });
});

describe('sfi.trace_debug_log — the empty-limit sentence must not blame the paste', () => {
  it('says the block is present but carried no rows, when that is the truth', async () => {
    const d = await run(
      [
        '57.0 APEX_CODE,FINE;APEX_PROFILING,INFO',
        '10:00:00.0 (1000000)|EXECUTION_STARTED',
        '10:00:00.0 (2000000)|CUMULATIVE_LIMIT_USAGE',
        '10:00:00.0 (2000000)|CUMULATIVE_LIMIT_USAGE_END',
        '10:00:00.0 (3000000)|EXECUTION_FINISHED',
      ].join('\n'),
    );
    expect(d.limits).toHaveLength(0);
    expect(d.boundaries.join(' ')).toMatch(/block IS present but carries no LIMIT_USAGE_FOR_NS rows/);
    expect(d.boundaries.join(' ')).not.toMatch(/No CUMULATIVE_LIMIT_USAGE block is present/);
  });
});
