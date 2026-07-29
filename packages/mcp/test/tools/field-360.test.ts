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

// GUARD (L2 alias OS / ADMIN-SURFACE-ALIAS-SKEW-CLUSTER): pre-fix the schema
// required `fieldId` and Zod-STRIPPED `componentId: CustomField:…` -> `fieldId:
// Required`. Post-fix the componentId alias resolves to the SAME result as the
// canonical fieldId; disagreeing values -> invalid-query.
describe('field360Handler — componentId ↔ fieldId alias', () => {
  const run = async (raw: unknown) => {
    const parsed = field360InputSchema.safeParse(raw);
    if (!parsed.success) return null;
    return field360Handler(ctx, parsed.data);
  };

  it('natural componentId ≡ canonical fieldId (byte-equal data)', async () => {
    const byField = await run({ fieldId: TARGET });
    const byComponent = await run({ componentId: TARGET });
    expect(byField).not.toBeNull();
    expect(byComponent).not.toBeNull();
    if (!byField?.ok || !byComponent?.ok) return;
    expect(byComponent.value.data.fieldId).toBe(TARGET);
    expect(byComponent.value.data).toEqual(byField.value.data);
  });

  it('disagreeing fieldId / componentId → invalid-query', async () => {
    const parsed = field360InputSchema.safeParse({
      fieldId: TARGET,
      componentId: 'CustomField:Account.Other_Field__c',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await field360Handler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('neither fieldId nor componentId → schema rejects', () => {
    expect(field360InputSchema.safeParse({}).success).toBe(false);
  });
});

// GUARD: a ConditionalContext `readsFrom` edge is a DECLARATIVE blocker (the
// field a Flow entry criterion / workflow-rule criterion / validation-rule
// condition TESTS), not a code read.
//
// FAIL-BEFORE: `classifyIncomingEdge` had no ConditionalContext branch, so the
// edge fell through to `readers` — a section this tool's own module doc
// describes as heuristic Apex/LWC CODE reads — while `safe_to_delete_field`
// classifies the identical edge as {category: 'condition', verdict: 'blocking'}.
// Two tools described one dependency incompatibly. On the reference vault the
// mis-file covered 1,488 edges over 584 distinct fields.
//
// The reroute also moves the edge onto the AUTOMATION risk axis, which is the
// substantive half of the fix: `automations` escalates to `high` at 5, whereas
// `readers` tops out at `medium`. This block pins both the section and the risk
// consequence so a revert cannot pass silently.
describe('field360Handler — ConditionalContext readsFrom lands in automations', () => {
  const CONDITION_FIELD = 'CustomField:Enrolment__c.Verification_Status__c';
  const CONDITION_CONTEXT =
    'ConditionalContext:Flow:Enrolment_Verification.condition-0';
  const CODE_READER = 'ApexClass:EnrolmentReader';

  let dir: string;
  let condStore: GraphStore;
  let condCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-condition-'));
    const opened = await openGraph(join(dir, 'condition.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    condStore = opened.value;
    const imported = await importExtractionResults(condStore, [
      {
        nodes: [
          makeNode({
            id: CONDITION_FIELD,
            type: 'CustomField',
            apiName: 'Verification_Status__c',
            parentId: 'CustomObject:Enrolment__c',
            properties: { dataType: 'Picklist' },
          }),
          makeNode({
            id: 'Flow:Enrolment_Verification',
            type: 'Flow',
            apiName: 'Enrolment_Verification',
          }),
          makeNode({
            id: CONDITION_CONTEXT,
            type: 'ConditionalContext',
            apiName: 'Flow:Enrolment_Verification.condition-0',
            parentId: 'Flow:Enrolment_Verification',
          }),
          makeNode({
            id: CODE_READER,
            type: 'ApexClass',
            apiName: 'EnrolmentReader',
          }),
        ],
        edges: [
          // The real shape emitted by condition-extractor (CONDITION-FIELDREF-
          // EDGES): context -> field, `readsFrom`, confidence inherited from the
          // condition surface, `firerId` naming the Flow.
          makeEdge({
            fromId: CONDITION_CONTEXT,
            toId: CONDITION_FIELD,
            edgeType: 'readsFrom',
            confidence: 'declared',
            source: 'condition-extractor',
            properties: {
              kind: 'flow-decision',
              conditionIndex: 0,
              firerId: 'Flow:Enrolment_Verification',
            },
          }),
          // A genuine CODE read on the same field, so the test proves the
          // ConditionalContext edge MOVED rather than that `readers` emptied.
          makeEdge({
            fromId: CODE_READER,
            toId: CONDITION_FIELD,
            edgeType: 'readsFrom',
            confidence: 'heuristic',
            source: 'apex-scanner',
          }),
        ],
      },
    ]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    condCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: condStore };
  });

  afterAll(async () => {
    await closeGraph(condStore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('files the condition edge under automations and leaves readers code-only', async () => {
    const result = await field360Handler(condCtx, { fieldId: CONDITION_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;

    expect(out.automations?.rows.map((r) => r.componentId)).toEqual([
      CONDITION_CONTEXT,
    ]);
    const row = out.automations?.rows[0];
    expect(row?.componentType).toBe('ConditionalContext');
    expect(row?.edgeType).toBe('readsFrom');
    expect(row?.source).toBe('condition-extractor');
    // The firer is reachable without a second hop — that is what makes the row
    // renderable as "Flow X's entry criterion tests this field".
    expect(row?.properties['firerId']).toBe('Flow:Enrolment_Verification');

    // `readers` keeps ONLY the Apex read.
    expect(out.readers?.rows.map((r) => r.componentId)).toEqual([CODE_READER]);
    expect(out.summary.perSectionCounts['automations']).toBe(1);
    expect(out.summary.perSectionCounts['readers']).toBe(1);
  });

  it('feeds the automation risk axis, not the reader axis', async () => {
    // Pre-fix this field scored `low` / narrow-footprint: one heuristic reader
    // and one mis-filed condition both sat under `readers`, which tolerates 3.
    // A blocking declarative condition must not read as a narrow footprint.
    const result = await field360Handler(condCtx, { fieldId: CONDITION_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.summary.riskLevel).not.toBe('low');
    expect(result.value.data.summary.riskFactors).not.toContain(
      'narrow-footprint',
    );
  });

  it('does not emit the static-SOQL reader caveat for a condition-only field', async () => {
    // A declarative condition is not SOQL, so the dynamic-SOQL blind-spot note
    // would be a boundary about a mechanism this field never touches. Proven on
    // a field whose ONLY incoming edge is the condition.
    const soloDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-cond-solo-'));
    const opened = await openGraph(join(soloDir, 'solo.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const soloStore = opened.value;
    try {
      const imported = await importExtractionResults(soloStore, [
        {
          nodes: [
            makeNode({
              id: 'CustomField:Enrolment__c.Solo_Flag__c',
              type: 'CustomField',
              apiName: 'Solo_Flag__c',
              parentId: 'CustomObject:Enrolment__c',
              properties: { dataType: 'Checkbox' },
            }),
            makeNode({
              id: 'ValidationRule:Enrolment__c.RequireFlag',
              type: 'ValidationRule',
              apiName: 'RequireFlag',
            }),
            makeNode({
              id: 'ConditionalContext:ValidationRule:Enrolment__c.RequireFlag.condition-0',
              type: 'ConditionalContext',
              apiName: 'ValidationRule:Enrolment__c.RequireFlag.condition-0',
              parentId: 'ValidationRule:Enrolment__c.RequireFlag',
            }),
          ],
          edges: [
            makeEdge({
              fromId:
                'ConditionalContext:ValidationRule:Enrolment__c.RequireFlag.condition-0',
              toId: 'CustomField:Enrolment__c.Solo_Flag__c',
              edgeType: 'readsFrom',
              confidence: 'parsed',
              source: 'condition-extractor',
              properties: { kind: 'formula', conditionIndex: 0 },
            }),
          ],
        },
      ]);
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      const result = await field360Handler(
        { vaultRoot: soloDir, manifest: FIXTURE_MANIFEST, graph: soloStore },
        { fieldId: 'CustomField:Enrolment__c.Solo_Flag__c' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const out = result.value.data;
      expect(out.readers?.rows.length).toBe(0);
      expect(out.automations?.rows.length).toBe(1);
      expect(
        out.boundaries.some((b) => b.includes('readers cover static SOQL only')),
      ).toBe(false);
    } finally {
      await closeGraph(soloStore);
      rmSync(soloDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// GUARD (0.3.0): `validates` and `automations` must not BOTH hold one rule.
//
// FAIL-BEFORE: a ValidationRule reaches a field its `errorConditionFormula`
// names by two edges tokenized from that one string — a direct `references`
// edge (filed under `validates`) and a `ConditionalContext` `readsFrom` (filed
// under `automations`). One referrer occupied two sections and both counts, the
// same inflated referrer count `safe_to_delete_field` folds.
//
// The fold is presentation-only. The second block below is the regression this
// fix must NOT ship: dropping the folded rows from `computeRisk`'s automation
// axis would send fields whose blockers are validation-rule conditions to
// `low` / narrow-footprint (224 fields on the reference vault). The existing
// guard higher in this file cannot catch that — its firer is a Flow.
// =============================================================================
describe('field360Handler — validation-rule condition folds into validates', () => {
  const FOLD_FIELD = 'CustomField:Enrolment__c.Fold_Status__c';
  const FOLD_RULE = 'ValidationRule:Enrolment__c.RequireFoldStatus';
  const FOLD_CONTEXT =
    'ConditionalContext:ValidationRule:Enrolment__c.RequireFoldStatus.condition-0';

  // Five DISTINCT validation rules, each reaching the field both ways. Pre-fix
  // this scored `high` on `automations >= 5`; the fold must not change that.
  const RISK_FIELD = 'CustomField:Enrolment__c.Risk_Status__c';

  // NEGATIVE: a Flow that WRITES the field and separately TESTS it. Two facts,
  // two remediations — the fold must not touch them.
  const FLOW_FIELD = 'CustomField:Enrolment__c.Flow_Both__c';
  const FLOW_ID = 'Flow:Enrolment_Router';
  const FLOW_CONTEXT = 'ConditionalContext:Flow:Enrolment_Router.condition-0';

  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  const bothPathEdges = (rule: string, field: string): Edge[] => [
    makeEdge({
      fromId: rule,
      toId: field,
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
      properties: { tokenizedFromField: 'errorConditionFormula' },
    }),
    makeEdge({
      fromId: `ConditionalContext:${rule}.condition-0`,
      toId: field,
      edgeType: 'readsFrom',
      confidence: 'parsed',
      source: 'condition-extractor',
      properties: { kind: 'formula', conditionIndex: 0, firerId: rule },
    }),
  ];

  const bothPathNodes = (rule: string, apiName: string): Node[] => [
    makeNode({ id: rule, type: 'ValidationRule', apiName }),
    makeNode({
      id: `ConditionalContext:${rule}.condition-0`,
      type: 'ConditionalContext',
      apiName: `${apiName}.condition-0`,
      parentId: rule,
    }),
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-fold-'));
    const opened = await openGraph(join(dir, 'fold.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;

    const riskRules = [1, 2, 3, 4, 5].map(
      (n) => `ValidationRule:Enrolment__c.RiskRule_${n}`,
    );
    const imported = await importExtractionResults(store, [
      {
        nodes: [
          makeNode({
            id: FOLD_FIELD,
            type: 'CustomField',
            apiName: 'Fold_Status__c',
            parentId: 'CustomObject:Enrolment__c',
            properties: { dataType: 'Picklist' },
          }),
          makeNode({
            id: RISK_FIELD,
            type: 'CustomField',
            apiName: 'Risk_Status__c',
            parentId: 'CustomObject:Enrolment__c',
            properties: { dataType: 'Picklist' },
          }),
          makeNode({
            id: FLOW_FIELD,
            type: 'CustomField',
            apiName: 'Flow_Both__c',
            parentId: 'CustomObject:Enrolment__c',
            properties: { dataType: 'Picklist' },
          }),
          makeNode({ id: FLOW_ID, type: 'Flow', apiName: 'Enrolment_Router' }),
          makeNode({
            id: FLOW_CONTEXT,
            type: 'ConditionalContext',
            apiName: 'Flow:Enrolment_Router.condition-0',
            parentId: FLOW_ID,
          }),
          ...bothPathNodes(FOLD_RULE, 'RequireFoldStatus'),
          ...riskRules.flatMap((r, i) => bothPathNodes(r, `RiskRule_${i + 1}`)),
        ],
        edges: [
          ...bothPathEdges(FOLD_RULE, FOLD_FIELD),
          ...riskRules.flatMap((r) => bothPathEdges(r, RISK_FIELD)),
          makeEdge({
            fromId: FLOW_ID,
            toId: FLOW_FIELD,
            edgeType: 'writesTo',
            confidence: 'declared',
            source: 'flow-extractor',
          }),
          makeEdge({
            fromId: FLOW_CONTEXT,
            toId: FLOW_FIELD,
            edgeType: 'readsFrom',
            confidence: 'declared',
            source: 'condition-extractor',
            properties: {
              kind: 'flow-decision',
              conditionIndex: 0,
              firerId: FLOW_ID,
            },
          }),
        ],
      },
    ]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the rule once, in validates, and discloses the fold', async () => {
    const result = await field360Handler(ctx, { fieldId: FOLD_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;

    expect(out.validates?.rows.map((r) => r.componentId)).toEqual([FOLD_RULE]);
    // FAIL-BEFORE: this held the ConditionalContext for the SAME rule.
    expect(out.automations?.rows.map((r) => r.componentId)).toEqual([]);
    expect(out.summary.perSectionCounts['validates']).toBe(1);
    expect(out.summary.perSectionCounts['automations']).toBe(0);
    // Collapse by DISCLOSURE — the folded row is named, not silently dropped.
    expect(
      out.boundaries.some((b) => b.includes('FOLDED into `validates`')),
    ).toBe(true);
    // FOLD_CONTEXT is still in the graph; it is simply not a second referrer.
    expect(
      [...(out.validates?.rows ?? []), ...(out.automations?.rows ?? [])].map(
        (r) => r.componentId,
      ),
    ).not.toContain(FOLD_CONTEXT);
  });

  it('keeps the folded rows on the automation RISK axis (no de-escalation)', async () => {
    const result = await field360Handler(ctx, { fieldId: RISK_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    // Presentation: five rules, five rows, zero duplicates.
    expect(out.summary.perSectionCounts['validates']).toBe(5);
    expect(out.summary.perSectionCounts['automations']).toBe(0);
    // Risk: five blocking declarative conditions is still a high-blast-radius
    // delete. A presentation fold must never move a risk level.
    expect(out.summary.riskLevel).toBe('high');
    expect(out.summary.riskFactors).toContain(
      '5-automations-exceeds-threshold-5',
    );
    expect(out.summary.riskFactors).not.toContain('narrow-footprint');
  });

  it('does NOT fold a Flow that writes AND tests the same field', async () => {
    const result = await field360Handler(ctx, { fieldId: FLOW_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.writers?.rows.map((r) => r.componentId)).toEqual([FLOW_ID]);
    expect(out.automations?.rows.map((r) => r.componentId)).toEqual([
      FLOW_CONTEXT,
    ]);
    expect(
      out.boundaries.some((b) => b.includes('FOLDED into `validates`')),
    ).toBe(false);
  });
});

// =============================================================================
// D3-soundness-overclaim — a Flow decision/filter that references a field is
// extracted as a `firesWhen` edge to a ConditionalContext (the field lives on
// the context's `fieldRefs` property), NOT a `readsFrom` onto the field. Before
// the fix field_360 reported readers:0 for a field several Flows filter on. The
// scan reconstructs these as DISCLOSED, heuristic readers so readers > 0.
// =============================================================================

describe('field360Handler: Flow decision/filter reads (readers no longer 0)', () => {
  const FIELD = 'CustomField:Account.Stage__c';
  const FLOW = 'Flow:Account_Stage_Router';
  const CC = 'ConditionalContext:Flow:Account_Stage_Router.condition-0';
  let dir: string;
  let localStore: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-flowcond-'));
    const opened = await openGraph(join(dir, 'flowcond.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    localStore = opened.value;
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
        makeNode({
          id: FIELD,
          type: 'CustomField',
          apiName: 'Stage__c',
          label: 'Stage',
          parentId: 'CustomObject:Account',
          properties: { dataType: 'Picklist' },
        }),
        makeNode({ id: FLOW, type: 'Flow', apiName: 'Account_Stage_Router' }),
        // The synthetic ConditionalContext whose fieldRefs include the field —
        // parent is the Flow. This is what the decision-extractor emits; there
        // is NO readsFrom edge onto the field, only this firesWhen target.
        makeNode({
          id: CC,
          type: 'ConditionalContext',
          apiName: 'Flow:Account_Stage_Router.condition-0',
          parentId: FLOW,
          properties: {
            kind: 'flow-decision',
            expression: 'Stage__c equals Closed',
            fieldRefs: [FIELD],
          },
        }),
      ],
      edges: [
        makeEdge({
          fromId: 'CustomObject:Account',
          toId: FIELD,
          edgeType: 'parentOf',
          confidence: 'declared',
          source: 'extractor:custom-object',
        }),
        // The real firesWhen edge points Flow -> ConditionalContext (NOT the field).
        makeEdge({
          fromId: FLOW,
          toId: CC,
          edgeType: 'firesWhen',
          confidence: 'declared',
          source: 'condition-extractor',
          properties: { kind: 'flow-decision', conditionIndex: 0 },
        }),
      ],
    };
    const imp = await importExtractionResults(localStore, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: localStore };
  });

  afterAll(async () => {
    await closeGraph(localStore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the flow-condition reader in `readers` (> 0), disclosed + heuristic', async () => {
    const result = await field360Handler(localCtx, { fieldId: FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const readers = result.value.data.readers?.rows ?? [];
    // FAIL-BEFORE: readers was 0 — the Flow's decision read carried no readsFrom edge.
    expect(readers.length).toBeGreaterThan(0);
    const flowReader = readers.find((r) => r.componentId === FLOW);
    expect(flowReader).toBeDefined();
    expect(flowReader?.componentType).toBe('Flow');
    expect(flowReader?.confidence).toBe('heuristic');
    expect(flowReader?.source).toContain('flow-condition-reads-scan');
    expect(flowReader?.properties['mechanism']).toBe('flow-decision-filter');
    // Honesty: the reconstruction is disclosed in boundaries.
    expect(
      result.value.data.boundaries.some(
        (b) => b.includes('flow-condition-reads-scan') && /reconstructed/i.test(b),
      ),
    ).toBe(true);
  });

  it('discloses the structurally-unmodeled referrer classes (roll-up / related-list) in boundaries', async () => {
    const result = await field360Handler(localCtx, { fieldId: FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.data.boundaries.some(
        (b) => b.includes('roll-up source coupling') && b.includes('related-list'),
      ),
    ).toBe(true);
  });

  it('does NOT double-count a Flow that already reads the field via a real readsFrom edge', async () => {
    // Add a real readsFrom edge from the SAME flow; the reader must appear ONCE.
    const dupDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-flowcond-dup-'));
    try {
      const opened = await openGraph(join(dupDir, 'dup.db'));
      if (!opened.ok) throw new Error(opened.error.message);
      const dupStore = opened.value;
      const seed: ExtractionResult = {
        nodes: [
          makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
          makeNode({
            id: FIELD,
            type: 'CustomField',
            apiName: 'Stage__c',
            parentId: 'CustomObject:Account',
            properties: { dataType: 'Picklist' },
          }),
          makeNode({ id: FLOW, type: 'Flow', apiName: 'Account_Stage_Router' }),
          makeNode({
            id: CC,
            type: 'ConditionalContext',
            apiName: 'Flow:Account_Stage_Router.condition-0',
            parentId: FLOW,
            properties: { kind: 'flow-decision', fieldRefs: [FIELD] },
          }),
        ],
        edges: [
          // A REAL readsFrom edge from the flow (e.g. a recordLookup on the field).
          makeEdge({
            fromId: FLOW,
            toId: FIELD,
            edgeType: 'readsFrom',
            confidence: 'parsed',
            source: 'flow-extractor',
          }),
        ],
      };
      const imp = await importExtractionResults(dupStore, [seed]);
      if (!imp.ok) throw new Error(imp.error.message);
      const dupCtx: Context = { vaultRoot: dupDir, manifest: FIXTURE_MANIFEST, graph: dupStore };
      const result = await field360Handler(dupCtx, { fieldId: FIELD });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const flowRows = (result.value.data.readers?.rows ?? []).filter(
        (r) => r.componentId === FLOW,
      );
      expect(flowRows.length).toBe(1);
      // The kept row is the REAL readsFrom edge (parsed), not the reconstruction.
      expect(flowRows[0]?.source).toBe('flow-extractor');
      await closeGraph(dupStore);
    } finally {
      rmSync(dupDir, { recursive: true, force: true });
    }
  });

  // D3 residual (silent-truncation fix): the old scan capped at the first 500
  // ConditionalContext nodes. A field whose SOLE flow-condition reader is a CC
  // past position 500 would silently read readers:0 — the exact under-reporting
  // D3 exists to eliminate. The scan now pages ALL ConditionalContext nodes.
  it('finds a flow-condition reader whose ConditionalContext is BEYOND the old 500-node single-page cap', async () => {
    const bigDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-flowcond-tail-'));
    try {
      const opened = await openGraph(join(bigDir, 'tail.db'));
      if (!opened.ok) throw new Error(opened.error.message);
      const bigStore = opened.value;
      const FIELD_T = 'CustomField:Account.TailStage__c';
      const FLOW_T = 'Flow:zzz_Tail_Router';
      const nodes = [
        makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
        makeNode({
          id: FIELD_T,
          type: 'CustomField',
          apiName: 'TailStage__c',
          parentId: 'CustomObject:Account',
          properties: { dataType: 'Picklist' },
        }),
        makeNode({ id: FLOW_T, type: 'Flow', apiName: 'zzz_Tail_Router' }),
      ];
      // 600 dummy flow-parented CCs (empty fieldRefs) whose ids sort BEFORE the
      // target — id-ASC order places the target CC at position 601, past the old
      // single-page 500 cap.
      for (let i = 0; i < 600; i++) {
        const idx = String(i).padStart(4, '0');
        nodes.push(
          makeNode({
            id: `ConditionalContext:Flow:Dummy_${idx}.condition-0`,
            type: 'ConditionalContext',
            apiName: `Flow:Dummy_${idx}.condition-0`,
            parentId: `Flow:Dummy_${idx}`,
            properties: { kind: 'flow-decision', fieldRefs: [] },
          }),
        );
      }
      // The target CC — id 'zzz…' sorts AFTER every 'Dummy_' id → position 601.
      nodes.push(
        makeNode({
          id: 'ConditionalContext:Flow:zzz_Tail_Router.condition-0',
          type: 'ConditionalContext',
          apiName: 'Flow:zzz_Tail_Router.condition-0',
          parentId: FLOW_T,
          properties: { kind: 'flow-decision', fieldRefs: [FIELD_T] },
        }),
      );
      const imp = await importExtractionResults(bigStore, [{ nodes, edges: [] }]);
      if (!imp.ok) throw new Error(imp.error.message);
      const bigCtx: Context = { vaultRoot: bigDir, manifest: FIXTURE_MANIFEST, graph: bigStore };
      const result = await field360Handler(bigCtx, { fieldId: FIELD_T });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // FAIL-BEFORE: a single 500-node page never reached the position-601 CC.
      const flowReader = (result.value.data.readers?.rows ?? []).find((r) => r.componentId === FLOW_T);
      expect(flowReader).toBeDefined();
      expect((result.value.data.readers?.rows ?? []).length).toBeGreaterThan(0);
      // The full scan was NOT truncated (601 << ceiling), so no cap boundary.
      expect(
        result.value.data.boundaries.some((b) => /CAPPED at .* ConditionalContext nodes/.test(b)),
      ).toBe(false);
      await closeGraph(bigStore);
    } finally {
      rmSync(bigDir, { recursive: true, force: true });
    }
  });

  // When the ConditionalContext scan DOES hit its ceiling, the miss must be
  // DISCLOSED (never silent). SFI_CONDITION_SCAN_MAX (ceiling) + SFI_NODE_SCAN_LIMIT
  // (window) are lowered so the truncated path fires without seeding thousands.
  it('discloses a truncation boundary when the ConditionalContext scan hits its ceiling (tail reader disclosed, not silent)', async () => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '2';
    process.env['SFI_CONDITION_SCAN_MAX'] = '2';
    const capDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-360-flowcond-cap-'));
    try {
      const opened = await openGraph(join(capDir, 'cap.db'));
      if (!opened.ok) throw new Error(opened.error.message);
      const capStore = opened.value;
      const FIELD_C = 'CustomField:Account.CapStage__c';
      const FLOW_C = 'Flow:zzz_Cap_Router';
      const nodes = [
        makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
        makeNode({
          id: FIELD_C,
          type: 'CustomField',
          apiName: 'CapStage__c',
          parentId: 'CustomObject:Account',
          properties: { dataType: 'Picklist' },
        }),
        makeNode({ id: FLOW_C, type: 'Flow', apiName: 'zzz_Cap_Router' }),
      ];
      // 4 dummy CCs (sort first) + the target CC (sorts last) = 5 CC nodes; the
      // ceiling of 2 stops the walk before the tail target is reached.
      for (let i = 0; i < 4; i++) {
        nodes.push(
          makeNode({
            id: `ConditionalContext:Flow:Dummy_${i}.condition-0`,
            type: 'ConditionalContext',
            apiName: `Flow:Dummy_${i}.condition-0`,
            parentId: `Flow:Dummy_${i}`,
            properties: { kind: 'flow-decision', fieldRefs: [] },
          }),
        );
      }
      nodes.push(
        makeNode({
          id: 'ConditionalContext:Flow:zzz_Cap_Router.condition-0',
          type: 'ConditionalContext',
          apiName: 'Flow:zzz_Cap_Router.condition-0',
          parentId: FLOW_C,
          properties: { kind: 'flow-decision', fieldRefs: [FIELD_C] },
        }),
      );
      const imp = await importExtractionResults(capStore, [{ nodes, edges: [] }]);
      if (!imp.ok) throw new Error(imp.error.message);
      const capCtx: Context = { vaultRoot: capDir, manifest: FIXTURE_MANIFEST, graph: capStore };
      const result = await field360Handler(capCtx, { fieldId: FIELD_C });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The truncation is DISCLOSED (N of M), so a tail miss is never silent.
      expect(
        result.value.data.boundaries.some(
          (b) => /CAPPED at 2 of 5 ConditionalContext nodes/.test(b) && /INCOMPLETE/.test(b),
        ),
      ).toBe(true);
      // The tail reader (position 5, past the ceiling of 2) is not in readers —
      // but the boundary above discloses it, rather than the old silent miss.
      const flowReader = (result.value.data.readers?.rows ?? []).find((r) => r.componentId === FLOW_C);
      expect(flowReader).toBeUndefined();
      await closeGraph(capStore);
    } finally {
      delete process.env['SFI_NODE_SCAN_LIMIT'];
      delete process.env['SFI_CONDITION_SCAN_MAX'];
      rmSync(capDir, { recursive: true, force: true });
    }
  });
});
