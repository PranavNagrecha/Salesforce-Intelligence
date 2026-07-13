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
  collectApexIdentifiers,
  explainDebugLogHandler,
  isDebugLog,
  parseGovernorLimit,
} from '../../src/tools/explain-debug-log.js';

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

// Fixtures shaped like real graph rows. AccountHandler carries a soql-in-loop
// governor-risk finding (the `qualityIssues` shape governor_limit_risks reads).
const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    node({
      id: 'ApexClass:AccountHandler',
      type: 'ApexClass',
      apiName: 'AccountHandler',
      label: 'AccountHandler',
      properties: {
        qualityIssues: [
          {
            rule: 'soql-in-loop',
            severity: 'high',
            location: 'AccountHandler.recalc line 12',
            explanation: 'SOQL query inside a for-loop; risks the 100-SOQL governor limit.',
          },
        ],
      },
    }),
    // A class with NO governor-risk finding — resolves, but no correlation.
    node({ id: 'ApexClass:QuietService', type: 'ApexClass', apiName: 'QuietService' }),
    node({
      id: 'ApexTrigger:AccountTrigger',
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      properties: { triggerObject: 'Account', status: 'Active' },
    }),
    node({
      id: 'Flow:Account_After_Save',
      type: 'Flow',
      apiName: 'Account_After_Save',
      label: 'Account After Save',
      properties: { status: 'Active', triggerObject: 'Account' },
    }),
  ],
  edges: [
    edge({ fromId: 'ApexTrigger:AccountTrigger', toId: 'CustomObject:Account', edgeType: 'triggersOn' }),
  ],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-explain-debug-log-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe('isDebugLog', () => {
  it('recognizes pipe-delimited debug-log event markers', () => {
    expect(isDebugLog('16:20:01.0 (12345)|CODE_UNIT_STARTED|[EXTERNAL]|AccountHandler.recalc()')).toBe(true);
    expect(isDebugLog('12:00:00.1 (9)|LIMIT_USAGE_FOR_NS|(default)|')).toBe(true);
    expect(isDebugLog('explain this debug log for me')).toBe(true);
  });
  it('does NOT treat a plain save-error banner as a debug log', () => {
    expect(isDebugLog('FIELD_CUSTOM_VALIDATION_EXCEPTION, Close date is required')).toBe(false);
  });
});

describe('parseGovernorLimit', () => {
  it('classifies a SOQL LimitException and extracts the count', () => {
    const p = parseGovernorLimit('FATAL_ERROR|System.LimitException: Too many SOQL queries: 101');
    expect(p?.limitType).toBe('soql');
    expect(p?.actual).toBe(101);
  });
  it('classifies a DML LimitException', () => {
    const p = parseGovernorLimit('System.LimitException: Too many DML statements: 151');
    expect(p?.limitType).toBe('dml');
    expect(p?.actual).toBe(151);
  });
  it('classifies a CPU-time exception with no trailing count', () => {
    const p = parseGovernorLimit('System.LimitException: Apex CPU time limit exceeded');
    expect(p?.limitType).toBe('cpu');
    expect(p?.actual).toBeNull();
  });
  it('classifies a heap exception', () => {
    expect(parseGovernorLimit('System.LimitException: Apex heap size too large: 7000000')?.limitType).toBe('heap');
  });
  it('reads an exceeding LIMIT_USAGE block (out of)', () => {
    const p = parseGovernorLimit('Number of SOQL queries: 101 out of 100');
    expect(p?.limitType).toBe('soql');
    expect(p?.actual).toBe(101);
    expect(p?.allowed).toBe(100);
  });
  it('returns null when there is no governor-limit signal', () => {
    expect(parseGovernorLimit('just some ordinary text about accounts')).toBeNull();
  });
});

describe('collectApexIdentifiers', () => {
  it('harvests classes and triggers from stack frames and event units', () => {
    const log = [
      '16:20:01.0 (1)|CODE_UNIT_STARTED|[EXTERNAL]|AccountTrigger on Account trigger event BeforeInsert|__sfdc_trigger/AccountTrigger',
      '16:20:01.1 (2)|CODE_UNIT_STARTED|[EXTERNAL]|AccountHandler.recalc()',
      'Class.AccountHandler.recalc: line 12, column 1',
      'Trigger.AccountTrigger: line 3, column 1',
    ].join('\n');
    const ids = collectApexIdentifiers(log);
    expect(ids).toContainEqual({ kind: 'ApexClass', name: 'AccountHandler' });
    expect(ids).toContainEqual({ kind: 'ApexTrigger', name: 'AccountTrigger' });
  });
  it('de-duplicates repeated identities', () => {
    const ids = collectApexIdentifiers('Class.Foo.a: line 1\nClass.Foo.b: line 2');
    expect(ids.filter((i) => i.name === 'Foo').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('explainDebugLogHandler', () => {
  it('cross-references a fired SOQL limit to a resolved class with a soql-in-loop finding', async () => {
    const logText = [
      '16:20:01.0 (1000)|EXCEPTION_THROWN|[12]|System.LimitException: Too many SOQL queries: 101',
      '16:20:01.0 (1001)|FATAL_ERROR|System.LimitException: Too many SOQL queries: 101',
      'Class.AccountHandler.recalc: line 12, column 1',
    ].join('\n');
    const r = await explainDebugLogHandler(ctx, { logText });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.disposition).toBe('matched');
    expect(d.logKind).toBe('debug-log');
    expect(d.detectedLimit?.limitType).toBe('soql');
    // The class resolved AND carries the matched governor risk.
    expect(d.candidates[0]?.componentId).toBe('ApexClass:AccountHandler');
    expect(d.candidates[0]?.confidence).toBe('declared');
    expect(d.governorRiskCrossRef?.limitType).toBe('soql');
    const ref = d.governorRiskCrossRef?.classesWithRisks.find((c) => c.componentId === 'ApexClass:AccountHandler');
    expect(ref?.matchedRisks[0]?.rule).toBe('soql-in-loop');
  });

  it('resolves an apex identity even with no static risk, and notes the gap', async () => {
    const logText = 'System.LimitException: Too many SOQL queries: 101\nClass.QuietService.run: line 5, column 1';
    const r = await explainDebugLogHandler(ctx, { logText });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.candidates.some((c) => c.componentId === 'ApexClass:QuietService')).toBe(true);
    // No class carried a matched loop-risk → the cross-ref note explains why.
    expect(d.governorRiskCrossRef?.classesWithRisks.every((c) => c.matchedRisks.length === 0)).toBe(true);
    expect(d.governorRiskCrossRef?.note).toBeTruthy();
  });

  it('reports an unresolved apex name without fabricating a match', async () => {
    const r = await explainDebugLogHandler(ctx, {
      logText: 'System.LimitException: Too many DML statements: 200\nClass.GhostClass.go: line 1, column 1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unresolvedApex).toContain('ApexClass:GhostClass');
    expect(r.value.data.candidates.every((c) => c.componentId !== 'ApexClass:GhostClass')).toBe(true);
  });

  it('resolves a flow named in a fault embedded in the log', async () => {
    const r = await explainDebugLogHandler(ctx, {
      logText: 'FLOW_START_INTERVIEWS|An error occurred. Flow API Name: Account_After_Save',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.candidates.some((c) => c.componentId === 'Flow:Account_After_Save')).toBe(true);
  });

  it('fails closed with actionable next steps when nothing resolves', async () => {
    const r = await explainDebugLogHandler(ctx, { logText: 'System.LimitException: Apex CPU time limit exceeded' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.disposition).toBe('none');
    expect(d.candidates).toHaveLength(0);
    expect(d.nextSteps.length).toBeGreaterThan(0);
    // A recognized limit still classifies at the category level.
    expect(d.detectedLimit?.limitType).toBe('cpu');
    expect(d.disclosure.length).toBeGreaterThan(0);
  });

  it('carries the shared status-code taxonomy through (reused detectStatusCode)', async () => {
    const r = await explainDebugLogHandler(ctx, {
      logText: 'FATAL_ERROR|System.DmlException: Update failed. First exception on row 0; UNABLE_TO_LOCK_ROW',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.detectedStatusCode).toBe('UNABLE_TO_LOCK_ROW');
  });
});
