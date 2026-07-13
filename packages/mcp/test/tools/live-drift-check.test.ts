/// <reference types="vitest/globals" />

import type { VaultManifest } from '@sf-intelligence/contracts';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import {
  diffFields,
  liveDriftCheckHandler,
  liveDriftCheckInputSchema,
} from '../../src/tools/live-drift-check.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { CustomObject: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const ctx = { manifest: FIXTURE_MANIFEST, liveCapability: mintLiveCapability('primary') } as Context;

describe('diffFields', () => {
  it('flags vault-only fields (stale) and custom live-only fields (added)', () => {
    const d = diffFields(['A__c', 'B__c', 'Name'], ['A__c', 'C__c', 'Name']);
    expect(d.onlyInVault).toEqual(['B__c']); // in snapshot, gone live → stale
    expect(d.onlyInLiveCustom).toEqual(['C__c']); // added live, custom
  });

  it('excludes standard fields from the live-only set (no noise)', () => {
    const d = diffFields(['A__c'], ['A__c', 'Industry', 'Phone']); // Industry/Phone are standard
    expect(d.onlyInVault).toEqual([]);
    expect(d.onlyInLiveCustom).toEqual([]);
  });

  it('reports nothing when the field sets match', () => {
    const d = diffFields(['A__c', 'B__c'], ['B__c', 'A__c']);
    expect(d.onlyInVault).toEqual([]);
    expect(d.onlyInLiveCustom).toEqual([]);
  });
});

describe('liveDriftCheckHandler', () => {
  it('propagates the live-plane-disabled error when not enabled', async () => {
    const r = await liveDriftCheckHandler(ctx, { objectApiName: 'Account' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // liveDescribeHandler refuses when the plane is off.
    expect(r.error.message.toLowerCase()).toContain('live');
  });
});

describe('liveDriftCheckInputSchema', () => {
  it('requires objectApiName and accepts liveEnabled', () => {
    expect(liveDriftCheckInputSchema.safeParse({}).success).toBe(false);
    expect(liveDriftCheckInputSchema.safeParse({ objectApiName: 'Account', liveEnabled: true }).success).toBe(true);
  });
});
