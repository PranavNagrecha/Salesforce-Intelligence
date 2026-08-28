/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { fieldAccessAuditHandler } from '../../src/tools/field-access-audit.js';
import { resolveContainerAlias } from '../../src/tools/input-aliases.js';
import { userAbilityHandler, userAbilityInputSchema } from '../../src/tools/user-ability.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: 'x.xml', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'Profile:Sales', type: 'Profile', apiName: 'Sales', properties: {
      // The extractor writes `customPermissionGrantCount` on EVERY container it
      // processes, granting containers and zero-granting ones alike, so a
      // fixture without it models a node shape that cannot exist. Present-and-0
      // is the CHECKED zero this file locks below.
      customPermissionGrantCount: 0,
      // Same law, the flowAccess family: the extractor writes `flowGrantCount`
      // on EVERY container it processes (`packages/extractors/src/profile.ts`
      // + `permission-set.ts`), so a fixture without it models a node shape a
      // real refresh cannot produce.
      flowGrantCount: 1,
      userPermissions: ['RunReports', 'ExportReport', 'ApiEnabled', 'ManageUsers' /* admin, filtered out */],
      loginIpRanges: [{ startAddress: '10.0.0.1', endAddress: '10.0.0.255' }],
      loginHoursDefined: true,
      loginHours: [
        { day: 'Monday', startTime: '480', endTime: '1020' },
        { day: 'Tuesday', startTime: '480', endTime: '1020' },
      ],
    } }),
    node({ id: 'PermissionSet:FlowRunner', type: 'PermissionSet', apiName: 'FlowRunner', properties: { userPermissions: [], customPermissionGrantCount: 0, flowGrantCount: 1 } }),
    node({ id: 'Flow:Onboard_Contact', type: 'Flow', apiName: 'Onboard_Contact' }),
    // CR-CAP-10: a defined CustomPermission (resolves) and a permset granting
    // both it and a managed-package perm with no definition (targetMissing).
    node({ id: 'CustomPermission:SkipValidation', type: 'CustomPermission', apiName: 'SkipValidation' }),
    node({ id: 'PermissionSet:CustomPerms', type: 'PermissionSet', apiName: 'CustomPerms', properties: { userPermissions: [], customPermissionGrantCount: 2, flowGrantCount: 0 } }),
    // A container from a vault refreshed BEFORE custom-permission extraction:
    // no sentinel, and therefore no evidence either way. Its empty grant set
    // must read as "not checked", never as a verified zero.
    node({ id: 'PermissionSet:Pre_Extraction_Set', type: 'PermissionSet', apiName: 'Pre_Extraction_Set', properties: { userPermissions: [], flowGrantCount: 0 } }),
    // A permission set granting run access to a flow that is NOT a node here —
    // a managed-package flow, or one this refresh did not retrieve. The
    // importer stamps `targetMissing` on the edge automatically.
    node({ id: 'PermissionSet:PhantomFlowRunner', type: 'PermissionSet', apiName: 'PhantomFlowRunner', properties: { userPermissions: [], customPermissionGrantCount: 0, flowGrantCount: 2 } }),
    // A profile that grants run access to THREE flows — used to exercise the
    // CR-22 cursor over the paged runnableFlows list.
    node({ id: 'Profile:MultiFlow', type: 'Profile', apiName: 'MultiFlow', properties: { userPermissions: [], customPermissionGrantCount: 0, flowGrantCount: 3, loginIpRanges: [], loginHoursDefined: false, loginHours: [] } }),
    node({ id: 'Flow:Alpha', type: 'Flow', apiName: 'Alpha' }),
    node({ id: 'Flow:Beta', type: 'Flow', apiName: 'Beta' }),
    node({ id: 'Flow:Gamma', type: 'Flow', apiName: 'Gamma' }),
    // USER-ABILITY-REJECTS-FIELD-SCOPE: a profile with declared FLS grants, plus
    // real field nodes. Contact.Email = read+edit; Contact.Phone = read only;
    // Contact.Fax = a real field the profile grants NOTHING on (honest no-FLS,
    // not invalid-query).
    node({ id: 'Profile:FieldEditor', type: 'Profile', apiName: 'FieldEditor', properties: { userPermissions: [], customPermissionGrantCount: 0, flowGrantCount: 0, loginIpRanges: [], loginHoursDefined: false, loginHours: [] } }),
    // TYPED ABSENCE, login axis: a Profile from a refresh that predates
    // `collectLoginRestrictions` — no `loginIpRanges` / `loginHoursDefined` /
    // `loginHours` key at all. Its flow + custom-permission families ARE
    // extracted, so the two axes stay independently observable.
    node({ id: 'Profile:Pre_Login_Extraction', type: 'Profile', apiName: 'Pre_Login_Extraction', properties: { userPermissions: [], customPermissionGrantCount: 0, flowGrantCount: 0 } }),
    // TYPED ABSENCE, flow axis: a Profile from a refresh that predates
    // `buildFlowEdges` — no `flowGrantCount` key. Its login + custom-permission
    // families ARE extracted (and declare nothing), which is the CHECKED zero
    // that must not be muted by the flow-family fix.
    node({ id: 'Profile:Pre_Flow_Extraction', type: 'Profile', apiName: 'Pre_Flow_Extraction', properties: { userPermissions: [], customPermissionGrantCount: 0, loginIpRanges: [], loginHoursDefined: false, loginHours: [] } }),
    node({ id: 'CustomField:Contact.Email', type: 'CustomField', apiName: 'Contact.Email' }),
    node({ id: 'CustomField:Contact.Phone', type: 'CustomField', apiName: 'Contact.Phone' }),
    node({ id: 'CustomField:Contact.Fax', type: 'CustomField', apiName: 'Contact.Fax' }),
  ],
  edges: [
    edge({ fromId: 'Profile:FieldEditor', toId: 'CustomField:Contact.Email', edgeType: 'grantedBy', properties: { readable: true, editable: true } }),
    edge({ fromId: 'Profile:FieldEditor', toId: 'CustomField:Contact.Phone', edgeType: 'grantedBy', properties: { readable: true } }),
    edge({ fromId: 'Profile:Sales', toId: 'Flow:Onboard_Contact', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'PermissionSet:FlowRunner', toId: 'Flow:Onboard_Contact', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'Profile:MultiFlow', toId: 'Flow:Alpha', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'Profile:MultiFlow', toId: 'Flow:Beta', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'Profile:MultiFlow', toId: 'Flow:Gamma', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'PermissionSet:PhantomFlowRunner', toId: 'Flow:zeta__Packaged_Flow', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'PermissionSet:PhantomFlowRunner', toId: 'Flow:Onboard_Contact', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'PermissionSet:CustomPerms', toId: 'CustomPermission:SkipValidation', edgeType: 'grantedBy', properties: { enabled: true } }),
    edge({ fromId: 'PermissionSet:CustomPerms', toId: 'CustomPermission:APXTConga4__Composer_Custom_Permission', edgeType: 'grantedBy', properties: { enabled: true } }),
  ],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-user-ability-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('userAbilityHandler', () => {
  it('rejects a non-Profile/PermissionSet id', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('invalid-query');
  });

  it('returns runnable flows + action permissions + login restrictions for a profile', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Sales' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.runnableFlows).toEqual([{ flowId: 'Flow:Onboard_Contact', targetMissing: false }]);
    // ManageUsers (admin) is filtered out; the action perms remain.
    expect(d.actionPermissions).toEqual(['ApiEnabled', 'ExportReport', 'RunReports']);
    expect(d.loginRestrictions.ipRangeCount).toBe(1);
    expect(d.loginRestrictions.loginHoursRestricted).toBe(true);
    expect(d.loginRestrictions.applies).toBe(true);
    // The full IP-range windows are surfaced structurally (not just counted).
    expect(d.loginRestrictions.ipRanges).toEqual([{ startAddress: '10.0.0.1', endAddress: '10.0.0.255' }]);
    // Login-hours per-weekday windows are surfaced structurally too.
    expect(d.loginRestrictions.loginHours).toEqual([
      { day: 'Monday', startTime: '480', endTime: '1020' },
      { day: 'Tuesday', startTime: '480', endTime: '1020' },
    ]);
  });

  it('marks login restrictions not-applicable for a permission set', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'PermissionSet:FlowRunner' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.runnableFlows).toEqual([
      { flowId: 'Flow:Onboard_Contact', targetMissing: false },
    ]);
    expect(r.value.data.loginRestrictions.applies).toBe(false);
    // A permission set carries no login security → empty structured lists.
    expect(r.value.data.loginRestrictions.ipRanges).toEqual([]);
    expect(r.value.data.loginRestrictions.loginHours).toEqual([]);
  });

  it('component-not-found for an unknown id', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Ghost' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('component-not-found');
  });

  // CR-CAP-10: user_ability now surfaces granted custom permissions, marking a
  // managed-package grant whose definition is not in the vault as targetMissing.
  it('surfaces granted custom permissions, flagging the one with no definition as targetMissing', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'PermissionSet:CustomPerms' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.customPermissions).toEqual([
      { name: 'APXTConga4__Composer_Custom_Permission', targetMissing: true },
      { name: 'SkipValidation', targetMissing: false },
    ]);
    expect(d.summary.customPermissions).toBe(2);
    // The disclosure must call out the granted-but-undefined name (not drop it).
    expect(d.boundaryNote).toContain('not present in this vault');
  });

  it('reports zero custom permissions cleanly for a container that grants none', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Sales' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.customPermissions).toEqual([]);
    // A CHECKED zero. It must stay a number — this is the case the null below
    // could most easily swallow, so it is locked hardest.
    expect(r.value.data.summary.customPermissions).toBe(0);
    expect(r.value.data.summary.customPermissions).not.toBeNull();
    expect(r.value.data.boundaryNote).not.toMatch(/Custom permissions were NOT checked/);
    // The clause describing the populated field is present, because it IS
    // populated (with nothing).
    expect(r.value.data.boundaryNote).toContain('customPermissions are declared');
  });

  it('an UNCHECKED custom-permission family is null + disclosed, never a zero', async () => {
    // The finding: on a 0.1.11 vault this reported `0` for 230 of 230
    // containers while 27 permission sets declared 100 real grants. A false 0
    // in a security tool is a missed grant.
    const r = await userAbilityHandler(ctx, { componentId: 'PermissionSet:Pre_Extraction_Set' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.customPermissions).toBeNull();
    expect(d.summary.customPermissions).not.toBe(0);
    // The array stays `[]`; the reader's cue that `[]` is not "none" is the
    // null count plus the sentence.
    expect(d.customPermissions).toEqual([]);
    expect(d.boundaryNote).toMatch(/Custom permissions were NOT checked/);
    expect(d.boundaryNote).toContain('customPermissionGrantCount');
    expect(d.boundaryNote).toContain('PermissionSet:Pre_Extraction_Set');
    // …and the clause that DESCRIBES a populated customPermissions field is
    // suppressed — today it described a field that is not populated, which
    // made the boundaryNote itself the thing that lied.
    expect(d.boundaryNote).not.toContain('customPermissions are declared');
  });
});

// =============================================================================
// TYPED ABSENCE (R1) — the two families this tool still decided by VALUE SHAPE.
// `loginRestrictions` was `{ ipRangeCount: 0, loginHoursRestricted: false }` for
// a Profile on a vault predating `collectLoginRestrictions` — a SECURITY-POSTURE
// claim ("checked; not IP- or hours-restricted") derived from `!Array.isArray`
// and `=== true`. `summary.runnableFlows` was a bare `0` for a Profile on a
// vault predating `buildFlowEdges` — "can run no flows" — while the line under
// it (`customPermissions`) had already been typed `number | null` for exactly
// this reason. Both are now decided by the extractor's always-written sentinel
// (`loginIpRanges` / `flowGrantCount`) via `familyWasExtracted`.
// =============================================================================
describe('userAbilityHandler — typed absence on the login + flow families', () => {
  it('an UNCHECKED login-restriction family is null + disclosed, never a verified "unrestricted"', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Pre_Login_Extraction' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    // NOT 0 / false / [] — those are the CHECKED answers and this was not checked.
    expect(d.loginRestrictions.ipRangeCount).toBeNull();
    expect(d.loginRestrictions.ipRangeCount).not.toBe(0);
    expect(d.loginRestrictions.loginHoursRestricted).toBeNull();
    expect(d.loginRestrictions.loginHoursRestricted).not.toBe(false);
    expect(d.loginRestrictions.ipRanges).toBeNull();
    expect(d.loginRestrictions.loginHours).toBeNull();
    // `applies` still says the axis is MEANINGFUL for a Profile; the nulls say
    // it was not measured. The two are different claims.
    expect(d.loginRestrictions.applies).toBe(true);
    expect(d.boundaryNote).toMatch(/Login restrictions were NOT checked/);
    expect(d.boundaryNote).toContain('loginIpRanges');
    expect(d.boundaryNote).toContain('Profile:Pre_Login_Extraction');
  });

  it('a CHECKED-and-clean login-restriction family stays 0 / false / [], never null', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Pre_Flow_Extraction' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.loginRestrictions.ipRangeCount).toBe(0);
    expect(d.loginRestrictions.ipRangeCount).not.toBeNull();
    expect(d.loginRestrictions.loginHoursRestricted).toBe(false);
    expect(d.loginRestrictions.loginHoursRestricted).not.toBeNull();
    expect(d.loginRestrictions.ipRanges).toEqual([]);
    expect(d.loginRestrictions.loginHours).toEqual([]);
    expect(d.boundaryNote).not.toMatch(/Login restrictions were NOT checked/);
  });

  it('an UNCHECKED flowAccess family is summary.runnableFlows: null + disclosed, never a zero', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Pre_Flow_Extraction' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.runnableFlows).toBeNull();
    expect(d.summary.runnableFlows).not.toBe(0);
    // The list stays `[]`; the reader's cue that `[]` is not "none" is the null
    // count plus the sentence — the same contract `customPermissions` carries.
    expect(d.runnableFlows).toEqual([]);
    expect(d.boundaryNote).toMatch(/Flow run grants were NOT checked/);
    expect(d.boundaryNote).toContain('flowGrantCount');
    expect(d.boundaryNote).toContain('Profile:Pre_Flow_Extraction');
    // The clause that DESCRIBES a populated runnableFlows list is suppressed —
    // it is not populated, so keeping it makes the boundaryNote itself lie.
    expect(d.boundaryNote).not.toContain('runnableFlows = the flowAccess grants');
  });

  it('a CHECKED zero flow family stays 0 and keeps its describing clause', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Pre_Login_Extraction' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.runnableFlows).toBe(0);
    expect(d.summary.runnableFlows).not.toBeNull();
    expect(d.boundaryNote).not.toMatch(/Flow run grants were NOT checked/);
    expect(d.boundaryNote).toContain('runnableFlows = the flowAccess grants');
  });

  it('a granting container still reports its real flow total, unmuted', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:MultiFlow' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.summary.runnableFlows).toBe(3);
  });

  it('a permission set is N/A-by-design on login security, not unchecked', async () => {
    // `applies:false` already states the axis does not exist for a permission
    // set, so its zeros must NOT be muted into nulls — that would report a
    // BLIND SPOT where there is none.
    const r = await userAbilityHandler(ctx, { componentId: 'PermissionSet:FlowRunner' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.loginRestrictions.applies).toBe(false);
    expect(d.loginRestrictions.ipRangeCount).toBe(0);
    expect(d.loginRestrictions.loginHoursRestricted).toBe(false);
    expect(d.loginRestrictions.ipRanges).toEqual([]);
    expect(d.loginRestrictions.loginHours).toEqual([]);
    expect(d.boundaryNote).not.toMatch(/Login restrictions were NOT checked/);
  });
});

// =============================================================================
// GUARD (USER-ABILITY-REJECTS-FIELD-SCOPE): a natural "can {profile} edit
// {Object}.{field}?" passes a field scope (`objectApiName`+`fieldApiName`, or a
// `fieldId`). Pre-fix these were rejected (componentId required) and the tool
// only answered the profile-only ability inventory. Post-fix the field resolves,
// a `fieldAccess` FLS block + `appliedScope` are added, an unresolvable field is
// invalid-query, and a call without a field scope is byte-identical.
// =============================================================================
describe('userAbilityHandler — field scope (guard)', () => {
  it('objectApiName + fieldApiName answers FLS read/edit + echoes appliedScope', async () => {
    const r = await userAbilityHandler(ctx, {
      componentId: 'Profile:FieldEditor',
      objectApiName: 'Contact',
      fieldApiName: 'Email',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({
      container: 'Profile:FieldEditor',
      field: 'CustomField:Contact.Email',
    });
    // `readable` / `editable` keep their FLS-ONLY meaning, byte for byte. The
    // block gained the COMPOSED answer beside them; this pin is about the FLS
    // half, so it asserts that half exactly.
    expect(r.value.data.fieldAccess).toMatchObject({
      field: 'CustomField:Contact.Email',
      readable: true,
      editable: true,
    });
    expect(r.value.data.boundaryNote).toContain('fieldAccess');
  });

  it('a read-only FLS grant is readable:true, editable:false', async () => {
    const r = await userAbilityHandler(ctx, {
      componentId: 'Profile:FieldEditor',
      fieldId: 'CustomField:Contact.Phone',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.fieldAccess).toMatchObject({
      field: 'CustomField:Contact.Phone',
      readable: true,
      editable: false,
    });
    // No FLS Edit is a CHECKED denial — not an unknown.
    expect(r.value.data.fieldAccess?.canUpdate).toBe(false);
    expect(r.value.data.fieldAccess?.reason).toMatch(/declares no FLS Edit/);
  });

  it('fieldId ≡ objectApiName+fieldApiName (byte-equal data)', async () => {
    const viaId = await userAbilityHandler(ctx, {
      componentId: 'Profile:FieldEditor',
      fieldId: 'CustomField:Contact.Email',
    });
    const viaParts = await userAbilityHandler(ctx, {
      componentId: 'Profile:FieldEditor',
      objectApiName: 'Contact',
      fieldApiName: 'Email',
    });
    expect(viaId.ok && viaParts.ok).toBe(true);
    if (!viaId.ok || !viaParts.ok) return;
    expect(JSON.stringify(viaId.value.data)).toBe(JSON.stringify(viaParts.value.data));
  });

  it('a real field the container grants no FLS on is an honest {readable:false, editable:false}, not invalid-query', async () => {
    const r = await userAbilityHandler(ctx, {
      componentId: 'Profile:FieldEditor',
      fieldId: 'CustomField:Contact.Fax',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.fieldAccess).toMatchObject({
      field: 'CustomField:Contact.Fax',
      readable: false,
      editable: false,
    });
  });

  it('an unresolvable field (no node, no grant) → invalid-query, never a silent field-dropped answer', async () => {
    const r = await userAbilityHandler(ctx, {
      componentId: 'Profile:FieldEditor',
      objectApiName: 'Contact',
      fieldApiName: 'Ghost__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('CustomField:Contact.Ghost__c');
  });

  it('a bare field name with no object → invalid-query naming the object', async () => {
    const r = await userAbilityHandler(ctx, {
      componentId: 'Profile:FieldEditor',
      fieldApiName: 'Email',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('objectApiName');
  });

  it('a call WITHOUT a field scope reports NO field scope — only the container echo', async () => {
    // This pin was written for the FIELD axis: a call that named no field must
    // not report one, and must not grow a fieldAccess block. Both hold. What
    // changed is that the CONTAINER axis now echoes unconditionally, so the
    // assertion is narrowed to the axis it is about rather than deleted.
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Sales' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({ container: 'Profile:Sales' });
    expect(r.value.data.appliedScope.field).toBeUndefined();
    expect('fieldAccess' in r.value.data).toBe(false);
  });
});

// =============================================================================
// GUARD (USER-ABILITY-REJECTS-FIELD-SCOPE — narrowed residual): the container
// used to be nameable ONLY by its canonical `componentId` — a natural
// `profileApiName` / `permissionSetApiName` (the form a router-driven host
// passes) hard-failed with "componentId: Required". Post-fix the selector is
// merged into `componentId` by the schema preprocess (canonical `componentId`
// still wins), the field+profile natural shape resolves the profile AND returns
// FLS, a call naming NO container is a NAMED invalid-query (never a bare Zod
// error), and the canonical `componentId` path stays byte-identical.
// =============================================================================
describe('userAbilityInputSchema — profileApiName / permissionSetApiName selector', () => {
  it('coerces a bare profileApiName / permissionSetApiName / id alias to the container prefix', () => {
    // The COERCION moved out of the schema's z.preprocess and into the
    // handler's `resolveContainerAlias`, because a preprocess step cannot emit
    // a named invalid-query and this axis now has to refuse. The coercion
    // invariant is unchanged; it is asserted at its new site. Crucially, the
    // prefix now comes from EACH KEY'S OWN NAME rather than from the presence
    // of a sibling key.
    const idOf = (raw: Record<string, unknown>): string => {
      const r = resolveContainerAlias(userAbilityInputSchema.parse(raw));
      if (!r.ok) throw new Error(`unexpected refusal: ${r.error.message}`);
      return (r.value as { componentId: string }).componentId;
    };
    expect(idOf({ profileApiName: 'StandardUser' })).toBe('Profile:StandardUser');
    expect(idOf({ permissionSetApiName: 'FlowRunner' })).toBe('PermissionSet:FlowRunner');
    expect(idOf({ profileId: 'StandardUser' })).toBe('Profile:StandardUser');
    expect(idOf({ permissionSetId: 'FlowRunner' })).toBe('PermissionSet:FlowRunner');
    // An already-canonical componentId is left untouched.
    expect(idOf({ componentId: 'Profile:Sales' })).toBe('Profile:Sales');
    // Agreeing selectors collapse to one candidate and still resolve.
    expect(idOf({ componentId: 'Profile:Sales', profileApiName: 'Sales' })).toBe('Profile:Sales');
  });

  it('a DISAGREEING componentId + alias is REFUSED, not silently won by componentId', async () => {
    // Pre-fix this answered about `Profile:Sales` and dropped `Other` silently.
    // CLAUDE.md states the required behaviour verbatim: when the selectors
    // disagree the tool refuses with a named `invalid-query`.
    const r = await userAbilityHandler(
      ctx,
      userAbilityInputSchema.parse({ componentId: 'Profile:Sales', profileApiName: 'Other' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Profile:Sales');
    expect(r.error.message).toContain('Profile:Other');
  });

  it('{ profileApiName } ≡ { componentId: Profile:X } (byte-identical data)', async () => {
    const natural = await userAbilityHandler(
      ctx,
      userAbilityInputSchema.parse({ profileApiName: 'Sales' }),
    );
    const canonical = await userAbilityHandler(
      ctx,
      userAbilityInputSchema.parse({ componentId: 'Profile:Sales' }),
    );
    expect(natural.ok && canonical.ok).toBe(true);
    if (!natural.ok || !canonical.ok) return;
    expect(JSON.stringify(natural.value.data)).toBe(JSON.stringify(canonical.value.data));
  });

  it('{ profileApiName, objectApiName, fieldApiName } resolves the profile AND returns field FLS', async () => {
    const r = await userAbilityHandler(
      ctx,
      userAbilityInputSchema.parse({
        profileApiName: 'FieldEditor',
        objectApiName: 'Contact',
        fieldApiName: 'Email',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.componentId).toBe('Profile:FieldEditor');
    expect(r.value.data.appliedScope).toEqual({
      container: 'Profile:FieldEditor',
      field: 'CustomField:Contact.Email',
    });
    expect(r.value.data.fieldAccess).toMatchObject({
      field: 'CustomField:Contact.Email',
      readable: true,
      editable: true,
    });
  });

  it('field+profile natural shape ≡ canonical componentId + fieldId (byte-identical data)', async () => {
    const natural = await userAbilityHandler(
      ctx,
      userAbilityInputSchema.parse({
        profileApiName: 'FieldEditor',
        objectApiName: 'Contact',
        fieldApiName: 'Email',
      }),
    );
    const canonical = await userAbilityHandler(
      ctx,
      userAbilityInputSchema.parse({
        componentId: 'Profile:FieldEditor',
        fieldId: 'CustomField:Contact.Email',
      }),
    );
    expect(natural.ok && canonical.ok).toBe(true);
    if (!natural.ok || !canonical.ok) return;
    expect(JSON.stringify(natural.value.data)).toBe(JSON.stringify(canonical.value.data));
  });

  it('a call naming NO container (field scope but no profile) → a NAMED invalid-query, not a bare Zod error', async () => {
    const r = await userAbilityHandler(
      ctx,
      userAbilityInputSchema.parse({ objectApiName: 'Contact', fieldApiName: 'Email' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    // The message names the natural selectors, never the raw "componentId: Required".
    expect(r.error.message).toContain('profileApiName');
    expect(r.error.message).not.toBe('componentId: Required');
  });

  it('an unknown profile named by its natural api name still → component-not-found (selector resolved, node absent)', async () => {
    const r = await userAbilityHandler(
      ctx,
      userAbilityInputSchema.parse({ profileApiName: 'GhostProfile' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });
});

describe('userAbilityHandler — CR-22 continuation cursor', () => {
  it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:MultiFlow' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.runnableFlows.length).toBe(3);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.hasMore).toBe(false);
    // The golden shape: runnableFlows is a TOTAL-ORDERED list keyed on `flowId`.
    //
    // This pin was written as a CR-22 cursor-shape guard — it exists to catch
    // accidental drift in the paginated element, and every invariant it guards
    // is preserved verbatim above and below (3 rows, sorted, no cursor on a
    // whole-fits page). The element gained a `targetMissing` marker so a grant
    // naming a flow that is not in this vault is disclosed rather than emitted
    // as a bare id that dead-ends in `resolve`; the ORDER KEY is still the flow
    // id, which is what the resume depends on.
    expect(d.runnableFlows).toEqual([
      { flowId: 'Flow:Alpha', targetMissing: false },
      { flowId: 'Flow:Beta', targetMissing: false },
      { flowId: 'Flow:Gamma', targetMissing: false },
    ]);
    expect(d.runnableFlows.map((f) => f.flowId)).toEqual(['Flow:Alpha', 'Flow:Beta', 'Flow:Gamma']);
  });

  it('a truncated (over-limit) page emits a nextCursor that resumes with no gaps/dupes', async () => {
    const first = await userAbilityHandler(ctx, { componentId: 'Profile:MultiFlow', limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const d1 = first.value.data;
    expect(d1.runnableFlows.length).toBe(2);
    expect(d1.hasMore).toBe(true);
    expect(typeof d1.nextCursor).toBe('string');
    expect(d1.pageInfo?.nextCursor).toBe(d1.nextCursor);

    const second = await userAbilityHandler(ctx, {
      componentId: 'Profile:MultiFlow',
      limit: 2,
      cursor: d1.nextCursor as string,
    });
    expect(second.ok).toBe(true); if (!second.ok) return;
    const d2 = second.value.data;
    expect(d2.runnableFlows.length).toBe(1);
    expect(d2.hasMore).toBe(false);
    expect('nextCursor' in d2).toBe(false);

    const combined = [...d1.runnableFlows, ...d2.runnableFlows].map((f) => f.flowId);
    expect(new Set(combined).size).toBe(3); // no dupes
    expect([...combined].sort()).toEqual(['Flow:Alpha', 'Flow:Beta', 'Flow:Gamma']); // no gaps
  });

  it('rejects a cursor minted for a DIFFERENT componentId', async () => {
    const first = await userAbilityHandler(ctx, { componentId: 'Profile:MultiFlow', limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    const replay = await userAbilityHandler(ctx, { componentId: 'Profile:Sales', cursor });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed / forged cursor string', async () => {
    const replay = await userAbilityHandler(ctx, {
      componentId: 'Profile:MultiFlow',
      cursor: 'not-a-real-cursor',
    });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});

// =============================================================================
// FIX 5 shape 3 — the worst of the three, reproduced end to end.
//
// A vault where the SAME api name exists as both a Profile and a PermissionSet.
// Pre-fix, `{ profileApiName: 'X', permissionSetApiName: 'Y' }` took the VALUE
// from profileApiName and the PREFIX from the mere PRESENCE of
// permissionSetApiName, so the tool answered about `PermissionSet:X` — a THIRD
// component neither selector named — and the answer differs materially
// (`loginRestrictions.applies` flips between a Profile and a PermissionSet).
// =============================================================================

const collisionSeed: ExtractionResult = {
  nodes: [
    node({
      id: 'Profile:Ambiguous_Name',
      type: 'Profile',
      apiName: 'Ambiguous_Name',
      properties: {
        loginHoursDefined: true,
        loginIpRanges: [{ startAddress: '10.0.0.1', endAddress: '10.0.0.9' }],
      },
    }),
    node({
      id: 'PermissionSet:Ambiguous_Name',
      type: 'PermissionSet',
      apiName: 'Ambiguous_Name',
      properties: { userPermissions: ['RunReports'] },
    }),
    node({ id: 'PermissionSet:Distinct_Set', type: 'PermissionSet', apiName: 'Distinct_Set' }),
  ],
  edges: [],
};

describe('userAbilityHandler — disagreeing container selectors (FIX 5 shape 3)', () => {
  let colDir: string;
  let colStore: GraphStore;
  let colCtx: Context;

  beforeAll(async () => {
    colDir = mkdtempSync(join(tmpdir(), 'sfi-ua-collision-'));
    const o = await openGraph(join(colDir, 'g.db'));
    if (!o.ok) throw new Error(o.error.message);
    colStore = o.value;
    const i = await importExtractionResults(colStore, [collisionSeed]);
    if (!i.ok) throw new Error(i.error.message);
    colCtx = { vaultRoot: colDir, manifest: MANIFEST, graph: colStore };
  });

  afterAll(async () => {
    await closeGraph(colStore);
    rmSync(colDir, { recursive: true, force: true });
  });

  it('refuses instead of answering about a THIRD component neither selector named', async () => {
    const r = await userAbilityHandler(
      colCtx,
      userAbilityInputSchema.parse({
        profileApiName: 'Ambiguous_Name',
        permissionSetApiName: 'Distinct_Set',
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    // Both ids the caller actually named are in the message…
    expect(r.error.message).toContain('Profile:Ambiguous_Name');
    expect(r.error.message).toContain('PermissionSet:Distinct_Set');
    // …and the third component the old preprocess would have answered about is
    // nowhere in the response.
    expect(r.error.message).not.toContain('PermissionSet:Ambiguous_Name');
  });

  it('either selector ALONE still answers, and the two answers differ materially', async () => {
    const asProfile = await userAbilityHandler(
      colCtx,
      userAbilityInputSchema.parse({ profileApiName: 'Ambiguous_Name' }),
    );
    const asPermSet = await userAbilityHandler(
      colCtx,
      userAbilityInputSchema.parse({ permissionSetApiName: 'Ambiguous_Name' }),
    );
    expect(asProfile.ok && asPermSet.ok).toBe(true);
    if (!asProfile.ok || !asPermSet.ok) return;
    expect(asProfile.value.data.appliedScope.container).toBe('Profile:Ambiguous_Name');
    expect(asPermSet.value.data.appliedScope.container).toBe('PermissionSet:Ambiguous_Name');
    // This is why picking one silently was never acceptable.
    expect(asProfile.value.data.loginRestrictions.applies).toBe(true);
    expect(asPermSet.value.data.loginRestrictions.applies).toBe(false);
  });
});

// =============================================================================
// FIX 8 — a grant row whose TARGET is not in this vault.
//
// Direct blast radius here is small; the same importer marker sits on thousands
// of ApexClass / CustomField / CustomObject grant edges. The failure mode is
// specific and expensive: the admin follows the id, `resolve` / `get_component`
// dead-ends, and they conclude THE VAULT IS BROKEN rather than that the
// component is managed-package. That is a trust failure, not a cosmetic one.
//
// `user_ability` already gets this right twelve lines below the bug, for custom
// permissions. The flow list threw the same information away.
// =============================================================================
describe('userAbilityHandler — unresolvable flow grant targets', () => {
  it('marks the row and discloses it, instead of emitting a bare id that dead-ends', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'PermissionSet:PhantomFlowRunner' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.runnableFlows).toEqual([
      { flowId: 'Flow:Onboard_Contact', targetMissing: false },
      { flowId: 'Flow:zeta__Packaged_Flow', targetMissing: true },
    ]);
    expect(d.summary.runnableFlows).toBe(2);
    expect(d.boundaryNote).toMatch(/NOT in this vault/);
    expect(d.boundaryNote).toContain('1 Flow grant(s) above');
    expect(d.boundaryNote).toContain('The GRANT is declared and real');
    expect(d.boundaryNote).toContain('component-not-found');
  });

  it('a fully-resolvable flow list carries no disclosure at all', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:MultiFlow' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.runnableFlows.every((f) => f.targetMissing === false)).toBe(true);
    expect(d.boundaryNote).not.toMatch(/NOT in this vault/);
  });
});

// =============================================================================
// FIX 3 — `editable: true` for a field whose object the container cannot edit.
//
// Field-level security is a NECESSARY but not SUFFICIENT condition. 7,900
// measured field/container pairs in one vault hold FLS Edit while the
// container's OWN `<objectPermissions>` row says `allowEdit: false` — an
// airtight false `true`. A sibling tool, `field_access_audit`, returned the
// opposite answer to the identical question about the identical vault, because
// each derived the rule privately.
//
// The composed answer uses the SAME predicates as the sibling, so the two agree
// by construction rather than by coincidence.
// =============================================================================

const OBJ_DENIED = 'Profile:Object_Denied';
const OBJ_ALLOWED = 'Profile:Object_Allowed';
const OBJ_NOROW = 'Profile:Object_No_Row';
const FLD = 'CustomField:Widget__c.Serial__c';
const FORMULA_FLD = 'CustomField:Widget__c.Derived__c';

const crudSeed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Widget__c', type: 'CustomObject', apiName: 'Widget__c' }),
    node({ id: FLD, type: 'CustomField', apiName: 'Widget__c.Serial__c' }),
    node({
      id: FORMULA_FLD,
      type: 'CustomField',
      apiName: 'Widget__c.Derived__c',
      properties: { formula: 'Serial__c & "-x"' },
    }),
    node({ id: OBJ_DENIED, type: 'Profile', apiName: 'Object_Denied', properties: { userPermissions: [], customPermissionGrantCount: 0 } }),
    node({ id: OBJ_ALLOWED, type: 'Profile', apiName: 'Object_Allowed', properties: { userPermissions: [], customPermissionGrantCount: 0 } }),
    node({ id: OBJ_NOROW, type: 'Profile', apiName: 'Object_No_Row', properties: { userPermissions: [], customPermissionGrantCount: 0 } }),
  ],
  edges: [
    // FLS Edit on the field, but the object row explicitly denies Edit.
    edge({ fromId: OBJ_DENIED, toId: FLD, edgeType: 'grantedBy', properties: { readable: true, editable: true } }),
    edge({ fromId: OBJ_DENIED, toId: 'CustomObject:Widget__c', edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: false } }),
    // FLS Edit AND object Edit.
    edge({ fromId: OBJ_ALLOWED, toId: FLD, edgeType: 'grantedBy', properties: { readable: true, editable: true } }),
    edge({ fromId: OBJ_ALLOWED, toId: 'CustomObject:Widget__c', edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true } }),
    edge({ fromId: OBJ_ALLOWED, toId: FORMULA_FLD, edgeType: 'grantedBy', properties: { readable: true, editable: true } }),
    // FLS Edit and NO object row at all — the dominant real-world shape.
    edge({ fromId: OBJ_NOROW, toId: FLD, edgeType: 'grantedBy', properties: { readable: true, editable: true } }),
  ],
};

describe('userAbilityHandler — FLS composed with object CRUD', () => {
  let crudDir: string;
  let crudStore: GraphStore;
  let crudCtx: Context;

  beforeAll(async () => {
    crudDir = mkdtempSync(join(tmpdir(), 'sfi-ua-crud-'));
    const o = await openGraph(join(crudDir, 'g.db'));
    if (!o.ok) throw new Error(o.error.message);
    crudStore = o.value;
    const i = await importExtractionResults(crudStore, [crudSeed]);
    if (!i.ok) throw new Error(i.error.message);
    crudCtx = { vaultRoot: crudDir, manifest: MANIFEST, graph: crudStore };
  });

  afterAll(async () => {
    await closeGraph(crudStore);
    rmSync(crudDir, { recursive: true, force: true });
  });

  it('an explicit allowEdit:false object row makes canUpdate FALSE, with editable:true intact', async () => {
    const r = await userAbilityHandler(
      crudCtx,
      userAbilityInputSchema.parse({ profileApiName: 'Object_Denied', fieldId: FLD }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fa = r.value.data.fieldAccess;
    // The FLS half is UNCHANGED — that was never wrong, only incomplete.
    expect(fa?.editable).toBe(true);
    // The whole answer was `editable: true`. It is now composed.
    expect(fa?.canUpdate).toBe(false);
    expect(fa?.reason).toMatch(/allowEdit: false/);
    expect(fa?.objectPermission).toEqual({
      object: 'Widget__c',
      allowRead: true,
      allowEdit: false,
      modifyAllRecords: false,
    });
    expect(fa?.canRead).toBe(true);
  });

  it('NO object row is canUpdate null — absent is NOT denied', async () => {
    const r = await userAbilityHandler(
      crudCtx,
      userAbilityInputSchema.parse({ profileApiName: 'Object_No_Row', fieldId: FLD }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fa = r.value.data.fieldAccess;
    expect(fa?.objectPermission).toBeNull();
    expect(fa?.canUpdate).toBeNull();
    // THIS assertion is the finding: a fabricated `false` here would be a
    // proven denial the vault never proved.
    expect(fa?.canUpdate).not.toBe(false);
    expect(fa?.canRead).toBeNull();
    expect(fa?.reason).toMatch(/NOT CHECKED/);
    expect(fa?.reason).toContain('absent is not denied');
    expect(fa?.reason).toContain('/sfi-refresh');
  });

  it('FLS Edit AND object Edit is canUpdate true, carrying the record-edit dependency', async () => {
    const r = await userAbilityHandler(
      crudCtx,
      userAbilityInputSchema.parse({ profileApiName: 'Object_Allowed', fieldId: FLD }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fa = r.value.data.fieldAccess;
    expect(fa?.canUpdate).toBe(true);
    expect(fa?.canRead).toBe(true);
    expect(fa?.reason).toContain('BOTH declared FLS Edit');
    expect(fa?.reason).toContain('EDIT access to the specific record');
  });

  it('a FORMULA field is canUpdate false even with full grants', async () => {
    const r = await userAbilityHandler(
      crudCtx,
      userAbilityInputSchema.parse({ profileApiName: 'Object_Allowed', fieldId: FORMULA_FLD }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fa = r.value.data.fieldAccess;
    expect(fa?.fieldUpdatable).toBe(false);
    expect(fa?.canUpdate).toBe(false);
    expect(fa?.reason).toMatch(/formula field/);
  });

  it('the boundaryNote names the object-CRUD precondition it never used to mention', async () => {
    const r = await userAbilityHandler(
      crudCtx,
      userAbilityInputSchema.parse({ profileApiName: 'Object_Denied', fieldId: FLD }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaryNote).toContain('NECESSARY but not SUFFICIENT');
    expect(r.value.data.boundaryNote).toContain('object-level Edit on Widget__c');
  });

  it('CROSS-TOOL AGREEMENT: user_ability and field_access_audit no longer contradict', async () => {
    // The denial case: field_access_audit omits the profile from canUpdate,
    // user_ability says canUpdate:false. Same claim, two shapes.
    const audit = await fieldAccessAuditHandler(crudCtx, { fieldId: FLD });
    expect(audit.ok).toBe(true);
    if (!audit.ok) return;
    const canUpdateIds = audit.value.data.update.canUpdate.map((g) => g.grantorId);
    expect(canUpdateIds).not.toContain(OBJ_DENIED);
    expect(canUpdateIds).toContain(OBJ_ALLOWED);

    const denied = await userAbilityHandler(
      crudCtx,
      userAbilityInputSchema.parse({ profileApiName: 'Object_Denied', fieldId: FLD }),
    );
    expect(denied.ok).toBe(true);
    if (!denied.ok) return;
    expect(denied.value.data.fieldAccess?.canUpdate).toBe(false);

    // The NO-ROW case: field_access_audit also omits it, which would read as a
    // denial. It now COUNTS and NAMES it instead, matching user_ability's null.
    expect(canUpdateIds).not.toContain(OBJ_NOROW);
    expect(audit.value.data.update.flsEditWithoutObjectRow).toBe(1);
    expect(audit.value.data.update.objectRowNote).toMatch(/not a proven denial/);
    expect(audit.value.data.update.objectRowNote).toContain('Widget__c');

    const noRow = await userAbilityHandler(
      crudCtx,
      userAbilityInputSchema.parse({ profileApiName: 'Object_No_Row', fieldId: FLD }),
    );
    expect(noRow.ok).toBe(true);
    if (!noRow.ok) return;
    expect(noRow.value.data.fieldAccess?.canUpdate).toBeNull();
  });
});
