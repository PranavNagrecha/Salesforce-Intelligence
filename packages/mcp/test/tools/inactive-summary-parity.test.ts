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
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { orderOfExecutionHandler } from '../../src/tools/order-of-execution.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

/**
 * ONE inactive-roster census, shared by both save-order tools.
 *
 * `what_happens_on_save` and `order_of_execution` each carried a byte-identical
 * private copy of `SoeInactiveSummary` / `inactiveByType` / the note builders /
 * `buildInactiveSummary`, under a comment promising the two would "stay in
 * lockstep, so a rewording here is a code-review concern, not a drift". A
 * comment is not a mechanism — it is the same seam that let two constants named
 * `UNPROVEN_REGISTRATION_DISCLOSURE` ship different text.
 *
 * The definition now lives once in `soe-active.ts`. This pins the OBSERVABLE
 * consequence: for the same object and the same knobs, both tools render the
 * same census, byte for byte. A re-fork fails here rather than shipping.
 */

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-inactive-parity',
};

const OBJ = 'CustomObject:WidgetShipment__c';

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
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
  source: 'metadata',
  properties: {},
  ...overrides,
});

/** Six Draft/Obsolete Flows plus two inactive WorkflowRules — a mixed roster. */
const seed = (): ExtractionResult => {
  const nodes: Node[] = [
    makeNode({ id: OBJ, apiName: 'WidgetShipment__c', properties: { sharingModel: 'Private' } }),
  ];
  const edges: Edge[] = [];
  for (let i = 0; i < 6; i += 1) {
    const id = `Flow:WidgetShipment_Retired_Route_${i}`;
    nodes.push(
      makeNode({
        id,
        type: 'Flow',
        apiName: `WidgetShipment_Retired_Route_${i}`,
        properties: { status: i % 2 === 0 ? 'Draft' : 'Obsolete' },
      }),
    );
    edges.push(
      makeEdge({
        fromId: id,
        toId: OBJ,
        edgeType: 'triggersOn',
        properties: { recordTriggerType: 'CreateAndUpdate', triggerType: 'RecordAfterSave' },
      }),
    );
  }
  for (let i = 0; i < 2; i += 1) {
    const id = `WorkflowRule:WidgetShipment__c.Retired_Alert_${i}`;
    nodes.push(
      makeNode({
        id,
        type: 'WorkflowRule',
        apiName: `WidgetShipment__c.Retired_Alert_${i}`,
        parentId: OBJ,
        properties: { active: false },
      }),
    );
    edges.push(makeEdge({ fromId: OBJ, toId: id, edgeType: 'parentOf' }));
    edges.push(
      makeEdge({
        fromId: id,
        toId: OBJ,
        edgeType: 'triggersOn',
        properties: { triggerType: 'onCreateOrTriggeringUpdate' },
      }),
    );
  }
  return { nodes, edges };
};

const withStore = async <T>(run: (ctx: Context) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), 'sfi-inactive-parity-'));
  const opened = await openGraph(join(dir, 'parity.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  const imported = await importExtractionResults(store, [seed()]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  const out = await run({ vaultRoot: dir, manifest: MANIFEST, graph: store } as Context);
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
  return out;
};

/** The four input shapes the census renders differently. */
const KNOB_MATRIX = [
  { label: 'bare', knobs: {} },
  { label: 'includeInactive', knobs: { includeInactive: true } },
  { label: 'phase', knobs: { phase: 'pre-save-validation' as const } },
  {
    label: 'phase + includeInactive',
    knobs: { phase: 'pre-save-validation' as const, includeInactive: true },
  },
] as const;

describe('the inactive-roster census is ONE definition (both save-order tools)', () => {
  for (const { label, knobs } of KNOB_MATRIX) {
    it(`renders identically in what_happens_on_save and order_of_execution — ${label}`, async () => {
      const [save, ooe] = await withStore(async (ctx) => {
        const s = await whatHappensOnSaveHandler(ctx, {
          objectApiName: 'WidgetShipment__c',
          event: 'update',
          ...knobs,
        } as never);
        const o = await orderOfExecutionHandler(ctx, {
          objectApiName: 'WidgetShipment__c',
          events: ['update'],
          ...knobs,
        } as never);
        if (!s.ok) throw new Error(`what_happens_on_save failed: ${s.error.message}`);
        if (!o.ok) throw new Error(`order_of_execution failed: ${o.error.message}`);
        return [s.value.data.inactiveSummary, o.value.data.inactiveSummary] as const;
      });
      // The roster itself must be the same on both — otherwise the note
      // comparison below is comparing two different populations.
      expect(save.total).toBe(8);
      expect(ooe.total).toBe(save.total);
      expect(ooe.byType).toEqual(save.byType);
      expect(ooe.included).toBe(save.included);
      // The point of the test: byte-identical prose, from one builder.
      expect(ooe.note).toBe(save.note);
    });
  }

  it('the census sentence is present on EVERY branch — a zero-equivalent is never silent', async () => {
    const notes = await withStore(async (ctx) => {
      const out: string[] = [];
      for (const { knobs } of KNOB_MATRIX) {
        const s = await whatHappensOnSaveHandler(ctx, {
          objectApiName: 'WidgetShipment__c',
          event: 'update',
          ...knobs,
        } as never);
        if (!s.ok) throw new Error('handler failed');
        out.push(s.value.data.inactiveSummary.note);
      }
      return out;
    });
    for (const note of notes) {
      expect(note).toContain('They were CHECKED and counted, not skipped.');
      // Exactly one remedy sentence per branch — never a remedy the next
      // sentence negates (S4).
      expect(note.match(/for the full list|is in inactiveConfigured/g)).toHaveLength(1);
    }
  });
});
