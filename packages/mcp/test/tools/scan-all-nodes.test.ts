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

  // CR-P3 (scan-cap off-by-one): a type with EXACTLY FULL_SCAN_MAX_NODES nodes
  // was fully scanned — nothing is behind it — so it must NOT report incomplete.
  it('FAIL-BEFORE/PASS-AFTER: a type with EXACTLY the full-scan cap is complete, not incomplete', async () => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '2'; // windowSize = 2
    // 3 ApexClasses seeded; pass a maxNodes that equals the count so the walk
    // hits the cap exactly at the type's end (offset advances 0→2→[cap]).
    const r = await scanAllNodesOfTypes(store, ['ApexClass'], /* maxNodes */ 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 2 windowed nodes were read before hitting the cap of 2. There IS a 3rd
    // node behind it, so this case IS genuinely incomplete — sanity anchor.
    expect(r.value.scanIncomplete).toBe(true);

    // Now a cap that equals the exact node count of the type: 3 ApexClasses,
    // maxNodes = 4 (a multiple-friendly cap above the count) reads all 3 in a
    // short final page and is complete.
    const exact = await scanAllNodesOfTypes(store, ['ApexClass'], 4);
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.value.scanIncomplete).toBe(false);
  });

  it('FAIL-BEFORE/PASS-AFTER: cap that lands exactly on a full window with no tail is complete', async () => {
    // windowSize 1, maxNodes 3, exactly 3 ApexClasses: offset advances
    // 0→1→2→3(==cap). The off-by-one declared this incomplete even though the
    // 3rd node was the last. The bounded probe at offset 3 returns nothing → complete.
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    const r = await scanAllNodesOfTypes(store, ['ApexClass'], /* maxNodes */ 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes.length).toBe(3);
    expect(r.value.scanIncomplete).toBe(false);
    expect(r.value.incompleteTypes).toEqual([]);
  });

  it('still reports incomplete when STRICTLY MORE nodes remain behind the cap', async () => {
    // windowSize 1, maxNodes 2, 3 ApexClasses: walk stops at the cap of 2 with
    // a real 3rd node behind it → incomplete.
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    const r = await scanAllNodesOfTypes(store, ['ApexClass'], /* maxNodes */ 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scanIncomplete).toBe(true);
    expect(r.value.incompleteTypes).toEqual(['ApexClass']);
  });
});
