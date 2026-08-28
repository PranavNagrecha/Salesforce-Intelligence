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

const node = (
  id: string,
  type: Node['type'],
  apiName: string,
  parentId: Node['parentId'] = null,
): Node => ({
  id,
  type,
  apiName,
  label: null,
  parentId,
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
      // Two parents whose CustomField children INTERLEAVE in the id-ASC order
      // the scan walks, so a missing `parentId` narrow is visible as foreign
      // rows rather than as a harmless extra tail.
      node('CustomObject:Alpha__c', 'CustomObject', 'Alpha__c'),
      node('CustomObject:Beta__c', 'CustomObject', 'Beta__c'),
      node('CustomField:Alpha__c.F1__c', 'CustomField', 'F1__c', 'CustomObject:Alpha__c'),
      node('CustomField:Alpha__c.F2__c', 'CustomField', 'F2__c', 'CustomObject:Alpha__c'),
      node('CustomField:Beta__c.G1__c', 'CustomField', 'G1__c', 'CustomObject:Beta__c'),
      node('CustomField:Beta__c.G2__c', 'CustomField', 'G2__c', 'CustomObject:Beta__c'),
      node('CustomField:Beta__c.G3__c', 'CustomField', 'G3__c', 'CustomObject:Beta__c'),
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

/**
 * The windowing walk existed in THREE copies because this helper could express
 * only `types` — `live-drift-check.ts` (`scanObjectFields`) and
 * `value-change-audit.ts` (`listObjectFields`) each re-implemented it purely to
 * add a `parentId` narrow, and the second of those copies is unbounded with no
 * residual-cap disclosure at all. These cases pin the narrow so the shape can
 * live in exactly one place (R6 adoption).
 */
describe('scanAllNodesOfTypes — parentId narrow', () => {
  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('FAIL-BEFORE/PASS-AFTER: narrows the walk to ONE parent instead of the whole type', async () => {
    const r = await scanAllNodesOfTypes(store, ['CustomField'], {
      parentId: 'CustomObject:Alpha__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Without the narrow this is all FIVE CustomFields — three of them belong
    // to a different object, which is exactly the wrong answer a caller that
    // asked about one object would have been handed.
    expect(r.value.nodes.map((n) => n.id)).toEqual([
      'CustomField:Alpha__c.F1__c',
      'CustomField:Alpha__c.F2__c',
    ]);
    expect(r.value.scanIncomplete).toBe(false);
  });

  it('FAIL-BEFORE/PASS-AFTER: the narrow survives MULTI-WINDOW paging, not just the first page', async () => {
    // windowSize 1 forces three windows over Beta's three fields. An unnarrowed
    // OFFSET walk would interleave Alpha's rows into the result.
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    const r = await scanAllNodesOfTypes(store, ['CustomField'], {
      parentId: 'CustomObject:Beta__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes.map((n) => n.id)).toEqual([
      'CustomField:Beta__c.G1__c',
      'CustomField:Beta__c.G2__c',
      'CustomField:Beta__c.G3__c',
    ]);
    expect(r.value.scanIncomplete).toBe(false);
  });

  it('FAIL-BEFORE/PASS-AFTER: the CR-P3 cap probe is narrowed too — a foreign row must not fake incompleteness', async () => {
    // windowSize 1, maxNodes 2, and Alpha has EXACTLY 2 fields, so the walk
    // stops at the cap with the type's own rows exhausted. The bounded probe
    // reads offset 2: narrowed it sees nothing (complete); UNNARROWED it sees
    // Beta's first field and reports a residual cap that does not exist.
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    const r = await scanAllNodesOfTypes(store, ['CustomField'], {
      parentId: 'CustomObject:Alpha__c',
      maxNodes: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes.length).toBe(2);
    expect(r.value.scanIncomplete).toBe(false);
    expect(r.value.incompleteTypes).toEqual([]);
  });

  it('still discloses a real residual cap under a narrow', async () => {
    // Beta has THREE fields; cap the walk at 2 → one genuinely remains behind.
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    const r = await scanAllNodesOfTypes(store, ['CustomField'], {
      parentId: 'CustomObject:Beta__c',
      maxNodes: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scanIncomplete).toBe(true);
    expect(r.value.incompleteTypes).toEqual(['CustomField']);
  });

  it('a WRONG-CASE parent id yields an honest empty walk — the helper does not resolve existence', async () => {
    // `customobject:alpha__c` is not a stored id. The narrow is a SQL equality,
    // so this is an empty scan, NOT an error and NOT the whole type. Callers
    // must verify the object exists first (input-aliases `resolveExistingObjectScope`)
    // or they will render a confident "nothing found" for a real object.
    const r = await scanAllNodesOfTypes(store, ['CustomField'], {
      parentId: 'customobject:alpha__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes).toEqual([]);
    expect(r.value.scanIncomplete).toBe(false);
  });

  it('the legacy positional maxNodes still means maxNodes (no silent behaviour swap)', async () => {
    // 55+ call sites pass a bare number here. Widening the parameter must not
    // reinterpret it — this is the drift test for the union.
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    const legacy = await scanAllNodesOfTypes(store, ['CustomField'], 2);
    const object = await scanAllNodesOfTypes(store, ['CustomField'], { maxNodes: 2 });
    expect(legacy.ok).toBe(true);
    expect(object.ok).toBe(true);
    if (!legacy.ok || !object.ok) return;
    expect(legacy.value.nodes.map((n) => n.id)).toEqual(object.value.nodes.map((n) => n.id));
    expect(legacy.value.scanIncomplete).toBe(true);
    expect(object.value.scanIncomplete).toBe(true);
  });
});
