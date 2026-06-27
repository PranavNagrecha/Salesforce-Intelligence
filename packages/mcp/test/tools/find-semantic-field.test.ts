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
  findSemanticFieldHandler,
  findSemanticFieldInputSchema,
  tokenizeIdentifier,
  tokenizeText,
} from '../../src/tools/find-semantic-field.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-fsf',
};

const makeNode = (
  overrides: Partial<Node> & Pick<Node, 'id' | 'apiName'>,
): Node => ({
  type: 'CustomField',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      apiName: 'Account',
      type: 'CustomObject',
    }),
    makeNode({
      id: 'CustomField:Account.Customer_Health_Score__c',
      apiName: 'Account.Customer_Health_Score__c',
      label: 'Customer Health Score',
      parentId: 'CustomObject:Account',
      properties: { description: 'Current health rating' },
    }),
    makeNode({
      id: 'CustomField:Account.Customer_Industry__c',
      apiName: 'Account.Customer_Industry__c',
      label: 'Customer Industry',
      parentId: 'CustomObject:Account',
      properties: { description: 'Industry vertical' },
    }),
    makeNode({
      id: 'CustomField:Account.Annual_Revenue__c',
      apiName: 'Account.Annual_Revenue__c',
      label: 'Annual Revenue',
      parentId: 'CustomObject:Account',
      properties: { description: 'Yearly turnover in USD' },
    }),
    makeNode({
      id: 'CustomObject:Contact',
      apiName: 'Contact',
      type: 'CustomObject',
    }),
    makeNode({
      id: 'CustomField:Contact.Customer_Loyalty__c',
      apiName: 'Contact.Customer_Loyalty__c',
      label: 'Customer Loyalty',
      parentId: 'CustomObject:Contact',
      properties: { description: null },
    }),
    makeNode({
      id: 'CustomObject:Tasks__c',
      apiName: 'Tasks__c',
      type: 'CustomObject',
    }),
    // Synonym-bridge fixture: the apiName tokenizes to a mangled `c.dob`
    // (namespace strip + the `Object.Field` dot) and the label tokenizes to
    // `dob`, so the field bag holds `dob` but never the query tokens `date`
    // or `birth`. The query "date of birth" matches ONLY via the
    // `['dob','birthdate','birthday','birth']` synonym group — a 0-score case
    // before the synonym layer, a recall hit after it.
    makeNode({
      id: 'CustomField:Tasks__c.DOB__c',
      apiName: 'Tasks__c.DOB__c',
      label: 'DOB',
      parentId: 'CustomObject:Tasks__c',
      properties: { description: null },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fsf-'));
  const opened = await openGraph(join(tempDir, 'fsf.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('tokenizeIdentifier', () => {
  it('splits on underscores', () => {
    expect(tokenizeIdentifier('Customer_Health_Score__c')).toEqual([
      'customer',
      'health',
      'score',
    ]);
  });

  it('strips __c, __r, __mdt suffixes', () => {
    expect(tokenizeIdentifier('Foo__c')).toEqual(['foo']);
    expect(tokenizeIdentifier('Foo__r')).toEqual(['foo']);
    expect(tokenizeIdentifier('Foo__mdt')).toEqual(['foo']);
  });

  it('drops stop words', () => {
    expect(tokenizeIdentifier('Field_Of_Value')).toEqual([]);
  });

  it('splits CamelCase boundaries', () => {
    expect(tokenizeIdentifier('MyHelperUtility')).toEqual([
      'my',
      'helper',
      'utility',
    ]);
  });

  it('lowercases tokens', () => {
    expect(tokenizeIdentifier('HEALTH').every((t) => t === t.toLowerCase())).toBe(
      true,
    );
  });
});

describe('tokenizeText', () => {
  it('tokenizes punctuated query', () => {
    expect(tokenizeText("customer's health-score")).toEqual([
      'customer',
      'health',
      'score',
    ]);
  });

  it('returns empty for empty input', () => {
    expect(tokenizeText('')).toEqual([]);
  });

  it('drops stop words', () => {
    expect(tokenizeText('the customer is here')).toEqual([
      'customer',
      'here',
    ]);
  });
});

describe('findSemanticFieldHandler', () => {
  it('ranks Customer_Health_Score__c above Customer_Industry__c for "customer health"', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer health',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBeGreaterThan(0);
    const first = r.value.data.matches[0];
    expect(first?.componentId).toBe(
      'CustomField:Account.Customer_Health_Score__c',
    );
  });

  it('bridges synonyms: "date of birth" reaches DOB__c via the synonym group', async () => {
    // The DOB__c field shares no literal token with "date of birth" (its bag
    // is {c.dob, dob}); the only path to it is the synonym group
    // ['dob','birthdate','birthday','birth']. Pre-synonym this scored 0 and
    // was filtered out — this test guards the recall the bridge adds.
    const r = await findSemanticFieldHandler(ctx, {
      description: 'date of birth',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dob = r.value.data.matches.find(
      (m) => m.componentId === 'CustomField:Tasks__c.DOB__c',
    );
    expect(dob).toBeDefined();
    // Above the default minScore (0.1): one synonym hit (birth→dob, weight
    // 0.9) over the union |{date,birth}| + |{c.dob,dob}| − 0 = 4 → 0.225.
    expect(dob?.score ?? 0).toBeGreaterThan(0.1);
    expect(dob?.score).toBeCloseTo(0.225, 6);
    // The matched query token recorded is the synonym-bridged one.
    expect([...(dob?.matchedTokens ?? [])]).toEqual(['birth']);
    // Synonym hit scores below a literal hit of equal shape: had the query
    // token been literally present it would score 1/4 = 0.25 > 0.225.
    expect(dob?.score ?? 1).toBeLessThan(0.25);
  });

  it('does not regress literal-overlap scores (no-synonym match scores as before)', async () => {
    // "customer health" hits Customer_Health_Score__c on the literal tokens
    // {customer, health} only — `customer` happens to be in a synonym group
    // but it matches LITERALLY (full weight), and `health` is in no group, so
    // the synonym-aware score MUST equal the original symmetric-Jaccard value.
    // Field bag (apiName ∪ label ∪ description) =
    //   {account.customer, health, score, customer, current, rating}  (6),
    // query bag = {customer, health} (2):
    //   literal ∩ = {customer, health} (2), |∪| = 2 + 6 − 2 = 6 → 2/6 = 1/3.
    // This is the exact value the pre-synonym jaccard() returned.
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer health',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hit = r.value.data.matches.find(
      (m) =>
        m.componentId === 'CustomField:Account.Customer_Health_Score__c',
    );
    expect(hit).toBeDefined();
    expect(hit?.score).toBeCloseTo(1 / 3, 10);
  });

  it('every match carries confidence: heuristic (Q95 enforcement)', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer health',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.value.data.matches) {
      expect(m.confidence).toBe('heuristic');
    }
  });

  it('surfaces the verbatim Q95 disclosure on every call', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer health',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    // The Q95 anchor names Customer_Industry__c as the false-positive
    // example — the verbatim phrase locks the disclosure language.
    expect(joined).toContain('Customer_Industry__c');
    expect(joined).toContain('customer health');
    expect(joined).toContain('similarity-ranked recommendation');
    expect(joined.toLowerCase()).toContain('verify');
  });

  it('matchedTokens captures the overlapping tokens', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer health',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const top = r.value.data.matches[0];
    expect([...(top?.matchedTokens ?? [])].sort()).toEqual([
      'customer',
      'health',
    ]);
  });

  it('tokenizedQuery reflects the query tokenization', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: "Customer's Health-Score",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.value.data.tokenizedQuery].sort()).toEqual([
      'customer',
      'health',
      'score',
    ]);
  });

  it('filters out matches below minScore', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer health',
      minScore: 0.99,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBe(0);
  });

  it('returns empty matches when no tokens overlap', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'unrelated cucumber spaceship',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBe(0);
    expect(r.value.data.totalCount).toBe(0);
  });

  it('returns empty when the query tokenizes to nothing', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'the of by and',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBe(0);
    expect(r.value.data.tokenizedQuery.length).toBe(0);
  });

  it('filters candidates by objectIds when supplied', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer',
      objectIds: ['CustomObject:Contact'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.value.data.matches) {
      expect(m.objectId).toBe('CustomObject:Contact');
    }
  });

  it('respects limit by truncating the slice', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer',
      limit: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBeLessThanOrEqual(1);
  });

  it('ranks by score DESC with componentId ASC tiebreaker', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 1; i < r.value.data.matches.length; i += 1) {
      const a = r.value.data.matches[i - 1];
      const b = r.value.data.matches[i];
      if (a !== undefined && b !== undefined) {
        if (a.score === b.score) {
          expect(a.componentId.localeCompare(b.componentId)).toBeLessThan(0);
        } else {
          expect(a.score).toBeGreaterThan(b.score);
        }
      }
    }
  });

  it('surfaces the synonym disclosure (groups applied, heuristic, not embeddings)', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    // The disclosure must state that synonym groups ARE applied (the old
    // "no synonym dictionary" language would be a lie now)...
    expect(joined).toContain('synonym');
    expect(joined.toLowerCase()).toContain('org-agnostic');
    // ...while remaining honest that this is heuristic, not embedding-based
    // semantic search (still future work).
    expect(joined.toLowerCase()).toContain('heuristic');
    expect(joined.toLowerCase()).toContain('semantic');
    // The old disclosure's "no synonym dictionary" claim must be gone.
    expect(joined).not.toContain('no synonym dictionary');
  });
});

describe('findSemanticFieldInputSchema', () => {
  it('accepts a valid description', () => {
    expect(
      findSemanticFieldInputSchema.safeParse({ description: 'health' }).success,
    ).toBe(true);
  });

  it('accepts query as alias for description (TSB-12)', () => {
    const parsed = findSemanticFieldInputSchema.safeParse({ query: 'health score' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.description).toBe('health score');
  });

  it('rejects missing description', () => {
    expect(findSemanticFieldInputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects limit above 50', () => {
    expect(
      findSemanticFieldInputSchema.safeParse({
        description: 'x',
        limit: 51,
      }).success,
    ).toBe(false);
  });

  it('rejects minScore outside [0, 1]', () => {
    expect(
      findSemanticFieldInputSchema.safeParse({
        description: 'x',
        minScore: 1.5,
      }).success,
    ).toBe(false);
  });

  it('accepts offset and cursor (CR-22)', () => {
    expect(
      findSemanticFieldInputSchema.safeParse({
        description: 'x',
        offset: 1,
        cursor: 'abc',
      }).success,
    ).toBe(true);
  });
});

// =============================================================================
// CR-22 B4 — output cursor over the ranked match list + full CustomField scan.
// A whole-fits no-cursor call is byte-identical; a truncated page resumes the
// full set with no gaps / dupes across the score-tie boundary (componentId
// tiebreak); totalCount stays the FULL count.
// =============================================================================
describe('findSemanticFieldHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call omits all paging fields', async () => {
    const r = await findSemanticFieldHandler(ctx, {
      description: 'customer health',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextOffset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await findSemanticFieldHandler(ctx, {
      description: 'customer health',
      minScore: 0,
      limit: 50,
    });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.matches.map((m) => m.componentId);
    expect(fullOrder.length).toBeGreaterThan(2);
    const fullTotal = all.value.data.totalCount;

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof findSemanticFieldHandler>> =
        await findSemanticFieldHandler(
          ctx,
          cursor !== undefined
            ? { description: 'customer health', minScore: 0, limit: 1, cursor }
            : { description: 'customer health', minScore: 0, limit: 1 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.data.totalCount).toBe(fullTotal);
      for (const m of page.value.data.matches) seen.push(m.componentId);
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 50) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor minted for a different description / minScore', async () => {
    const first = await findSemanticFieldHandler(ctx, {
      description: 'customer health',
      minScore: 0,
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    // Different minScore → different fingerprint → rejected.
    const replay = await findSemanticFieldHandler(ctx, {
      description: 'customer health',
      minScore: 0.5,
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});
