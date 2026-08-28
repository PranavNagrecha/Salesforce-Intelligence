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
import { cpqRuleChainHandler } from '../../src/tools/cpq-rule-chain.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    CpqPriceRule: 3,
    CpqProductRule: 1,
  },
  edges: { parentOf: 4 },
  sourceTreeHash: 'sha256:cpq-rule-chain-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'placeholder',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

// =============================================================================
// Three CpqPriceRule nodes under the same SBQQ__PriceRule__c CustomObject,
// exercising the (active DESC, evaluationOrder ASC, id ASC) sort.
// =============================================================================

const PRICE_RULE_TYPE_ID = 'CustomObject:SBQQ__PriceRule__c';
const PRICE_RULE_A_ID = 'CpqPriceRule:SBQQ__PriceRule__c.A_HighDiscount';
const PRICE_RULE_B_ID = 'CpqPriceRule:SBQQ__PriceRule__c.B_LaptopFloor';
const PRICE_RULE_C_ID = 'CpqPriceRule:SBQQ__PriceRule__c.C_Inactive';

const PRODUCT_RULE_TYPE_ID = 'CustomObject:SBQQ__ProductRule__c';
const PRODUCT_RULE_ID = 'CpqProductRule:SBQQ__ProductRule__c.Battery';

const priceRuleSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PRICE_RULE_TYPE_ID,
      type: 'CustomObject',
      apiName: 'SBQQ__PriceRule__c',
    }),
    makeNode({
      id: PRICE_RULE_A_ID,
      type: 'CpqPriceRule',
      apiName: 'SBQQ__PriceRule__c.A_HighDiscount',
      label: 'High Discount',
      parentId: PRICE_RULE_TYPE_ID,
      properties: {
        active: true,
        evaluationOrder: 10,
        recognitionConfidence: 'heuristic',
      },
    }),
    makeNode({
      id: PRICE_RULE_B_ID,
      type: 'CpqPriceRule',
      apiName: 'SBQQ__PriceRule__c.B_LaptopFloor',
      label: 'Laptop Floor',
      parentId: PRICE_RULE_TYPE_ID,
      properties: {
        active: true,
        evaluationOrder: 5,
        recognitionConfidence: 'heuristic',
      },
    }),
    makeNode({
      id: PRICE_RULE_C_ID,
      type: 'CpqPriceRule',
      apiName: 'SBQQ__PriceRule__c.C_Inactive',
      label: 'Inactive Rule',
      parentId: PRICE_RULE_TYPE_ID,
      properties: {
        active: false,
        evaluationOrder: 1,
        recognitionConfidence: 'heuristic',
      },
    }),
    // A CpqProductRule under a different parent — should NOT appear in
    // a CpqPriceRule chain walk even though it lives in the same graph.
    makeNode({
      id: PRODUCT_RULE_TYPE_ID,
      type: 'CustomObject',
      apiName: 'SBQQ__ProductRule__c',
    }),
    makeNode({
      id: PRODUCT_RULE_ID,
      type: 'CpqProductRule',
      apiName: 'SBQQ__ProductRule__c.Battery',
      label: 'Battery',
      parentId: PRODUCT_RULE_TYPE_ID,
      properties: {
        active: true,
        evaluationOrder: 1,
        recognitionConfidence: 'heuristic',
      },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cpq-rule-chain-'));
  const dbPath = join(tempDir, 'cpq-rule-chain.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [priceRuleSeed]);
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

describe('cpqRuleChainHandler', () => {
  it('returns the chain sorted by (active DESC, evaluationOrder ASC, id ASC)', async () => {
    const result = await cpqRuleChainHandler(ctx, {
      ruleId: PRICE_RULE_A_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { chain, targetPosition, type } = result.value.data;
    expect(type).toBe('CpqPriceRule');
    // Three CpqPriceRule entries; the CpqProductRule under a different
    // parent is excluded.
    expect(chain.length).toBe(3);
    // Active rules first (B has evaluationOrder 5, A has 10); inactive
    // C surfaces last regardless of its lower evaluationOrder.
    expect(chain[0]?.id).toBe(PRICE_RULE_B_ID);
    expect(chain[0]?.position).toBe(1);
    expect(chain[1]?.id).toBe(PRICE_RULE_A_ID);
    expect(chain[1]?.position).toBe(2);
    expect(chain[2]?.id).toBe(PRICE_RULE_C_ID);
    expect(chain[2]?.position).toBe(3);
    expect(targetPosition).toBe(2);
  });

  it('surfaces the verbatim recognition-axis disclosure on every response', async () => {
    const result = await cpqRuleChainHandler(ctx, {
      ruleId: PRICE_RULE_B_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { disclosure } = result.value.data;
    // The disclosure names Apex customization and runtime re-ordering
    // as the two invisible-to-v2.6a paths per CpqSemantics.md §4.1.
    expect(disclosure).toContain('Apex-customized');
    expect(disclosure).toContain('runtime');
    expect(disclosure).toContain('declared evaluation order');
  });

  it('accepts a CpqProductRule id and returns only product-rule siblings', async () => {
    const result = await cpqRuleChainHandler(ctx, {
      ruleId: PRODUCT_RULE_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { chain, type, parentId } = result.value.data;
    expect(type).toBe('CpqProductRule');
    expect(parentId).toBe(PRODUCT_RULE_TYPE_ID);
    // The CpqProductRule chain has only one entry because the seed
    // contains only one product rule. The three CpqPriceRule nodes
    // are excluded — they live under a different parent and are a
    // different ComponentType.
    expect(chain.length).toBe(1);
    expect(chain[0]?.id).toBe(PRODUCT_RULE_ID);
  });

  it('returns invalid-query when the ruleId carries a non-CPQ-rule prefix', async () => {
    const result = await cpqRuleChainHandler(ctx, {
      ruleId: 'CustomField:Account.Industry',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('CpqProductRule:');
    expect(result.error.message).toContain('CpqPriceRule:');
  });

  it('returns component-not-found for an unknown rule id with a valid prefix', async () => {
    const result = await cpqRuleChainHandler(ctx, {
      ruleId: 'CpqPriceRule:SBQQ__PriceRule__c.DoesNotExist',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });
});

// =============================================================================
// R1/BRIEF-081: a rule object with MORE THAN 500 siblings under the same
// parent. The old handler fetched exactly one `listNodesByType` page capped
// at 500 with no OFFSET, so any sibling whose id sorted past the cap was
// dropped from the chain with no truncation disclosure — and when the
// CALLER's own rule was one of the dropped rows, `targetPosition` fell back
// to a bare `0`, a position no rule can occupy, indistinguishable from a
// real answer.
// =============================================================================

describe('cpqRuleChainHandler — sibling count beyond the legacy 500-row page', () => {
  const BIG_PARENT_ID = 'CustomObject:SBQQ__PriceRule__c';
  const SIBLING_COUNT = 501;
  // Zero-padded so lexical (id ASC) order matches numeric order — the last
  // one, index 500, sorts strictly after the first 500 (index 0..499).
  const idFor = (i: number) =>
    `CpqPriceRule:SBQQ__PriceRule__c.Rule${String(i).padStart(4, '0')}`;
  // The rule that sorted PAST the old 500-row cap: the 501st id, index 500.
  const LAST_RULE_ID = idFor(SIBLING_COUNT - 1);

  let bigTempDir: string;
  let bigStore: GraphStore;
  let bigCtx: Context;

  beforeAll(async () => {
    bigTempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cpq-rule-chain-big-'));
    const dbPath = join(bigTempDir, 'cpq-rule-chain-big.db');
    const opened = await openGraph(dbPath);
    if (!opened.ok) {
      throw new Error(`openGraph failed: ${opened.error.message}`);
    }
    bigStore = opened.value;
    const nodes: Node[] = [
      makeNode({
        id: BIG_PARENT_ID,
        type: 'CustomObject',
        apiName: 'SBQQ__PriceRule__c',
      }),
    ];
    for (let i = 0; i < SIBLING_COUNT; i += 1) {
      nodes.push(
        makeNode({
          id: idFor(i),
          type: 'CpqPriceRule',
          apiName: `SBQQ__PriceRule__c.Rule${String(i).padStart(4, '0')}`,
          parentId: BIG_PARENT_ID,
          properties: {
            active: true,
            evaluationOrder: 1,
            recognitionConfidence: 'heuristic',
          },
        }),
      );
    }
    const imported = await importExtractionResults(bigStore, [{ nodes, edges: [] }]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    bigCtx = {
      vaultRoot: bigTempDir,
      manifest: {
        ...FIXTURE_MANIFEST,
        components: { CustomObject: 1, CpqPriceRule: SIBLING_COUNT },
      },
      graph: bigStore,
    };
  });

  afterAll(async () => {
    await closeGraph(bigStore);
    rmSync(bigTempDir, { recursive: true, force: true });
  });

  it('includes every sibling in the chain, not just the first 500', async () => {
    const result = await cpqRuleChainHandler(bigCtx, { ruleId: LAST_RULE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All 501 same-active/same-evaluationOrder rules tie-break on id ASC, so
    // the full chain is exactly SIBLING_COUNT long when nothing was dropped.
    expect(result.value.data.chain.length).toBe(SIBLING_COUNT);
  });

  it('reports the true position of a rule that sorts past the old 500-row cap, never a bare 0', async () => {
    const result = await cpqRuleChainHandler(bigCtx, { ruleId: LAST_RULE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // idFor(500) is the 501st id in ASC order → position 501, one-based.
    expect(result.value.data.targetPosition).toBe(SIBLING_COUNT);
    expect(result.value.data.targetPosition).not.toBe(0);
  });

  it('does not report the walk as truncated when every sibling was scanned', async () => {
    const result = await cpqRuleChainHandler(bigCtx, { ruleId: LAST_RULE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.scanTruncated).toBe(false);
  });
});
