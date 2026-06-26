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
  unusedFieldsDeepHandler,
  unusedFieldsDeepInputSchema,
} from '../../src/tools/unused-fields-deep.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomField: 8 },
  edges: { parentOf: 8 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Field__c',
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
// Seeds for the v2.4 cross-walk:
//   - Account.TrulyUnused__c — zero references anywhere (Q106 happy path)
//   - Account.RefByFormula__c — referenced by another field's formula (Q107)
//   - Account.RefByLayout__c — placed on a Layout (Q107 sibling)
//   - Account.RefBySoql__c — appears in an ApexClass SOQL string (Q107 sibling)
//   - Account.RefByLwc__c — incoming references edge from LWC bundle
//   - Account.RefByConditional__c — appears in a ConditionalContext expression
//   - Account.RefByInteg__c — has incoming `exposes` edge
//   - Account.UnresolvedRef__c — appears in apex-scanner unresolvedFieldReferences
//   - Standard field Account.Industry — excluded by default (low tier)
//   - Managed-package ns__Field__c — excluded by default
// =============================================================================

const ACCOUNT_ID = 'CustomObject:Account';
const seedParent: ExtractionResult = {
  nodes: [makeNode({ id: ACCOUNT_ID, type: 'CustomObject', apiName: 'Account' })],
  edges: [],
};

const TRULY_UNUSED = 'CustomField:Account.TrulyUnused__c';
const REF_BY_FORMULA = 'CustomField:Account.RefByFormula__c';
const SIBLING_FORMULA_FIELD = 'CustomField:Account.SiblingFormula__c';
const REF_BY_LAYOUT = 'CustomField:Account.RefByLayout__c';
const REF_BY_SOQL = 'CustomField:Account.RefBySoql__c';
const REF_BY_LWC = 'CustomField:Account.RefByLwc__c';
const REF_BY_CONDITIONAL = 'CustomField:Account.RefByConditional__c';
const REF_BY_WR_CONDITION = 'CustomField:Account.RefByWrCondition__c';
const REF_BY_INTEG = 'CustomField:Account.RefByInteg__c';
const UNRESOLVED_REF = 'CustomField:Account.UnresolvedRef__c';
const STANDARD_FIELD = 'CustomField:Account.Industry';
const MANAGED_FIELD = 'CustomField:Account.ns__Field__c';

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TRULY_UNUSED,
      apiName: 'TrulyUnused__c',
      parentId: ACCOUNT_ID,
      properties: { dataType: 'Text' },
    }),
    makeNode({
      id: REF_BY_FORMULA,
      apiName: 'RefByFormula__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: SIBLING_FORMULA_FIELD,
      apiName: 'SiblingFormula__c',
      parentId: ACCOUNT_ID,
      properties: {
        formula: 'IF(NOT(ISBLANK(RefByFormula__c)), "Y", "N")',
      },
    }),
    makeNode({
      id: REF_BY_LAYOUT,
      apiName: 'RefByLayout__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: 'Layout:Account.AccountLayout',
      type: 'Layout',
      apiName: 'Account.AccountLayout',
      properties: {
        layoutSections: [
          {
            layoutItems: [{ field: 'RefByLayout__c' }],
          },
        ],
      },
    }),
    makeNode({
      id: REF_BY_SOQL,
      apiName: 'RefBySoql__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: 'ApexClass:SomeClass',
      type: 'ApexClass',
      apiName: 'SomeClass',
      properties: {
        soqlStrings: ['SELECT Id, RefBySoql__c FROM Account'],
        unresolvedFieldReferences: ['UnresolvedRef__c'],
      },
    }),
    makeNode({
      id: UNRESOLVED_REF,
      apiName: 'UnresolvedRef__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: REF_BY_LWC,
      apiName: 'RefByLwc__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: 'LightningComponentBundle:myLwc',
      type: 'LightningComponentBundle',
      apiName: 'myLwc',
    }),
    makeNode({
      id: REF_BY_CONDITIONAL,
      apiName: 'RefByConditional__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: REF_BY_WR_CONDITION,
      apiName: 'RefByWrCondition__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: 'WorkflowRule:Account.WrCriteriaOnly',
      type: 'WorkflowRule',
      apiName: 'Account.WrCriteriaOnly',
      properties: {
        formula: null,
        conditions: [
          {
            kind: 'criteria',
            conditionContextId:
              'ConditionalContext:WorkflowRule:Account.WrCriteriaOnly.condition-0',
            expression: 'RefByWrCondition__c equals Active',
            fieldRefs: [REF_BY_WR_CONDITION],
          },
        ],
      },
    }),
    makeNode({
      id: 'ConditionalContext:WorkflowRule.Account.SomeRule.condition-0',
      type: 'ConditionalContext',
      apiName: 'condition-0',
      properties: { expression: 'RefByConditional__c = "X"' },
    }),
    makeNode({
      id: REF_BY_INTEG,
      apiName: 'RefByInteg__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: 'ApexClass:IntegrationExposer',
      type: 'ApexClass',
      apiName: 'IntegrationExposer',
    }),
    makeNode({
      id: STANDARD_FIELD,
      apiName: 'Industry',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: MANAGED_FIELD,
      apiName: 'ns__Field__c',
      parentId: ACCOUNT_ID,
    }),
  ],
  edges: [
    // parentOf edges — should NOT count as references.
    makeEdge({ fromId: ACCOUNT_ID, toId: TRULY_UNUSED, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT_ID, toId: REF_BY_FORMULA, edgeType: 'parentOf' }),
    makeEdge({
      fromId: ACCOUNT_ID,
      toId: SIBLING_FORMULA_FIELD,
      edgeType: 'parentOf',
    }),
    // LWC `references` edge into RefByLwc__c.
    makeEdge({
      fromId: 'LightningComponentBundle:myLwc',
      toId: REF_BY_LWC,
      edgeType: 'references',
      source: 'lwc-scanner',
      confidence: 'heuristic',
    }),
    // Integration exposes edge.
    makeEdge({
      fromId: 'ApexClass:IntegrationExposer',
      toId: REF_BY_INTEG,
      edgeType: 'exposes',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ufd-'));
  const dbPath = join(tempDir, 'ufd.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seedParent, seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('unusedFieldsDeepHandler', () => {
  it('flags a truly unused field with confidence high', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).toContain(TRULY_UNUSED);
    const entry = result.value.data.fields.find((f) => f.id === TRULY_UNUSED);
    expect(entry?.confidence).toBe('high');
    expect(entry?.checks.noIncomingEdges).toBe(true);
    expect(entry?.checks.noFormulaTextReferences).toBe(true);
    expect(entry?.checks.noLayoutReferences).toBe(true);
    expect(entry?.checks.noSoqlStringReferences).toBe(true);
    expect(entry?.checks.noUnresolvedApexReferences).toBe(true);
    expect(entry?.checks.noLwcAuraVfReferences).toBe(true);
    expect(entry?.checks.noConditionalContextReferences).toBe(true);
    expect(entry?.checks.noIntegrationExposure).toBe(true);
  });

  it('excludes a field whose only use is a report/dashboard (usedInReport) + carries the --with-reports caveat', async () => {
    // Dedicated store so the shared seed assertions stay intact.
    const dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-rpt-'));
    const opened = await openGraph(join(dir, 'rpt.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const acct = 'CustomObject:Account';
      const reportField = 'CustomField:Account.ReportOnly__c';
      const genuinelyUnused = 'CustomField:Account.GenuinelyUnused__c';
      const local: ExtractionResult = {
        nodes: [
          makeNode({ id: acct, type: 'CustomObject', apiName: 'Account' }),
          // Only use is a report column — the refresh `--with-reports` fold stamped
          // `usedInReport` on it (no per-report node). Must NOT surface as unused.
          makeNode({
            id: reportField,
            apiName: 'ReportOnly__c',
            parentId: acct,
            properties: { dataType: 'Text', usedInReport: true },
          }),
          makeNode({
            id: genuinelyUnused,
            apiName: 'GenuinelyUnused__c',
            parentId: acct,
            properties: { dataType: 'Text' },
          }),
        ],
        edges: [
          makeEdge({ fromId: acct, toId: reportField, edgeType: 'parentOf' }),
          makeEdge({ fromId: acct, toId: genuinelyUnused, edgeType: 'parentOf' }),
        ],
      };
      const imp = await importExtractionResults(s, [local]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
      const result = await unusedFieldsDeepHandler(localCtx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ids = result.value.data.fields.map((f) => f.id);
      expect(ids).not.toContain(reportField);
      expect(ids).toContain(genuinelyUnused);
      expect(
        result.value.data.boundaries.some((b) => b.includes('--with-reports')),
      ).toBe(true);
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F7: a field whose only incoming edge is an FLS grant (grantedBy) is still unused', async () => {
    // Dedicated store so the shared seed assertions stay intact.
    const dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-f7-'));
    const opened = await openGraph(join(dir, 'f7.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const acct = 'CustomObject:Account';
      const grantedField = 'CustomField:Account.GrantedOnly__c';
      const local: ExtractionResult = {
        nodes: [
          makeNode({ id: acct, type: 'CustomObject', apiName: 'Account' }),
          makeNode({
            id: grantedField,
            apiName: 'GrantedOnly__c',
            parentId: acct,
            properties: { dataType: 'Text' },
          }),
          makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
        ],
        edges: [
          makeEdge({ fromId: acct, toId: grantedField, edgeType: 'parentOf' }),
          // FLS grant — ACCESS, not usage; must not fail the noIncomingEdges tier.
          makeEdge({
            fromId: 'Profile:Admin',
            toId: grantedField,
            edgeType: 'grantedBy',
            source: 'profile-extractor',
            properties: { readable: true, editable: false },
          }),
        ],
      };
      const imp = await importExtractionResults(s, [local]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
      const result = await unusedFieldsDeepHandler(localCtx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const entry = result.value.data.fields.find((f) => f.id === grantedField);
      // Before the fix the FLS grant failed noIncomingEdges → the AND-of-tiers
      // verdict hid the field. It must now be flagged unused.
      expect(entry).toBeDefined();
      expect(entry?.checks.noIncomingEdges).toBe(true);
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disqualifies a field referenced only by another field\'s formula text', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).not.toContain(REF_BY_FORMULA);
  });

  it('disqualifies a field referenced only by a layout placement', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).not.toContain(REF_BY_LAYOUT);
  });

  it('disqualifies a field referenced only by an Apex SOQL string', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).not.toContain(REF_BY_SOQL);
  });

  it('disqualifies a field appearing in apex-scanner unresolvedFieldReferences', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).not.toContain(UNRESOLVED_REF);
  });

  it('disqualifies a field with an incoming LWC references edge', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).not.toContain(REF_BY_LWC);
  });

  it('disqualifies a field referenced only by a ConditionalContext expression', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).not.toContain(REF_BY_CONDITIONAL);
  });

  it('disqualifies a field referenced only via a WorkflowRule conditions mirror', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).not.toContain(REF_BY_WR_CONDITION);
  });

  it('disqualifies a field with an incoming `exposes` integration edge', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).not.toContain(REF_BY_INTEG);
  });

  it('excludes standard fields and managed-package fields by default', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).not.toContain(STANDARD_FIELD);
    expect(ids).not.toContain(MANAGED_FIELD);
  });

  it('includes standard fields when excludeStandardFields=false (with low confidence)', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
      excludeStandardFields: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.data.fields.find((f) => f.id === STANDARD_FIELD);
    expect(entry).toBeDefined();
    expect(entry?.confidence).toBe('low');
  });

  it('emits invisibilityWarnings on every flagged field even at high confidence', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.data.fields.find((f) => f.id === TRULY_UNUSED);
    expect(entry?.invisibilityWarnings.length).toBeGreaterThan(0);
    expect(entry?.invisibilityWarnings.join(' ')).toMatch(/dynamic SOQL|reflective|LWC/i);
  });

  it("emits the verbatim 'no static evidence of use' boundary disclosure", async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.boundaries.join(' ')).toMatch(
      /no static evidence of use/,
    );
  });

  it('returns byParentObject and byConfidence breakdown', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.byParentObject['Account']).toBeGreaterThanOrEqual(1);
    expect(result.value.data.byConfidence.high).toBeGreaterThanOrEqual(1);
  });
});

describe('unusedFieldsDeepInputSchema', () => {
  it('accepts an empty input', () => {
    expect(unusedFieldsDeepInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a limit above 500', () => {
    expect(
      unusedFieldsDeepInputSchema.safeParse({ limit: 501 }).success,
    ).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    expect(
      unusedFieldsDeepInputSchema.safeParse({ limit: 1.5 }).success,
    ).toBe(false);
  });

  it('accepts boolean toggles', () => {
    expect(
      unusedFieldsDeepInputSchema.safeParse({
        excludeManagedPackage: false,
        excludeStandardFields: false,
      }).success,
    ).toBe(true);
  });

  it('FLD-01: accepts objectId (canonical id form)', () => {
    expect(
      unusedFieldsDeepInputSchema.safeParse({ objectId: 'CustomObject:Account' }).success,
    ).toBe(true);
  });

  it('FLD-01: accepts objectId (bare api name form)', () => {
    expect(
      unusedFieldsDeepInputSchema.safeParse({ objectId: 'Account' }).success,
    ).toBe(true);
  });
});

describe('unusedFieldsDeepHandler — FLD-01 objectId filtering', () => {
  it('filters to a single object when objectId is the canonical id', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      objectId: 'CustomObject:Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The truly unused Account field should appear.
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).toContain(TRULY_UNUSED);
    // All returned fields must belong to Account.
    expect(result.value.data.fields.every((f) => f.parentObjectApiName === 'Account')).toBe(true);
  });

  it('filters to a single object when objectId is a bare api name', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      objectId: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.fields.map((f) => f.id);
    expect(ids).toContain(TRULY_UNUSED);
    expect(result.value.data.fields.every((f) => f.parentObjectApiName === 'Account')).toBe(true);
  });

  it('objectId and parentObjectFilter produce identical results for the same object', async () => {
    const byObjectId = await unusedFieldsDeepHandler(ctx, { objectId: 'Account' });
    const byFilter = await unusedFieldsDeepHandler(ctx, { parentObjectFilter: 'Account' });
    expect(byObjectId.ok).toBe(true);
    expect(byFilter.ok).toBe(true);
    if (!byObjectId.ok || !byFilter.ok) return;
    expect(byObjectId.value.data.fields.map((f) => f.id).sort()).toEqual(
      byFilter.value.data.fields.map((f) => f.id).sort(),
    );
  });

  it('FLD-01: objectApiName synonym produces the same result as objectId (bare name)', async () => {
    const byObjectId = await unusedFieldsDeepHandler(ctx, { objectId: 'Account' });
    const byApiName = await unusedFieldsDeepHandler(ctx, { objectApiName: 'Account' });
    expect(byObjectId.ok).toBe(true);
    expect(byApiName.ok).toBe(true);
    if (!byObjectId.ok || !byApiName.ok) return;
    expect(byObjectId.value.data.fields.map((f) => f.id).sort()).toEqual(
      byApiName.value.data.fields.map((f) => f.id).sort(),
    );
  });
});

describe('unusedFieldsDeepHandler — byte budget (oversize fix)', () => {
  it('trims the page below limit to fit the response guard, keeping honest totals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-budget-'));
    const opened = await openGraph(join(dir, 'budget.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const obj = 'CustomObject:Big_Budget_Object__c';
      const nodes: Node[] = [makeNode({ id: obj, type: 'CustomObject', apiName: 'Big_Budget_Object__c' })];
      const edges: Edge[] = [];
      for (let i = 0; i < 120; i++) {
        const api = `Very_Long_Unused_Field_For_The_Byte_Budget_${i}__c`;
        const fid = `CustomField:Big_Budget_Object__c.${api}`;
        nodes.push(makeNode({ id: fid, apiName: api, parentId: obj, properties: { dataType: 'Text' } }));
        edges.push(makeEdge({ fromId: obj, toId: fid, edgeType: 'parentOf' }));
      }
      const imp = await importExtractionResults(s, [{ nodes, edges }]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
      const r = await unusedFieldsDeepHandler(localCtx, { limit: 500 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      expect(Buffer.byteLength(JSON.stringify(d), 'utf8')).toBeLessThanOrEqual(45_000);
      expect(d.fields.length).toBeGreaterThan(0);
      expect(d.fields.length).toBeLessThan(120); // byte-trimmed below the available set
      expect(d.totalCount).toBe(120); // honest unfiltered count preserved
      expect(d.truncated).toBe(true);
      expect(typeof d.note).toBe('string');
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// CR-12 — page-to-exhaustion. buildCorpora pages every corpus type (incl. the
// high-cardinality CustomField driver and the cross-reference corpora) to
// exhaustion, not just the first 500. The verdict is destructive: an unused
// CustomField past the cap must still be enumerated, AND a field referenced
// only by a corpus member (here a Layout) past the cap must NOT be wrongly
// flagged unused (over-suppression). SFI_NODE_SCAN_LIMIT=2 drives multi-page.
// =============================================================================
describe('unusedFieldsDeepHandler — past-cap corpora completeness (CR-12 de-cap)', () => {
  beforeEach(() => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '2';
  });

  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('enumerates an unused CustomField past the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-pastcap-'));
    const opened = await openGraph(join(dir, 'pastcap.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const acct = 'CustomObject:Account';
      // 3 unused CustomFields. id-ASC: Aaa__c, Bbb__c, Zzz__c — with a cap of 2
      // the single-page corpus dropped Zzz__c entirely.
      const nodes: Node[] = [
        makeNode({ id: acct, type: 'CustomObject', apiName: 'Account' }),
        makeNode({ id: 'CustomField:Account.Aaa__c', apiName: 'Aaa__c', parentId: acct, properties: { dataType: 'Text' } }),
        makeNode({ id: 'CustomField:Account.Bbb__c', apiName: 'Bbb__c', parentId: acct, properties: { dataType: 'Text' } }),
        makeNode({ id: 'CustomField:Account.Zzz__c', apiName: 'Zzz__c', parentId: acct, properties: { dataType: 'Text' } }),
      ];
      const edges: Edge[] = [
        makeEdge({ fromId: acct, toId: 'CustomField:Account.Aaa__c', edgeType: 'parentOf' }),
        makeEdge({ fromId: acct, toId: 'CustomField:Account.Bbb__c', edgeType: 'parentOf' }),
        makeEdge({ fromId: acct, toId: 'CustomField:Account.Zzz__c', edgeType: 'parentOf' }),
      ];
      const imp = await importExtractionResults(s, [{ nodes, edges }]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
      const r = await unusedFieldsDeepHandler(localCtx, { limit: 500 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ids = r.value.data.fields.map((f) => f.id);
      expect(ids).toContain('CustomField:Account.Zzz__c');
      expect(ids).toContain('CustomField:Account.Aaa__c');
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT flag a field referenced only by a Layout that sorts PAST the cap (no over-suppression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-pastcap-layout-'));
    const opened = await openGraph(join(dir, 'pastcap-layout.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const acct = 'CustomObject:Account';
      // 3 Layouts; id-ASC: A_Layout, B_Layout, Z_Layout. With a cap of 2 the
      // Z_Layout (which references RefByZLayout__c) was dropped from the corpus,
      // so the field would be WRONGLY flagged unused (over-suppression).
      const nodes: Node[] = [
        makeNode({ id: acct, type: 'CustomObject', apiName: 'Account' }),
        makeNode({ id: 'CustomField:Account.RefByZLayout__c', apiName: 'RefByZLayout__c', parentId: acct, properties: { dataType: 'Text' } }),
        makeNode({ id: 'Layout:Account.A_Layout', type: 'Layout', apiName: 'Account.A_Layout', properties: { layoutSections: [] } }),
        makeNode({ id: 'Layout:Account.B_Layout', type: 'Layout', apiName: 'Account.B_Layout', properties: { layoutSections: [] } }),
        makeNode({
          id: 'Layout:Account.Z_Layout',
          type: 'Layout',
          apiName: 'Account.Z_Layout',
          properties: { layoutSections: [{ layoutItems: [{ field: 'RefByZLayout__c' }] }] },
        }),
      ];
      const edges: Edge[] = [
        makeEdge({ fromId: acct, toId: 'CustomField:Account.RefByZLayout__c', edgeType: 'parentOf' }),
      ];
      const imp = await importExtractionResults(s, [{ nodes, edges }]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
      const r = await unusedFieldsDeepHandler(localCtx, { limit: 500 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ids = r.value.data.fields.map((f) => f.id);
      // The field IS referenced (by the past-cap Z_Layout) → must NOT be unused.
      expect(ids).not.toContain('CustomField:Account.RefByZLayout__c');
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
