/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult } from '@sf-intelligence/contracts';
import {
  ACTIVE_HOLDERS_COMPLETE_SUBJECT,
  closeGraph,
  importExtractionResults,
  openGraph,
  readFacts,
  writeFacts,
  type GraphStore,
} from '@sf-intelligence/graph';

import {
  captureDataShape,
  dataShapeBudget,
  type DataShapeExecutors,
} from '../src/data-shape-capture.js';

/**
 * P13-FACTS-capture — budgeted, consent-gated, injectable-executor capture:
 * consent/auth failures skip honestly (zero API calls, never an error);
 * record counts attach only to graph-known objects; fill rates come from a
 * recent sample with the exact/recent method distinction; the budget is a
 * hard stop with a disclosed partial summary.
 */

const node = (id: string, type: string, apiName: string) =>
  ({
    id,
    type,
    apiName,
    label: apiName,
    parentId: null,
    sourcePath: `source/${apiName}`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
  }) as never;

const edge = (fromId: string, toId: string, edgeType: string) =>
  ({ fromId, toId, edgeType, confidence: 'declared', source: 'test', properties: {} }) as never;

const FIXTURE: ExtractionResult = {
  nodes: [
    node('CustomObject:Alpha__c', 'CustomObject', 'Alpha__c'),
    node('CustomObject:Beta__c', 'CustomObject', 'Beta__c'),
    node('CustomField:Alpha__c.Score__c', 'CustomField', 'Alpha__c.Score__c'),
    node('CustomField:Alpha__c.Note__c', 'CustomField', 'Alpha__c.Note__c'),
    node('ApexClass:AlphaService', 'ApexClass', 'AlphaService'),
    node('PermissionSet:Power_User', 'PermissionSet', 'Power_User'),
    node('Profile:Admin', 'Profile', 'Admin'),
  ],
  edges: [
    edge('CustomObject:Alpha__c', 'CustomField:Alpha__c.Score__c', 'parentOf'),
    edge('CustomObject:Alpha__c', 'CustomField:Alpha__c.Note__c', 'parentOf'),
    // Alpha is the top-centrality object (one real inbound dependency).
    edge('ApexClass:AlphaService', 'CustomObject:Alpha__c', 'readsFrom'),
  ],
} as never;

const AUTH = { instanceUrl: 'https://example.test', accessToken: 't', apiVersion: '62.0' };

const executors = (overrides: Partial<DataShapeExecutors> = {}): DataShapeExecutors & {
  readonly calls: string[];
} => {
  const calls: string[] = [];
  return {
    calls,
    hasConsent: async () => true,
    getAuth: async () => ({ ok: true as const, value: AUTH }),
    restGet: async (_auth, path) => {
      calls.push(path);
      if (path.includes('/limits/recordCount')) {
        return {
          ok: true as const,
          value: {
            sObjects: [
              { name: 'Alpha__c', count: 150 },
              { name: 'Beta__c', count: 5000 },
              { name: 'Not_In_Graph__c', count: 9 },
            ],
          },
        };
      }
      if (path.includes('PermissionSetAssignment')) {
        return {
          ok: true as const,
          value: { records: [
            { name: 'Power_User', holders: 7 },
            { name: 'Not_In_Graph_PS', holders: 3 },
          ] },
        };
      }
      if (path.includes('FROM%20User') || path.includes('FROM User')) {
        return {
          ok: true as const,
          value: { records: [{ name: 'Admin', holders: 12 }] },
        };
      }
      // sample query: 3 rows, Score__c filled in 2, Note__c in 0
      return {
        ok: true as const,
        value: {
          records: [
            { Score__c: 10, Note__c: null },
            { Score__c: 20, Note__c: null },
            { Score__c: null, Note__c: null },
          ],
        },
      };
    },
    ...overrides,
  };
};

let tempDir: string;
let store: GraphStore;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-capture-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [FIXTURE]);
  if (!imported.ok) throw new Error(imported.error.message);
});

afterEach(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env['SFI_DATA_SHAPE_BUDGET'];
});

describe('captureDataShape', () => {
  it('skips honestly without consent — zero API calls, never an error', async () => {
    const ex = executors({ hasConsent: async () => false });
    const s = await captureDataShape(store, 'some-org', { executors: ex, now: '2026-06-10T03:00:00.000Z' });
    expect(s.ran).toBe(false);
    expect(s.skippedReason).toContain('consent');
    expect(ex.calls).toHaveLength(0);
    const facts = await readFacts(store);
    expect(facts.ok && facts.value).toHaveLength(0);
  });

  it('captures record counts (graph-known objects only) and recent-sample fill rates', async () => {
    const ex = executors();
    const s = await captureDataShape(store, 'some-org', { executors: ex, now: '2026-06-10T03:00:00.000Z' });
    expect(s.ran).toBe(true);
    expect(s.recordCountFacts).toBe(2); // Not_In_Graph__c dropped
    expect(s.fillRateFacts).toBe(2); // Score__c + Note__c on the top object

    const counts = await readFacts(store, { metric: 'recordCount' });
    expect(counts.ok).toBe(true);
    if (!counts.ok) return;
    const alpha = counts.value.find((f) => f.subjectId === 'CustomObject:Alpha__c');
    expect(alpha?.value).toBe(150);
    expect(alpha?.method).toBe('rest-recordcount');
    expect(alpha?.capturedAt).toBe('2026-06-10T03:00:00.000Z');

    const fills = await readFacts(store, { metric: 'fillRate' });
    expect(fills.ok).toBe(true);
    if (!fills.ok) return;
    const score = fills.value.find((f) => f.subjectId === 'CustomField:Alpha__c.Score__c');
    expect(score?.value).toEqual({ rate: 0.667, sampleSize: 3, exact: false });
    expect(score?.method).toBe('recent-sample');
  });

  it('marks the sample exact when the whole population fit inside it', async () => {
    const ex = executors({
      restGet: async (_auth, path) => {
        if (path.includes('/limits/recordCount')) {
          return { ok: true as const, value: { sObjects: [{ name: 'Alpha__c', count: 2 }] } };
        }
        return {
          ok: true as const,
          value: { records: [{ Score__c: 1, Note__c: null }, { Score__c: 2, Note__c: 'x' }] },
        };
      },
    });
    const s = await captureDataShape(store, 'some-org', { executors: ex, now: '2026-06-10T03:00:00.000Z' });
    expect(s.ran).toBe(true);
    const fills = await readFacts(store, { metric: 'fillRate' });
    if (!fills.ok) return;
    expect(fills.value[0]?.method).toBe('exact-sample');
  });

  it('stops at the budget with a disclosed partial capture', async () => {
    const ex = executors();
    const s = await captureDataShape(store, 'some-org', {
      executors: ex,
      budget: 1, // only the recordCount call fits
      now: '2026-06-10T03:00:00.000Z',
    });
    expect(s.ran).toBe(true);
    expect(s.apiCalls).toBe(1);
    expect(s.budgetExhausted).toBe(true);
    expect(s.recordCountFacts).toBe(2);
    expect(s.fillRateFacts).toBe(0);
  });

  it('captures PSA aggregate holder counts — graph-known containers only, COUNTS only (PII grep)', async () => {
    const ex = executors();
    const s = await captureDataShape(store, 'some-org', { executors: ex, now: '2026-06-10T03:00:00.000Z' });
    expect(s.ran).toBe(true);
    expect(s.holderFacts).toBe(2); // Power_User + Admin; Not_In_Graph_PS dropped

    const holders = await readFacts(store, { metric: 'activeHolders' });
    expect(holders.ok).toBe(true);
    if (!holders.ok) return;
    const ps = holders.value.find((f) => f.subjectId === 'PermissionSet:Power_User');
    const marker = holders.value.find((f) => f.subjectId === ACTIVE_HOLDERS_COMPLETE_SUBJECT);
    expect(ps?.value).toBe(7);
    expect(ps?.method).toBe('aggregate-soql');
    expect(marker?.value).toEqual({ complete: true, containerCount: 2 });
    // PII grep: nothing identifier-shaped lands in the stored facts — no
    // user ids (005-prefixed), no emails, no Assignee keys.
    const serialized = JSON.stringify(holders.value);
    expect(serialized).not.toMatch(/005[A-Za-z0-9]{12,15}/);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toMatch(/assignee/i);
    // and the SOQL itself never selects identities:
    const psaQuery = ex.calls.find((c) => c.includes('PermissionSetAssignment')) ?? '';
    expect(decodeURIComponent(psaQuery)).not.toMatch(/AssigneeId|Username|Email/i);
  });

  it('keeps the prior holder snapshot when either aggregate query is incomplete', async () => {
    const oldStamp = '2026-06-09T03:00:00.000Z';
    const seeded = await writeFacts(store, [{
      subjectId: 'PermissionSet:Power_User',
      metric: 'activeHolders',
      value: 99,
      capturedAt: oldStamp,
      method: 'aggregate-soql',
      source: 'refresh-with-data-shape',
    }]);
    if (!seeded.ok) throw new Error(seeded.error.message);
    const ex = executors({
      restGet: async (_auth, path) => {
        if (path.includes('PermissionSetAssignment')) {
          return { ok: true as const, value: { records: [{ name: 'Power_User', holders: 7 }] } };
        }
        if (path.includes('FROM%20User') || path.includes('FROM User')) {
          return { ok: false as const, error: { message: 'query failed' } };
        }
        return { ok: true as const, value: { records: [] } };
      },
    });

    const s = await captureDataShape(store, 'some-org', {
      executors: ex,
      now: '2026-06-10T03:00:00.000Z',
    });
    expect(s.holderFacts).toBe(0);
    const holders = await readFacts(store, { metric: 'activeHolders' });
    if (!holders.ok) throw new Error(holders.error.message);
    expect(holders.value).toHaveLength(1);
    expect(holders.value[0]?.value).toBe(99);
    expect(holders.value[0]?.capturedAt).toBe(oldStamp);
  });

  it('writes explicit zeros and clears stale rows only after a complete recapture', async () => {
    const seeded = await writeFacts(store, [{
      subjectId: 'PermissionSet:Power_User',
      metric: 'activeHolders',
      value: 99,
      capturedAt: '2026-06-09T03:00:00.000Z',
      method: 'aggregate-soql',
      source: 'refresh-with-data-shape',
    }]);
    if (!seeded.ok) throw new Error(seeded.error.message);
    const ex = executors({
      restGet: async (_auth, path) => {
        if (path.includes('/limits/recordCount')) {
          return { ok: true as const, value: { sObjects: [] } };
        }
        if (path.includes('PermissionSetAssignment') || path.includes('FROM%20User') || path.includes('FROM User')) {
          return { ok: true as const, value: { records: [] } };
        }
        return { ok: true as const, value: { records: [] } };
      },
    });

    const stamp = '2026-06-10T03:00:00.000Z';
    const s = await captureDataShape(store, 'some-org', { executors: ex, now: stamp });
    expect(s.holderFacts).toBe(2);
    const holders = await readFacts(store, { metric: 'activeHolders' });
    if (!holders.ok) throw new Error(holders.error.message);
    const rows = holders.value.filter((f) => f.subjectId !== ACTIVE_HOLDERS_COMPLETE_SUBJECT);
    expect(rows).toHaveLength(2);
    expect(rows.every((f) => f.value === 0 && f.capturedAt === stamp)).toBe(true);
  });

  it('captures explicit holder rows beyond the old 500-container page', async () => {
    const extraSets: ExtractionResult = {
      nodes: Array.from({ length: 501 }, (_, i) =>
        node(`PermissionSet:Extra_${String(i).padStart(3, '0')}`, 'PermissionSet', `Extra_${String(i).padStart(3, '0')}`),
      ),
      edges: [],
    } as never;
    const imported = await importExtractionResults(store, [extraSets]);
    if (!imported.ok) throw new Error(imported.error.message);
    const ex = executors({
      restGet: async (_auth, path) => {
        if (path.includes('/limits/recordCount')) {
          return { ok: true as const, value: { sObjects: [] } };
        }
        return { ok: true as const, value: { records: [] } };
      },
    });

    const s = await captureDataShape(store, 'some-org', { executors: ex });
    expect(s.holderFacts).toBe(503);
    const last = await readFacts(store, {
      subjectId: 'PermissionSet:Extra_500',
      metric: 'activeHolders',
    });
    expect(last.ok && last.value[0]?.value).toBe(0);
  });

  it('dataShapeBudget honors the env with a floor', () => {
    expect(dataShapeBudget()).toBe(60);
    process.env['SFI_DATA_SHAPE_BUDGET'] = '10';
    expect(dataShapeBudget()).toBe(10);
    process.env['SFI_DATA_SHAPE_BUDGET'] = '1';
    expect(dataShapeBudget()).toBe(60);
  });
});
