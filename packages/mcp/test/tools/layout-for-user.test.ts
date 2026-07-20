/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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
  layoutForUserHandler,
  layoutForUserInputSchema,
} from '../../src/tools/layout-for-user.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    Profile: 3,
    Layout: 4,
    RecordType: 2,
  },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName/properties. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'Profile',
  apiName: 'Standard User',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed 1: Admin profile carrying a fully-populated layoutAssignments array.
// Covers explicit recordType match (Account + Account.B2B) and the profile's
// default for Account (no recordType -> Account Standard Layout).
// =============================================================================

const ADMIN_PROFILE = 'Profile:System Administrator';
// Callers pass the canonical id form `RecordType:{Object}.{Name}`, but
// profile <layoutAssignments> store the record type BARE (no
// `RecordType:` prefix) — see packages/extractors/src/profile.ts. Keep
// both constants so the seed carries the real bare shape while queries
// use the documented canonical form; findLayoutAssignment normalizes the
// canonical input down to the bare stored value.
const ACCOUNT_B2B_RECORD_TYPE = 'RecordType:Account.B2B';
const ACCOUNT_B2B_BARE = 'Account.B2B';

const adminProfileSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ADMIN_PROFILE,
      apiName: 'System Administrator',
      properties: {
        layoutAssignments: [
          // Default for Account (no recordType).
          { layout: 'Account-Account Standard Layout', recordType: null },
          // Account, B2B record type.
          {
            layout: 'Account-Account B2B Layout',
            // Stored bare, exactly as profile.ts emits it.
            recordType: ACCOUNT_B2B_BARE,
          },
          // Default for Opportunity (no recordType).
          {
            layout: 'Opportunity-Opportunity Standard Layout',
            recordType: null,
          },
        ],
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 2: a profile whose layoutAssignments array contains ONLY explicit
// record-type entries — no default-for-object entry. Used to exercise the
// "caller omitted recordTypeId but no default exists" unknown branch.
// =============================================================================

const EXPLICIT_ONLY_PROFILE = 'Profile:Explicit Only';

const explicitOnlyProfileSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: EXPLICIT_ONLY_PROFILE,
      apiName: 'Explicit Only',
      properties: {
        layoutAssignments: [
          {
            layout: 'Case-Case Partner Layout',
            // Stored bare, exactly as profile.ts emits it.
            recordType: 'Case.Partner',
          },
        ],
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 3: a profile whose `properties` lacks `layoutAssignments` entirely —
// the v0.1 extractor's status quo. Used to exercise the honesty axis.
// =============================================================================

const NO_ASSIGNMENTS_PROFILE = 'Profile:No Assignments';

const noAssignmentsProfileSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NO_ASSIGNMENTS_PROFILE,
      apiName: 'No Assignments',
      properties: { description: 'no layoutAssignments here' },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 4: a profile with ONLY explicit per-record-type layoutAssignments (no
// `recordType: null` master entry) PLUS a recordTypeVisibilities default. When
// the caller omits a record type, the cascade must route via the profile's
// DEFAULT record type's layout (P2-BL-06-full depth), not return unknown.
// =============================================================================

const DEFAULT_RT_PROFILE = 'Profile:Default RT';

const defaultRtProfileSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: DEFAULT_RT_PROFILE,
      apiName: 'Default RT',
      properties: {
        layoutAssignments: [
          { layout: 'Case-Case Partner Layout', recordType: 'Case.Partner' },
          { layout: 'Case-Case Support Layout', recordType: 'Case.Support' },
        ],
        recordTypeVisibilities: [
          { recordType: 'Case.Partner', default: false, visible: true },
          { recordType: 'Case.Support', default: true, visible: true },
        ],
      },
    }),
  ],
  edges: [],
};

const flexiPageSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'FlexiPage:Account_Record_Page',
      type: 'FlexiPage',
      apiName: 'Account_Record_Page',
    }),
    // LAYOUT-FOR-USER-MISSES-CUSTOM-OBJECT-FLEXIPAGES: a CUSTOM-object record
    // page whose apiName has no `__c` in it (so the old `{Object}_` prefix
    // heuristic — `Evaluation__c_` — never matches). Carries `sobjectType`, the
    // signal `lightning_pages` matches on.
    makeNode({
      id: 'FlexiPage:Evaluation_Record_Page',
      type: 'FlexiPage',
      apiName: 'Evaluation_Record_Page',
      properties: { sobjectType: 'Evaluation__c', pageType: 'RecordPage' },
    }),
  ],
  edges: [],
};

// One shared graph store + Context across the suite.
// ids so there is no cross-test interference.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-layout-for-user-'));
  const dbPath = join(tempDir, 'layout-for-user.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    adminProfileSeed,
    explicitOnlyProfileSeed,
    noAssignmentsProfileSeed,
    defaultRtProfileSeed,
    flexiPageSeed,
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

describe('layoutForUserHandler', () => {
  it('routes via the profile default record type when no recordType is given and there is no master assignment (P2-BL-06-full)', async () => {
    const result = await layoutForUserHandler(ctx, {
      objectApiName: 'Case',
      profileId: DEFAULT_RT_PROFILE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // The default record type is Case.Support -> Case Support Layout.
    expect(d.layoutId).toBe('Layout:Case.Case Support Layout');
    expect(d.recordTypeUsed).toBe('Case.Support');
    const assign = d.reasoning.find((s) => s.stage === 'LayoutAssignment');
    expect(assign?.verdict).toBe('fallback');
    expect(assign?.reason).toContain('default record type');
  });

  it('returns not-found and null layoutId when the profile id is unknown', async () => {
    const result = await layoutForUserHandler(ctx, {
      objectApiName: 'Account',
      profileId: 'Profile:DoesNotExist',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { layoutId, recordTypeUsed, reasoning } = result.value.data;
    expect(layoutId).toBeNull();
    expect(recordTypeUsed).toBeNull();
    expect(reasoning.length).toBe(1);
    expect(reasoning[0]?.stage).toBe('ProfileLookup');
    expect(reasoning[0]?.verdict).toBe('not-found');
    expect(reasoning[0]?.reason).toContain('Profile:DoesNotExist');
    // vaultState carries the manifest hash and timestamp.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('returns matched for an explicit recordType layoutAssignment hit', async () => {
    const result = await layoutForUserHandler(ctx, {
      objectApiName: 'Account',
      recordTypeId: ACCOUNT_B2B_RECORD_TYPE,
      profileId: ADMIN_PROFILE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { layoutId, recordTypeUsed, reasoning } = result.value.data;
    expect(layoutId).toBe('Layout:Account.Account B2B Layout');
    // findLayoutAssignment normalizes the canonical input down to the
    // bare stored form, so recordTypeUsed is the bare `Account.B2B`.
    expect(recordTypeUsed).toBe(ACCOUNT_B2B_BARE);
    // ProfileLookup matched, LayoutAssignment matched,
    // RecordTypeResolution matched.
    const profileLookup = reasoning.find((s) => s.stage === 'ProfileLookup');
    expect(profileLookup?.verdict).toBe('matched');
    const layoutAssign = reasoning.find((s) => s.stage === 'LayoutAssignment');
    expect(layoutAssign?.verdict).toBe('matched');
    expect(layoutAssign?.reason).toContain('Account');
    expect(layoutAssign?.reason).toContain(ACCOUNT_B2B_BARE);
    const rtRes = reasoning.find((s) => s.stage === 'RecordTypeResolution');
    expect(rtRes?.verdict).toBe('matched');
    expect(rtRes?.value).toBe(ACCOUNT_B2B_BARE);
  });

  it('resolves BOTH the canonical RecordType: id and the bare form to the same layout (input-contract normalization)', async () => {
    // Real callers pass the documented canonical id
    // `RecordType:Account.B2B`; profile layoutAssignments store the
    // record type bare as `Account.B2B`. Both inputs must resolve to the
    // SAME layout. The prior bug compared the canonical input verbatim
    // against the bare stored value (`a.recordType === recordTypeId`), so
    // the documented form never matched and every record-type-specific
    // routing query wrongly returned `unknown` / null layout.
    for (const rt of [ACCOUNT_B2B_RECORD_TYPE, ACCOUNT_B2B_BARE]) {
      const result = await layoutForUserHandler(ctx, {
        objectApiName: 'Account',
        recordTypeId: rt,
        profileId: ADMIN_PROFILE,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { layoutId, recordTypeUsed, reasoning } = result.value.data;
      expect(layoutId).toBe('Layout:Account.Account B2B Layout');
      expect(recordTypeUsed).toBe(ACCOUNT_B2B_BARE);
      const layoutAssign = reasoning.find(
        (s) => s.stage === 'LayoutAssignment',
      );
      expect(layoutAssign?.verdict).toBe('matched');
    }
  });

  it('returns fallback (and a null recordTypeUsed) when no recordTypeId is supplied but a default assignment exists', async () => {
    const result = await layoutForUserHandler(ctx, {
      objectApiName: 'Account',
      profileId: ADMIN_PROFILE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { layoutId, recordTypeUsed, reasoning } = result.value.data;
    expect(layoutId).toBe('Layout:Account.Account Standard Layout');
    expect(recordTypeUsed).toBeNull();
    const layoutAssign = reasoning.find((s) => s.stage === 'LayoutAssignment');
    expect(layoutAssign?.verdict).toBe('fallback');
    expect(layoutAssign?.reason).toContain('default');
    expect(layoutAssign?.reason).toContain('Account');
    const rtRes = reasoning.find((s) => s.stage === 'RecordTypeResolution');
    expect(rtRes?.verdict).toBe('fallback');
    // value is omitted when the default record type is used.
    expect(rtRes?.value).toBeUndefined();
  });

  it('returns unknown when the recordTypeId is supplied but no layoutAssignment matches that combo', async () => {
    const result = await layoutForUserHandler(ctx, {
      objectApiName: 'Account',
      recordTypeId: 'RecordType:Account.UnknownRecordType',
      profileId: ADMIN_PROFILE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { layoutId, recordTypeUsed, reasoning } = result.value.data;
    expect(layoutId).toBeNull();
    expect(recordTypeUsed).toBeNull();
    const layoutAssign = reasoning.find((s) => s.stage === 'LayoutAssignment');
    expect(layoutAssign?.verdict).toBe('unknown');
    expect(layoutAssign?.reason).toContain('Account');
    expect(layoutAssign?.reason).toContain('UnknownRecordType');
    // RecordTypeResolution is not appended when the LayoutAssignment
    // stage already returned without a match.
    expect(
      reasoning.find((s) => s.stage === 'RecordTypeResolution'),
    ).toBeUndefined();
  });

  it('returns unknown when no default assignment exists for the requested object', async () => {
    // Explicit-only profile has Case+Partner but no default for Case;
    // omitting recordTypeId should surface the "no default" unknown.
    const result = await layoutForUserHandler(ctx, {
      objectApiName: 'Case',
      profileId: EXPLICIT_ONLY_PROFILE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { layoutId, recordTypeUsed, reasoning } = result.value.data;
    expect(layoutId).toBeNull();
    expect(recordTypeUsed).toBeNull();
    const layoutAssign = reasoning.find((s) => s.stage === 'LayoutAssignment');
    expect(layoutAssign?.verdict).toBe('unknown');
    expect(layoutAssign?.reason).toContain('default');
    expect(layoutAssign?.reason).toContain('Case');
  });

  it('honesty axis: returns unknown when properties.layoutAssignments is missing', async () => {
    const result = await layoutForUserHandler(ctx, {
      objectApiName: 'Account',
      profileId: NO_ASSIGNMENTS_PROFILE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { layoutId, recordTypeUsed, reasoning } = result.value.data;
    expect(layoutId).toBeNull();
    expect(recordTypeUsed).toBeNull();
    // ProfileLookup matched (the node exists), but the
    // LayoutAssignment stage short-circuits to unknown when the
    // extractor has not populated the property.
    const profileLookup = reasoning.find((s) => s.stage === 'ProfileLookup');
    expect(profileLookup?.verdict).toBe('matched');
    const layoutAssign = reasoning.find((s) => s.stage === 'LayoutAssignment');
    expect(layoutAssign?.verdict).toBe('unknown');
    expect(layoutAssign?.reason).toContain('not present');
    // No downstream steps appended when the property is missing.
    expect(
      reasoning.find((s) => s.stage === 'RecordTypeResolution'),
    ).toBeUndefined();
  });

  it('returns Lightning FlexiPage when the vault models a record page for the object', async () => {
    const result = await layoutForUserHandler(ctx, {
      objectApiName: 'Account',
      profileId: ADMIN_PROFILE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.uiSurface).toBe('lightning-flexipage');
    expect(result.value.data.flexiPageId).toBe('FlexiPage:Account_Record_Page');
    expect(result.value.data.boundaryNote).toContain('FlexiPage');
    expect(
      result.value.data.reasoning.some((s) => s.stage === 'LightningPageLookup'),
    ).toBe(true);
  });

  // LAYOUT-FOR-USER-MISSES-CUSTOM-OBJECT-FLEXIPAGES: a custom object's record
  // page must resolve via its `sobjectType` — the apiName-prefix heuristic
  // (`Evaluation__c_`) never matched `Evaluation_Record_Page`, so the tool
  // reported classic-only while `lightning_pages` listed the page. FAILS
  // pre-fix (flexiPageId null / uiSurface unknown).
  it('resolves a CUSTOM-object FlexiPage by sobjectType (not apiName prefix)', async () => {
    const result = await layoutForUserHandler(ctx, {
      objectApiName: 'Evaluation__c',
      profileId: ADMIN_PROFILE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.flexiPageId).toBe('FlexiPage:Evaluation_Record_Page');
    expect(result.value.data.uiSurface).toBe('lightning-flexipage');
    const pageStep = result.value.data.reasoning.find(
      (s) => s.stage === 'LightningPageLookup',
    );
    expect(pageStep?.verdict).toBe('matched');
  });

  // GUARD (LAYOUT-FOR-USER-REJECTS-PROFILEAPINAME): pre-fix a natural
  // `profileApiName` hard-failed `profileId: Required`. Post-fix a bare profile
  // name resolves to the `Profile:` id — BYTE-IDENTICAL to the profileId path —
  // and `appliedScope` echoes the resolved profile + object.
  it('profileApiName ≡ profileId (byte-equal + appliedScope echo)', async () => {
    const viaProfileId = await layoutForUserHandler(ctx, {
      objectApiName: 'Account',
      recordTypeId: ACCOUNT_B2B_RECORD_TYPE,
      profileId: ADMIN_PROFILE,
    });
    const viaProfileApiName = await layoutForUserHandler(ctx, {
      objectApiName: 'Account',
      recordTypeId: ACCOUNT_B2B_RECORD_TYPE,
      profileApiName: 'System Administrator',
    });
    expect(viaProfileId.ok && viaProfileApiName.ok).toBe(true);
    if (!viaProfileId.ok || !viaProfileApiName.ok) return;
    expect(viaProfileId.value.data.appliedScope).toEqual({
      profileId: ADMIN_PROFILE,
      objectApiName: 'Account',
      recordTypeId: ACCOUNT_B2B_RECORD_TYPE,
    });
    expect(viaProfileApiName.value.data).toEqual(viaProfileId.value.data);
  });

  it('refuses when no profile selector is supplied', async () => {
    const parsed = layoutForUserInputSchema.safeParse({ objectApiName: 'Account' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await layoutForUserHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('disagreeing profile selectors → invalid-query (never a silent pick)', async () => {
    const r = await layoutForUserHandler(ctx, {
      objectApiName: 'Account',
      profileId: ADMIN_PROFILE,
      profileApiName: 'Standard User',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});

describe('layoutForUserInputSchema', () => {
  it('accepts a minimal input with objectApiName and profileId only', () => {
    const parsed = layoutForUserInputSchema.safeParse({
      objectApiName: 'Account',
      profileId: 'Profile:Standard User',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an input with all three fields set', () => {
    const parsed = layoutForUserInputSchema.safeParse({
      objectApiName: 'Account',
      recordTypeId: 'RecordType:Account.B2B',
      profileId: 'Profile:Standard User',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty objectApiName', () => {
    const parsed = layoutForUserInputSchema.safeParse({
      objectApiName: '',
      profileId: 'Profile:Standard User',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty profileId', () => {
    const parsed = layoutForUserInputSchema.safeParse({
      objectApiName: 'Account',
      profileId: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty recordTypeId when supplied', () => {
    const parsed = layoutForUserInputSchema.safeParse({
      objectApiName: 'Account',
      recordTypeId: '',
      profileId: 'Profile:Standard User',
    });
    expect(parsed.success).toBe(false);
  });

  // LAYOUT-FOR-USER-REJECTS-PROFILEAPINAME: profileId is now OPTIONAL at the Zod
  // level (a profile alias may supply it); the handler enforces "at least one
  // profile selector" and rejects a truly profile-less call with invalid-query.
  it('accepts a missing profileId at the schema level (handler enforces presence)', () => {
    const parsed = layoutForUserInputSchema.safeParse({
      objectApiName: 'Account',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts profileApiName / profileName as the profile selector', () => {
    expect(
      layoutForUserInputSchema.safeParse({
        objectApiName: 'Account',
        profileApiName: 'Standard User',
      }).success,
    ).toBe(true);
    expect(
      layoutForUserInputSchema.safeParse({
        objectApiName: 'Account',
        profileName: 'Standard User',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing objectApiName', () => {
    const parsed = layoutForUserInputSchema.safeParse({
      profileId: 'Profile:Standard User',
    });
    expect(parsed.success).toBe(false);
  });
});
