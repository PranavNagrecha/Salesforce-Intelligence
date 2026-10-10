/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { ExtractionResult, Node } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import { resolveComponents } from '../src/resolve.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

/**
 * B08 / C10 — FAIL-BEFORE/PASS-AFTER.
 *
 * (1) "<ExactApiName> label" / "<ExactApiName> class": the trailing type noun
 *     was matched as a NAME token, so an exact api name came back `ambiguous`.
 * (2) A query that IS a field's multi-word label ("Number of Invoice Records")
 *     ranked a fuzzy look-alike above the exact label and stayed `ambiguous`.
 */
const makeNode = (o: Partial<Node> & Pick<Node, 'id' | 'apiName'>): Node => ({
  type: 'CustomObject',
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Project__c', apiName: 'Project__c', label: 'Project' }),
    makeNode({ id: 'CustomObject:Invoice__c', apiName: 'Invoice__c', label: 'Invoice' }),
    makeNode({
      id: 'CustomField:Project__c.Number_of_Invoice_Records__c',
      type: 'CustomField',
      apiName: 'Number_of_Invoice_Records__c',
      label: 'Number of Invoice Records',
      parentId: 'CustomObject:Project__c',
    }),
    makeNode({
      id: 'CustomField:Project__c.Number_of_Weekly_Invoices__c',
      type: 'CustomField',
      apiName: 'Number_of_Weekly_Invoices__c',
      label: 'Number of Weekly Invoices',
      parentId: 'CustomObject:Project__c',
    }),
    makeNode({
      id: 'CustomField:Invoice__c.Billing_Stage__c',
      type: 'CustomField',
      apiName: 'Billing_Stage__c',
      label: 'Billing Stage',
      parentId: 'CustomObject:Invoice__c',
    }),
    // A field labelled "<X> Record" beside one labelled "<X>" (the shorter one
    // is MORE referenced, so it out-scores on popularity when the trailing
    // "Record" is wrongly stripped as a type noun).
    makeNode({
      id: 'CustomField:Project__c.Billing_Contact_Record__c',
      type: 'CustomField',
      apiName: 'Billing_Contact_Record__c',
      label: 'Billing Contact Record',
      parentId: 'CustomObject:Project__c',
    }),
    makeNode({
      id: 'CustomField:Project__c.Legacy_Billing_Contact__c',
      type: 'CustomField',
      apiName: 'Legacy_Billing_Contact__c',
      label: 'Billing Contact',
      parentId: 'CustomObject:Project__c',
    }),
    makeNode({ id: 'CustomLabel:Invoice_Portal_URL', type: 'CustomLabel', apiName: 'Invoice_Portal_URL', label: 'Invoice Portal URL' }),
    makeNode({ id: 'CustomLabel:Invoice_Portal_Help', type: 'CustomLabel', apiName: 'Invoice_Portal_Help', label: 'Invoice Portal Help' }),
    makeNode({ id: 'ApexClass:InvoiceSelector', type: 'ApexClass', apiName: 'InvoiceSelector' }),
    makeNode({ id: 'ApexClass:InvoiceService', type: 'ApexClass', apiName: 'InvoiceService' }),
  ],
  edges: [
    // Popularity for the SHORTER-label field, so a wrong strip lets it win on score.
    ...['InvoiceSelector', 'InvoiceService'].map((c) => ({
      fromId: `ApexClass:${c}`,
      toId: 'CustomField:Project__c.Legacy_Billing_Contact__c',
      edgeType: 'references' as const,
      confidence: 'heuristic' as const,
      source: 'apex-scanner',
      properties: {},
    })),
  ],
};

let tempDir: string;
let store: GraphStore;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-resolve-noun-'));
  const instance = await DuckDBInstance.create(join(tempDir, 'r.db'));
  const connection = await instance.connect();
  const init = await initSchema(connection);
  if (!init.ok) throw new Error(init.error.message);
  store = { connection, instance };
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
});

afterAll(() => {
  store.connection.disconnectSync();
  store.instance.closeSync();
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('trailing type nouns are type hints, not name tokens (B08)', () => {
  it.each([
    ['Invoice_Portal_URL label', 'CustomLabel:Invoice_Portal_URL'],
    ['Invoice_Portal_URL custom label', 'CustomLabel:Invoice_Portal_URL'],
    ['InvoiceSelector class', 'ApexClass:InvoiceSelector'],
  ])('"%s" resolves exact to %s', async (query, id) => {
    const r = await resolveComponents(store, query);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.disposition).toBe('exact');
    expect(r.value.candidates[0]?.id).toBe(id);
  });
});

describe('an exact multi-word label is a whole-name hit (C10)', () => {
  it('"Number of Invoice Records" resolves exact to the field with that label', async () => {
    const r = await resolveComponents(store, 'Number of Invoice Records');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomField:Project__c.Number_of_Invoice_Records__c');
    expect(r.value.disposition).toBe('exact');
  });
});

describe('a type noun before "on <Object>" is a type hint too (ROUTE-06)', () => {
  it.each([
    ['Billing Stage picklist on invoice'],
    ['Billing Stage field on invoice'],
  ])('"%s" resolves exact to the field', async (query) => {
    const r = await resolveComponents(store, query);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomField:Invoice__c.Billing_Stage__c');
    expect(r.value.disposition).toBe('exact');
  });
});

/**
 * FAIL-BEFORE/PASS-AFTER — "record(s)" as a stripped type noun must never eat
 * a word that is PART of a real label. Before: "Billing Contact Record field"
 * stripped BOTH "field" and "Record", so the shorter label "Billing Contact"
 * matched the stripped query exactly and won `exact` on the wrong field.
 */
describe('a literal name/label match on the less-stripped query wins', () => {
  it.each([
    ['Billing Contact Record field'],
    ['Billing Contact Record'],
    ['the Billing Contact Record field'],
  ])('"%s" resolves exact to the field labelled "Billing Contact Record"', async (query) => {
    const r = await resolveComponents(store, query);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomField:Project__c.Billing_Contact_Record__c');
    expect(r.value.disposition).toBe('exact');
    const sibling = r.value.candidates.find(
      (c) => c.id === 'CustomField:Project__c.Legacy_Billing_Contact__c',
    );
    if (sibling !== undefined) expect(sibling.matchKind).not.toBe('exact');
  });

  it('"Billing Contact field" still strips the noun and resolves to the "Billing Contact" field', async () => {
    const r = await resolveComponents(store, 'Billing Contact field');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomField:Project__c.Legacy_Billing_Contact__c');
    expect(r.value.disposition).toBe('exact');
  });
});
