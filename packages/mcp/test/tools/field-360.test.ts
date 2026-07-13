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
  FIELD_360_DATA_NOT_AVAILABLE,
  FIELD_360_Q165_DISCLOSURE,
  field360Handler,
  field360InputSchema,
} from '../../src/tools/field-360.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '3.0.0',
  refreshedAt: '2026-05-28T12:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:field-360-fixture',
};

// CR-CAP-03: a manifest whose coverage proves Report/Dashboard WERE retrieved
// (retrieved > 0 -> summarizeCoverage status 'complete'). With this manifest a
// field that has no folded usage is confirmed-not-used, so `reports`/`dashboards`
// must drop out of `dataNotAvailable`.
const COVERAGE_COMPLETE_MANIFEST: VaultManifest = {
  ...FIXTURE_MANIFEST,
  components: { Report: 5, Dashboard: 2 },
  coverage: [
    { type: 'Report', requested: true, retrieved: 5, errored: false, neverModeled: false },
    { type: 'Dashboard', requested: true, retrieved: 2, errored: false, neverModeled: false },
  ],
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: 'Default',
  label: null,
  parentId: null,
  sourcePath: 'fixture.xml',
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
  source: 'fixture',
  properties: {},
  ...overrides,
});

// Canonical scenario per PLAN-v3.0 §7 Q156:
//
//   - Account.Customer_Segment__c is the target field.
//   - 1 ValidationRule references it (declared)
//   - 1 formula field references it (parsed via formula-tokenizer)
//   - 1 Apex class writes it (writesTo, heuristic)
//   - 1 Flow writes it (writesTo, declared)
//   - 1 Apex class reads it (readsFrom, heuristic)
//   - 1 Layout places it (usedInLayout, declared)
//   - 1 OutboundMessage references it (integration, declared)
//   - 1 WorkflowRule references it (automation, declared)
//   - 1 EmailTemplate body-merges it (parsed, body-merge role)
const TARGET = 'CustomField:Account.Customer_Segment__c';
// A Lookup (relationship) field — verifies field_360 surfaces `referenceTo`
// (the target object). Mirrors the real Payment__c.Sample_Connection__c, a
// Lookup to hed__Course_Enrollment__c. The graph models no lookup edge, so the
// target is reachable ONLY via this node property.
const LOOKUP_FIELD = 'CustomField:Payment__c.Sample_Connection__c';
// A field whose ONLY incoming edge is an FLS grant (Profile → field). field_360
// composes usage axes, not access, so this grant is counted in
// summary.totalIncomingEdges but placed in NO section; the boundaries MUST
// disclose that (and point to field_access_audit) so the count is explained.
const FLS_FIELD = 'CustomField:Account.FLS_Only_Field__c';
const REPORT_USED_FIELD = 'CustomField:Account.Report_Used__c';
// Finding #36: a field carrying the fold-time capped NAME lists (not just the
// boolean) — used by 2 reports + 1 dashboard, well under the 50-name cap.
const REPORT_NAMED_FIELD = 'CustomField:Account.Report_Named__c';
// Finding #36: a field whose fold-time name list was truncated by the 50-name
// per-field cap — carries `usedInReportsTruncated` with the true total.
const REPORT_TRUNCATED_FIELD = 'CustomField:Account.Report_Truncated__c';
// CR-CAP-02: a ListView that references the TARGET field as a column. The
// ListView->CustomField `references` edge exists in the graph (heuristic, regex
// column extraction) but pre-fix field_360 had no branch for it, so the edge was
// dropped silently (appeared in NO section).
const LIST_VIEW = 'ListView:Account.RecentSegments';
// CR-CAP-13: a field used ONLY as a filter predicate (never a column) and a
// field used as BOTH a column and a filter — to prove the merged-edge
// referenceKind (`filterRef` / `columnAndFilter`) reaches field_360 rows.
const FILTER_ONLY_FIELD = 'CustomField:Account.Filter_Only__c';
const COMBO_FIELD = 'CustomField:Account.Combo__c';
const FILTER_LIST_VIEW = 'ListView:Account.FilteredOnly';
const COMBO_LIST_VIEW = 'ListView:Account.ComboView';
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TARGET,
      type: 'CustomField',
      apiName: 'Customer_Segment__c',
      label: 'Customer Segment',
      parentId: 'CustomObject:Account',
      properties: { dataType: 'Picklist', piiClassification: 'public' },
    }),
    makeNode({
      id: 'ValidationRule:Account.RequireSegment',
      type: 'ValidationRule',
      apiName: 'RequireSegment',
    }),
    makeNode({
      id: 'CustomField:Account.Segment_Display__c',
      type: 'CustomField',
      apiName: 'Segment_Display__c',
      properties: { isFormula: true },
    }),
    makeNode({
      id: 'ApexClass:AccountWriter',
      type: 'ApexClass',
      apiName: 'AccountWriter',
    }),
    makeNode({
      id: 'Flow:AccountSetSegment',
      type: 'Flow',
      apiName: 'AccountSetSegment',
    }),
    makeNode({
      id: 'ApexClass:AccountReader',
      type: 'ApexClass',
      apiName: 'AccountReader',
    }),
    makeNode({
      id: 'Layout:Account-Default',
      type: 'Layout',
      apiName: 'Account-Default',
    }),
    makeNode({
      id: 'OutboundMessage:Account.MarketoSync',
      type: 'OutboundMessage',
      apiName: 'Account.MarketoSync',
    }),
    makeNode({
      id: 'WorkflowRule:Account.NotifyManager',
      type: 'WorkflowRule',
      apiName: 'Account.NotifyManager',
    }),
    makeNode({
      id: 'EmailTemplate:Sales.WelcomeEmail',
      type: 'EmailTemplate',
      apiName: 'Sales.WelcomeEmail',
    }),
    makeNode({
      id: LOOKUP_FIELD,
      type: 'CustomField',
      apiName: 'Sample_Connection__c',
      label: 'Course Connection',
      parentId: 'CustomObject:Payment__c',
      properties: {
        dataType: 'Lookup',
        referenceTo: 'hed__Course_Enrollment__c',
        relationshipName: 'Payments',
      },
    }),
    makeNode({
      id: 'Profile:TestAdmin',
      type: 'Profile',
      apiName: 'TestAdmin',
    }),
    makeNode({
      id: FLS_FIELD,
      type: 'CustomField',
      apiName: 'FLS_Only_Field__c',
      label: 'FLS Only Field',
      parentId: 'CustomObject:Account',
      properties: { dataType: 'Text' },
    }),
    // Field carrying folded `--with-reports` usage — used by a report column.
    makeNode({
      id: REPORT_USED_FIELD,
      type: 'CustomField',
      apiName: 'Report_Used__c',
      label: 'Report Used',
      parentId: 'CustomObject:Account',
      properties: { dataType: 'Text', usedInReport: true },
    }),
    // Finding #36: a field carrying the fold-time capped NAME lists — proves
    // field_360 enumerates WHICH reports/dashboards, not just the boolean.
    makeNode({
      id: REPORT_NAMED_FIELD,
      type: 'CustomField',
      apiName: 'Report_Named__c',
      label: 'Report Named',
      parentId: 'CustomObject:Account',
      properties: {
        dataType: 'Text',
        usedInReport: true,
        usedInReports: ['Exec/Forecast', 'Sales/Pipeline'],
        usedInDashboard: true,
        usedInDashboards: ['Exec/KPIs'],
      },
    }),
    // Finding #36: a field whose fold-time name list was truncated by the
    // per-field 50-name cap — `usedInReportsTruncated` carries the true total.
    makeNode({
      id: REPORT_TRUNCATED_FIELD,
      type: 'CustomField',
      apiName: 'Report_Truncated__c',
      label: 'Report Truncated',
      parentId: 'CustomObject:Account',
      properties: {
        dataType: 'Text',
        usedInReport: true,
        usedInReports: Array.from({ length: 50 }, (_, i) => `Bulk/Report${String(i).padStart(3, '0')}`),
        usedInReportsTruncated: 73,
      },
    }),
    // CR-CAP-02: a ListView that shows the TARGET field as a column.
    makeNode({
      id: LIST_VIEW,
      type: 'ListView',
      apiName: 'RecentSegments',
      label: 'Recent Segments',
      parentId: 'CustomObject:Account',
    }),
    // CR-CAP-13: a filter-only field + a both-column-and-filter field, each with
    // its own ListView, to prove the merged-edge referenceKind reaches rows.
    makeNode({
      id: FILTER_ONLY_FIELD,
      type: 'CustomField',
      apiName: 'Filter_Only__c',
      label: 'Filter Only',
      parentId: 'CustomObject:Account',
      properties: { dataType: 'Text' },
    }),
    makeNode({
      id: COMBO_FIELD,
      type: 'CustomField',
      apiName: 'Combo__c',
      label: 'Combo',
      parentId: 'CustomObject:Account',
      properties: { dataType: 'Text' },
    }),
    makeNode({
      id: FILTER_LIST_VIEW,
      type: 'ListView',
      apiName: 'FilteredOnly',
      parentId: 'CustomObject:Account',
    }),
    makeNode({
      id: COMBO_LIST_VIEW,
      type: 'ListView',
      apiName: 'ComboView',
      parentId: 'CustomObject:Account',
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'Profile:TestAdmin',
      toId: FLS_FIELD,
      edgeType: 'grantedBy',
      confidence: 'declared',
      source: 'profile-extractor',
    }),
    makeEdge({
      fromId: 'ValidationRule:Account.RequireSegment',
      toId: TARGET,
      edgeType: 'references',
      confidence: 'declared',
      source: 'validation-rule-extractor',
    }),
    makeEdge({
      fromId: 'CustomField:Account.Segment_Display__c',
      toId: TARGET,
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
      properties: { tokenizedFromField: 'formula', formulaLength: 32 },
    }),
    makeEdge({
      fromId: 'ApexClass:AccountWriter',
      toId: TARGET,
      edgeType: 'writesTo',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
    makeEdge({
      fromId: 'Flow:AccountSetSegment',
      toId: TARGET,
      edgeType: 'writesTo',
      confidence: 'declared',
      source: 'flow-extractor',
    }),
    makeEdge({
      fromId: 'ApexClass:AccountReader',
      toId: TARGET,
      edgeType: 'readsFrom',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
    makeEdge({
      fromId: 'Layout:Account-Default',
      toId: TARGET,
      edgeType: 'usedInLayout',
      confidence: 'declared',
      source: 'layout-extractor',
    }),
    makeEdge({
      fromId: 'OutboundMessage:Account.MarketoSync',
      toId: TARGET,
      edgeType: 'references',
      confidence: 'declared',
      source: 'workflow-rule-extractor',
    }),
    makeEdge({
      fromId: 'WorkflowRule:Account.NotifyManager',
      toId: TARGET,
      edgeType: 'references',
      confidence: 'declared',
      source: 'workflow-rule-extractor',
    }),
    makeEdge({
      fromId: 'EmailTemplate:Sales.WelcomeEmail',
      toId: TARGET,
      edgeType: 'references',
      confidence: 'parsed',
      source: 'email-template-extractor',
      properties: {
        role: 'body-merge',
        conditional: false,
        mergeContext: '{!Account.Customer_Segment__c}',
      },
    }),
    // CR-CAP-02: ListView column ref → TARGET (heuristic, referenceKind fieldRef).
    makeEdge({
      fromId: LIST_VIEW,
      toId: TARGET,
      edgeType: 'references',
      confidence: 'heuristic',
      source: 'enterprise-metadata-extractor',
      properties: { referenceKind: 'fieldRef' },
    }),
    // CR-CAP-13: a filter-only field surfaces in listViews tagged `filterRef`.
    makeEdge({
      fromId: FILTER_LIST_VIEW,
      toId: FILTER_ONLY_FIELD,
      edgeType: 'references',
      confidence: 'heuristic',
      source: 'enterprise-metadata-extractor',
      properties: { referenceKind: 'filterRef' },
    }),
    // CR-CAP-13: a both-column-and-filter field is ONE merged `columnAndFilter`
    // edge (the extractor never emits two `references` to the same field — the
    // edge PK would collide), so field_360 shows exactly ONE row, not two.
    makeEdge({
      fromId: COMBO_LIST_VIEW,
      toId: COMBO_FIELD,
      edgeType: 'references',
      confidence: 'heuristic',
      source: 'enterprise-metadata-extractor',
      properties: { referenceKind: 'columnAndFilter' },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-'));
  const dbPath = join(tempDir, 'field-360.db');
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

describe('field360Handler', () => {
  it('composes every section with appropriate edges (Q156 happy path)', async () => {
    const result = await field360Handler(ctx, { fieldId: TARGET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    // Identity fields.
    expect(out.fieldId).toBe(TARGET);
    expect(out.parentObjectId).toBe('CustomObject:Account');
    expect(out.fieldType).toBe('Picklist');
    expect(out.isFormula).toBe(false);
    // A Picklist has no relationship target — referenceTo is null, not fabricated.
    expect(out.referenceTo).toBeNull();
    // Per-section content.
    expect(out.validates?.rows.length).toBe(1);
    expect(out.validates?.rows[0]?.componentId).toBe(
      'ValidationRule:Account.RequireSegment',
    );
    expect(out.formulas?.rows.length).toBe(1);
    expect(out.formulas?.rows[0]?.source).toBe('formula-tokenizer');
    expect(out.writers?.rows.length).toBe(2);
    expect(out.readers?.rows.length).toBe(1);
    expect(out.ui?.rows.length).toBe(1);
    expect(out.integrations?.rows.length).toBe(1);
    expect(out.automations?.rows.length).toBe(1);
    expect(out.emails?.rows.length).toBe(1);
    expect(out.emails?.rows[0]?.properties['role']).toBe('body-merge');
  });

  it('CR-CAP-02 — composes ListView column refs into the listViews section', async () => {
    // FAIL-BEFORE: classifyIncomingEdge had no branch for a `references` edge
    // whose source is a ListView, so the edge fell through every case and was
    // dropped silently (the field appeared in no section). After the fix it
    // lands in the new `listViews` section.
    const result = await field360Handler(ctx, { fieldId: TARGET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.listViews?.rows.length).toBe(1);
    const row = out.listViews?.rows[0];
    expect(row?.componentId).toBe(LIST_VIEW);
    expect(row?.componentType).toBe('ListView');
    expect(row?.edgeType).toBe('references');
    expect(row?.confidence).toBe('heuristic');
    expect(row?.source).toBe('enterprise-metadata-extractor');
    expect(row?.properties['referenceKind']).toBe('fieldRef');
    // The per-section count reflects the listViews row too.
    expect(out.summary.perSectionCounts['listViews']).toBe(1);
  });

  it('CR-CAP-13 — a filter-ONLY field surfaces in listViews tagged filterRef', async () => {
    // FAIL-BEFORE: a filter-only field was either tagged `fieldRef`
    // (indistinguishable from a column) or, for a non-field token, minted a
    // phantom; the consumer could not tell a filter from a column. After the
    // extractor change the edge carries `referenceKind: 'filterRef'` and
    // field_360 surfaces it as one labeled row.
    const result = await field360Handler(ctx, { fieldId: FILTER_ONLY_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.listViews?.rows.length).toBe(1);
    const row = out.listViews?.rows[0];
    expect(row?.componentId).toBe(FILTER_LIST_VIEW);
    expect(row?.componentType).toBe('ListView');
    expect(row?.properties['referenceKind']).toBe('filterRef');
    expect(out.summary.perSectionCounts['listViews']).toBe(1);
  });

  it('CR-CAP-13 — a column+filter field is ONE merged columnAndFilter row (no double-count)', async () => {
    // The extractor merges column + filter into ONE edge (the edge PK
    // (fromId,toId,edgeType,source) cannot hold two `references`), so field_360
    // shows exactly ONE listViews row, not two — no double-count.
    const result = await field360Handler(ctx, { fieldId: COMBO_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.listViews?.rows.length).toBe(1);
    expect(out.listViews?.rows[0]?.properties['referenceKind']).toBe('columnAndFilter');
    expect(out.summary.perSectionCounts['listViews']).toBe(1);
  });

  it('CR-CAP-13 — boundary distinguishes filter IDENTITY (composed) from predicate EVALUATION (unmodeled)', async () => {
    const result = await field360Handler(ctx, { fieldId: FILTER_ONLY_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    // Identity IS composed and the boundary names the three referenceKinds.
    expect(
      out.boundaries.some(
        (b) =>
          b.includes('filterRef') &&
          b.includes('columnAndFilter') &&
          b.includes('PREDICATE EVALUATION'),
      ),
    ).toBe(true);
    // Predicate-evaluation gap still disclosed and NOT claimed as available.
    expect(out.dataNotAvailable).toContain('list-view-filters');
  });

  it('CR-CAP-02 — drops the stale "NOT composed" boundary + Q165 list-view clause', async () => {
    // FAIL-BEFORE: boundaries carried the verbatim "list view column refs are
    // extracted as graph edges but are NOT composed into field_360 sections"
    // line, and FIELD_360_Q165_DISCLOSURE claimed list view column refs are NOT
    // composed. Both are now false — the refs ARE composed.
    const result = await field360Handler(ctx, { fieldId: TARGET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { boundaries } = result.value.data;
    expect(
      boundaries.includes(
        'list view column refs are extracted as graph edges but are NOT composed into field_360 sections',
      ),
    ).toBe(false);
    expect(
      FIELD_360_Q165_DISCLOSURE.includes(
        'are NOT composed into field_360 sections',
      ),
    ).toBe(true); // the clause survives, but ONLY for report/dashboard + filter eval
    expect(
      FIELD_360_Q165_DISCLOSURE.includes('List view column refs'),
    ).toBe(false);
    // A present-tense disclosure of the heuristic list-view composition appears.
    expect(
      boundaries.some(
        (b) =>
          b.includes('listViews') && b.includes('heuristic'),
      ),
    ).toBe(true);
  });

  it('CR-CAP-02 — listViews stays empty for a field with no ListView ref (no fabrication)', async () => {
    // PASS-AFTER: a field whose only edges are an FLS grant has no ListView ref,
    // so the listViews section is empty/zero — the fix never fabricates rows.
    const result = await field360Handler(ctx, { fieldId: FLS_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.listViews?.rows.length).toBe(0);
    expect(result.value.data.summary.perSectionCounts['listViews']).toBe(0);
  });

  it('discloses the FLS/permission-grant exclusion when the field has grantedBy edges', async () => {
    const result = await field360Handler(ctx, { fieldId: FLS_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    // The lone grantedBy (FLS) edge is counted in the total but composed into
    // no usage section — without a boundary the "1 incoming edge / 0 rows" gap
    // is unexplained.
    expect(out.summary.totalIncomingEdges).toBe(0);
    expect(out.summary.flsGrantCount).toBe(1);
    expect(out.formulas?.rows.length).toBe(0);
    expect(out.ui?.rows.length).toBe(0);
    expect(out.writers?.rows.length).toBe(0);
    // The boundaries MUST disclose the FLS exclusion + point to field_access_audit.
    expect(out.boundaries.some((b) => b.includes('field_access_audit'))).toBe(
      true,
    );
  });

  it('surfaces folded report/dashboard usage as a positive in-use signal', async () => {
    // Report_Used__c carries the folded `usedInReport` property (no edge). The
    // field IS in use, so the boundaries must say so — not the "not modeled"
    // caveat, and never the old static "report references NOT extracted" line.
    const result = await field360Handler(ctx, { fieldId: REPORT_USED_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { boundaries } = result.value.data;
    expect(
      boundaries.some(
        (b) => b.includes('IS referenced') && b.includes('report column/filter'),
      ),
    ).toBe(true);
    // The misleading static "NOT extracted" report line must be gone.
    expect(
      boundaries.some((b) =>
        b.includes('report column / filter references are NOT extracted'),
      ),
    ).toBe(false);
  });

  it('Finding #36 — enumerates the specific report/dashboard names when the fold provides them', async () => {
    const result = await field360Handler(ctx, { fieldId: REPORT_NAMED_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    // Structured companion field — the "WHICH reports" answer, not just the boolean.
    expect(out.reportUsage).toEqual({
      reportNames: ['Exec/Forecast', 'Sales/Pipeline'],
      dashboardNames: ['Exec/KPIs'],
    });
    // The boundaries prose also names them inline.
    expect(
      out.boundaries.some(
        (b) =>
          b.includes('IS referenced') &&
          b.includes('Sales/Pipeline') &&
          b.includes('Exec/Forecast') &&
          b.includes('Exec/KPIs'),
      ),
    ).toBe(true);
  });

  it('Finding #36 — discloses truncation beyond the per-field 50-name cap', async () => {
    const result = await field360Handler(ctx, { fieldId: REPORT_TRUNCATED_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.reportUsage?.reportNames).toHaveLength(50);
    expect(out.reportUsage?.reportsTruncatedTotal).toBe(73);
    // Dashboards were never referenced for this field — absent, not fabricated.
    expect(out.reportUsage?.dashboardNames).toEqual([]);
    expect(out.reportUsage?.dashboardsTruncatedTotal).toBeUndefined();
    expect(
      out.boundaries.some((b) => b.includes('+23 more beyond the 50-name cap')),
    ).toBe(true);
  });

  it('discloses the --with-reports caveat when a field has no folded report/dashboard usage', async () => {
    const result = await field360Handler(ctx, { fieldId: TARGET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.data.boundaries.some((b) => b.includes('--with-reports')),
    ).toBe(true);
  });

  it('surfaces the referenceTo target for a lookup field (everything = what it points to)', async () => {
    const result = await field360Handler(ctx, { fieldId: LOOKUP_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    // field_360 is "show me EVERYTHING about this field" — for a Lookup that
    // MUST include the target object. fieldType alone says "Lookup", and the
    // graph models no lookup edge, so without referenceTo the target appears
    // nowhere in the output.
    expect(out.fieldType).toBe('Lookup');
    expect(out.referenceTo).toBe('hed__Course_Enrollment__c');
  });

  it('surfaces the verbatim Q165 disclosure and dataNotAvailable (honesty anchor)', async () => {
    const result = await field360Handler(ctx, { fieldId: TARGET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    // The verbatim Q165 string must appear in boundaries.
    expect(out.boundaries).toContain(FIELD_360_Q165_DISCLOSURE);
    // The dataNotAvailable array uses the FIXED order per PLAN-v3.0 §16.
    expect(out.dataNotAvailable).toEqual(FIELD_360_DATA_NOT_AVAILABLE);
    expect(out.dataNotAvailable).toEqual([
      'list-view-filters',
      'reports',
      'dashboards',
    ]);
  });

  it('honors includeSections to narrow the response (Q157)', async () => {
    const result = await field360Handler(ctx, {
      fieldId: TARGET,
      includeSections: ['writers', 'readers', 'summary'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.writers).toBeDefined();
    expect(out.readers).toBeDefined();
    expect(out.summary).toBeDefined();
    // Other sections must be undefined when filtered out.
    expect(out.validates).toBeUndefined();
    expect(out.formulas).toBeUndefined();
    expect(out.ui).toBeUndefined();
    expect(out.integrations).toBeUndefined();
    expect(out.automations).toBeUndefined();
    expect(out.emails).toBeUndefined();
    // But the summary's per-section counts STILL reflect the unfiltered
    // totals — the topology view stays honest.
    expect(out.summary.perSectionCounts['validates']).toBe(1);
    expect(out.summary.perSectionCounts['emails']).toBe(1);
  });

  it('computes a "mixed" overall confidence when sections span tiers', async () => {
    const result = await field360Handler(ctx, { fieldId: TARGET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The fixture spans declared + parsed + heuristic edges — the
    // overall confidence MUST be "mixed".
    expect(result.value.data.confidence).toBe('mixed');
  });

  it('returns invalid-query for non-CustomField prefixes', async () => {
    const result = await field360Handler(ctx, {
      fieldId: 'ApexClass:NotAField',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('fieldId');
  });

  it('returns component-not-found for unknown CustomField ids', async () => {
    const result = await field360Handler(ctx, {
      fieldId: 'CustomField:Account.NoSuchField__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    // No inbound edges → the bare, kind-specific message (not the phantom one).
    expect(result.error.message).toMatch(/no CustomField with id/i);
  });

  it('gives the phantom-aware not-found message for a referenced-but-not-retrieved field (B12)', async () => {
    // Contact.Email is a STANDARD field: no node of its own, but a permission
    // set grants it (the grantedBy edge exists). field_360 cannot synthesize
    // its sections without the definition, but the not-found message must say
    // "referenced but not retrieved" — the consistent phantom path — instead of
    // a bare "no field with id" that reads as "this field does not exist".
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-f360-phantom-'));
    const opened = await openGraph(join(localDir, 'phantom.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({ id: 'PermissionSet:Sales', type: 'PermissionSet', apiName: 'Sales' }),
        ],
        edges: [
          makeEdge({
            fromId: 'PermissionSet:Sales',
            toId: 'CustomField:Contact.Email',
            edgeType: 'grantedBy',
            properties: { readable: true, editable: false, targetMissing: true },
          }),
        ],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) {
      await closeGraph(localStore);
      return;
    }
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await field360Handler(localCtx, { fieldId: 'CustomField:Contact.Email' });
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toMatch(/referenced by 1 .*never retrieved/is);
  });

  it('accepts the short Object.Field form and normalises to canonical', async () => {
    const result = await field360Handler(ctx, {
      fieldId: 'Account.Customer_Segment__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fieldId).toBe(TARGET);
  });

  it('CR-05 — surfaces a WorkflowRule field-update writer exactly once (no double-count)', async () => {
    // The CR-05 extractor change emits a field-level `writesTo` from a
    // WorkflowRule to the field its FieldUpdate sets. field_360 must show
    // that rule ONCE in writers. It is NOT double-counted in automations:
    // the rule's OTHER (pre-existing) edge is a `references` to the
    // WorkflowFieldUpdate scaffolding node — NOT to this field — so the
    // field's inbound walk never sees the rule via `references`. Here we
    // model only the writesTo (the references edge points elsewhere), so
    // writers has exactly one entry and automations is empty.
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-f360-wf-'));
    const opened = await openGraph(join(localDir, 'wf.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const FIELD = 'CustomField:Account.Region__c';
    const RULE = 'WorkflowRule:Account.Set_Region';
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: FIELD,
            type: 'CustomField',
            apiName: 'Region__c',
            label: 'Region',
            parentId: 'CustomObject:Account',
            properties: { dataType: 'Picklist' },
          }),
          makeNode({ id: RULE, type: 'WorkflowRule', apiName: 'Account.Set_Region' }),
        ],
        edges: [
          makeEdge({
            fromId: RULE,
            toId: FIELD,
            edgeType: 'writesTo',
            confidence: 'parsed',
            source: 'workflow-rule-extractor',
            properties: { operation: 'Formula' },
          }),
        ],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) {
      await closeGraph(localStore);
      return;
    }
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await field360Handler(localCtx, { fieldId: FIELD });
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.value.data;
    expect(out.writers?.rows.length).toBe(1);
    expect(out.writers?.rows[0]?.componentId).toBe(RULE);
    expect(out.writers?.rows[0]?.source).toBe('workflow-rule-extractor');
    // Not double-counted as an automation (no references edge to this field).
    expect(out.automations?.rows.length ?? 0).toBe(0);
  });

  it('caps section rows at maxRowsPerSection and reports truncatedAtN', async () => {
    const result = await field360Handler(ctx, {
      fieldId: TARGET,
      maxRowsPerSection: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    // writers had 2 entries; capped at 1 means truncatedAtN reports 2.
    expect(out.writers?.rows.length).toBe(1);
    expect(out.writers?.truncatedAtN).toBe(2);
    expect(out.writers?.count).toBe(2);
    // Sections that fit under the cap show truncatedAtN: null.
    expect(out.validates?.truncatedAtN).toBe(null);
  });
});

describe('field360Handler — CR-CAP-03 coverage-aware analytics disclosure', () => {
  it('not-retrieved manifest keeps reports/dashboards in dataNotAvailable + caveat', async () => {
    // PASS-AFTER guard: the default fixture manifest has no Report/Dashboard
    // coverage -> summarizeCoverage status 'unknown' (not 'complete') -> the
    // families are genuinely not-retrieved, so they STAY in dataNotAvailable and
    // the REPORT_DASHBOARD_USAGE_CAVEAT boundary stays present. Guards against
    // over-eager removal.
    const result = await field360Handler(ctx, { fieldId: TARGET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.dataNotAvailable).toContain('reports');
    expect(out.dataNotAvailable).toContain('dashboards');
    expect(out.dataNotAvailable).toEqual(FIELD_360_DATA_NOT_AVAILABLE);
    // The not-retrieved caveat (distinctive 'outside that cap' text) is present.
    expect(out.boundaries.some((b) => b.includes('outside that cap'))).toBe(true);
  });

  it('retrieved-empty manifest drops reports/dashboards + states confirmed not-used', async () => {
    // FAIL-BEFORE: dataNotAvailable was the static
    // ['list-view-filters','reports','dashboards'] regardless of coverage. With
    // a manifest where Report:5/Dashboard:2 were retrieved (coverage 'complete')
    // and a field with NO folded usage, reports/dashboards are AVAILABLE
    // (confirmed-absent), so they must NOT appear in dataNotAvailable, and a
    // boundary must state reports were retrieved with no reference.
    const completeCtx: Context = { ...ctx, manifest: COVERAGE_COMPLETE_MANIFEST };
    const result = await field360Handler(completeCtx, { fieldId: TARGET });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.dataNotAvailable).not.toContain('reports');
    expect(out.dataNotAvailable).not.toContain('dashboards');
    // list-view-filters is ALWAYS present (predicate eval genuinely unmodeled).
    expect(out.dataNotAvailable).toContain('list-view-filters');
    expect(
      out.boundaries.some(
        (b) =>
          b.includes('WERE retrieved') && b.includes('none reference this field'),
      ),
    ).toBe(true);
    // The not-retrieved CAVEAT must NOT be present when reports were retrieved.
    // (Note: '--with-reports' also appears in the always-present Q165
    // disclosure, so we match the caveat's distinctive 'outside that cap' text.)
    expect(
      out.boundaries.some((b) => b.includes('outside that cap')),
    ).toBe(false);
  });

  it('a folded-used field omits reports from dataNotAvailable even on a not-retrieved manifest', async () => {
    // PASS-AFTER (used signal preserved): REPORT_USED_FIELD carries
    // usedInReport:true. Even with the default not-retrieved manifest, reports
    // is provably AVAILABLE (the field IS used), so 'reports' must NOT appear in
    // dataNotAvailable. The positive in-use boundary stays.
    const result = await field360Handler(ctx, { fieldId: REPORT_USED_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.dataNotAvailable).not.toContain('reports');
    // Dashboard usage is NOT folded on this field and not retrieved -> stays.
    expect(out.dataNotAvailable).toContain('dashboards');
    expect(
      out.boundaries.some(
        (b) => b.includes('IS referenced') && b.includes('report column/filter'),
      ),
    ).toBe(true);
  });
});

describe('field360 risk classification', () => {
  it('flags low risk for narrow-footprint non-PII fields', async () => {
    // Use a separate isolated graph for clean classification.
    const dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-low-'));
    const dbPath = join(dir, 'low.db');
    const opened = await openGraph(dbPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const lowStore = opened.value;
    try {
      const low = await importExtractionResults(lowStore, [
        {
          nodes: [
            makeNode({
              id: 'CustomField:Contact.Internal_Notes__c',
              type: 'CustomField',
              apiName: 'Internal_Notes__c',
              // Genuinely non-PII name — the live recognizer finds no signal.
              properties: { dataType: 'Text' },
            }),
            makeNode({
              id: 'ApexClass:NotesWriter',
              type: 'ApexClass',
              apiName: 'NotesWriter',
            }),
          ],
          edges: [
            makeEdge({
              fromId: 'ApexClass:NotesWriter',
              toId: 'CustomField:Contact.Internal_Notes__c',
              edgeType: 'writesTo',
              confidence: 'heuristic',
              source: 'apex-scanner',
            }),
          ],
        },
      ]);
      expect(low.ok).toBe(true);
      if (!low.ok) return;
      const result = await field360Handler(
        {
          vaultRoot: dir,
          manifest: FIXTURE_MANIFEST,
          graph: lowStore,
        },
        { fieldId: 'CustomField:Contact.Internal_Notes__c' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.summary.riskLevel).toBe('low');
      expect(result.value.data.summary.riskFactors).toContain(
        'narrow-footprint',
      );
    } finally {
      await closeGraph(lowStore);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags high risk when PII meets multiple integrations (Q159 pattern)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-high-'));
    const dbPath = join(dir, 'high.db');
    const opened = await openGraph(dbPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const highStore = opened.value;
    try {
      const high = await importExtractionResults(highStore, [
        {
          nodes: [
            makeNode({
              // Recognizer-classified name (Salary -> sensitive/financial) so
              // the LIVE detectPiiClassification path produces the PII signal —
              // no longer relying on a stamped `piiClassification` property.
              id: 'CustomField:Opportunity.Salary__c',
              type: 'CustomField',
              apiName: 'Salary__c',
              properties: {
                dataType: 'Currency',
              },
            }),
            makeNode({
              id: 'OutboundMessage:Opportunity.SyncA',
              type: 'OutboundMessage',
              apiName: 'Opportunity.SyncA',
            }),
            makeNode({
              id: 'OutboundMessage:Opportunity.SyncB',
              type: 'OutboundMessage',
              apiName: 'Opportunity.SyncB',
            }),
          ],
          edges: [
            makeEdge({
              fromId: 'OutboundMessage:Opportunity.SyncA',
              toId: 'CustomField:Opportunity.Salary__c',
              edgeType: 'references',
            }),
            makeEdge({
              fromId: 'OutboundMessage:Opportunity.SyncB',
              toId: 'CustomField:Opportunity.Salary__c',
              edgeType: 'references',
            }),
          ],
        },
      ]);
      expect(high.ok).toBe(true);
      if (!high.ok) return;
      const result = await field360Handler(
        {
          vaultRoot: dir,
          manifest: FIXTURE_MANIFEST,
          graph: highStore,
        },
        { fieldId: 'CustomField:Opportunity.Salary__c' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const summary = result.value.data.summary;
      expect(summary.riskLevel).toBe('high');
      // The specific risk factors MUST be enumerated, not bare.
      expect(summary.riskFactors).toContain('pii-classified');
      expect(summary.riskFactors).toContain(
        '2-integrations-exceeds-threshold-2',
      );
      expect(summary.riskFactors).toContain('pii-with-integrations');
    } finally {
      await closeGraph(highStore);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // GROUP-A PII-safety: detectIsPii must run the LIVE recognizer
  // (detectPiiClassification) rather than reading a `piiClassification`
  // property that nothing ever stamps. An EncryptedText field with NO
  // such property must still escalate as PII.
  it('escalates an EncryptedText field with no stamped property via the live recognizer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-enc-'));
    const dbPath = join(dir, 'enc.db');
    const opened = await openGraph(dbPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const store = opened.value;
    try {
      const imported = await importExtractionResults(store, [
        {
          nodes: [
            makeNode({
              id: 'CustomField:Contact.Secret__c',
              type: 'CustomField',
              apiName: 'Secret__c',
              // DELIBERATELY no `piiClassification` property — the old
              // dead-code path would read undefined and never escalate.
              properties: { dataType: 'EncryptedText' },
            }),
          ],
          edges: [],
        },
      ]);
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      const result = await field360Handler(
        { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store },
        { fieldId: 'CustomField:Contact.Secret__c' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.summary.riskLevel).toBe('high');
      expect(result.value.data.summary.riskFactors).toContain('pii-classified');
    } finally {
      await closeGraph(store);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('field360Handler — CR-22 section cursor', () => {
  it('whole-fits omits cursor block (byte-identical golden)', async () => {
    const r = await field360Handler(ctx, { fieldId: TARGET });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('nextCursor' in r.value.data).toBe(false);
    expect('pageInfo' in r.value.data).toBe(false);
    expect('otherSections' in r.value.data).toBe(false);
    // writers has 2 rows (an Apex class + a Flow); both present whole-fits.
    expect(r.value.data.writers?.rows.length).toBe(2);
    expect(r.value.data.writers?.truncatedAtN).toBeNull();
  });

  it('paging an over-cap section emits nextCursor + discloses the rest', async () => {
    const r = await field360Handler(ctx, { fieldId: TARGET, maxRowsPerSection: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // writers (2 rows) is the largest populated section → designated + paged.
    expect(r.value.data.designatedList).toBe('writers');
    expect(r.value.data.nextCursor).toBeDefined();
    expect(r.value.data.writers?.rows.length).toBe(1);
    expect(r.value.data.writers?.count).toBe(2);
    const others = r.value.data.otherSections ?? [];
    expect(others.some((s) => s.listId === 'readers')).toBe(true);
  });

  it('resume advances the designated section with no dup/skip', async () => {
    const p1 = await field360Handler(ctx, { fieldId: TARGET, maxRowsPerSection: 1 });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const w1 = p1.value.data.writers?.rows ?? [];
    const cursor = p1.value.data.nextCursor!;
    const p2 = await field360Handler(ctx, { fieldId: TARGET, maxRowsPerSection: 1, cursor });
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    const w2 = p2.value.data.writers?.rows ?? [];
    const ids = [...w1, ...w2].map((row) => `${row.componentId}|${row.edgeType}|${row.source}`);
    expect(new Set(ids).size).toBe(ids.length); // no dup
    expect(ids.length).toBe(2); // both writers walked
  });

  it('rejects a cursor minted for a different field / includeSections', async () => {
    const p1 = await field360Handler(ctx, { fieldId: TARGET, maxRowsPerSection: 1 });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const cursor = p1.value.data.nextCursor!;
    const stale = await field360Handler(ctx, {
      fieldId: TARGET,
      maxRowsPerSection: 1,
      cursor,
      includeSections: ['writers'],
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.kind).toBe('invalid-query');
  });
});

describe('field360InputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = field360InputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects maxRowsPerSection above the hard cap', () => {
    const parsed = field360InputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      maxRowsPerSection: 201,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown groupBy value', () => {
    const parsed = field360InputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      groupBy: 'nope',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown includeSections entry', () => {
    const parsed = field360InputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      includeSections: ['not-a-section'],
    });
    expect(parsed.success).toBe(false);
  });
});
