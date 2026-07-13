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
  canonicalJson,
  compareComponentsHandler,
  compareComponentsInputSchema,
} from '../../src/tools/compare-components.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. */
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

/** Default edge-shape helper. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed: two identical ApexClasses, same id (smoke test for same-component case).
// Single ApexClass used by the "same id" test.
// =============================================================================

const APEX_BASE = 'ApexClass:BaseService';
const apexBaseSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: APEX_BASE,
      type: 'ApexClass',
      apiName: 'BaseService',
      label: 'Base Service',
      properties: { isTest: false, modifiers: ['public', 'with sharing'] },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed: two ApexClasses with different properties + different outgoing edges,
// for the property + edge diff test.
// =============================================================================

const APEX_OLD = 'ApexClass:OldService';
const APEX_NEW = 'ApexClass:NewService';
const FIELD_TARGET = 'CustomField:Account.Industry__c';
const FIELD_OTHER = 'CustomField:Account.Region__c';
const apexPairSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: APEX_OLD,
      type: 'ApexClass',
      apiName: 'OldService',
      label: 'Old Service',
      properties: { isTest: false, modifiers: ['public'] },
    }),
    makeNode({
      id: APEX_NEW,
      type: 'ApexClass',
      apiName: 'NewService',
      label: 'New Service',
      properties: { isTest: false, modifiers: ['public', 'with sharing'] },
    }),
    makeNode({ id: FIELD_TARGET, type: 'CustomField', apiName: 'Industry__c' }),
    makeNode({ id: FIELD_OTHER, type: 'CustomField', apiName: 'Region__c' }),
  ],
  edges: [
    // Both classes read FIELD_TARGET — shared outgoing edge.
    makeEdge({
      fromId: APEX_OLD,
      toId: FIELD_TARGET,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
    }),
    makeEdge({
      fromId: APEX_NEW,
      toId: FIELD_TARGET,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
    }),
    // Only the new class also reads FIELD_OTHER — b-only outgoing edge.
    makeEdge({
      fromId: APEX_NEW,
      toId: FIELD_OTHER,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
    }),
  ],
};

// =============================================================================
// Seed: a Profile + PermissionSet for the cross-type test.
// =============================================================================

const PROFILE_A = 'Profile:SalesUser';
const PERMSET_B = 'PermissionSet:SalesExtras';
const crossTypeSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PROFILE_A,
      type: 'Profile',
      apiName: 'SalesUser',
      label: 'Sales User',
      properties: {
        fieldPermissions: { 'Account.Industry__c': { read: true, edit: false } },
        userPermissions: ['ApiEnabled', 'ViewSetup'],
      },
    }),
    makeNode({
      id: PERMSET_B,
      type: 'PermissionSet',
      apiName: 'SalesExtras',
      label: 'Sales Extras',
      properties: {
        fieldPermissions: { 'Account.Industry__c': { read: true, edit: true } },
        userPermissions: ['ApiEnabled'],
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed: a third pair where only the ids differ (everything else identical).
// =============================================================================

const FIELD_A = 'CustomField:Account.IdentityA__c';
const FIELD_B = 'CustomField:Account.IdentityB__c';
const identityOnlySeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FIELD_A,
      type: 'CustomField',
      apiName: 'IdentityA__c',
      label: 'Identity Field',
      properties: { dataType: 'Text', length: 255 },
    }),
    makeNode({
      id: FIELD_B,
      type: 'CustomField',
      apiName: 'IdentityB__c',
      label: 'Identity Field',
      properties: { dataType: 'Text', length: 255 },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed: a field with shared and one-sided incoming edges.
// =============================================================================

const FIELD_INCOMING_A = 'CustomField:Account.IncomingA__c';
const FIELD_INCOMING_B = 'CustomField:Account.IncomingB__c';
const FLOW_SHARED = 'Flow:SharedReader';
const FLOW_A_ONLY = 'Flow:UsesAOnly';
const incomingEdgesSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FIELD_INCOMING_A,
      type: 'CustomField',
      apiName: 'IncomingA__c',
    }),
    makeNode({
      id: FIELD_INCOMING_B,
      type: 'CustomField',
      apiName: 'IncomingB__c',
    }),
    makeNode({ id: FLOW_SHARED, type: 'Flow', apiName: 'SharedReader' }),
    makeNode({ id: FLOW_A_ONLY, type: 'Flow', apiName: 'UsesAOnly' }),
  ],
  edges: [
    // FLOW_SHARED reads both fields — shared incoming edge.
    makeEdge({
      fromId: FLOW_SHARED,
      toId: FIELD_INCOMING_A,
      edgeType: 'readsFrom',
      source: 'flow-extractor',
    }),
    makeEdge({
      fromId: FLOW_SHARED,
      toId: FIELD_INCOMING_B,
      edgeType: 'readsFrom',
      source: 'flow-extractor',
    }),
    // FLOW_A_ONLY reads only A — a-only incoming edge.
    makeEdge({
      fromId: FLOW_A_ONLY,
      toId: FIELD_INCOMING_A,
      edgeType: 'readsFrom',
      source: 'flow-extractor',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-compare-components-'));
  const dbPath = join(tempDir, 'compare-components.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    apexBaseSeed,
    apexPairSeed,
    crossTypeSeed,
    identityOnlySeed,
    incomingEdgesSeed,
  ]);
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

describe('compareComponentsHandler — same id on both sides', () => {
  it('reports every field as same and no edge diffs when the same component is compared with itself', async () => {
    const result = await compareComponentsHandler(ctx, {
      idA: APEX_BASE,
      idB: APEX_BASE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.typesMatch).toBe(true);
    expect(d.idA).toBe(APEX_BASE);
    expect(d.idB).toBe(APEX_BASE);
    // Every fieldDiff must have status: 'same' since both sides resolve
    // to the same node row.
    for (const fd of d.fieldDiffs) {
      expect(fd.status).toBe('same');
    }
    expect(d.edgeDiffs).toEqual([]);
  });
});

describe('compareComponentsHandler — different ApexClasses', () => {
  it('reports property differences in fieldDiffs and edge differences in edgeDiffs', async () => {
    const result = await compareComponentsHandler(ctx, {
      idA: APEX_OLD,
      idB: APEX_NEW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.typesMatch).toBe(true);
    // apiName + label differ.
    const apiNameDiff = d.fieldDiffs.find((fd) => fd.path === 'apiName');
    expect(apiNameDiff?.status).toBe('different');
    expect(apiNameDiff?.valueA).toBe('OldService');
    expect(apiNameDiff?.valueB).toBe('NewService');
    const labelDiff = d.fieldDiffs.find((fd) => fd.path === 'label');
    expect(labelDiff?.status).toBe('different');
    // properties.modifiers differs (['public'] vs ['public', 'with sharing']).
    const modifiersDiff = d.fieldDiffs.find(
      (fd) => fd.path === 'properties.modifiers',
    );
    expect(modifiersDiff?.status).toBe('different');
    // properties.isTest is same on both sides.
    const isTestDiff = d.fieldDiffs.find(
      (fd) => fd.path === 'properties.isTest',
    );
    expect(isTestDiff?.status).toBe('same');

    // Edge diffs: shared readsFrom to FIELD_TARGET (inA: true, inB: true)
    // plus a b-only readsFrom to FIELD_OTHER (inA: false, inB: true).
    const sharedEdge = d.edgeDiffs.find(
      (ed) => ed.direction === 'outgoing' && ed.target === FIELD_TARGET,
    );
    expect(sharedEdge?.inA).toBe(true);
    expect(sharedEdge?.inB).toBe(true);
    const bOnlyEdge = d.edgeDiffs.find(
      (ed) => ed.direction === 'outgoing' && ed.target === FIELD_OTHER,
    );
    expect(bOnlyEdge?.inA).toBe(false);
    expect(bOnlyEdge?.inB).toBe(true);
  });
});

describe('compareComponentsHandler — cross-type comparison', () => {
  it('allows comparing a Profile with a PermissionSet and reports typesMatch: false', async () => {
    const result = await compareComponentsHandler(ctx, {
      idA: PROFILE_A,
      idB: PERMSET_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.typesMatch).toBe(false);
    // The `type` field difference must be surfaced explicitly.
    const typeDiff = d.fieldDiffs.find((fd) => fd.path === 'type');
    expect(typeDiff?.status).toBe('different');
    expect(typeDiff?.valueA).toBe('Profile');
    expect(typeDiff?.valueB).toBe('PermissionSet');
    // The flattened fieldPermissions map differs at the Industry__c key
    // because the Profile has `edit: false` and the PermSet has `edit: true`.
    const fpDiff = d.fieldDiffs.find(
      (fd) => fd.path === 'properties.fieldPermissions.Account.Industry__c',
    );
    // Two-level-deep flattening should surface the value diff. (The
    // path uses a literal dot in Account.Industry__c — verify the
    // status is `different` regardless of the precise key separator.)
    expect(fpDiff?.status).toBe('different');
  });
});

describe('compareComponentsHandler — identical metadata, different ids', () => {
  it('reports apiName as different but all other shared properties as same', async () => {
    const result = await compareComponentsHandler(ctx, {
      idA: FIELD_A,
      idB: FIELD_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.typesMatch).toBe(true);
    // apiName must differ (IdentityA__c vs IdentityB__c).
    const apiNameDiff = d.fieldDiffs.find((fd) => fd.path === 'apiName');
    expect(apiNameDiff?.status).toBe('different');
    // label is the same string on both sides.
    const labelDiff = d.fieldDiffs.find((fd) => fd.path === 'label');
    expect(labelDiff?.status).toBe('same');
    // properties.dataType and properties.length are both same.
    expect(
      d.fieldDiffs.find((fd) => fd.path === 'properties.dataType')?.status,
    ).toBe('same');
    expect(
      d.fieldDiffs.find((fd) => fd.path === 'properties.length')?.status,
    ).toBe('same');
  });
});

describe('compareComponentsHandler — unknown component', () => {
  it('returns component-not-found when idA does not exist in the graph', async () => {
    const result = await compareComponentsHandler(ctx, {
      idA: 'CustomObject:GhostA',
      idB: APEX_BASE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('CustomObject:GhostA');
  });

  it('returns component-not-found when idB does not exist in the graph', async () => {
    const result = await compareComponentsHandler(ctx, {
      idA: APEX_BASE,
      idB: 'CustomObject:GhostB',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('CustomObject:GhostB');
  });
});

describe('compareComponentsHandler — incoming edges', () => {
  it('surfaces shared and one-sided incoming edges with the right inA/inB flags', async () => {
    const result = await compareComponentsHandler(ctx, {
      idA: FIELD_INCOMING_A,
      idB: FIELD_INCOMING_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // The shared incoming edge from FLOW_SHARED must show inA + inB.
    const sharedIncoming = d.edgeDiffs.find(
      (ed) => ed.direction === 'incoming' && ed.target === FLOW_SHARED,
    );
    expect(sharedIncoming?.inA).toBe(true);
    expect(sharedIncoming?.inB).toBe(true);
    // FLOW_A_ONLY reads only A; inA=true, inB=false.
    const aOnlyIncoming = d.edgeDiffs.find(
      (ed) => ed.direction === 'incoming' && ed.target === FLOW_A_ONLY,
    );
    expect(aOnlyIncoming?.inA).toBe(true);
    expect(aOnlyIncoming?.inB).toBe(false);
  });
});

describe('compareComponentsHandler — sort stability', () => {
  it("returns edgeDiffs sorted by direction (outgoing first), then target ASC", async () => {
    const result = await compareComponentsHandler(ctx, {
      idA: APEX_OLD,
      idB: APEX_NEW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    if (d.edgeDiffs.length === 0) return;
    // Find indices of the first outgoing and the first incoming, if any.
    const firstOutgoingIdx = d.edgeDiffs.findIndex(
      (ed) => ed.direction === 'outgoing',
    );
    const firstIncomingIdx = d.edgeDiffs.findIndex(
      (ed) => ed.direction === 'incoming',
    );
    if (firstOutgoingIdx >= 0 && firstIncomingIdx >= 0) {
      expect(firstOutgoingIdx).toBeLessThan(firstIncomingIdx);
    }
    // Within each direction, target ids must be ascending.
    const outgoing = d.edgeDiffs.filter((ed) => ed.direction === 'outgoing');
    for (let i = 1; i < outgoing.length; i++) {
      expect(outgoing[i]!.target >= outgoing[i - 1]!.target).toBe(true);
    }
  });
});

describe('compareComponentsHandler — vaultState', () => {
  it('passes the manifest sourceTreeHash and refreshedAt through to vaultState', async () => {
    const result = await compareComponentsHandler(ctx, {
      idA: APEX_BASE,
      idB: APEX_BASE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-27T14:33:08Z');
  });
});

describe('compareComponentsInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = compareComponentsInputSchema.safeParse({
      idA: 'CustomObject:Account',
      idB: 'CustomObject:Contact',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty idA string', () => {
    const parsed = compareComponentsInputSchema.safeParse({
      idA: '',
      idB: 'CustomObject:Contact',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing idB', () => {
    const parsed = compareComponentsInputSchema.safeParse({
      idA: 'CustomObject:Account',
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * C-3 (finding 28) regression — `canonicalJson(undefined)` crash-class
 * sweep. `buildFieldDiffs`'s `inA`/`inB` presence guards mean no reachable
 * end-to-end fixture built from real (JSON-round-tripped) vault data can
 * trigger the `undefined` branch today (matching the audit's "latent, not
 * live" classification), so this exercises the exported helper directly —
 * proving the fix without waiting for a future caller to hit the landmine.
 */
describe('canonicalJson — C-3 (finding 28) regression', () => {
  it('returns a string sentinel for undefined instead of the raw JS `undefined` value', () => {
    const result = canonicalJson(undefined);
    expect(typeof result).toBe('string');
    expect(result).toBe('\0undefined\0');
  });

  it('the undefined sentinel does not collide with any real JSON value', () => {
    expect(canonicalJson(undefined)).not.toBe(canonicalJson(null));
    expect(canonicalJson(undefined)).not.toBe(canonicalJson('undefined'));
    expect(canonicalJson(undefined)).not.toBe(canonicalJson('\0undefined\0'));
  });

  it('an object with an explicit undefined property value does not throw', () => {
    const withUndefined = { a: 1, b: undefined as unknown };
    expect(() => canonicalJson(withUndefined)).not.toThrow();
    expect(canonicalJson(withUndefined)).toContain('\0undefined\0');
  });
});
