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
const FIELD_REGION = 'CustomField:Account.Region__c';
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
      id: FIELD_REGION,
      type: 'CustomField',
      apiName: 'Region__c',
      label: 'Region',
      parentId: ACCOUNT_ID,
      properties: {
        dataType: 'MasterDetail',
        referenceTo: 'Territory__c',
        required: true,
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
    makeEdge({ fromId: ACCOUNT_ID, toId: FIELD_REGION, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT_ID, toId: VR_ID, edgeType: 'parentOf' }),
    makeEdge({ fromId: LAYOUT_ID, toId: FIELD_INDUSTRY, edgeType: 'usedInLayout' }),
    makeEdge({ fromId: TRIGGER_ID, toId: ACCOUNT_ID, edgeType: 'triggersOn' }),
    makeEdge({ fromId: FLOW_ID, toId: ACCOUNT_ID, edgeType: 'triggersOn' }),
    // Outgoing lookupTo edges (v3.3 first-class relationship tier) —
    // deliberately mirror the CustomField properties above, since that's
    // what `sfi refresh` would extract for Owner__c / Region__c.
    makeEdge({
      fromId: FIELD_OWNER,
      toId: 'CustomObject:User',
      edgeType: 'lookupTo',
      properties: { relationshipType: 'Lookup' },
    }),
    makeEdge({
      fromId: FIELD_REGION,
      toId: 'CustomObject:Territory__c',
      edgeType: 'lookupTo',
      properties: { relationshipType: 'MasterDetail' },
    }),
    // R6-19: INBOUND lookupTo — a Contact.AccountId-style field on a
    // DIFFERENT object pointing AT Account. No CustomField NODE for it is
    // seeded (real orgs frequently omit standard-object fields from the
    // vault) — the edge alone must be enough for the inbound ERD half.
    makeEdge({
      fromId: 'CustomField:Contact.AccountId',
      toId: ACCOUNT_ID,
      edgeType: 'lookupTo',
      properties: { relationshipType: 'MasterDetail' },
    }),
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

  it('R6-19: renders an Entity Relationship Diagram section with a mermaid erDiagram fence', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('## Entity Relationship Diagram');
    expect(body).toContain('```mermaid');
    expect(body).toContain('erDiagram');
  });

  it('R6-19: renders the OUTGOING Lookup (Owner__c -> User) with the zero-or-more connector', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const erdIdx = body.indexOf('## Entity Relationship Diagram');
    const erdSection = body.slice(erdIdx, body.indexOf('## Validation Rules'));
    expect(erdSection).toContain('||--o{');
    expect(erdSection).toContain('Lookup (Owner__c)');
  });

  it('R6-19: renders the OUTGOING Master-Detail (Region__c -> Territory__c) with the one-or-more connector', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const erdIdx = body.indexOf('## Entity Relationship Diagram');
    const erdSection = body.slice(erdIdx, body.indexOf('## Validation Rules'));
    expect(erdSection).toContain('||--|{');
    expect(erdSection).toContain('MasterDetail (Region__c)');
    expect(erdSection).toContain('Territory__c');
  });

  it('R6-19: renders the INBOUND lookupTo from Contact.AccountId even though no Contact CustomField node was seeded', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const erdIdx = body.indexOf('## Entity Relationship Diagram');
    const erdSection = body.slice(erdIdx, body.indexOf('## Validation Rules'));
    expect(erdSection).toContain('Contact');
    expect(erdSection).toContain('AccountId');
  });

  it('R6-19: sanitizes api names into mermaid-safe entity ids (Region__c carries __)', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const erdIdx = body.indexOf('## Entity Relationship Diagram');
    const erdSection = body.slice(erdIdx, body.indexOf('## Validation Rules'));
    const relationshipLine = erdSection
      .split('\n')
      .find((l) => l.includes('||--|{') && l.includes('Territory__c'));
    expect(relationshipLine).toBeDefined();
    // Entity ids (outside the quoted labels) are plain identifiers.
    expect(relationshipLine).toMatch(/^ {4}[A-Za-z_][A-Za-z0-9_]*\["/);
  });

  it('R6-19: always surfaces the ERD scope disclosure in boundaries', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const joined = result.value.data.document.boundaries.join('\n');
    expect(joined).toContain('lookupTo` edges, extraction-time');
  });

  it('R6-19: sectionConfidence includes Entity Relationship Diagram', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.document.sectionConfidence['Entity Relationship Diagram']).toBeDefined();
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

  // R6-21: format: 'csv' — mirrors generate_architecture_overview's format:
  // 'html' plumbing (the document is always returned; csv is additive).
  it('omits csv unless format is csv (default markdown)', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.csv).toBeUndefined();
  });

  it('returns one CSV row per field when format is csv', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
      format: 'csv',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The markdown document is still returned alongside the csv.
    expect(result.value.data.document.body).toContain('## Fields');
    const csv = result.value.data.csv;
    expect(csv).toBeDefined();
    if (csv === undefined) return;
    const lines = csv.trimEnd().split('\n');
    const dataLines = lines.filter((l) => !l.startsWith('#'));
    expect(dataLines[0]).toBe(
      'objectApiName,label,apiName,dataType,formula,description,required',
    );
    // 5 fields seeded on Account: Industry__c, Owner__c, Notes__c, Score__c,
    // and Region__c (added by the R6-19 ERD fixture on the shared graph).
    expect(dataLines.length).toBe(6);
    const joined = dataLines.join('\n');
    expect(joined).toContain('Industry__c');
    expect(joined).toContain('Owner__c');
    expect(joined).toContain('Notes__c');
    expect(joined).toContain('Score__c');
    expect(joined).toContain('Region__c');
  });

  it('marks the formula column true only for the formula field', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
      format: 'csv',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const csv = result.value.data.csv ?? '';
    const scoreRow = csv.split('\n').find((l) => l.includes('Score__c'));
    const industryRow = csv.split('\n').find((l) => l.includes('Industry__c'));
    expect(scoreRow).toContain(',true,');
    expect(industryRow).toContain(',false,');
  });

  it('embeds the object id and freshness disclosure as comment lines', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: ACCOUNT_ID,
      format: 'csv',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const csv = result.value.data.csv ?? '';
    expect(csv).toContain(`# object: ${ACCOUNT_ID}`);
    expect(csv).toContain('# Generated from offline vault on');
  });
});

// R6-21: an object with MANY fields must not overflow the response budget —
// the csv is fitted independently of `document` (rows dropped tail-first with
// a `# truncated: …` comment), never silently corrupted by the global guard's
// blunt slimDataStrings head-cut (the same H7-class risk CR-08/CR-P3-4 guard
// against for markdown/html elsewhere in this tool family).
describe('generateDataDictionaryHandler csv byte budget (R6-21)', () => {
  let store: GraphStore;
  let ctx: Context;
  const prevMax = process.env['SFI_MAX_RESPONSE_BYTES'];
  const MANY_FIELDS_OBJECT = 'CustomObject:BigObject__c';

  beforeAll(async () => {
    // Small enough that 300 verbose field rows overflow, large enough that a
    // TRIMMED csv can still fit alongside the (small) markdown document.
    process.env['SFI_MAX_RESPONSE_BYTES'] = '6000';
    const dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-datadict-bigcsv-'));
    const opened = await openGraph(join(dir, 'big.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
    const nodes: Node[] = [
      makeNode({ id: MANY_FIELDS_OBJECT, type: 'CustomObject', apiName: 'BigObject__c', label: 'Big Object' }),
    ];
    const edges: Edge[] = [];
    for (let i = 0; i < 300; i += 1) {
      const fieldId = `CustomField:BigObject__c.Field_${String(i)}__c`;
      nodes.push(
        makeNode({
          id: fieldId,
          type: 'CustomField',
          apiName: `Field_${String(i)}__c`,
          label: `Field ${String(i)}`,
          parentId: MANY_FIELDS_OBJECT,
          properties: {
            dataType: 'Text',
            description: `A fairly verbose description for field number ${String(i)} that pads out the row.`,
          },
        }),
      );
      edges.push({ fromId: MANY_FIELDS_OBJECT, toId: fieldId, edgeType: 'parentOf', confidence: 'declared', source: 'unit-test', properties: {} });
    }
    const imported = await importExtractionResults(store, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
    if (prevMax === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
    else process.env['SFI_MAX_RESPONSE_BYTES'] = prevMax;
  });

  it('fits the csv under budget by dropping rows tail-first with a truncation comment', async () => {
    const result = await generateDataDictionaryHandler(ctx, {
      objectId: MANY_FIELDS_OBJECT,
      format: 'csv',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const csv = result.value.data.csv;
    expect(csv).toBeDefined();
    if (csv === undefined) return;
    // The honesty footer in the markdown document must still survive.
    expect(result.value.data.document.body).toContain('## Boundaries');
    // The earliest field (kept, tail-dropped) is present; a late one is not.
    expect(csv).toContain('Field_0__c');
    expect(csv).toContain('# truncated: showing');
    // The full envelope (document + csv) must fit under the configured budget.
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({ data: result.value.data, vaultState: result.value.vaultState }),
      'utf8',
    );
    expect(envelopeBytes).toBeLessThanOrEqual(6000);
  });
});

describe('generateDataDictionaryHandler — R6-19 ERD cap behavior', () => {
  const HUB_ID = 'CustomObject:Hub__c';
  const INBOUND_COUNT = 50; // > erd-mermaid.ts's default maxRelationships (40)

  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const opened = await openGraph(join(tempDir, 'erd-cap.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };

    const edges: Edge[] = [];
    for (let i = 0; i < INBOUND_COUNT; i += 1) {
      const suffix = i.toString().padStart(3, '0');
      edges.push(
        makeEdge({
          fromId: `CustomField:Spoke_${suffix}__c.Hub__c`,
          toId: HUB_ID,
          edgeType: 'lookupTo',
          properties: { relationshipType: 'Lookup' },
        }),
      );
    }
    const imported = await importExtractionResults(store, [
      {
        nodes: [makeNode({ id: HUB_ID, type: 'CustomObject', apiName: 'Hub__c', label: 'Hub' })],
        edges,
      },
    ]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('caps the ERD at maxRelationships and discloses the truncation', async () => {
    const result = await generateDataDictionaryHandler(ctx, { objectId: HUB_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const erdIdx = body.indexOf('## Entity Relationship Diagram');
    const nextHeadingIdx = body.indexOf('## ', erdIdx + 1);
    const erdSection = body.slice(erdIdx, nextHeadingIdx);
    const relationshipLines = erdSection.split('\n').filter((l) => l.includes('||--'));
    expect(relationshipLines.length).toBeLessThanOrEqual(40);
    expect(erdSection).toMatch(/capped at 40 of 50/);
  });
});

// R1: a bare "_(no validation rules)_" / "_(no apex triggers)_" etc. is a
// FALSE "none" when the vault's refresh never (successfully) retrieved that
// family — it must read "not checked" instead. Mirrors org-card.ts's identical
// use of `buildEnumerationCoverageCaveatFor` for its own automation counts.
describe('generateDataDictionaryHandler — coverage-aware absence (R1)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const opened = await openGraph(join(tempDir, 'coverage-caveat.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    // The seeded object DOES have a ValidationRule, a Layout ref, a
    // trigger, and a flow (see `seed` above) — this is deliberately NOT an
    // object that has none of these, so a caveat proves the absence-claim
    // check is coverage-driven, not "there happen to be zero rows".
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('discloses a coverage caveat when ValidationRule/Layout/ApexTrigger/Flow were never retrieved', async () => {
    const incompleteCoverageManifest: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
        { type: 'CustomField', requested: true, retrieved: 5, errored: false, neverModeled: false, retrieveConfirmed: true },
        // Never retrieved — no row at all for ValidationRule/Layout/ApexTrigger/Flow
        // is the realistic "refresh errored/skipped this family" shape.
      ],
    } as never;
    const result = await generateDataDictionaryHandler(
      { ...ctx, manifest: incompleteCoverageManifest },
      { objectId: ACCOUNT_ID },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Mirrors the R6-19 ERD-disclosure test above: `boundaries[]` (the
    // frontmatter disclosure array) is the honesty surface these caveats are
    // asserted against — the `## Boundaries` H2 in `body` is a fixed
    // Q125/inherited-confidence/structural footer, unrelated to this caveat.
    const { boundaries } = result.value.data.document;
    expect(boundaries.some((b) => /not checked/i.test(b) && /ValidationRule|Layout|ApexTrigger|Flow/.test(b))).toBe(
      true,
    );
  });

  it('does not disclose a coverage caveat when the families are confirmed fully retrieved', async () => {
    const completeCoverageManifest: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
        { type: 'CustomField', requested: true, retrieved: 5, errored: false, neverModeled: false, retrieveConfirmed: true },
        { type: 'ValidationRule', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
        { type: 'Layout', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
        { type: 'ApexTrigger', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
        { type: 'Flow', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
      ],
    } as never;
    const result = await generateDataDictionaryHandler(
      { ...ctx, manifest: completeCoverageManifest },
      { objectId: ACCOUNT_ID },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { boundaries } = result.value.data.document;
    expect(boundaries.some((b) => /not checked/i.test(b))).toBe(false);
  });

  it('does not disclose a coverage caveat on a legacy pre-v4 vault with no coverage array', async () => {
    // FIXTURE_MANIFEST carries no `coverage` field at all — must not
    // false-flag a legacy vault that predates the coverage feature.
    const result = await generateDataDictionaryHandler(ctx, { objectId: ACCOUNT_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { boundaries } = result.value.data.document;
    expect(boundaries.some((b) => /not checked/i.test(b))).toBe(false);
  });
});
