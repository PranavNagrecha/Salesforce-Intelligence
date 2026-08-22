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

describe('whatIfMergeProfilesHandler — CR-22 continuation cursor', () => {
  it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.hasMore).toBe(false);
    // The disclosure stays the plain DISCLOSURE on a non-truncated page.
    expect(d.disclosure).not.toContain('Returning conflicts');
  });

  it('a truncated (limit 1) page cursors through the FULL conflict list with no gaps/dupes', async () => {
    const full = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const total = full.value.data.summary.conflicts;
    expect(total).toBeGreaterThanOrEqual(2);
    const fullKeys = full.value.data.conflicts.map((c) => `${c.settingType}|${c.settingId}`);

    const collected: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const r = await whatIfMergeProfilesHandler(ctx, {
        profileIdA: PROFILE_A,
        profileIdB: PROFILE_B,
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      // rollups stay COMPLETE on every page (computed over the full list).
      expect(d.summary.conflicts).toBe(total);
      for (const c of d.conflicts) collected.push(`${c.settingType}|${c.settingId}`);
      if (d.hasMore) {
        expect(typeof d.nextCursor).toBe('string');
        expect(d.pageInfo?.nextCursor).toBe(d.nextCursor);
        cursor = d.nextCursor as string;
      } else {
        expect('nextCursor' in d).toBe(false);
        break;
      }
      if (++guard > 200) throw new Error('cursor loop did not terminate');
    }
    expect(collected.length).toBe(total); // no gaps
    expect(new Set(collected).size).toBe(total); // no dupes
    expect(collected).toEqual(fullKeys); // identical order to the whole-list walk
  });

  it('rejects a cursor minted for a DIFFERENT profile pair', async () => {
    const first = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    const replay = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_C,
      profileIdB: PROFILE_D,
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed / forged cursor string', async () => {
    const replay = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
      cursor: 'not-a-real-cursor',
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
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

// =============================================================================
// Finding #35 — format: 'proposal' emits a LOCAL package.xml pulling both
// profiles for a human to hand-merge.
// =============================================================================

const isWellFormedMergeXml = (xml: string): boolean => {
  const body = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?xml[^>]*\?>/g, '');
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w.-]*)(\s[^>]*)?(\/?)>/g)) {
    const closing = m[1] === '/';
    const name = m[2] ?? '';
    if (m[4] === '/') continue;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
};

describe('whatIfMergeProfilesHandler — format: proposal (Finding #35)', () => {
  it('emits a deploy package.xml naming both profiles, with conflict evidence inline', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
      format: 'proposal',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proposal = result.value.data.proposal;
    expect(proposal).toBeDefined();
    if (proposal === undefined) return;

    expect(proposal.kind).toBe('deploy');
    expect(proposal.files.map((f) => f.path)).toEqual(['package.xml']);
    const pkg = proposal.files[0]?.contents ?? '';
    // Both profiles are packaged under <name>Profile</name>.
    expect(pkg).toContain('<members>SalesA</members>');
    expect(pkg).toContain('<members>SalesB</members>');
    expect(pkg).toContain('<name>Profile</name>');
    expect(pkg).toContain('<version>');
    expect(isWellFormedMergeXml(pkg)).toBe(true);

    // Self-justifying: verdict + conflict count + REVIEW banner + vault hash.
    expect(pkg).toMatch(/REVIEW BEFORE DEPLOY/i);
    expect(pkg).toContain(`verdict: ${result.value.data.verdict}`);
    expect(proposal.summary.componentCount).toBe(2);
    expect(proposal.evidence.reasons.join(' ')).toMatch(/conflict/i);
    // The "surfaces but does not auto-resolve" disclosure rides verbatim.
    expect(proposal.evidence.disclosures.join(' ')).toMatch(/auto-resolve/i);
  });

  it('does not attach a proposal for the default json format', async () => {
    const result = await whatIfMergeProfilesHandler(ctx, {
      profileIdA: PROFILE_A,
      profileIdB: PROFILE_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.proposal).toBeUndefined();
  });
});

// =============================================================================
// FIX 4 — the tool asserted an exhaustive conflict list over three categories
// it never walked.
//
// The license half is the sharpest: 1,089 of 1,326 profile pairs in one vault
// are cross-license, and for those the tool emitted up to 3,060 `max`-policy
// recommendations that CANNOT BE DEPLOYED, labelled `completeness: complete`
// with `limitations: []`. A recommendation that cannot be executed, labelled
// complete, is worse than no recommendation.
// =============================================================================

const LIC_A = 'Profile:License_Alpha';
const LIC_B = 'Profile:License_Beta';
const LIC_C = 'Profile:License_Alpha_Twin';
const NO_APPS = 'Profile:No_Apps_Extracted';

/** Every property-derived family present, so only the axis under test varies. */
const fullProfileProps = (over: Record<string, unknown>): Record<string, unknown> => ({
  userPermissions: ['ApiEnabled'],
  tabVisibilities: [],
  layoutAssignments: [],
  recordTypeVisibilities: [],
  applicationVisibilities: [],
  loginIpRanges: [],
  loginHours: [],
  userLicense: 'Alpha Platform',
  ...over,
});

const licenseSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: LIC_A,
      apiName: 'License_Alpha',
      properties: fullProfileProps({
        applicationVisibilities: [{ application: 'App_One', default: true, visible: true }],
        loginIpRanges: [
          { startAddress: '198.51.100.1', endAddress: '198.51.100.9' },
          { startAddress: '203.0.113.1', endAddress: '203.0.113.9' },
        ],
      }),
    }),
    makeNode({
      id: LIC_B,
      apiName: 'License_Beta',
      properties: fullProfileProps({
        userLicense: 'Beta Platform',
        applicationVisibilities: [{ application: 'App_One', default: false, visible: false }],
      }),
    }),
    makeNode({
      id: LIC_C,
      apiName: 'License_Alpha_Twin',
      properties: fullProfileProps({
        applicationVisibilities: [{ application: 'App_One', default: true, visible: true }],
        loginIpRanges: [
          { startAddress: '198.51.100.1', endAddress: '198.51.100.9' },
          { startAddress: '203.0.113.1', endAddress: '203.0.113.9' },
        ],
      }),
    }),
    // Same as LIC_A but the applicationVisibilities key was NEVER WRITTEN.
    makeNode({
      id: NO_APPS,
      apiName: 'No_Apps_Extracted',
      properties: (() => {
        const p = fullProfileProps({});
        delete p['applicationVisibilities'];
        return p;
      })(),
    }),
  ],
  edges: [],
};

describe('whatIfMergeProfilesHandler — compatibility, apps and login restrictions', () => {
  let licDir: string;
  let licStore: GraphStore;
  let licCtx: Context;

  beforeAll(async () => {
    licDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-merge-license-'));
    const opened = await openGraph(join(licDir, 'g.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    licStore = opened.value;
    const imported = await importExtractionResults(licStore, [licenseSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    licCtx = { vaultRoot: licDir, manifest: FIXTURE_MANIFEST, graph: licStore };
  });

  afterAll(async () => {
    await closeGraph(licStore);
    rmSync(licDir, { recursive: true, force: true });
  });

  it('a cross-license pair is BLOCKING, not `review` with deployable-looking advice', async () => {
    const r = await whatIfMergeProfilesHandler(licCtx, {
      profileIdA: LIC_A,
      profileIdB: LIC_B,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Today: `review`, and no `compatibility` key at all.
    expect(d.verdict).toBe('blocking');
    expect(d.compatibility.mergeable).toBe(false);
    expect(d.compatibility.blockers).toHaveLength(1);
    expect(d.compatibility.blockers[0]?.kind).toBe('user-license');
    expect(d.compatibility.blockers[0]?.profileAValue).toBe('Alpha Platform');
    expect(d.compatibility.blockers[0]?.profileBValue).toBe('Beta Platform');
    expect(d.disclosure).toMatch(/cannot be merged/);
    expect(d.disclosure).toContain('IMMUTABLE in Salesforce');
    expect(d.disclosure).toContain('VERDICT: blocking');
  });

  it('the blocker reaches the deploy-shaped proposal artifact', async () => {
    const r = await whatIfMergeProfilesHandler(licCtx, {
      profileIdA: LIC_A,
      profileIdB: LIC_B,
      format: 'proposal',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const evidence = JSON.stringify(r.value.data.proposal);
    expect(evidence).toContain('BLOCKER (user-license)');
  });

  it('application visibilities are COMPARED, at manual-only', async () => {
    const r = await whatIfMergeProfilesHandler(licCtx, {
      profileIdA: LIC_A,
      profileIdB: LIC_B,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Today: zero. The property was never walked.
    const apps = r.value.data.conflicts.filter(
      (c) => c.settingType === 'application-visibility',
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]?.settingId).toBe('App_One');
    expect(apps[0]?.recommendedPolicy).toBe('manual-only');
  });

  it('login restrictions are COMPARED, and NEVER at policy `max`', async () => {
    const r = await whatIfMergeProfilesHandler(licCtx, {
      profileIdA: LIC_A,
      profileIdB: LIC_B,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const login = r.value.data.conflicts.filter((c) => c.settingType === 'login-restriction');
    expect(login).toHaveLength(1);
    expect(login[0]?.settingId).toBe('loginIpRanges');
    // `max` on an IP allowlist means DELETING the restriction. Asserted as a
    // negative because that is the failure this line exists to prevent.
    expect(login[0]?.recommendedPolicy).toBe('manual-only');
    expect(login[0]?.recommendedPolicy).not.toBe('max');
    // Both sides' windows are surfaced verbatim for the reviewer.
    expect(login[0]?.profileAValue).toHaveLength(2);
    expect(login[0]?.profileBValue).toHaveLength(0);
  });

  it('a same-license, all-agreeing pair stays `safe` with mergeable true', async () => {
    const r = await whatIfMergeProfilesHandler(licCtx, {
      profileIdA: LIC_A,
      profileIdB: LIC_C,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.compatibility.mergeable).toBe(true);
    expect(d.compatibility.blockers).toEqual([]);
    expect(d.conflicts).toEqual([]);
    expect(d.summary.agreed).toBe(d.summary.totalSettings);
    expect(d.summary.notEvaluatedCategories).toEqual([]);
    // NOT blocking: same license, so the merge is possible. (The fixture
    // manifest carries no coverage block, so the pre-existing coverage pass
    // downgrades `safe` to `review` here — orthogonal to this fix, and the
    // point of this assertion is that `blocking` did not leak in.)
    expect(d.verdict).not.toBe('blocking');
    expect(['safe', 'review']).toContain(d.verdict);
    // Nothing un-evaluated → no not-evaluated limitations.
    expect(d.trust.limitations).toEqual([]);
  });

  it('a self-merge produces no spurious blocker', async () => {
    const r = await whatIfMergeProfilesHandler(licCtx, {
      profileIdA: LIC_A,
      profileIdB: LIC_A,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.compatibility.mergeable).toBe(true);
    expect(r.value.data.compatibility.blockers).toEqual([]);
  });

  it('an UNEXTRACTED category is named, disclosed, and drags completeness off `complete`', async () => {
    const r = await whatIfMergeProfilesHandler(licCtx, {
      profileIdA: NO_APPS,
      profileIdB: NO_APPS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.notEvaluatedCategories).toContain('application-visibility');
    expect(d.disclosure).toContain('Application visibility was NOT compared');
    expect(d.disclosure).toContain('applicationVisibilities');
    // No fabricated app conflicts.
    expect(d.conflicts.filter((c) => c.settingType === 'application-visibility')).toEqual([]);
    // The response must not claim `complete` next to a not-evaluated list.
    expect(d.trust.completeness.status).not.toBe('complete');
    expect(d.trust.limitations.length).toBeGreaterThan(0);
  });

  it('present-and-EMPTY is a compared zero, not a not-evaluated one', async () => {
    // LIC_A/LIC_C both carry `tabVisibilities: []`. Extracted and empty must
    // NOT render the same as never-extracted.
    const r = await whatIfMergeProfilesHandler(licCtx, {
      profileIdA: LIC_A,
      profileIdB: LIC_C,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.notEvaluatedCategories).not.toContain('tab-visibility');
    expect(r.value.data.disclosure).not.toContain('Tab visibility was NOT compared');
  });
});
