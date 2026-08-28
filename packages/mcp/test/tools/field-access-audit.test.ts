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
  fieldAccessAuditHandler,
  fieldAccessAuditInputSchema,
} from '../../src/tools/field-access-audit.js';
import { V01_TOOLS } from '../../src/tools/roster.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 1,
    CustomField: 3,
    Profile: 2,
    PermissionSet: 2,
    ApexClass: 2,
  },
  edges: { grantedBy: 6, readsFrom: 1, writesTo: 1 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Industry__c',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { dataType: 'Text' },
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
// Seed: Contact CustomObject parent.
// =============================================================================

const CONTACT_ID = 'CustomObject:Contact';
const containerSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: CONTACT_ID, type: 'CustomObject', apiName: 'Contact' }),
  ],
  edges: [],
};

// =============================================================================
// Seed: SSN__c field with 4 permission grants (2 Profiles, 2 PermSets) and
// 2 Apex-via-access edges (one readsFrom, one writesTo).
// =============================================================================

const SSN_FIELD = 'CustomField:Contact.SSN__c';
const PROFILE_ADMIN = 'Profile:System Administrator';
const PROFILE_STD = 'Profile:Standard User';
const PERMSET_HIPAA = 'PermissionSet:HIPAA_Compliance';
const PERMSET_AUDIT = 'PermissionSet:Audit_Readonly';
const APEX_READER = 'ApexClass:ContactService';
const APEX_WRITER = 'ApexClass:DataSync';

const ssnSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: SSN_FIELD,
      apiName: 'SSN__c',
      label: 'Social Security Number',
      parentId: CONTACT_ID,
    }),
    makeNode({
      id: PROFILE_ADMIN,
      type: 'Profile',
      apiName: 'System Administrator',
      label: 'System Administrator',
    }),
    makeNode({
      id: PROFILE_STD,
      type: 'Profile',
      apiName: 'Standard User',
      label: 'Standard User',
    }),
    makeNode({
      id: PERMSET_HIPAA,
      type: 'PermissionSet',
      apiName: 'HIPAA_Compliance',
      label: 'HIPAA Compliance',
    }),
    makeNode({
      id: PERMSET_AUDIT,
      type: 'PermissionSet',
      apiName: 'Audit_Readonly',
      label: 'Audit Readonly',
    }),
    makeNode({
      id: APEX_READER,
      type: 'ApexClass',
      apiName: 'ContactService',
      label: 'ContactService',
    }),
    makeNode({
      id: APEX_WRITER,
      type: 'ApexClass',
      apiName: 'DataSync',
      label: 'DataSync',
    }),
  ],
  edges: [
    // Profile:System Administrator grants edit access.
    makeEdge({
      fromId: PROFILE_ADMIN,
      toId: SSN_FIELD,
      edgeType: 'grantedBy',
      properties: { read: true, edit: true },
    }),
    // Profile:Standard User grants read-only access.
    makeEdge({
      fromId: PROFILE_STD,
      toId: SSN_FIELD,
      edgeType: 'grantedBy',
      properties: { read: true, edit: false },
    }),
    // PermissionSet:HIPAA_Compliance grants edit access.
    makeEdge({
      fromId: PERMSET_HIPAA,
      toId: SSN_FIELD,
      edgeType: 'grantedBy',
      properties: { read: true, edit: true },
    }),
    // PermissionSet:Audit_Readonly grants read access.
    makeEdge({
      fromId: PERMSET_AUDIT,
      toId: SSN_FIELD,
      edgeType: 'grantedBy',
      properties: { read: true, edit: false },
    }),
    // ApexClass:ContactService readsFrom the field (via-Apex access).
    makeEdge({
      fromId: APEX_READER,
      toId: SSN_FIELD,
      edgeType: 'readsFrom',
      confidence: 'parsed',
      source: 'apex-scanner',
    }),
    // ApexClass:DataSync writesTo the field (via-Apex access).
    makeEdge({
      fromId: APEX_WRITER,
      toId: SSN_FIELD,
      edgeType: 'writesTo',
      confidence: 'parsed',
      source: 'apex-scanner',
    }),
  ],
};

// =============================================================================
// Seed: a public-classified field with no grants and no Apex access.
// =============================================================================

const PUBLIC_FIELD = 'CustomField:Contact.Industry__c';
const publicSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PUBLIC_FIELD,
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: CONTACT_ID,
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed: a field whose `grantedBy` edge does NOT carry the read/edit flags,
// to exercise the `permission: 'unknown'` branch.
// =============================================================================

const UNKNOWN_FIELD = 'CustomField:Contact.Tag__c';
const PROFILE_LEGACY = 'Profile:LegacyProfile';
const unknownGrantSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: UNKNOWN_FIELD,
      apiName: 'Tag__c',
      label: 'Tag',
      parentId: CONTACT_ID,
    }),
    makeNode({
      id: PROFILE_LEGACY,
      type: 'Profile',
      apiName: 'LegacyProfile',
      label: 'Legacy Profile',
    }),
  ],
  edges: [
    makeEdge({
      fromId: PROFILE_LEGACY,
      toId: UNKNOWN_FIELD,
      edgeType: 'grantedBy',
      // No read/edit properties — older extractor output.
      properties: {},
    }),
  ],
};

// =============================================================================
// Seed: a field whose grantedBy edge carries `editable`/`readable` — the keys
// the REAL profile / permission-set extractor emits (mirroring Salesforce
// <editable>/<readable> fieldPermissions). The level MUST resolve to 'edit',
// NOT 'unknown'. Regression: the resolver read `edit`/`read`, which the real
// edges never carry, so every real grant was mis-reported as 'unknown' — and
// the other seeds use `read`/`edit`, masking it.
// =============================================================================

const REALKEYS_FIELD = 'CustomField:Contact.RealKeys__c';
const PROFILE_REAL = 'Profile:RealKeysProfile';
const realKeysSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: REALKEYS_FIELD,
      apiName: 'RealKeys__c',
      label: 'Real Keys',
      parentId: CONTACT_ID,
    }),
    makeNode({
      id: PROFILE_REAL,
      type: 'Profile',
      apiName: 'RealKeysProfile',
      label: 'Real Keys Profile',
    }),
  ],
  edges: [
    makeEdge({
      fromId: PROFILE_REAL,
      toId: REALKEYS_FIELD,
      edgeType: 'grantedBy',
      properties: { readable: true, editable: true },
    }),
  ],
};

// One shared graph store + Context across the suite.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

// =============================================================================
// Seed (update axis): a Widget object with an editable Status__c field and a
// derived Total__c formula field. Profile:Editor has FLS-edit on Status__c AND
// object-edit on Widget__c (→ canUpdate); Profile:FieldOnly has FLS-edit on
// Status__c but NO object-edit (→ excluded).
// =============================================================================

const WIDGET_OBJ = 'CustomObject:Widget__c';
const STATUS_FIELD = 'CustomField:Widget__c.Status__c';
const TOTAL_FIELD = 'CustomField:Widget__c.Total__c';
const EDITOR = 'Profile:Editor';
const FIELD_ONLY = 'Profile:FieldOnly';
const MAD_EDITOR = 'Profile:MadEditor';
const VAD_ONLY = 'Profile:VadOnly';

const updateSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: WIDGET_OBJ, type: 'CustomObject', apiName: 'Widget__c', properties: {} }),
    makeNode({ id: STATUS_FIELD, apiName: 'Status__c', parentId: WIDGET_OBJ, properties: { dataType: 'Text' } }),
    makeNode({
      id: TOTAL_FIELD,
      apiName: 'Total__c',
      parentId: WIDGET_OBJ,
      properties: { dataType: 'Number', formula: 'Amount__c + Tax__c' },
    }),
    makeNode({ id: EDITOR, type: 'Profile', apiName: 'Editor', properties: {} }),
    makeNode({ id: FIELD_ONLY, type: 'Profile', apiName: 'FieldOnly', properties: {} }),
    // MadEditor: FLS-edit + the ModifyAllData SYSTEM permission, but NO explicit
    // object grant — MAD implies object-edit everywhere (FLS still required).
    makeNode({ id: MAD_EDITOR, type: 'Profile', apiName: 'MadEditor', properties: { userPermissions: ['ModifyAllData'] } }),
    // VadOnly: FLS-edit + ViewAllData — read-only god-mode is NOT object-edit.
    makeNode({ id: VAD_ONLY, type: 'Profile', apiName: 'VadOnly', properties: { userPermissions: ['ViewAllData'] } }),
  ],
  edges: [
    // Editor: FLS-edit on the field AND object-edit on Widget__c → can update.
    makeEdge({ fromId: EDITOR, toId: STATUS_FIELD, edgeType: 'grantedBy', properties: { editable: true, readable: true } }),
    makeEdge({ fromId: EDITOR, toId: WIDGET_OBJ, edgeType: 'grantedBy', properties: { allowEdit: true, allowRead: true } }),
    // FieldOnly: FLS-edit on the field but NO object-edit → cannot update.
    makeEdge({ fromId: FIELD_ONLY, toId: STATUS_FIELD, edgeType: 'grantedBy', properties: { editable: true, readable: true } }),
    // Both have FLS-edit on the formula field, but it is never updatable.
    makeEdge({ fromId: EDITOR, toId: TOTAL_FIELD, edgeType: 'grantedBy', properties: { editable: true, readable: true } }),
    // MadEditor / VadOnly: FLS-edit on the field, no object grantedBy edge.
    makeEdge({ fromId: MAD_EDITOR, toId: STATUS_FIELD, edgeType: 'grantedBy', properties: { editable: true, readable: true } }),
    makeEdge({ fromId: VAD_ONLY, toId: STATUS_FIELD, edgeType: 'grantedBy', properties: { editable: true, readable: true } }),
  ],
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-access-audit-'));
  const dbPath = join(tempDir, 'field-access-audit.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    containerSeed,
    ssnSeed,
    publicSeed,
    unknownGrantSeed,
    realKeysSeed,
    updateSeed,
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

describe('fieldAccessAuditHandler', () => {
  it("returns every grant when permissionType='all' (default)", async () => {
    const result = await fieldAccessAuditHandler(ctx, { fieldId: SSN_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { grants } = result.value.data;
    // 4 grants seeded.
    expect(grants.length).toBe(4);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it("resolves the grant level from `editable`/`readable` (the real extractor keys), not 'unknown'", async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: REALKEYS_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The grantedBy edge carries editable:true (Salesforce <editable>), so the
    // grant MUST resolve to 'edit', not 'unknown'.
    expect(result.value.data.grants.some((g) => g.permission === 'edit')).toBe(
      true,
    );
    expect(result.value.data.summary.profilesWithEdit).toBe(1);
    expect(result.value.data.summary.profilesWithUnknown).toBe(0);
  });

  it("filters grants to edit-only when permissionType='edit'", async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: SSN_FIELD,
      permissionType: 'edit',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { grants } = result.value.data;
    // Only the System Administrator profile + HIPAA permset grant edit.
    expect(grants.length).toBe(2);
    for (const g of grants) {
      expect(g.permission).toBe('edit');
    }
  });

  it("filters grants to read-equivalent when permissionType='read' (edit implies read)", async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: SSN_FIELD,
      permissionType: 'read',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { grants } = result.value.data;
    // All 4 with read==true (admin/hipaa carry edit too which implies read,
    // std/audit carry read-only) match. Unknown-level grants are not on
    // this field; they're on UNKNOWN_FIELD seeded separately.
    expect(grants.length).toBe(4);
    for (const g of grants) {
      expect(g.permission === 'read' || g.permission === 'edit').toBe(true);
    }
  });

  it("reports the unfiltered summary counts (split by grantor type and permission)", async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: SSN_FIELD,
      permissionType: 'edit',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { summary } = result.value.data;
    // Summary is unfiltered — even though the response filtered to edit
    // grants, summary still reports both read AND edit counts.
    expect(summary.profilesWithRead).toBe(2);
    expect(summary.profilesWithEdit).toBe(1);
    expect(summary.permSetsWithRead).toBe(2);
    expect(summary.permSetsWithEdit).toBe(1);
  });

  it("classifies the field's PII context alongside the grants (SSN__c -> pii/identifier)", async () => {
    const result = await fieldAccessAuditHandler(ctx, { fieldId: SSN_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { piiClassification, piiCategory, fieldLabel } = result.value.data;
    expect(piiClassification).toBe('pii');
    expect(piiCategory).toBe('identifier');
    expect(fieldLabel).toBe('Social Security Number');
  });

  it("surfaces ApexClass references via viaApexAccess", async () => {
    const result = await fieldAccessAuditHandler(ctx, { fieldId: SSN_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { viaApexAccess } = result.value.data;
    expect(viaApexAccess.length).toBe(2);
    const ids = viaApexAccess.map((v) => v.apexClassId).sort();
    expect(ids).toEqual([APEX_READER, APEX_WRITER].sort());
  });

  it("returns an empty grants list and zeroed summary for a public field with no grants", async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: PUBLIC_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { grants, summary, viaApexAccess, piiClassification } =
      result.value.data;
    expect(grants).toEqual([]);
    expect(viaApexAccess).toEqual([]);
    expect(summary.profilesWithRead).toBe(0);
    expect(summary.profilesWithEdit).toBe(0);
    expect(summary.permSetsWithRead).toBe(0);
    expect(summary.permSetsWithEdit).toBe(0);
    expect(piiClassification).toBe('public');
  });

  it("reports permission='unknown' when the grantedBy edge has no read/edit flags", async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: UNKNOWN_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { grants, summary } = result.value.data;
    expect(grants.length).toBe(1);
    expect(grants[0]?.permission).toBe('unknown');
    // Unknown levels do NOT count in profilesWith{Read,Edit}.
    expect(summary.profilesWithRead).toBe(0);
    expect(summary.profilesWithEdit).toBe(0);
    // ...but the grant IS counted in profilesWithUnknown, so an all-zero
    // read/edit summary cannot be misread as "no access" — the field is in
    // fact granted to 1 profile (at an extractor-unpopulated level).
    expect(summary.profilesWithUnknown).toBe(1);
    expect(summary.permSetsWithUnknown).toBe(0);
  });

  it("orders grants by grantorType ASC (PermissionSet before Profile) then by id", async () => {
    // Alphabetic ASC sort matches the convention every other composition
    // tool uses. `'PermissionSet' < 'Profile'` so PermSet grants
    // appear first in the output, then Profile grants.
    const result = await fieldAccessAuditHandler(ctx, { fieldId: SSN_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const types = result.value.data.grants.map((g) => g.grantorType);
    const profileIdx = types.indexOf('Profile');
    const permsetIdx = types.indexOf('PermissionSet');
    expect(profileIdx).toBeGreaterThanOrEqual(0);
    expect(permsetIdx).toBeGreaterThanOrEqual(0);
    // PermissionSet first (alphabetic ASC), then Profile.
    expect(permsetIdx).toBeLessThan(profileIdx);
  });

  it("returns invalid-query when the fieldId does not start with CustomField:", async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: 'ApexClass:NotAField',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('CustomField:');
  });

  it("returns component-not-found when the field id is unknown", async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: 'CustomField:Contact.DoesNotExist__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('audits a referenced-but-not-modeled standard field instead of erroring (B12)', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-faa-stdfield-'));
    const opened = await openGraph(join(localDir, 'std.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    // Contact.Email is a STANDARD field: no node of its own, but a permission
    // set grants it (the grantedBy edge exists). The audit must work off the
    // edge rather than returning component-not-found.
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: 'PermissionSet:Sales',
            type: 'PermissionSet',
            apiName: 'Sales',
          }),
        ],
        edges: [
          makeEdge({
            fromId: 'PermissionSet:Sales',
            toId: 'CustomField:Contact.Email',
            edgeType: 'grantedBy',
            properties: { readable: true, editable: false, targetMissing: true },
          }),
        ],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await fieldAccessAuditHandler(localCtx, {
      fieldId: 'CustomField:Contact.Email',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.notModeled).toBe(true);
    expect(d.notModeledNote).toMatch(/not modeled|not retrieved/i);
    // The grant is read straight from the edge.
    expect(d.grants.length).toBe(1);
    expect(d.grants[0]?.grantorId).toBe('PermissionSet:Sales');
    expect(d.summary.permSetsWithRead).toBe(1);
    // PII is inferred from the field NAME (Email) even without the definition.
    expect(d.piiClassification).toBe('pii');
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  // --- update axis: who can UPDATE this field (P11-ACCESS-field-update) ---

  it('canUpdate = grantors with FLS-edit AND object-edit; excludes FLS-edit-only', async () => {
    const result = await fieldAccessAuditHandler(ctx, { fieldId: STATUS_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { update } = result.value.data;
    expect(update.fieldUpdatable).toBe(true);
    const ids = update.canUpdate.map((g) => g.grantorId);
    expect(ids).toContain('Profile:Editor'); // FLS-edit + object-edit
    expect(ids).not.toContain('Profile:FieldOnly'); // FLS-edit only → cannot update
    expect(update.recordEditDependency).toContain('record');
  });

  it('canUpdate counts ModifyAllData as object-edit (no explicit object grant); ViewAllData does not count', async () => {
    const result = await fieldAccessAuditHandler(ctx, { fieldId: STATUS_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.update.canUpdate.map((g) => g.grantorId);
    // MAD implies object-edit everywhere; FLS-edit was already held.
    expect(ids).toContain('Profile:MadEditor');
    // ViewAllData is read-only god-mode — never edit-capable.
    expect(ids).not.toContain('Profile:VadOnly');
  });

  it('a formula field is never updatable; canUpdate is empty even with FLS-edit', async () => {
    const result = await fieldAccessAuditHandler(ctx, { fieldId: TOTAL_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { update } = result.value.data;
    expect(update.fieldUpdatable).toBe(false);
    expect(update.fieldUpdatableNote).toContain('formula');
    expect(update.canUpdate).toEqual([]);
  });
});

describe('fieldAccessAuditInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = fieldAccessAuditInputSchema.safeParse({
      fieldId: 'CustomField:Contact.SSN__c',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a missing fieldId', () => {
    const parsed = fieldAccessAuditInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('accepts a valid permissionType', () => {
    const parsed = fieldAccessAuditInputSchema.safeParse({
      fieldId: 'CustomField:Contact.SSN__c',
      permissionType: 'edit',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown permissionType value', () => {
    const parsed = fieldAccessAuditInputSchema.safeParse({
      fieldId: 'CustomField:Contact.SSN__c',
      permissionType: 'delete',
    });
    expect(parsed.success).toBe(false);
  });
});

// GUARD (L2 alias OS / ADMIN-SURFACE-ALIAS-SKEW-CLUSTER): pre-fix the schema
// required `fieldId` and Zod-STRIPPED `componentId: CustomField:…` -> `fieldId:
// Required`. Post-fix the componentId alias resolves to the SAME result as the
// canonical fieldId; disagreeing values -> invalid-query.
describe('fieldAccessAuditHandler — componentId ↔ fieldId alias', () => {
  const run = async (raw: unknown) => {
    const parsed = fieldAccessAuditInputSchema.safeParse(raw);
    if (!parsed.success) return null;
    return fieldAccessAuditHandler(ctx, parsed.data);
  };

  it('natural componentId ≡ canonical fieldId (byte-equal grants + summary)', async () => {
    const byField = await run({ fieldId: SSN_FIELD });
    const byComponent = await run({ componentId: SSN_FIELD });
    expect(byField).not.toBeNull();
    expect(byComponent).not.toBeNull();
    if (!byField?.ok || !byComponent?.ok) return;
    expect(byComponent.value.data.fieldId).toBe(SSN_FIELD);
    expect(byComponent.value.data.grants).toEqual(byField.value.data.grants);
    expect(byComponent.value.data.summary).toEqual(byField.value.data.summary);
  });

  it('disagreeing fieldId / componentId → invalid-query', async () => {
    const parsed = fieldAccessAuditInputSchema.safeParse({
      fieldId: SSN_FIELD,
      componentId: 'CustomField:Contact.Email',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await fieldAccessAuditHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });
});

// BRIEF 086 / R1 — SENTINEL-KEY DISCOVERABILITY.
//
// This tool emits four keys whose ONLY job is to stop a zero being read as a
// verified negative: `summary.profilesWithUnknown` / `summary.permSetsWithUnknown`
// (an all-zero read/edit split is not "no access" when a grant's level is merely
// unpopulated) and `update.flsEditWithoutObjectRow` / `update.objectRowNote` (an
// empty `canUpdate` is not a proven denial when object-edit went unchecked).
//
// A sentinel nobody is told to look for does not do its job. Before this brief
// the ONLY place the tool described its own output was the roster description a
// host reads at tools/list time, and that description named FOUR of the six
// summary keys — omitting exactly the two sentinels — and neither update key;
// the response payload carried no honesty field of any kind. So the rule these
// tests enforce is: every key the handler emits on the summary, plus the two
// update honesty keys, must be NAMED on a surface the caller actually reads —
// the tools/list description, or the response's own `boundaryNote`, which is
// the stronger of the two because it arrives WITH the numbers it qualifies.
//
// The key list is read off the RUNTIME object the handler returns, never
// hand-copied, so the assertion tracks the code rather than a second list that
// can drift. Each test first asserts the fixture genuinely fires the sentinel it
// is about, so a fixture that stopped producing one fails loudly instead of
// asserting over nothing.
describe('sfi.field_access_audit — every emitted sentinel key is named on a surface the caller reads', () => {
  const tool = V01_TOOLS.find((t) => t.name === 'sfi.field_access_audit');
  const rosterDescription = String(tool?.description ?? '');

  /** The two honesty surfaces a caller can actually reach, concatenated. */
  const honestySurfaces = (boundaryNote: string): string =>
    `${rosterDescription}\n${boundaryNote}`;

  it('the tool is registered in the roster (an unregistered tool would pass every check below over an empty string)', () => {
    expect(tool).toBeDefined();
    expect(rosterDescription.length).toBeGreaterThan(200);
  });

  it('names every FieldAccessAuditSummary key the handler emits', async () => {
    // UNKNOWN_FIELD's grant carries no read/edit flags, so this exercises the
    // exact case the sentinel exists for: one REAL grant, all-zero read/edit.
    const result = await fieldAccessAuditHandler(ctx, { fieldId: UNKNOWN_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summaryKeys = Object.keys(result.value.data.summary);
    // Vacuity guard: the fixture must actually produce the sentinel keys.
    expect(summaryKeys).toContain('profilesWithUnknown');
    expect(summaryKeys).toContain('permSetsWithUnknown');
    expect(
      result.value.data.summary.profilesWithUnknown +
        result.value.data.summary.permSetsWithUnknown,
    ).toBeGreaterThan(0);

    const surfaces = honestySurfaces(result.value.data.boundaryNote);
    const unnamed = summaryKeys.filter((k) => !surfaces.includes(k));
    expect(
      unnamed,
      `the handler emits these summary key(s) that NEITHER the roster description NOR the ` +
        `response boundaryNote names, so a caller is never told to look for them: ${unnamed.join(', ')}`,
    ).toEqual([]);
  });

  it('names the update-block not-checked-vs-denied sentinel keys', async () => {
    // STATUS_FIELD's FIELD_ONLY profile holds FLS-edit with NO object grantedBy
    // edge at all — the exact case flsEditWithoutObjectRow exists to flag.
    const result = await fieldAccessAuditHandler(ctx, { fieldId: STATUS_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Vacuity guard: the fixture must actually fire this sentinel.
    expect(result.value.data.update.flsEditWithoutObjectRow).toBeGreaterThan(0);
    expect(result.value.data.update.objectRowNote).toBeDefined();

    const surfaces = honestySurfaces(result.value.data.boundaryNote);
    const unnamed = ['flsEditWithoutObjectRow', 'objectRowNote'].filter(
      (k) => !surfaces.includes(k),
    );
    expect(
      unnamed,
      `neither the roster description nor the response boundaryNote names these 'update' ` +
        `honesty key(s) — the not-checked-vs-proven-denial hedge on canUpdate: ${unnamed.join(', ')}`,
    ).toEqual([]);
  });

  it('states the three honesty axes the module header claims, in the payload', async () => {
    const result = await fieldAccessAuditHandler(ctx, { fieldId: UNKNOWN_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = result.value.data.boundaryNote;
    // Axis 1: sharing rules are not walked (grant level only).
    expect(note).toMatch(/sharing rules/i);
    expect(note).toContain('why_cant_user_see_record');
    // Axis 2: an unpopulated permission level is not an absence of access.
    expect(note).toMatch(/not a verified "no access"/i);
    // Axis 3: the Apex route is heuristic, flagging the file and not the user.
    expect(note).toMatch(/viaApexAccess/);
    expect(note).toMatch(/heuristic/i);
  });

  it('quantifies each sentinel that actually fired, so the caller gets the number and not only the key name', async () => {
    const unknownResult = await fieldAccessAuditHandler(ctx, { fieldId: UNKNOWN_FIELD });
    expect(unknownResult.ok).toBe(true);
    if (!unknownResult.ok) return;
    expect(unknownResult.value.data.boundaryNote).toContain('ON THIS FIELD');

    const updateResult = await fieldAccessAuditHandler(ctx, { fieldId: STATUS_FIELD });
    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;
    expect(updateResult.value.data.boundaryNote).toContain(
      `object edit was NOT CHECKED for ${updateResult.value.data.update.flsEditWithoutObjectRow}`,
    );
  });
});

// =============================================================================
// CASE-INSENSITIVE FIELD-ID RESOLUTION.
//
// Salesforce api names are case-insensitive: `Contact.SSN__c`, `CONTACT.SSN__C`
// and `contact.ssn__c` all name the SAME field in SOQL, in a formula and in a
// Setup URL. A ticket pasted in upper case, or a host that upper-cased an id,
// therefore names a field this vault DOES hold.
//
// The measured defect: the handler probed `getNodeById(exact id)` only, so an
// upper-cased id missed the node, carried NO inbound edges under that exact
// spelling either, and fell through to `component-not-found` — with a
// FABRICATED cause ("standard-object field ... Metadata API retrieve does not
// emit uncustomized standard fields"), because the phantom-node standard-field
// guard tests the `__c` suffix case-SENSITIVELY and an upper-cased custom field
// ends `__C`. The refusal's hedge was honest; the named cause was invented, and
// the field's real 40-plus grantors were reachable the whole time.
//
// Sibling object-scoped tools (`pii_inventory`, `who_can_access_object`, …)
// already fold case through `input-aliases` `objectIdCaseVariants`; this tool
// did not.
// =============================================================================

describe('fieldAccessAuditHandler — case-insensitive field-id resolution', () => {
  it('answers an UPPER-CASED field id with the real audit, not a not-found', async () => {
    const upper = 'CustomField:CONTACT.SSN__C';
    const result = await fieldAccessAuditHandler(ctx, { fieldId: upper });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // The vault's EXACT id is echoed — never the caller's spelling, which is an
    // id no vault holds.
    expect(d.fieldId).toBe(SSN_FIELD);
    expect(d.resolvedFrom).toBe(upper);
    // Same answer as the exactly-cased call: 4 grants, 2 Apex routes.
    expect(d.grants.length).toBe(4);
    expect(d.viaApexAccess.length).toBe(2);
    expect(d.notModeled).toBe(false);
  });

  it('answers a LOWER-CASED object segment the same way', async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: 'CustomField:contact.SSN__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fieldId).toBe(SSN_FIELD);
    expect(result.value.data.grants.length).toBe(4);
  });

  it('tells the caller in the boundaryNote that the id was case-corrected', async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: 'CustomField:Contact.ssn__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.boundaryNote).toMatch(/case/i);
    expect(result.value.data.boundaryNote).toContain(SSN_FIELD);
  });

  it('still refuses a genuinely unknown id, and says the case probe was RUN and found nothing', async () => {
    const result = await fieldAccessAuditHandler(ctx, {
      fieldId: 'CustomField:Contact.NOPE__C',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    // A checked zero, stated as one: the parent's whole field list was walked.
    expect(result.error.message).toMatch(/case/i);
  });

  it('REFUSES rather than silently picking when two vault fields differ only by case', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-faa-fieldcase-'));
    const opened = await openGraph(join(localDir, 'case.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const objId = 'CustomObject:Obj_A__c';
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({ id: objId, type: 'CustomObject', apiName: 'Obj_A__c', properties: {} }),
          makeNode({ id: `CustomField:Obj_A__c.Dup__c`, apiName: 'Dup__c', parentId: objId }),
          makeNode({ id: `CustomField:Obj_A__c.DUP__c`, apiName: 'DUP__c', parentId: objId }),
        ],
        edges: [],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await fieldAccessAuditHandler(localCtx, {
      fieldId: 'CustomField:Obj_A__c.dup__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/case/i);
    // BOTH candidates are named, so nothing is silently picked.
    expect(r.error.message).toContain('CustomField:Obj_A__c.Dup__c');
    expect(r.error.message).toContain('CustomField:Obj_A__c.DUP__c');
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it('does not claim a case probe it could not run when the parent object has no node', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-faa-noparent-'));
    const opened = await openGraph(join(localDir, 'noparent.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const imp = await importExtractionResults(localStore, [{ nodes: [], edges: [] }]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await fieldAccessAuditHandler(localCtx, {
      fieldId: 'CustomField:Obj_B__c.Field_C__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    // The probe could NOT run — say so, rather than implying a checked zero.
    expect(r.error.message).toMatch(/could not be walked|no CustomObject node/i);
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });
});
