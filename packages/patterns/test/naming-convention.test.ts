/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node } from '@sf-intelligence/contracts';
import {
  closeGraph,
  type GraphStore,
  importExtractionResults,
  openGraph,
} from '@sf-intelligence/graph';

import { recognizeNamingConventions } from '../src/naming-convention.js';

// Each scenario gets its own DB file under a shared tmpdir so recognizer
// outputs don't bleed across scenarios.
let tempDir: string;

const field = (parent: string, apiName: string): Node => ({
  id: `CustomField:${parent}.${apiName}`,
  type: 'CustomField',
  apiName,
  label: apiName,
  parentId: `CustomObject:${parent}`,
  sourcePath: `objects/${parent}/fields/${apiName}.field-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { dataType: 'Text' },
});

const parentObject = (parent: string): Node => ({
  id: `CustomObject:${parent}`,
  type: 'CustomObject',
  apiName: parent,
  label: parent,
  parentId: null,
  sourcePath: `objects/${parent}/${parent}.object-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const seedStore = async (
  dbName: string,
  nodes: readonly Node[],
): Promise<GraphStore> => {
  const opened = await openGraph(join(tempDir, dbName));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const imported = await importExtractionResults(opened.value, [
    { nodes, edges: [] },
  ]);
  if (!imported.ok) throw new Error(`seed failed: ${imported.error.message}`);
  return opened.value;
};

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-patterns-naming-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('recognizeNamingConventions: strong prefix pattern', () => {
  let store: GraphStore;

  beforeAll(async () => {
    const nodes: Node[] = [parentObject('Account')];
    for (let i = 0; i < 20; i++) {
      nodes.push(field('Account', `Acc_Field${i.toString()}__c`));
    }
    store = await seedStore('strong-prefix.db', nodes);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('emits a prefix observation with 100% adherence', async () => {
    const r = await recognizeNamingConventions(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const prefixObs = r.value.find((o) => o.statement.includes('prefix'));
    expect(prefixObs).toBeDefined();
    if (prefixObs === undefined) return;
    expect(prefixObs.kind).toBe('naming-convention');
    expect(prefixObs.scope).toBe('CustomField:Account.*');
    expect(prefixObs.confidence).toBe('heuristic');
    expect(prefixObs.evidence.matching).toBe(20);
    expect(prefixObs.evidence.total).toBe(20);
    expect(prefixObs.evidence.examples.length).toBeLessThanOrEqual(5);
    for (const example of prefixObs.evidence.examples) {
      expect(example.startsWith('Acc_')).toBe(true);
    }
  });

  it('accepts a scope without the trailing .* as equivalent to the wildcard form (B5)', async () => {
    const withWildcard = await recognizeNamingConventions(store, {
      scope: 'CustomField:Account.*',
    });
    const bareForm = await recognizeNamingConventions(store, {
      scope: 'CustomField:Account',
    });
    expect(withWildcard.ok).toBe(true);
    expect(bareForm.ok).toBe(true);
    if (!withWildcard.ok || !bareForm.ok) return;
    // The bare form must not error as invalid-scope and must produce the same
    // scoped observations as the explicit wildcard form.
    expect(bareForm.value).toEqual(withWildcard.value);
    expect(bareForm.value.length).toBeGreaterThan(0);
  });
});

describe('recognizeNamingConventions: no pattern', () => {
  let store: GraphStore;

  beforeAll(async () => {
    // Ten unrelated names with no shared prefix, mixed casing, no shared
    // semantic suffix. The recognizer should stay quiet.
    const apiNames = [
      'Industry__c',
      'region_code__c',
      'AnnualRevenue__c',
      'priorityLevel__c',
      'STATUS_FIELD__c',
      'NoteText__c',
      'employee_count__c',
      'CUSTOMER_TIER__c',
      'shippingMethod__c',
      'Discount__c',
    ];
    const nodes: Node[] = [parentObject('Account')];
    for (const apiName of apiNames) {
      nodes.push(field('Account', apiName));
    }
    store = await seedStore('no-pattern.db', nodes);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('emits no observations when nothing dominates', async () => {
    const r = await recognizeNamingConventions(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });
});

describe('recognizeNamingConventions: below threshold', () => {
  let store: GraphStore;

  beforeAll(async () => {
    const nodes: Node[] = [parentObject('Account')];
    for (let i = 0; i < 4; i++) {
      nodes.push(field('Account', `Acc_F${i.toString()}__c`));
    }
    store = await seedStore('below-threshold.db', nodes);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('emits no observations when the group has fewer than 5 fields', async () => {
    const r = await recognizeNamingConventions(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });
});

describe('recognizeNamingConventions: casing pattern only', () => {
  let store: GraphStore;

  beforeAll(async () => {
    // Ten snake_case field names. No prefix dominates (the first segments are
    // all different short words), but every field is unambiguously snake_case.
    const apiNames = [
      'industry_code__c',
      'region_name__c',
      'annual_revenue__c',
      'priority_level__c',
      'status_flag__c',
      'note_text__c',
      'employee_count__c',
      'customer_tier__c',
      'shipping_method__c',
      'discount_value__c',
    ];
    const nodes: Node[] = [parentObject('Account')];
    for (const apiName of apiNames) {
      nodes.push(field('Account', apiName));
    }
    store = await seedStore('casing-only.db', nodes);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('emits a snake_case observation when casing dominates', async () => {
    const r = await recognizeNamingConventions(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const casingObs = r.value.find((o) => o.statement.includes('snake_case'));
    expect(casingObs).toBeDefined();
    if (casingObs === undefined) return;
    expect(casingObs.scope).toBe('CustomField:Account.*');
    expect(casingObs.evidence.matching).toBe(10);
    expect(casingObs.evidence.total).toBe(10);
    expect(casingObs.confidence).toBe('heuristic');
  });
});

describe('recognizeNamingConventions: partial coverage (evidence total = whole group)', () => {
  let store: GraphStore;

  beforeAll(async () => {
    // 6 fields share the FAQ_ prefix; 2 single-word fields have no prefix at
    // all (extractPrefix returns null, so they are not in the dominant's own
    // tally). The statement says "6 of 8 fields" — the evidence must agree.
    const nodes: Node[] = [parentObject('Knowledge')];
    for (const apiName of [
      'FAQ_Answer__c',
      'FAQ_Question__c',
      'FAQ_Topic__c',
      'FAQ_Source__c',
      'FAQ_Status__c',
      'FAQ_Owner__c',
    ]) {
      nodes.push(field('Knowledge', apiName));
    }
    for (const apiName of ['Title__c', 'Body__c']) {
      nodes.push(field('Knowledge', apiName));
    }
    store = await seedStore('partial-prefix.db', nodes);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('reports evidence.total as the whole group, matching the statement denominator', async () => {
    const r = await recognizeNamingConventions(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const prefixObs = r.value.find((o) => o.statement.includes('prefix "FAQ_"'));
    expect(prefixObs).toBeDefined();
    if (prefixObs === undefined) return;
    // Regression: evidence.total used to be `dom.total` (6 — the prefixed-only
    // tally), contradicting the statement's "6 of 8 fields".
    expect(prefixObs.statement).toContain('6 of 8 fields');
    expect(prefixObs.evidence.matching).toBe(6);
    expect(prefixObs.evidence.total).toBe(8);
  });
});

describe('recognizeNamingConventions: determinism', () => {
  let store: GraphStore;

  beforeAll(async () => {
    const nodes: Node[] = [parentObject('Opportunity')];
    for (let i = 0; i < 10; i++) {
      nodes.push(field('Opportunity', `OPP_Field${i.toString()}__c`));
    }
    store = await seedStore('determinism.db', nodes);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('produces identical output across repeated calls', async () => {
    const first = await recognizeNamingConventions(store);
    const second = await recognizeNamingConventions(store);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toEqual(first.value);
  });
});

describe('recognizeNamingConventions: scope filter', () => {
  let store: GraphStore;

  beforeAll(async () => {
    const nodes: Node[] = [
      parentObject('Account'),
      parentObject('Opportunity'),
    ];
    for (let i = 0; i < 10; i++) {
      nodes.push(field('Account', `Acc_Field${i.toString()}__c`));
    }
    for (let i = 0; i < 10; i++) {
      nodes.push(field('Opportunity', `OPP_Field${i.toString()}__c`));
    }
    store = await seedStore('scope-filter.db', nodes);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('limits observations to the requested parent object', async () => {
    const r = await recognizeNamingConventions(store, {
      scope: 'CustomField:Account.*',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBeGreaterThan(0);
    for (const obs of r.value) {
      expect(obs.scope).toBe('CustomField:Account.*');
      expect(obs.statement).toContain('Account');
      expect(obs.statement).not.toContain('Opportunity');
    }
  });

  it('analyzes every parent object with the default scope', async () => {
    const r = await recognizeNamingConventions(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scopes = new Set(r.value.map((o) => o.scope));
    expect(scopes.has('CustomField:Account.*')).toBe(true);
    expect(scopes.has('CustomField:Opportunity.*')).toBe(true);
  });

  it('rejects an unrecognized scope string', async () => {
    const r = await recognizeNamingConventions(store, { scope: 'bogus' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-scope');
  });
});
