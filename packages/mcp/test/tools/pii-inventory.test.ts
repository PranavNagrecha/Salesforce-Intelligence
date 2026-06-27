/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
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

import type { Context } from '../../src/server.js';
import {
  piiInventoryHandler,
  piiInventoryInputSchema,
} from '../../src/tools/pii-inventory.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    CustomField: 10,
  },
  edges: { parentOf: 10 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Industry__c',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { dataType: 'Text' },
  ...overrides,
});

// =============================================================================
// Seed data: a small mix of PII / sensitive / public CustomFields plus their
// parent CustomObject for parentOf containment.
// =============================================================================

const CONTACT_ID = 'CustomObject:Contact';
const ACCOUNT_ID = 'CustomObject:Account';
const PATIENT_ID = 'CustomObject:Patient__c';

const PII_SSN = 'CustomField:Contact.SSN__c';
const PII_EMAIL = 'CustomField:Contact.PersonalEmail__c';
const PII_PHONE = 'CustomField:Contact.Mobile_Phone__c';
const PII_STREET = 'CustomField:Contact.Street__c';
const PII_DOB = 'CustomField:Contact.BirthDate__c';
const SENS_SALARY = 'CustomField:Contact.Salary__c';
const SENS_CC = 'CustomField:Account.CreditCard_Number__c';
const SENS_DIAGNOSIS = 'CustomField:Patient__c.Diagnosis__c';
const SENS_MRN = 'CustomField:Patient__c.MRN__c';
const PII_BY_TYPE = 'CustomField:Contact.Notification__c';
const SENS_ENCRYPTED = 'CustomField:Contact.Notes__c';
const PUBLIC_INDUSTRY = 'CustomField:Account.Industry__c';
const PII_BY_DESC = 'CustomField:Account.OtherNotes__c';
const SENS_HIPAA_DESC = 'CustomField:Patient__c.MedicalNote__c';
const FORMULA_FROM_SSN = 'CustomField:Contact.Masked_Value__c';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: CONTACT_ID, type: 'CustomObject', apiName: 'Contact' }),
    makeNode({ id: ACCOUNT_ID, type: 'CustomObject', apiName: 'Account' }),
    makeNode({
      id: PATIENT_ID,
      type: 'CustomObject',
      apiName: 'Patient__c',
    }),
    makeNode({ id: PII_SSN, apiName: 'SSN__c', parentId: CONTACT_ID }),
    makeNode({
      id: PII_EMAIL,
      apiName: 'PersonalEmail__c',
      parentId: CONTACT_ID,
    }),
    makeNode({
      id: PII_PHONE,
      apiName: 'Mobile_Phone__c',
      parentId: CONTACT_ID,
    }),
    makeNode({ id: PII_STREET, apiName: 'Street__c', parentId: CONTACT_ID }),
    makeNode({
      id: PII_DOB,
      apiName: 'BirthDate__c',
      parentId: CONTACT_ID,
    }),
    makeNode({
      id: SENS_SALARY,
      apiName: 'Salary__c',
      parentId: CONTACT_ID,
    }),
    makeNode({
      id: SENS_CC,
      apiName: 'CreditCard_Number__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: SENS_DIAGNOSIS,
      apiName: 'Diagnosis__c',
      parentId: PATIENT_ID,
    }),
    makeNode({ id: SENS_MRN, apiName: 'MRN__c', parentId: PATIENT_ID }),
    makeNode({
      id: PII_BY_TYPE,
      apiName: 'Notification__c',
      parentId: CONTACT_ID,
      properties: { dataType: 'Email' },
    }),
    makeNode({
      id: SENS_ENCRYPTED,
      apiName: 'Notes__c',
      parentId: CONTACT_ID,
      properties: { dataType: 'EncryptedText' },
    }),
    makeNode({
      id: PUBLIC_INDUSTRY,
      apiName: 'Industry__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: PII_BY_DESC,
      apiName: 'OtherNotes__c',
      parentId: ACCOUNT_ID,
      properties: { dataType: 'Text', description: 'Contains PII data' },
    }),
    makeNode({
      id: SENS_HIPAA_DESC,
      apiName: 'MedicalNote__c',
      parentId: PATIENT_ID,
      properties: { dataType: 'Text', description: 'HIPAA-protected note' },
    }),
    // A formula field with NO direct PII signal in its name/type, but whose
    // formula derives from the PII SSN field — bug 11.
    makeNode({
      id: FORMULA_FROM_SSN,
      apiName: 'Masked_Value__c',
      parentId: CONTACT_ID,
      properties: { dataType: 'Text', formula: 'LEFT(SSN__c, 3)' },
    }),
  ],
  edges: [
    // Formula field → its PII source field (formula-references extractor shape).
    {
      fromId: FORMULA_FROM_SSN,
      toId: PII_SSN,
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-references',
      properties: {},
    },
  ],
};

// One shared graph store + Context across the suite.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pii-inventory-'));
  const dbPath = join(tempDir, 'pii-inventory.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
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

describe('piiInventoryHandler', () => {
  it('returns every classified field with the default `all`/`all` filters', async () => {
    const result = await piiInventoryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { fields, summary, truncated } = result.value.data;
    // 15 CustomFields were seeded (incl. the formula field derived from SSN)
    // — every one is classified.
    expect(fields.length).toBe(15);
    expect(summary.total).toBe(15);
    expect(truncated).toBe(false);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it("narrows to pii-only fields when classification='pii'", async () => {
    const result = await piiInventoryHandler(ctx, { classification: 'pii' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { fields, summary } = result.value.data;
    for (const f of fields) {
      expect(f.classification).toBe('pii');
    }
    // 5 by-name (SSN, PersonalEmail, Mobile_Phone, Street, BirthDate) plus
    // 1 by-data-type (Notification__c -> Email) plus 1 by-description
    // (OtherNotes__c -> "Contains PII data") plus 1 formula-derived
    // (Masked_Value__c <- SSN) = 9 pii-classified fields.
    expect(summary.total).toBe(9);
    expect(summary.byClassification['pii']).toBe(9);
  });

  it("narrows to sensitive-only fields when classification='sensitive'", async () => {
    const result = await piiInventoryHandler(ctx, {
      classification: 'sensitive',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { fields, summary } = result.value.data;
    for (const f of fields) {
      expect(f.classification).toBe('sensitive');
    }
    // 4 by-name (Salary__c, CreditCard_Number__c, Diagnosis__c, MRN__c) plus
    // 1 by-description (HIPAA note) = 5 (EncryptedText now classifies as pii).
    expect(summary.total).toBe(5);
    expect(summary.byClassification['sensitive']).toBe(5);
  });

  it("narrows by category to health-only fields", async () => {
    const result = await piiInventoryHandler(ctx, { category: 'health' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { fields, summary } = result.value.data;
    for (const f of fields) {
      expect(f.category).toBe('health');
    }
    // Diagnosis__c + MRN__c + HIPAA-description MedicalNote__c = 3.
    expect(summary.total).toBe(3);
    expect(summary.byCategory['health']).toBe(3);
  });

  it("combines classification + category filters (financial sensitive)", async () => {
    const result = await piiInventoryHandler(ctx, {
      classification: 'sensitive',
      category: 'financial',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { fields } = result.value.data;
    // Salary__c and CreditCard_Number__c match both filters.
    expect(fields.length).toBe(2);
    const ids = fields.map((f) => f.id).sort();
    expect(ids).toEqual([SENS_CC, SENS_SALARY].sort());
  });

  it("classifies an EncryptedText field as pii regardless of name", async () => {
    const result = await piiInventoryHandler(ctx, {
      classification: 'pii',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const encrypted = result.value.data.fields.find(
      (f) => f.id === SENS_ENCRYPTED,
    );
    expect(encrypted).toBeDefined();
    expect(encrypted?.classification).toBe('pii');
    expect(encrypted?.type).toBe('EncryptedText');
    expect(encrypted?.reason).toContain('EncryptedText');
  });

  it('narrows to one object when objectId is supplied', async () => {
    const scoped = await piiInventoryHandler(ctx, {
      objectId: 'CustomObject:Contact',
    });
    const orgWide = await piiInventoryHandler(ctx, {});
    expect(scoped.ok).toBe(true);
    expect(orgWide.ok).toBe(true);
    if (!scoped.ok || !orgWide.ok) return;
    expect(scoped.value.data.summary.total).toBeLessThan(
      orgWide.value.data.summary.total,
    );
  });

  it("classifies an Email-typed field with no PII name as pii/contact", async () => {
    const result = await piiInventoryHandler(ctx, {
      classification: 'pii',
      category: 'contact',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byType = result.value.data.fields.find((f) => f.id === PII_BY_TYPE);
    expect(byType).toBeDefined();
    expect(byType?.type).toBe('Email');
    expect(byType?.classification).toBe('pii');
    expect(byType?.category).toBe('contact');
  });

  it("classifies a field by description-keyword when the name has no PII token", async () => {
    const result = await piiInventoryHandler(ctx, { classification: 'pii' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byDesc = result.value.data.fields.find((f) => f.id === PII_BY_DESC);
    expect(byDesc).toBeDefined();
    expect(byDesc?.classification).toBe('pii');
    expect(byDesc?.description).toBe('Contains PII data');
  });

  it('propagates PII to a formula field derived from a PII source (bug 11)', async () => {
    const result = await piiInventoryHandler(ctx, { classification: 'pii' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Masked_Value__c has no PII token in its name and is plain Text, but its
    // formula derives from the PII SSN field — it inherits that exposure.
    const derived = result.value.data.fields.find((f) => f.id === FORMULA_FROM_SSN);
    expect(derived).toBeDefined();
    expect(derived?.classification).toBe('pii');
    expect(derived?.reason).toContain('formula derives from');
  });

  it("returns an empty list (with a zero summary) when no field matches the filter", async () => {
    // No identifier-classified sensitive fields in the seed.
    const result = await piiInventoryHandler(ctx, {
      classification: 'sensitive',
      category: 'identifier',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fields).toEqual([]);
    expect(result.value.data.summary.total).toBe(0);
  });

  it("truncates the slice to `limit` and flips `truncated` true; summary.total stays the full count", async () => {
    const result = await piiInventoryHandler(ctx, { limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fields.length).toBe(3);
    expect(result.value.data.truncated).toBe(true);
    expect(result.value.data.summary.total).toBe(15);
  });

  it("emits fields sorted by classification, category, then id", async () => {
    const result = await piiInventoryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fields = result.value.data.fields;
    for (let i = 1; i < fields.length; i++) {
      const a = fields[i - 1];
      const b = fields[i];
      if (a === undefined || b === undefined) continue;
      if (a.classification === b.classification) {
        if (a.category === b.category) {
          expect(a.id <= b.id).toBe(true);
        } else {
          expect(a.category <= b.category).toBe(true);
        }
      } else {
        expect(a.classification <= b.classification).toBe(true);
      }
    }
  });
});

describe('piiInventoryInputSchema', () => {
  it('accepts an empty input (all defaults)', () => {
    const parsed = piiInventoryInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('accepts a valid (classification, category, limit) triple', () => {
    const parsed = piiInventoryInputSchema.safeParse({
      classification: 'pii',
      category: 'contact',
      limit: 50,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown classification value', () => {
    const parsed = piiInventoryInputSchema.safeParse({
      classification: 'something-else',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a limit above 500', () => {
    const parsed = piiInventoryInputSchema.safeParse({ limit: 1000 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const parsed = piiInventoryInputSchema.safeParse({ limit: 25.5 });
    expect(parsed.success).toBe(false);
  });

  it('accepts a valid offset and rejects a negative one', () => {
    expect(piiInventoryInputSchema.safeParse({ offset: 50 }).success).toBe(true);
    expect(piiInventoryInputSchema.safeParse({ offset: -1 }).success).toBe(
      false,
    );
  });
});

// =============================================================================
// B25 — response-size pagination + byte budget. A bare pii_inventory on a large
// org used to serialize past the global ~45 KB dispatch guard and be rejected
// outright; the handler now pages (limit/offset) and byte-trims each page so it
// always returns usable data with a `nextOffset` cursor and an advisory `note`.
// =============================================================================

/** Mirrors `MAX_RESPONSE_BYTES` (the global dispatch guard in index.ts). */
const GLOBAL_RESPONSE_GUARD_BYTES = 45_000;

/** A ~2 KB field (long description) so a handful blow past the byte budget. */
const makeBulkyField = (i: number): Node =>
  makeNode({
    id: `CustomField:Bulk__c.Field_${i}__c`,
    apiName: `Field_${i}__c`,
    parentId: 'CustomObject:Bulk__c',
    label: `Field ${i}`,
    properties: {
      dataType: 'Text',
      // "PII" in the description guarantees a pii classification (mirrors the
      // PII_BY_DESC fixture); the padding makes each serialized field ~2 KB so
      // the byte budget — not the row-count limit — is what trips.
      description: `Contains PII data. ${'x'.repeat(2000)}`,
    },
  });

describe('piiInventoryHandler — pagination + byte budget (B25)', () => {
  const BULK_COUNT = 120;
  let bulkDir: string;
  let bulkStore: GraphStore;
  let bulkCtx: Context;

  beforeAll(async () => {
    bulkDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pii-bulk-'));
    const opened = await openGraph(join(bulkDir, 'bulk.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    bulkStore = opened.value;
    const bulkSeed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'CustomObject:Bulk__c',
          type: 'CustomObject',
          apiName: 'Bulk__c',
        }),
        ...Array.from({ length: BULK_COUNT }, (_unused, i) => makeBulkyField(i)),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(bulkStore, [bulkSeed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    bulkCtx = { vaultRoot: bulkDir, manifest: FIXTURE_MANIFEST, graph: bulkStore };
  });

  afterAll(async () => {
    await closeGraph(bulkStore);
    rmSync(bulkDir, { recursive: true, force: true });
  });

  it('keeps a default (no-arg) response under the global ~45 KB guard', async () => {
    const result = await piiInventoryHandler(bulkCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bytes = Buffer.byteLength(JSON.stringify(result.value), 'utf8');
    expect(bytes).toBeLessThanOrEqual(GLOBAL_RESPONSE_GUARD_BYTES);
    // 120 bulky fields cannot fit, so the page is byte-trimmed below the
    // default limit, flagged truncated, with a cursor + advisory note.
    const { fields, summary, truncated, nextOffset, note } = result.value.data;
    expect(summary.total).toBe(BULK_COUNT);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.length).toBeLessThan(BULK_COUNT);
    expect(truncated).toBe(true);
    expect(nextOffset).toBe(fields.length);
    expect(note).toMatch(/45 KB/);
  });

  it('walks the full inventory via the offset cursor and terminates', async () => {
    let offset = 0;
    let seen = 0;
    let guard = 0;
    for (;;) {
      const result = await piiInventoryHandler(bulkCtx, { offset });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.value.data;
      expect(data.offset).toBe(offset);
      seen += data.fields.length;
      if (!data.truncated) break;
      expect(data.nextOffset).toBeGreaterThan(offset);
      offset = data.nextOffset as number;
      if (++guard > 1000) throw new Error('cursor did not terminate');
    }
    // Every matched field surfaced exactly once across the pages.
    expect(seen).toBe(BULK_COUNT);
  });

  it('honours an explicit small limit with a nextOffset cursor', async () => {
    const result = await piiInventoryHandler(bulkCtx, { limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { fields, truncated, nextOffset, offset, limit } = result.value.data;
    expect(limit).toBe(5);
    expect(offset).toBe(0);
    expect(fields.length).toBeLessThanOrEqual(5);
    expect(fields.length).toBeGreaterThan(0);
    expect(truncated).toBe(true);
    expect(nextOffset).toBe(fields.length);
  });

  // CR-22: the byte-trimmed page must carry an opaque continuation cursor and
  // walking it must cover every field exactly once.
  it('emits a nextCursor on the byte-trimmed page and walks the full inventory via cursor (no gaps/dupes)', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const result = await piiInventoryHandler(
        bulkCtx,
        cursor === undefined ? {} : { cursor },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.value.data;
      for (const f of data.fields) seen.add(f.id);
      if (!data.truncated) {
        expect('nextCursor' in data).toBe(false);
        break;
      }
      expect(typeof data.nextCursor).toBe('string');
      expect(data.pageInfo?.nextCursor).toBe(data.nextCursor);
      cursor = data.nextCursor as string;
      if (++guard > 1000) throw new Error('cursor did not terminate');
    }
    expect(seen.size).toBe(BULK_COUNT);
  });

  it('rejects a cursor replayed against a different query (changed classification filter)', async () => {
    const first = await piiInventoryHandler(bulkCtx, { limit: 5 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    const replay = await piiInventoryHandler(bulkCtx, {
      classification: 'sensitive',
      cursor: cursor as string,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.kind).toBe('invalid-query');
  });

  it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical to pre-CR-22)', async () => {
    // The non-bulk 15-field fixture (`ctx`) fits under the default limit and
    // byte budget, so the response carries neither nextCursor nor pageInfo.
    const result = await piiInventoryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.truncated).toBe(false);
    expect('nextCursor' in result.value.data).toBe(false);
    expect('pageInfo' in result.value.data).toBe(false);
  });
});
