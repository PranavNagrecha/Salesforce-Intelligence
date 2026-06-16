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
import {
  fieldProvenanceHandler,
  fieldProvenanceInputSchema,
} from '../../src/tools/field-provenance.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 3, CustomField: 4, ApexClass: 2, Flow: 1 },
  edges: { parentOf: 4, writesTo: 3, references: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Foo__c',
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

// =============================================================================
// Seeds:
//   Q151 — Opportunity.Customer_Health_Score__c (declared formula)
//   Q152 — Contact.External_Customer_Id__c (integration-synced via Stripe)
//   Q153 — Account.Close_Date__c (Flow writer, manual-and-coded)
//   Q147 — Account.Internal_Notes__c (no writers, manual)
//   Pre-v2.9 — Account.Old_Field__c (no sourceOfTruth populated)
// =============================================================================

const OPP_OBJ = 'CustomObject:Opportunity';
const CONTACT_OBJ = 'CustomObject:Contact';
const ACCOUNT_OBJ = 'CustomObject:Account';

const FORMULA_FIELD = 'CustomField:Opportunity.Customer_Health_Score__c';
const INTEG_FIELD = 'CustomField:Contact.External_Customer_Id__c';
const FLOW_WRITTEN_FIELD = 'CustomField:Account.Close_Date__c';
const MANUAL_FIELD = 'CustomField:Account.Internal_Notes__c';
const PRE_V29_FIELD = 'CustomField:Account.Old_Field__c';

const STRIPE_INTEGRATION = 'ApexClass:StripeIntegrationService';
const STRIPE_CRED = 'NamedCredential:Stripe';
const PLAIN_APEX = 'ApexClass:RegularUpdater';
const CLOSE_FLOW = 'Flow:Close_Opportunity_Flow';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: OPP_OBJ, type: 'CustomObject', apiName: 'Opportunity' }),
    makeNode({ id: CONTACT_OBJ, type: 'CustomObject', apiName: 'Contact' }),
    makeNode({ id: ACCOUNT_OBJ, type: 'CustomObject', apiName: 'Account' }),
    // Q151: formula field. sourceOfTruth declared:derived.
    makeNode({
      id: FORMULA_FIELD,
      type: 'CustomField',
      apiName: 'Customer_Health_Score__c',
      label: 'Customer Health Score',
      parentId: OPP_OBJ,
      properties: {
        label: 'Customer Health Score',
        type: 'Formula',
        formula: 'Renewal_Probability__c * Engagement_Score__c',
        sourceOfTruth: { value: 'derived', confidence: 'declared' },
        semanticCategory: { value: 'unknown', confidence: 'heuristic' },
      },
    }),
    // Q152: integration-synced field. Single Apex writer that references
    // a NamedCredential.
    makeNode({
      id: INTEG_FIELD,
      type: 'CustomField',
      apiName: 'External_Customer_Id__c',
      label: 'External Customer Id',
      parentId: CONTACT_OBJ,
      properties: {
        label: 'External Customer Id',
        type: 'Text',
        sourceOfTruth: {
          value: 'integration-synced',
          confidence: 'heuristic',
        },
        semanticCategory: { value: 'identifier', confidence: 'heuristic' },
      },
    }),
    // Q153: flow-written field. manual-and-coded classification.
    makeNode({
      id: FLOW_WRITTEN_FIELD,
      type: 'CustomField',
      apiName: 'Close_Date__c',
      label: 'Close Date',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Close Date',
        type: 'Date',
        sourceOfTruth: {
          value: 'manual-and-coded',
          confidence: 'heuristic',
        },
        semanticCategory: { value: 'date', confidence: 'heuristic' },
      },
    }),
    // Q147: no writers, no formula → manual.
    makeNode({
      id: MANUAL_FIELD,
      type: 'CustomField',
      apiName: 'Internal_Notes__c',
      label: 'Internal Notes',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Internal Notes',
        type: 'TextArea',
        sourceOfTruth: { value: 'manual', confidence: 'heuristic' },
        semanticCategory: { value: 'descriptor', confidence: 'heuristic' },
      },
    }),
    // Pre-v2.9: no classification populated.
    makeNode({
      id: PRE_V29_FIELD,
      type: 'CustomField',
      apiName: 'Old_Field__c',
      label: 'Old Field',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Old Field',
        type: 'Text',
      },
    }),
    // Apex writers.
    makeNode({
      id: STRIPE_INTEGRATION,
      type: 'ApexClass',
      apiName: 'StripeIntegrationService',
    }),
    makeNode({
      id: STRIPE_CRED,
      type: 'NamedCredential',
      apiName: 'Stripe',
    }),
    makeNode({
      id: PLAIN_APEX,
      type: 'ApexClass',
      apiName: 'RegularUpdater',
    }),
    // Flow writer.
    makeNode({
      id: CLOSE_FLOW,
      type: 'Flow',
      apiName: 'Close_Opportunity_Flow',
    }),
  ],
  edges: [
    // Stripe writes to the integration field, AND references the
    // NamedCredential (v2.0a integration tagging).
    makeEdge({
      fromId: STRIPE_INTEGRATION,
      toId: INTEG_FIELD,
      edgeType: 'writesTo',
      confidence: 'heuristic',
    }),
    makeEdge({
      fromId: STRIPE_INTEGRATION,
      toId: STRIPE_CRED,
      edgeType: 'references',
      confidence: 'declared',
    }),
    // RegularUpdater writes to the integration field too — but it has
    // NO references edge. This proves isIntegrationTagged is per-writer.
    makeEdge({
      fromId: PLAIN_APEX,
      toId: INTEG_FIELD,
      edgeType: 'writesTo',
      confidence: 'heuristic',
    }),
    // Flow writes to the Close_Date field.
    makeEdge({
      fromId: CLOSE_FLOW,
      toId: FLOW_WRITTEN_FIELD,
      edgeType: 'writesTo',
      confidence: 'declared',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-provenance-'));
  const dbPath = join(tempDir, 'provenance.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('fieldProvenanceInputSchema', () => {
  it('accepts a valid fieldId', () => {
    const r = fieldProvenanceInputSchema.safeParse({ fieldId: MANUAL_FIELD });
    expect(r.success).toBe(true);
  });

  it('rejects an empty fieldId', () => {
    const r = fieldProvenanceInputSchema.safeParse({ fieldId: '' });
    expect(r.success).toBe(false);
  });
});

describe('fieldProvenanceHandler', () => {
  it('returns invalid-query for non-CustomField prefix', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: 'ApexClass:Foo',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for unknown ids', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: 'CustomField:Account.Nope__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('Q151: declared formula — surfaces declaredAsFormula trace, noWritersDetected: false', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: FORMULA_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.classification).toEqual({
      value: 'derived',
      confidence: 'declared',
    });
    expect(data.trace.declaredAsFormula).toEqual({
      formula: 'Renewal_Probability__c * Engagement_Score__c',
    });
    expect(data.trace.declaredAsAutoNumber).toBeNull();
    expect(data.trace.apexWriters).toEqual([]);
    expect(data.trace.flowWriters).toEqual([]);
    expect(data.trace.triggerWriters).toEqual([]);
    // Formula IS the source — not noWritersDetected.
    expect(data.trace.noWritersDetected).toBe(false);
    // Declared confidence → heuristic boundary not surfaced.
    expect(
      data.boundaries.some((b) => b.includes('writes-fabric inference')),
    ).toBe(false);
  });

  it('Q152: integration-synced — surfaces apexWriters with isIntegrationTagged per-writer', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: INTEG_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.classification).toEqual({
      value: 'integration-synced',
      confidence: 'heuristic',
    });
    // Two apex writers; Stripe is tagged, RegularUpdater is not.
    expect(data.trace.apexWriters.length).toBe(2);
    const stripe = data.trace.apexWriters.find(
      (w) => w.componentId === STRIPE_INTEGRATION,
    );
    expect(stripe).toBeDefined();
    expect(stripe!.isIntegrationTagged).toBe(true);
    const plain = data.trace.apexWriters.find(
      (w) => w.componentId === PLAIN_APEX,
    );
    expect(plain).toBeDefined();
    expect(plain!.isIntegrationTagged).toBe(false);
    // Heuristic confidence → boundary surfaces.
    expect(
      data.boundaries.some((b) => b.includes('writes-fabric inference')),
    ).toBe(true);
  });

  it('Q153: Flow writer — surfaces flowWriters and manual-and-coded classification', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: FLOW_WRITTEN_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.classification).toEqual({
      value: 'manual-and-coded',
      confidence: 'heuristic',
    });
    expect(data.trace.flowWriters).toEqual([
      { componentId: CLOSE_FLOW, apiName: 'Close_Opportunity_Flow' },
    ]);
    expect(data.trace.apexWriters).toEqual([]);
    expect(data.trace.triggerWriters).toEqual([]);
    expect(data.trace.noWritersDetected).toBe(false);
  });

  it('Q147: manual — empty trace, noWritersDetected: true', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: MANUAL_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.classification).toEqual({
      value: 'manual',
      confidence: 'heuristic',
    });
    expect(data.trace.declaredAsFormula).toBeNull();
    expect(data.trace.declaredAsAutoNumber).toBeNull();
    expect(data.trace.apexWriters).toEqual([]);
    expect(data.trace.flowWriters).toEqual([]);
    expect(data.trace.triggerWriters).toEqual([]);
    expect(data.trace.noWritersDetected).toBe(true);
  });

  it('surfaces classification-missing boundary on pre-v2.9 fields', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: PRE_V29_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.classification).toEqual({
      value: 'unknown',
      confidence: 'heuristic',
    });
    expect(
      result.value.data.boundaries.some((b) =>
        b.includes('classifier has not run'),
      ),
    ).toBe(true);
  });

  it('always surfaces the writes-invisible boundary', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: MANUAL_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.data.boundaries.some((b) =>
        b.includes('Dynamic SOQL'),
      ),
    ).toBe(true);
  });

  it('vaultState carries the manifest hash', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: MANUAL_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });
});
