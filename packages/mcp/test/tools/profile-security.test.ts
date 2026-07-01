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
import { profileSecurityHandler } from '../../src/tools/profile-security.js';

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

// Two fixtures: one WITHOUT a SessionSettings node (refresh-gated → null), one
// WITH it. They live in separate graphs so the null-vs-present cases are clean.
const seedNoSession: ExtractionResult = {
  nodes: [
    node({ id: 'Profile:Restricted', type: 'Profile', apiName: 'Restricted', label: 'Restricted Profile', properties: {
      loginIpRanges: [
        { startAddress: '10.0.0.1', endAddress: '10.0.0.255' },
        { startAddress: '192.168.1.0', endAddress: '192.168.1.255' },
        // A malformed row (missing endAddress) must be dropped, never [object Object].
        { startAddress: '172.16.0.1' },
      ],
      loginHoursDefined: true,
    } }),
    node({ id: 'Profile:Open', type: 'Profile', apiName: 'Open', label: 'Open Profile', properties: {} }),
    node({ id: 'PermissionSet:Custom', type: 'PermissionSet', apiName: 'Custom', properties: {} }),
  ],
  edges: [],
};

const seedWithSession: ExtractionResult = {
  nodes: [
    node({ id: 'Profile:Sales', type: 'Profile', apiName: 'Sales', label: 'Sales Profile', properties: {
      loginIpRanges: [{ startAddress: '203.0.113.0', endAddress: '203.0.113.255' }],
    } }),
    node({ id: 'SessionSettings:default', type: 'SessionSettings', apiName: 'SessionSettings', label: 'Session Settings', properties: {
      mfaRequired: true,
      requiresStrongAuth: true,
      sessionTimeoutMinutes: 480,
    } }),
  ],
  edges: [],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
let tempDir2: string; let store2: GraphStore; let ctxWithSession: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-profile-security-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seedNoSession]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };

  tempDir2 = mkdtempSync(join(tmpdir(), 'sfi-profile-security-sess-'));
  const o2 = await openGraph(join(tempDir2, 'g.db')); if (!o2.ok) throw new Error(o2.error.message);
  store2 = o2.value;
  const i2 = await importExtractionResults(store2, [seedWithSession]); if (!i2.ok) throw new Error(i2.error.message);
  ctxWithSession = { vaultRoot: tempDir2, manifest: MANIFEST, graph: store2 };
});

afterAll(async () => {
  await closeGraph(store); rmSync(tempDir, { recursive: true, force: true });
  await closeGraph(store2); rmSync(tempDir2, { recursive: true, force: true });
});

describe('profileSecurityHandler', () => {
  it('returns the profile login IP ranges, dropping malformed rows', async () => {
    const r = await profileSecurityHandler(ctx, { profileId: 'Profile:Restricted' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    // The malformed third row (no endAddress) is dropped — only the two valid ones remain.
    expect(d.loginIpRanges).toEqual([
      { startAddress: '10.0.0.1', endAddress: '10.0.0.255' },
      { startAddress: '192.168.1.0', endAddress: '192.168.1.255' },
    ]);
    expect(d.loginIpRangeCount).toBe(2);
    expect(d.loginHoursRestricted).toBe(true);
    // Login-hours windows are DEFERRED behind the SessionSettings tier.
    expect(d.loginHoursByDay).toEqual([]);
    expect(d.confidence).toBe('declared');
    expect(d.profileLabel).toBe('Restricted Profile');
  });

  it('reports sessionSecuritySettings null + a refresh-gated disclosure when SessionSettings is absent', async () => {
    const r = await profileSecurityHandler(ctx, { profileId: 'Profile:Restricted' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.sessionSecuritySettings).toBeNull();
    expect(r.value.data.boundaryNote).toContain('refresh-gated');
  });

  it('reports empty login restrictions for a profile with none', async () => {
    const r = await profileSecurityHandler(ctx, { profileId: 'Profile:Open' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.loginIpRanges).toEqual([]);
    expect(r.value.data.loginIpRangeCount).toBe(0);
    expect(r.value.data.loginHoursRestricted).toBe(false);
  });

  it('coerces a bare profile apiName to a Profile: id', async () => {
    const r = await profileSecurityHandler(ctx, { profileId: 'Restricted' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.profileId).toBe('Profile:Restricted');
    expect(r.value.data.loginIpRangeCount).toBe(2);
  });

  it('rejects a PermissionSet id with invalid-query (login security is Profile-only)', async () => {
    const r = await profileSecurityHandler(ctx, { profileId: 'PermissionSet:Custom' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('component-not-found for an unknown profile', async () => {
    const r = await profileSecurityHandler(ctx, { profileId: 'Profile:Ghost' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('populates sessionSecuritySettings from the org SessionSettings:default node', async () => {
    const r = await profileSecurityHandler(ctxWithSession, { profileId: 'Profile:Sales' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.sessionSecuritySettings).toEqual({
      mfaRequired: true,
      requiresStrongAuth: true,
      sessionTimeoutMinutes: 480,
    });
    // With settings present the disclosure must NOT claim the refresh-gated gap.
    expect(d.boundaryNote).not.toContain('refresh-gated');
    expect(d.loginIpRanges).toEqual([{ startAddress: '203.0.113.0', endAddress: '203.0.113.255' }]);
  });
});
