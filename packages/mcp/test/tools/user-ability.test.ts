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
      userPermissions: ['RunReports', 'ExportReport', 'ApiEnabled', 'ManageUsers' /* admin, filtered out */],
      loginIpRanges: [{ startAddress: '10.0.0.1', endAddress: '10.0.0.255' }],
      loginHoursDefined: true,
      loginHours: [
        { day: 'Monday', startTime: '480', endTime: '1020' },
        { day: 'Tuesday', startTime: '480', endTime: '1020' },
      ],
    } }),
    node({ id: 'PermissionSet:FlowRunner', type: 'PermissionSet', apiName: 'FlowRunner', properties: { userPermissions: [] } }),
    node({ id: 'Flow:Onboard_Contact', type: 'Flow', apiName: 'Onboard_Contact' }),
    // CR-CAP-10: a defined CustomPermission (resolves) and a permset granting
    // both it and a managed-package perm with no definition (targetMissing).
    node({ id: 'CustomPermission:SkipValidation', type: 'CustomPermission', apiName: 'SkipValidation' }),
    node({ id: 'PermissionSet:CustomPerms', type: 'PermissionSet', apiName: 'CustomPerms', properties: { userPermissions: [] } }),
    // A profile that grants run access to THREE flows — used to exercise the
    // CR-22 cursor over the paged runnableFlows list.
    node({ id: 'Profile:MultiFlow', type: 'Profile', apiName: 'MultiFlow', properties: { userPermissions: [] } }),
    node({ id: 'Flow:Alpha', type: 'Flow', apiName: 'Alpha' }),
    node({ id: 'Flow:Beta', type: 'Flow', apiName: 'Beta' }),
    node({ id: 'Flow:Gamma', type: 'Flow', apiName: 'Gamma' }),
    // USER-ABILITY-REJECTS-FIELD-SCOPE: a profile with declared FLS grants, plus
    // real field nodes. Contact.Email = read+edit; Contact.Phone = read only;
    // Contact.Fax = a real field the profile grants NOTHING on (honest no-FLS,
    // not invalid-query).
    node({ id: 'Profile:FieldEditor', type: 'Profile', apiName: 'FieldEditor', properties: { userPermissions: [] } }),
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
    expect(d.runnableFlows).toEqual(['Flow:Onboard_Contact']);
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
    expect(r.value.data.runnableFlows).toEqual(['Flow:Onboard_Contact']);
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
    expect(r.value.data.summary.customPermissions).toBe(0);
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
    expect(r.value.data.fieldAccess).toEqual({
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
    expect(r.value.data.fieldAccess).toEqual({
      field: 'CustomField:Contact.Phone',
      readable: true,
      editable: false,
    });
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
    expect(r.value.data.fieldAccess).toEqual({
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
    expect(r.value.data.fieldAccess).toEqual({
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
    // The golden shape: runnableFlows stays a bare ComponentId[] string array.
    expect(d.runnableFlows).toEqual(['Flow:Alpha', 'Flow:Beta', 'Flow:Gamma']);
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

    const combined = [...d1.runnableFlows, ...d2.runnableFlows];
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
