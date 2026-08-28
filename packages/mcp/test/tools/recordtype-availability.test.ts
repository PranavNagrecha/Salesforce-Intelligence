/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  recordtypeAvailabilityHandler,
  recordtypeAvailabilityInputSchema,
} from '../../src/tools/recordtype-availability.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: { Profile: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const SALES = 'Profile:Sales';

const seed: ExtractionResult = {
  nodes: [
    node({
      id: SALES,
      type: 'Profile',
      apiName: 'Sales',
      label: 'Sales',
      properties: {
        recordTypeVisibilities: [
          { recordType: 'Account.Business', visible: true, default: true },
          { recordType: 'Account.Person', visible: true, default: false },
          { recordType: 'Case.Support', visible: false, default: false },
          // Older-format entry: <visible> omitted → treated as visible.
          { recordType: 'Lead.Inbound', default: false },
        ],
      },
    }),
    // A profile from a pre-extraction / stale vault: NO recordTypeVisibilities key.
    node({ id: 'Profile:Bare', type: 'Profile', apiName: 'Bare', label: 'Bare', properties: {} }),
    // A profile whose `recordTypeVisibilities` key IS present but serialized as
    // `null` rather than `[]` — R1: extracted (the key is carried), so this
    // must NOT read as "not modeled" the way an `Array.isArray` test would.
    node({
      id: 'Profile:NullRt',
      type: 'Profile',
      apiName: 'NullRt',
      label: 'NullRt',
      properties: { recordTypeVisibilities: null },
    }),
    // Real CustomObject nodes so the R4 object-existence check has something
    // to verify against. `Opportunity` exists but the Sales profile grants no
    // record types on it (the "exists, but empty for this profile" case).
    // Note: NO node for 'Casee' (typo) — that stays an absent-from-vault case.
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account', label: 'Account', properties: {} }),
    node({ id: 'CustomObject:Case', type: 'CustomObject', apiName: 'Case', label: 'Case', properties: {} }),
    node({ id: 'CustomObject:Lead', type: 'CustomObject', apiName: 'Lead', label: 'Lead', properties: {} }),
    node({ id: 'CustomObject:Opportunity', type: 'CustomObject', apiName: 'Opportunity', label: 'Opportunity', properties: {} }),
  ],
  edges: [],
};

let store: GraphStore;
let tempDir: string;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-rt-avail-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('recordtypeAvailabilityHandler', () => {
  it('groups record types by object with default + visibility', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: SALES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { objects, summary } = r.value.data;
    const account = objects.find((o) => o.object === 'Account')!;
    expect(account.recordTypes.map((t) => t.name)).toEqual(['Business', 'Person']);
    expect(account.defaultRecordType).toBe('Business');
    expect(account.recordTypes.every((t) => t.visible)).toBe(true);
    // Objects with no default → defaultRecordType null.
    const cas = objects.find((o) => o.object === 'Case')!;
    expect(cas.defaultRecordType).toBeNull();
    expect(cas.recordTypes[0]?.visible).toBe(false);
    expect(summary.objects).toBe(3); // Account, Case, Lead
    expect(summary.visibleRecordTypes).toBe(3); // Business, Person, Lead.Inbound (Case.Support not visible)
  });

  it('treats an omitted <visible> as visible (older metadata)', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: SALES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lead = r.value.data.objects.find((o) => o.object === 'Lead')!;
    expect(lead.recordTypes[0]?.visible).toBe(true);
  });

  it('rejects a non-Profile/PermissionSet id with invalid-query', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  // GUARD (W3.3 misbind fix / ADMIN-SURFACE-ALIAS-SKEW-CLUSTER): pre-fix a
  // `CustomObject:` componentId was coerced into a phantom
  // `Profile:CustomObject:Case` (component-NOT-found, not invalid-query), and
  // `objectApiName` / `object` / `objectId` were Zod-STRIPPED (componentId
  // Required). Post-fix an object-shaped input binds to the OBJECT and is
  // rejected HONESTLY as a CustomObject — never a phantom Profile.
  it('a CustomObject componentId is rejected as an object, not a phantom Profile', async () => {
    const parsed = recordtypeAvailabilityInputSchema.safeParse({ componentId: 'CustomObject:Case' });
    // The preprocess must NOT have prepended Profile:.
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.componentId).toBe('CustomObject:Case');
    const r = await recordtypeAvailabilityHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    // Names the CustomObject + the tool's real contract; never a Profile not-found.
    expect(r.error.message).toContain('CustomObject');
    expect(r.error.message).not.toContain('Profile:CustomObject');
  });

  it.each(['objectApiName', 'object', 'objectId'] as const)(
    'the %s object alias binds to the object (not stripped, not Profile) → invalid-query',
    async (key) => {
      const value = key === 'objectId' ? 'CustomObject:Case' : 'Case';
      const parsed = recordtypeAvailabilityInputSchema.safeParse({ [key]: value });
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.componentId).toBe('CustomObject:Case');
      const r = await recordtypeAvailabilityHandler(ctx, parsed.data);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('invalid-query');
    },
  );

  it('a real Profile still resolves (container path unaffected by the fix)', async () => {
    const parsed = recordtypeAvailabilityInputSchema.safeParse({ profileId: 'Sales' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.componentId).toBe('Profile:Sales');
    const r = await recordtypeAvailabilityHandler(ctx, parsed.data);
    expect(r.ok).toBe(true);
  });

  it('returns component-not-found for an unknown profile', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: 'Profile:Ghost' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('discloses "not modeled" when recordTypeVisibilities is absent, not a verified empty (P12-HONESTY-recordtype-not-modeled)', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: 'Profile:Bare' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objects).toEqual([]);
    expect(r.value.data.summary.visibleRecordTypes).toBe(0);
    expect(r.value.data.boundaryNote).toMatch(/not modeled/);
    expect(r.value.data.boundaryNote).toMatch(/sfi-refresh/);
  });

  it('does NOT cry "not modeled" when the property IS present (the extracted path)', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: SALES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaryNote).not.toMatch(/not modeled/);
    expect(r.value.data.boundaryNote).toMatch(/recordTypeVisibilities/);
  });

  // R1 (BRIEF 073, line 232): the family sentinel is whether the node CARRIES
  // the property, never `Array.isArray`. A present-but-`null` value (extracted,
  // just serialized as `null` instead of `[]`) must NOT read as "not modeled" —
  // `Array.isArray(null)` disagrees with the sentinel and would misreport it.
  it('a present-but-null recordTypeVisibilities is EXTRACTED, not "not modeled" (R1 sentinel, not Array.isArray)', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: 'Profile:NullRt' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objects).toEqual([]);
    // The property WAS carried (even though its value is null) — this is a
    // checked, declared zero, not an unmodeled family.
    expect(r.value.data.boundaryNote).not.toMatch(/not modeled/);
    expect(r.value.data.boundaryNote).toMatch(/Declared from/);
  });
});

// =============================================================================
// GUARD (RECORDTYPE-AVAILABILITY-REJECTS-PROFILEAPINAME, W3.5 residual): a
// natural "record types on Case for {profile}?" passes an OBJECT key alongside a
// PROFILE key. Pre-fix the object was consumed into the container slot and
// `profileApiName` was stripped entirely, so the call hard-failed as a
// CustomObject. Post-fix the profile is the SUBJECT, the object is a FILTER, and
// both are echoed in appliedScope; the profile is never stripped by the object.
// =============================================================================
describe('recordtypeAvailabilityHandler — profile subject + object filter (guard)', () => {
  it('objectApiName + profileApiName resolves the PROFILE and narrows to the object', async () => {
    // The dispatch layer parses natural args through the schema, then hands the
    // resolved shape to the handler — mirror that here.
    const parsed = recordtypeAvailabilityInputSchema.safeParse({
      objectApiName: 'Case',
      profileApiName: 'Sales',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The profile is the SUBJECT (never stripped by the object); the object is a
    // filter — pre-fix this resolved to CustomObject:Case and hard-failed.
    expect(parsed.data.componentId).toBe('Profile:Sales');
    expect(parsed.data.object).toBe('Case');
    const res = await recordtypeAvailabilityHandler(ctx, parsed.data);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.appliedScope).toEqual({
      componentId: 'Profile:Sales',
      object: 'Case',
    });
    // Narrowed to Case only (Case.Support, which is not visible).
    expect(res.value.data.objects.map((o) => o.object)).toEqual(['Case']);
    expect(res.value.data.summary.objects).toBe(1);
    expect(res.value.data.summary.visibleRecordTypes).toBe(0);
  });

  it('profileApiName alone (no object) resolves the profile across every object', async () => {
    const parsed = recordtypeAvailabilityInputSchema.safeParse({
      profileApiName: 'Sales',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.componentId).toBe('Profile:Sales');
    const res = await recordtypeAvailabilityHandler(ctx, parsed.data);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.objects.map((o) => o.object)).toEqual([
      'Account',
      'Case',
      'Lead',
    ]);
    expect(res.value.data.appliedScope).toEqual({
      componentId: 'Profile:Sales',
      object: null,
    });
  });

  it('natural profileApiName+object ≡ canonical componentId+object (byte-equal data)', async () => {
    const natural = recordtypeAvailabilityInputSchema.safeParse({
      objectApiName: 'Account',
      profileApiName: 'Sales',
    });
    const canonical = recordtypeAvailabilityInputSchema.safeParse({
      componentId: 'Profile:Sales',
      objectApiName: 'Account',
    });
    expect(natural.success && canonical.success).toBe(true);
    if (!natural.success || !canonical.success) return;
    const a = await recordtypeAvailabilityHandler(ctx, natural.data);
    const b = await recordtypeAvailabilityHandler(ctx, canonical.data);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.value.data)).toBe(JSON.stringify(b.value.data));
    expect(a.value.data.appliedScope).toEqual({
      componentId: 'Profile:Sales',
      object: 'Account',
    });
    // Narrowed to just Account (differs from the unscoped 3-object result).
    expect(a.value.data.objects.map((o) => o.object)).toEqual(['Account']);
  });

  it('an object the profile has no record types for is an honest empty (still declared, not the whole map)', async () => {
    const parsed = recordtypeAvailabilityInputSchema.safeParse({
      profileApiName: 'Sales',
      objectApiName: 'Opportunity',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const res = await recordtypeAvailabilityHandler(ctx, parsed.data);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.objects).toEqual([]);
    expect(res.value.data.summary.objects).toBe(0);
    expect(res.value.data.appliedScope.object).toBe('Opportunity');
    // The property WAS extracted — so it is not the "not modeled" disclosure.
    expect(res.value.data.boundaryNote).not.toMatch(/not modeled/);
  });
});

// =============================================================================
// R4 (BRIEF 073, line 270): the object filter must be VERIFIED against the
// vault before it narrows the result. A typo'd / never-retrieved / wrong-case
// object name must be REFUSED (`invalid-query`), never answered with a
// declared-looking empty.
// =============================================================================
describe('recordtypeAvailabilityHandler — object filter is verified against the vault (R4)', () => {
  it('a typo object name (no CustomObject node in the vault) is refused, not a declared empty', async () => {
    const parsed = recordtypeAvailabilityInputSchema.safeParse({
      profileApiName: 'Sales',
      objectApiName: 'Casee',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const res = await recordtypeAvailabilityHandler(ctx, parsed.data);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid-query');
    // Must NOT silently answer "0 record types" for a nonexistent object.
    expect(res.error.message).toContain('Casee');
  });

  it('a wrong-case object name resolves via the vault case-variant probe (not a silent empty)', async () => {
    // The vault holds `CustomObject:Case`; the caller passes lower-case
    // 'case'. Pre-fix, string-templating `CustomObject:case` was never
    // checked against the vault at all — the filter matched the profile's own
    // (correctly-cased) recordTypeVisibilities entries by pure string
    // lower-casing, so this happened to still "work" by accident. The point
    // of R4 is that it now goes through the SAME verified path as a typo, and
    // resolves to the vault's exact casing.
    const parsed = recordtypeAvailabilityInputSchema.safeParse({
      profileApiName: 'Sales',
      objectApiName: 'case',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const res = await recordtypeAvailabilityHandler(ctx, parsed.data);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.appliedScope.object).toBe('Case');
    expect(res.value.data.objects.map((o) => o.object)).toEqual(['Case']);
  });

  it('an unscoped call (no object) is unaffected — still byte-shaped as before', async () => {
    const res = await recordtypeAvailabilityHandler(ctx, { componentId: SALES });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.data.appliedScope.object).toBeNull();
    expect(res.value.data.objects.map((o) => o.object)).toEqual(['Account', 'Case', 'Lead']);
  });
});
