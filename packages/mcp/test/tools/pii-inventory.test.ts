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
import { detectPiiClassificationWithReason } from '@sf-intelligence/patterns';

import type { Context } from '../../src/server.js';
import {
  collectPiiInventoryFields,
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

  // R6-21: format: 'csv' — fields moves to csv; JSON-facing fields stay.
  it('omits csv unless format is csv (default json)', async () => {
    const result = await piiInventoryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.csv).toBeUndefined();
    expect(result.value.data.fields.length).toBeGreaterThan(0);
  });

  it('returns fields:[] and a csv with one row per matched field when format is csv', async () => {
    const result = await piiInventoryHandler(ctx, {
      classification: 'pii',
      format: 'csv',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fields).toEqual([]);
    const csv = result.value.data.csv;
    expect(csv).toBeDefined();
    if (csv === undefined) return;
    const dataLines = csv.trimEnd().split('\n').filter((l) => !l.startsWith('#'));
    expect(dataLines[0]).toBe('id,apiName,label,type,classification,category,description,reason');
    // summary.total for the pii-only filter names how many rows to expect.
    const summaryResult = await piiInventoryHandler(ctx, { classification: 'pii' });
    expect(summaryResult.ok).toBe(true);
    if (!summaryResult.ok) return;
    expect(dataLines.length - 1).toBe(summaryResult.value.data.summary.total);
    for (const line of dataLines.slice(1)) {
      expect(line.split(',')[4]).toBe('pii');
    }
  });

  it('embeds the freshness + heuristic-recognizer disclosures as comment lines', async () => {
    const result = await piiInventoryHandler(ctx, { format: 'csv' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const csv = result.value.data.csv ?? '';
    expect(csv).toContain('# generatedAt: 2026-05-27T14:33:08Z');
    expect(csv).toContain('# sourceTreeHash: sha256:fixture');
    expect(csv).toContain('heuristic');
  });

  it('every data row is well-formed CSV with exactly 8 columns (RFC 4180 quote-aware parse)', async () => {
    const result = await piiInventoryHandler(ctx, { format: 'csv' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const csv = result.value.data.csv ?? '';
    const dataLines = csv.trimEnd().split('\n').filter((l) => !l.startsWith('#'));
    // Minimal RFC 4180 quote-aware cell counter — mirrors what a real CSV
    // parser does, unlike a naive `.split(',')` that miscounts quoted commas.
    const countCells = (line: string): number => {
      let cells = 1;
      let inQuotes = false;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (c === '"') inQuotes = !inQuotes;
        else if (c === ',' && !inQuotes) cells += 1;
      }
      return cells;
    };
    for (const line of dataLines) {
      expect(countCells(line)).toBe(8);
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

  // R6-21: format: 'csv' — the byte-trimmed BULK_COUNT (120) page must fit the
  // csv too, dropping rows tail-first with a truncation comment rather than
  // overflowing the global guard.
  it('fits a csv export of the byte-trimmed bulk page under the global guard', async () => {
    const result = await piiInventoryHandler(bulkCtx, { format: 'csv' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bytes = Buffer.byteLength(JSON.stringify(result.value), 'utf8');
    expect(bytes).toBeLessThanOrEqual(GLOBAL_RESPONSE_GUARD_BYTES);
    expect(result.value.data.fields).toEqual([]);
    expect(result.value.data.csv).toBeDefined();
    expect(result.value.data.csv).toContain('# sourceTreeHash:');
  });
});

// Perf regression guard: the formula-source PII cross-walk reads each formula
// field's outgoing `references` edges, and the composer collector returns the
// full classified set. BOTH must be single-pass — one batched
// `listEdgesForNodes`, and ONE corpus classification (not one per output page).
// The former N+1 (one `listEdges` per formula field), multiplied by the
// per-page re-scan in `collectPiiInventoryFields`, was the biggest residual cost
// in the >60s org_risk_report timeout.
describe('pii_inventory — single-pass classification + batched edge lookups (no N+1)', () => {
  const FORMULA_COUNT = 60;
  let dir: string;
  let localStore: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-pii-perf-'));
    const opened = await openGraph(join(dir, 'perf.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    localStore = opened.value;
    const sourceId = 'CustomField:Perf__c.SSN__c';
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Perf__c', type: 'CustomObject', apiName: 'Perf__c' }),
        // Regulated source field (name token → pii) the formula fields derive from.
        makeNode({
          id: sourceId,
          apiName: 'SSN__c',
          parentId: 'CustomObject:Perf__c',
          properties: { dataType: 'Text' },
        }),
        // Formula fields with a public name/description; each ~2 KB so the OLD
        // page-walk collector would have byte-trimmed into many pages (and
        // re-scanned the whole corpus for each). They inherit SSN's pii verdict
        // via their outgoing `references` edge.
        ...Array.from({ length: FORMULA_COUNT }, (_unused, i) =>
          makeNode({
            id: `CustomField:Perf__c.Calc${i}__c`,
            apiName: `Calc${i}__c`,
            parentId: 'CustomObject:Perf__c',
            properties: {
              dataType: 'Text',
              formula: `${'SSN__c'} & ""`,
              description: `Derived value. ${'x'.repeat(2000)}`,
            },
          }),
        ),
      ],
      edges: Array.from({ length: FORMULA_COUNT }, (_unused, i) => ({
        fromId: `CustomField:Perf__c.Calc${i}__c`,
        toId: sourceId,
        edgeType: 'references' as const,
        confidence: 'declared' as const,
        source: 'unit-test',
        properties: {},
      })),
    };
    const imported = await importExtractionResults(localStore, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: localStore };
  });

  afterAll(async () => {
    await closeGraph(localStore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies the corpus once and batches formula-source edge lookups', async () => {
    const spy = vi.spyOn(localStore.connection, 'runAndReadAll');
    const result = await collectPiiInventoryFields(localCtx, {});
    const edgeQueries = spy.mock.calls.filter(([sql]) =>
      String(sql).includes('FROM edges'),
    ).length;
    const customFieldScans = spy.mock.calls.filter(
      ([sql, params]) =>
        String(sql).includes('FROM nodes') &&
        String(sql).includes('type = ?') &&
        Array.isArray(params) &&
        params[0] === 'CustomField',
    ).length;
    spy.mockRestore();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every formula field inherits the SSN source's pii classification.
    expect(result.value.summary.byClassification.pii).toBeGreaterThanOrEqual(
      FORMULA_COUNT,
    );
    // ONE batched references fetch — not one listEdges per formula field.
    expect(edgeQueries).toBeLessThanOrEqual(2);
    // ONE corpus scan — not one fetchAllCustomFields per byte-trimmed page.
    expect(customFieldScans).toBeLessThanOrEqual(2);
  });
});

// =============================================================================
// UNRESOLVABLE-OBJECT-SCOPE-ANSWERED-ANYWAY (0.3.3) — the `unused_fields_deep`
// family 0.3.2 apologised for, in its worst form.
//
// `pii_inventory` narrowed by `objectId` / `objectApiName` with a STRING
// COMPARE (`resolveObjectScopeParentId` + `fieldMatchesObjectScope`) and never
// asked the vault whether that object exists. An object that is not there
// matched no field, so "what personal data does this object hold?" came back
// `{fields: [], summary: {total: 0}}` with NO absence marker at all — an
// UNCHECKED zero wearing a CHECKED zero's clothes. On a PRIVACY question that
// empty reads as "nothing sensitive here", about an object never found.
//
// The same string compare made a REAL object typed in the wrong case return the
// identical clean zero (`contact` !== `Contact`).
// =============================================================================
describe('piiInventoryHandler — object scope existence (honesty)', () => {
  const ABSENT = 'Zzz_Nonexistent_Object_9x7__c';

  it('REFUSES an objectApiName naming no vault object (never a silent zero)', async () => {
    const r = await piiInventoryHandler(ctx, { objectApiName: ABSENT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain(ABSENT);
  });

  it('REFUSES an absent objectId through the parsed schema (dispatch path)', async () => {
    const parsed = piiInventoryInputSchema.safeParse({ objectId: ABSENT });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await piiInventoryHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('REFUSES an absent object for the composer entry point too', async () => {
    const r = await collectPiiInventoryFields(ctx, { objectApiName: ABSENT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('a REAL object in the wrong case still answers (case-insensitive resolution)', async () => {
    const lower = await piiInventoryHandler(ctx, { objectApiName: 'contact' });
    const exact = await piiInventoryHandler(ctx, { objectId: 'CustomObject:Contact' });
    expect(lower.ok).toBe(true);
    expect(exact.ok).toBe(true);
    if (!lower.ok || !exact.ok) return;
    expect(exact.value.data.summary.total).toBeGreaterThan(0);
    expect(lower.value.data.summary.total).toBe(exact.value.data.summary.total);
    expect(lower.value.data.fields.map((f) => f.id)).toEqual(
      exact.value.data.fields.map((f) => f.id),
    );
  });

  it('a scoped call echoes appliedScope with the vault’s exact casing', async () => {
    const r = await piiInventoryHandler(ctx, { objectApiName: 'contact' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({
      object: 'CustomObject:Contact',
      mode: 'component',
    });
  });

  // The regression this fix is most likely to cause: the org-wide (no scope)
  // call must be BYTE-IDENTICAL — no appliedScope key, same counts.
  it('the org-wide call is unchanged (no appliedScope, full inventory)', async () => {
    const r = await piiInventoryHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('appliedScope' in r.value.data).toBe(false);
    expect(r.value.data.summary.total).toBe(15);
    expect(r.value.data.fields.length).toBe(15);
  });
});

// =============================================================================
// PII-INVENTORY-PUBLISHES-A-HEURISTIC-VERDICT-AS-A-CHECKED-ONE.
//
// The recognizer reads a field's API name, declared data type and description —
// nothing else. A field it cannot place classifies `public` / `unknown`, an
// UNMATCHED DEFAULT that reads, in the emitted row, exactly like a bucket that
// was checked and found clean.
//
// The default (`format: 'json'`) response used to disclose none of that: its
// keys were `[fields, summary, limit, offset, truncated, ...]` and the one
// sentence the product owns about its own method rode ONLY on the non-default
// csv header. So the encoding a host LLM actually calls was the one with no
// caveat, while `summary.byCategory` published a `0` for whole regulated
// categories. These cases pin the disclosure to EVERY response, both encodings,
// gap or no gap.
// =============================================================================

describe('pii_inventory — the honesty disclosure rides on every response, not just csv', () => {
  it('the DEFAULT json response carries boundaries, trust and a prose disclosure', async () => {
    const result = await piiInventoryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(Array.isArray(data.boundaries)).toBe(true);
    expect(data.boundaries.length).toBeGreaterThan(0);
    expect(data.boundaries.join(' ')).toMatch(/heuristic/i);
    expect(typeof data.disclosure).toBe('string');
    expect(data.disclosure).toMatch(/heuristic/i);
    expect(data.trust).toBeDefined();
  });

  it('names `public` / `unknown` as the UNMATCHED DEFAULT, never a checked negative', async () => {
    const result = await piiInventoryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const all = result.value.data.boundaries.join(' ');
    expect(all).toMatch(/unmatched default/i);
    expect(all).toMatch(/never that the field was verified/i);
  });

  it('NEVER certifies completeness with an empty limitations list', async () => {
    const result = await piiInventoryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trust = result.value.data.trust;
    expect(trust.completeness.status).not.toBe('complete');
    expect(trust.limitations.length).toBeGreaterThan(0);
    // The classification that selects every row is heuristic, so the whole
    // answer is — a `declared` confidence here would be the certification again.
    expect(trust.confidence).toBe('heuristic');
  });

  it('discloses a zero-count bucket as an UNMATCHED-TOKEN zero, by name', async () => {
    // The seed carries no protected-class field, so that bucket is 0 — the same
    // shape the real-org report published for a whole regulated category.
    const result = await piiInventoryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.summary.byCategory['protected-class']).toBe(0);
    const all = result.value.data.boundaries.join(' ');
    expect(all).toMatch(/unmatched-token zero/i);
    expect(all).toMatch(/protected-class/);
  });

  it('an EMPTY filtered sweep names the filter and calls the zero unmatched-token', async () => {
    // The real-org shape this reproduces: a category sweep that returns
    // `{total: 0}` with an all-zero summary and nothing marking the zero as a
    // heuristic default rather than a checked negative.
    const result = await piiInventoryHandler(ctx, {
      classification: 'sensitive',
      category: 'identifier',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.summary.total).toBe(0);
    const zero = result.value.data.boundaries.find((b) =>
      b.startsWith('UNMATCHED-TOKEN ZERO'),
    );
    expect(zero).toBeDefined();
    expect(zero).toContain('classification "sensitive"');
    expect(zero).toContain('category "identifier"');
    expect(zero).toMatch(/matched 0 fields/);
  });

  it('never names the reserved `unknown` CLASSIFICATION as a blind-spot zero', async () => {
    // The recognizer reserves `classification: "unknown"` and never emits it,
    // so its zero is structural. Naming it would be a manufactured blind spot —
    // crying wolf next to the real ones and training a reader to skim past.
    const result = await piiInventoryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.summary.byClassification.unknown).toBe(0);
    const zero =
      result.value.data.boundaries.find((b) =>
        b.startsWith('UNMATCHED-TOKEN ZERO'),
      ) ?? '';
    expect(zero).not.toContain('classification "unknown"');
    // The category `unknown` bucket is populated here, so it is not listed
    // either — but the one bucket that IS an unmatched zero must be.
    expect(zero).toContain('category "protected-class"');
  });

  it('a filtered call says its summary counts the FILTERED set, not the org', async () => {
    const result = await piiInventoryHandler(ctx, { classification: 'pii' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.boundaries.join(' ')).toMatch(
      /filter was applied/i,
    );
  });

  // The tool's own contract says EncryptedText "ALWAYS classifies as sensitive".
  // The recognizer classifies it `pii`. A `classification: 'sensitive'` sweep —
  // the natural "find every encrypted field" query — therefore returns NONE of
  // them, and nothing in the response said so.
  it('a sensitive-only sweep excludes EncryptedText fields AND the response says so', async () => {
    const result = await piiInventoryHandler(ctx, {
      classification: 'sensitive',
      limit: 500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The behaviour itself, pinned: no EncryptedText row is in the bucket.
    expect(
      result.value.data.fields.filter((f) => f.type === 'EncryptedText'),
    ).toEqual([]);
    const all = result.value.data.boundaries.join(' ');
    expect(all).toMatch(/EncryptedText/);
    expect(all).toMatch(/does NOT classify `sensitive`|not.*`sensitive`/);
  });

  it('the csv header states the EncryptedText rule the recognizer actually implements', async () => {
    const result = await piiInventoryHandler(ctx, { format: 'csv' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const csv = result.value.data.csv ?? '';
    // The old header asserted the opposite of the code.
    expect(csv).not.toMatch(/EncryptedText always classifies sensitive/);
  });

  it('the csv disclosures are DERIVED from the json boundaries (no second copy to drift)', async () => {
    const jsonResult = await piiInventoryHandler(ctx, {});
    const csvResult = await piiInventoryHandler(ctx, { format: 'csv' });
    expect(jsonResult.ok && csvResult.ok).toBe(true);
    if (!jsonResult.ok || !csvResult.ok) return;
    const csv = csvResult.value.data.csv ?? '';
    for (const boundary of jsonResult.value.data.boundaries) {
      expect(csv).toContain(`# ${boundary}`);
    }
  });
});

// =============================================================================
// The literal-token blind spot, pinned as a DRIFT TEST.
//
// The name match USED to be a substring test over the API name with its
// separators intact, so a multi-word concept only fired when the name spelled
// it as ONE token, and two fields naming the same concept on the same object
// landed in different categories. That is now FIXED in the recognizer
// (`@sf-intelligence/patterns` `pii-detection.ts`): the token is also tested
// against the name's word segments joined, accepted only where the match STARTS
// on a word boundary. These cases pin BOTH directions — the separator-spelled
// concept is caught, and a token that merely straddles two abutting words
// (`Class_Number__c` -> "classnumber" contains "ssn") is still not — plus the
// response-level rule that outlived the fix: the boundaries must no longer
// claim a limitation that has been repaired.
// =============================================================================

describe('pii_inventory — separator-spelled concepts, and the boundary that had to go', () => {
  const ONE_TOKEN = 'CustomField:Obj_A__c.Birthdate__c';
  const SEPARATED = 'CustomField:Obj_A__c.Birth_Date__c';
  // Squashes to "classnumber", which CONTAINS the `ssn` token. It must not
  // become an identifier: the boundary-aligned match is the only thing
  // stopping it, and an unguarded squash would publish it as an SSN.
  const STRADDLE = 'CustomField:Obj_A__c.Class_Number__c';
  let dir: string;
  let store2: GraphStore;
  let ctx2: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pii-tokens-'));
    const opened = await openGraph(join(dir, 'tokens.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store2 = opened.value;
    const imported = await importExtractionResults(store2, [
      {
        nodes: [
          makeNode({
            id: 'CustomObject:Obj_A__c',
            type: 'CustomObject',
            apiName: 'Obj_A__c',
          }),
          makeNode({
            id: ONE_TOKEN,
            apiName: 'Birthdate__c',
            parentId: 'CustomObject:Obj_A__c',
            properties: { dataType: 'Date' },
          }),
          makeNode({
            id: SEPARATED,
            apiName: 'Birth_Date__c',
            parentId: 'CustomObject:Obj_A__c',
            properties: {
              dataType: 'Date',
              description: "Date of this individual's birth",
            },
          }),
          makeNode({
            id: STRADDLE,
            apiName: 'Class_Number__c',
            parentId: 'CustomObject:Obj_A__c',
            properties: { dataType: 'Number' },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(`seed failed: ${imported.error.message}`);
    ctx2 = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store2 };
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports exactly what the recognizer says for BOTH spellings — no local override', async () => {
    // DELIBERATELY DERIVED, not pinned to a literal verdict.
    //
    // The separator fix lives in `@sf-intelligence/patterns` src; this package
    // imports that package's BUILT `dist/`, which this branch does not rebuild
    // (concurrent `tsc --build` corrupts the shared dist, so agents here never
    // build). Pinning `pii`/`identifier` for the separated spelling would
    // therefore assert the state of a build artefact rather than of the code,
    // and would flip red or green depending on who built last. The flip itself
    // is pinned where it runs against source:
    // `packages/patterns/test/pii-detection.test.ts` ->
    // "separator-spelled multi-word concepts".
    //
    // What is this TOOL's to guarantee, and what this case bites on, is that it
    // publishes the recognizer's verdict unaltered — it holds no second copy of
    // the classification rules that could drift from them.
    const result = await piiInventoryHandler(ctx2, { limit: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.data.fields.map((f) => [f.id, f]));
    for (const [id, apiName] of [
      [ONE_TOKEN, 'Birthdate__c'],
      [SEPARATED, 'Birth_Date__c'],
    ] as const) {
      const expected = detectPiiClassificationWithReason({
        id,
        type: 'CustomField',
        apiName,
        label: apiName,
        parentId: 'CustomObject:Obj_A__c',
        sourcePath: `objects/Obj_A__c/fields/${apiName}.field-meta.xml`,
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties:
          id === SEPARATED
            ? { dataType: 'Date', description: "Date of this individual's birth" }
            : { dataType: 'Date' },
      });
      expect(byId.get(id)?.classification, apiName).toBe(
        expected.piiClassification,
      );
      expect(byId.get(id)?.category, apiName).toBe(expected.piiCategory);
      expect(byId.get(id)?.reason, apiName).toBe(expected.reason);
    }
  });

  it('does not read an identifier out of two words that merely abut', async () => {
    const result = await piiInventoryHandler(ctx2, { limit: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.data.fields.map((f) => [f.id, f]));
    const straddle = byId.get(STRADDLE);
    expect(straddle?.category, straddle?.reason).not.toBe('identifier');
    expect(straddle?.classification, straddle?.reason).toBe('public');
  });

  it('no longer publishes the separator-sensitivity boundary it used to', async () => {
    // A boundary describing a repaired limitation is the same stale-prose
    // defect as a csv header asserting the opposite of the code. The
    // replacement names the limitation that SURVIVED: a finite vocabulary.
    const result = await piiInventoryHandler(ctx2, { limit: 500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prose = result.value.data.boundaries.join(' ');
    expect(prose).not.toMatch(/separators intact|spells it as one token/i);
    expect(prose).toMatch(/FIXED vocabulary of concept tokens/);
    // And the csv header, which is derived from the same array, agrees.
    const csv = await piiInventoryHandler(ctx2, { limit: 500, format: 'csv' });
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    const header = (csv.value.data.csv ?? '')
      .split('\n')
      .filter((l) => l.startsWith('#'))
      .join(' ');
    expect(header).not.toMatch(/separators intact/i);
    expect(header).toMatch(/FIXED vocabulary of concept tokens/);
  });
});
