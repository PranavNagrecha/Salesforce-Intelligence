/// <reference types="vitest/globals" />

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  getNodeById,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { assessValueChange } from '../../src/tools/value-change-risk.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0', refreshedAt: '2026-06-01T00:00:00Z', sourceOrg: 'me@example.com',
  components: {}, edges: {}, sourceTreeHash: 'sha256:fixture', coverageComputedAt: '2026-06-01T00:00:00.000Z', coverage: [],
};
const mk = (o: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: 'x', label: null, parentId: null, sourcePath: 'x', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const fld = (obj: string, name: string, props: Record<string, unknown>): Node =>
  mk({ id: `CustomField:${obj}.${name}`, type: 'CustomField', apiName: name, parentId: `CustomObject:${obj}`, properties: { dataType: 'Text', ...props } });

const SIS = 'External_Ref_Id__c';
const seed: ExtractionResult = {
  nodes: [
    mk({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    mk({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
    mk({ id: 'CustomObject:Sample_Exam__c', type: 'CustomObject', apiName: 'Sample_Exam__c' }),
    // SIS key: External ID on Account + Contact (masters), plain copy on Sample_Exam__c.
    fld('Account', SIS, { externalId: true }),
    fld('Contact', SIS, { externalId: true }),
    fld('Sample_Exam__c', SIS, { externalId: false }),
    // Region_Code__c: keyish NAME on two objects but NO External ID -> NOT a shadow join.
    fld('Account', 'Region_Code__c', { externalId: false }),
    fld('Contact', 'Region_Code__c', { externalId: false }),
  ],
  edges: [
    { fromId: 'CustomObject:Account', toId: `CustomField:Account.${SIS}`, edgeType: 'parentOf', confidence: 'declared', source: 't', properties: {} },
    { fromId: 'CustomObject:Contact', toId: `CustomField:Contact.${SIS}`, edgeType: 'parentOf', confidence: 'declared', source: 't', properties: {} },
    { fromId: 'CustomObject:Sample_Exam__c', toId: `CustomField:Sample_Exam__c.${SIS}`, edgeType: 'parentOf', confidence: 'declared', source: 't', properties: {} },
    { fromId: 'CustomObject:Account', toId: 'CustomField:Account.Region_Code__c', edgeType: 'parentOf', confidence: 'declared', source: 't', properties: {} },
    { fromId: 'CustomObject:Contact', toId: 'CustomField:Contact.Region_Code__c', edgeType: 'parentOf', confidence: 'declared', source: 't', properties: {} },
  ] as Edge[],
};

let dir: string;
let store: GraphStore;
let ctx: Context;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-shadow-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(dir, { recursive: true, force: true }); });

const assess = async (id: string) => {
  const n = await getNodeById(ctx.graph, id as Node['id']);
  if (!n.ok || n.value === null) throw new Error(`missing ${id}`);
  const r = await assessValueChange(ctx, n.value);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const xobj = (a: Awaited<ReturnType<typeof assess>>) => a.buckets.find((b) => b.bucket === 'cross-object');

describe('cross-object shadow-join detection', () => {
  it('flags a master External-ID key replicated across objects as high cross-object', async () => {
    const a = await assess(`CustomField:Account.${SIS}`);
    const x = xobj(a)!;
    expect(x).toBeDefined();
    expect(x.severity).toBe('high');
    expect(x.summary).toContain('replicated on 3 objects');
  });

  it('flags the plain copy as medium cross-object', async () => {
    const x = xobj(await assess(`CustomField:Sample_Exam__c.${SIS}`))!;
    expect(x).toBeDefined();
    expect(x.severity).toBe('medium');
  });

  it('does NOT flag a keyish-named field with no External-ID master (common name, not a shadow join)', async () => {
    const a = await assess('CustomField:Account.Region_Code__c');
    expect(xobj(a)).toBeUndefined();
  });
});

// =============================================================================
// R6 — detectShadowJoin's CustomField scan was a hand-rolled `listNodesByType`
// offset loop (500 hardcoded, no `FULL_SCAN_MAX_NODES` residual ceiling, no
// `scanIncomplete` concept at all) — a second/third copy of the walk
// `scan-all-nodes.ts` exists to own, alongside `findValueCouplings`'s identical
// copy for `ConditionalContext`. Neither could ever disclose a capped scan: a
// shadow-join verdict computed over a truncated corpus still read as a
// confident answer with no state to say "the scan did not finish".
// =============================================================================
describe('CustomField full-scan adoption (R6)', () => {
  it('DRIFT GUARD: issues no hand-rolled listNodesByType CustomField/ConditionalContext scan', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/tools/value-change-risk.ts'),
      'utf8',
    );
    expect(/listNodesByType\(ctx\.graph, 'CustomField'/.test(src)).toBe(false);
    expect(/listNodesByType\(ctx\.graph, 'ConditionalContext'/.test(src)).toBe(false);
    expect(src).toContain('scanAllNodesOfTypes');
  });

  describe('residual scan-cap disclosure', () => {
    const saved = {
      window: process.env['SFI_NODE_SCAN_LIMIT'],
      ceiling: process.env['SFI_VALUE_CHANGE_SCAN_MAX'],
    };
    afterEach(() => {
      if (saved.window === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = saved.window;
      if (saved.ceiling === undefined) delete process.env['SFI_VALUE_CHANGE_SCAN_MAX'];
      else process.env['SFI_VALUE_CHANGE_SCAN_MAX'] = saved.ceiling;
    });

    it('discloses an incomplete CustomField scan instead of a silent confident verdict', async () => {
      // 5 CustomField nodes are seeded; a window/ceiling of 2 leaves 3 behind it.
      process.env['SFI_NODE_SCAN_LIMIT'] = '2';
      process.env['SFI_VALUE_CHANGE_SCAN_MAX'] = '2';
      const a = await assess(`CustomField:Account.${SIS}`);
      expect(a.disclosures.some((d) => /full scan capped/i.test(d))).toBe(true);
    });

    it('does NOT over-disclose when the CustomField scan completes', async () => {
      const a = await assess(`CustomField:Account.${SIS}`);
      expect(a.disclosures.some((d) => /full scan capped/i.test(d))).toBe(false);
    });
  });
});
