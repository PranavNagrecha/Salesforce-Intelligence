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
  generateDataDictionaryHandler,
} from '../../src/tools/generate-data-dictionary.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 4, ValidationRule: 1 },
  edges: { parentOf: 5, usedInLayout: 1, triggersOn: 1 },
  sourceTreeHash: 'sha256:datadict-fixture',
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

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

const ACCOUNT_ID = 'CustomObject:Account';
const FIELD_INDUSTRY = 'CustomField:Account.Industry__c';
const FIELD_OWNER = 'CustomField:Account.Owner__c';
const FIELD_NOTES = 'CustomField:Account.Notes__c';
const FIELD_SCORE = 'CustomField:Account.Score__c';
const VR_ID = 'ValidationRule:Account.MustHaveIndustry';
const LAYOUT_ID = 'Layout:Account.Default';
const TRIGGER_ID = 'ApexTrigger:AccountTrigger';
const FLOW_ID = 'Flow:AccountFlow';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACCOUNT_ID, type: 'CustomObject', apiName: 'Account', label: 'Account' }),
    makeNode({
      id: FIELD_INDUSTRY,
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: ACCOUNT_ID,
      properties: {
        dataType: 'Picklist',
        description: 'The industry the account operates in.',
        required: false,
      },
    }),
    makeNode({
      id: FIELD_OWNER,
      type: 'CustomField',
      apiName: 'Owner__c',
      label: 'Owner',
      parentId: ACCOUNT_ID,
      properties: {
        dataType: 'Lookup',
        referenceTo: 'User',
        required: true,
      },
    }),
    makeNode({
      id: FIELD_NOTES,
      type: 'CustomField',
      apiName: 'Notes__c',
      label: 'Notes',
      parentId: ACCOUNT_ID,
      properties: {
        dataType: 'LongTextArea',
      },
    }),
    makeNode({
      id: FIELD_SCORE,
      type: 'CustomField',
      apiName: 'Score__c',
      label: 'Score',
      parentId: ACCOUNT_ID,
      properties: {
        dataType: 'Number',
        description: 'Computed account health score.',
        formula: 'Revenue__c / NULLVALUE(Employees__c, 1)',
      },
    }),
    makeNode({
      id: VR_ID,
      type: 'ValidationRule',
      apiName: 'Account.MustHaveIndustry',
      parentId: ACCOUNT_ID,
      properties: { description: 'Industry is required for active accounts' },
    }),
    makeNode({ id: LAYOUT_ID, type: 'Layout', apiName: 'Account.Default' }),
    makeNode({ id: TRIGGER_ID, type: 'ApexTrigger', apiName: 'AccountTrigger' }),
    makeNode({ id: FLOW_ID, type: 'Flow', apiName: 'AccountFlow' }),
  ],
  edges: [
    makeEdge({ fromId: ACCOUNT_ID, toId: FIELD_INDUSTRY, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT_ID, toId: FIELD_OWNER, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT_ID, toId: FIELD_NOTES, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT_ID, toId: FIELD_SCORE, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT_ID, toId: VR_ID, edgeType: 'parentOf' }),
    makeEdge({ fromId: LAYOUT_ID, toId: FIELD_INDUSTRY, edgeType: 'usedInLayout' }),
    makeEdge({ fromId: TRIGGER_ID, toId: ACCOUNT_ID, edgeType: 'triggersOn' }),
    makeEdge({ fromId: FLOW_ID, toId: ACCOUNT_ID, edgeType: 'triggersOn' }),
  ],
};

let tempDir: string;

const makeFreshCtx = async (
  dbName: string,
): Promise<{ ctx: Context; store: GraphStore }> => {
  const opened = await openGraph(join(tempDir, dbName));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  const ctx: Context = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
  return { ctx, store };
};

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-datadict-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('generateDataDictionaryHandler (empty graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('empty.db');
    store = built.store;
    ctx = built.ctx;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns component-not-found when the object id does not exist', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: 'CustomObject:NotARealObject',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    // No inbound edges → the bare, kind-specific message (not the phantom one).
    expect(result.error.message).toMatch(/no CustomObject with id/i);
  });

  it('gives the phantom-aware message for a referenced-but-not-retrieved object (P2-get_component-phantom)', async () => {
    // A managed-package object: no CustomObject node of its own, but referenced
    // by a retrieved component. The not-found message must say "referenced but
    // not retrieved" — the uniform phantom path — not a bare "no object with id"
    // that reads as "this object does not exist".
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-datadict-phantom-'));
    const opened = await openGraph(join(localDir, 'phantom.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: 'ApexClass:EnrollmentService',
            type: 'ApexClass',
            apiName: 'EnrollmentService',
          }),
        ],
        edges: [
          makeEdge({
            fromId: 'ApexClass:EnrollmentService',
            toId: 'CustomObject:Managed_Course_Enrollment__c',
            edgeType: 'references',
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
    const r = await generateDataDictionaryHandler(localCtx, {
      objectId: 'CustomObject:Managed_Course_Enrollment__c',
    });
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toMatch(/referenced by 1 .*never retrieved/is);
  });

  it('returns invalid-query when the objectId prefix is wrong', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: 'CustomField:Account.Industry__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });
});

describe('generateDataDictionaryHandler (seeded graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('seeded.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns a valid GeneratedDocument with required frontmatter', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.frontmatter.title).toContain('Account');
    expect(typeof doc.frontmatter.generatedAt).toBe('string');
    expect(doc.frontmatter.sourceTreeHash).toBe('sha256:datadict-fixture');
    expect(doc.frontmatter.componentIds).toContain(ACCOUNT_ID);
    expect(doc.frontmatter.componentIds).toContain(FIELD_INDUSTRY);
    expect(doc.frontmatter.componentIds).toContain(VR_ID);
  });

  it('accepts a bare object api name (coerced to the CustomObject id) — doc-generator consistency', async () => {
    // generate_sharing_summary takes a bare api name; generate_data_dictionary
    // now coerces one too instead of rejecting it with invalid-query.
    const result = await generateDataDictionaryHandler(ctx, { objectId: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.document.frontmatter.componentIds).toContain(ACCOUNT_ID);
  });

  it('renders the expected H1 + section headings in the body', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toMatch(/^# Account/);
    expect(body).toContain('## Object Overview');
    expect(body).toContain('## Fields');
    expect(body).toContain('## Relationships');
    expect(body).toContain('## Validation Rules');
    expect(body).toContain('## Page Layouts');
    expect(body).toContain('## Related Triggers and Flows');
    expect(body).toContain('## Boundaries');
    expect(body).toContain('## How To Regenerate');
  });

  it('lists every CustomField in the Fields table', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Industry__c');
    expect(body).toContain('Owner__c');
    expect(body).toContain('Notes__c');
  });

  it('annotates formula fields in the Fields table type column', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // Isolate the Fields section so these row-level assertions don't catch
    // the same field id echoed in other sections (frontmatter, relationships).
    const fieldsSection = body.slice(
      body.indexOf('## Fields'),
      body.indexOf('## Relationships'),
    );
    const rows = fieldsSection.split('\n');
    const scoreRow = rows.find((line) => line.includes('Score__c'));
    const industryRow = rows.find((line) => line.includes('Industry__c'));
    // A formula field is read-only/computed — the dictionary must say so in
    // the type cell, not present the bare return type as if it were stored.
    expect(scoreRow).toBeDefined();
    expect(scoreRow).toContain('Number (formula)');
    // A stored (non-formula) field must NOT be annotated.
    expect(industryRow).toBeDefined();
    expect(industryRow).not.toContain('(formula)');
  });

  it('lists relationships (Lookups + MasterDetails) but not other field types', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // Owner__c is a Lookup → User; the table row should include `User`.
    expect(body).toContain('User');
    // The relationships section should include Owner__c by name.
    const relIdx = body.indexOf('## Relationships');
    const valIdx = body.indexOf('## Validation Rules');
    expect(relIdx).toBeLessThan(valIdx);
    const relSection = body.substring(relIdx, valIdx);
    expect(relSection).toContain('Owner__c');
    // Industry__c is a Picklist → must NOT appear in the relationships section.
    expect(relSection).not.toContain('Industry__c');
  });

  it('surfaces incoming usedInLayout edges as Page Layouts entries', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain(LAYOUT_ID);
  });

  it('partitions incoming triggersOn edges into Apex Triggers vs Flows sub-lists', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain(TRIGGER_ID);
    expect(body).toContain(FLOW_ID);
    // Apex Triggers section comes before Flows section.
    const trigIdx = body.indexOf('### Apex Triggers');
    const flowIdx = body.indexOf('### Flows');
    expect(trigIdx).toBeGreaterThan(0);
    expect(flowIdx).toBeGreaterThan(trigIdx);
  });

  it('populates sectionConfidence for every emitted section', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const conf = result.value.data.document.sectionConfidence;
    expect(conf['Object Overview']).toBeDefined();
    expect(conf['Fields']).toBeDefined();
    expect(conf['Relationships']).toBeDefined();
    expect(conf['Validation Rules']).toBeDefined();
    expect(conf['Page Layouts']).toBeDefined();
    expect(conf['Related Triggers and Flows']).toBeDefined();
  });

  it('includes the Q125 freshness disclosure in boundaries', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.document.boundaries;
    expect(boundaries.length).toBeGreaterThan(0);
    const joined = boundaries.join('\n');
    expect(joined).toContain('offline vault');
    expect(joined).toContain('2026-05-27T14:33:08Z');
  });
});
