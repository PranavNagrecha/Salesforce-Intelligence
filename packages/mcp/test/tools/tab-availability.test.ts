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
  tabAvailabilityHandler,
  tabAvailabilityInputSchema,
} from '../../src/tools/tab-availability.js';

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

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin', properties: {
      tabVisibilities: [
        { tab: 'Account', visibility: 'DefaultOn' },
        { tab: 'Deals__c', visibility: 'DefaultOff' },
        { tab: 'Secret__c', visibility: 'Hidden' },
      ],
    } }),
    // A profile with no tabVisibilities extracted → disclose "not modeled".
    node({ id: 'Profile:Bare', type: 'Profile', apiName: 'Bare' }),
    // A profile whose tabs use the `standard-<Object>` convention (standard
    // objects) alongside a custom-object tab named after the object.
    node({ id: 'Profile:Std', type: 'Profile', apiName: 'Std', properties: {
      tabVisibilities: [
        { tab: 'standard-Case', visibility: 'DefaultOn' },
        { tab: 'Widgets__c', visibility: 'DefaultOff' },
      ],
    } }),
  ],
  edges: [],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-tab-avail-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('tabAvailabilityHandler', () => {
  it('rejects a non-Profile/PermissionSet id', async () => {
    const r = await tabAvailabilityHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('invalid-query');
  });
  it('lists tabs with visibility + available flag, tallied', async () => {
    const r = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.total).toBe(3);
    expect(d.summary.available).toBe(2); // DefaultOn + DefaultOff
    expect(d.summary.hidden).toBe(1); // Hidden
    const hidden = d.tabs.find((t) => t.tab === 'Secret__c');
    expect(hidden?.available).toBe(false);
    const on = d.tabs.find((t) => t.tab === 'Account');
    expect(on?.available).toBe(true);
  });
  it('discloses "not modeled" when tabVisibilities was not extracted', async () => {
    const r = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Bare' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.summary.total).toBe(0);
    expect(r.value.data.boundaryNote).toContain('not modeled');
  });
});

// TAB-AVAILABILITY-PREFIXES-NON-PROFILE-AS-PROFILE: the bug lives in the Zod
// preprocess (which the handler-direct tests above bypass), so these drive the
// schema. Pre-fix, a `CustomTab:` id was coerced to `Profile:CustomTab:…` and
// 404-ed as a phantom Profile; the guard requires it to pass through untouched
// so the handler rejects it with `invalid-query` (mirroring app_access).
describe('tabAvailabilityInputSchema — non-Profile canonical id is NOT Profile-prefixed', () => {
  it('leaves a CustomTab: id untouched (does not mint Profile:CustomTab:…)', () => {
    const parsed = tabAvailabilityInputSchema.parse({
      componentId: 'CustomTab:standard-Case',
    });
    expect(parsed.componentId).toBe('CustomTab:standard-Case');
    expect(parsed.componentId).not.toBe('Profile:CustomTab:standard-Case');
  });

  it('a CustomTab: id parsed through the schema then reaches invalid-query, not component-not-found', async () => {
    const parsed = tabAvailabilityInputSchema.parse({
      componentId: 'CustomTab:standard-Case',
    });
    const r = await tabAvailabilityHandler(ctx, parsed);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('still coerces a BARE granter name to a canonical Profile id (regression)', () => {
    expect(tabAvailabilityInputSchema.parse({ componentId: 'Admin' }).componentId).toBe(
      'Profile:Admin',
    );
    // An explicit permissionSetId alias still routes to PermissionSet.
    expect(
      tabAvailabilityInputSchema.parse({ permissionSetId: 'Sales_Ops' }).componentId,
    ).toBe('PermissionSet:Sales_Ops');
    // Already-canonical granter ids are unchanged.
    expect(
      tabAvailabilityInputSchema.parse({ componentId: 'Profile:Admin' }).componentId,
    ).toBe('Profile:Admin');
    expect(
      tabAvailabilityInputSchema.parse({ componentId: 'PermissionSet:Sales_Ops' })
        .componentId,
    ).toBe('PermissionSet:Sales_Ops');
  });
});

// =============================================================================
// GUARD (TAB-AVAILABILITY-REJECTS-PROFILEAPINAME): a natural "is {object}'s tab
// available to {profile}?" passes `profileApiName` (+ `objectApiName`). Pre-fix
// profileApiName was rejected (componentId required) and objectApiName was
// ignored (full-profile tab dump). Post-fix the profile resolves via the alias,
// the object narrows the tab list by naming convention, and `appliedScope` is
// echoed; a bare call stays byte-identical.
// =============================================================================
describe('tabAvailabilityInputSchema — profileApiName / permissionSetApiName aliases', () => {
  it('coerces profileApiName / permissionSetApiName to the container prefix', () => {
    expect(tabAvailabilityInputSchema.parse({ profileApiName: 'Admin' }).componentId).toBe(
      'Profile:Admin',
    );
    expect(
      tabAvailabilityInputSchema.parse({ permissionSetApiName: 'Sales_Ops' }).componentId,
    ).toBe('PermissionSet:Sales_Ops');
    // Canonical componentId still wins when both are present.
    expect(
      tabAvailabilityInputSchema.parse({ componentId: 'Profile:Admin', profileApiName: 'Other' })
        .componentId,
    ).toBe('Profile:Admin');
  });
});

describe('tabAvailabilityHandler — object scope (guard)', () => {
  it('objectApiName narrows to the object tab (custom object, tab == object api name) + appliedScope', async () => {
    const r = await tabAvailabilityHandler(
      ctx,
      tabAvailabilityInputSchema.parse({ profileApiName: 'Admin', objectApiName: 'Deals__c' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({ componentId: 'Profile:Admin', object: 'Deals__c' });
    expect(r.value.data.tabs.map((t) => t.tab)).toEqual(['Deals__c']);
    expect(r.value.data.summary.total).toBe(1); // NOT the full 3-tab dump
  });

  it('objectApiName matches the `standard-<Object>` tab for a standard object', async () => {
    const r = await tabAvailabilityHandler(
      ctx,
      tabAvailabilityInputSchema.parse({ componentId: 'Profile:Std', objectApiName: 'Case' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.tabs.map((t) => t.tab)).toEqual(['standard-Case']);
    expect(r.value.data.appliedScope?.object).toBe('Case');
  });

  it('an object with no matching tab is an honest empty for that profile, not the full dump', async () => {
    const r = await tabAvailabilityHandler(
      ctx,
      tabAvailabilityInputSchema.parse({ componentId: 'Profile:Admin', objectApiName: 'Nonexistent__c' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.tabs).toEqual([]);
    expect(r.value.data.summary.total).toBe(0);
    expect(r.value.data.appliedScope?.object).toBe('Nonexistent__c');
  });

  it('natural profileApiName+object ≡ canonical componentId+object (byte-equal data)', async () => {
    const natural = await tabAvailabilityHandler(
      ctx,
      tabAvailabilityInputSchema.parse({ profileApiName: 'Admin', objectApiName: 'Account' }),
    );
    const canonical = await tabAvailabilityHandler(
      ctx,
      tabAvailabilityInputSchema.parse({ componentId: 'Profile:Admin', objectApiName: 'Account' }),
    );
    expect(natural.ok && canonical.ok).toBe(true);
    if (!natural.ok || !canonical.ok) return;
    expect(JSON.stringify(natural.value.data)).toBe(JSON.stringify(canonical.value.data));
    expect(natural.value.data.tabs.map((t) => t.tab)).toEqual(['Account']);
  });

  it('a bare (no-object) call is byte-identical to before — no appliedScope key', async () => {
    const r = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('appliedScope' in r.value.data).toBe(false);
    expect(r.value.data.summary.total).toBe(3);
  });
});

describe('tabAvailabilityHandler — CR-22 continuation cursor', () => {
  it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    const r = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    // truncated stays false on the first whole-fits page.
    expect(d.truncated).toBe(false);
    expect(d.hasMore).toBe(false);
  });

  it('a truncated (over-limit) page emits a nextCursor that resumes with no gaps/dupes', async () => {
    const first = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin', limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const d1 = first.value.data;
    expect(d1.tabs.length).toBe(2);
    expect(d1.hasMore).toBe(true);
    expect(typeof d1.nextCursor).toBe('string');
    expect(d1.pageInfo?.nextCursor).toBe(d1.nextCursor);

    const second = await tabAvailabilityHandler(ctx, {
      componentId: 'Profile:Admin',
      limit: 2,
      cursor: d1.nextCursor as string,
    });
    expect(second.ok).toBe(true); if (!second.ok) return;
    const d2 = second.value.data;
    expect(d2.tabs.length).toBe(1);
    expect(d2.hasMore).toBe(false);
    expect('nextCursor' in d2).toBe(false);

    const ids = (ts: typeof d1.tabs) => ts.map((t) => `${t.tab}|${t.visibility}`);
    const combined = [...ids(d1.tabs), ...ids(d2.tabs)];
    expect(new Set(combined).size).toBe(3); // no dupes
    const full = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin' });
    if (!full.ok) return;
    expect(combined.sort()).toEqual(ids(full.value.data.tabs).sort()); // no gaps
  });

  it('rejects a cursor minted for a DIFFERENT componentId', async () => {
    const first = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin', limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    const replay = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Bare', cursor });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed / forged cursor string', async () => {
    const replay = await tabAvailabilityHandler(ctx, {
      componentId: 'Profile:Admin',
      cursor: 'not-a-real-cursor',
    });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});
