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
    makeNode({ id: 'Profile:FlsOnly', type: 'Profile', apiName: 'FlsOnly' }),
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
    // CR-CAP-05b: an owner rule shared with Role:Executive AND its subordinates.
    // Role:Manager inheritsFrom Role:Executive, so the summary must name the
    // recipient AND mark "(and its subordinate roles)".
    makeNode({
      id: 'SharingRule:Account.ExecRule',
      type: 'SharingRule',
      apiName: 'Account.ExecRule',
      properties: {
        sObjectType: 'Account',
        accessLevel: 'Edit',
        ruleType: 'owner',
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'parentOf',
    }),
    // CR-CAP-05b: the criteria rule names a Group recipient verbatim; the owner
    // rule shares with Role:Executive carrying the subordinates marker.
    makeEdge({
      fromId: 'SharingRule:Account.AccountRule',
      toId: 'Group:Banking_Team',
      edgeType: 'sharedWith',
    }),
    makeEdge({
      fromId: 'SharingRule:Account.ExecRule',
      toId: 'Role:Executive',
      edgeType: 'sharedWith',
      properties: { inheritance: 'subordinates' },
    }),
    // Role:Manager inheritsFrom Role:Executive (child -> parent).
    makeEdge({
      fromId: 'Role:Manager',
      toId: 'Role:Executive',
      edgeType: 'inheritsFrom',
      source: 'role-extractor',
    }),
    makeEdge({
      fromId: 'CustomObject:Contact',
      toId: 'CustomField:Contact.Title__c',
      edgeType: 'parentOf',
    }),
    // CR-04: OBJECT-level CRUD grants — Profile:Admin reads, PermissionSet:Bonus
    // edits — count toward the object tally. (Previously these pointed at a
    // CustomField, conflating the FLS plane with object access.)
    makeEdge({
      fromId: 'Profile:Admin',
      toId: 'CustomObject:Account',
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
    makeEdge({
      fromId: 'PermissionSet:Bonus',
      toId: 'CustomObject:Account',
      edgeType: 'grantedBy',
      properties: { allowEdit: true },
    }),
    // CR-04 negative: a grantor with ONLY a field-level (FLS) grant and NO
    // object-CRUD edge must contribute 0 to the OBJECT tally. Profile:FlsOnly
    // is FLS-only on a field — it should NOT be counted as an object grantor.
    makeEdge({
      fromId: 'Profile:FlsOnly',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'grantedBy',
      properties: { readable: true },
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
    // The rules table now carries Type + Shared With + Criteria columns, so both
    // the recipient AND a criteria-based predicate are visible (CR-CAP-05b adds
    // the Shared With column to surface recipients that were previously omitted).
    expect(body).toContain('| Rule | Type | Shared With | Access Level | Criteria |');
    expect(body).toContain('criteria');
    expect(body).toContain('Account.Industry = "Banking"');
  });

  // CR-CAP-05b: the summary previously named NO recipient (4-column table). It
  // must now surface the rule's sharedWith recipient verbatim.
  it('CR-CAP-05b: surfaces each rule\'s sharedWith recipient (was omitted)', async () => {
    const result = await generateSharingSummaryHandler(ctx, { objectFilter: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // The criteria rule's Group recipient is named verbatim.
    expect(body).toContain('Banking_Team');
    // The owner rule's Role recipient is named.
    expect(body).toContain('Executive');
  });

  // CR-CAP-05b: a roleAndSubordinates recipient is marked "(and its subordinate
  // roles)" — consuming the SAME expandRoleSubordinates helper as who_can.
  it('CR-CAP-05b: marks a subordinate-role recipient with the subordinate note', async () => {
    const result = await generateSharingSummaryHandler(ctx, { objectFilter: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toMatch(/and its subordinate roles/i);
  });

  it('tallies OBJECT-level CRUD grants and EXCLUDES FLS-only grantors (CR-04)', async () => {
    const result = await generateSharingSummaryHandler(ctx, { objectFilter: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // Account: Profile:Admin (allowRead) + PermissionSet:Bonus (allowEdit) =
    // 1 profile + 1 permset. Profile:FlsOnly has only a CustomField FLS grant
    // and NO object-CRUD edge → it must NOT be counted toward the object tally.
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

// C2 / Systemic #1: when the SharingRule / Role TYPE itself was requested but
// retrieved nothing, an empty per-object rules table and an empty role
// hierarchy mean "not retrieved", NOT "this object has no sharing rules / no
// roles". The graph has an Account object but ZERO SharingRule / Role nodes,
// and the manifest coverage marks both types requested-but-empty.
describe('generateSharingSummaryHandler (SharingRule / Role not retrieved — C2)', () => {
  let store: GraphStore;
  let ctx: Context;

  // Manifest WITH a coverage array so coverageKnown is true; SharingRule and
  // Role are requested-but-empty (retrieved:0) — the C2 repro shape.
  const COVERAGE_GAP_MANIFEST: VaultManifest = {
    ...FIXTURE_MANIFEST,
    coverage: [
      { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false },
      { type: 'SharingRule', requested: true, retrieved: 0, errored: false, neverModeled: false },
      { type: 'Role', requested: true, retrieved: 0, errored: false, neverModeled: false },
    ],
  };

  // Object exists, but NO SharingRule / Role nodes were retrieved.
  const gapSeed: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
        label: 'Account',
        properties: { sharingModel: 'Private' },
      }),
    ],
    edges: [],
  };

  beforeAll(async () => {
    const built = await makeFreshCtx('coverage-gap.db');
    store = built.store;
    ctx = { ...built.ctx, manifest: COVERAGE_GAP_MANIFEST };
    const imported = await importExtractionResults(store, [gapSeed]);
    if (!imported.ok)
      throw new Error(`coverage-gap seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('renders "SharingRule not retrieved" instead of "(no sharing rules)" for an object with zero rules', async () => {
    const result = await generateSharingSummaryHandler(ctx, { objectFilter: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('SharingRule not retrieved');
    expect(body).not.toContain('_(no sharing rules)_');
  });

  it('pushes a SharingRule coverage-gap boundary (not just the UNMODELED dimensions disclosure)', async () => {
    const result = await generateSharingSummaryHandler(ctx, { objectFilter: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const b = result.value.data.document.boundaries.join('\n');
    expect(b).toContain('SharingRule coverage gap');
    expect(b).toMatch(/not checked/i);
  });

  it('renders "Role type not retrieved" and pushes a Role coverage-gap boundary', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.body).toContain('Role type not retrieved');
    expect(doc.body).not.toContain('no Role nodes extracted');
    expect(doc.boundaries.join('\n')).toContain('Role coverage gap');
  });
});

// Regression guard: a pre-v4 manifest with NO coverage array must NOT suddenly
// emit "not retrieved" noise — coverageKnown is false, so the original
// "(no sharing rules)" / "no Role nodes extracted" wording is kept.
describe('generateSharingSummaryHandler (legacy manifest, no coverage array)', () => {
  let store: GraphStore;
  let ctx: Context;

  const legacySeed: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
        label: 'Account',
        properties: { sharingModel: 'Private' },
      }),
    ],
    edges: [],
  };

  beforeAll(async () => {
    const built = await makeFreshCtx('legacy-no-coverage.db');
    store = built.store;
    // FIXTURE_MANIFEST carries NO `coverage` array → coverageKnown false.
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [legacySeed]);
    if (!imported.ok)
      throw new Error(`legacy seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('keeps "(no sharing rules)" and does NOT emit a coverage-gap boundary', async () => {
    const result = await generateSharingSummaryHandler(ctx, { objectFilter: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.body).toContain('_(no sharing rules)_');
    expect(doc.body).not.toContain('SharingRule not retrieved');
    expect(doc.boundaries.join('\n')).not.toContain('SharingRule coverage gap');
  });
});
