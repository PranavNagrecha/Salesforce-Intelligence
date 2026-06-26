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
              id: 'CustomField:Contact.Email_Notes__c',
              type: 'CustomField',
              apiName: 'Email_Notes__c',
              properties: { dataType: 'Text', piiClassification: 'public' },
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
              toId: 'CustomField:Contact.Email_Notes__c',
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
        { fieldId: 'CustomField:Contact.Email_Notes__c' },
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
              id: 'CustomField:Opportunity.Deal_Size__c',
              type: 'CustomField',
              apiName: 'Deal_Size__c',
              properties: {
                dataType: 'Currency',
                piiClassification: 'pii',
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
              toId: 'CustomField:Opportunity.Deal_Size__c',
              edgeType: 'references',
            }),
            makeEdge({
              fromId: 'OutboundMessage:Opportunity.SyncB',
              toId: 'CustomField:Opportunity.Deal_Size__c',
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
        { fieldId: 'CustomField:Opportunity.Deal_Size__c' },
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
