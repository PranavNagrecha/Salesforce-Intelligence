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
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { recordCreationPathsHandler } from '../../src/tools/record-creation-paths.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, Flow: 1, ApexTrigger: 1 },
  edges: { writesTo: 1, triggersOn: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Widget__c',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
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
  source: 'unit-test',
  properties: {},
  ...overrides,
});

const WIDGET = 'CustomObject:Widget__c';
const CREATOR_FLOW = 'Flow:Create_Widget';
const WIDGET_TRIGGER = 'ApexTrigger:WidgetTrigger';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: WIDGET, type: 'CustomObject', apiName: 'Widget__c' }),
    makeNode({ id: CREATOR_FLOW, type: 'Flow', apiName: 'Create_Widget' }),
    makeNode({ id: WIDGET_TRIGGER, type: 'ApexTrigger', apiName: 'WidgetTrigger' }),
  ],
  edges: [
    // A Flow that inserts Widget__c records (the only modeled creator class).
    makeEdge({
      fromId: CREATOR_FLOW,
      toId: WIDGET,
      edgeType: 'writesTo',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    // A trigger that fires on save.
    makeEdge({ fromId: WIDGET_TRIGGER, toId: WIDGET, edgeType: 'triggersOn' }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-rcp-'));
  const opened = await openGraph(join(tempDir, 'rcp.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('recordCreationPathsHandler', () => {
  it('lists the Flow creator and the trigger', async () => {
    const r = await recordCreationPathsHandler(ctx, { objectApiName: 'Widget__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.creatorCount).toBe(1);
    expect(r.value.data.creators[0]?.sourceId).toBe(CREATOR_FLOW);
    expect(r.value.data.triggerCount).toBe(1);
  });

  it('qualifies the count as Flow creators and discloses that Apex inserts are unmodeled', async () => {
    // The creator detection only sees Flow recordCreates. Apex `insert x;`
    // (static) and Database.insert (dynamic) are NOT modeled — so an object
    // created only by Apex (e.g. real acme Marketo_Log__c, inserted by
    // MRK_LoggerHelper) reports 0 creators. The framing must say "Flow"
    // (not bare "automation") and the disclosure must flag the Apex gap so
    // "0 creators" isn't read as "nothing creates this".
    const r = await recordCreationPathsHandler(ctx, { objectApiName: 'Widget__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.rendered).toMatch(/Flow automation/);
    expect(r.value.data.rendered).toMatch(/Apex/);
    expect(r.value.data.rendered).toMatch(/insert/i);
  });
});
