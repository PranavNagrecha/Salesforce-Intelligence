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

  it('accepts input with `vault` omitted via the Zod schema', () => {
    const parsed = fieldMappingBetweenObjectsInputSchema.safeParse({
      objectA: 'Lead',
      objectB: 'Contact',
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * Single-vault deployment — the normal `sfi mcp` session: NO registry
 * (no SF_INTELLIGENCE_REGISTRY_PATH, no registry.json anywhere above
 * the vault) and no `vault` argument. The tool must answer from the
 * SERVED vault instead of refusing with fieldCount: 0.
 */
describe('fieldMappingBetweenObjectsHandler (single-vault, no registry)', () => {
  let soloRoot: string;
  let soloStore: GraphStore;
  let soloCtx: Context;
  let savedRegistryPath: string | undefined;

  beforeAll(async () => {
    soloRoot = await mkdtemp(join(tmpdir(), 'sfi-v31-field-mapping-solo-'));
    const soloVaultPath = join(soloRoot, 'solo-org');
    await mkdir(join(soloVaultPath, 'graph'), { recursive: true });
    await saveManifest(soloVaultPath, FIXTURE_MANIFEST);

    const opened = await openGraph(vaultPaths(soloVaultPath).graphDb);
    if (!opened.ok) throw new Error(opened.error.message);
    soloStore = opened.value;

    // Order with Order_Total__c (Currency); Invoice with
    // Invoice_Total__c (Currency) — a real pair on the shared "total"
    // token. NO registerVault call: this vault is served, not registered.
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Order__c', apiName: 'Order__c' }),
        makeNode({ id: 'CustomObject:Invoice__c', apiName: 'Invoice__c' }),
        makeNode({
          id: 'CustomField:Order__c.Order_Total__c',
          type: 'CustomField',
          apiName: 'Order_Total__c',
          label: 'Order Total',
          parentId: 'CustomObject:Order__c',
          properties: { dataType: 'Currency' },
        }),
        makeNode({
          id: 'CustomField:Invoice__c.Invoice_Total__c',
          type: 'CustomField',
          apiName: 'Invoice_Total__c',
          label: 'Invoice Total',
          parentId: 'CustomObject:Invoice__c',
          properties: { dataType: 'Currency' },
        }),
      ],
      edges: [],
    };
    await importExtractionResults(soloStore, [seed]);

    soloCtx = {
      vaultRoot: soloVaultPath,
      manifest: FIXTURE_MANIFEST,
      graph: soloStore,
    };
  });

  beforeEach(() => {
    // The sibling suite sets SF_INTELLIGENCE_REGISTRY_PATH in ITS
    // beforeAll; clear it so these cases exercise the registry-less path.
    savedRegistryPath = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  });

  afterEach(() => {
    if (savedRegistryPath !== undefined) {
      process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = savedRegistryPath;
    }
  });

  afterAll(async () => {
    await closeGraph(soloStore);
    await rm(soloRoot, { recursive: true, force: true });
  });

  it('answers from the served vault when `vault` is omitted (fieldCount > 0 both sides)', async () => {
    const r = await fieldMappingBetweenObjectsHandler(soloCtx, {
      objectA: 'Order__c',
      objectB: 'Invoice__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objectA.fieldCount).toBeGreaterThan(0);
    expect(r.value.data.objectB.fieldCount).toBeGreaterThan(0);
    const totalPair = r.value.data.suggestedPairs.find(
      (p) =>
        p.fieldA.apiName === 'Order_Total__c' &&
        p.fieldB.apiName === 'Invoice_Total__c',
    );
    expect(totalPair).toBeDefined();
    expect(totalPair?.typeCompatible).toBe(true);
    // The served-vault ref points at the vault this session serves.
    expect(r.value.data.vault.path).toBe(soloCtx.vaultRoot);
    // The Q174 verbatim phrase is unconditional.
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes('field-mapping suggestions are heuristic'),
      ),
    ).toBe(true);
  });

  it('answers from the served vault for a self-referential alias, with the single-vault disclosure', async () => {
    const r = await fieldMappingBetweenObjectsHandler(soloCtx, {
      vault: 'solo-org',
      objectA: 'Order__c',
      objectB: 'Invoice__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objectA.fieldCount).toBeGreaterThan(0);
    expect(r.value.data.objectB.fieldCount).toBeGreaterThan(0);
    expect(r.value.data.suggestedPairs.length).toBeGreaterThan(0);
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes('single-vault install'),
      ),
    ).toBe(true);
  });

  it('refuses an unknown alias with the omit-`vault` hint when no registry exists', async () => {
    const r = await fieldMappingBetweenObjectsHandler(soloCtx, {
      vault: 'some-other-org',
      objectA: 'Order__c',
      objectB: 'Invoice__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes("'some-other-org' is not registered"),
      ),
    ).toBe(true);
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes('Omit `vault` to map fields within the served vault'),
      ),
    ).toBe(true);
  });
});

/**
 * FIX 6 — never state a total this tool cannot enumerate.
 *
 * With 592-field and 354-field objects the dispatcher silently dropped rows
 * (222 on the reported run), so the response stated a `fieldCount` its own
 * rows did not add up to and the caller had no knob to reach the rest.
 */
describe('fieldMappingBetweenObjectsHandler — counts + paging (FIX 6)', () => {
  let bigRoot: string;
  let bigPath: string;
  let bigStore: GraphStore;
  let bigCtx: Context;

  beforeAll(async () => {
    bigRoot = await mkdtemp(join(tmpdir(), 'sfi-fix6-mapping-'));
    bigPath = join(bigRoot, 'big-vault');
    await mkdir(join(bigPath, 'graph'), { recursive: true });
    await saveManifest(bigPath, FIXTURE_MANIFEST);
    const opened = await openGraph(vaultPaths(bigPath).graphDb);
    if (!opened.ok) throw new Error(opened.error.message);
    bigStore = opened.value;

    const nodes: Node[] = [
      makeNode({ id: 'CustomObject:Widget_Session__c', apiName: 'Widget_Session__c' }),
      makeNode({ id: 'CustomObject:Widget_Archive__c', apiName: 'Widget_Archive__c' }),
    ];
    // 300 fields on A, 60 on B. The first 60 pair by label; the remaining 240
    // on A are unpaired — comfortably over the default page size.
    for (let i = 0; i < 300; i += 1) {
      nodes.push(
        makeNode({
          id: `CustomField:Widget_Session__c.Attr_${i}__c`,
          type: 'CustomField',
          apiName: `Attr_${i}__c`,
          label: `Attr ${i}`,
          parentId: 'CustomObject:Widget_Session__c',
          properties: { dataType: 'Text' },
        }),
      );
    }
    for (let i = 0; i < 60; i += 1) {
      nodes.push(
        makeNode({
          id: `CustomField:Widget_Archive__c.Attr_${i}__c`,
          type: 'CustomField',
          apiName: `Attr_${i}__c`,
          label: `Attr ${i}`,
          parentId: 'CustomObject:Widget_Archive__c',
          properties: { dataType: 'Text' },
        }),
      );
    }
    await importExtractionResults(bigStore, [{ nodes, edges: [] }]);
    await registerVault(bigRoot, 'big-vault', bigPath);
    bigCtx = {
      vaultRoot: bigPath,
      manifest: FIXTURE_MANIFEST,
      graph: bigStore,
    };
  });

  afterAll(async () => {
    await closeGraph(bigStore);
    await rm(bigRoot, { recursive: true, force: true });
  });

  it('publishes exact counts and a BALANCED reconciliation', async () => {
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = bigRoot;
    const r = await fieldMappingBetweenObjectsHandler(bigCtx, {
      objectA: 'Widget_Session__c',
      objectB: 'Widget_Archive__c',
      section: 'unpairedFromA',
    });
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Pre-fix: no `counts`, no `reconciliation`, and no way to know the
    // unpaired list had been trimmed.
    expect(d.counts.suggestedPairs + d.counts.unpairedFromA).toBe(
      d.objectA.fieldCount,
    );
    expect(d.counts.suggestedPairs + d.counts.unpairedFromB).toBe(
      d.objectB.fieldCount,
    );
    expect(d.reconciliation.balanced).toBe(true);
    expect(d.reconciliation.aAccountedFor).toBe(300);
    expect(d.reconciliation.bAccountedFor).toBe(60);
  });

  it('pages the designated section and names the true total', async () => {
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = bigRoot;
    const r = await fieldMappingBetweenObjectsHandler(bigCtx, {
      objectA: 'Widget_Session__c',
      objectB: 'Widget_Archive__c',
      section: 'unpairedFromA',
      limit: 100,
    });
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.unpairedFromA.length).toBe(100);
    expect(d.counts.unpairedFromA).toBe(240);
    expect(d.hasMore).toBe(true);
    expect(d.nextOffset).toBe(100);
    expect(d.note).toBe(
      'Showing 100 of 240 `unpairedFromA` row(s) (offset=0). MORE remain — advance with offset=100 or echo `nextCursor`. `counts` states the TRUE total for every section; this page is a slice of one of them. Change `section` to page a different list.',
    );
  });

  it('round-trips a cursor with no overlap and no gap', async () => {
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = bigRoot;
    const page1 = await fieldMappingBetweenObjectsHandler(bigCtx, {
      objectA: 'Widget_Session__c',
      objectB: 'Widget_Archive__c',
      section: 'unpairedFromA',
      limit: 100,
    });
    expect(page1.ok).toBe(true);
    if (!page1.ok) {
      process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
      return;
    }
    const page2 = await fieldMappingBetweenObjectsHandler(bigCtx, {
      objectA: 'Widget_Session__c',
      objectB: 'Widget_Archive__c',
      section: 'unpairedFromA',
      limit: 100,
      cursor: page1.value.data.nextCursor as string,
    });
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    const a = page1.value.data.unpairedFromA;
    const b = page2.value.data.unpairedFromA;
    expect(b.length).toBe(100);
    expect(a.some((x) => b.includes(x))).toBe(false);
    expect(page2.value.data.offset).toBe(100);
  });

  it('rejects a cursor minted for a DIFFERENT query', async () => {
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = bigRoot;
    const page1 = await fieldMappingBetweenObjectsHandler(bigCtx, {
      objectA: 'Widget_Session__c',
      objectB: 'Widget_Archive__c',
      section: 'unpairedFromA',
      limit: 100,
    });
    expect(page1.ok).toBe(true);
    if (!page1.ok) {
      process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
      return;
    }
    const crossed = await fieldMappingBetweenObjectsHandler(bigCtx, {
      objectA: 'Widget_Archive__c',
      objectB: 'Widget_Session__c',
      section: 'unpairedFromA',
      cursor: page1.value.data.nextCursor as string,
    });
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.kind).toBe('invalid-query');
  });

  it('leaves a small pair byte-identical apart from the additive keys', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      objectA: 'Lead',
      objectB: 'Contact',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect(d['hasMore']).toBeUndefined();
    expect(d['note']).toBeUndefined();
    expect(d['nextCursor']).toBeUndefined();
    expect(d['section']).toBeUndefined();
    expect(r.value.data.reconciliation.balanced).toBe(true);
  });
});

/**
 * R4 — an object filter must be VERIFIED to exist in the vault before it is
 * used.
 *
 * `loadFields` string-templated `CustomObject:${objectApiName}`, so a typo
 * ('Acount') and a wrong-CASE name ('contact' — Salesforce api names are
 * case-INSENSITIVE, so this names the same object) both returned zero rows.
 * The tool then reported `fieldCount: 0` with empty lists AND stamped its own
 * integrity check VALID — `reconciliation.balanced` is `0 === 0` — while its
 * boundary tells the reader to use the result for a migration script.
 */
describe('fieldMappingBetweenObjectsHandler — object scope must exist (R4)', () => {
  it('REFUSES a nonexistent objectA instead of certifying an empty mapping', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      objectA: 'Acount',
      objectB: 'Contact',
    });
    expect(r.ok).toBe(false);
    if (r.ok) {
      // Pre-fix shape, recorded so the failure names the defect precisely.
      expect({
        objectA: r.value.data.objectA,
        counts: r.value.data.counts,
        reconciliation: r.value.data.reconciliation,
      }).toEqual('a refusal');
      return;
    }
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain("no object named 'Acount' exists in this vault");
    expect(r.error.path).toBe('objectA');
  });

  it('REFUSES a nonexistent objectB instead of certifying an empty mapping', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      objectA: 'Lead',
      objectB: 'Contct',
    });
    expect(r.ok).toBe(false);
    if (r.ok) {
      expect({
        objectB: r.value.data.objectB,
        reconciliation: r.value.data.reconciliation,
      }).toEqual('a refusal');
      return;
    }
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain("no object named 'Contct' exists in this vault");
    expect(r.error.path).toBe('objectB');
  });

  it('answers a wrong-CASE object name against the vault casing', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      objectA: 'lead',
      objectB: 'contact',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Same answer as the exactly-cased call: fields found, pairs suggested.
    expect(d.objectA.fieldCount).toBeGreaterThan(0);
    expect(d.objectB.fieldCount).toBeGreaterThan(0);
    expect(
      d.suggestedPairs.some(
        (p) =>
          p.fieldA.apiName === 'Lead_Score__c' &&
          p.fieldB.apiName === 'Contact_Score__c',
      ),
    ).toBe(true);
    // The echoed api name is the VAULT's casing, never the caller's — the
    // response must not assert a component id that does not exist.
    expect(d.objectA.apiName).toBe('Lead');
    expect(d.objectB.apiName).toBe('Contact');
  });

  it('never reports balanced: true for an object it could not find', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      objectA: 'Acount',
      objectB: 'Contact',
    });
    if (r.ok) {
      expect(r.value.data.reconciliation.balanced).toBe(false);
      return;
    }
    expect(r.ok).toBe(false);
  });

  it('refuses a nonexistent object on the served vault too (no `vault` arg)', async () => {
    const r = await fieldMappingBetweenObjectsHandler(ctx, {
      vault: 'acme-prod',
      objectA: 'Lead',
      objectB: 'Opportunty',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});
