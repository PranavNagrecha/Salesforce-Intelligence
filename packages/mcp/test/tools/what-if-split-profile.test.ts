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
  whatIfSplitProfileHandler,
  whatIfSplitProfileInputSchema,
} from '../../src/tools/what-if-split-profile.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Profile: 1, PermissionSet: 3, CustomObject: 2, CustomField: 2 },
  edges: { grantedBy: 0 },
  sourceTreeHash: 'sha256:fixture',
};

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

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// =============================================================================
// Targets the profile grants on.
// =============================================================================

const ACCOUNT_OBJECT = 'CustomObject:Account';
const CASE_OBJECT = 'CustomObject:Case';
const ACCOUNT_INDUSTRY = 'CustomField:Account.Industry__c';
const CASE_STATUS = 'CustomField:Case.Status';
const EMAIL_ROUTER = 'ApexClass:EmailRouterService';
const CONTACT_HANDLER = 'ApexClass:ContactHandler';

const targetNodesSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACCOUNT_OBJECT, type: 'CustomObject', apiName: 'Account' }),
    makeNode({ id: CASE_OBJECT, type: 'CustomObject', apiName: 'Case' }),
    makeNode({
      id: ACCOUNT_INDUSTRY,
      type: 'CustomField',
      apiName: 'Industry__c',
      parentId: ACCOUNT_OBJECT,
    }),
    makeNode({
      id: CASE_STATUS,
      type: 'CustomField',
      apiName: 'Status',
      parentId: CASE_OBJECT,
    }),
    makeNode({
      id: EMAIL_ROUTER,
      type: 'ApexClass',
      apiName: 'EmailRouterService',
    }),
    makeNode({
      id: CONTACT_HANDLER,
      type: 'ApexClass',
      apiName: 'ContactHandler',
    }),
  ],
  edges: [],
};

// =============================================================================
// Target permission sets.
// =============================================================================

const CSR_EMAIL_PS = 'PermissionSet:CSR_Email_Console';
const CSR_ACCOUNT_PS = 'PermissionSet:CSR_Account_Access';
const CSR_BASE_PS = 'PermissionSet:CSR_Base';

const permSetsSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CSR_EMAIL_PS,
      type: 'PermissionSet',
      apiName: 'CSR_Email_Console',
    }),
    makeNode({
      id: CSR_ACCOUNT_PS,
      type: 'PermissionSet',
      apiName: 'CSR_Account_Access',
    }),
    makeNode({
      id: CSR_BASE_PS,
      type: 'PermissionSet',
      apiName: 'CSR_Base',
    }),
  ],
  edges: [],
};

// =============================================================================
// Profile with grants the heuristic can split.
//   - Email-related grants should match CSR_Email_Console via keyword.
//   - Account grants should fall through to domain-cluster match on
//     CSR_Account_Access.
//   - ManageUsers (a user permission) has no obvious match → default.
// =============================================================================

const PROFILE_CSR = 'Profile:CSRRep';

const profileSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PROFILE_CSR,
      apiName: 'CSRRep',
      properties: {
        userPermissions: ['ManageUsers', 'EmailTemplateManagement'],
      },
    }),
  ],
  edges: [
    // Object permission on Account: keyword "Account" matches CSR_Account_Access.
    makeEdge({
      fromId: PROFILE_CSR,
      toId: ACCOUNT_OBJECT,
      edgeType: 'grantedBy',
      properties: { allowRead: true, allowEdit: true },
    }),
    // Field permission Account.Industry__c: keyword "Account" matches
    // CSR_Account_Access.
    makeEdge({
      fromId: PROFILE_CSR,
      toId: ACCOUNT_INDUSTRY,
      edgeType: 'grantedBy',
      properties: { editable: true, readable: true },
    }),
    // Apex class EmailRouterService: keyword "Email" matches
    // CSR_Email_Console.
    makeEdge({
      fromId: PROFILE_CSR,
      toId: EMAIL_ROUTER,
      edgeType: 'grantedBy',
      properties: {},
    }),
    // Apex class ContactHandler: no shared tokens with any target —
    // falls to default (first in list = CSR_Email_Console).
    makeEdge({
      fromId: PROFILE_CSR,
      toId: CONTACT_HANDLER,
      edgeType: 'grantedBy',
      properties: {},
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-what-if-split-profile-'));
  const dbPath = join(tempDir, 'what-if-split-profile.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    targetNodesSeed,
    permSetsSeed,
    profileSeed,
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

describe('whatIfSplitProfileHandler', () => {
  it('returns invalid-query when the profileId lacks the Profile: prefix', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: 'CustomObject:Account',
      targetPermSets: [CSR_BASE_PS],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('profileId');
  });

  it('returns component-not-found when the profile is missing', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: 'Profile:NoSuch',
      targetPermSets: [CSR_BASE_PS],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('returns invalid-query when a target lacks the PermissionSet: prefix', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: ['Profile:Bogus'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found when a target perm set is missing', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: ['PermissionSet:DoesNotExist'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('keyword-matches Email grants to CSR_Email_Console', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: [CSR_BASE_PS, CSR_EMAIL_PS, CSR_ACCOUNT_PS],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const emailAssignment = result.value.data.assignments.find(
      (a) =>
        a.settingType === 'apex-class-access' &&
        a.settingId === 'EmailRouterService',
    );
    expect(emailAssignment).toBeDefined();
    expect(emailAssignment?.targetPermSetId).toBe(CSR_EMAIL_PS);
    expect(emailAssignment?.rationale).toBe('keyword-match');
  });

  it('defaults the per-grant page to a size that fits the MCP response limit', async () => {
    // Regression: the default page was 500 assignments, which on an Admin-class
    // split serialised to ~75 KB — over the MCP client's ~55 KB response-token
    // limit, so the call was rejected. The default now fits. (Mirrors
    // what_if_merge_profiles.)
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: [CSR_BASE_PS],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.limit).toBe(120);
  });

  it('keyword-matches Account grants to CSR_Account_Access', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: [CSR_BASE_PS, CSR_EMAIL_PS, CSR_ACCOUNT_PS],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const accountObj = result.value.data.assignments.find(
      (a) =>
        a.settingType === 'object-permission' &&
        a.settingId === 'Account',
    );
    expect(accountObj).toBeDefined();
    expect(accountObj?.targetPermSetId).toBe(CSR_ACCOUNT_PS);
    expect(accountObj?.rationale).toBe('keyword-match');
  });

  it('falls through to default rationale for grants with no token overlap', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: [CSR_BASE_PS, CSR_EMAIL_PS, CSR_ACCOUNT_PS],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ContactHandler has no shared tokens with any target perm-set name.
    const contact = result.value.data.assignments.find(
      (a) =>
        a.settingType === 'apex-class-access' &&
        a.settingId === 'ContactHandler',
    );
    expect(contact).toBeDefined();
    expect(contact?.rationale).toBe('default');
    // Default is the FIRST target.
    expect(contact?.targetPermSetId).toBe(CSR_BASE_PS);
  });

  it('walks both user permissions and grantedBy edges', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: [CSR_BASE_PS, CSR_EMAIL_PS, CSR_ACCOUNT_PS],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const types = new Set(
      result.value.data.assignments.map((a) => a.settingType),
    );
    expect(types.has('user-permission')).toBe(true);
    expect(types.has('object-permission')).toBe(true);
    expect(types.has('field-permission')).toBe(true);
    expect(types.has('apex-class-access')).toBe(true);
  });

  it('routes the EmailTemplateManagement user permission via keyword match', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: [CSR_BASE_PS, CSR_EMAIL_PS, CSR_ACCOUNT_PS],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const upAssignment = result.value.data.assignments.find(
      (a) =>
        a.settingType === 'user-permission' &&
        a.settingId === 'EmailTemplateManagement',
    );
    expect(upAssignment).toBeDefined();
    expect(upAssignment?.targetPermSetId).toBe(CSR_EMAIL_PS);
    expect(upAssignment?.rationale).toBe('keyword-match');
  });

  it('emits the verbatim disclosure and the assigned summary count', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: [CSR_BASE_PS, CSR_EMAIL_PS, CSR_ACCOUNT_PS],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('approximate');
    expect(result.value.data.disclosure).toContain('fail-conservative');
    expect(result.value.data.summary.assignedCount).toBe(
      result.value.data.assignments.length,
    );
    expect(result.value.data.summary.unassignedCount).toBe(
      result.value.data.unassignedSettings.length,
    );
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });
});

describe('whatIfSplitProfileHandler — CR-22 continuation cursor', () => {
  const TARGETS = [CSR_BASE_PS, CSR_EMAIL_PS, CSR_ACCOUNT_PS];

  it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    const result = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: TARGETS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.hasMore).toBe(false);
    expect(d.disclosure).not.toContain('Returning assignments');
  });

  it('a truncated (limit 1) page cursors through the FULL assignment list with no gaps/dupes', async () => {
    const full = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: TARGETS,
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const total = full.value.data.summary.assignedCount;
    expect(total).toBeGreaterThanOrEqual(2);
    const fullKeys = full.value.data.assignments.map(
      (a) => `${a.settingType}|${a.settingId}|${a.targetPermSetId}`,
    );

    const collected: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const r = await whatIfSplitProfileHandler(ctx, {
        profileId: PROFILE_CSR,
        targetPermSets: TARGETS,
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      // byTarget rollup stays COMPLETE on every page.
      expect(d.summary.assignedCount).toBe(total);
      for (const a of d.assignments) {
        collected.push(`${a.settingType}|${a.settingId}|${a.targetPermSetId}`);
      }
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

  it('rejects a cursor minted for a DIFFERENT target order (fingerprint mismatch)', async () => {
    const first = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: TARGETS,
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    // targetPermSets order is load-bearing → a reordered list is a different
    // query → the fingerprint changes → the cursor stale-rejects.
    const replay = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: [CSR_EMAIL_PS, CSR_BASE_PS, CSR_ACCOUNT_PS],
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed / forged cursor string', async () => {
    const replay = await whatIfSplitProfileHandler(ctx, {
      profileId: PROFILE_CSR,
      targetPermSets: TARGETS,
      cursor: 'not-a-real-cursor',
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});

describe('whatIfSplitProfileInputSchema', () => {
  it('accepts a valid profileId + non-empty targetPermSets array', () => {
    const parsed = whatIfSplitProfileInputSchema.safeParse({
      profileId: 'Profile:A',
      targetPermSets: ['PermissionSet:Base'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty targetPermSets array at the Zod step', () => {
    const parsed = whatIfSplitProfileInputSchema.safeParse({
      profileId: 'Profile:A',
      targetPermSets: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty profileId', () => {
    const parsed = whatIfSplitProfileInputSchema.safeParse({
      profileId: '',
      targetPermSets: ['PermissionSet:Base'],
    });
    expect(parsed.success).toBe(false);
  });
});

// =============================================================================
// FIX 1 — the tool excluded three families the platform really does support,
// then called the resulting plan `safe`.
//
// The old disclosure said tab / record-type / application visibilities "are not
// split (Profile-only settings in the Salesforce metadata model)". That is
// false about Salesforce, and this product already contradicted it:
// `effective_permissions` unions record-type visibility FROM permission sets,
// and both extractors normalise the permset forms onto the same property keys.
//
// Correcting only the prose would have left `summary.assignedCount` /
// `unassignedCount` silently excluding movable settings — and those are the
// numbers a caller reads as "the plan is complete", and the numbers the verdict
// is computed from.
// =============================================================================

const VIS_PROFILE = 'Profile:Visibility_Rich';
const VIS_PROFILE_NO_RT = 'Profile:Visibility_No_Rt';
const VIS_PROFILE_EMPTY = 'Profile:Visibility_Empty';
const VIS_PS_1 = 'PermissionSet:Widget_Ops';
const VIS_PS_2 = 'PermissionSet:Reporting_Ops';

const visibilityProps = {
  userPermissions: ['ApiEnabled'],
  tabVisibilities: [
    { tab: 'Widget__c', visibility: 'DefaultOn' },
    { tab: 'Secret__c', visibility: 'Hidden' },
  ],
  recordTypeVisibilities: [
    { recordType: 'Widget__c.Standard_Widget', default: true, visible: true },
    { recordType: 'Widget__c.Retired_Widget', default: false, visible: false },
  ],
  applicationVisibilities: [{ application: 'Widget_Console', default: false, visible: true }],
  layoutAssignments: [{ layout: 'Widget__c-Widget Layout', recordType: null }],
};

const visibilitySeed: ExtractionResult = {
  nodes: [
    makeNode({ id: VIS_PROFILE, apiName: 'Visibility_Rich', properties: visibilityProps }),
    // Same profile with `recordTypeVisibilities` DELETED — the sentinel case.
    makeNode({
      id: VIS_PROFILE_NO_RT,
      apiName: 'Visibility_No_Rt',
      properties: (() => {
        const p: Record<string, unknown> = { ...visibilityProps };
        delete p['recordTypeVisibilities'];
        return p;
      })(),
    }),
    // Extracted but genuinely EMPTY — present-and-empty must not render like
    // absent, and must not disturb the four pre-existing categories.
    makeNode({
      id: VIS_PROFILE_EMPTY,
      apiName: 'Visibility_Empty',
      properties: {
        userPermissions: ['ApiEnabled'],
        tabVisibilities: [],
        recordTypeVisibilities: [],
        applicationVisibilities: [],
        layoutAssignments: [],
      },
    }),
    makeNode({ id: VIS_PS_1, type: 'PermissionSet', apiName: 'Widget_Ops' }),
    makeNode({ id: VIS_PS_2, type: 'PermissionSet', apiName: 'Reporting_Ops' }),
  ],
  edges: [],
};

describe('whatIfSplitProfileHandler — the three splittable visibility families', () => {
  let visDir: string;
  let visStore: GraphStore;
  let visCtx: Context;

  beforeAll(async () => {
    visDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-split-vis-'));
    const opened = await openGraph(join(visDir, 'g.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    visStore = opened.value;
    const imported = await importExtractionResults(visStore, [visibilitySeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    visCtx = { vaultRoot: visDir, manifest: FIXTURE_MANIFEST, graph: visStore };
  });

  afterAll(async () => {
    await closeGraph(visStore);
    rmSync(visDir, { recursive: true, force: true });
  });

  it('splits the movable states and quarantines the ones only a Profile can express', async () => {
    const r = await whatIfSplitProfileHandler(visCtx, {
      profileId: VIS_PROFILE,
      targetPermSets: [VIS_PS_1, VIS_PS_2],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    // Today all six of these rows are absent from the response entirely.
    const tab = d.assignments.find((a) => a.settingType === 'tab-visibility');
    expect(tab?.settingId).toBe('Widget__c');
    // The Profile spelling is TRANSLATED to the PermissionSet <tabSettings> one.
    expect(tab?.currentValue).toBe('Visible');

    const rt = d.assignments.find((a) => a.settingType === 'record-type-visibility');
    expect(rt?.settingId).toBe('Widget__c.Standard_Widget');
    expect(rt?.currentValue).toEqual({ visible: true, default: false });
    // Part of the setting moves, part cannot.
    expect(rt?.transferNote).toContain('DEFAULT designation does not');
    expect(rt?.transferNote).toContain('Profile-only');

    const app = d.assignments.find((a) => a.settingType === 'application-visibility');
    expect(app?.settingId).toBe('Widget_Console');

    const nt = d.nonTransferableSettings;
    expect(nt.map((n) => n.settingId).sort()).toEqual([
      'Secret__c',
      'Widget__c-Widget Layout|default',
      'Widget__c.Retired_Widget',
    ]);
    expect(d.summary.nonTransferableCount).toBe(3);
    expect(nt.find((n) => n.settingId === 'Secret__c')?.reason).toContain('cannot hide a tab');
    expect(
      nt.find((n) => n.settingId === 'Widget__c.Retired_Widget')?.reason,
    ).toContain('cannot un-see a record type');
    expect(
      nt.find((n) => n.settingId === 'Widget__c-Widget Layout|default')?.reason,
    ).toContain('no layout-assignment element');
  });

  it('the disclosure no longer claims the three families are Profile-only', async () => {
    const r = await whatIfSplitProfileHandler(visCtx, {
      profileId: VIS_PROFILE,
      targetPermSets: [VIS_PS_1],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.disclosure).not.toContain(
      'Profile-only settings in the Salesforce metadata model',
    );
    expect(d.disclosure).toContain('ARE split');
    expect(d.disclosure).toContain('DefaultOn -> Visible');
    expect(d.disclosure).toContain('A permission set is ADDITIVE');
    expect(d.disclosure).toContain(
      'cannot move to a permission set at all and are listed in nonTransferableSettings',
    );
  });

  it('an UNEXTRACTED family forces `review` — `safe` must never mean "I did not look"', async () => {
    const r = await whatIfSplitProfileHandler(visCtx, {
      profileId: VIS_PROFILE_NO_RT,
      targetPermSets: [VIS_PS_1],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.verdict).toBe('review');
    expect(d.summary.notEvaluatedCategories).toContain('record-type-visibility');
    expect(d.disclosure).toContain('Record-type visibility was NOT checked');
    expect(d.disclosure).toContain('recordTypeVisibilities');
    // And it fabricated nothing.
    expect(
      d.assignments.filter((a) => a.settingType === 'record-type-visibility'),
    ).toEqual([]);
    expect(
      d.nonTransferableSettings.filter((n) => n.settingType === 'record-type-visibility'),
    ).toEqual([]);
  });

  it('present-and-EMPTY is not the same as absent', async () => {
    const r = await whatIfSplitProfileHandler(visCtx, {
      profileId: VIS_PROFILE_EMPTY,
      targetPermSets: [VIS_PS_1],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.notEvaluatedCategories).toEqual([]);
    expect(d.disclosure).not.toContain('was NOT checked');
    expect(d.summary.nonTransferableCount).toBe(0);
    // The four pre-existing categories are untouched: one user permission, no
    // grant edges in this seed.
    expect(d.summary.assignedCount).toBe(1);
    expect(d.assignments[0]?.settingType).toBe('user-permission');
  });

  it('the cursor key stays a total order across the three new setting types', async () => {
    const first = await whatIfSplitProfileHandler(visCtx, {
      profileId: VIS_PROFILE,
      targetPermSets: [VIS_PS_1, VIS_PS_2],
      limit: 2,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const d1 = first.value.data;
    expect(d1.hasMore).toBe(true);
    const second = await whatIfSplitProfileHandler(visCtx, {
      profileId: VIS_PROFILE,
      targetPermSets: [VIS_PS_1, VIS_PS_2],
      limit: 10,
      cursor: d1.nextCursor as string,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const keys = [...d1.assignments, ...second.value.data.assignments].map(
      (a) => `${a.settingType} ${a.settingId} ${a.targetPermSetId}`,
    );
    expect(new Set(keys).size).toBe(keys.length); // no dupes
    expect(keys.length).toBe(d1.summary.assignedCount); // no gaps
  });
});
