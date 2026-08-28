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

import { measureGraphQueries } from './_graph-query-budget.js';

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
const GUEST_RULE_ID = 'SharingRule:GuestObj.Share_To_Customer_Site';

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
      apiName: 'GuestObj.Share_To_Customer_Site',
      parentId: GUEST_OBJ,
      properties: {
        ruleType: 'guest',
        accessLevel: 'Read',
        sharedToType: 'guestUser',
        sharedToName: 'Customer_Site',
        sharedFromType: null,
        sharedFromName: null,
        booleanFilter: '1 AND 2',
        criteriaItemCount: 2,
        siteName: 'Customer_Site',
      },
    }),
    makeNode({ id: 'Group:Customer_Site', type: 'Group', apiName: 'Customer_Site' }),
  ],
  edges: [
    makeEdge({
      fromId: GUEST_OBJ,
      toId: GUEST_RULE_ID,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: GUEST_RULE_ID,
      toId: 'Group:Customer_Site',
      edgeType: 'sharedWith',
      properties: { synthetic: true, siteName: 'Customer_Site' },
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

// =============================================================================
// Seed (hard-deny + restriction rule): a Private object that carries an active
// RestrictionRule, queried with a profile that has NO object grant. The
// object-CRUD precondition hard-denies (verdict `restricted`), but the cascade
// must STILL surface the RestrictionRule stage in the reasoning chain — the
// hard deny does not erase the rest of the evaluation. Mirrors the CI
// visibility-honesty eval contract (an active restriction rule on the object
// surfaces as a RestrictionRule reasoning stage even on a hard deny).
// =============================================================================

const HARDDENY_RESTRICTION_OBJ = 'CustomObject:HardDenyRestrictObj';

const hardDenyRestrictionSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: HARDDENY_RESTRICTION_OBJ,
      apiName: 'HardDenyRestrictObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: 'RestrictionRule:HardDenyRestrictObj.Hide_External',
      type: 'RestrictionRule',
      apiName: 'HardDenyRestrictObj.Hide_External',
      parentId: HARDDENY_RESTRICTION_OBJ,
    }),
    // A profile with NO grantedBy edge on this object → object-CRUD precondition
    // fails → hard deny.
    makeNode({
      id: 'Profile:HardDenyUser',
      type: 'Profile',
      apiName: 'HardDenyUser',
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed (R7-W4 — PermissionSetGroup MUTING). A Public-Read object where a PSG's
// two members BOTH grant object Read, but the group's muting permission set
// DENIES object Read. Muting is group-scoped, so:
//   - a user assigned ONLY the muting group has NO net object Read → the
//     object-CRUD precondition FAILS (verdict `restricted`, `mutedBy` names the
//     muting set) even though the OWD is Public Read — the pre-R7-W4 overstatement.
//   - a SECOND group with no muting keeps its member's Read (survives).
//   - a profile granting Read OUTSIDE any group is never muted (survives).
// Plus a create object where the group mutes object Create, and a legacy muting
// node (no muted-perm data) that CANNOT be subtracted (disclosed overstatement).
// =============================================================================

const MUTE_OBJ = 'CustomObject:MuteObj';
const MUTE_CREATE_OBJ = 'CustomObject:MuteCreateObj';
const LEGACY_MUTE_OBJ = 'CustomObject:LegacyMuteObj';
const MUTE_GROUP = 'PermissionSetGroup:MuteG';
const CLEAN_GROUP = 'PermissionSetGroup:CleanG';
const MUTE_CREATE_GROUP = 'PermissionSetGroup:MuteCreateG';
const LEGACY_MUTE_GROUP = 'PermissionSetGroup:LegacyG';
const MUTE_READ_SET = 'MutingPermissionSet:MuteRead';
const MUTE_CREATE_SET = 'MutingPermissionSet:MuteCreate';
const OUTSIDE_READER_PROFILE = 'Profile:OutsideReader';

const mutingSeed: ExtractionResult = {
  nodes: [
    // Public-Read object: without muting, object Read via the group → visible.
    makeNode({ id: MUTE_OBJ, apiName: 'MuteObj', properties: { sharingModel: 'Read' } }),
    // Group members: BOTH grant object Read on MuteObj.
    makeNode({ id: 'PermissionSet:MuteM1', type: 'PermissionSet', apiName: 'MuteM1' }),
    makeNode({ id: 'PermissionSet:MuteM2', type: 'PermissionSet', apiName: 'MuteM2' }),
    // Muting set — R6-06 muted-perm node properties: denies object Read on MuteObj.
    makeNode({
      id: MUTE_READ_SET,
      type: 'MutingPermissionSet',
      apiName: 'MuteRead',
      properties: {
        mutedObjectPermissions: [
          {
            object: 'MuteObj',
            allowCreate: false,
            allowRead: true,
            allowEdit: false,
            allowDelete: false,
            viewAllRecords: false,
            modifyAllRecords: false,
          },
        ],
        mutedFieldPermissions: [],
        mutedUserPermissions: [],
        mutedCustomPermissions: [],
        mutedApexClasses: [],
      },
    }),
    makeNode({
      id: MUTE_GROUP,
      type: 'PermissionSetGroup',
      apiName: 'MuteG',
      properties: { permissionSets: ['MuteM1', 'MuteM2'], mutingPermissionSets: ['MuteRead'] },
    }),
    // A second group with NO muting — its member's Read must survive intact.
    makeNode({ id: 'PermissionSet:MuteM3', type: 'PermissionSet', apiName: 'MuteM3' }),
    makeNode({
      id: CLEAN_GROUP,
      type: 'PermissionSetGroup',
      apiName: 'CleanG',
      properties: { permissionSets: ['MuteM3'] },
    }),
    // A profile granting Read OUTSIDE any group — muting is group-scoped, so it
    // is never subtracted.
    makeNode({ id: OUTSIDE_READER_PROFILE, type: 'Profile', apiName: 'OutsideReader' }),
    // Create object: a member grants object Create, the group mutes it.
    makeNode({ id: MUTE_CREATE_OBJ, apiName: 'MuteCreateObj', properties: { sharingModel: 'Private' } }),
    makeNode({ id: 'PermissionSet:MuteCM1', type: 'PermissionSet', apiName: 'MuteCM1' }),
    makeNode({
      id: MUTE_CREATE_SET,
      type: 'MutingPermissionSet',
      apiName: 'MuteCreate',
      properties: {
        mutedObjectPermissions: [
          {
            object: 'MuteCreateObj',
            allowCreate: true,
            allowRead: false,
            allowEdit: false,
            allowDelete: false,
            viewAllRecords: false,
            modifyAllRecords: false,
          },
        ],
        mutedFieldPermissions: [],
        mutedUserPermissions: [],
        mutedCustomPermissions: [],
        mutedApexClasses: [],
      },
    }),
    makeNode({
      id: MUTE_CREATE_GROUP,
      type: 'PermissionSetGroup',
      apiName: 'MuteCreateG',
      properties: { permissionSets: ['MuteCM1'], mutingPermissionSets: ['MuteCreate'] },
    }),
    // Legacy muting node (vault refreshed before R6-06): NO muted-perm props, so
    // it CANNOT be subtracted — access may be overstated (disclosed).
    makeNode({ id: LEGACY_MUTE_OBJ, apiName: 'LegacyMuteObj', properties: { sharingModel: 'Read' } }),
    makeNode({ id: 'PermissionSet:LegacyM1', type: 'PermissionSet', apiName: 'LegacyM1' }),
    makeNode({ id: 'MutingPermissionSet:LegacyMute', type: 'MutingPermissionSet', apiName: 'LegacyMute' }),
    makeNode({
      id: LEGACY_MUTE_GROUP,
      type: 'PermissionSetGroup',
      apiName: 'LegacyG',
      properties: { permissionSets: ['LegacyM1'], mutingPermissionSets: ['LegacyMute'] },
    }),
  ],
  edges: [
    makeEdge({ fromId: 'PermissionSet:MuteM1', toId: MUTE_OBJ, edgeType: 'grantedBy', properties: { allowRead: true } }),
    makeEdge({ fromId: 'PermissionSet:MuteM2', toId: MUTE_OBJ, edgeType: 'grantedBy', properties: { allowRead: true } }),
    makeEdge({ fromId: 'PermissionSet:MuteM3', toId: MUTE_OBJ, edgeType: 'grantedBy', properties: { allowRead: true } }),
    makeEdge({ fromId: OUTSIDE_READER_PROFILE, toId: MUTE_OBJ, edgeType: 'grantedBy', properties: { allowRead: true } }),
    makeEdge({ fromId: 'PermissionSet:MuteCM1', toId: MUTE_CREATE_OBJ, edgeType: 'grantedBy', properties: { allowCreate: true } }),
    makeEdge({ fromId: 'PermissionSet:LegacyM1', toId: LEGACY_MUTE_OBJ, edgeType: 'grantedBy', properties: { allowRead: true } }),
    // PSG membership + muting reference edges (real runtime shapes).
    makeEdge({ fromId: MUTE_GROUP, toId: 'PermissionSet:MuteM1', edgeType: 'references', properties: { referenceKind: 'permissionSetGroupMember' } }),
    makeEdge({ fromId: MUTE_GROUP, toId: 'PermissionSet:MuteM2', edgeType: 'references', properties: { referenceKind: 'permissionSetGroupMember' } }),
    makeEdge({ fromId: MUTE_GROUP, toId: MUTE_READ_SET, edgeType: 'references', properties: { referenceKind: 'mutingPermissionSet' } }),
    makeEdge({ fromId: CLEAN_GROUP, toId: 'PermissionSet:MuteM3', edgeType: 'references', properties: { referenceKind: 'permissionSetGroupMember' } }),
    makeEdge({ fromId: MUTE_CREATE_GROUP, toId: 'PermissionSet:MuteCM1', edgeType: 'references', properties: { referenceKind: 'permissionSetGroupMember' } }),
    makeEdge({ fromId: MUTE_CREATE_GROUP, toId: MUTE_CREATE_SET, edgeType: 'references', properties: { referenceKind: 'mutingPermissionSet' } }),
    makeEdge({ fromId: LEGACY_MUTE_GROUP, toId: 'PermissionSet:LegacyM1', edgeType: 'references', properties: { referenceKind: 'permissionSetGroupMember' } }),
    makeEdge({ fromId: LEGACY_MUTE_GROUP, toId: 'MutingPermissionSet:LegacyMute', edgeType: 'references', properties: { referenceKind: 'mutingPermissionSet' } }),
  ],
};

/**
 * `Profile:Standard User` — the zero-permission profile the CR-03 precondition
 * tests query. It is SEEDED (with no grant edges at all) so those tests pin what
 * they mean to pin: a profile that IS in the vault and genuinely grants nothing,
 * which is a MEASURED deny. An ABSENT profile is a different answer (`unknown`
 * — its grants were never read); leaving this node out conflated the two and let
 * a fabricated deny masquerade as the H1 guarantee.
 */
const ZERO_GRANT_PROFILE = 'Profile:Standard User';

const zeroGrantProfileSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ZERO_GRANT_PROFILE,
      type: 'Profile',
      apiName: 'Standard User',
      properties: { userLicense: 'Salesforce', userPermissions: [] },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed (G3) — THE CTO'S REPRODUCTION. A present profile plus a present
// PermissionSetGroup that NAMES a member permission set which is not in the
// vault. Member ids are synthesized from the group's declared `<permissionSets>`
// bare names, so a managed-package member set is routinely absent; the verdict
// must stay a MEASURED `restricted` and the absence must be DISCLOSED on the
// PermissionSetGroup step. The group carries NO muting set on purpose — that is
// the case the muting-only caveat branch used to swallow.
// =============================================================================

const PSG_MISS_OBJ = 'CustomObject:PsgMissObj';
const PSG_MISS_PROFILE = 'Profile:PsgMissProfile';
const PSG_MISS_PRESENT_SET = 'PermissionSet:PsgMissPresent';
/** Named by the group, deliberately NOT seeded — the managed-package case. */
const PSG_MISS_ABSENT_SET = 'PermissionSet:PsgMissAbsent';
const PSG_MISS_GROUP = 'PermissionSetGroup:PsgMissG';

const psgMemberMissSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PSG_MISS_OBJ,
      apiName: 'PsgMissObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: PSG_MISS_PROFILE,
      type: 'Profile',
      apiName: 'PsgMissProfile',
      properties: { userLicense: 'Salesforce', userPermissions: [] },
    }),
    makeNode({
      id: PSG_MISS_PRESENT_SET,
      type: 'PermissionSet',
      apiName: 'PsgMissPresent',
      properties: { userPermissions: [] },
    }),
    makeNode({
      id: PSG_MISS_GROUP,
      type: 'PermissionSetGroup',
      apiName: 'PsgMissG',
      // NO `mutingPermissionSets` — the member-miss disclosure must not depend
      // on the group having one.
      properties: { permissionSets: ['PsgMissPresent', 'PsgMissAbsent'] },
    }),
  ],
  edges: [
    makeEdge({
      fromId: PSG_MISS_GROUP,
      toId: PSG_MISS_PRESENT_SET,
      edgeType: 'references',
      properties: { referenceKind: 'permissionSetGroupMember' },
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
    hardDenyRestrictionSeed,
    mutingSeed,
    godModeSeed,
    godModeRestrictedSeed,
    modifyAllSeed,
    createWithRtSeed,
    createNoRtObjSeed,
    zeroGrantProfileSeed,
    psgMemberMissSeed,
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
    // visible. `Profile:Standard User` IS seeded (zeroGrantProfileSeed) and
    // holds zero object permission on READ_OBJ, so the deny is MEASURED — the
    // object-Read PRECONDITION (plane A) is
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
    // not `unknown`. The PermissionGrant step cites the missing object-Read.
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
    // The hard deny no longer SHORT-CIRCUITS the cascade: the full reasoning
    // chain is still walked and returned (OWD through the unknown tail) so the
    // admin sees every stage that was evaluated. None of those downstream
    // stages can OVERTURN the hard-deny `restricted` verdict.
    expect(reasoning.length).toBeGreaterThan(1);
    expect(reasoning[0]?.stage).toBe('OWD');
  });

  it('hard-deny still surfaces the RestrictionRule stage: an active restriction rule on the object appears in reasoning even when object CRUD is hard-denied (visibility-honesty)', async () => {
    // CI eval contract (cases.analytical.ci.json, caseClass visibility-honesty):
    // Profile:HardDenyUser has no object grant on the Private
    // HardDenyRestrictObj, so the object-CRUD precondition hard-denies and the
    // verdict is `restricted`. The object carries an active RestrictionRule, and
    // an honest reasoning chain MUST surface that RestrictionRule stage — the
    // hard deny decides the verdict, but it does not erase the rest of the
    // evaluation. (Regression: a prior short-circuit returned a single
    // PermissionGrant step and the RestrictionRule stage was lost.)
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: HARDDENY_RESTRICTION_OBJ,
      userContext: { profileId: 'Profile:HardDenyUser' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('restricted');
    const stages = reasoning.map((s) => s.stage);
    // The RestrictionRule stage is present despite the hard deny.
    expect(stages).toContain('RestrictionRule');
    // The hard deny is still explained on the PermissionGrant stage.
    const grant = reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('restricted');
    expect(grant?.reason).toMatch(/object Read|precondition/i);
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
      userContext: { groupIds: ['Group:Customer_Site'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    const tg = reasoning.filter((s) => s.stage === 'TerritoryAndGuestRules');
    expect(tg.length).toBe(1);
    expect(tg[0]?.verdict).toBe('unknown');
    // Declared detail surfaced: rule id, site name, and predicate.
    expect(tg[0]?.reason).toContain(GUEST_RULE_ID);
    expect(tg[0]?.reason).toContain('Customer_Site');
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

  it('reports PermissionSetGroup as NOT EVALUATED when groups exist but none are assigned', async () => {
    // CR-CAP-04: PSG membership IS modeled, so the old always-`unknown` stub is
    // gone. But when the caller supplies no group, nothing about the groups that
    // DO exist was examined — and `restricted` claims they were examined and
    // grant nothing. An unknown must not wear a denial word: this stage now
    // matches the `TerritoryAndGuestRules` / `ManualSharing` idiom in the same
    // response. It still names that no assigned PSG was supplied.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RESTRICTION_OBJ,
      userContext: { permissionSetIds: [RESTRICTION_PS] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const psg = result.value.data.reasoning.find((s) => s.stage === 'PermissionSetGroup');
    expect(psg?.verdict).toBe('unknown');
    expect(psg?.verdict).not.toBe('restricted');
    expect(psg?.reason).toMatch(/NOT EVALUATED/);
    expect(psg?.reason).toContain('permission set group');
    expect(psg?.reason).toMatch(/none were supplied/i);
  });

  it('the top-level verdict is unchanged by the PermissionSetGroup step wording', async () => {
    // The frozen UNKNOWN_TAIL already demotes the aggregate, so this stage's
    // verdict never reached the headline. Asserted rather than assumed — the
    // fix is a reasoning-chain correction and must stay one.
    const result = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RESTRICTION_OBJ,
      userContext: { permissionSetIds: [RESTRICTION_PS] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('unknown');
  });
});

// =============================================================================
// A vault holding ZERO PermissionSetGroup nodes. That branch is genuinely
// determinate — the vault WAS checked and holds no group, so no group can
// grant anything — and must keep saying `restricted`. Deleting it would be the
// easy over-correction, so it gets its own isolated graph (the shared fixture
// seeds `PermissionSetGroup:Ops_Group`).
// =============================================================================

const NO_PSG_OBJ = 'CustomObject:NoGroupsObj';
const NO_PSG_PS = 'PermissionSet:NoGroups_PS';
const noPsgSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NO_PSG_OBJ,
      apiName: 'NoGroupsObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({ id: NO_PSG_PS, type: 'PermissionSet', apiName: 'NoGroups_PS' }),
  ],
  edges: [
    makeEdge({
      fromId: NO_PSG_PS,
      toId: NO_PSG_OBJ,
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
};

describe('whyCantUserSeeRecordHandler — PermissionSetGroup with zero groups in vault', () => {
  let noPsgStore: GraphStore;
  let noPsgDir: string;
  let noPsgCtx: Context;

  beforeAll(async () => {
    noPsgDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-no-psg-'));
    const opened = await openGraph(join(noPsgDir, 'no-psg.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    noPsgStore = opened.value;
    const imported = await importExtractionResults(noPsgStore, [noPsgSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    noPsgCtx = { vaultRoot: noPsgDir, manifest: FIXTURE_MANIFEST, graph: noPsgStore };
  });

  afterAll(async () => {
    await closeGraph(noPsgStore);
    rmSync(noPsgDir, { recursive: true, force: true });
  });

  it('keeps the determinate `restricted` verdict verbatim when the vault holds no groups', async () => {
    const result = await whyCantUserSeeRecordHandler(noPsgCtx, {
      componentId: NO_PSG_OBJ,
      userContext: { permissionSetIds: [NO_PSG_PS] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const psg = result.value.data.reasoning.find((s) => s.stage === 'PermissionSetGroup');
    expect(psg).toEqual({
      stage: 'PermissionSetGroup',
      verdict: 'restricted',
      reason: 'no permission set groups in vault',
    });
  });

  it('the top-level verdict on the zero-group vault is unchanged too', async () => {
    const result = await whyCantUserSeeRecordHandler(noPsgCtx, {
      componentId: NO_PSG_OBJ,
      userContext: { permissionSetIds: [NO_PSG_PS] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('unknown');
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

  // ===========================================================================
  // R7-W4 — PermissionSetGroup MUTING subtracts from the object-CRUD precondition.
  // ===========================================================================
  describe('R7-W4 group-scoped muting of the object-CRUD precondition', () => {
    it('mutes object Read within the group → precondition FAILS, verdict restricted, mutedBy names the set', async () => {
      // Both group members grant object Read on a Public-Read object, but the
      // group's muting set denies object Read. Pre-R7-W4 the object-Read
      // precondition passed (member grant counted) and the Public-Read OWD made
      // this `visible` — the OVERSTATEMENT. Now muting removes the members' Read
      // net, so the precondition fails and the honest answer is `restricted`.
      const r = await whyCantUserSeeRecordHandler(ctx, {
        componentId: MUTE_OBJ,
        userContext: { permissionSetIds: [MUTE_GROUP] },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.verdict).toBe('restricted');
      // The muting set is named at the top level and on the PermissionGrant step.
      expect(r.value.data.mutedBy).toEqual([MUTE_READ_SET]);
      const grant = r.value.data.reasoning.find((s) => s.stage === 'PermissionGrant');
      expect(grant?.verdict).toBe('restricted');
      expect(grant?.mutedBy).toEqual([MUTE_READ_SET]);
      expect(grant?.reason).toMatch(/muted/i);
      expect(grant?.reason).toContain(MUTE_READ_SET);
      // OWD stage is Public-Read (visible in isolation) but the hard deny wins.
      const owd = r.value.data.reasoning.find((s) => s.stage === 'OWD');
      expect(owd?.verdict).toBe('visible');
      expect(r.value.data.hardDenyReason).toMatch(/muted/i);
    });

    it('REGRESSION: a PSG member Read with NO muting on the group is unchanged (visible)', async () => {
      // The second group has no muting set; its member grants object Read, so the
      // Public-Read OWD legitimately makes the record visible — no behavior change.
      const r = await whyCantUserSeeRecordHandler(ctx, {
        componentId: MUTE_OBJ,
        userContext: { permissionSetIds: [CLEAN_GROUP] },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.verdict).toBe('visible');
      expect(r.value.data.mutedBy).toBeUndefined();
      const owd = r.value.data.reasoning.find((s) => s.stage === 'OWD');
      expect(owd?.verdict).toBe('visible');
    });

    it('a grant surviving via the profile OUTSIDE the group is NOT muted (visible)', async () => {
      // Even assigned the muting group, a profile granting object Read outside any
      // group survives (muting is group-scoped) → precondition passes → visible.
      const r = await whyCantUserSeeRecordHandler(ctx, {
        componentId: MUTE_OBJ,
        userContext: {
          profileId: OUTSIDE_READER_PROFILE,
          permissionSetIds: [MUTE_GROUP],
        },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.verdict).toBe('visible');
      expect(r.value.data.mutedBy).toBeUndefined();
    });

    it('mutes object Create within the group → create verdict restricted, mutedBy named', async () => {
      const r = await whyCantUserSeeRecordHandler(ctx, {
        componentId: MUTE_CREATE_OBJ,
        accessLevel: 'create',
        userContext: { permissionSetIds: [MUTE_CREATE_GROUP] },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.verdict).toBe('restricted');
      expect(r.value.data.mutedBy).toEqual([MUTE_CREATE_SET]);
      const grant = r.value.data.reasoning.find((s) => s.stage === 'PermissionGrant');
      expect(grant?.verdict).toBe('restricted');
      expect(grant?.mutedBy).toEqual([MUTE_CREATE_SET]);
    });

    it('a legacy muting node (no muted-perm data) CANNOT be subtracted → access preserved but disclosed as overstated', async () => {
      // The muting node predates the R6-06 extractor (no muted* properties), so
      // its Read mute cannot be applied. Honesty: do NOT drop the grant (would be
      // a false deny) — keep it visible but DISCLOSE the possible overstatement.
      const r = await whyCantUserSeeRecordHandler(ctx, {
        componentId: LEGACY_MUTE_OBJ,
        userContext: { permissionSetIds: [LEGACY_MUTE_GROUP] },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.verdict).toBe('visible');
      expect(r.value.data.mutedBy).toBeUndefined();
      const psg = r.value.data.reasoning.find((s) => s.stage === 'PermissionSetGroup');
      expect(psg?.reason).toMatch(/OVERSTATED/);
      expect(psg?.reason).toContain('MutingPermissionSet:LegacyMute');
      expect(r.value.data.boundaryNote).toMatch(/OVERSTATED/);
    });

    it('PermissionSetGroup step reports muting WAS applied to the precondition', async () => {
      const r = await whyCantUserSeeRecordHandler(ctx, {
        componentId: MUTE_OBJ,
        userContext: { permissionSetIds: [MUTE_GROUP] },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const psg = r.value.data.reasoning.find((s) => s.stage === 'PermissionSetGroup');
      expect(psg?.reason).toMatch(/subtracted from the object-CRUD precondition/i);
      expect(psg?.reason).toContain(MUTE_READ_SET);
    });
  });
});

// =============================================================================
// N+1 query budget (finding C-1). fetchSharingRules (parentOf children) and
// the owner-rule sharedWith walk (per-rule listEdges inside ownerRuleMatches)
// used to scale with the number of sharing rules on the object; both are now
// batched. The query count must NOT scale with the owner-rule count.
// =============================================================================
describe('whyCantUserSeeRecordHandler — bounded graph queries', () => {
  const seedWideObject = async (ruleCount: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-wcusr-budget-'));
    const opened = await openGraph(join(dir, 'wcusr.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const OBJ = 'CustomObject:Wide';
    const GROUP = 'Group:Wide_PG';
    const nodes: Node[] = [
      makeNode({ id: OBJ, apiName: 'Wide', properties: { sharingModel: 'Private' } }),
      makeNode({ id: GROUP, type: 'Group', apiName: 'Wide_PG' }),
    ];
    const edges: Edge[] = [];
    for (let i = 0; i < ruleCount; i += 1) {
      const ruleId = `SharingRule:Wide.Rule${i}`;
      nodes.push(
        makeNode({
          id: ruleId,
          type: 'SharingRule',
          apiName: `Wide.Rule${i}`,
          parentId: OBJ,
          properties: { ruleType: 'owner', accessLevel: 'Read' },
        }),
      );
      edges.push(makeEdge({ fromId: OBJ, toId: ruleId, edgeType: 'parentOf' }));
      edges.push(
        makeEdge({
          fromId: ruleId,
          toId: GROUP,
          edgeType: 'sharedWith',
          properties: { direction: 'to' },
        }),
      );
    }
    const imported = await importExtractionResults(s, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const wideCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const measured = await measureGraphQueries(s, () =>
      // A userContext with NO group membership so the cascade walks EVERY owner
      // rule (none short-circuits to visible) — exercising the full fan-out.
      whyCantUserSeeRecordHandler(wideCtx, {
        componentId: OBJ,
        userContext: { profileId: 'Profile:Std' },
      }),
    );
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return measured;
  };

  it('issues a query count independent of the owner-rule count', async () => {
    const small = await seedWideObject(60);
    const large = await seedWideObject(200);
    expect(small.result.ok).toBe(true);
    expect(large.result.ok).toBe(true);
    // Batched fetchSharingRules + one listEdgesForNodes over all rules'
    // sharedWith edges — not one listEdges per rule.
    expect(large.edgeQueries).toBe(small.edgeQueries);
    expect(large.nodeQueries).toBe(small.nodeQueries);
    // A per-rule listEdges (>=200) or per-child getNodeById (>=200) would blow
    // this; batched, the counts are a small constant.
    expect(large.edgeQueries).toBeLessThan(60);
    expect(large.nodeQueries).toBeLessThan(60);
  });
});

// =============================================================================
// GUARD (WHY-CANT-USER-SEE-REJECTS-OBJECTAPINAME): the router's #1 support tool
// required a canonical `componentId` + `userContext.profileId` and Zod-stripped
// the natural `objectApiName` / `userContext.profileApiName`, hard-failing with
// `componentId: Required` / `profileId` required. The aliases must now (a) pass
// the input schema and (b) yield the SAME verdict + reasoning as the canonical
// CustomObject / Profile ids. PrivateObj + System Administrator (View/Modify All
// grant) => visible. Pre-fix the schema rejects the alias-only shape, so the
// schema assertion is RED before the fix.
describe('whyCantUserSeeRecordHandler — objectApiName / profileApiName aliases (guard)', () => {
  it('accepts objectApiName + profileApiName at the schema layer (were stripped)', () => {
    const parsed = whyCantUserSeeRecordInputSchema.safeParse({
      objectApiName: 'PrivateObj',
      userContext: { profileApiName: 'System Administrator' },
    });
    expect(parsed.success).toBe(true);
  });

  it('objectApiName + profileApiName ≡ CustomObject / Profile ids path', async () => {
    const byAlias = await whyCantUserSeeRecordHandler(ctx, {
      objectApiName: 'PrivateObj',
      userContext: { profileApiName: 'System Administrator' },
    });
    const byId = await whyCantUserSeeRecordHandler(ctx, {
      componentId: 'CustomObject:PrivateObj',
      userContext: { profileId: 'Profile:System Administrator' },
    });
    expect(byAlias.ok && byId.ok).toBe(true);
    if (!byAlias.ok || !byId.ok) return;
    expect(byAlias.value.data.verdict).toBe('visible');
    expect(byAlias.value.data.verdict).toBe(byId.value.data.verdict);
    expect(byAlias.value.data.reasoning).toEqual(byId.value.data.reasoning);
    expect(byAlias.value.data.appliedScope).toEqual({
      object: 'CustomObject:PrivateObj',
      profile: 'Profile:System Administrator',
    });
  });

  it('rejects componentId/objectApiName that disagree with invalid-query', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: 'CustomObject:PrivateObj',
      objectApiName: 'ReadObj',
      userContext: { profileId: 'Profile:System Administrator' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});

// =============================================================================
// EXTERNAL-OWD AUDIENCE (spec row 1): `evaluateOWD` ranked the INTERNAL
// org-wide default for EXTERNAL (Experience Cloud / portal / guest) users.
// Salesforce keeps two OWD columns per object and applies them to disjoint
// audiences, so on an object whose internal OWD outranks its external one a
// community profile with object Read got a confident `visible` — the exact
// "checked and found nothing" vs "did not check" conflation, in a security
// answer. These tests own the four audience paths and the byte-identity of the
// internal one.
// =============================================================================

/** Internal ReadWrite / external Private — the columns DISAGREE for read. */
const EXT_SPLIT_OBJ = 'CustomObject:ExtSplitObj';
/** Internal ReadWrite / external Read — agree for read, DISAGREE for edit. */
const EXT_READ_OBJ = 'CustomObject:ExtReadObj';
/** Internal Private / external Private — the columns AGREE at every level. */
const EXT_AGREE_OBJ = 'CustomObject:ExtAgreeObj';
/** Internal ReadWrite, NO external column declared at all. */
const EXT_NO_COLUMN_OBJ = 'CustomObject:ExtNoColumnObj';

const EXTERNAL_PROFILE = 'Profile:Community Login User';
/** In the vault, internal licence, and holds NO grant edge on any object. */
const PRESENT_UNGRANTED_PROFILE = 'Profile:Present But Ungranted';
const INTERNAL_PROFILE = 'Profile:Internal Staff';
const UNLICENSED_PROFILE = 'Profile:No Licence Profile';

/** Full object CRUD so the plane-A precondition never masks the OWD step. */
const fullCrudEdge = (fromId: string, toId: string): Edge =>
  makeEdge({
    fromId,
    toId,
    edgeType: 'grantedBy',
    properties: {
      allowRead: true,
      allowCreate: true,
      allowEdit: true,
      allowDelete: true,
      viewAllRecords: false,
      modifyAllRecords: false,
    },
  });

const externalOwdAudienceSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: EXT_SPLIT_OBJ,
      apiName: 'ExtSplitObj',
      properties: { sharingModel: 'ReadWrite', externalSharingModel: 'Private' },
    }),
    makeNode({
      id: EXT_READ_OBJ,
      apiName: 'ExtReadObj',
      properties: { sharingModel: 'ReadWrite', externalSharingModel: 'Read' },
    }),
    makeNode({
      id: EXT_AGREE_OBJ,
      apiName: 'ExtAgreeObj',
      properties: { sharingModel: 'Private', externalSharingModel: 'Private' },
    }),
    makeNode({
      id: EXT_NO_COLUMN_OBJ,
      apiName: 'ExtNoColumnObj',
      properties: { sharingModel: 'ReadWrite' },
    }),
    makeNode({
      id: EXTERNAL_PROFILE,
      type: 'Profile',
      apiName: 'Community Login User',
      properties: { userLicense: 'Customer Community Login' },
    }),
    makeNode({
      id: INTERNAL_PROFILE,
      type: 'Profile',
      apiName: 'Internal Staff',
      properties: { userLicense: 'Salesforce' },
    }),
    // No `userLicense` at all — the audience is genuinely undeterminable.
    makeNode({
      id: UNLICENSED_PROFILE,
      type: 'Profile',
      apiName: 'No Licence Profile',
      properties: {},
    }),
    // Present, readable, and grants nothing — the CONTROL for the absent-
    // container fix: a measured deny must stay `restricted`.
    makeNode({
      id: PRESENT_UNGRANTED_PROFILE,
      type: 'Profile',
      apiName: 'Present But Ungranted',
      properties: { userLicense: 'Salesforce', userPermissions: [] },
    }),
  ],
  edges: [
    EXT_SPLIT_OBJ,
    EXT_READ_OBJ,
    EXT_AGREE_OBJ,
    EXT_NO_COLUMN_OBJ,
  ].flatMap((obj) => [
    fullCrudEdge(EXTERNAL_PROFILE, obj),
    fullCrudEdge(INTERNAL_PROFILE, obj),
    fullCrudEdge(UNLICENSED_PROFILE, obj),
  ]),
};

describe('whyCantUserSeeRecordHandler — OWD audience (internal vs external column)', () => {
  let extStore: GraphStore;
  let extDir: string;
  let extCtx: Context;

  beforeAll(async () => {
    extDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ext-owd-'));
    const opened = await openGraph(join(extDir, 'ext-owd.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    extStore = opened.value;
    const imported = await importExtractionResults(extStore, [externalOwdAudienceSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    extCtx = { vaultRoot: extDir, manifest: FIXTURE_MANIFEST, graph: extStore };
  });

  afterAll(async () => {
    await closeGraph(extStore);
    rmSync(extDir, { recursive: true, force: true });
  });

  const owdStepOf = async (
    componentId: string,
    profileId: string,
    accessLevel?: 'read' | 'edit' | 'delete',
  ) => {
    const r = await whyCantUserSeeRecordHandler(extCtx, {
      componentId,
      userContext: { profileId },
      ...(accessLevel === undefined ? {} : { accessLevel }),
    });
    if (!r.ok) throw new Error(`handler failed: ${r.error.message}`);
    return { step: r.value.data.reasoning[0]!, out: r.value.data };
  };

  it('an EXTERNAL-licence profile is ranked against externalSharingModel, never the internal OWD', async () => {
    const { step, out } = await owdStepOf(EXT_SPLIT_OBJ, EXTERNAL_PROFILE);
    expect(step.stage).toBe('OWD');
    // The defect: this was `visible`, off the internal ReadWrite.
    expect(step.verdict).toBe('restricted');
    expect(step.reason).toContain("EXTERNAL OWD 'Private'");
    expect(step.reason).toContain('Customer Community Login');
    // The internal token may be NAMED as the one that does not apply, but it
    // must never be the token the verdict was taken from.
    expect(step.reason).not.toContain("OWD 'ReadWrite' grants");
    // No modeled stage grants it, and the unmodeled tail is honest `unknown`.
    expect(out.verdict).not.toBe('visible');
  });

  it('an INTERNAL-licence profile keeps the pre-existing OWD step verbatim', async () => {
    const { step, out } = await owdStepOf(EXT_SPLIT_OBJ, INTERNAL_PROFILE);
    // Byte-identity guard: the internal path must be unchanged by this stage
    // becoming audience-aware, character for character.
    expect(step).toEqual({
      stage: 'OWD',
      verdict: 'visible',
      reason:
        "OWD 'ReadWrite' grants read access to all records (given the user has object read permission — checked separately as the object read precondition)",
    });
    expect(out.verdict).toBe('visible');
    expect(out.boundaryNote ?? '').not.toContain('enableExternalSharingModel');
  });

  it('an UNDETERMINABLE audience is `unknown` naming both columns — never a silent internal fallback', async () => {
    const { step, out } = await owdStepOf(EXT_SPLIT_OBJ, UNLICENSED_PROFILE);
    expect(step.verdict).toBe('unknown');
    expect(step.reason).toContain('DISAGREE');
    expect(step.reason).toContain("'ReadWrite'");
    expect(step.reason).toContain("'Private'");
    expect(out.verdict).toBe('unknown');
    // An audience-indeterminate OWD must NOT truncate the cascade the way a
    // no-OWD entity does: every later stage is still evaluated and returned.
    expect(out.reasoning.length).toBeGreaterThan(1);
    expect(out.reasoning.map((s) => s.stage)).toContain('PermissionGrant');
  });

  it('an UNDETERMINABLE audience changes nothing when the two columns agree', async () => {
    const { step } = await owdStepOf(EXT_AGREE_OBJ, UNLICENSED_PROFILE);
    expect(step).toEqual({
      stage: 'OWD',
      verdict: 'restricted',
      reason:
        "OWD 'Private' does not grant read access org-wide; downstream grants may apply",
    });
  });

  it('an EXTERNAL subject on an object with NO external column is `unknown`, not the internal answer', async () => {
    const { step, out } = await owdStepOf(EXT_NO_COLUMN_OBJ, EXTERNAL_PROFILE);
    expect(step.verdict).toBe('unknown');
    expect(step.reason).toContain('does not carry for this object');
    expect(out.verdict).not.toBe('visible');
    // Still a full chain, not the single-step no-OWD short circuit.
    expect(out.reasoning.length).toBeGreaterThan(1);
  });

  it('the external verdict tracks the EXTERNAL column at every access level', async () => {
    // ExtReadObj: internal ReadWrite (visible for read AND edit) vs external
    // Read (visible for read, restricted for edit). An external subject must
    // follow the external column at both levels, so read and edit DIVERGE.
    const extRead = await owdStepOf(EXT_READ_OBJ, EXTERNAL_PROFILE, 'read');
    const extEdit = await owdStepOf(EXT_READ_OBJ, EXTERNAL_PROFILE, 'edit');
    expect(extRead.step.verdict).toBe('visible');
    expect(extEdit.step.verdict).toBe('restricted');
    // The internal subject sees the internal column at both, so it does not.
    const intRead = await owdStepOf(EXT_READ_OBJ, INTERNAL_PROFILE, 'read');
    const intEdit = await owdStepOf(EXT_READ_OBJ, INTERNAL_PROFILE, 'edit');
    expect(intRead.step.verdict).toBe('visible');
    expect(intEdit.step.verdict).toBe('visible');
  });

  it('discloses the enableExternalSharingModel assumption exactly when the external column was used', async () => {
    const external = await owdStepOf(EXT_SPLIT_OBJ, EXTERNAL_PROFILE);
    const internal = await owdStepOf(EXT_SPLIT_OBJ, INTERNAL_PROFILE);
    expect(external.out.boundaryNote ?? '').toContain(
      'SharingSettings.enableExternalSharingModel',
    );
    expect(internal.out.boundaryNote ?? '').not.toContain(
      'SharingSettings.enableExternalSharingModel',
    );
  });

  it('a profile that is not in the vault is `unknown`, not assumed internal', async () => {
    const r = await whyCantUserSeeRecordHandler(extCtx, {
      componentId: EXT_SPLIT_OBJ,
      userContext: { profileId: 'Profile:Not In Vault' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const owd = r.value.data.reasoning[0]!;
    expect(owd.verdict).toBe('unknown');
    expect(owd.reason).toContain('is not in this vault');
    // The blind spot this test used to have: it asserted only `reasoning[0]`
    // and never the VERDICT, which was a confident `restricted` off the
    // object-CRUD hard deny.
    expect(r.value.data.verdict).toBe('unknown');
  });
});

/**
 * G3 — an absent SUPPLIED Profile / PermissionSet / PermissionSetGroup is
 * `unknown`, never a hard deny. This tool's failure direction is the dangerous
 * one (it concludes a user CANNOT act), and a missing container used to be
 * indistinguishable from one that grants nothing: the object-CRUD precondition
 * failed on a failed LOOKUP and forced `restricted`, with the absent id named
 * NOWHERE in the payload on an ordinary object (both OWD columns agreeing).
 */
describe('whyCantUserSeeRecordHandler — a supplied container absent from the vault', () => {
  let absStore: GraphStore;
  let absDir: string;
  let absCtx: Context;

  const PHANTOM_PROFILE = 'Profile:Totally_Nonexistent_XYZ';

  beforeAll(async () => {
    absDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-absent-container-'));
    const opened = await openGraph(join(absDir, 'absent.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    absStore = opened.value;
    const imported = await importExtractionResults(absStore, [externalOwdAudienceSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    absCtx = { vaultRoot: absDir, manifest: FIXTURE_MANIFEST, graph: absStore };
  });

  afterAll(async () => {
    await closeGraph(absStore);
    rmSync(absDir, { recursive: true, force: true });
  });

  it('an ordinary object + an absent profile is `unknown` and NAMES the absent id', async () => {
    // EXT_AGREE_OBJ's two OWD columns agree, so the audience never matters and
    // the OWD stage's own not-in-vault disclosure never fires — this is the
    // path where the absent profile appeared nowhere at all in the payload.
    const r = await whyCantUserSeeRecordHandler(absCtx, {
      componentId: EXT_AGREE_OBJ,
      userContext: { profileId: PHANTOM_PROFILE },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('unknown');
    // No hard deny was recorded, so the honesty axis decided the verdict.
    expect(r.value.data.hardDenyReason).toBeUndefined();
    const payload = JSON.stringify(r.value.data);
    expect(payload).toContain(PHANTOM_PROFILE);
    expect(payload).toContain('NOT in this vault');
    const grant = r.value.data.reasoning.find((s) => s.stage === 'PermissionGrant');
    expect(grant?.verdict).toBe('unknown');
  });

  it('the create path is `unknown` too, not "no object Create permission"', async () => {
    const r = await whyCantUserSeeRecordHandler(absCtx, {
      componentId: EXT_AGREE_OBJ,
      userContext: { profileId: PHANTOM_PROFILE },
      accessLevel: 'create',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('unknown');
    const payload = JSON.stringify(r.value.data);
    expect(payload).toContain(PHANTOM_PROFILE);
    expect(payload).not.toMatch(
      /no object Create permission on the supplied granters/i,
    );
  });

  it('a supplied `PermissionSetGroup:` id that is not in the vault is `unknown` — it WAS supplied', async () => {
    const r = await whyCantUserSeeRecordHandler(absCtx, {
      componentId: EXT_AGREE_OBJ,
      userContext: {
        profileId: PRESENT_UNGRANTED_PROFILE,
        permissionSetIds: ['PermissionSetGroup:No_Such_Group'],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('unknown');
    const payload = JSON.stringify(r.value.data);
    expect(payload).toContain('PermissionSetGroup:No_Such_Group');
    expect(payload).toContain('NOT in this vault');
  });

  it('CONTROL — a PRESENT profile that genuinely grants nothing is still a `restricted` hard deny', async () => {
    // The fix must not be a blanket demotion of every deny to `unknown`: a
    // container that was READ and grants nothing is a measured deny.
    const r = await whyCantUserSeeRecordHandler(absCtx, {
      componentId: EXT_AGREE_OBJ,
      userContext: { profileId: PRESENT_UNGRANTED_PROFILE },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('restricted');
    expect(r.value.data.hardDenyReason).toContain(
      'no object Read permission on the supplied profile / permission sets',
    );
    expect(JSON.stringify(r.value.data)).not.toContain('NOT in this vault');
  });

  it('CONTROL — a real granting profile plus an absent permission set is still `visible`', async () => {
    // The absent container can only ADD access, so a grant that was actually
    // READ stays determinative.
    const r = await whyCantUserSeeRecordHandler(absCtx, {
      componentId: EXT_SPLIT_OBJ,
      userContext: {
        profileId: INTERNAL_PROFILE,
        permissionSetIds: ['PermissionSet:Not_In_Vault_Either'],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('visible');
  });
});

/**
 * G3 — THE CTO'S REPRODUCTION, and the reason attempt 1 was rejected. A present
 * profile plus a PRESENT PermissionSetGroup that names ONE member permission set
 * absent from the vault is a common, HEALTHY configuration (member ids are
 * synthesized from bare `<permissionSets>` names, and managed-package member
 * sets are routinely not retrieved). It must keep its measured verdict; the
 * absence is disclosure only.
 */
describe('whyCantUserSeeRecordHandler — a PSG member absent from the vault', () => {
  it("keeps the MEASURED `restricted` verdict — a member miss never buys an `unknown`", async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PSG_MISS_OBJ,
      userContext: {
        profileId: PSG_MISS_PROFILE,
        permissionSetIds: [PSG_MISS_GROUP],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // FAIL-BEFORE (the rejected diff): 'unknown'.
    expect(r.value.data.verdict).toBe('restricted');
    expect(r.value.data.hardDenyReason).toContain(
      'no object Read permission on the supplied profile / permission sets',
    );
  });

  it('DISCLOSES the absent member on the PermissionSetGroup step — even with NO muting set', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PSG_MISS_OBJ,
      userContext: {
        profileId: PSG_MISS_PROFILE,
        permissionSetIds: [PSG_MISS_GROUP],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const psg = r.value.data.reasoning.find((s) => s.stage === 'PermissionSetGroup');
    expect(psg).toBeDefined();
    // The group carries no muting permission set, so this proves the caveat was
    // lifted OUT of the `mutingPsgs.length > 0` branch.
    expect(psg?.reason).not.toContain('muting permission set (');
    expect(psg?.reason).toContain(PSG_MISS_ABSENT_SET);
    expect(psg?.reason).toContain('ABSENT from this vault');
    expect(psg?.reason).toContain('does NOT change the verdict');
  });

  it('never calls a synthesized member a "supplied container", nor tells the admin to check ids they never passed', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PSG_MISS_OBJ,
      userContext: {
        profileId: PSG_MISS_PROFILE,
        permissionSetIds: [PSG_MISS_GROUP],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const payload = JSON.stringify(r.value.data);
    // FAIL-BEFORE: `supplied container PermissionSet:PsgMissAbsent is NOT in
    // this vault … or check the ids`.
    expect(payload).not.toContain('supplied container ' + PSG_MISS_ABSENT_SET);
    expect(payload).not.toContain('NOT in this vault');
    expect(payload).not.toContain('check the ids');
  });

  it('CONTROL — the same object with a bare PRESENT permission set is `restricted` too', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: PSG_MISS_OBJ,
      userContext: {
        profileId: PSG_MISS_PROFILE,
        permissionSetIds: [PSG_MISS_PRESENT_SET],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('restricted');
  });
});

// =============================================================================
// R1 — the child-rule scan must not be an alphabetically-capped org-wide page.
//
// `listObjectChildRules` used to fetch ONE `listNodesByType(ruleType, {limit:
// 500})` page ORG-WIDE and post-filter by `parentId` in memory. Any
// RestrictionRule / ScopingRule whose id sorts after the 500th rule of that
// type in the whole org was never fetched, and the stage then emitted a
// CHECKED negative — `restricted` / "no restriction rules attached to this
// object" — for a scan that never looked at the object's own rule. The same
// helper backs the god-mode branch, where the miss flips an honest `unknown`
// ("an active restriction rule can still filter specific users") into a
// confident `visible`.
//
// The seed puts 500 decoy rules of each type on a DECOY object whose ids sort
// FIRST, and one real rule on the queried object whose id sorts LAST.
// =============================================================================

const CAP_OBJ = 'CustomObject:ZzCapObj';
const CAP_DECOY_OBJ = 'CustomObject:AaDecoyObj';
/** A third object carrying NO rules at all — the control for over-correction. */
const CAP_CLEAN_OBJ = 'CustomObject:ZzCleanObj';
const CAP_PS = 'PermissionSet:ZzCapPS';
const CAP_GOD_PS = 'PermissionSet:ZzCapGodPS';
/** Exactly the graph's `LIST_MAX_LIMIT`, so the target rule falls off the page. */
const CAP_DECOY_COUNT = 500;

const capScanSeed = (): ExtractionResult => {
  const nodes: Node[] = [
    makeNode({ id: CAP_OBJ, apiName: 'ZzCapObj', properties: { sharingModel: 'Private' } }),
    makeNode({
      id: CAP_DECOY_OBJ,
      apiName: 'AaDecoyObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: CAP_CLEAN_OBJ,
      apiName: 'ZzCleanObj',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({ id: CAP_PS, type: 'PermissionSet', apiName: 'ZzCapPS' }),
    makeNode({
      id: CAP_GOD_PS,
      type: 'PermissionSet',
      apiName: 'ZzCapGodPS',
      properties: { userPermissions: ['ModifyAllData'] },
    }),
    // The rules that actually belong to the queried object. Ids sort AFTER
    // every decoy (`Zz…` > `Aa…`).
    makeNode({
      id: 'RestrictionRule:ZzCapObj.Hide_All',
      type: 'RestrictionRule',
      apiName: 'ZzCapObj.Hide_All',
      parentId: CAP_OBJ,
    }),
    makeNode({
      id: 'ScopingRule:ZzCapObj.Scope_Mine',
      type: 'ScopingRule',
      apiName: 'ZzCapObj.Scope_Mine',
      parentId: CAP_OBJ,
    }),
  ];
  for (let i = 0; i < CAP_DECOY_COUNT; i += 1) {
    const n = String(i).padStart(4, '0');
    nodes.push(
      makeNode({
        id: `RestrictionRule:AaDecoyObj.R${n}`,
        type: 'RestrictionRule',
        apiName: `AaDecoyObj.R${n}`,
        parentId: CAP_DECOY_OBJ,
      }),
      makeNode({
        id: `ScopingRule:AaDecoyObj.S${n}`,
        type: 'ScopingRule',
        apiName: `AaDecoyObj.S${n}`,
        parentId: CAP_DECOY_OBJ,
      }),
    );
  }
  return {
    nodes,
    edges: [
      makeEdge({
        fromId: CAP_PS,
        toId: CAP_OBJ,
        edgeType: 'grantedBy',
        properties: { allowRead: true },
      }),
    ],
  };
};

describe('whyCantUserSeeRecordHandler — child-rule scan is not alphabetically capped', () => {
  let capDir: string;
  let capStore: GraphStore;
  let capCtx: Context;

  beforeAll(async () => {
    capDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cap-scan-'));
    const opened = await openGraph(join(capDir, 'cap.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    capStore = opened.value;
    const imported = await importExtractionResults(capStore, [capScanSeed()]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    capCtx = { vaultRoot: capDir, manifest: FIXTURE_MANIFEST, graph: capStore };
  });

  afterAll(async () => {
    await closeGraph(capStore);
    rmSync(capDir, { recursive: true, force: true });
  });

  it('finds a RestrictionRule on the queried object even when 500 other-object rules sort ahead of it', async () => {
    const r = await whyCantUserSeeRecordHandler(capCtx, {
      componentId: CAP_OBJ,
      userContext: { permissionSetIds: [CAP_PS] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rr = r.value.data.reasoning.find((s) => s.stage === 'RestrictionRule');
    expect(rr).toBeDefined();
    // FAIL-BEFORE: verdict `restricted`, reason "no restriction rules attached
    // to this object" — a CHECKED negative from a scan that never looked.
    expect(rr?.reason).not.toContain('no restriction rules attached');
    expect(rr?.verdict).toBe('unknown');
    expect(rr?.reason).toContain('RestrictionRule:ZzCapObj.Hide_All');
  });

  it('finds a ScopingRule on the queried object even when 500 other-object rules sort ahead of it', async () => {
    const r = await whyCantUserSeeRecordHandler(capCtx, {
      componentId: CAP_OBJ,
      userContext: { permissionSetIds: [CAP_PS] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sr = r.value.data.reasoning.find((s) => s.stage === 'ScopingRule');
    expect(sr).toBeDefined();
    expect(sr?.reason).not.toContain('no scoping rules attached');
    expect(sr?.verdict).toBe('unknown');
    expect(sr?.reason).toContain('ScopingRule:ZzCapObj.Scope_Mine');
  });

  it('god-mode stays `unknown` (not a confident `visible`) when the object’s restriction rule sorts past the scan cap', async () => {
    const r = await whyCantUserSeeRecordHandler(capCtx, {
      componentId: CAP_OBJ,
      userContext: { permissionSetIds: [CAP_GOD_PS] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sp = r.value.data.reasoning.find((s) => s.stage === 'SystemPermission');
    expect(sp).toBeDefined();
    // FAIL-BEFORE: `visible` — "grants access to all records regardless of
    // OWD/sharing", with the object's own restriction rule never fetched.
    expect(sp?.verdict).toBe('unknown');
    expect(sp?.reason).toContain('restriction rule');
  });

  // The previous control pointed at CAP_DECOY_OBJ, which carries 500 rules of
  // each type — asserting `unknown` there passes just as happily WITH the bug,
  // so it constrained nothing. The honest control is a third object that owns
  // NO rules: the checked negative must survive the fix, or "always say
  // unknown" would have been a passing over-correction.
  it('CONTROL — an object with NO rules of its own still reports the honest checked negative', async () => {
    const r = await whyCantUserSeeRecordHandler(capCtx, {
      componentId: CAP_CLEAN_OBJ,
      userContext: { permissionSetIds: [CAP_PS] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rr = r.value.data.reasoning.find((s) => s.stage === 'RestrictionRule');
    expect(rr?.verdict).toBe('restricted');
    expect(rr?.reason).toContain('no restriction rules attached');
    const sr = r.value.data.reasoning.find((s) => s.stage === 'ScopingRule');
    expect(sr?.verdict).toBe('restricted');
    expect(sr?.reason).toContain('no scoping rules attached');
  });

  // The per-object page can STILL come back at the cap (an object with more
  // rules of one type than the clamped scan limit). `scanHitCap` /
  // `scanTruncationNote` exist so that page never reads as a complete
  // enumeration; nothing exercised that path, so a silent regression to
  // "page == everything" would have gone unnoticed.
  it('discloses the cap when the per-object page itself comes back full', async () => {
    const prior = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    try {
      const r = await whyCantUserSeeRecordHandler(capCtx, {
        componentId: CAP_DECOY_OBJ,
        userContext: { permissionSetIds: [CAP_PS] },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const rr = r.value.data.reasoning.filter((s) => s.stage === 'RestrictionRule');
      expect(rr.length).toBeGreaterThan(0);
      expect(rr[rr.length - 1]?.reason).toContain('Scan capped at 1 nodes per type');
      expect(rr[rr.length - 1]?.reason).toContain('INCOMPLETE');
    } finally {
      if (prior === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prior;
    }
  });

  it('CONTROL — an uncapped page carries NO truncation note', async () => {
    const r = await whyCantUserSeeRecordHandler(capCtx, {
      componentId: CAP_OBJ,
      userContext: { permissionSetIds: [CAP_PS] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rr = r.value.data.reasoning.find((s) => s.stage === 'RestrictionRule');
    expect(rr?.reason).not.toContain('Scan capped at');
  });
});

// =============================================================================
// R6 — object-alias resolution must be the SHARED one, case-folding included.
//
// The handler hand-rolled object resolution (a Set + two `coercePrefix` calls)
// and so skipped the CASE-CANONICALISATION half that `input-aliases.ts` exists
// for. Salesforce api names are case-insensitive, and an LLM host echoing an
// object name out of a user's sentence lower-cases it, so the org's central
// security-explainer refused (`component-not-found`) a name that `object_360`
// and four other object-scoped tools answer happily. It also had no defence
// against two vault objects differing ONLY by case.
// =============================================================================

describe('whyCantUserSeeRecordHandler — object alias case-folding', () => {
  it('answers a lower-cased objectApiName instead of refusing it', async () => {
    // FAIL-BEFORE: `CustomObject:restrictionobj` — an id no vault holds —
    // straight to `component-not-found`.
    const lower = await whyCantUserSeeRecordHandler(ctx, {
      objectApiName: 'restrictionobj',
      userContext: { permissionSetIds: [RESTRICTION_PS] },
    });
    expect(lower.ok).toBe(true);
    if (!lower.ok) return;
    const exact = await whyCantUserSeeRecordHandler(ctx, {
      componentId: RESTRICTION_OBJ,
      userContext: { permissionSetIds: [RESTRICTION_PS] },
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(lower.value.data.verdict).toBe(exact.value.data.verdict);
    expect(lower.value.data.reasoning).toEqual(exact.value.data.reasoning);
    // `appliedScope` must echo the VAULT's casing, never the caller's, or the
    // response asserts a component id that does not exist.
    expect(lower.value.data.appliedScope.object).toBe(RESTRICTION_OBJ);
  });

  it('answers an UPPER-cased bare componentId too', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: 'RESTRICTIONOBJ',
      userContext: { permissionSetIds: [RESTRICTION_PS] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope.object).toBe(RESTRICTION_OBJ);
  });

  it('CONTROL — a name matching nothing in any casing is still component-not-found', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      objectApiName: 'nosuchobjectanywhere',
      userContext: { profileId: ADMIN_PROFILE },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });
});

// Two objects that differ ONLY by case: case-insensitive RESOLUTION must never
// become case-insensitive IDENTITY. Picking one silently is how a reader ends
// up holding a security answer about the other object.
const CASE_A = 'CustomObject:CaseObj';
const CASE_B = 'CustomObject:CASEOBJ';
const caseAmbiguitySeed: ExtractionResult = {
  nodes: [
    makeNode({ id: CASE_A, apiName: 'CaseObj', properties: { sharingModel: 'Private' } }),
    makeNode({ id: CASE_B, apiName: 'CASEOBJ', properties: { sharingModel: 'Read' } }),
  ],
  edges: [],
};

describe('whyCantUserSeeRecordHandler — two objects differing only by case', () => {
  let ambDir: string;
  let ambStore: GraphStore;
  let ambCtx: Context;

  beforeAll(async () => {
    ambDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-case-amb-'));
    const opened = await openGraph(join(ambDir, 'amb.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    ambStore = opened.value;
    const imported = await importExtractionResults(ambStore, [caseAmbiguitySeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    ambCtx = { vaultRoot: ambDir, manifest: FIXTURE_MANIFEST, graph: ambStore };
  });

  afterAll(async () => {
    await closeGraph(ambStore);
    rmSync(ambDir, { recursive: true, force: true });
  });

  it('refuses rather than silently picking one of two case-variant objects', async () => {
    // FAIL-BEFORE: `CustomObject:caseobj` missed both, so the tool answered
    // `component-not-found` — no ambiguity defence at all.
    const r = await whyCantUserSeeRecordHandler(ambCtx, {
      objectApiName: 'caseobj',
      userContext: { profileId: 'Profile:Whoever' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('differ only by CASE');
    expect(r.error.message).toContain(CASE_A);
    expect(r.error.message).toContain(CASE_B);
  });

  it('an EXACT componentId still resolves to that exact object', async () => {
    const r = await whyCantUserSeeRecordHandler(ambCtx, {
      componentId: CASE_B,
      userContext: { profileId: 'Profile:Whoever' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope.object).toBe(CASE_B);
  });
});
