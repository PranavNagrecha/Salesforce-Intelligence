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
  whyCantUserSeeRecordHandler,
  whyCantUserSeeRecordInputSchema,
} from '../../src/tools/why-cant-user-see-record.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 4,
    Profile: 1,
    PermissionSet: 1,
    Role: 4,
    Group: 1,
    SharingRule: 4,
  },
  edges: { grantedBy: 1, parentOf: 4, sharedWith: 4, inheritsFrom: 3 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName/properties. */
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

/** Default edge-shape helper. Caller overrides fromId/toId/edgeType/source. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed 1: OWD-Read object. Cascade short-circuits after OWD.
// =============================================================================

const READ_OBJ = 'CustomObject:ReadObj';

const owdReadSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: READ_OBJ,
      apiName: 'ReadObj',
      properties: { sharingModel: 'Read' },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 1b: OWD-ReadWriteTransfer object (Lead/Case "Public Read/Write/Transfer").
// A PUBLIC read-or-better OWD — the cascade must short-circuit visible.
// =============================================================================

const RWT_OBJ = 'CustomObject:Lead';

const owdReadWriteTransferSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: RWT_OBJ,
      apiName: 'Lead',
      properties: { sharingModel: 'ReadWriteTransfer' },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 1c: OWD-ControlledByCampaign object (CampaignMember). Access is inherited
// from the parent Campaign — restricted at OWD like ControlledByParent.
// =============================================================================

const CBC_OBJ = 'CustomObject:CampaignMember';

const owdControlledByCampaignSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CBC_OBJ,
      apiName: 'CampaignMember',
      properties: { sharingModel: 'ControlledByCampaign' },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 2: OWD-Private object with a Profile that holds a read-or-better
// grantedBy edge. PermissionGrant overrides OWD.
// =============================================================================

const PRIVATE_OBJ = 'CustomObject:PrivateObj';
const ADMIN_PROFILE = 'Profile:System Administrator';

const permissionGrantSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PRIVATE_OBJ,
      apiName: 'PrivateObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({ id: ADMIN_PROFILE, type: 'Profile', apiName: 'System Administrator' }),
  ],
  edges: [
    makeEdge({
      fromId: ADMIN_PROFILE,
      toId: PRIVATE_OBJ,
      edgeType: 'grantedBy',
      properties: {
        allowRead: true,
        allowEdit: true,
        modifyAllRecords: true,
        viewAllRecords: true,
      },
    }),
  ],
};

// =============================================================================
// Seed 3: OWD-Private object with an owner-type SharingRule sharedWith a
// group the user is in. The rule should report `visible`.
// =============================================================================

const OWNER_RULE_OBJ = 'CustomObject:OwnerRuleObj';
const OWNER_RULE_ID = 'SharingRule:OwnerRuleObj.OwnerRule';
const SALES_GROUP = 'Group:Sales_Public_Group';
const SALES_REP_ROLE = 'Role:Sales_Rep';

const ownerSharingRuleSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: OWNER_RULE_OBJ,
      apiName: 'OwnerRuleObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: OWNER_RULE_ID,
      type: 'SharingRule',
      apiName: 'OwnerRuleObj.OwnerRule',
      parentId: OWNER_RULE_OBJ,
      properties: {
        ruleType: 'owner',
        accessLevel: 'Read',
        sharedToType: 'group',
        sharedToName: 'Sales_Public_Group',
        sharedFromType: 'roleAndSubordinates',
        sharedFromName: 'Sales_VP',
        booleanFilter: null,
        criteriaItemCount: 0,
      },
    }),
    makeNode({ id: SALES_GROUP, type: 'Group', apiName: 'Sales_Public_Group' }),
    makeNode({ id: SALES_REP_ROLE, type: 'Role', apiName: 'Sales_Rep' }),
  ],
  edges: [
    makeEdge({
      fromId: OWNER_RULE_OBJ,
      toId: OWNER_RULE_ID,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: OWNER_RULE_ID,
      toId: SALES_GROUP,
      edgeType: 'sharedWith',
      properties: { direction: 'to' },
    }),
    makeEdge({
      fromId: OWNER_RULE_ID,
      toId: 'Role:Sales_VP',
      edgeType: 'sharedWith',
      properties: { inheritance: 'subordinates', direction: 'from' },
    }),
  ],
};

// =============================================================================
// Seed 4: OWD-Private object with a criteria-type SharingRule. Always
// reports `unknown` with the booleanFilter mentioned in the reason.
// =============================================================================

const CRITERIA_OBJ = 'CustomObject:CriteriaObj';
const CRITERIA_RULE_ID = 'SharingRule:CriteriaObj.CriteriaRule';
const CRITERIA_BOOLEAN_FILTER = '1 OR 2';

const criteriaSharingRuleSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CRITERIA_OBJ,
      apiName: 'CriteriaObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: CRITERIA_RULE_ID,
      type: 'SharingRule',
      apiName: 'CriteriaObj.CriteriaRule',
      parentId: CRITERIA_OBJ,
      properties: {
        ruleType: 'criteria',
        accessLevel: 'Read',
        sharedToType: 'role',
        sharedToName: 'Sales_Rep',
        sharedFromType: null,
        sharedFromName: null,
        booleanFilter: CRITERIA_BOOLEAN_FILTER,
        criteriaItemCount: 2,
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: CRITERIA_OBJ,
      toId: CRITERIA_RULE_ID,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: CRITERIA_RULE_ID,
      toId: SALES_REP_ROLE,
      edgeType: 'sharedWith',
    }),
  ],
};

// =============================================================================
// Seed 5: object with sharingModel: null (e.g., __mdt). OWD short-circuits
// to `unknown`.
// =============================================================================

const MDT_OBJ = 'CustomObject:MyMetadata__mdt';

const owdUnknownSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: MDT_OBJ,
      apiName: 'MyMetadata__mdt',
      properties: { sharingModel: null },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 6: Role hierarchy fixture. Sales_Rep -> Sales_Manager -> Sales_VP
// via inheritsFrom edges. Used for the traversal test.
// =============================================================================

const HIER_OBJ = 'CustomObject:HierObj';
const SALES_MANAGER_ROLE = 'Role:Sales_Manager';
const SALES_VP_ROLE = 'Role:Sales_VP';

const roleHierarchySeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: HIER_OBJ,
      apiName: 'HierObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({ id: SALES_REP_ROLE, type: 'Role', apiName: 'Sales_Rep' }),
    makeNode({ id: SALES_MANAGER_ROLE, type: 'Role', apiName: 'Sales_Manager' }),
    makeNode({ id: SALES_VP_ROLE, type: 'Role', apiName: 'Sales_VP' }),
  ],
  edges: [
    makeEdge({
      fromId: SALES_REP_ROLE,
      toId: SALES_MANAGER_ROLE,
      edgeType: 'inheritsFrom',
    }),
    makeEdge({
      fromId: SALES_MANAGER_ROLE,
      toId: SALES_VP_ROLE,
      edgeType: 'inheritsFrom',
    }),
  ],
};

const RESTRICTION_OBJ = 'CustomObject:RestrictionObj';
const restrictionRuleSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: RESTRICTION_OBJ,
      apiName: 'RestrictionObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: 'RestrictionRule:RestrictionObj.Hide_All',
      type: 'RestrictionRule',
      apiName: 'RestrictionObj.Hide_All',
      parentId: RESTRICTION_OBJ,
    }),
    makeNode({
      id: 'PermissionSetGroup:Ops_Group',
      type: 'PermissionSetGroup',
      apiName: 'Ops_Group',
    }),
  ],
  edges: [],
};

// One shared graph store + Context across the suite. All seeds use
// distinct ids so there's no cross-test interference.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

// =============================================================================
// Seed (god-mode): OWD-Private object + a Profile holding the ViewAllData SYSTEM
// permission on properties.userPermissions, with NO restriction rule. View All
// Data bypasses OWD + sharing → SystemPermission visible.
// =============================================================================

const GODMODE_OBJ = 'CustomObject:GodModeObj';
const GOD_PROFILE = 'Profile:GodAdmin';

const godModeSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: GODMODE_OBJ, apiName: 'GodModeObj', properties: { sharingModel: 'Private' } }),
    makeNode({
      id: GOD_PROFILE,
      type: 'Profile',
      apiName: 'GodAdmin',
      properties: { userPermissions: ['ManageUsers', 'ViewAllData'] },
    }),
    // A non-god-mode profile on the same object, to exercise the restricted path.
    makeNode({
      id: 'Profile:Mortal',
      type: 'Profile',
      apiName: 'Mortal',
      properties: { userPermissions: ['ManageUsers'] },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed (god-mode + restriction): ModifyAllData on a PermissionSet, but the
// object carries an active RestrictionRule that can still filter the user →
// SystemPermission unknown (honesty caveat), not a possibly-wrong visible.
// =============================================================================

const GODMODE_RESTRICTED_OBJ = 'CustomObject:GodModeRestricted';
const SUPER_PS = 'PermissionSet:SuperPS';

const godModeRestrictedSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: GODMODE_RESTRICTED_OBJ,
      apiName: 'GodModeRestricted',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: SUPER_PS,
      type: 'PermissionSet',
      apiName: 'SuperPS',
      properties: { userPermissions: ['ModifyAllData'] },
    }),
    makeNode({
      id: 'RestrictionRule:GodModeRestricted.Only_Mine',
      type: 'RestrictionRule',
      apiName: 'GodModeRestricted.Only_Mine',
      parentId: GODMODE_RESTRICTED_OBJ,
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed (ModifyAllData): OWD-Private object + a PermissionSet with ModifyAllData
// (full god-mode) and NO restriction rule → SystemPermission visible for edit
// AND delete (ModifyAllData satisfies every level; ViewAllData would not).
// =============================================================================

const MAD_OBJ = 'CustomObject:MadObj';
const MAD_PS = 'PermissionSet:MadPS';

const modifyAllSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: MAD_OBJ, apiName: 'MadObj', properties: { sharingModel: 'Private' } }),
    makeNode({
      id: MAD_PS,
      type: 'PermissionSet',
      apiName: 'MadPS',
      properties: { userPermissions: ['ModifyAllData'] },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed (create + record types): one object WITH a record type, and four
// profiles varying object Create permission × record-type visibility. Exercises
// the accessLevel:'create' branch — create needs allowCreate AND (object has no
// RT, or a visible RT). The RT gate is ANDed onto the permission gate.
// =============================================================================

const CREATE_OBJ = 'CustomObject:CreateObj';
const CREATE_RT = 'RecordType:CreateObj.Standard';
const CREATE_OK_PROFILE = 'Profile:CreateOk'; //      allowCreate + visible RT
const CREATE_NORT_PROFILE = 'Profile:CreateNoRt'; //  allowCreate + RT hidden
const CREATE_NOPERM_PROFILE = 'Profile:CreateNoPerm'; // no allowCreate, RT visible
const CREATE_NOVIS_PROFILE = 'Profile:CreateNoVis'; // allowCreate, no RT-vis data

const createWithRtSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: CREATE_OBJ, apiName: 'CreateObj', properties: { sharingModel: 'Private' } }),
    makeNode({
      id: CREATE_RT,
      type: 'RecordType',
      apiName: 'CreateObj.Standard',
      parentId: CREATE_OBJ,
    }),
    makeNode({
      id: CREATE_OK_PROFILE,
      type: 'Profile',
      apiName: 'CreateOk',
      properties: {
        recordTypeVisibilities: [
          { recordType: 'CreateObj.Standard', visible: true, default: true },
        ],
      },
    }),
    makeNode({
      id: CREATE_NORT_PROFILE,
      type: 'Profile',
      apiName: 'CreateNoRt',
      properties: {
        recordTypeVisibilities: [{ recordType: 'CreateObj.Standard', visible: false }],
      },
    }),
    makeNode({
      id: CREATE_NOPERM_PROFILE,
      type: 'Profile',
      apiName: 'CreateNoPerm',
      properties: {
        recordTypeVisibilities: [{ recordType: 'CreateObj.Standard', visible: true }],
      },
    }),
    // allowCreate but NO recordTypeVisibilities at all → RT stage `unknown`.
    makeNode({ id: CREATE_NOVIS_PROFILE, type: 'Profile', apiName: 'CreateNoVis' }),
  ],
  edges: [
    makeEdge({ fromId: CREATE_OBJ, toId: CREATE_RT, edgeType: 'parentOf' }),
    makeEdge({
      fromId: CREATE_OK_PROFILE,
      toId: CREATE_OBJ,
      edgeType: 'grantedBy',
      properties: { allowCreate: true, allowRead: true },
    }),
    makeEdge({
      fromId: CREATE_NORT_PROFILE,
      toId: CREATE_OBJ,
      edgeType: 'grantedBy',
      properties: { allowCreate: true, allowRead: true },
    }),
    makeEdge({
      fromId: CREATE_NOPERM_PROFILE,
      toId: CREATE_OBJ,
      edgeType: 'grantedBy',
      properties: { allowCreate: false, allowRead: true },
    }),
    makeEdge({
      fromId: CREATE_NOVIS_PROFILE,
      toId: CREATE_OBJ,
      edgeType: 'grantedBy',
      properties: { allowCreate: true, allowRead: true },
    }),
  ],
};

// =============================================================================
// Seed (create, object with NO record types): create is not record-type-gated,
// so allowCreate alone makes it `visible`.
// =============================================================================

const CREATE_NORTOBJ = 'CustomObject:CreateNoRtObj';
const CREATE_NORTOBJ_PROFILE = 'Profile:CreateNoRtObjP';

const createNoRtObjSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: CREATE_NORTOBJ, apiName: 'CreateNoRtObj', properties: { sharingModel: 'Private' } }),
    makeNode({ id: CREATE_NORTOBJ_PROFILE, type: 'Profile', apiName: 'CreateNoRtObjP' }),
  ],
  edges: [
    makeEdge({
      fromId: CREATE_NORTOBJ_PROFILE,
      toId: CREATE_NORTOBJ,
      edgeType: 'grantedBy',
      properties: { allowCreate: true },
    }),
  ],
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-why-cant-see-'));
  const dbPath = join(tempDir, 'why-cant-see.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    owdReadSeed,
    owdReadWriteTransferSeed,
    owdControlledByCampaignSeed,
    permissionGrantSeed,
    ownerSharingRuleSeed,
    criteriaSharingRuleSeed,
    owdUnknownSeed,
    roleHierarchySeed,
    restrictionRuleSeed,
    godModeSeed,
    godModeRestrictedSeed,
    modifyAllSeed,
    createWithRtSeed,
    createNoRtObjSeed,
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

describe('whyCantUserSeeRecordHandler', () => {
  it('returns visible after OWD Read; short-circuits the cascade', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: READ_OBJ,
      userContext: { profileId: 'Profile:Standard User' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('visible');
    expect(reasoning.length).toBe(1);
    expect(reasoning[0]?.stage).toBe('OWD');
    expect(reasoning[0]?.verdict).toBe('visible');
    expect(reasoning[0]?.reason).toContain('Read');
    // The vaultState carries the manifest hash and timestamp.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('classifies OWD ReadWriteTransfer as visible (Public Read/Write/Transfer)', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RWT_OBJ,
      userContext: { profileId: 'Profile:Standard User' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    // ReadWriteTransfer (the Lead/Case OWD) is a PUBLIC read-or-better setting —
    // it must short-circuit visible, NOT fall through to 'unrecognised OWD value'.
    expect(verdict).toBe('visible');
    expect(reasoning[0]?.stage).toBe('OWD');
    expect(reasoning[0]?.verdict).toBe('visible');
  });

  it('classifies OWD ControlledByCampaign as restricted at the OWD stage', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: CBC_OBJ,
      userContext: { profileId: 'Profile:Standard User' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { reasoning } = result.value.data;
    // ControlledByCampaign (the CampaignMember OWD) is access-controlled by the
    // parent Campaign — restricted at OWD like ControlledByParent, NOT 'unknown'.
    expect(reasoning[0]?.stage).toBe('OWD');
    expect(reasoning[0]?.verdict).toBe('restricted');
  });

  it('returns visible when an OWD-Private object has a PermissionGrant override', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PRIVATE_OBJ,
      userContext: { profileId: ADMIN_PROFILE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('visible');
    // First step is OWD restricted, second is PermissionGrant visible.
    const owd = reasoning.find((s) => s.stage === 'OWD');
    expect(owd?.verdict).toBe('restricted');
    const grant = reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('visible');
    expect(grant?.reason).toContain(ADMIN_PROFILE);
  });

  it('returns visible when a profile has the ViewAllData system permission (god-mode bypasses OWD)', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: GODMODE_OBJ,
      userContext: { profileId: GOD_PROFILE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('visible');
    const owd = reasoning.find((s) => s.stage === 'OWD');
    expect(owd?.verdict).toBe('restricted'); // OWD is Private…
    const sys = reasoning.find((s) => s.stage === 'SystemPermission');
    expect(sys?.verdict).toBe('visible'); // …but View All Data overrides it.
    expect(sys?.reason).toContain('ViewAllData');
  });

  it('reports SystemPermission restricted for a profile WITHOUT View All / Modify All Data', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: GODMODE_OBJ,
      userContext: { profileId: 'Profile:Mortal' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sys = result.value.data.reasoning.find((s) => s.stage === 'SystemPermission');
    expect(sys?.verdict).toBe('restricted');
    // Without god-mode this step does not grant access (other stages decide).
    expect(result.value.data.verdict).not.toBe('visible');
  });

  it('object-CRUD hard gate: a supplied profile with no object grant and no god-mode is restricted, not unknown (bug 21)', async () => {
    // Profile:Mortal has no grantedBy edge on the Private GodModeObj and no
    // View/Modify-All Data. Object access is a hard pre-condition for record
    // access, so the unknown record-level sharing tail (territory / manual /
    // sets / teams) cannot grant it — the answer is a definitive `restricted`,
    // not `unknown`.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: GODMODE_OBJ,
      userContext: { profileId: 'Profile:Mortal' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(
      reasoning.find((s) => s.stage === 'PermissionGrant')?.verdict,
    ).toBe('restricted');
    expect(
      reasoning.find((s) => s.stage === 'SystemPermission')?.verdict,
    ).toBe('restricted');
    // The record-level tail is still surfaced as unknown for manual review…
    expect(
      reasoning.find((s) => s.stage === 'ManualSharing')?.verdict,
    ).toBe('unknown');
    // …but the aggregate is restricted: object access is denied, sharing moot.
    expect(verdict).toBe('restricted');
  });

  it('downgrades god-mode to unknown when an active restriction rule can still filter the user', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: GODMODE_RESTRICTED_OBJ,
      userContext: { permissionSetIds: [SUPER_PS] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    const sys = reasoning.find((s) => s.stage === 'SystemPermission');
    // ModifyAllData would bypass OWD, but a restriction rule can still filter the
    // user — undecidable from metadata, so honest `unknown`, never a wrong visible.
    expect(sys?.verdict).toBe('unknown');
    expect(sys?.reason).toContain('restriction rule');
    expect(verdict).not.toBe('visible');
  });

  it('returns visible when an OwnerSharingRule grants access to the user group', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: OWNER_RULE_OBJ,
      userContext: { groupIds: [SALES_GROUP] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('visible');
    // OWD restricted, no PermissionGrant override, OwnerSharingRule visible.
    const owd = reasoning.find((s) => s.stage === 'OWD');
    expect(owd?.verdict).toBe('restricted');
    const grant = reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('restricted');
    const ownerSteps = reasoning.filter((s) => s.stage === 'OwnerSharingRule');
    expect(ownerSteps.length).toBe(1);
    expect(ownerSteps[0]?.verdict).toBe('visible');
    expect(ownerSteps[0]?.reason).toContain(OWNER_RULE_ID);
    expect(ownerSteps[0]?.reason).toContain(SALES_GROUP);
  });

  it('returns unknown for a CriteriaSharingRule and surfaces the booleanFilter', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: CRITERIA_OBJ,
      userContext: { roleId: SALES_REP_ROLE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    const criteria = reasoning.filter(
      (s) => s.stage === 'CriteriaSharingRule',
    );
    expect(criteria.length).toBe(1);
    expect(criteria[0]?.verdict).toBe('unknown');
    expect(criteria[0]?.reason).toContain(CRITERIA_BOOLEAN_FILTER);
    expect(criteria[0]?.reason).toContain(CRITERIA_RULE_ID);
    // Aggregate verdict is unknown — no visible step before this
    // unknown one.
    expect(verdict).toBe('unknown');
  });

  it('always reports ManualSharing as unknown with the documented reason', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: CRITERIA_OBJ,
      userContext: { roleId: SALES_REP_ROLE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manual = result.value.data.reasoning.find(
      (s) => s.stage === 'ManualSharing',
    );
    expect(manual).toBeDefined();
    expect(manual?.verdict).toBe('unknown');
    expect(manual?.reason).toContain('record-level');
    // The trailing stages appear: TerritoryAndGuestRules, ManualSharing,
    // SharingSets, AccountTeams.
    const territoryGuest = result.value.data.reasoning.find(
      (s) => s.stage === 'TerritoryAndGuestRules',
    );
    expect(territoryGuest?.verdict).toBe('unknown');
    expect(territoryGuest?.reason).toMatch(/territory|guest/i);
    const sharingSets = result.value.data.reasoning.find(
      (s) => s.stage === 'SharingSets',
    );
    const accountTeams = result.value.data.reasoning.find(
      (s) => s.stage === 'AccountTeams',
    );
    expect(sharingSets?.verdict).toBe('unknown');
    expect(accountTeams?.verdict).toBe('unknown');
  });

  it('short-circuits with a single OWD step when sharingModel is null', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: MDT_OBJ,
      userContext: { profileId: ADMIN_PROFILE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('unknown');
    expect(reasoning.length).toBe(1);
    expect(reasoning[0]?.stage).toBe('OWD');
    expect(reasoning[0]?.verdict).toBe('unknown');
    expect(reasoning[0]?.reason).toContain('OWD not defined');
  });

  it('refuses an unknown componentId with component-not-found', async () => {
    // Regression for journal 0160: an id that doesn't resolve to a
    // node used to surface as a single OWD step with `verdict: unknown`
    // and `reason: 'component not found'` inside the data envelope —
    // silent accept that hid typos behind a real-looking cascade. The
    // handler now returns the canonical `component-not-found` error
    // envelope (matches `get-component`, `explain-apex-method`, and
    // the rest of the v0.1+ tools).
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: 'CustomObject:DoesNotExist',
      userContext: { profileId: ADMIN_PROFILE },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toMatch(/CustomObject:DoesNotExist/);
    expect(result.error.message).toMatch(/no component matches/);
    expect(result.error.path).toBe('CustomObject:DoesNotExist');
  });

  it('walks the role hierarchy and reports parents in `traversed`', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: HIER_OBJ,
      userContext: { roleId: SALES_REP_ROLE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const roleStep = result.value.data.reasoning.find(
      (s) => s.stage === 'RoleHierarchy',
    );
    expect(roleStep?.verdict).toBe('unknown');
    expect(roleStep?.traversed).toEqual([SALES_MANAGER_ROLE, SALES_VP_ROLE]);
    expect(roleStep?.reason).toContain('2 level');
  });

  // --- accessLevel: read vs edit vs delete (P11-ACCESS-edit-verdict) ---

  it('a Read OWD is visible for read but NOT for edit (read-only is not edit-capable)', async () => {
    const read = await whyCantUserSeeRecordHandler(ctx, {
      componentId: READ_OBJ,
      userContext: { profileId: 'Profile:Standard User' },
    });
    const edit = await whyCantUserSeeRecordHandler(ctx, {
      componentId: READ_OBJ,
      accessLevel: 'edit',
      userContext: { profileId: 'Profile:Standard User' },
    });
    expect(read.ok && edit.ok).toBe(true);
    if (!read.ok || !edit.ok) return;
    expect(read.value.data.verdict).toBe('visible'); // OWD Read → read visible
    const owdEdit = edit.value.data.reasoning.find((s) => s.stage === 'OWD');
    expect(owdEdit?.verdict).toBe('restricted'); // …but not edit-capable
    expect(owdEdit?.reason).toContain('edit');
    expect(edit.value.data.verdict).not.toBe('visible');
  });

  it('a ReadWrite (ReadWriteTransfer) OWD is visible for edit but NOT for delete', async () => {
    const edit = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RWT_OBJ,
      accessLevel: 'edit',
      userContext: { profileId: 'Profile:Standard User' },
    });
    const del = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RWT_OBJ,
      accessLevel: 'delete',
      userContext: { profileId: 'Profile:Standard User' },
    });
    expect(edit.ok && del.ok).toBe(true);
    if (!edit.ok || !del.ok) return;
    expect(edit.value.data.verdict).toBe('visible'); // ReadWrite OWD → edit visible
    const owdDel = del.value.data.reasoning.find((s) => s.stage === 'OWD');
    expect(owdDel?.verdict).toBe('restricted'); // delete needs FullAccess
    expect(owdDel?.reason).toContain('delete');
    expect(del.value.data.verdict).not.toBe('visible');
  });

  it('ViewAllData grants read god-mode but NOT edit; ModifyAllData grants edit AND delete', async () => {
    // ViewAllData is read-only.
    const vadEdit = await whyCantUserSeeRecordHandler(ctx, {
      componentId: GODMODE_OBJ,
      accessLevel: 'edit',
      userContext: { profileId: GOD_PROFILE },
    });
    expect(vadEdit.ok).toBe(true);
    if (!vadEdit.ok) return;
    const sysVad = vadEdit.value.data.reasoning.find((s) => s.stage === 'SystemPermission');
    expect(sysVad?.verdict).toBe('restricted');
    expect(vadEdit.value.data.verdict).not.toBe('visible');

    // ModifyAllData is full god-mode → edit and delete both visible.
    for (const lvl of ['edit', 'delete'] as const) {
      const r = await whyCantUserSeeRecordHandler(ctx, {
        componentId: MAD_OBJ,
        accessLevel: lvl,
        userContext: { permissionSetIds: [MAD_PS] },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const sys = r.value.data.reasoning.find((s) => s.stage === 'SystemPermission');
      expect(sys?.verdict).toBe('visible');
      expect(r.value.data.verdict).toBe('visible');
    }
  });

  // === accessLevel: 'create' (P11-ACCESS-create-verdict) ====================

  it('create is visible with allowCreate AND a visible record type', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: CREATE_OBJ,
      accessLevel: 'create',
      userContext: { profileId: CREATE_OK_PROFILE },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('visible');
    const grant = r.value.data.reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('visible');
    const rt = r.value.data.reasoning.find((s) => s.stage === 'RecordType');
    expect(rt?.verdict).toBe('visible');
    // Create short-circuits the sharing cascade — no OWD / sharing-rule stages.
    const stages = r.value.data.reasoning.map((s) => s.stage);
    expect(stages).not.toContain('OWD');
    expect(stages).not.toContain('OwnerSharingRule');
    expect(stages).not.toContain('RoleHierarchy');
  });

  it('create is restricted with allowCreate but NO visible record type', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: CREATE_OBJ,
      accessLevel: 'create',
      userContext: { profileId: CREATE_NORT_PROFILE },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('restricted');
    const grant = r.value.data.reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('visible'); // has the Create permission…
    const rt = r.value.data.reasoning.find((s) => s.stage === 'RecordType');
    expect(rt?.verdict).toBe('restricted'); // …but no record type to pick
  });

  it('create is restricted without the Create object permission', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: CREATE_OBJ,
      accessLevel: 'create',
      userContext: { profileId: CREATE_NOPERM_PROFILE },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('restricted');
    const grant = r.value.data.reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('restricted');
  });

  it('create is unknown when the object has record types but no visibility data', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: CREATE_OBJ,
      accessLevel: 'create',
      userContext: { profileId: CREATE_NOVIS_PROFILE },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('unknown');
    const rt = r.value.data.reasoning.find((s) => s.stage === 'RecordType');
    expect(rt?.verdict).toBe('unknown');
  });

  it('create is visible with allowCreate when the object has NO record types', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: CREATE_NORTOBJ,
      accessLevel: 'create',
      userContext: { profileId: CREATE_NORTOBJ_PROFILE },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('visible');
    const rt = r.value.data.reasoning.find((s) => s.stage === 'RecordType');
    expect(rt?.verdict).toBe('visible');
    expect(rt?.reason).toContain('no record types');
  });

  it('ModifyAllData grants create even on a Private object with no record types', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: MAD_OBJ,
      accessLevel: 'create',
      userContext: { permissionSetIds: [MAD_PS] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('visible');
    const sys = r.value.data.reasoning.find((s) => s.stage === 'SystemPermission');
    expect(sys?.verdict).toBe('visible');
  });
});

describe('whyCantUserSeeRecordInputSchema', () => {
  it('accepts a minimal input with just a profileId', () => {
    const parsed = whyCantUserSeeRecordInputSchema.safeParse({
      componentId: 'CustomObject:Account',
      userContext: { profileId: 'Profile:Standard User' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an input with just a non-empty permissionSetIds array', () => {
    const parsed = whyCantUserSeeRecordInputSchema.safeParse({
      componentId: 'CustomObject:Account',
      userContext: { permissionSetIds: ['PermissionSet:Sales_User'] },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an input with just a roleId', () => {
    const parsed = whyCantUserSeeRecordInputSchema.safeParse({
      componentId: 'CustomObject:Account',
      userContext: { roleId: 'Role:Sales_Rep' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an input with just a non-empty groupIds array', () => {
    const parsed = whyCantUserSeeRecordInputSchema.safeParse({
      componentId: 'CustomObject:Account',
      userContext: { groupIds: ['Group:Sales_Public_Group'] },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty userContext (none of the four fields supplied)', () => {
    const parsed = whyCantUserSeeRecordInputSchema.safeParse({
      componentId: 'CustomObject:Account',
      userContext: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a userContext whose permissionSetIds is empty and nothing else is set', () => {
    const parsed = whyCantUserSeeRecordInputSchema.safeParse({
      componentId: 'CustomObject:Account',
      userContext: { permissionSetIds: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty componentId', () => {
    const parsed = whyCantUserSeeRecordInputSchema.safeParse({
      componentId: '',
      userContext: { profileId: 'Profile:Standard User' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty profileId string within userContext', () => {
    const parsed = whyCantUserSeeRecordInputSchema.safeParse({
      componentId: 'CustomObject:Account',
      userContext: { profileId: '' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing userContext entirely', () => {
    const parsed = whyCantUserSeeRecordInputSchema.safeParse({
      componentId: 'CustomObject:Account',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('whyCantUserSeeRecordHandler — restriction rules and PSG boundaries', () => {
  it('surfaces RestrictionRule stage as unknown when rules exist on the object', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RESTRICTION_OBJ,
      userContext: { profileId: 'Profile:System Administrator' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The supplied admin profile has no object grant on RestrictionObj and no
    // View/Modify-All, so object access is denied (hard gate) → `restricted`.
    // The RestrictionRule stage is still surfaced as `unknown` for review —
    // a restriction rule can only further filter access, never grant it.
    expect(result.value.data.verdict).toBe('restricted');
    const rr = result.value.data.reasoning.find((s) => s.stage === 'RestrictionRule');
    expect(rr?.verdict).toBe('unknown');
    expect(rr?.reason).toContain('restriction rule');
  });

  it('surfaces PermissionSetGroup boundary when groups exist in vault', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RESTRICTION_OBJ,
      userContext: { permissionSetIds: ['PermissionSet:Some_PS'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const psg = result.value.data.reasoning.find((s) => s.stage === 'PermissionSetGroup');
    expect(psg?.verdict).toBe('unknown');
    expect(psg?.reason).toContain('permission set group');
  });
});

// =============================================================================
// userContext apiName coercion — a caller may pass `profileId: 'Admin'`
// instead of 'Profile:Admin'. The load-bearing property is PERMISSION
// CORRECTNESS: a coerced (bare-name) context must yield the EXACT same verdict
// and reasoning as the equivalent prefixed-id context. We assert byte-identity
// of the full response, and (for the profile path) that the verdict is the
// grant-driven `visible` — which a bare, UNcoerced name could never have
// reached, since the grant edge is from `Profile:System Administrator`.
// =============================================================================
describe('whyCantUserSeeRecordHandler: userContext apiName coercion', () => {
  const runBoth = async (
    componentId: string,
    prefixed: Record<string, unknown>,
    bare: Record<string, unknown>,
  ) => {
    const a = await whyCantUserSeeRecordHandler(ctx, {
      componentId,
      userContext: prefixed,
    } as never);
    const b = await whyCantUserSeeRecordHandler(ctx, {
      componentId,
      userContext: bare,
    } as never);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Verdict-preserving: bare-name context == prefixed-id context, in full.
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    return a;
  };

  it('profileId: bare name == prefixed, and the grant still drives visible', async () => {
    const r = await runBoth(
      PRIVATE_OBJ,
      { profileId: 'Profile:System Administrator' },
      { profileId: 'System Administrator' },
    );
    if (!r.ok) return;
    // The grant edge is from `Profile:System Administrator`; reaching `visible`
    // from the bare 'System Administrator' proves coercion matched the grant.
    expect(r.value.data.verdict).toBe('visible');
  });

  it('groupIds: bare name == prefixed (graph-disambiguated Group/Queue)', async () => {
    await runBoth(
      OWNER_RULE_OBJ,
      { groupIds: ['Group:Sales_Public_Group'] },
      { groupIds: ['Sales_Public_Group'] },
    );
  });

  it('roleId: bare name == prefixed', async () => {
    await runBoth(
      OWNER_RULE_OBJ,
      { roleId: 'Role:Sales_Rep' },
      { roleId: 'Sales_Rep' },
    );
  });

  it('permissionSetIds: bare names == prefixed', async () => {
    await runBoth(
      PRIVATE_OBJ,
      { permissionSetIds: ['PermissionSet:Some_PS'] },
      { permissionSetIds: ['Some_PS'] },
    );
  });

  it('a WRONG-type id (already prefixed) passes through unchanged and grants nothing', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PRIVATE_OBJ,
      userContext: { profileId: 'CustomObject:Account' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A CustomObject id never matches a grantedBy edge -> not visible-by-grant,
    // and crucially: no crash, honest cascade.
    expect(r.value.data.verdict).not.toBe('visible');
  });
});
