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
  whatIfMergeProfilesHandler,
  whatIfMergeProfilesInputSchema,
} from '../../src/tools/what-if-merge-profiles.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Profile: 2, CustomObject: 1, CustomField: 1, ApexClass: 1 },
  edges: { grantedBy: 0 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'Profile',
  apiName: 'TestProfile',
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
// Shared targets the profiles grant on.
// =============================================================================

const ACCOUNT_OBJECT = 'CustomObject:Account';
const INDUSTRY_FIELD = 'CustomField:Account.Industry__c';
const ACCOUNT_CONTROLLER = 'ApexClass:AccountController';

const sharedTargetsSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACCOUNT_OBJECT, type: 'CustomObject', apiName: 'Account' }),
    makeNode({
      id: INDUSTRY_FIELD,
      type: 'CustomField',
      apiName: 'Industry__c',
      parentId: ACCOUNT_OBJECT,
    }),
    makeNode({
      id: ACCOUNT_CONTROLLER,
      type: 'ApexClass',
      apiName: 'AccountController',
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed: two profiles with overlapping settings. Used to exercise both
// "agreed" and "conflict" paths across every category.
// =============================================================================

const PROFILE_A = 'Profile:SalesA';
const PROFILE_B = 'Profile:SalesB';

const profileASeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PROFILE_A,
      apiName: 'SalesA',
      properties: {
        // Shared user permission with B: should be agreed.
        // Plus a user permission only on A: should produce a conflict.
        userPermissions: ['ManageUsers', 'ApiEnabled'],
        tabVisibilities: [
          { tab: 'standard-Account', visibility: 'DefaultOn' },
          // Disagrees with B (B has DefaultOff).
          { tab: 'standard-Lead', visibility: 'DefaultOn' },
        ],
        layoutAssignments: [
          // Disagrees with B on the default-layout axis.
          { layout: 'Account-Account A Layout', recordType: null },
        ],
        recordTypeVisibilities: [
          // Disagrees with B on the default flag.
          {
            recordType: 'RecordType:Account.B2B',
            default: true,
            visible: true,
          },
        ],
      },
    }),
  ],
  edges: [
    // Object permission: A grants Read+Edit on Account.
    makeEdge({
      fromId: PROFILE_A,
      toId: ACCOUNT_OBJECT,
      edgeType: 'grantedBy',
      properties: { allowRead: true, allowEdit: true },
    }),
    // Field permission: A grants edit-level on Industry__c.
    makeEdge({
      fromId: PROFILE_A,
      toId: INDUSTRY_FIELD,
      edgeType: 'grantedBy',
      properties: { editable: true, readable: true },
    }),
    // Apex class access: A grants AccountController.
    makeEdge({
      fromId: PROFILE_A,
      toId: ACCOUNT_CONTROLLER,
      edgeType: 'grantedBy',
      properties: {},
    }),
  ],
};

const profileBSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PROFILE_B,
      apiName: 'SalesB',
      properties: {
        userPermissions: ['ManageUsers'], // ApiEnabled is missing — conflict.
        tabVisibilities: [
          { tab: 'standard-Account', visibility: 'DefaultOn' },
          { tab: 'standard-Lead', visibility: 'DefaultOff' },
        ],
        layoutAssignments: [
          { layout: 'Account-Account B Layout', recordType: null },
        ],
        recordTypeVisibilities: [
          {
            recordType: 'RecordType:Account.B2B',
            default: false,
            visible: true,
          },
        ],
      },
    }),
  ],
  edges: [
    // Object permission: B grants Read only — conflict with A's Read+Edit.
    makeEdge({
      fromId: PROFILE_B,
      toId: ACCOUNT_OBJECT,
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
    // Field permission: B grants read-only on Industry__c — conflict.
    makeEdge({
      fromId: PROFILE_B,
      toId: INDUSTRY_FIELD,
      edgeType: 'grantedBy',
      properties: { editable: false, readable: true },
    }),
    // Apex class access: B agrees with A on AccountController.
    makeEdge({
      fromId: PROFILE_B,
      toId: ACCOUNT_CONTROLLER,
      edgeType: 'grantedBy',
      properties: {},
    }),
  ],
};

// =============================================================================
// Seed: two profiles that agree on everything (degenerate case).
// =============================================================================

const PROFILE_C = 'Profile:Same1';
const PROFILE_D = 'Profile:Same2';

const sameProfileCSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PROFILE_C,
      apiName: 'Same1',
      properties: { userPermissions: ['ApiEnabled'] },
    }),
  ],
  edges: [
    makeEdge({
      fromId: PROFILE_C,
      toId: ACCOUNT_OBJECT,
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
};

const sameProfileDSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PROFILE_D,
      apiName: 'Same2',
      properties: { userPermissions: ['ApiEnabled'] },
    }),
  ],
  edges: [
    makeEdge({
      fromId: PROFILE_D,
      toId: ACCOUNT_OBJECT,
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-what-if-merge-profiles-'));
  const dbPath = join(tempDir, 'what-if-merge-profiles.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    sharedTargetsSeed,
    profileASeed,
    profileBSeed,
    sameProfileCSeed,
    sameProfileDSeed,
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

describe('whatIfMergeProfilesHandler', () => {
  it('returns invalid-query when profileIdA lacks the Profile: prefix', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: 'NotAProfile:Foo',
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('profileIdA');
  });

  it('returns invalid-query when profileIdB lacks the Profile: prefix', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: 'CustomObject:Foo',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('profileIdB');
  });

  it('returns component-not-found when profileIdA is unknown', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: 'Profile:NoSuch',
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('returns component-not-found when profileIdB is unknown', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: 'Profile:NoSuch',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('surfaces field-permission conflict with recommendedPolicy max', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const conflicts = result.value.data.conflicts;
    const fieldConflict = conflicts.find(
      (c) =>
        c.settingType === 'field-permission' &&
        c.settingId === 'Account.Industry__c',
    );
    expect(fieldConflict).toBeDefined();
    expect(fieldConflict?.profileAValue).toBe('edit');
    expect(fieldConflict?.profileBValue).toBe('read');
    expect(fieldConflict?.recommendedPolicy).toBe('max');
  });

  it('surfaces object-permission conflict with recommendedPolicy max', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const conflicts = result.value.data.conflicts;
    const objConflict = conflicts.find(
      (c) =>
        c.settingType === 'object-permission' && c.settingId === 'Account',
    );
    expect(objConflict).toBeDefined();
    expect(objConflict?.recommendedPolicy).toBe('max');
    // A has {allowRead, allowEdit}; B has {allowRead} — values differ.
    const aFlags = objConflict?.profileAValue as Record<string, boolean>;
    expect(aFlags['allowEdit']).toBe(true);
  });

  it('surfaces user-permission conflict for permissions only on one profile', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const conflicts = result.value.data.conflicts;
    const userConflict = conflicts.find(
      (c) =>
        c.settingType === 'user-permission' && c.settingId === 'ApiEnabled',
    );
    // A has ApiEnabled (true), B doesn't (undefined → null in output).
    expect(userConflict).toBeDefined();
    expect(userConflict?.profileAValue).toBe(true);
    expect(userConflict?.profileBValue).toBeNull();
    expect(userConflict?.recommendedPolicy).toBe('max');
  });

  it('surfaces layout-assignment conflict with recommendedPolicy manual-only', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const layoutConflicts = result.value.data.conflicts.filter(
      (c) => c.settingType === 'layout-assignment',
    );
    expect(layoutConflicts.length).toBeGreaterThan(0);
    const conflict = layoutConflicts[0]!;
    expect(conflict.recommendedPolicy).toBe('manual-only');
    expect(conflict.tieBreak).toBeDefined();
  });

  it('surfaces tab-visibility conflict for differing visibility values', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tabConflict = result.value.data.conflicts.find(
      (c) =>
        c.settingType === 'tab-visibility' &&
        c.settingId === 'standard-Lead',
    );
    expect(tabConflict).toBeDefined();
    expect(tabConflict?.profileAValue).toBe('DefaultOn');
    expect(tabConflict?.profileBValue).toBe('DefaultOff');
  });

  it('reports zero conflicts and matching agreed count for identical profiles', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_C,
      profileIdB: PROFILE_D,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.conflicts.length).toBe(0);
    expect(result.value.data.summary.conflicts).toBe(0);
    expect(result.value.data.summary.agreed).toBeGreaterThan(0);
    expect(result.value.data.summary.agreed).toBe(
      result.value.data.summary.totalSettings,
    );
  });

  it('discloses tab-visibility as not-evaluated when neither profile extracted it', async () => {
    // P11-UI-tabvis-consumer-bug: Same1/Same2 carry no `tabVisibilities`
    // property, so the merge must NOT imply a verified "no tab conflicts".
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_C,
      profileIdB: PROFILE_D,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.summary.notEvaluatedCategories).toContain(
      'tab-visibility',
    );
    expect(result.value.data.disclosure).toContain(
      'Tab visibility was NOT compared',
    );
  });

  it('does NOT flag tab-visibility as not-evaluated when it was extracted', async () => {
    // PROFILE_A / PROFILE_B both carry `tabVisibilities` → real comparison.
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.summary.notEvaluatedCategories).not.toContain(
      'tab-visibility',
    );
  });

  it('emits the verbatim disclosure and matches the vault state', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('NOT auto-resolve');
    expect(result.value.data.disclosure).toContain(
      'Profile-edition rollup',
    );
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('defaults the per-conflict page to a size that fits the MCP response limit', async () => {
    // Regression: the default page was 500 conflicts, which on an Admin-class
    // merge serialised to ~77 KB — over the MCP client's ~55 KB response-token
    // limit, so the call was rejected outright. The default now fits.
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.limit).toBe(120);
  });

  it('orders conflicts deterministically by (settingType, settingId)', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.value.data.conflicts.map(
      (c) => `${c.settingType}|${c.settingId}`,
    );
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});

describe('whatIfMergeProfilesInputSchema', () => {
  it('accepts two non-empty Profile-like strings', () => {
    const parsed = whatIfMergeProfilesInputSchema.safeParse({
      profileIdA: 'Profile:A',
      profileIdB: 'Profile:B',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty profileIdA at the Zod step', () => {
    const parsed = whatIfMergeProfilesInputSchema.safeParse({
      profileIdA: '',
      profileIdB: 'Profile:B',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing profileIdB', () => {
    const parsed = whatIfMergeProfilesInputSchema.safeParse({
      profileIdA: 'Profile:A',
    });
    expect(parsed.success).toBe(false);
  });
});
