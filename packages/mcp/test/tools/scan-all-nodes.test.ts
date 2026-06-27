/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import { scanAllNodesOfTypes } from '../../src/tools/scan-all-nodes.js';

const node = (id: string, type: Node['type'], apiName: string): Node => ({
  id,
  type,
  apiName,
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

let dir: string;
let store: GraphStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-scan-all-'));
  const o = await openGraph(join(dir, 'g.db'));
  if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  // 3 ApexClasses + 2 ApexTriggers — small enough that a low cap forces
  // multiple windows.
  const seed: ExtractionResult = {
    nodes: [
      node('ApexClass:A', 'ApexClass', 'A'),
      node('ApexClass:B', 'ApexClass', 'B'),
      node('ApexClass:C', 'ApexClass', 'C'),
      node('ApexTrigger:T1', 'ApexTrigger', 'T1'),
      node('ApexTrigger:T2', 'ApexTrigger', 'T2'),
    ],
    edges: [],
  };
  const i = await importExtractionResults(store, [seed]);
  if (!i.ok) throw new Error(i.error.message);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

describe('scanAllNodesOfTypes (CR-22 B3)', () => {
  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('returns every node of every type in declaration then id-ASC order under the default cap', async () => {
    const r = await scanAllNodesOfTypes(store, ['ApexClass', 'ApexTrigger']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes.map((n) => n.id)).toEqual([
      'ApexClass:A',
      'ApexClass:B',
      'ApexClass:C',
      'ApexTrigger:T1',
      'ApexTrigger:T2',
    ]);
    expect(r.value.scanIncomplete).toBe(false);
    expect(r.value.incompleteTypes).toEqual([]);
  });

  it('FAIL-BEFORE/PASS-AFTER: a cap of 1 still windows past the tail and returns ALL nodes', async () => {
    // The pre-B3 single capped page would have returned ONE node per type and
    // dropped the rest. The windowed scan returns the complete set.
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    const r = await scanAllNodesOfTypes(store, ['ApexClass', 'ApexTrigger']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes.map((n) => n.id)).toEqual([
      'ApexClass:A',
      'ApexClass:B',
      'ApexClass:C',
      'ApexTrigger:T1',
      'ApexTrigger:T2',
    ]);
    // The full scan completed — NOT incomplete despite the cap of 1.
    expect(r.value.scanIncomplete).toBe(false);
  });

  it('a cap > 500 is windowed (clamped), not rejected (RV10)', async () => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '600';
    const r = await scanAllNodesOfTypes(store, ['ApexClass']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes.length).toBe(3);
  });
});
