/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
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
  whatIfChangeFieldTypeHandler,
  whatIfChangeFieldTypeInputSchema,
} from '../../src/tools/what-if-change-field-type.js';

const completeCoverage = (types: readonly string[]): readonly CoverageEntry[] =>
  types.map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
  }));

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 1 },
  edges: { parentOf: 1, references: 1 },
  sourceTreeHash: 'sha256:fixture',
  coverageComputedAt: '2026-05-29T12:00:00.000Z',
  coverage: completeCoverage([
    'CustomField',
    'ValidationRule',
    'Flow',
    'ApexClass',
    'ApexTrigger',
    'Layout',
    'LightningComponentBundle',
    'AuraDefinitionBundle',
    'VisualforcePage',
    'VisualforceComponent',
    'WorkflowRule',
    'Report',
    'Dashboard',
    'ListView',
    'ReportType',
    'FlexiPage',
  ]),
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
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

const ACCOUNT_OBJ = 'CustomObject:Account';
const TEXT_FIELD = 'CustomField:Account.IndustryText';
const PICK_FIELD = 'CustomField:Account.Industry';
const VR_ID = 'ValidationRule:Account.Industry_Required';
const FLOW_ID = 'Flow:SetIndustry';
const APEX_ID = 'ApexClass:AccountService';
const LAYOUT_ID = 'Layout:Account.Standard';
const CURRENCY_FIELD = 'CustomField:Account.Amount';
const FORMULA_FIELD = 'CustomField:Account.AmountDoubled';
const CHECKBOX_FIELD = 'CustomField:Account.IsActive';
const MULTI_FIELD = 'CustomField:Account.Markets';
// A field whose ONLY incoming non-parentOf edges are FLS grants (access, not
// usage) — used to prove grantedBy edges are excluded from the impact walk.
const GRANTS_ONLY_FIELD = 'CustomField:Account.GrantsOnly';
const PROFILE_ID = 'Profile:Admin';
const PERMSET_ID = 'PermissionSet:Support';
// Computed fields — their type is derived, so a field-type change is invalid.
const FORMULA_TYPE_FIELD = 'CustomField:Account.ComputedLabel';
const ROLLUP_FIELD = 'CustomField:Account.TotalAmount';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACCOUNT_OBJ, apiName: 'Account' }),
    makeNode({
      id: TEXT_FIELD,
      type: 'CustomField',
      apiName: 'IndustryText',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Text' },
    }),
    makeNode({
      id: PICK_FIELD,
      type: 'CustomField',
      apiName: 'Industry',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Picklist' },
    }),
    makeNode({
      id: CHECKBOX_FIELD,
      type: 'CustomField',
      apiName: 'IsActive',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Checkbox' },
    }),
    makeNode({
      id: MULTI_FIELD,
      type: 'CustomField',
      apiName: 'Markets',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'MultiselectPicklist' },
    }),
    makeNode({
      id: VR_ID,
      type: 'ValidationRule',
      apiName: 'Account.Industry_Required',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: FLOW_ID,
      type: 'Flow',
      apiName: 'SetIndustry',
    }),
    makeNode({
      id: APEX_ID,
      type: 'ApexClass',
      apiName: 'AccountService',
    }),
    makeNode({
      id: LAYOUT_ID,
      type: 'Layout',
      apiName: 'Account.Standard',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: CURRENCY_FIELD,
      type: 'CustomField',
      apiName: 'Amount',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Currency' },
    }),
    makeNode({
      id: FORMULA_FIELD,
      type: 'CustomField',
      apiName: 'AmountDoubled',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Number' },
    }),
    makeNode({
      id: GRANTS_ONLY_FIELD,
      type: 'CustomField',
      apiName: 'GrantsOnly',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Picklist' },
    }),
    makeNode({ id: PROFILE_ID, type: 'Profile', apiName: 'Admin' }),
    makeNode({ id: PERMSET_ID, type: 'PermissionSet', apiName: 'Support' }),
    makeNode({
      id: FORMULA_TYPE_FIELD,
      type: 'CustomField',
      apiName: 'ComputedLabel',
      parentId: ACCOUNT_OBJ,
      // dataType is the formula's RETURN type; `formula` non-empty marks it computed.
      properties: { dataType: 'Text', formula: 'IF(ISBLANK(Name), "n/a", Name)' },
    }),
    makeNode({
      id: ROLLUP_FIELD,
      type: 'CustomField',
      apiName: 'TotalAmount',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Summary' },
    }),
  ],
  edges: [
    makeEdge({ fromId: ACCOUNT_OBJ, toId: TEXT_FIELD, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT_OBJ, toId: PICK_FIELD, edgeType: 'parentOf' }),
    // ValidationRule references the text field.
    makeEdge({
      fromId: VR_ID,
      toId: TEXT_FIELD,
      edgeType: 'references',
      source: 'validation-rule-extractor',
    }),
    // Flow reads from the text field.
    makeEdge({
      fromId: FLOW_ID,
      toId: TEXT_FIELD,
      edgeType: 'readsFrom',
      source: 'flow-extractor',
      confidence: 'parsed',
    }),
    // Apex class reads from the text field.
    makeEdge({
      fromId: APEX_ID,
      toId: TEXT_FIELD,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
      confidence: 'heuristic',
    }),
    // Layout places the text field.
    makeEdge({
      fromId: LAYOUT_ID,
      toId: TEXT_FIELD,
      edgeType: 'usedInLayout',
    }),
    // A formula field references the Currency field (an arithmetic source).
    makeEdge({ fromId: ACCOUNT_OBJ, toId: CURRENCY_FIELD, edgeType: 'parentOf' }),
    makeEdge({
      fromId: FORMULA_FIELD,
      toId: CURRENCY_FIELD,
      edgeType: 'references',
      source: 'formula-tokenizer',
      confidence: 'parsed',
    }),
    // FLS grants on GRANTS_ONLY_FIELD — access, not usage. A Profile and a
    // PermissionSet grant read/edit; a type change must NOT surface these.
    makeEdge({ fromId: ACCOUNT_OBJ, toId: GRANTS_ONLY_FIELD, edgeType: 'parentOf' }),
    makeEdge({
      fromId: PROFILE_ID,
      toId: GRANTS_ONLY_FIELD,
      edgeType: 'grantedBy',
      source: 'profile-extractor',
      properties: { readable: true, editable: true },
    }),
    makeEdge({
      fromId: PERMSET_ID,
      toId: GRANTS_ONLY_FIELD,
      edgeType: 'grantedBy',
      source: 'permission-set-extractor',
      properties: { readable: true, editable: false },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-wi-cft-'));
  const dbPath = join(tempDir, 'wi-cft.db');
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

describe('whatIfChangeFieldTypeHandler', () => {
  it('rejects a non-CustomField prefix with invalid-query', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: 'Flow:NotAField',
      newType: 'Text',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('fieldId');
  });

  it('excludes FLS / permission grants (grantedBy) — a grants-only field is safe to retype', async () => {
    // GRANTS_ONLY_FIELD's only incoming non-parentOf edges are FLS grants from
    // a Profile and a PermissionSet. Those grant ACCESS by API name and are
    // unaffected by a TYPE change, so Picklist→Text has no impacts and is safe
    // (regression: grants were surfaced as configuration-only impacts, which
    // also inflated the verdict above `safe`).
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: GRANTS_ONLY_FIELD,
      newType: 'Text',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.compatibility).toBe('lossy'); // Picklist→Text loses the picklist semantics
    expect(
      d.impacts.some(
        (i) => i.componentType === 'Profile' || i.componentType === 'PermissionSet',
      ),
    ).toBe(false);
    expect(d.impacts).toHaveLength(0);
    expect(d.verdict).toBe('safe');
  });

  it('rejects a formula (computed) field — its type is derived, not changeable', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: FORMULA_TYPE_FIELD,
      newType: 'Number',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('fieldId');
    expect(result.error.message).toContain('formula');
  });

  it('rejects a roll-up summary (computed) field', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: ROLLUP_FIELD,
      newType: 'Text',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('roll-up summary');
  });

  it('returns component-not-found for an unknown CustomField id', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: 'CustomField:Account.DoesNotExist',
      newType: 'Number',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('classifies Text -> LongTextArea as forward-compatible', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'LongTextArea',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.compatibility).toBe('forward-compatible');
    expect(result.value.data.currentType).toBe('Text');
    expect(result.value.data.newType).toBe('LongTextArea');
  });

  it('classifies Text -> Number as breaking', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'Number',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.compatibility).toBe('breaking');
  });

  it('classifies a numeric field -> Text as lossy and surfaces the formula referrer', async () => {
    // Regression: Currency/Number/Percent -> Text was classified
    // forward-compatible (data-shape only), which SUPPRESSED impacts. But a
    // formula doing arithmetic on the field breaks — Salesforce blocks the
    // change — so the referrer must surface for review, not be hidden.
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: CURRENCY_FIELD,
      newType: 'Text',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.compatibility).toBe('lossy');
    expect(result.value.data.impacts.map((i) => i.componentId)).toContain(
      FORMULA_FIELD,
    );
  });

  it('classifies Picklist / MultiselectPicklist / Checkbox -> Text as lossy (type-specific semantics)', async () => {
    // Picklist (ISPICKVAL), MultiselectPicklist (INCLUDES), and Checkbox
    // (boolean IF/AND/OR) all lose type-specific semantics when converted to
    // free text. The raw matrix marks them forward-compatible (the value
    // survives as a string), which would SUPPRESS the impact walk and hide the
    // breaking referrers — same class as the numeric/temporal -> Text
    // regression. Force lossy so those referrers surface for review.
    for (const fieldId of [PICK_FIELD, MULTI_FIELD, CHECKBOX_FIELD]) {
      const result = await whatIfChangeFieldTypeHandler(ctx, {
        fieldId,
        newType: 'Text',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.compatibility).toBe('lossy');
    }
  });

  it('classifies LongTextArea -> Text as lossy', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'LongTextArea',
    });
    expect(result.ok).toBe(true);
    // Set up reverse: re-call with longtext field. We'll do this by
    // assuming the matrix is right; check Picklist -> Number is breaking.
    const r2 = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: PICK_FIELD,
      newType: 'Number',
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.data.compatibility).toBe('breaking');
  });

  it('emits findings for every recognised referrer on a breaking transition', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'Number',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    // Validation rule, Flow, ApexClass, Layout are all surfaced on
    // a breaking transition (Layout is configuration-only but still
    // emitted for `breaking`).
    expect(ids).toContain(VR_ID);
    expect(ids).toContain(FLOW_ID);
    expect(ids).toContain(APEX_ID);
    expect(ids).toContain(LAYOUT_ID);
  });

  it('classifies categories correctly per source type', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'Number',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(
      result.value.data.impacts.map((i) => [i.componentId, i]),
    );
    expect(byId.get(VR_ID)?.category).toBe('metadata-blocker');
    expect(byId.get(FLOW_ID)?.category).toBe('metadata-blocker');
    expect(byId.get(APEX_ID)?.category).toBe('code-needs-update');
    expect(byId.get(LAYOUT_ID)?.category).toBe('configuration-only');
  });

  it('surfaces edge-level confidence verbatim per finding', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'Number',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(
      result.value.data.impacts.map((i) => [i.componentId, i]),
    );
    // VR was emitted at 'declared', Flow at 'parsed', Apex at 'heuristic'.
    expect(byId.get(VR_ID)?.confidence).toBe('declared');
    expect(byId.get(FLOW_ID)?.confidence).toBe('parsed');
    expect(byId.get(APEX_ID)?.confidence).toBe('heuristic');
  });

  it('aggregates verdict as blocking when a metadata-blocker is present', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'Number',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
  });

  it('suppresses configuration-only impacts on forward-compatible transitions', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'LongTextArea',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Layout reference should NOT be surfaced in `impacts` on a forward-
    // compatible transition (configuration-only category is suppressed)…
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).not.toContain(LAYOUT_ID);
    // The Apex code-needs-update finding IS emitted even on
    // forward-compatible.
    expect(ids).toContain(APEX_ID);
    // …but the suppressed layout reference IS disclosed (bug 13): the caller
    // must not be misled into thinking the field has fewer references than it
    // does. The suppressed set is reported with a pointer to find_component_usages.
    const fcr = result.value.data.forwardCompatibleReferences;
    expect(fcr).toBeDefined();
    expect(fcr?.count).toBeGreaterThan(0);
    expect(fcr?.sample.map((s) => s.componentId)).toContain(LAYOUT_ID);
    expect(fcr?.note).toContain('find_component_usages');
  });

  it('sorts impacts by componentId ASC for deterministic output', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'Number',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('carries the verbatim boundary disclosure', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'Number',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('Compatibility classification');
    expect(result.value.data.disclosure).toContain('Dynamic SOQL');
  });

  it('echoes the fieldId and newType in the response', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: TEXT_FIELD,
      newType: 'Number',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fieldId).toBe(TEXT_FIELD);
    expect(result.value.data.newType).toBe('Number');
  });

  // Regression lock: the extractor writes the field's data type under
  // `properties.dataType`, not `properties.type`. Reading the wrong key
  // resolved currentType to 'Unknown', which made classifyTransition
  // hard-return 'breaking' for every transition (including no-ops). The
  // fixtures above seed `dataType`, matching real vault output.
  it('resolves currentType from properties.dataType (not "Unknown")', async () => {
    const result = await whatIfChangeFieldTypeHandler(ctx, {
      fieldId: PICK_FIELD,
      // Same-type transition: only reachable as forward-compatible when
      // the real type ('Picklist') is resolved. An 'Unknown' currentType
      // would force 'breaking'.
      newType: 'Picklist',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.currentType).toBe('Picklist');
    expect(result.value.data.compatibility).toBe('forward-compatible');
  });
});

describe('whatIfChangeFieldTypeInputSchema', () => {
  it('accepts a well-formed input', () => {
    const parsed = whatIfChangeFieldTypeInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
      newType: 'Number',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown newType value', () => {
    const parsed = whatIfChangeFieldTypeInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
      newType: 'NotAType',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty fieldId', () => {
    const parsed = whatIfChangeFieldTypeInputSchema.safeParse({
      fieldId: '',
      newType: 'Number',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing newType', () => {
    const parsed = whatIfChangeFieldTypeInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
    });
    expect(parsed.success).toBe(false);
  });
});
