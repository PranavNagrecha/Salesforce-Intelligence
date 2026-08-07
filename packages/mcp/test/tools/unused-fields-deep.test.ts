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
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import { resetLiveSession } from '../../src/tools/live-session.js';
import {
  LIVE_CROSS_CHECK_CAP,
  unusedFieldsDeepHandler,
  unusedFieldsDeepInputSchema,
  type UnusedFieldDeepEntry,
} from '../../src/tools/unused-fields-deep.js';
import { grantTestLiveAccess } from '../helpers/live-test-grant.js';

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
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store, liveCapability: mintLiveCapability('opt-in')};
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

  // GROUP-A PII-safety: a truly-unused PII / encrypted field must NOT read as
  // the bland "consider deletion" recommendation — it must PREPEND a compliance
  // escalation and expose a machine-readable piiClassification.
  it('escalates a truly-unused PII (SSN) field with a compliance recommendation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-pii-'));
    const opened = await openGraph(join(dir, 'pii.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const piiField = 'CustomField:Account.SSN__c';
      const imp = await importExtractionResults(s, [
        {
          nodes: [
            makeNode({
              id: piiField,
              apiName: 'SSN__c',
              parentId: ACCOUNT_ID,
              properties: { dataType: 'Text' },
            }),
          ],
          edges: [],
        },
      ]);
      if (!imp.ok) throw new Error('import failed');
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
      const result = await unusedFieldsDeepHandler(localCtx, { parentObjectFilter: 'Account' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const entry = result.value.data.fields.find((f) => f.id === piiField);
      expect(entry).toBeDefined();
      // machine-readable classification surfaced
      expect(entry?.piiClassification).toBe('pii');
      // the recommendation must escalate, not read as bland deletion
      expect(entry?.recommendedAction.toLowerCase()).toContain('pii');
      expect(entry?.recommendedAction.toLowerCase()).toMatch(
        /compliance|retention|irreversible|sign-off/,
      );
      expect(entry?.recommendedAction).not.toBe(
        'field appears unused across all eight tiers; consider deletion after manual review of dynamic Apex / LWC / external integration paths the scanner cannot see.',
      );
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
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
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
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
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
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

  // R6-21: format: 'csv' — fields moves to csv; JSON-facing fields stay.
  it('omits csv unless format is csv (default json)', async () => {
    const result = await unusedFieldsDeepHandler(ctx, { parentObjectFilter: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.csv).toBeUndefined();
    expect(result.value.data.fields.length).toBeGreaterThan(0);
  });

  it('returns fields:[] and a csv with one row per matched field (checks flattened to checks_* columns)', async () => {
    const jsonResult = await unusedFieldsDeepHandler(ctx, { parentObjectFilter: 'Account' });
    const csvResult = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
      format: 'csv',
    });
    expect(jsonResult.ok).toBe(true);
    expect(csvResult.ok).toBe(true);
    if (!jsonResult.ok || !csvResult.ok) return;
    expect(csvResult.value.data.fields).toEqual([]);
    const csv = csvResult.value.data.csv;
    expect(csv).toBeDefined();
    if (csv === undefined) return;
    const dataLines = csv.trimEnd().split('\n').filter((l) => !l.startsWith('#'));
    expect(dataLines[0]).toBe(
      'id,apiName,parentObjectApiName,label,fieldType,isCustom,namespacePrefix,confidence,recommendedAction,piiClassification,' +
        'checks_noIncomingEdges,checks_noFormulaTextReferences,checks_noLayoutReferences,checks_noSoqlStringReferences,' +
        'checks_noUnresolvedApexReferences,checks_noLwcAuraVfReferences,checks_noConditionalContextReferences,checks_noIntegrationExposure',
    );
    expect(dataLines.length - 1).toBe(jsonResult.value.data.fields.length);
    const trulyUnusedRow = dataLines.find((l) => l.startsWith(`${TRULY_UNUSED},`));
    expect(trulyUnusedRow).toBeDefined();
    // The eight checks are all `true` for TRULY_UNUSED per the earlier assertion.
    expect(trulyUnusedRow?.split(',').slice(-8)).toEqual([
      'true', 'true', 'true', 'true', 'true', 'true', 'true', 'true',
    ]);
  });

  it('embeds the freshness + boundary disclosures as comment lines', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
      format: 'csv',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const csv = result.value.data.csv ?? '';
    expect(csv).toContain('# generatedAt:');
    expect(csv).toContain('# sourceTreeHash:');
    expect(csv).toContain('no static evidence of use');
  });

  it('every data row is well-formed CSV with exactly 18 columns (RFC 4180 quote-aware parse)', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
      format: 'csv',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const csv = result.value.data.csv ?? '';
    const dataLines = csv.trimEnd().split('\n').filter((l) => !l.startsWith('#'));
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
      expect(countCells(line)).toBe(18);
    }
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

  it('accepts offset and cursor (CR-22)', () => {
    expect(
      unusedFieldsDeepInputSchema.safeParse({ offset: 1, cursor: 'abc' }).success,
    ).toBe(true);
  });

  it('accepts the live params (CR-CAP-L5)', () => {
    expect(
      unusedFieldsDeepInputSchema.safeParse({ liveEnabled: true, orgAlias: 'prod' }).success,
    ).toBe(true);
  });

  it('accepts the internal staticOnly composition guard (CR-CAP-L5 timeout fix)', () => {
    expect(unusedFieldsDeepInputSchema.safeParse({ staticOnly: true }).success).toBe(true);
  });
});

// =============================================================================
// CR-CAP-L5 — live population cross-check on `confidence: 'high'` fields.
// Isolated local graph: ONE unused custom field (TargetField__c, zero
// references — always `high`) so live-check assertions are unambiguous.
// =============================================================================
describe('unusedFieldsDeepHandler — live population cross-check (CR-CAP-L5)', () => {
  const LIVE_OBJ = 'CustomObject:LiveCheckObj__c';
  const LIVE_FIELD = 'CustomField:LiveCheckObj__c.TargetField__c';
  let dir: string;
  let s: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-live-'));
    const opened = await openGraph(join(dir, 'live.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    s = opened.value;
    const nodes: Node[] = [
      makeNode({ id: LIVE_OBJ, type: 'CustomObject', apiName: 'LiveCheckObj__c' }),
      makeNode({
        id: LIVE_FIELD,
        apiName: 'TargetField__c',
        parentId: LIVE_OBJ,
        properties: { dataType: 'Text' },
      }),
    ];
    const imp = await importExtractionResults(s, [{ nodes, edges: [] }]);
    if (!imp.ok) throw new Error(imp.error.message);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
  });
  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  let consentDir: string;
  beforeEach(async () => {
    resetLiveSession();
    consentDir = mkdtempSync(join(tmpdir(), 'sfi-ufd-consent-'));
    process.env.SFI_CONSENT_PATH = join(consentDir, 'c.json');
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    await grantTestLiveAccess('me@example.com');
  });
  afterEach(() => {
    resetLiveSession();
    delete process.env.SFI_CONSENT_PATH;
    rmSync(consentDir, { recursive: true, force: true });
  });

  /** 100 total records; `populatedCount` controls how many are non-null. */
  const makePopulationExec = (populatedCount: number): ExecCommand =>
    (async (_bin, args) => {
      const soql = String(args[args.indexOf('--query') + 1] ?? '');
      const count = soql.includes('= null') ? 100 - populatedCount : 100;
      return { stdout: JSON.stringify({ result: { totalSize: count } }), stderr: '' };
    }) as ExecCommand;

  const targetEntry = (fields: readonly UnusedFieldDeepEntry[]) =>
    fields.find((f) => f.id === LIVE_FIELD);

  it('populated → downgrades high to medium with a livePopulation evidence block', async () => {
    const exec = makePopulationExec(40);
    const r = await unusedFieldsDeepHandler(
      localCtx,
      { objectId: LIVE_OBJ, liveEnabled: true },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entry = targetEntry(r.value.data.fields);
    expect(entry?.confidence).toBe('medium');
    expect(entry?.livePopulation).toBeDefined();
    expect(entry?.livePopulation?.totalCount).toBe(100);
    expect(entry?.livePopulation?.populatedCount).toBe(40);
    expect(entry?.recommendedAction).toContain('LIVE CHECK');
    expect(entry?.recommendedAction).toContain('downgraded from high to medium');
    // byConfidence/totalCount stay the STATIC totals — disclosed, not silently drifted.
    expect(r.value.data.byConfidence.high).toBeGreaterThanOrEqual(1);
    expect(
      r.value.data.boundaries.some((b) => b.includes('STATIC analysis only')),
    ).toBe(true);
  });

  it('zero population → high stands, with the live evidence block still attached', async () => {
    const exec = makePopulationExec(0);
    const r = await unusedFieldsDeepHandler(
      localCtx,
      { objectId: LIVE_OBJ, liveEnabled: true },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entry = targetEntry(r.value.data.fields);
    expect(entry?.confidence).toBe('high');
    expect(entry?.livePopulation).toBeDefined();
    expect(entry?.livePopulation?.populatedCount).toBe(0);
    expect(entry?.livePopulation?.totalCount).toBe(100);
  });

  it('live unavailable (no consent, no liveEnabled) → static confidence stands with a disclosure', async () => {
    const { revokeLiveConsent } = await import('../../src/live-consent.js');
    await revokeLiveConsent('me@example.com');
    const throwExec: ExecCommand = (async () => {
      throw new Error('sf must NOT be spawned — live plane is not enabled');
    }) as ExecCommand;
    const r = await unusedFieldsDeepHandler(localCtx, { objectId: LIVE_OBJ }, throwExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entry = targetEntry(r.value.data.fields);
    expect(entry?.confidence).toBe('high');
    expect(entry?.livePopulation).toBeUndefined();
    expect(r.value.data.boundaries).toContain(
      'static-only verdict; live population not checked',
    );
  });

  it('live error (budget exhausted) → fails soft to the static confidence with a disclosure, never crashes', async () => {
    const prevBudget = process.env.SFI_LIVE_QUERY_BUDGET;
    process.env.SFI_LIVE_QUERY_BUDGET = '0';
    try {
      const exec = makePopulationExec(40);
      const r = await unusedFieldsDeepHandler(
        localCtx,
        { objectId: LIVE_OBJ, liveEnabled: true },
        exec,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const entry = targetEntry(r.value.data.fields);
      expect(entry?.confidence).toBe('high');
      expect(entry?.livePopulation).toBeUndefined();
      expect(r.value.data.boundaries).toContain(
        'static-only verdict; live population not checked',
      );
    } finally {
      if (prevBudget === undefined) delete process.env.SFI_LIVE_QUERY_BUDGET;
      else process.env.SFI_LIVE_QUERY_BUDGET = prevBudget;
    }
  });

  it('never attempts a live call when no field on the page is high-confidence (budget-neutral)', async () => {
    const managedDir = mkdtempSync(join(tmpdir(), 'sfi-ufd-live-managed-'));
    const opened = await openGraph(join(managedDir, 'managed.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const managedStore = opened.value;
    try {
      const obj = 'CustomObject:ManagedOnlyObj__c';
      const managedField = 'CustomField:ManagedOnlyObj__c.ns__Managed__c';
      const nodes: Node[] = [
        makeNode({ id: obj, type: 'CustomObject', apiName: 'ManagedOnlyObj__c' }),
        makeNode({
          id: managedField,
          apiName: 'ns__Managed__c',
          parentId: obj,
          properties: { dataType: 'Text' },
        }),
      ];
      const imp = await importExtractionResults(managedStore, [{ nodes, edges: [] }]);
      if (!imp.ok) throw new Error(imp.error.message);
      const managedCtx: Context = {
        vaultRoot: managedDir,
        manifest: FIXTURE_MANIFEST,
        graph: managedStore,
      liveCapability: mintLiveCapability('opt-in'),
      };
      const throwExec: ExecCommand = (async () => {
        throw new Error('live must NEVER be reached — no high-confidence field on this page');
      }) as ExecCommand;
      const r = await unusedFieldsDeepHandler(
        managedCtx,
        { objectId: obj, excludeManagedPackage: false, liveEnabled: true },
        throwExec,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const entry = r.value.data.fields.find((f) => f.id === managedField);
      expect(entry?.confidence).toBe('low');
      expect(entry?.livePopulation).toBeUndefined();
    } finally {
      await closeGraph(managedStore);
      rmSync(managedDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// CR-CAP-L5 timeout fix — the live cross-check must be BOUNDED so a large
// consented org (many high-confidence fields on one page) never fires hundreds
// of serial live queries and blows the MCP 60s client timeout. Two bounds:
//   FIX B — at most LIVE_CROSS_CHECK_CAP live cross-checks fire per page.
//   FIX A — `staticOnly: true` fires ZERO (the composite guard).
// Isolated local graph seeded with MANY zero-reference custom fields on ONE
// object (all statically `high`) so the cap is observable.
// =============================================================================
describe('unusedFieldsDeepHandler — live cross-check is bounded (CR-CAP-L5 timeout fix)', () => {
  const MANY_OBJ = 'CustomObject:ManyHighObj__c';
  const HIGH_FIELD_COUNT = LIVE_CROSS_CHECK_CAP + 5; // strictly more than the cap
  let dir: string;
  let s: GraphStore;
  let localCtx: Context;

  const fieldId = (i: number): string =>
    `CustomField:ManyHighObj__c.Field${String(i).padStart(2, '0')}__c`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-cap-'));
    const opened = await openGraph(join(dir, 'cap.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    s = opened.value;
    const nodes: Node[] = [
      makeNode({ id: MANY_OBJ, type: 'CustomObject', apiName: 'ManyHighObj__c' }),
    ];
    for (let i = 0; i < HIGH_FIELD_COUNT; i += 1) {
      nodes.push(
        makeNode({
          id: fieldId(i),
          apiName: `Field${String(i).padStart(2, '0')}__c`,
          parentId: MANY_OBJ,
          properties: { dataType: 'Text' },
        }),
      );
    }
    const imp = await importExtractionResults(s, [{ nodes, edges: [] }]);
    if (!imp.ok) throw new Error(imp.error.message);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
  });
  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  let consentDirCap: string;
  beforeEach(async () => {
    resetLiveSession();
    consentDirCap = mkdtempSync(join(tmpdir(), 'sfi-ufd-cap-consent-'));
    process.env.SFI_CONSENT_PATH = join(consentDirCap, 'c.json');
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    await grantTestLiveAccess('me@example.com');
  });
  afterEach(() => {
    resetLiveSession();
    delete process.env.SFI_CONSENT_PATH;
    rmSync(consentDirCap, { recursive: true, force: true });
  });

  it('FIX B: at most LIVE_CROSS_CHECK_CAP live cross-checks fire even when the page holds more high-confidence fields', async () => {
    // Count the null-population probes (one per cross-checked field). The
    // per-object total COUNT is cached, so this isolates the per-field cost.
    let nullCountQueries = 0;
    // populatedCount = 0 → every cross-checked field STAYS high, with a
    // livePopulation block attached, so "has a block" == "was cross-checked".
    const countingExec: ExecCommand = (async (_bin, args) => {
      const soql = String(args[args.indexOf('--query') + 1] ?? '');
      if (soql.includes('= null')) nullCountQueries += 1;
      return { stdout: JSON.stringify({ result: { totalSize: 100 } }), stderr: '' };
    }) as ExecCommand;

    const r = await unusedFieldsDeepHandler(
      localCtx,
      { objectId: MANY_OBJ, liveEnabled: true, limit: 500 },
      countingExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fields = r.value.data.fields;
    // The whole seeded set fits on one page (all statically high).
    expect(fields.length).toBe(HIGH_FIELD_COUNT);
    expect(fields.every((f) => f.confidence === 'high')).toBe(true);

    // THE GUARD: the cap bounds how many live cross-checks fire.
    expect(nullCountQueries).toBeLessThanOrEqual(LIVE_CROSS_CHECK_CAP);
    expect(nullCountQueries).toBe(LIVE_CROSS_CHECK_CAP);

    // Exactly the first CAP fields (page order = id order) carry a live block;
    // the rest keep their static verdict with no live evidence.
    const withLive = fields.filter((f) => f.livePopulation !== undefined);
    expect(withLive.length).toBe(LIVE_CROSS_CHECK_CAP);
    for (let i = 0; i < HIGH_FIELD_COUNT; i += 1) {
      const entry = fields.find((f) => f.id === fieldId(i));
      expect(entry).toBeDefined();
      if (i < LIVE_CROSS_CHECK_CAP) expect(entry?.livePopulation).toBeDefined();
      else {
        expect(entry?.livePopulation).toBeUndefined();
        expect(entry?.confidence).toBe('high');
      }
    }

    // An honest disclosure names the cap (N of M).
    expect(
      r.value.data.boundaries.some(
        (b) =>
          b.includes(`first ${LIVE_CROSS_CHECK_CAP} of ${HIGH_FIELD_COUNT}`) &&
          b.includes('high-confidence fields on this page'),
      ),
    ).toBe(true);
  });

  it('FIX A: staticOnly:true fires ZERO live queries and skips the cross-check entirely', async () => {
    const throwExec: ExecCommand = (async () => {
      throw new Error('live must NEVER be reached under staticOnly:true');
    }) as ExecCommand;
    // liveEnabled:true would normally trigger the cross-check for every high
    // field — staticOnly must override and skip the whole block.
    const r = await unusedFieldsDeepHandler(
      localCtx,
      { objectId: MANY_OBJ, liveEnabled: true, staticOnly: true, limit: 500 },
      throwExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fields = r.value.data.fields;
    expect(fields.length).toBe(HIGH_FIELD_COUNT);
    // No field carries live evidence — the cross-check never ran.
    expect(fields.every((f) => f.livePopulation === undefined)).toBe(true);
    expect(fields.every((f) => f.confidence === 'high')).toBe(true);
    // Neither the not-checked NOR the cap disclosure appears: the block was
    // skipped, not failed-soft. boundaries stays the base static set (2 entries).
    expect(r.value.data.boundaries).not.toContain(
      'static-only verdict; live population not checked',
    );
    expect(
      r.value.data.boundaries.some((b) => b.includes('high-confidence fields on this page')),
    ).toBe(false);
    expect(r.value.data.boundaries.length).toBe(2);
  });
});

// =============================================================================
// CR-22 B4 — output cursor + byte-trim preserved. A whole-fits no-cursor call
// is byte-identical; a truncated page resumes the full set with no gaps / dupes;
// totalCount/byParentObject/byConfidence stay UNFILTERED across pages.
// =============================================================================
describe('unusedFieldsDeepHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call omits all paging fields', async () => {
    const r = await unusedFieldsDeepHandler(ctx, { parentObjectFilter: 'Account' });
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
    const all = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
      limit: 500,
    });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.fields.map((f) => f.id);
    // At least two unused Account fields → limit:1 forces a multi-page walk.
    expect(fullOrder.length).toBeGreaterThanOrEqual(2);
    const fullTotal = all.value.data.totalCount;
    const fullByConfidence = all.value.data.byConfidence;

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof unusedFieldsDeepHandler>> =
        await unusedFieldsDeepHandler(
          ctx,
          cursor !== undefined
            ? { parentObjectFilter: 'Account', limit: 1, cursor }
            : { parentObjectFilter: 'Account', limit: 1 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      // Counts stay full-set across pages.
      expect(page.value.data.totalCount).toBe(fullTotal);
      expect(page.value.data.byConfidence).toEqual(fullByConfidence);
      for (const f of page.value.data.fields) seen.push(f.id);
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 50) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor minted for a different object scope', async () => {
    const first = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    if (typeof cursor !== 'string') return; // only meaningful when truncated
    const replay = await unusedFieldsDeepHandler(ctx, { cursor });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
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
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
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

  // R6-21: the same byte-trimmed page, encoded as csv instead of JSON `fields`.
  // `fitCsvRowsToBudget` inside the handler must itself stay under the tool's
  // own byte budget so the FULL envelope never trips the global ~45 KB guard.
  it('fits a csv export of the byte-trimmed page under the global guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-budget-csv-'));
    const opened = await openGraph(join(dir, 'budget-csv.db'));
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
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
      const r = await unusedFieldsDeepHandler(localCtx, { limit: 500, format: 'csv' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const bytes = Buffer.byteLength(JSON.stringify(r.value), 'utf8');
      expect(bytes).toBeLessThanOrEqual(45_000);
      expect(r.value.data.fields).toEqual([]);
      expect(r.value.data.csv).toBeDefined();
      expect(r.value.data.csv).toContain('# generatedAt:');
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
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
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
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
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

// Perf regression guard: the three incoming-edge tiers (structural,
// LWC/Aura/VF `references`, integration `exposes`) all read the SAME incoming
// edge set. They MUST come from one batched `listEdgesForNodes` fetch across all
// matching fields — not three N+1 `listEdges` calls per field (~3× the field
// count in DuckDB round-trips), the dominant cost in the >60s
// tech_debt_score / org_risk_report timeout on a large org.
describe('unusedFieldsDeepHandler — batched incoming-edge lookups (no N+1)', () => {
  const FIELD_COUNT = 60;
  let dir: string;
  let localStore: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-perf-'));
    const opened = await openGraph(join(dir, 'perf.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    localStore = opened.value;
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Perf__c', type: 'CustomObject', apiName: 'Perf__c' }),
        ...Array.from({ length: FIELD_COUNT }, (_unused, i) =>
          makeNode({
            id: `CustomField:Perf__c.Dead${i}__c`,
            type: 'CustomField',
            apiName: `Dead${i}__c`,
            parentId: 'CustomObject:Perf__c',
            properties: { dataType: 'Text' },
          }),
        ),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(localStore, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: localStore, liveCapability: mintLiveCapability('opt-in') };
  });

  afterAll(async () => {
    await closeGraph(localStore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('issues a bounded number of edge queries for the incoming-edge tiers', async () => {
    const spy = vi.spyOn(localStore.connection, 'runAndReadAll');
    const result = await unusedFieldsDeepHandler(localCtx, { limit: 500 });
    const edgeQueries = spy.mock.calls.filter(([sql]) =>
      String(sql).includes('FROM edges'),
    ).length;
    spy.mockRestore();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All 60 custom fields are clean across the eight tiers → all surface.
    expect(result.value.data.totalCount).toBe(FIELD_COUNT);
    // ONE batched listEdgesForNodes for every matching field — not three
    // listEdges per field.
    expect(edgeQueries).toBeLessThanOrEqual(2);
  });
});

// Perf regression guard (R6B): the eight-tier text checks are case-insensitive.
// Lower-casing each corpus string must happen ONCE per scan (buildLoweredCorpora),
// NOT once per candidate field — the latter is an O(fields × corpus)
// `toLowerCase()` blowup that (after the DuckDB round-trips were batched) was the
// residual JS-CPU cost pushing the first COLD unused_fields_deep / tech_debt_score
// / org_risk_report call past the MCP 60s client timeout on a large org. Spy
// String.prototype.toLowerCase and assert the count stays ~O(fields + corpus),
// well below the O(fields × corpus) a re-introduced per-field lowercasing yields.
describe('unusedFieldsDeepHandler — corpus lowercasing hoisted out of the field loop', () => {
  const FIELD_COUNT = 40;
  // Non-matching corpus strings per apex text tier (soqlStrings + unresolved).
  // Chosen NOT to contain any field apiName so no check short-circuits — the
  // broken per-field path would then re-lowercase the FULL corpus for every field.
  const CORPUS_STRINGS = 400;
  let dir: string;
  let localStore: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-lc-'));
    const opened = await openGraph(join(dir, 'lc.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    localStore = opened.value;
    const obj = 'CustomObject:LcPerf__c';
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: obj, type: 'CustomObject', apiName: 'LcPerf__c' }),
        // FIELD_COUNT unused custom fields — all clean, all surface.
        ...Array.from({ length: FIELD_COUNT }, (_unused, i) =>
          makeNode({
            id: `CustomField:LcPerf__c.LcDead${i}__c`,
            type: 'CustomField',
            apiName: `LcDead${i}__c`,
            parentId: obj,
            properties: { dataType: 'Text' },
          }),
        ),
        // One Apex class carrying a large NON-matching text corpus across the two
        // substring tiers (soqlStrings + unresolvedFieldReferences).
        makeNode({
          id: 'ApexClass:LcBigClass',
          type: 'ApexClass',
          apiName: 'LcBigClass',
          properties: {
            soqlStrings: Array.from(
              { length: CORPUS_STRINGS },
              (_unused, i) => `SELECT Id FROM Account WHERE Unrelated_${i}__c = 1`,
            ),
            unresolvedFieldReferences: Array.from(
              { length: CORPUS_STRINGS },
              (_unused, i) => `Unrelated_${i}__c`,
            ),
          },
        }),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(localStore, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: localStore, liveCapability: mintLiveCapability('opt-in') };
  });

  afterAll(async () => {
    await closeGraph(localStore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lower-cases the corpus O(fields + corpus) times, not O(fields × corpus)', async () => {
    const spy = vi.spyOn(String.prototype, 'toLowerCase');
    const result = await unusedFieldsDeepHandler(localCtx, { limit: 500 });
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All FIELD_COUNT fields are clean across the eight tiers → all surface.
    expect(result.value.data.totalCount).toBe(FIELD_COUNT);
    // Hoisted path: ~(2 × CORPUS_STRINGS corpus) + (FIELD_COUNT apiName tokens) +
    // small overhead. Per-field regression: FIELD_COUNT × 2 × CORPUS_STRINGS =
    // 32 000+. The threshold sits an order of magnitude above the hoisted count
    // and well below the per-field count, so a re-introduced blowup fails loudly.
    expect(calls).toBeLessThan(FIELD_COUNT * CORPUS_STRINGS);
  });
});

// =============================================================================
// Finding #35 — format: 'proposal' emits a LOCAL destructiveChanges.xml bundle
// of THIS PAGE's high-confidence unused fields (medium/low excluded).
// =============================================================================

/** Minimal well-formedness check (comments + prolog stripped). */
const isWellFormedXml = (xml: string): boolean => {
  const body = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?xml[^>]*\?>/g, '');
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w.-]*)(\s[^>]*)?(\/?)>/g)) {
    const closing = m[1] === '/';
    const name = m[2] ?? '';
    if (m[4] === '/') continue;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
};

describe('unusedFieldsDeepHandler — format: proposal (Finding #35)', () => {
  it('bundles the high-confidence unused field into a well-formed destructiveChanges.xml', async () => {
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
      format: 'proposal',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proposal = result.value.data.proposal;
    expect(proposal).toBeDefined();
    if (proposal === undefined) return;

    const destructive =
      proposal.files.find((f) => f.path === 'destructiveChanges.xml')?.contents ?? '';
    const pkg =
      proposal.files.find((f) => f.path === 'package.xml')?.contents ?? '';

    // TRULY_UNUSED is confidence:high → it must be in the delete set.
    expect(destructive).toContain('<members>Account.TrulyUnused__c</members>');
    expect(destructive).toContain('<name>CustomField</name>');
    expect(destructive).not.toContain('<version>');
    expect(pkg).toContain('<version>62.0</version>');
    expect(isWellFormedXml(destructive)).toBe(true);
    expect(isWellFormedXml(pkg)).toBe(true);

    // Evidence carries the vault hash + a per-field reason + REVIEW banner.
    expect(destructive).toContain('sha256:fixture');
    expect(destructive).toMatch(/REVIEW BEFORE DEPLOY/i);
    expect(proposal.evidence.reasons.join(' ')).toContain('TrulyUnused__c');
    expect(proposal.kind).toBe('destructive');
    // `fields` still populated (json shape) alongside the artifact.
    expect(result.value.data.fields.length).toBeGreaterThan(0);
  });

  it('excludes low-confidence (protected) fields from the delete set, disclosing the count', async () => {
    // Include standard fields so a `low`-confidence entry appears on the page.
    const result = await unusedFieldsDeepHandler(ctx, {
      parentObjectFilter: 'Account',
      excludeStandardFields: false,
      format: 'proposal',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proposal = result.value.data.proposal;
    expect(proposal).toBeDefined();
    if (proposal === undefined) return;

    const lowCount = result.value.data.fields.filter(
      (f) => f.confidence === 'low',
    ).length;
    const destructive =
      proposal.files.find((f) => f.path === 'destructiveChanges.xml')?.contents ?? '';
    // No protected field is packaged for deletion; only high-confidence ids land.
    for (const field of result.value.data.fields) {
      if (field.confidence !== 'high') {
        expect(destructive).not.toContain(`<members>${field.apiName}`);
      }
    }
    if (lowCount > 0) {
      expect(proposal.evidence.disclosures.join(' ')).toMatch(/low-confidence/i);
    }
    expect(isWellFormedXml(destructive)).toBe(true);
  });

  it('R6-24-WIRE — proposal evidence names reports/dashboards holding fields out of the unused set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-ufd-wire24-'));
    const opened = await openGraph(join(dir, 'wire.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const acct = 'CustomObject:Account';
      const reportField = 'CustomField:Account.ReportNamed__c';
      const genuinelyUnused = 'CustomField:Account.GenuinelyUnused__c';
      const local: ExtractionResult = {
        nodes: [
          makeNode({ id: acct, type: 'CustomObject', apiName: 'Account' }),
          makeNode({
            id: reportField,
            apiName: 'ReportNamed__c',
            parentId: acct,
            properties: {
              dataType: 'Text',
              usedInReport: true,
              usedInReports: ['Sales/Pipeline', 'Exec/Forecast'],
              usedInDashboard: true,
              usedInDashboards: ['Exec/KPIs'],
            },
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
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
      const result = await unusedFieldsDeepHandler(localCtx, {
        parentObjectFilter: 'Account',
        format: 'proposal',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const proposal = result.value.data.proposal;
      expect(proposal).toBeDefined();
      if (proposal === undefined) return;
      const destructive =
        proposal.files.find((f) => f.path === 'destructiveChanges.xml')?.contents ?? '';
      // Unused field is packaged; report-used field is not.
      expect(destructive).toContain('<members>Account.GenuinelyUnused__c</members>');
      expect(destructive).not.toContain('<members>Account.ReportNamed__c</members>');
      // Evidence names the reports/dashboards that would break for the held-out field.
      const evidenceBlob = [
        ...proposal.evidence.reasons,
        ...proposal.evidence.disclosures,
      ].join(' ');
      expect(evidenceBlob).toContain(reportField);
      expect(evidenceBlob).toContain('Sales/Pipeline');
      expect(evidenceBlob).toContain('Exec/Forecast');
      expect(evidenceBlob).toContain('Exec/KPIs');
      expect(evidenceBlob).toMatch(/would break/i);
      expect(destructive).toContain('Sales/Pipeline');
      expect(isWellFormedXml(destructive)).toBe(true);
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
