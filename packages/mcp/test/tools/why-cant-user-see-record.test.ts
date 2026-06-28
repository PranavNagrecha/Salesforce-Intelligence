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
    CustomObject: 8,
    Profile: 1,
    PermissionSet: 1,
    Role: 9,
    Group: 1,
    SharingRule: 8,
  },
  edges: { grantedBy: 1, parentOf: 8, sharedWith: 8, inheritsFrom: 6 },
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
const CBC_READER_PROFILE = 'Profile:CbcReader';

const owdControlledByCampaignSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CBC_OBJ,
      apiName: 'CampaignMember',
      properties: { sharingModel: 'ControlledByCampaign' },
    }),
    // CR-03: a profile with object Read so the precondition passes and the OWD
    // stage is reached — this test asserts the OWD's restricted CLASSIFICATION.
    makeNode({ id: CBC_READER_PROFILE, type: 'Profile', apiName: 'CbcReader' }),
  ],
  edges: [
    makeEdge({
      fromId: CBC_READER_PROFILE,
      toId: CBC_OBJ,
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
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
// Seed 3b (CR-CAP-12): OWD-Private object with an owner rule shared with an
// ENCLOSING public group. The user is a literal member ONLY of a NESTED group
// (`Group:Enclosing_PG --hasMember--> Group:Nested_PG`). Before CR-CAP-12 the
// literal membership set held only `Group:Nested_PG`, so the rule granting
// `Group:Enclosing_PG` did NOT match (restricted). After: the upward hasMember
// walk folds `Group:Enclosing_PG` into membership → visible.
// =============================================================================

const NESTED_RULE_OBJ = 'CustomObject:NestedGroupObj';
const NESTED_RULE_ID = 'SharingRule:NestedGroupObj.GrantEnclosing';
const ENCLOSING_PG = 'Group:Enclosing_PG';
const NESTED_PG = 'Group:Nested_PG';

const nestedGroupOwnerRuleSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NESTED_RULE_OBJ,
      apiName: 'NestedGroupObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: NESTED_RULE_ID,
      type: 'SharingRule',
      apiName: 'NestedGroupObj.GrantEnclosing',
      parentId: NESTED_RULE_OBJ,
      properties: {
        ruleType: 'owner',
        accessLevel: 'Read',
        sharedToType: 'group',
        sharedToName: 'Enclosing_PG',
        sharedFromType: 'group',
        sharedFromName: 'Enclosing_PG',
        booleanFilter: null,
        criteriaItemCount: 0,
      },
    }),
    makeNode({ id: ENCLOSING_PG, type: 'Group', apiName: 'Enclosing_PG' }),
    makeNode({ id: NESTED_PG, type: 'Group', apiName: 'Nested_PG' }),
  ],
  edges: [
    makeEdge({
      fromId: NESTED_RULE_OBJ,
      toId: NESTED_RULE_ID,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: NESTED_RULE_ID,
      toId: ENCLOSING_PG,
      edgeType: 'sharedWith',
      properties: { direction: 'to' },
    }),
    makeEdge({
      fromId: NESTED_RULE_ID,
      toId: ENCLOSING_PG,
      edgeType: 'sharedWith',
      properties: { direction: 'from' },
    }),
    // The enclosing public group CONTAINS the nested group as a member.
    makeEdge({
      fromId: ENCLOSING_PG,
      toId: NESTED_PG,
      edgeType: 'hasMember',
      source: 'group-extractor',
      properties: { memberType: 'Group' },
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
// Seed 4b (CR-CAP-16): OWD-Private object with a GUEST sharing rule. The
// TerritoryAndGuestRules stage must report `unknown` per rule with the rule id /
// site / predicate in the reason, and the aggregate stays `unknown`.
// =============================================================================

const GUEST_OBJ = 'CustomObject:GuestObj';
const GUEST_RULE_ID = 'SharingRule:GuestObj.Share_To_ClientPortal';

const guestSharingRuleSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: GUEST_OBJ,
      apiName: 'GuestObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: GUEST_RULE_ID,
      type: 'SharingRule',
      apiName: 'GuestObj.Share_To_ClientPortal',
      parentId: GUEST_OBJ,
      properties: {
        ruleType: 'guest',
        accessLevel: 'Read',
        sharedToType: 'guestUser',
        sharedToName: 'ClientPortal',
        sharedFromType: null,
        sharedFromName: null,
        booleanFilter: '1 AND 2',
        criteriaItemCount: 2,
        siteName: 'ClientPortal',
      },
    }),
    makeNode({ id: 'Group:ClientPortal', type: 'Group', apiName: 'ClientPortal' }),
  ],
  edges: [
    makeEdge({
      fromId: GUEST_OBJ,
      toId: GUEST_RULE_ID,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: GUEST_RULE_ID,
      toId: 'Group:ClientPortal',
      edgeType: 'sharedWith',
      properties: { synthetic: true, siteName: 'ClientPortal' },
    }),
  ],
};

// =============================================================================
// Seed 4c (CR-CAP-16): OWD-Private object with NO guest/territory rules. The
// TerritoryAndGuestRules stage must preserve the absence disclosure as
// `unknown`, never `restricted`.
// =============================================================================

const NO_GUEST_OBJ = 'CustomObject:NoGuestObj';

const noGuestRuleSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NO_GUEST_OBJ,
      apiName: 'NoGuestObj',
      properties: { sharingModel: 'Private' },
    }),
  ],
  edges: [],
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

// =============================================================================
// Seed 6b (CR-CAP-05): owner-based SharingRule whose RECEIVER (sharedTo) target
// is a role marked `roleAndSubordinates` (inheritance: 'subordinates'). The
// rule must reach the named role AND every role below it in the hierarchy.
//
// Hierarchy: Sales_VP (top) <- Sales_Manager <- Sales_Rep (subordinate chain
// via inheritsFrom child->parent). Service_Agent is an unrelated top role.
//
// The existing `ownerSharingRuleSeed` puts the inheritance marker on the SOURCE
// (`direction: 'from'`) edge and a plain Group on the receiver side, so it never
// exercised receiver-subtree expansion — this seed does.
// =============================================================================

const SUB_OBJ = 'CustomObject:SubObj';
const SUB_RULE_ID = 'SharingRule:SubObj.SubRule';
// Distinct role ids (Cap*) so this subtree does NOT collide with the
// roleHierarchySeed Sales_* roles — keeps the seeds independent and the
// FIXTURE_MANIFEST counts unambiguous.
const SUB_VP_ROLE = 'Role:Cap_VP';
const SUB_MANAGER_ROLE = 'Role:Cap_Manager';
const SUB_REP_ROLE = 'Role:Cap_Rep';
const SERVICE_AGENT_ROLE = 'Role:Cap_Service_Agent';

const ownerSubordinateRuleSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: SUB_OBJ,
      apiName: 'SubObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: SUB_RULE_ID,
      type: 'SharingRule',
      apiName: 'SubObj.SubRule',
      parentId: SUB_OBJ,
      properties: {
        ruleType: 'owner',
        accessLevel: 'Read',
        sharedToType: 'roleAndSubordinates',
        sharedToName: 'Cap_VP',
        sharedFromType: 'group',
        sharedFromName: 'Some_Source_Group',
        booleanFilter: null,
        criteriaItemCount: 0,
      },
    }),
    makeNode({ id: SUB_VP_ROLE, type: 'Role', apiName: 'Cap_VP' }),
    makeNode({ id: SUB_MANAGER_ROLE, type: 'Role', apiName: 'Cap_Manager' }),
    makeNode({ id: SUB_REP_ROLE, type: 'Role', apiName: 'Cap_Rep' }),
    makeNode({ id: SERVICE_AGENT_ROLE, type: 'Role', apiName: 'Cap_Service_Agent' }),
  ],
  edges: [
    makeEdge({ fromId: SUB_OBJ, toId: SUB_RULE_ID, edgeType: 'parentOf' }),
    // The RECEIVER (sharedTo) edge under test: roleAndSubordinates -> Sales_VP.
    makeEdge({
      fromId: SUB_RULE_ID,
      toId: SUB_VP_ROLE,
      edgeType: 'sharedWith',
      properties: { inheritance: 'subordinates', direction: 'to' },
    }),
    // inheritsFrom is child -> parent. Sales_Rep is a subordinate of Sales_VP
    // (two rungs down), so its ancestor chain is [Sales_Manager, Sales_VP].
    makeEdge({
      fromId: SUB_REP_ROLE,
      toId: SUB_MANAGER_ROLE,
      edgeType: 'inheritsFrom',
    }),
    makeEdge({
      fromId: SUB_MANAGER_ROLE,
      toId: SUB_VP_ROLE,
      edgeType: 'inheritsFrom',
    }),
  ],
};

// =============================================================================
// Seed 6c (CR-CAP-05): a PLAIN-role owner rule (NO inheritance marker) whose
// sharedTo target is Sales_VP. A plain `role` rule reaches ONLY the named role;
// a subordinate (Sales_Rep) must NOT match it. Guards the false-grant class.
// Reuses the Sales_* roles seeded in `ownerSubordinateRuleSeed`.
// =============================================================================

const PLAIN_ROLE_OBJ = 'CustomObject:PlainRoleObj';
const PLAIN_ROLE_RULE_ID = 'SharingRule:PlainRoleObj.PlainRule';

const ownerPlainRoleRuleSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PLAIN_ROLE_OBJ,
      apiName: 'PlainRoleObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: PLAIN_ROLE_RULE_ID,
      type: 'SharingRule',
      apiName: 'PlainRoleObj.PlainRule',
      parentId: PLAIN_ROLE_OBJ,
      properties: {
        ruleType: 'owner',
        accessLevel: 'Read',
        sharedToType: 'role',
        sharedToName: 'Cap_VP',
        sharedFromType: 'group',
        sharedFromName: 'Some_Source_Group',
        booleanFilter: null,
        criteriaItemCount: 0,
      },
    }),
  ],
  edges: [
    makeEdge({ fromId: PLAIN_ROLE_OBJ, toId: PLAIN_ROLE_RULE_ID, edgeType: 'parentOf' }),
    // Plain role receiver — NO inheritance prop, so named role only.
    makeEdge({
      fromId: PLAIN_ROLE_RULE_ID,
      toId: SUB_VP_ROLE,
      edgeType: 'sharedWith',
      properties: { direction: 'to' },
    }),
  ],
};

// =============================================================================
// Seed 6d (CR-CAP-05): an Edit-level owner rule whose sharedTo target is
// roleAndSubordinates -> Sales_VP. Proves the subordinate match still composes
// with the access-level gate: a subordinate (Sales_Rep) gets `visible` for read
// but `restricted` for edit (Read rule grants Read, not edit). Distinct object
// + Edit-rule so it stacks alongside the Read SubRule without two owner steps.
// =============================================================================

const SUB_EDIT_OBJ = 'CustomObject:SubEditObj';
const SUB_EDIT_RULE_ID = 'SharingRule:SubEditObj.SubEditRule';

const ownerSubordinateReadRuleForLevelSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: SUB_EDIT_OBJ,
      apiName: 'SubEditObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: SUB_EDIT_RULE_ID,
      type: 'SharingRule',
      apiName: 'SubEditObj.SubEditRule',
      parentId: SUB_EDIT_OBJ,
      properties: {
        ruleType: 'owner',
        accessLevel: 'Read',
        sharedToType: 'roleAndSubordinates',
        sharedToName: 'Cap_VP',
        sharedFromType: 'group',
        sharedFromName: 'Some_Source_Group',
        booleanFilter: null,
        criteriaItemCount: 0,
      },
    }),
  ],
  edges: [
    makeEdge({ fromId: SUB_EDIT_OBJ, toId: SUB_EDIT_RULE_ID, edgeType: 'parentOf' }),
    makeEdge({
      fromId: SUB_EDIT_RULE_ID,
      toId: SUB_VP_ROLE,
      edgeType: 'sharedWith',
      properties: { inheritance: 'subordinates', direction: 'to' },
    }),
  ],
};

// =============================================================================
// Seed 6e (CR-CAP-05 honesty): an owner rule whose sharedTo target is
// roleAndSubordinates -> Cap_VP (a role that IS retrieved). But an INTERMEDIATE
// role on the user's ancestor chain (Cap_Mid_Missing) was NOT retrieved, so the
// upward walk from Cap_Rep_Trunc truncates at the missing node and never reaches
// Cap_VP — the ancestor set is SHORT and the (real) subordinate relationship is
// MISSED. An inheritance-gated NON-match on a truncated chain must downgrade to
// `unknown` (never a confident false-deny). The reason names the target role and
// points to a refresh.
// =============================================================================

const TRUNC_OBJ = 'CustomObject:TruncObj';
const TRUNC_RULE_ID = 'SharingRule:TruncObj.TruncRule';
// The rule's sharedTo target role — present, and the reason should name it.
const TRUNC_TARGET_ROLE = SUB_VP_ROLE; // 'Role:Cap_VP'
const TRUNC_MISSING_MID_ROLE = 'Role:Cap_Mid_Missing';
const TRUNC_REP_ROLE = 'Role:Cap_Rep_Trunc';

const ownerSubordinateTruncatedSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TRUNC_OBJ,
      apiName: 'TruncObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: TRUNC_RULE_ID,
      type: 'SharingRule',
      apiName: 'TruncObj.TruncRule',
      parentId: TRUNC_OBJ,
      properties: {
        ruleType: 'owner',
        accessLevel: 'Read',
        sharedToType: 'roleAndSubordinates',
        sharedToName: 'Cap_VP',
        sharedFromType: 'group',
        sharedFromName: 'Some_Source_Group',
        booleanFilter: null,
        criteriaItemCount: 0,
      },
    }),
    // The subordinate role node IS present; the INTERMEDIATE role node is NOT.
    makeNode({ id: TRUNC_REP_ROLE, type: 'Role', apiName: 'Cap_Rep_Trunc' }),
    // NOTE: Role:Cap_Mid_Missing deliberately NOT seeded as a node, and
    // Cap_Mid_Missing -> Cap_VP is NOT seeded either, so the walk cannot reach
    // the (present) Cap_VP target.
  ],
  edges: [
    makeEdge({ fromId: TRUNC_OBJ, toId: TRUNC_RULE_ID, edgeType: 'parentOf' }),
    makeEdge({
      fromId: TRUNC_RULE_ID,
      toId: TRUNC_TARGET_ROLE,
      edgeType: 'sharedWith',
      properties: { inheritance: 'subordinates', direction: 'to' },
    }),
    // The subordinate inherits from the MISSING intermediate role — the walk
    // adds Cap_Mid_Missing to the chain, then hits its missing node and
    // truncates BEFORE reaching the target Cap_VP.
    makeEdge({
      fromId: TRUNC_REP_ROLE,
      toId: TRUNC_MISSING_MID_ROLE,
      edgeType: 'inheritsFrom',
    }),
  ],
};

const RESTRICTION_OBJ = 'CustomObject:RestrictionObj';
const RESTRICTION_PS = 'PermissionSet:Some_PS';
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
    // CR-03: a permission set with object Read on RestrictionObj so the
    // object-Read precondition passes and the cascade reaches the RestrictionRule
    // / PermissionSetGroup stages (which the boundary tests assert).
    makeNode({ id: RESTRICTION_PS, type: 'PermissionSet', apiName: 'Some_PS' }),
  ],
  edges: [
    makeEdge({
      fromId: RESTRICTION_PS,
      toId: RESTRICTION_OBJ,
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
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
    // CR-03: it holds plain object Read so the object-Read precondition passes
    // and the cascade reaches the SystemPermission stage (which then reports
    // `restricted` — no View/Modify All Data).
    makeNode({
      id: 'Profile:Mortal',
      type: 'Profile',
      apiName: 'Mortal',
      properties: { userPermissions: ['ManageUsers'] },
    }),
    // CR-03: a profile with ZERO object access on this object — used to exercise
    // the object-Read precondition hard-deny (bug 21).
    makeNode({
      id: 'Profile:NoAccess',
      type: 'Profile',
      apiName: 'NoAccess',
      properties: { userPermissions: ['ManageUsers'] },
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'Profile:Mortal',
      toId: GODMODE_OBJ,
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
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

// =============================================================================
// CR-03 (two-plane access model) seeds.
//
// The OWD-public objects above (READ_OBJ, RWT_OBJ) carry NO grantedBy edges, so
// a `Profile:Standard User` queried against them has ZERO object Read — under
// the corrected model a public OWD does NOT make a record visible without object
// Read (plane A). These seeds add a profile that legitimately HAS object Read on
// a public object so the OWD read/edit/delete ladder can still be exercised, and
// a Private object where the profile holds only plain object CRUD (the H2 case).
// =============================================================================

// A profile with object READ CRUD on a Public-Read object (no View/Modify All).
// On a public OWD the precondition is met → OWD grants record visibility.
const PUB_READ_OBJ = 'CustomObject:PubReadObj';
const READER_PROFILE = 'Profile:ObjReader';

const pubReadWithGrantSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: PUB_READ_OBJ, apiName: 'PubReadObj', properties: { sharingModel: 'Read' } }),
    makeNode({ id: READER_PROFILE, type: 'Profile', apiName: 'ObjReader' }),
  ],
  edges: [
    makeEdge({
      fromId: READER_PROFILE,
      toId: PUB_READ_OBJ,
      edgeType: 'grantedBy',
      // Plain object Read + Edit (NO viewAllRecords / modifyAllRecords): the
      // object precondition is satisfied and Edit implies Read.
      properties: { allowRead: true, allowEdit: true },
    }),
  ],
};

// A profile with object READ + EDIT CRUD on a Public Read/Write/Transfer object.
const PUB_RWT_OBJ = 'CustomObject:PubRwtObj';
const EDITOR_PROFILE = 'Profile:ObjEditor';

const pubRwtWithGrantSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: PUB_RWT_OBJ, apiName: 'PubRwtObj', properties: { sharingModel: 'ReadWriteTransfer' } }),
    makeNode({ id: EDITOR_PROFILE, type: 'Profile', apiName: 'ObjEditor' }),
  ],
  edges: [
    makeEdge({
      fromId: EDITOR_PROFILE,
      toId: PUB_RWT_OBJ,
      edgeType: 'grantedBy',
      properties: { allowRead: true, allowEdit: true, allowDelete: true },
    }),
  ],
};

// H2: a PRIVATE object + a profile with plain object Edit/Delete CRUD only
// (modifyAllRecords:false, viewAllRecords:false). Object CRUD satisfies the
// precondition (Edit/Delete imply Read) but is NOT a record-sharing grant on a
// Private object — record visibility is then the honest unmodeled `unknown`.
const PRIV_CRUD_OBJ = 'CustomObject:PrivCrudObj';
const CRUD_ONLY_PROFILE = 'Profile:CrudOnly';

const privateCrudOnlySeed: ExtractionResult = {
  nodes: [
    makeNode({ id: PRIV_CRUD_OBJ, apiName: 'PrivCrudObj', properties: { sharingModel: 'Private' } }),
    makeNode({ id: CRUD_ONLY_PROFILE, type: 'Profile', apiName: 'CrudOnly' }),
  ],
  edges: [
    makeEdge({
      fromId: CRUD_ONLY_PROFILE,
      toId: PRIV_CRUD_OBJ,
      edgeType: 'grantedBy',
      properties: {
        allowRead: true,
        allowEdit: true,
        allowDelete: true,
        viewAllRecords: false,
        modifyAllRecords: false,
      },
    }),
  ],
};

// Object "View All" records (viewAllRecords) on a PRIVATE object — a record-
// sharing BYPASS scoped to all-records. Read => visible even on Private.
const PRIV_VIEWALL_OBJ = 'CustomObject:PrivViewAllObj';
const VIEWALL_PROFILE = 'Profile:ViewAllRecs';

const privateViewAllSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: PRIV_VIEWALL_OBJ, apiName: 'PrivViewAllObj', properties: { sharingModel: 'Private' } }),
    makeNode({ id: VIEWALL_PROFILE, type: 'Profile', apiName: 'ViewAllRecs' }),
  ],
  edges: [
    makeEdge({
      fromId: VIEWALL_PROFILE,
      toId: PRIV_VIEWALL_OBJ,
      edgeType: 'grantedBy',
      properties: { allowRead: true, viewAllRecords: true },
    }),
  ],
};

// ControlledByParent: object Read precondition satisfied, but record access
// derives from the master object's sharing which v1.x cannot walk → honest
// `unknown` (NOT a flat restricted). The load-bearing honesty case.
const CBP_OBJ = 'CustomObject:DetailObj';
const CBP_READER_PROFILE = 'Profile:DetailReader';

const controlledByParentSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: CBP_OBJ, apiName: 'DetailObj', properties: { sharingModel: 'ControlledByParent' } }),
    makeNode({ id: CBP_READER_PROFILE, type: 'Profile', apiName: 'DetailReader' }),
  ],
  edges: [
    makeEdge({
      fromId: CBP_READER_PROFILE,
      toId: CBP_OBJ,
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
};

// =============================================================================
// CR-RV6 fixtures — operation-aware object-CRUD precondition.
// The old precondition only ever checked object READ regardless of accessLevel,
// so the FIRST cascade step (OWD) could win for an operation the user lacks the
// CRUD for: a Read-only user on a ReadWriteTransfer OWD object was told they
// could EDIT every record; an Edit-but-not-Delete user on a FullAccess OWD
// object was told they could DELETE. Every prior fixture granted Read+Edit+
// Delete together (e.g. EDITOR_PROFILE), which masked the bug.
// =============================================================================

// CR-RV6 #1 — READ-ONLY profile (allowRead:true, allowEdit/allowDelete:false,
// no view/modify-all) on a PUBLIC Read/Write/Transfer OWD object. OWD
// ReadWriteTransfer (rank 2) grants edit org-wide, so the FALSE-PERMISSIVE bug
// made accessLevel:'edit' say "visible" even though the user holds only Read.
const RV6_RWT_OBJ = 'CustomObject:Rv6RwtObj';
const RV6_READONLY_PROFILE = 'Profile:Rv6ReadOnly';

const rv6ReadOnlyOnRwtSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: RV6_RWT_OBJ,
      apiName: 'Rv6RwtObj',
      properties: { sharingModel: 'ReadWriteTransfer' },
    }),
    makeNode({ id: RV6_READONLY_PROFILE, type: 'Profile', apiName: 'Rv6ReadOnly' }),
  ],
  edges: [
    makeEdge({
      fromId: RV6_READONLY_PROFILE,
      toId: RV6_RWT_OBJ,
      edgeType: 'grantedBy',
      // Read ONLY — no Edit, no Delete, no record bypass. Edit/Delete must be
      // demoted; read must stay visible.
      properties: {
        allowRead: true,
        allowEdit: false,
        allowDelete: false,
        viewAllRecords: false,
        modifyAllRecords: false,
      },
    }),
  ],
};

// CR-RV6 #2 — FullAccess OWD object (none existed in the suite before) + a
// profile with Read+Edit but NOT Delete. OWD FullAccess (rank 3) grants delete
// org-wide, so the bug made accessLevel:'delete' say "visible" despite no
// object Delete CRUD. accessLevel:'edit' on the SAME object must stay visible
// (allowEdit present, FullAccess rank 3 >= edit rank 2) — the demotion is
// delete-specific, not a blanket deny.
const RV6_FULLACCESS_OBJ = 'CustomObject:Rv6FullAccessObj';
const RV6_EDIT_NO_DELETE_PROFILE = 'Profile:Rv6EditNoDelete';

const rv6FullAccessEditNoDeleteSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: RV6_FULLACCESS_OBJ,
      apiName: 'Rv6FullAccessObj',
      properties: { sharingModel: 'FullAccess' },
    }),
    makeNode({
      id: RV6_EDIT_NO_DELETE_PROFILE,
      type: 'Profile',
      apiName: 'Rv6EditNoDelete',
    }),
  ],
  edges: [
    makeEdge({
      fromId: RV6_EDIT_NO_DELETE_PROFILE,
      toId: RV6_FULLACCESS_OBJ,
      edgeType: 'grantedBy',
      properties: {
        allowRead: true,
        allowEdit: true,
        allowDelete: false,
        viewAllRecords: false,
        modifyAllRecords: false,
      },
    }),
  ],
};

// CR-RV6 #3 — grant-edge Modify-All variant: a PRIVATE object + a profile with
// NO plain CRUD bits but modifyAllRecords:true (object "Modify All"). The new
// write predicate's modifyAllRecords branch must satisfy the edit/delete
// precondition even with allowRead/allowEdit/allowDelete all false, mirroring
// hasObjectReadAccess's bypass handling.
const RV6_MAREC_OBJ = 'CustomObject:Rv6ModifyAllRecObj';
const RV6_MAREC_PROFILE = 'Profile:Rv6ModifyAllRec';

const rv6ModifyAllRecordsGrantSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: RV6_MAREC_OBJ,
      apiName: 'Rv6ModifyAllRecObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({ id: RV6_MAREC_PROFILE, type: 'Profile', apiName: 'Rv6ModifyAllRec' }),
  ],
  edges: [
    makeEdge({
      fromId: RV6_MAREC_PROFILE,
      toId: RV6_MAREC_OBJ,
      edgeType: 'grantedBy',
      properties: {
        allowRead: false,
        allowEdit: false,
        allowDelete: false,
        modifyAllRecords: true,
      },
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
    nestedGroupOwnerRuleSeed,
    criteriaSharingRuleSeed,
    guestSharingRuleSeed,
    noGuestRuleSeed,
    owdUnknownSeed,
    roleHierarchySeed,
    ownerSubordinateRuleSeed,
    ownerPlainRoleRuleSeed,
    ownerSubordinateReadRuleForLevelSeed,
    ownerSubordinateTruncatedSeed,
    restrictionRuleSeed,
    godModeSeed,
    godModeRestrictedSeed,
    modifyAllSeed,
    createWithRtSeed,
    createNoRtObjSeed,
    pubReadWithGrantSeed,
    pubRwtWithGrantSeed,
    privateCrudOnlySeed,
    privateViewAllSeed,
    controlledByParentSeed,
    rv6ReadOnlyOnRwtSeed,
    rv6FullAccessEditNoDeleteSeed,
    rv6ModifyAllRecordsGrantSeed,
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
  it('Public-Read OWD does NOT grant visibility without object Read CRUD (object Read is a precondition)', async () => {
    // CR-03 (corrected H1): a Public-Read OWD alone does NOT make a record
    // visible. `Profile:Standard User` is never seeded and has zero object
    // permission on READ_OBJ, so the object-Read PRECONDITION (plane A) is
    // unmet and the answer must be `restricted` — NOT the old (wrong) OWD-alone
    // `visible`. Telling a zero-permission user they can see any Public-Read
    // object is a catastrophic wrong access answer; this pins the two-plane
    // model instead.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: READ_OBJ,
      userContext: { profileId: 'Profile:Standard User' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('restricted');
    const grant = reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('restricted');
    expect(grant?.reason).toMatch(/object Read|precondition/i);
    // The vaultState carries the manifest hash and timestamp.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('Public-Read OWD grants visibility when the user HAS object Read CRUD', async () => {
    // CR-03 PASS-AFTER: with the object-Read precondition satisfied (a seeded
    // profile holding object Read), the public OWD legitimately makes the record
    // visible via the OWD step.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PUB_READ_OBJ,
      userContext: { profileId: READER_PROFILE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('visible');
    const owd = reasoning.find((s) => s.stage === 'OWD');
    expect(owd?.verdict).toBe('visible');
    expect(owd?.reason).toContain('Read');
  });

  it('classifies OWD ReadWriteTransfer as visible (Public Read/Write/Transfer) when object Read is present', async () => {
    // CR-03: ReadWriteTransfer (the Lead/Case OWD) is a PUBLIC read-or-better
    // setting — it must read as visible, NOT 'unrecognised OWD value'. The user
    // here HAS object Read CRUD (precondition satisfied), so the public OWD
    // grants record visibility.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PUB_RWT_OBJ,
      userContext: { profileId: EDITOR_PROFILE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('visible');
    const owd = reasoning.find((s) => s.stage === 'OWD');
    expect(owd?.verdict).toBe('visible');
  });

  it('classifies OWD ControlledByCampaign as restricted at the OWD stage', async () => {
    // CR-03: the supplied profile HAS object Read (precondition met), so the OWD
    // stage is reached and its CLASSIFICATION is what is tested.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: CBC_OBJ,
      userContext: { profileId: CBC_READER_PROFILE },
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

  it('object-Read precondition hard-deny: a supplied profile with no object grant and no god-mode is restricted, not unknown (bug 21)', async () => {
    // CR-03: Profile:NoAccess has no grantedBy edge on the Private GodModeObj and
    // no View/Modify-All Data. Object Read is a hard PRECONDITION for record
    // access, so the unknown record-level sharing tail (territory / manual /
    // sets / teams) cannot grant it — the answer is a definitive `restricted`,
    // not `unknown`. The handler returns early at the precondition with a single
    // PermissionGrant `restricted` step citing the missing object-Read.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: GODMODE_OBJ,
      userContext: { profileId: 'Profile:NoAccess' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    // …the aggregate is restricted: object Read is absent, sharing moot.
    expect(verdict).toBe('restricted');
    const grant = reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('restricted');
    expect(grant?.reason).toMatch(/object Read|precondition/i);
    // Precondition denial short-circuits before the record-level stages — the
    // reasoning is just the single precondition step.
    expect(reasoning.length).toBe(1);
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

  it('CR-CAP-12: a rule granting an ENCLOSING group reaches a user in a NESTED member group', async () => {
    // The user is a literal member ONLY of Group:Nested_PG. The owner rule
    // grants Group:Enclosing_PG, which CONTAINS Nested_PG via hasMember. The
    // literal membership set would miss the grant (restricted); the upward
    // hasMember expansion folds Enclosing_PG in → visible.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: NESTED_RULE_OBJ,
      userContext: { groupIds: [NESTED_PG] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('visible');
    const ownerSteps = reasoning.filter((s) => s.stage === 'OwnerSharingRule');
    expect(ownerSteps.length).toBe(1);
    expect(ownerSteps[0]?.verdict).toBe('visible');
    expect(ownerSteps[0]?.reason).toContain(ENCLOSING_PG);
  });

  // --- CR-CAP-05: owner sharing rule "Roles and Subordinates" subtree match ---

  it('CR-CAP-05 (1): a SUBORDINATE role is GRANTED by a roleAndSubordinates owner rule', async () => {
    // The core regression. Cap_Rep is two rungs below the rule's sharedTo
    // target Cap_VP. Before the fix the OwnerSharingRule step matched by EXACT
    // role membership, so Cap_Rep (not equal Cap_VP) was wrongly `restricted`
    // and the aggregate not `visible`. After the fix the rule reaches every
    // subordinate, so the step is `visible` and the aggregate `visible`.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: SUB_OBJ,
      userContext: { roleId: SUB_REP_ROLE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    const ownerSteps = reasoning.filter((s) => s.stage === 'OwnerSharingRule');
    expect(ownerSteps.length).toBe(1);
    expect(ownerSteps[0]?.verdict).toBe('visible');
    expect(ownerSteps[0]?.reason).toContain(SUB_RULE_ID);
    expect(ownerSteps[0]?.reason).toContain(SUB_VP_ROLE);
    expect(verdict).toBe('visible');
  });

  it('CR-CAP-05 (2): the NAMED role itself is still granted by a roleAndSubordinates rule', async () => {
    // Base case — covered by membership.has(target). Passes before AND after.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: SUB_OBJ,
      userContext: { roleId: SUB_VP_ROLE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ownerSteps = result.value.data.reasoning.filter(
      (s) => s.stage === 'OwnerSharingRule',
    );
    expect(ownerSteps.length).toBe(1);
    expect(ownerSteps[0]?.verdict).toBe('visible');
    expect(result.value.data.verdict).toBe('visible');
  });

  it('CR-CAP-05 (3): a PLAIN role owner rule stays EXACT — a subordinate is NOT granted', async () => {
    // False-grant guard. PlainRule targets Cap_VP with NO inheritance marker,
    // so a subordinate (Cap_Rep) must NOT leak into the match. restricted
    // before AND after.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PLAIN_ROLE_OBJ,
      userContext: { roleId: SUB_REP_ROLE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ownerSteps = result.value.data.reasoning.filter(
      (s) => s.stage === 'OwnerSharingRule',
    );
    expect(ownerSteps.length).toBe(1);
    expect(ownerSteps[0]?.verdict).toBe('restricted');
  });

  it('CR-CAP-05 (4): a role OUTSIDE the subtree is still DENIED', async () => {
    // Cap_Service_Agent is not Cap_VP and not a subordinate of it.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: SUB_OBJ,
      userContext: { roleId: SERVICE_AGENT_ROLE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    const ownerSteps = reasoning.filter((s) => s.stage === 'OwnerSharingRule');
    expect(ownerSteps.length).toBe(1);
    expect(ownerSteps[0]?.verdict).toBe('restricted');
    expect(verdict).not.toBe('visible');
  });

  it('CR-CAP-05 (5): an INCOMPLETE role tree downgrades the non-match to UNKNOWN, not restricted', async () => {
    // Honesty obligation. The rule targets subordinates of Cap_VP, and the user
    // Cap_Rep_Trunc really IS a subordinate — but the intermediate role
    // Cap_Mid_Missing was not retrieved, so the upward walk truncates before
    // reaching Cap_VP and the (real) ancestor match is MISSED. The
    // inheritance-gated non-match on a truncated chain must downgrade to
    // `unknown` (never a confident false-deny), name the target role, and point
    // to a refresh — NOT report `restricted`.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: TRUNC_OBJ,
      userContext: { roleId: TRUNC_REP_ROLE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    const ownerSteps = reasoning.filter((s) => s.stage === 'OwnerSharingRule');
    expect(ownerSteps.length).toBe(1);
    expect(ownerSteps[0]?.verdict).toBe('unknown');
    expect(ownerSteps[0]?.reason).toContain(TRUNC_TARGET_ROLE);
    expect(ownerSteps[0]?.reason).toContain(TRUNC_REP_ROLE);
    expect(ownerSteps[0]?.reason).toMatch(/refresh|coverage/i);
    // No false-deny: the aggregate must not be `restricted`.
    expect(verdict).not.toBe('restricted');
  });

  it('CR-CAP-05 (6): the subordinate match composes with the access-level gate', async () => {
    // A Read rule reaches the subordinate Cap_Rep, so `read` is visible but
    // `edit` is restricted with the "grants only Read" reason — the inheritance
    // change did not bypass ruleAccessSatisfiesLevel.
    const read = await whyCantUserSeeRecordHandler(ctx, {
      componentId: SUB_EDIT_OBJ,
      accessLevel: 'read',
      userContext: { roleId: SUB_REP_ROLE },
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const readOwner = read.value.data.reasoning.filter(
      (s) => s.stage === 'OwnerSharingRule',
    );
    expect(readOwner.length).toBe(1);
    expect(readOwner[0]?.verdict).toBe('visible');

    const edit = await whyCantUserSeeRecordHandler(ctx, {
      componentId: SUB_EDIT_OBJ,
      accessLevel: 'edit',
      userContext: { roleId: SUB_REP_ROLE },
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const editOwner = edit.value.data.reasoning.filter(
      (s) => s.stage === 'OwnerSharingRule',
    );
    expect(editOwner.length).toBe(1);
    expect(editOwner[0]?.verdict).toBe('restricted');
    expect(editOwner[0]?.reason).toMatch(/only Read|grants only/i);
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

  it('CR-CAP-16: a GUEST sharing rule surfaces an unknown TerritoryAndGuestRules step with rule id / site / predicate', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: GUEST_OBJ,
      userContext: { groupIds: ['Group:ClientPortal'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    const tg = reasoning.filter((s) => s.stage === 'TerritoryAndGuestRules');
    expect(tg.length).toBe(1);
    expect(tg[0]?.verdict).toBe('unknown');
    // Declared detail surfaced: rule id, site name, and predicate.
    expect(tg[0]?.reason).toContain(GUEST_RULE_ID);
    expect(tg[0]?.reason).toContain('ClientPortal');
    expect(tg[0]?.reason).toContain('1 AND 2');
    // Aggregate stays unknown — the rule's applicability is record-level.
    expect(verdict).toBe('unknown');
  });

  it('CR-CAP-16: an object with NO guest/territory rules preserves the absence disclosure as unknown, not restricted', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: NO_GUEST_OBJ,
      userContext: { roleId: SALES_REP_ROLE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tg = result.value.data.reasoning.filter(
      (s) => s.stage === 'TerritoryAndGuestRules',
    );
    expect(tg.length).toBe(1);
    expect(tg[0]?.verdict).toBe('unknown');
    expect(tg[0]?.verdict).not.toBe('restricted');
    expect(tg[0]?.reason).toMatch(/no territory or guest/i);
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

  // --- CR-03: two-plane access model (object-Read precondition + sharing) ---

  it('Public Read/Write/Transfer OWD does NOT grant visibility without object Read (precondition)', async () => {
    // CR-03 (H1): the same precondition gate applies to every public OWD, not
    // just Public-Read. A zero-permission user on a ReadWriteTransfer object is
    // `restricted`, not `visible`.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RWT_OBJ,
      userContext: { profileId: 'Profile:Standard User' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('restricted');
    const grant = result.value.data.reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('restricted');
    expect(grant?.reason).toMatch(/object Read|precondition/i);
  });

  it('H2: object Edit/Delete on a PRIVATE object is NOT a record-visibility grant', async () => {
    // CR-03 (H2): plain object Edit/Delete satisfies the object precondition
    // (Edit/Delete imply Read) but on a Private object with no record-sharing
    // grant it must NEVER read as `visible`. The honest answer is `unknown` —
    // unmodeled manual sharing / teams / sets could still grant it (the
    // load-bearing honesty distinction: "we can't see a grant" != "no access").
    for (const level of ['read', 'edit', 'delete'] as const) {
      const r = await whyCantUserSeeRecordHandler(ctx, {
        componentId: PRIV_CRUD_OBJ,
        accessLevel: level,
        userContext: { profileId: CRUD_ONLY_PROFILE },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Never `visible` from plain object CRUD on a Private object…
      expect(r.value.data.verdict).not.toBe('visible');
      // …and honest `unknown`, not a flat `restricted` (object Read precondition
      // met → unmodeled sharing tail demotes to unknown).
      expect(r.value.data.verdict).toBe('unknown');
      const grant = r.value.data.reasoning.find((s) => s.stage === 'PermissionGrant');
      expect(grant?.verdict).toBe('restricted');
      expect(grant?.reason).toMatch(/record visibility depends on OWD \/ sharing/);
    }
  });

  it('object View All records (viewAllRecords) on a Private object grants read (all-records bypass)', async () => {
    // CR-03: object "View All" records IS a record-sharing bypass scoped to all
    // records — visible even on a Private OWD.
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PRIV_VIEWALL_OBJ,
      userContext: { profileId: VIEWALL_PROFILE },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('visible');
    const grant = r.value.data.reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('visible');
    expect(grant?.reason).toMatch(/View All|Modify All|all records/i);
  });

  it('object View All records (read-only) on a Private object does NOT grant edit', async () => {
    // viewAllRecords is read-only — it must not read as edit-capable on a
    // Private object (no edit bypass), so edit is not `visible`.
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PRIV_VIEWALL_OBJ,
      accessLevel: 'edit',
      userContext: { profileId: VIEWALL_PROFILE },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).not.toBe('visible');
  });

  it('ControlledByParent with object Read but no modeled sharing is honest unknown, not restricted', async () => {
    // CR-03 (honesty): record access on a detail object derives from the MASTER
    // object's sharing, which v1.x cannot walk. With the object-Read precondition
    // satisfied but no modeled bypass/grant, the answer must be `unknown` — never
    // a flat `restricted` that would tell an admin the user definitely cannot see
    // the record.
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: CBP_OBJ,
      userContext: { profileId: CBP_READER_PROFILE },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('unknown');
    const owd = r.value.data.reasoning.find((s) => s.stage === 'OWD');
    expect(owd?.verdict).toBe('restricted'); // ControlledByParent groups as restricted at OWD
  });

  // --- accessLevel: read vs edit vs delete (P11-ACCESS-edit-verdict) ---

  it('a Read OWD is visible for read but NOT for edit (read-only is not edit-capable)', async () => {
    // CR-03: the supplied profile HAS object Read/Edit CRUD (precondition met),
    // so the OWD read/edit ladder is what is tested. A Read OWD makes the record
    // read-visible but the OWD does not grant edit org-wide; with only plain
    // object CRUD (no record-sharing bypass / grant) edit is NOT visible.
    const read = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PUB_READ_OBJ,
      userContext: { profileId: READER_PROFILE },
    });
    const edit = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PUB_READ_OBJ,
      accessLevel: 'edit',
      userContext: { profileId: READER_PROFILE },
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
    // CR-03: the supplied profile HAS object Read/Edit/Delete CRUD (precondition
    // met), so the OWD edit/delete ladder is what is tested. A ReadWrite OWD
    // makes edit visible but delete needs FullAccess org-wide; with only plain
    // object CRUD (no record-sharing bypass) delete is NOT visible.
    const edit = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PUB_RWT_OBJ,
      accessLevel: 'edit',
      userContext: { profileId: EDITOR_PROFILE },
    });
    const del = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PUB_RWT_OBJ,
      accessLevel: 'delete',
      userContext: { profileId: EDITOR_PROFILE },
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
    // ViewAllData is read-only. CR-RV6: GOD_PROFILE holds ViewAllData but NO
    // object Edit CRUD on GODMODE_OBJ, so for accessLevel:'edit' the now
    // operation-aware precondition (systemPermsForLevel('edit') = ModifyAllData
    // only) hard-stops at the precondition with `restricted` BEFORE the cascade
    // — the SystemPermission stage is no longer reached (stronger than the old
    // behavior, which let it through the read precondition then reported the
    // SystemPermission step `restricted`). The load-bearing invariant — read
    // god-mode but NOT edit — is preserved and the precondition reason names the
    // missing object Edit.
    const vadEdit = await whyCantUserSeeRecordHandler(ctx, {
      componentId: GODMODE_OBJ,
      accessLevel: 'edit',
      userContext: { profileId: GOD_PROFILE },
    });
    expect(vadEdit.ok).toBe(true);
    if (!vadEdit.ok) return;
    expect(vadEdit.value.data.verdict).toBe('restricted');
    const vadReasons = vadEdit.value.data.reasoning.map((s) => s.reason).join(' | ');
    expect(vadReasons).toMatch(/no object Edit permission/i);
    expect(vadEdit.value.data.verdict).not.toBe('visible');

    // Sanity: the SAME ViewAllData profile DOES grant read god-mode on the same
    // Private object (the precondition passes for read, the SystemPermission
    // stage visibles).
    const vadRead = await whyCantUserSeeRecordHandler(ctx, {
      componentId: GODMODE_OBJ,
      accessLevel: 'read',
      userContext: { profileId: GOD_PROFILE },
    });
    expect(vadRead.ok).toBe(true);
    if (!vadRead.ok) return;
    expect(vadRead.value.data.verdict).toBe('visible');
    const sysRead = vadRead.value.data.reasoning.find((s) => s.stage === 'SystemPermission');
    expect(sysRead?.verdict).toBe('visible');

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
    // RV1: the reason must match the (correct) `restricted` verdict — it must
    // say the user has no object Create permission, NOT claim create perm is
    // present nor that record visibility DEPENDS ON OWD / sharing (create is
    // never OWD-gated). The evaluateCreateAccess wrapper legitimately appends
    // "...NOT by OWD / sharing..." to explain create is off the sharing ladder,
    // so the load-bearing negative assertion is the absence of the buggy
    // "permission present" claim and the "depends on OWD / sharing" dependence.
    expect(grant?.reason).toMatch(/no object Create permission/i);
    expect(grant?.reason).not.toMatch(/depends on OWD \/ sharing/);
    expect(grant?.reason).not.toMatch(/create permission present/i);
    expect(grant?.reason).not.toMatch(/View All \/ Modify All/);
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

  // === CR-RV6: operation-aware object-CRUD precondition ======================
  // The headline false-permissive class. Pre-fix the precondition only checked
  // object READ regardless of accessLevel, so the OWD step (which visibles edit
  // on a ReadWriteTransfer OWD and delete on a FullAccess OWD) won for an
  // operation the user lacked the CRUD for.

  it('CR-RV6: read-only profile on a ReadWriteTransfer OWD object is NOT visible for edit (false-permissive guard)', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RV6_RWT_OBJ,
      accessLevel: 'edit',
      userContext: { profileId: RV6_READONLY_PROFILE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // PRE-FIX BUG: verdict was 'visible' — the tool told a read-only user they
    // could EDIT every record on a ReadWriteTransfer OWD object.
    expect(result.value.data.verdict).toBe('restricted');
    // The precondition-failure reason must name the missing object EDIT bit, not
    // object Read.
    const reasons = result.value.data.reasoning.map((s) => s.reason).join(' | ');
    expect(reasons).toMatch(/no object Edit permission/i);
    expect(reasons).not.toMatch(/no object Read permission/i);
  });

  it('CR-RV6: that SAME read-only profile is STILL visible for read (no over-demotion regression)', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RV6_RWT_OBJ,
      accessLevel: 'read',
      userContext: { profileId: RV6_READONLY_PROFILE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // allowRead satisfies the read precondition; OWD ReadWriteTransfer rank 2 >=
    // read rank 1 → read stays visible.
    expect(result.value.data.verdict).toBe('visible');
  });

  it('CR-RV6: Edit-but-not-Delete profile on a FullAccess OWD object is NOT visible for delete (false-permissive guard)', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RV6_FULLACCESS_OBJ,
      accessLevel: 'delete',
      userContext: { profileId: RV6_EDIT_NO_DELETE_PROFILE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // PRE-FIX BUG: verdict was 'visible' — OWD FullAccess rank 3 >= delete rank
    // 3, and the read-only precondition passed, so delete falsely visibled.
    expect(result.value.data.verdict).toBe('restricted');
    const reasons = result.value.data.reasoning.map((s) => s.reason).join(' | ');
    expect(reasons).toMatch(/no object Delete permission/i);
    expect(reasons).not.toMatch(/no object Read permission/i);
  });

  it('CR-RV6: that SAME Edit-but-not-Delete profile IS visible for edit on the FullAccess object (demotion is delete-specific)', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RV6_FULLACCESS_OBJ,
      accessLevel: 'edit',
      userContext: { profileId: RV6_EDIT_NO_DELETE_PROFILE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // allowEdit present, FullAccess rank 3 >= edit rank 2 → edit visible.
    expect(result.value.data.verdict).toBe('visible');
  });

  it('CR-RV6: true-positive preserved — Edit+Read profile on ReadWriteTransfer is visible for edit (regression guard for EDITOR_PROFILE)', async () => {
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PUB_RWT_OBJ,
      accessLevel: 'edit',
      userContext: { profileId: EDITOR_PROFILE },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // EDITOR_PROFILE holds allowEdit:true; the operation-aware precondition must
    // still ADMIT legitimate edits.
    expect(result.value.data.verdict).toBe('visible');
  });

  it('CR-RV6: object Modify-All grant-edge satisfies the edit AND delete precondition with no plain CRUD bits', async () => {
    for (const lvl of ['edit', 'delete'] as const) {
      const result = await whyCantUserSeeRecordHandler(ctx, {
        componentId: RV6_MAREC_OBJ,
        accessLevel: lvl,
        userContext: { profileId: RV6_MAREC_PROFILE },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // modifyAllRecords:true bypasses sharing for every level — the new write
      // predicate's bypass branch must let the precondition pass (NOT hard-deny
      // for missing allowEdit/allowDelete), then the PermissionGrant stage
      // visibles via grantSatisfiesRecordVisible.
      expect(result.value.data.verdict).toBe('visible');
    }
  });

  it('CR-RV6: role/group-only context on a PRIVATE object stays unknown for edit (operation-aware precondition must NOT hard-deny)', async () => {
    // The load-bearing honesty guard: with NO profileId / permissionSetIds object
    // perms are UNDECIDABLE, so the operation-aware precondition is SKIPPED
    // (profileOrPermSetSupplied is false) — it must NOT hard-deny. On a Private
    // OWD object the OWD does not visible edit, the cascade runs through its
    // unmodeled stages, and the answer is an honest `unknown` — NOT a hard
    // `restricted`. (RV6_MAREC_OBJ is Private; its only grant edge is to a
    // Profile, which the role-only context does not match, so no grant fires.)
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RV6_MAREC_OBJ,
      accessLevel: 'edit',
      userContext: { roleId: 'Role:Whatever' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('unknown');
    // Specifically: the answer is NOT the precondition hard-deny.
    expect(result.value.data.verdict).not.toBe('restricted');
    const reasons = result.value.data.reasoning.map((s) => s.reason).join(' | ');
    expect(reasons).not.toMatch(/no object Edit permission on the supplied profile/i);
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
    // CR-03: the supplied permission set has object Read on RestrictionObj, so
    // the object-Read precondition passes and the cascade reaches the
    // RestrictionRule stage. With object Read present, a Private OWD, and no
    // modeled bypass / sharing grant, the honest aggregate is `unknown` —
    // a restriction rule can only further filter access, never grant it, and
    // unmodeled sharing could still apply.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RESTRICTION_OBJ,
      userContext: { permissionSetIds: [RESTRICTION_PS] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('unknown');
    const rr = result.value.data.reasoning.find((s) => s.stage === 'RestrictionRule');
    expect(rr?.verdict).toBe('unknown');
    expect(rr?.reason).toContain('restriction rule');
  });

  it('reports PermissionSetGroup as informational when groups exist but none are assigned', async () => {
    // CR-CAP-04: PSG membership is now MODELED. The user carries only a plain
    // permission set (no PSG), so the PSG step is informational `restricted`
    // (the old always-`unknown` stub is gone — membership is no longer an
    // undecidable gap), and names that no assigned PSG was supplied.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RESTRICTION_OBJ,
      userContext: { permissionSetIds: [RESTRICTION_PS] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const psg = result.value.data.reasoning.find((s) => s.stage === 'PermissionSetGroup');
    expect(psg?.verdict).toBe('restricted');
    expect(psg?.reason).toContain('permission set group');
    expect(psg?.reason).toMatch(/none were supplied/i);
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
