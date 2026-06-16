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
