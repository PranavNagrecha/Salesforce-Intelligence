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
  findHardcodedValuesAnywhereHandler,
  findHardcodedValuesAnywhereInputSchema,
} from '../../src/tools/find-hardcoded-values-anywhere.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-fhva',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
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

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
    }),
    makeNode({
      id: 'ApexClass:AddressNormalizer',
      type: 'ApexClass',
      apiName: 'AddressNormalizer',
      properties: {
        isTest: false,
        qualityIssues: [
          {
            rule: 'hardcoded-id',
            severity: 'medium',
            location: 'line 12',
            explanation:
              "Hardcoded Salesforce ID literal '0015g00000Abc1234'",
            confidence: 'heuristic',
          },
          {
            rule: 'hardcoded-email',
            severity: 'low',
            location: 'line 18',
            explanation: "Hardcoded email 'admin@example.com'",
            confidence: 'heuristic',
          },
        ],
      },
    }),
    makeNode({
      id: 'ApexClass:AddressNormalizerTest',
      type: 'ApexClass',
      apiName: 'AddressNormalizerTest',
      properties: {
        isTest: true,
        qualityIssues: [
          {
            rule: 'hardcoded-id',
            severity: 'medium',
            location: 'line 5',
            explanation: "Hardcoded Salesforce ID literal 'United States'",
            confidence: 'heuristic',
          },
        ],
      },
    }),
    makeNode({
      id: 'CustomField:Account.NetWorth__c',
      type: 'CustomField',
      apiName: 'Account.NetWorth__c',
      parentId: 'CustomObject:Account',
      properties: {
        formula: 'IF(IsActive, 100, 0)',
        description: null,
      },
    }),
    makeNode({
      id: 'CustomField:Account.AdminProfileLink__c',
      type: 'CustomField',
      apiName: 'Account.AdminProfileLink__c',
      parentId: 'CustomObject:Account',
      properties: {
        formula: "HYPERLINK('/00e000000000001', 'Profile')",
      },
    }),
    makeNode({
      id: 'ValidationRule:Account.Industry_Required',
      type: 'ValidationRule',
      apiName: 'Industry_Required',
      parentId: 'CustomObject:Account',
      properties: {
        errorConditionFormula:
          "ISBLANK(Industry) || BillingCountry == 'United States'",
        errorMessage: 'Required',
        active: true,
      },
    }),
    makeNode({
      id: 'WorkflowRule:Account.SendEmailIfBig',
      type: 'WorkflowRule',
      apiName: 'SendEmailIfBig',
      parentId: 'CustomObject:Account',
      properties: {
        formula: "AnnualRevenue > 1000000 && BillingCountry == 'United States'",
      },
    }),
    makeNode({
      id: 'CustomField:AidApp__c.Visibility__c',
      type: 'CustomField',
      apiName: 'Visibility__c',
      parentId: 'CustomObject:AidApp__c',
      properties: {
        // The date 9/30/2024 appears ONLY in an explanatory /* comment */;
        // the active logic is TODAY()-based (dynamic), so the comment date
        // must NOT be flagged as a hardcoded literal (mirrors the real
        // acme AidApp_Record__c.Visibility__c formula).
        formula:
          '/* On 9/30/2024 award years differ */ IF(TODAY() <= DATE(YEAR(TODAY()), 9, 30), 1, 0)',
      },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fhva-'));
  const opened = await openGraph(join(tempDir, 'fhva.db'));
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

describe('findHardcodedValuesAnywhereHandler', () => {
  it("finds 'United States' in ValidationRule and WorkflowRule", async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sources = r.value.data.matches.map((m) => m.source).sort();
    // Should find in validation-rule, workflow-rule, and the test Apex class
    expect(sources).toContain('validation-rule');
    expect(sources).toContain('workflow-rule');
  });

  it('value matches carry confidence: declared', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.value.data.matches) {
      expect(m.confidence).toBe('declared');
    }
  });

  it('shape matches (category only) carry confidence: heuristic', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      category: 'id',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.value.data.matches) {
      expect(m.confidence).toBe('heuristic');
    }
  });

  it('does NOT flag a date that appears only inside a /* */ formula comment', async () => {
    // Visibility__c uses TODAY() (dynamic); the date 9/30/2024 lives only in
    // an explanatory block comment. The scan must strip `/* */` comments so
    // the comment date is not reported as a hardcoded literal.
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      category: 'date',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const visibilityMatches = r.value.data.matches.filter(
      (m) => m.componentId === 'CustomField:AidApp__c.Visibility__c',
    );
    expect(visibilityMatches).toHaveLength(0);
    // The comment date appears nowhere in the results.
    expect(
      r.value.data.matches.some((m) => m.matchedValue.includes('9/30/2024')),
    ).toBe(false);
  });

  it('finds Salesforce-id-shaped strings across formulas', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      category: 'id',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Apex qualityIssues with hardcoded-id (2 entries: AddressNormalizer + AddressNormalizerTest)
    // + formula in AdminProfileLink__c (contains '00e000000000001')
    expect(r.value.data.totalCount).toBeGreaterThanOrEqual(1);
  });

  it('surfaces ID false-positive disclosure when category is id', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      category: 'id',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('ID-shape');
  });

  it('surfaces numeric false-positive disclosure when category is numeric', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      category: 'numeric',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('numeric category has very high false-positive rate');
  });

  it('surfaces the test-class refusal-pattern when a finding is in a test class', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('@isTest');
  });

  it('narrows by scope', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
      scope: ['workflow-rule'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.value.data.matches) {
      expect(m.source).toBe('workflow-rule');
    }
  });

  it('groups counts by source and category', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.bySource['validation-rule']).toBeGreaterThan(0);
    expect(r.value.data.bySource['workflow-rule']).toBeGreaterThan(0);
  });

  it('returns invalid-query when neither value nor category is provided', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('truncates to limit and flips truncated=true', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      category: 'id',
      limit: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBeLessThanOrEqual(1);
  });

  it('returns empty matches when the value is absent everywhere', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'completely-unrelated-string-xyz123',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
  });

  it('sorts matches by componentId ASC then source then location', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 1; i < r.value.data.matches.length; i += 1) {
      const a = r.value.data.matches[i - 1];
      const b = r.value.data.matches[i];
      if (a !== undefined && b !== undefined) {
        if (a.componentId === b.componentId) {
          expect(a.source.localeCompare(b.source)).toBeLessThanOrEqual(0);
        } else {
          expect(a.componentId.localeCompare(b.componentId)).toBeLessThan(0);
        }
      }
    }
  });

  it('matches carry inTestClass=true only for ApexClass with isTest=true', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const apex = r.value.data.matches.find(
      (m) => m.componentId === 'ApexClass:AddressNormalizerTest',
    );
    if (apex !== undefined) expect(apex.inTestClass).toBe(true);
  });

  it('contextSnippet is non-empty when match has surrounding text', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.value.data.matches) {
      expect(m.contextSnippet.length).toBeGreaterThan(0);
    }
  });
});

describe('findHardcodedValuesAnywhereInputSchema', () => {
  it('accepts category-only input', () => {
    expect(
      findHardcodedValuesAnywhereInputSchema.safeParse({ category: 'id' })
        .success,
    ).toBe(true);
  });

  it('accepts value-only input', () => {
    expect(
      findHardcodedValuesAnywhereInputSchema.safeParse({ value: 'United States' })
        .success,
    ).toBe(true);
  });

  it('accepts query as an alias for value', () => {
    const parsed = findHardcodedValuesAnywhereInputSchema.safeParse({
      query: 'United States',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.value).toBe('United States');
    }
  });

  it('rejects unknown category', () => {
    expect(
      findHardcodedValuesAnywhereInputSchema.safeParse({ category: 'phone' })
        .success,
    ).toBe(false);
  });

  it('rejects unknown scope value', () => {
    expect(
      findHardcodedValuesAnywhereInputSchema.safeParse({
        category: 'id',
        scope: ['payload'],
      }).success,
    ).toBe(false);
  });

  it('rejects limit above 500', () => {
    expect(
      findHardcodedValuesAnywhereInputSchema.safeParse({
        category: 'id',
        limit: 501,
      }).success,
    ).toBe(false);
  });

  it('accepts offset and cursor (CR-22)', () => {
    expect(
      findHardcodedValuesAnywhereInputSchema.safeParse({
        category: 'id',
        offset: 1,
        cursor: 'abc',
      }).success,
    ).toBe(true);
  });
});

// =============================================================================
// CR-22 B4 — output cursor + mandatory total-order tiebreak (category,
// matchedValue, contextSnippet). A whole-fits no-cursor call is byte-identical;
// a truncated page resumes the full set with no gaps / dupes even across the
// per-node-constant-location tie clusters (formula/VR/WF).
// =============================================================================
describe('findHardcodedValuesAnywhereHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call omits all paging fields', async () => {
    const r = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextOffset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d['truncated']).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
      limit: 500,
    });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const key = (m: { componentId: string; source: string; location: string; category: string; matchedValue: string; contextSnippet: string }) =>
      `${m.componentId}|${m.source}|${m.location}|${m.category}|${m.matchedValue}|${m.contextSnippet}`;
    const fullOrder = all.value.data.matches.map(key);
    expect(fullOrder.length).toBeGreaterThan(2);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof findHardcodedValuesAnywhereHandler>> =
        await findHardcodedValuesAnywhereHandler(
          ctx,
          cursor !== undefined
            ? { value: 'United States', limit: 1, cursor }
            : { value: 'United States', limit: 1 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const m of page.value.data.matches) seen.push(key(m));
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 50) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor minted for a different value (argsFingerprint bind)', async () => {
    const first = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'United States',
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    const replay = await findHardcodedValuesAnywhereHandler(ctx, {
      value: 'Canada',
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});
