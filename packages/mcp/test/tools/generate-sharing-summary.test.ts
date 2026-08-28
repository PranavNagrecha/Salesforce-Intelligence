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
    // REALISTIC shape: the extractor carries the parent object on `parentId`
    // (`CustomObject:Account`) and `apiName` (`Account.AccountRule`) — it does
    // NOT emit `properties.sObjectType`. Keying the summary on that phantom
    // property matched nothing and rendered "(no sharing rules)"
    // (GENERATE-SHARING-SUMMARY-FALSE-EMPTY-SHARING-RULES). These fixtures now
    // mirror the real node, so the matching assertions are genuine guards.
    makeNode({
      id: 'SharingRule:Account.AccountRule',
      type: 'SharingRule',
      apiName: 'Account.AccountRule',
      parentId: 'CustomObject:Account',
      properties: {
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
      parentId: 'CustomObject:Account',
      properties: {
        accessLevel: 'Edit',
        ruleType: 'owner',
      },
    }),
    // RESTRICTION-RULE-MISSING-OBJECT-GRAPH-AND-SHARING-SUMMARY: an active
    // RestrictionRule on Contact must appear in the summary — its parentId ties
    // it to the object (the extractor sets it from <targetEntity>), so the
    // summary surfaces it on the CURRENT vault without a re-extract.
    makeNode({
      id: 'RestrictionRule:Contact.Viewer_Is_Owner',
      type: 'RestrictionRule',
      apiName: 'Contact.Viewer_Is_Owner',
      parentId: 'CustomObject:Contact',
      properties: {
        enforcementType: 'Scoping',
        active: 'true',
        recordFilter: 'OwnerId=$User.Id',
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

  // RESTRICTION-RULE-MISSING-OBJECT-GRAPH-AND-SHARING-SUMMARY guard: the summary
  // previously never mentioned restriction / scoping rules, inventing OWD-only
  // visibility. Assert the Contact section names its active RestrictionRule with
  // enforcement type and record filter.
  it('surfaces active restriction / scoping rules per object', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Contact',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('### Restriction & Scoping Rules');
    expect(body).toContain('Contact.Viewer_Is_Owner');
    expect(body).toContain('Scoping');
    expect(body).toContain('OwnerId=$User.Id');
  });

  // GENERATE-SHARING-SUMMARY-FALSE-EMPTY-SHARING-RULES regression guard: the
  // real extractor never emits `properties.sObjectType` — it carries the parent
  // object on `parentId`/`apiName` only. The seed rules above deliberately OMIT
  // `sObjectType`, so a summary that still keyed on it would render Account with
  // "(no sharing rules)" despite the two SharingRule nodes present. Assert the
  // Account section is NOT the false-empty text and that the rules table renders.
  it('does not invent "(no sharing rules)" for an object whose SharingRule nodes lack sObjectType', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Account.AccountRule');
    expect(body).toContain('Account.ExecRule');
    expect(body).not.toContain('_(no sharing rules)_');
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

  // GENERATE-SHARING-SUMMARY-ALIAS-SKEW guard (componentId): a `componentId`
  // object selector was Zod-stripped, so the call silently fell through to the
  // org-wide scan (Scanned objects: 2, "_(no objectFilter applied)_"). It must
  // now scope identically to `objectFilter: 'Account'`.
  it('scopes to a single object via componentId CustomObject:{api} (was silently org-wide)', async () => {
    const scoped = await generateSharingSummaryHandler(ctx, {
      componentId: 'CustomObject:Account',
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    const body = scoped.value.data.document.body;
    expect(body).toContain('Scanned objects: 1');
    expect(body).toContain('objectFilter: `Account`');
    expect(body).not.toContain('_(no objectFilter applied)_');
    // Equivalent to the objectFilter path: same Overview scope echo.
    const viaFilter = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Account',
    });
    expect(viaFilter.ok).toBe(true);
    if (!viaFilter.ok) return;
    expect(body).toContain('objectFilter: `Account`');
    expect(viaFilter.value.data.document.body).toContain('Scanned objects: 1');
  });

  // GENERATE-SHARING-SUMMARY-ALIAS-SKEW guard (objectApiName disclosure): the
  // `objectApiName` alias DID scope the scan, but the Overview still printed the
  // false "_(no objectFilter applied)_" — the disclosure lied. It must now echo
  // the applied scope honestly.
  it('echoes the applied scope for objectApiName (no longer claims "no objectFilter applied")', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectApiName: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Scanned objects: 1');
    expect(body).toContain('objectFilter: `Account`');
    expect(body).not.toContain('_(no objectFilter applied)_');
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

  // ESCALATED by GENERATE-SHARING-SUMMARY-ANSWERS-A-NONEXISTENT-OBJECT (0.3.3).
  // This test used to assert `ok: true` with a document whose only trace of the
  // miss was the body line "_(no CustomObjects matched the filter)_" — the
  // clean-zero defect itself: a full-looking sharing document, no structured
  // marker, read by a security reviewer as "this object has no sharing". A name
  // the vault knows in NEITHER sense (no node, no inbound edges) is now a named
  // `invalid-query`. Its original point stands and is asserted below: it must
  // NOT be dressed up as a B29 phantom, which is a different claim.
  it('a genuinely-unknown name (no node, no edges) is REFUSED, not called a phantom', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Totally_Unknown__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('Totally_Unknown__c');
    // Not a phantom claim: the refusal is about resolution, not retrieval.
    expect(result.error.message).not.toContain('referenced');
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

// CR-RV12: the OBJECT_SCAN_CAP=50 slice had NO reader-facing disclosure — on a
// >50-object org the summary silently read as complete. A 60-CustomObject
// fixture (past the cap) asserts the scanTruncated field, the "showing first
// N of M" boundary, and the Overview line all disclose the true count.
describe('generateSharingSummaryHandler (OBJECT_SCAN_CAP truncation — CR-RV12)', () => {
  let store: GraphStore;
  let ctx: Context;

  const OBJECT_COUNT = 60;
  const capSeed: ExtractionResult = {
    nodes: Array.from({ length: OBJECT_COUNT }, (_, i) => {
      const api = `Cap_Object_${String(i).padStart(2, '0')}__c`;
      return makeNode({
        id: `CustomObject:${api}`,
        type: 'CustomObject',
        apiName: api,
        label: api,
        properties: { sharingModel: 'Private' },
      });
    }),
    edges: [],
  };

  beforeAll(async () => {
    const built = await makeFreshCtx('object-scan-cap.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [capSeed]);
    if (!imported.ok)
      throw new Error(`cap seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('sets scanTruncated + totalMatchingObjects when the org exceeds OBJECT_SCAN_CAP', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.scanTruncated).toBe(true);
    expect(result.value.data.totalMatchingObjects).toBe(OBJECT_COUNT);
    // Only the first 50 got a full per-object sharing entry built.
    expect(result.value.data.document.frontmatter.componentIds.length).toBeLessThan(
      OBJECT_COUNT,
    );
  });

  it('discloses "showing first N of M" in boundaries — never silently reads as complete', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.document.boundaries.join('\n');
    expect(boundaries).toContain('Object scan capped');
    expect(boundaries).toContain(`first 50 of ${OBJECT_COUNT}`);
  });

  it('discloses the true count in the Overview body line', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.document.body).toContain(`50 of ${OBJECT_COUNT} matching`);
  });

  it('does NOT set scanTruncated when a narrowing objectFilter drops under the cap', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Cap_Object_00__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.scanTruncated).toBeUndefined();
    expect(result.value.data.totalMatchingObjects).toBeUndefined();
    expect(result.value.data.document.boundaries.join('\n')).not.toContain(
      'Object scan capped',
    );
  });
});

// =============================================================================
// UNRESOLVABLE-OBJECT-SCOPE-ANSWERED-ANYWAY (0.3.3) — the `unused_fields_deep`
// family, on an ACCESS question.
//
// `objectFilter` / `objectApiName` / `componentId` narrowed the scan with a raw
// STRING COMPARE (`o.apiName === filter`) against the objects already in hand.
// The vault was never asked whether the named object exists, so an object that
// is not there matched nothing and the tool emitted a complete-looking sharing
// document whose only trace of the miss was the body line
// "_(no CustomObjects matched the filter)_" — no `targetMissing`, no refusal,
// nothing in the structured payload. A security reviewer reads that document as
// "this object has no sharing rules and no grants", about an object never found.
//
// The same string compare made a REAL object typed in the wrong case
// (`account`) produce that identical empty document.
//
// The B29 PHANTOM case is deliberately preserved: an object with inbound edges
// but no retrieved definition is a DIFFERENT, answerable question ("referenced,
// not retrieved") and still returns its `targetMissing` document.
// =============================================================================
describe('generateSharingSummaryHandler — object scope existence (honesty)', () => {
  const ABSENT = 'Zzz_Nonexistent_Object_9x7__c';
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('object-scope-existence.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('REFUSES an objectFilter naming no vault object (never an empty document)', async () => {
    const r = await generateSharingSummaryHandler(ctx, { objectFilter: ABSENT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain(ABSENT);
  });

  it('REFUSES the objectApiName and componentId aliases too', async () => {
    for (const input of [
      { objectApiName: ABSENT },
      { componentId: `CustomObject:${ABSENT}` },
    ]) {
      const r = await generateSharingSummaryHandler(ctx, input);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe('invalid-query');
    }
  });

  it('a REAL object in the wrong case still answers (case-insensitive resolution)', async () => {
    const lower = await generateSharingSummaryHandler(ctx, { objectFilter: 'account' });
    expect(lower.ok).toBe(true);
    if (!lower.ok) return;
    const body = lower.value.data.document.body;
    // Scoped to the one object, and the echo carries the VAULT's casing.
    expect(body).toContain('objectFilter: `Account`');
    expect(body).not.toContain('no CustomObjects matched the filter');
    expect(body).not.toContain('_(no objectFilter applied)_');
  });

  // Regression guard: the org-wide (no filter) document must be unchanged.
  it('the org-wide call is unchanged (no objectFilter applied)', async () => {
    const r = await generateSharingSummaryHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.document.body).toContain('_(no objectFilter applied)_');
    expect(r.value.data.targetMissing).toBeUndefined();
  });
});

// =============================================================================
// FULL-TYPE-SCAN (0.3.3) — the single-page `listNodesByType(limit: 500)` fetch.
//
// SharingRule / RestrictionRule / ScopingRule / Role / CustomObject were each
// fetched with ONE `listNodesByType` call at the graph's HARD `LIST_MAX_LIMIT`
// (500) and NO advancing SQL `OFFSET`. Every node past id-ASC #500 was never
// fetched, so an object whose rules sort late rendered an EMPTY "Sharing Rules"
// table and an EMPTY "Restriction & Scoping Rules" section — read by a security
// reviewer as "OWD is the whole story". None of the file's honesty flags fires
// for that cap: `sharingRuleNotRetrieved` consults the MANIFEST, which
// correctly reports SharingRule as retrieved.
// =============================================================================
describe('generateSharingSummaryHandler — rules past the 500-node id-ASC cap', () => {
  let store: GraphStore;
  let ctx: Context;

  const FILLER_RULES = 504;
  const lateSeed: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'CustomObject:Aaa_Filler__c',
        type: 'CustomObject',
        apiName: 'Aaa_Filler__c',
        label: 'Aaa Filler',
        properties: { sharingModel: 'Private' },
      }),
      makeNode({
        id: 'CustomObject:Zzz_Target__c',
        type: 'CustomObject',
        apiName: 'Zzz_Target__c',
        label: 'Zzz Target',
        properties: { sharingModel: 'Private' },
      }),
      // 504 SharingRules that sort BEFORE the target's rule (id ASC), so the
      // target's rule is node #505 of the type — past the 500 cap.
      ...Array.from({ length: FILLER_RULES }, (_, i) =>
        makeNode({
          id: `SharingRule:Aaa_Filler__c.R${String(i).padStart(4, '0')}`,
          type: 'SharingRule',
          apiName: `Aaa_Filler__c.R${String(i).padStart(4, '0')}`,
          parentId: 'CustomObject:Aaa_Filler__c',
          properties: { accessLevel: 'Read', ruleType: 'owner' },
        }),
      ),
      makeNode({
        id: 'SharingRule:Zzz_Target__c.LateOwnerRule',
        type: 'SharingRule',
        apiName: 'Zzz_Target__c.LateOwnerRule',
        parentId: 'CustomObject:Zzz_Target__c',
        properties: { accessLevel: 'Edit', ruleType: 'owner' },
      }),
      // Same shape for the NARROWING plane: 504 filler RestrictionRules, then
      // the target's restriction rule at #505.
      ...Array.from({ length: FILLER_RULES }, (_, i) =>
        makeNode({
          id: `RestrictionRule:Aaa_Filler__c.RR${String(i).padStart(4, '0')}`,
          type: 'RestrictionRule',
          apiName: `Aaa_Filler__c.RR${String(i).padStart(4, '0')}`,
          parentId: 'CustomObject:Aaa_Filler__c',
          properties: { enforcementType: 'Restrict', active: 'true', recordFilter: 'OwnerId=$User.Id' },
        }),
      ),
      makeNode({
        id: 'RestrictionRule:Zzz_Target__c.LateRestriction',
        type: 'RestrictionRule',
        apiName: 'Zzz_Target__c.LateRestriction',
        parentId: 'CustomObject:Zzz_Target__c',
        properties: { enforcementType: 'Restrict', active: 'true', recordFilter: 'OwnerId=$User.Id' },
      }),
    ],
    edges: [],
  };

  beforeAll(async () => {
    const built = await makeFreshCtx('late-rules.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [lateSeed]);
    if (!imported.ok) throw new Error(`late seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('surfaces a SharingRule that sorts past node 500 (never "(no sharing rules)")', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Zzz_Target__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Zzz_Target__c.LateOwnerRule');
    expect(body).not.toContain('_(no sharing rules)_');
  });

  it('surfaces a RestrictionRule that sorts past node 500 (a NARROWING rule must never vanish)', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Zzz_Target__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.document.body).toContain('Zzz_Target__c.LateRestriction');
  });
});

// =============================================================================
// TRUE-OBJECT-TOTAL (0.3.3) — `totalMatchingObjects` was measured on the
// already-capped 500-node page, so the truncation disclosure's OWN number was
// truncated ("50 of 500" on a 520-object org). And an object sorting past #500
// was never in the page to be filtered to, so a REAL, fully-extracted object
// rendered "_(no CustomObjects matched the filter)_".
// =============================================================================
describe('generateSharingSummaryHandler — objects past the 500-node id-ASC cap', () => {
  let store: GraphStore;
  let ctx: Context;

  const FILLER_OBJECTS = 519;
  const TOTAL_OBJECTS = FILLER_OBJECTS + 1;
  const bigSeed: ExtractionResult = {
    nodes: [
      ...Array.from({ length: FILLER_OBJECTS }, (_, i) => {
        const api = `Cap_Object_${String(i).padStart(3, '0')}__c`;
        return makeNode({
          id: `CustomObject:${api}`,
          type: 'CustomObject',
          apiName: api,
          label: api,
          properties: { sharingModel: 'Private' },
        });
      }),
      makeNode({
        id: 'CustomObject:Zzz_Late_Object__c',
        type: 'CustomObject',
        apiName: 'Zzz_Late_Object__c',
        label: 'Zzz Late Object',
        properties: { sharingModel: 'ControlledByParent' },
      }),
    ],
    edges: [],
  };

  beforeAll(async () => {
    const built = await makeFreshCtx('object-cap-tail.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [bigSeed]);
    if (!imported.ok) throw new Error(`big seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('reports the TRUE matching-object total, not the 500-node page length', async () => {
    const result = await generateSharingSummaryHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.scanTruncated).toBe(true);
    expect(result.value.data.totalMatchingObjects).toBe(TOTAL_OBJECTS);
    expect(result.value.data.document.body).toContain(`50 of ${TOTAL_OBJECTS} matching`);
  });

  it('answers an objectFilter for a REAL object that sorts past node 500', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'Zzz_Late_Object__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).not.toContain('no CustomObjects matched the filter');
    expect(body).not.toContain('never retrieved into the vault');
    expect(body).toContain('(`Zzz_Late_Object__c`)');
    expect(body).toContain('`ControlledByParent`');
  });

  it('a WRONG-CASE name for an object past node 500 still answers (never a confident empty)', async () => {
    const result = await generateSharingSummaryHandler(ctx, {
      objectFilter: 'zzz_late_object__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).not.toContain('no CustomObjects matched the filter');
    expect(body).toContain('(`Zzz_Late_Object__c`)');
  });
});
