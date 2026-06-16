/// <reference types="vitest/globals" />

/**
 * Tests for the v3.1 `sfi.field_mapping_between_objects` MCP tool.
 *
 * The Q173 / Q174 anchor — Lead vs Contact field mapping for the
 * conversion. Q174 locks the verbatim heuristic-mapping disclosure:
 * "field-mapping suggestions are heuristic — labels are matched by
 * token overlap and types by compatibility table. Verify each
 * suggested pair against your business rules before relying on the
 * mapping for a migration script."
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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
import {
  registerVault,
  saveManifest,
  vaultPaths,
} from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import {
  fieldMappingBetweenObjectsHandler,
  fieldMappingBetweenObjectsInputSchema,
} from '../../src/tools/field-mapping-between-objects.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2 },
  edges: { parentOf: 4 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Lead',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

let rootDir: string;
let vaultPath: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sfi-v31-field-mapping-'));
  vaultPath = join(rootDir, 'acme-prod');
  await mkdir(join(vaultPath, 'graph'), { recursive: true });
  await saveManifest(vaultPath, FIXTURE_MANIFEST);

  const opened = await openGraph(vaultPaths(vaultPath).graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;

  // Lead with Lead_Score__c (Number) + Industry_Vertical__c (Picklist);
  // Contact with Contact_Score__c (Number) + Vertical__c (Picklist).
  const seed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'CustomObject:Lead', apiName: 'Lead' }),
      makeNode({ id: 'CustomObject:Contact', apiName: 'Contact' }),
      makeNode({
        id: 'CustomField:Lead.Lead_Score__c',
        type: 'CustomField',
        apiName: 'Lead_Score__c',
        label: 'Lead Score',
        parentId: 'CustomObject:Lead',
        properties: { dataType: 'Number' },
      }),
      makeNode({
        id: 'CustomField:Lead.Industry_Vertical__c',
        type: 'CustomField',
        apiName: 'Industry_Vertical__c',
        label: 'Industry Vertical',
        parentId: 'CustomObject:Lead',
        properties: { dataType: 'Picklist' },
      }),
      makeNode({
        id: 'CustomField:Contact.Contact_Score__c',
        type: 'CustomField',
        apiName: 'Contact_Score__c',
        label: 'Contact Score',
        parentId: 'CustomObject:Contact',
        properties: { dataType: 'Number' },
      }),
      makeNode({
        id: 'CustomField:Contact.Vertical__c',
        type: 'CustomField',
        apiName: 'Vertical__c',
        label: 'Vertical',
        parentId: 'CustomObject:Contact',
        properties: { dataType: 'Picklist' },
      }),
      // Rich-text (Html) ↔ LongTextArea: both are text-family types and a
      // migration can map one to the other (Html is the formatted sibling of
      // LongTextArea, which is already text-compatible). Distinct "biography"
      // token so the pair stands alone.
      makeNode({
        id: 'CustomField:Lead.Biography_Notes__c',
        type: 'CustomField',
        apiName: 'Biography_Notes__c',
        label: 'Biography Notes',
        parentId: 'CustomObject:Lead',
        properties: { dataType: 'Html' },
      }),
      makeNode({
        id: 'CustomField:Contact.Biography__c',
        type: 'CustomField',
        apiName: 'Biography__c',
        label: 'Biography',
        parentId: 'CustomObject:Contact',
        properties: { dataType: 'LongTextArea' },
      }),
    ],
    edges: [],
  };

  await importExtractionResults(store, [seed]);
  await registerVault(rootDir, 'acme-prod', vaultPath);

  ctx = {
    vaultRoot: vaultPath,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
  process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
});

afterAll(async () => {
  delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  await closeGraph(store);
  await rm(rootDir, { recursive: true, force: true });
});

describe('fieldMappingBetweenObjectsHandler', () => {
  it('parses valid input via the Zod schema', () => {
    const parsed = fieldMappingBetweenObjectsInputSchema.safeParse({
      vault: 'acme-prod',
      objectA: 'Lead',
      objectB: 'Contact',
    });
    expect(parsed.success).toBe(true);
  });

  it('Q173 — suggests Lead.Lead_Score__c ↔ Contact.Contact_Score__c (Score token overlap)', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      vault: 'acme-prod',
      objectA: 'Lead',
      objectB: 'Contact',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scorePair = r.value.data.suggestedPairs.find(
      (p) =>
        p.fieldA.apiName === 'Lead_Score__c' &&
        p.fieldB.apiName === 'Contact_Score__c',
    );
    expect(scorePair).toBeDefined();
    expect(scorePair?.typeCompatible).toBe(true);
    expect(scorePair?.confidence).toBe('heuristic');
  });

  it('Q173 — suggests Lead.Industry_Vertical__c ↔ Contact.Vertical__c (Vertical token overlap)', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      vault: 'acme-prod',
      objectA: 'Lead',
      objectB: 'Contact',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const verticalPair = r.value.data.suggestedPairs.find(
      (p) =>
        p.fieldA.apiName === 'Industry_Vertical__c' &&
        p.fieldB.apiName === 'Vertical__c',
    );
    expect(verticalPair).toBeDefined();
    expect(verticalPair?.typeCompatible).toBe(true);
  });

  it('flags an Html ↔ LongTextArea pair as typeCompatible (both text-family)', async () => {
    // Html (rich text) is a text-family type — the formatted sibling of
    // LongTextArea, which is already in TEXT_TYPES. A migration can map one to
    // the other, so the surfaced pair must be typeCompatible: true. It used to
    // be mislabeled false because Html was missing from TEXT_TYPES.
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      vault: 'acme-prod',
      objectA: 'Lead',
      objectB: 'Contact',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bioPair = r.value.data.suggestedPairs.find(
      (p) =>
        p.fieldA.apiName === 'Biography_Notes__c' &&
        p.fieldB.apiName === 'Biography__c',
    );
    expect(bioPair).toBeDefined();
    expect(bioPair?.typeCompatible).toBe(true);
  });

  it('orders suggestedPairs by labelSimilarity DESC', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      vault: 'acme-prod',
      objectA: 'Lead',
      objectB: 'Contact',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sims = r.value.data.suggestedPairs.map((p) => p.labelSimilarity);
    for (let i = 1; i < sims.length; i += 1) {
      const prev = sims[i - 1] ?? 0;
      const cur = sims[i] ?? 0;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });

  it('Q174 — ALWAYS surfaces the verbatim heuristic-mapping disclosure', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      vault: 'acme-prod',
      objectA: 'Lead',
      objectB: 'Contact',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const phrase =
      'field-mapping suggestions are heuristic — labels are matched by token overlap and types by compatibility table. Verify each suggested pair against your business rules before relying on the mapping for a migration script.';
    expect(r.value.data.boundaries).toContain(phrase);
  });

  it('all suggested pairs carry confidence: heuristic', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      vault: 'acme-prod',
      objectA: 'Lead',
      objectB: 'Contact',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const p of r.value.data.suggestedPairs) {
      expect(p.confidence).toBe('heuristic');
    }
  });

  it('returns vault-not-found refusal for unknown alias (Q174 disclosure still surfaces)', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      vault: 'no-such-vault',
      objectA: 'Lead',
      objectB: 'Contact',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes("'no-such-vault' is not registered"),
      ),
    ).toBe(true);
    // The Q174 verbatim phrase is still surfaced even on refusal — the
    // honesty discipline is unconditional.
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes('field-mapping suggestions are heuristic'),
      ),
    ).toBe(true);
  });

  it('reports unpaired fields for both objects when similarityThreshold is high', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      vault: 'acme-prod',
      objectA: 'Lead',
      objectB: 'Contact',
      similarityThreshold: 0.99,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // At threshold 0.99 no fields should pair.
    expect(r.value.data.suggestedPairs).toHaveLength(0);
    expect(r.value.data.unpairedFromA.length).toBeGreaterThan(0);
    expect(r.value.data.unpairedFromB.length).toBeGreaterThan(0);
  });
});
