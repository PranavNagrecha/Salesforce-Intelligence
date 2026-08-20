/// <reference types="vitest/globals" />

/**
 * STALE-CHECK-DESCRIPTION-UNDERSTATES-COVERAGE.
 *
 * `live_stale_check` queries {@link STALE_CHECK_TYPES} — 15 types. Its MCP
 * roster description, `fleet_drift_ranking`'s roster description, and
 * `fleet_drift_ranking`'s own response disclosure all hand-listed the SIX
 * original types and were never updated when the P13-WATCH widening added the
 * other nine. The nine omitted ones are exactly the permission / security drift
 * families (Profile, PermissionSet, PermissionSetGroup, SharingRules) plus the
 * UI / record-type surfaces — the most valuable half of the check — so a host
 * reading the advertised description would conclude a Profile edit is NOT
 * detected, when it is.
 *
 * This repo's standing rule is that a behaviour is not done until the MCP tool
 * DESCRIPTION and the JSDoc match the code. These assertions are the gate for
 * that rule on the staleness surface: they fail for ANY type the handler loops
 * over that a human-facing surface fails to name, so the only maintainable way
 * to satisfy them is to interpolate the constant (which the fix does) rather
 * than re-list the members by hand (which is what rotted).
 */
import { describe, expect, it } from 'vitest';

import { FLEET_DRIFT_DISCLOSURE } from '../../src/tools/fleet-drift-ranking.js';
import { V01_TOOLS } from '../../src/tools/index.js';
import {
  STALE_CHECK_TYPE_COUNT,
  STALE_CHECK_TYPE_LIST,
  STALE_CHECK_TYPES,
} from '../../src/tools/live-plane.js';

const descriptionOf = (name: string): string => {
  const tool = V01_TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool not in roster: ${name}`);
  return tool.description;
};

describe('live staleness surfaces name every type the handler actually checks', () => {
  it('the derived prose constants track STALE_CHECK_TYPES exactly', () => {
    expect(STALE_CHECK_TYPE_COUNT).toBe(STALE_CHECK_TYPES.length);
    for (const type of STALE_CHECK_TYPES) {
      expect(STALE_CHECK_TYPE_LIST).toContain(type);
    }
  });

  it.each([...STALE_CHECK_TYPES])(
    'sfi.live_stale_check description names the checked type %s',
    (type) => {
      expect(descriptionOf('sfi.live_stale_check')).toContain(type);
    },
  );

  it.each([...STALE_CHECK_TYPES])(
    'sfi.fleet_drift_ranking description names the checked type %s',
    (type) => {
      expect(descriptionOf('sfi.fleet_drift_ranking')).toContain(type);
    },
  );

  it.each([...STALE_CHECK_TYPES])(
    'the fleet_drift_ranking response disclosure names the checked type %s',
    (type) => {
      expect(FLEET_DRIFT_DISCLOSURE).toContain(type);
    },
  );

  it('no surface still advertises the stale count of 6', () => {
    // The literal that rotted: "Only the 6 checked types drift-count" and
    // "N orgs x 6 queries". Guard the NUMBER as well as the member list, so a
    // future widening cannot leave a stale tally behind a correct list.
    for (const text of [
      descriptionOf('sfi.live_stale_check'),
      descriptionOf('sfi.fleet_drift_ranking'),
      FLEET_DRIFT_DISCLOSURE,
    ]) {
      expect(text).not.toMatch(/\b6 (?:checked types|queries)\b/);
    }
    expect(descriptionOf('sfi.fleet_drift_ranking')).toContain(
      `Only the ${String(STALE_CHECK_TYPE_COUNT)} checked types drift-count`,
    );
  });

  it('the permission / security families are named, not just counted', () => {
    // The whole point of the widening — and the half the description hid.
    const permissionFamilies = [
      'Profile',
      'PermissionSet',
      'PermissionSetGroup',
      'SharingRules',
    ] as const;
    for (const family of permissionFamilies) {
      expect(STALE_CHECK_TYPES).toContain(family);
      expect(descriptionOf('sfi.live_stale_check')).toContain(family);
    }
  });
});
