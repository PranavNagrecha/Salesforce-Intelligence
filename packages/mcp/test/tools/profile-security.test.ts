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
      loginHours: [
        { day: 'Monday', startTime: '480', endTime: '1020' },
        { day: 'Friday', startTime: '480', endTime: '780' },
        // A malformed row (no day) must be dropped, never [object Object].
        { startTime: '0', endTime: '100' },
      ],
    } }),
    // NEVER EXTRACTED: a Profile node built by a refresh that predates
    // login-restriction extraction carries NO `loginIpRanges` key at all.
    node({ id: 'Profile:Open', type: 'Profile', apiName: 'Open', label: 'Open Profile', properties: {} }),
    // EXTRACTED AND CLEAN: the extractor always writes the trio (empty when the
    // profile declares no restriction) — this is a VERIFIED zero.
    node({ id: 'Profile:Unrestricted', type: 'Profile', apiName: 'Unrestricted', label: 'Unrestricted Profile', properties: {
      loginIpRanges: [],
      loginHoursDefined: false,
      loginHours: [],
    } }),
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
    // Login-hours per-weekday windows, dropping the malformed row (no day).
    expect(d.loginHoursByDay).toEqual([
      { day: 'Monday', startTime: '480', endTime: '1020' },
      { day: 'Friday', startTime: '480', endTime: '780' },
    ]);
    expect(d.confidence).toBe('declared');
    expect(d.profileLabel).toBe('Restricted Profile');
  });

  it('reports sessionSecuritySettings null + a refresh-gated disclosure when SessionSettings is absent', async () => {
    const r = await profileSecurityHandler(ctx, { profileId: 'Profile:Restricted' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.sessionSecuritySettings).toBeNull();
    expect(r.value.data.boundaryNote).toContain('refresh-gated');
  });

  // The old single case here asserted `[] / 0 / false` for `Profile:Open`, whose
  // properties are EMPTY — i.e. it pinned the never-extracted vault as a verified
  // "this profile is not restricted". Split into the two honest cases.
  it('reports a VERIFIED zero for a profile the extractor checked and found unrestricted', async () => {
    const r = await profileSecurityHandler(ctx, { profileId: 'Profile:Unrestricted' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.loginRestrictionsExtracted).toBe(true);
    expect(d.loginIpRanges).toEqual([]);
    expect(d.loginIpRangeCount).toBe(0);
    expect(d.loginHoursByDay).toEqual([]);
    expect(d.loginHoursRestricted).toBe(false);
    // A checked-and-clean profile must NOT carry the not-extracted disclosure.
    expect(d.boundaryNote).not.toContain('NOT checked');
  });

  it('does NOT report a profile from a pre-extraction refresh as unrestricted (typed absence)', async () => {
    const r = await profileSecurityHandler(ctx, { profileId: 'Profile:Open' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    // null, never [] / 0 / false — an absent sentinel is "not modeled", and a
    // profile locked to a corporate network must never read as unrestricted.
    expect(d.loginIpRangeCount).toBeNull();
    expect(d.loginHoursRestricted).toBeNull();
    expect(d.loginRestrictionsExtracted).toBe(false);
    expect(d.loginIpRanges).toBeNull();
    expect(d.loginHoursByDay).toBeNull();
    expect(d.boundaryNote).toContain('NOT checked');
    expect(d.boundaryNote).toContain('loginIpRanges');
    expect(d.boundaryNote).toContain('/sfi-refresh');
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

  // PROFILE-SECURITY-REJECTS-COMPONENTID: a host forwarding sfi.resolve's
  // Profile id (as `componentId` / `profileApiName`) must reach the SAME answer.
  it('resolves a componentId / profileApiName selector to the SAME result as profileId', async () => {
    const canonical = await profileSecurityHandler(ctx, { profileId: 'Profile:Restricted' });
    const viaComponentId = await profileSecurityHandler(ctx, { componentId: 'Profile:Restricted' });
    const viaApiName = await profileSecurityHandler(ctx, { profileApiName: 'Restricted' });
    expect(canonical.ok && viaComponentId.ok && viaApiName.ok).toBe(true);
    if (!canonical.ok || !viaComponentId.ok || !viaApiName.ok) return;
    // Byte-identical payload whichever selector the host supplied.
    expect(viaComponentId.value.data).toEqual(canonical.value.data);
    expect(viaApiName.value.data).toEqual(canonical.value.data);
    expect(viaComponentId.value.data.profileId).toBe('Profile:Restricted');
  });

  it('rejects a wrong-type componentId (a PermissionSet) with invalid-query', async () => {
    const r = await profileSecurityHandler(ctx, { componentId: 'PermissionSet:Custom' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('rejects disagreeing selectors with invalid-query', async () => {
    const r = await profileSecurityHandler(ctx, {
      profileId: 'Profile:Restricted',
      componentId: 'Profile:Open',
    });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('different targets');
  });

  it('rejects a call with no selector at all with invalid-query', async () => {
    const r = await profileSecurityHandler(ctx, {});
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('profileId');
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
