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
  generateSharingSummaryHandler,
} from '../../src/tools/generate-sharing-summary.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, Profile: 1, Role: 2, SharingRule: 1 },
  edges: { parentOf: 2, grantedBy: 2 },
  sourceTreeHash: 'sha256:sharing-fixture',
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

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: 'CustomObject:Contact',
      type: 'CustomObject',
      apiName: 'Contact',
      label: 'Contact',
      properties: { sharingModel: 'Read' },
    }),
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
      parentId: 'CustomObject:Account',
    }),
    makeNode({
      id: 'CustomField:Contact.Title__c',
      type: 'CustomField',
      apiName: 'Title__c',
      parentId: 'CustomObject:Contact',
    }),
    makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
    makeNode({ id: 'PermissionSet:Bonus', type: 'PermissionSet', apiName: 'Bonus' }),
    makeNode({
      id: 'Role:Executive',
      type: 'Role',
      apiName: 'Executive',
      properties: {},
    }),
    makeNode({
      id: 'Role:Manager',
      type: 'Role',
      apiName: 'Manager',
      properties: { parentRoleId: 'Role:Executive' },
    }),
    makeNode({
      id: 'SharingRule:Account.AccountRule',
      type: 'SharingRule',
      apiName: 'Account.AccountRule',
      properties: {
        sObjectType: 'Account',
        accessLevel: 'Read',
        ruleType: 'criteria',
        booleanFilter: 'Account.Industry = "Banking"',
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: 'CustomObject:Contact',
      toId: 'CustomField:Contact.Title__c',
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: 'Profile:Admin',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'grantedBy',
    }),
    makeEdge({
      fromId: 'PermissionSet:Bonus',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'grantedBy',
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
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-sharing-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('generateSharingSummaryHandler (empty graph)', () => {
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

  it('returns a minimal valid document with no object sections', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.body).toContain('Sharing Model Summary');
    expect(doc.body).toContain('Scanned objects: 0');
  });

  it('surfaces the role-hierarchy disclosure when no Role nodes exist', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('## Role Hierarchy');
    expect(body).toContain('no Role nodes extracted');
  });
});

describe('generateSharingSummaryHandler (seeded graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('seeded.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('emits per-object H2 sections', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Account');
    expect(body).toContain('Contact');
  });

  it('surfaces each object OWD (sharingModel) verbatim', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Private');
    expect(body).toContain('Read');
  });

  it('matches SharingRules to their sobject', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Account.AccountRule');
  });

  it('surfaces a criteria-based rule type and its predicate (P11-G5)', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // The rules table now carries Type + Criteria columns, so a criteria-based
    // access path is visible with its predicate, not hidden behind a bare name.
    expect(body).toContain('| Rule | Type | Access Level | Criteria |');
    expect(body).toContain('criteria');
    expect(body).toContain('Account.Industry = "Banking"');
  });

  it('tallies profile and permission-set grants from grantedBy edges', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Profiles with grants:** 1');
    expect(body).toContain('PermissionSets with grants:** 1');
  });

  it('renders the role hierarchy mermaid diagram from extracted Role nodes', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('```mermaid');
    expect(body).toContain('Executive');
    expect(body).toContain('Manager');
  });

  it('narrows to a single object via objectFilter', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Account');
    expect(body).toContain('Scanned objects: 1');
    expect(body).toContain("objectFilter: `Account`");
  });

  it('always surfaces the Q125 freshness disclosure in boundaries', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.document.boundaries;
    expect(boundaries.join('\n')).toContain('offline vault');
  });

  it('discloses the UNMODELED G5 sharing dimensions (territory / guest / sharing-set / teams) — absence ≠ none (P12-TEST-sharing-summary-boundary)', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const b = result.value.data.document.boundaries.join('\n');
    expect(b).toMatch(/territory sharing rules/i);
    expect(b).toMatch(/guest .*sharing rules/i);
    expect(b).toMatch(/sharing sets/i);
    expect(b).toMatch(/teams/i);
    expect(b).toMatch(/absence ≠ none|not modeled/i);
  });
});

// B29 (P1-B29-complete): a filtered object that is referenced (inbound edges)
// but whose own CustomObject definition was never retrieved is a PHANTOM. The
// answer must be an honest `targetMissing` ("not retrieved"), never a silent
// "_(no objects matched)_" that a security review would read as "no sharing".
describe('generateSharingSummaryHandler (phantom CustomObject — B29)', () => {
  let store: GraphStore;
  let ctx: Context;

  // A PermissionSet grants object access to Demo_Phantom_Template__c, but that
  // object has NO CustomObject node — it was referenced, not retrieved.
  const phantomSeed: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
        label: 'Account',
        properties: { sharingModel: 'Private' },
      }),
      makeNode({
        id: 'PermissionSet:Demo_Community',
        type: 'PermissionSet',
        apiName: 'Demo_Community',
      }),
    ],
    edges: [
      makeEdge({
        fromId: 'PermissionSet:Demo_Community',
        toId: 'CustomObject:Demo_Phantom_Template__c',
        edgeType: 'grantedBy',
      }),
    ],
  };

  beforeAll(async () => {
    const built = await makeFreshCtx('phantom.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [phantomSeed]);
    if (!imported.ok)
      throw new Error(`phantom seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns a structured targetMissing for a referenced-but-not-retrieved object', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Demo_Phantom_Template__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.targetMissing).toEqual({
      id: 'CustomObject:Demo_Phantom_Template__c',
      referencedBy: 1,
    });
  });

  it('discloses "not retrieved" in the body and boundaries, never silent-empty', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectApiName: 'Demo_Phantom_Template__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.body).toContain('not retrieved');
    expect(doc.body).not.toContain('no CustomObjects matched the filter');
    expect(doc.boundaries.join('\n')).toContain('targetMissing');
  });

  it('does NOT claim targetMissing for a genuinely-unknown name (no node, no edges)', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Totally_Unknown__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.targetMissing).toBeUndefined();
    expect(result.value.data.document.body).toContain(
      'no CustomObjects matched the filter',
    );
  });
});
