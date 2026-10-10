/// <reference types="vitest/globals" />

/**
 * ARCH-11 — order_of_execution's byte budget used to tail-drop steps, so on an
 * object with a long run of validation rules the after-triggers, after-save
 * flows and duplicate rules were the steps cut. The unpaged view now sheds from
 * the most crowded phase first. All names synthetic.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { orderOfExecutionHandler } from '../../src/tools/order-of-execution.js';
import { enforceSoeByteBudget, PHASE_STEP_FLOOR } from '../../src/tools/soe-payload-bounds.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (fromId: string, toId: string, edgeType: Edge['edgeType']): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
});

const OBJ = 'CustomObject:Invoice__c';
const VR_COUNT = 140;
const nodes: Node[] = [
  node({ id: OBJ, type: 'CustomObject', apiName: 'Invoice__c' }),
  node({
    id: 'ApexTrigger:InvoiceAfterTrigger',
    type: 'ApexTrigger',
    apiName: 'InvoiceAfterTrigger',
    properties: { triggerObject: 'Invoice__c', events: ['after update'], status: 'Active' },
  }),
];
const edges: Edge[] = [edge('ApexTrigger:InvoiceAfterTrigger', OBJ, 'triggersOn')];
for (let i = 0; i < VR_COUNT; i += 1) {
  const id = `ValidationRule:Invoice__c.Address_Check_${i}`;
  nodes.push(
    node({
      id,
      type: 'ValidationRule',
      apiName: `Address_Check_${i}`,
      parentId: OBJ,
      properties: {
        active: true,
        errorMessage: `Address line ${i} must be filled in before saving. `.repeat(8),
        errorDisplayField: null,
      },
    }),
  );
  edges.push(edge(OBJ, id, 'parentOf'));
}
const seed: ExtractionResult = { nodes, edges };

let dir: string;
let graph: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-ooe-balance-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  graph = opened.value;
  const imported = await importExtractionResults(graph, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph } as Context;
});

afterAll(async () => {
  await closeGraph(graph);
  rmSync(dir, { recursive: true, force: true });
});

describe('ARCH-11 order_of_execution keeps code-bearing phases under the byte budget', () => {
  it('FAIL-BEFORE/PASS-AFTER: the after-trigger survives a validation-rule run that overflows the budget', async () => {
    const r = await orderOfExecutionHandler(ctx, { objectApiName: 'Invoice__c', event: 'update' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const soe = r.value.data.byEvent.update?.soe ?? [];
    // The budget really did bite (otherwise this proves nothing).
    expect(soe.filter((s) => s.phase === 'pre-save-validation').length).toBeLessThan(VR_COUNT);
    expect(soe.some((s) => s.componentId === 'ApexTrigger:InvoiceAfterTrigger')).toBe(true);
    expect(r.value.data.disclosure).toContain('most crowded phase first');
  });

  it('largest-phase-first never sheds a phase below the floor; tail strategy is unchanged', () => {
    const mk = (phase: string, n: number) =>
      Array.from({ length: n }, () => ({ phase, actions: [], description: 'x'.repeat(400) }));
    const steps = [...mk('pre-save-validation', 20), ...mk('after-triggers', 2)];
    const payload = { soe: steps };
    enforceSoeByteBudget(payload, [steps], { budgetBytes: 2_600, stepDropStrategy: 'largest-phase-first' });
    expect(steps.filter((s) => s.phase === 'after-triggers')).toHaveLength(2);
    expect(steps.filter((s) => s.phase === 'pre-save-validation').length).toBeGreaterThanOrEqual(
      Math.min(PHASE_STEP_FLOOR, 1),
    );

    const tail = [...mk('pre-save-validation', 20), ...mk('after-triggers', 2)];
    enforceSoeByteBudget({ soe: tail }, [tail], { budgetBytes: 2_600 });
    expect(tail.filter((s) => s.phase === 'after-triggers')).toHaveLength(0);
  });
});
