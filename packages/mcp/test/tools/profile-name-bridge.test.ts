/// <reference types="vitest/globals" />

/**
 * PLATFORM-ACCESS-ORACLE — contract pins for the ONE profile-bridge seam.
 *
 * The mechanism behind this seam (the refresh-built label<->API-name join) is
 * under independent verification and may be replaced. These pins are written
 * against the SEAM'S CONTRACT, not the join, so they survive that swap:
 * whatever the mechanism, the caller gets a resolved API name backed by
 * evidence, or an actionable refusal — never a guess, never silence.
 *
 * The resolution key is the PROFILE ID, never the label: labels are mutable and
 * re-usable, and a label-keyed lookup silently misattributes after a rename.
 *
 * PRIVACY: every profile here is INVENTED.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildProfileNameMap, saveProfileNameMap } from '@sf-intelligence/vault';

import { bridgeProfileToApiName } from '../../src/tools/profile-name-bridge.js';

const ID_A = '00e0x0000000001AAA';
const ID_B = '00e0x0000000002AAA';
const NOW = '2026-08-20T00:00:00.000Z';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-bridge-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolved path', () => {
  it('crosses a label that does NOT equal the api name, and cites its evidence', async () => {
    await saveProfileNameMap(
      dir,
      buildProfileNameMap(
        [{ id: ID_A, fullName: 'Std_User_Profile' }],
        [{ Id: ID_A, Name: 'Standard Widget User' }],
        NOW,
      ),
    );
    const r = await bridgeProfileToApiName(dir, ID_A, 'Standard Widget User');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.apiName).toBe('Std_User_Profile');
    expect(r.resolution).toEqual({
      label: 'Standard Widget User',
      profileId15: ID_A.slice(0, 15),
      mappedLabel: 'Standard Widget User',
      labelChangedSinceRefresh: false,
      apiName: 'Std_User_Profile',
      source: 'vault-profile-name-map',
      mapBuiltAt: NOW,
      mapEntries: 1,
      mapGaps: 0,
    });
  });

  it('counts every disclosed gap class, so a partial map advertises its own limits', async () => {
    await saveProfileNameMap(
      dir,
      buildProfileNameMap(
        [
          { id: ID_A, fullName: 'Std_User_Profile' },
          { id: ID_B, fullName: 'MetadataOnly' },
          { id: '', fullName: 'NoIdAtAll' },
        ],
        [{ Id: ID_A, Name: 'Standard Widget User' }],
        NOW,
      ),
    );
    const r = await bridgeProfileToApiName(dir, ID_A, 'Standard Widget User');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // onlyInMetadata (ID_B) + unjoinable.metadata (NoIdAtAll) = 2.
    expect(r.resolution.mapGaps).toBe(2);
  });
});

describe('every failure mode is a LOUD refusal, never a fallback', () => {
  it('map ABSENT -> refuses, names `sfi refresh` AND `profileId`, and says why not to guess', async () => {
    const r = await bridgeProfileToApiName(dir, ID_A, 'Standard Widget User');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('profileId');
    expect(r.error.message).toMatch(/no Profile Id<->API-name map/i);
    expect(r.error.message).toMatch(/sfi refresh/);
    expect(r.error.message).toMatch(/mutable and re-usable/i);
  });

  it('map EMPTY is still a map, and still refuses (absent vs empty stay distinct)', async () => {
    await saveProfileNameMap(dir, buildProfileNameMap([], [], NOW));
    const r = await bridgeProfileToApiName(dir, ID_A, 'Standard Widget User');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The EMPTY-map message cites the built map; the ABSENT one does not exist.
    expect(r.error.message).toMatch(/not in this vault's Profile Id<->API-name map/i);
    expect(r.error.message).not.toMatch(/has no Profile Id/i);
  });

  it('label UNKNOWN -> refuses and points at a stale-vault / disclosed-gap cause', async () => {
    await saveProfileNameMap(
      dir,
      buildProfileNameMap(
        [{ id: ID_A, fullName: 'Std_User_Profile' }],
        [{ Id: ID_A, Name: 'Standard Widget User' }],
        NOW,
      ),
    );
    const r = await bridgeProfileToApiName(dir, ID_B, 'Brand New Profile');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/created after the last refresh/i);
    expect(r.error.message).toMatch(/profileId/);
  });

  it('a RENAMED profile still resolves, and the rename is DISCLOSED not hidden', async () => {
    // Map built when the profile was 'Standard Widget User'; the org has since
    // renamed it. Under the old label-keyed design this silently failed (or
    // worse, matched a different profile). Now it resolves and says so.
    await saveProfileNameMap(
      dir,
      buildProfileNameMap(
        [{ id: ID_A, fullName: 'Std_User_Profile' }],
        [{ Id: ID_A, Name: 'Standard Widget User' }],
        NOW,
      ),
    );
    const r = await bridgeProfileToApiName(dir, ID_A, 'Renamed Widget User');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.apiName).toBe('Std_User_Profile');
    expect(r.resolution.labelChangedSinceRefresh).toBe(true);
    expect(r.resolution.mappedLabel).toBe('Standard Widget User');
    expect(r.resolution.label).toBe('Renamed Widget User');
  });

  it('a REUSED label cannot mis-resolve: each id gets its own profile', async () => {
    await saveProfileNameMap(
      dir,
      buildProfileNameMap(
        [
          { id: ID_A, fullName: 'OriginalProfile' },
          { id: ID_B, fullName: 'ImposterProfile' },
        ],
        [
          { Id: ID_A, Name: 'Old Name' },
          { Id: ID_B, Name: 'Shared Support Name' },
        ],
        NOW,
      ),
    );
    // Both users report the SAME label; only the ids differ.
    const a = await bridgeProfileToApiName(dir, ID_A, 'Shared Support Name');
    const b = await bridgeProfileToApiName(dir, ID_B, 'Shared Support Name');
    expect(a.ok && a.apiName).toBe('OriginalProfile');
    expect(b.ok && b.apiName).toBe('ImposterProfile');
  });

  it('NO ProfileId at all -> refuses rather than falling back to the label', async () => {
    await saveProfileNameMap(
      dir,
      buildProfileNameMap(
        [{ id: ID_A, fullName: 'Std_User_Profile' }],
        [{ Id: ID_A, Name: 'Standard Widget User' }],
        NOW,
      ),
    );
    const r = await bridgeProfileToApiName(dir, null, 'Standard Widget User');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/no usable ProfileId/i);
    expect(r.error.message).toMatch(/labels are mutable/i);
  });

  it('NEVER name-matches: a name in the id position resolves to nothing', async () => {
    await saveProfileNameMap(
      dir,
      buildProfileNameMap(
        [{ id: ID_A, fullName: 'Std_User_Profile' }],
        [{ Id: ID_A, Name: 'Standard Widget User' }],
        NOW,
      ),
    );
    expect((await bridgeProfileToApiName(dir, 'Std_User_Profile', null)).ok).toBe(false);
    expect((await bridgeProfileToApiName(dir, 'Standard Widget User', null)).ok).toBe(false);
  });

  it('a CORRUPT artifact is treated as ABSENT, never as an empty or partial map', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(join(dir, 'meta', 'profile-name-map.json'), '{ broken', 'utf8');
    const r = await bridgeProfileToApiName(dir, ID_A, 'Standard Widget User');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/no Profile Id<->API-name map/i);
  });
});
