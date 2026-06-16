/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const e = (fromId: string, toId: string, edgeType: Edge['edgeType']): Edge =>
  ({ fromId, toId, edgeType, confidence: 'declared', source: 't', properties: {} });

const OPP = 'CustomObject:Opportunity';
const TYPE = 'CustomField:Opportunity.Type__c';
const STAGE = 'CustomField:Opportunity.Stage__c';
const VR = 'ValidationRule:Opportunity.TypeCheck';
const FLOW = 'Flow:StageRouter';

const seed: ExtractionResult = {
  nodes: [
    mk({ id: OPP, type: 'CustomObject', apiName: 'Opportunity' }),
    mk({ id: TYPE, type: 'CustomField', apiName: 'Type__c', parentId: OPP, properties: { dataType: 'Picklist' } }),
    mk({ id: STAGE, type: 'CustomField', apiName: 'Stage__c', parentId: OPP, properties: { dataType: 'Picklist' } }),
    mk({ id: VR, type: 'ValidationRule', apiName: 'Opportunity.TypeCheck', parentId: OPP }),
    mk({ id: FLOW, type: 'Flow', apiName: 'StageRouter' }),
    // criteria ConditionalContext: canonical fieldRefs + literal in expression.
    mk({ id: `ConditionalContext:${VR}.condition-0`, type: 'ConditionalContext', apiName: 'c', properties: { kind: 'criteria', expression: 'Opportunity.Type__c equals "ESE,Extended Ed"', fieldRefs: [TYPE] } }),
    // flow ConditionalContext: EMPTY fieldRefs, field name only in the expression.
    mk({ id: `ConditionalContext:${FLOW}.condition-0`, type: 'ConditionalContext', apiName: 'c', properties: { kind: 'flow-decision', expression: "ISPICKVAL({!$Record.Stage__c},'Won')", fieldRefs: [] } }),
  ],
  edges: [
    e(OPP, TYPE, 'parentOf'), e(OPP, STAGE, 'parentOf'),
    e(VR, TYPE, 'references'),       // makes Type__c get an automation bucket
    e(FLOW, STAGE, 'readsFrom'),     // makes Stage__c get an automation bucket
    e(VR, `ConditionalContext:${VR}.condition-0`, 'firesWhen'),
    e(FLOW, `ConditionalContext:${FLOW}.condition-0`, 'firesWhen'),
  ],
};

let dir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-lit-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(dir, { recursive: true, force: true }); });

const automationOf = async (id: string) => {
  const n = await getNodeById(ctx.graph, id as Node['id']);
  if (!n.ok || n.value === null) throw new Error(`missing ${id}`);
  const r = await assessValueChange(ctx, n.value);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.buckets.find((b) => b.bucket === 'automation');
};

describe('declarative value-literal coupling', () => {
  it('surfaces the literal from a criteria ConditionalContext (matched by fieldRefs)', async () => {
    const a = (await automationOf(TYPE))!;
    expect(a).toBeDefined();
    expect(a.summary).toMatch(/Value-coupled/);
    expect(a.summary).toContain('ESE,Extended Ed');
    expect(a.confidence).toBe('confirmed');
  });

  it('surfaces the literal from a flow ConditionalContext (matched by field name in expression)', async () => {
    const a = (await automationOf(STAGE))!;
    expect(a).toBeDefined();
    expect(a.summary).toMatch(/Value-coupled/);
    expect(a.summary).toContain('Won');
  });
});
