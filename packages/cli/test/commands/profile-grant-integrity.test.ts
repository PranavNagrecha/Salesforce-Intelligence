/// <reference types="vitest/globals" />

import type {
  ComponentType,
  CoverageEntry,
  Edge,
  EdgeType,
  ExtractionResult,
  Node,
} from '@sf-intelligence/contracts';

import {
  assessProfileGrantIntegrity,
  computeProfileGrantStats,
  decorateProfileGrantCoverage,
  formatRefreshSummary,
  PROFILE_GRANT_DISCLOSURE,
  type ProfileGrantStats,
  type RefreshResult,
} from '../../src/commands/refresh.js';

/**
 * PROFILE-COBATCH detect+disclose (trust-critical). Regression context: a
 * split retrieve separated Profile from its co-listed types, profiles came
 * back with ZERO grant sections while `retrieveConfirmed: true` read healthy,
 * and `grantedBy` collapsed 83,798 -> 26,849 — caught only by a real-org
 * probe. These tests pin the detection that makes that failure LOUD.
 */

const node = (type: ComponentType, apiName: string): Node => ({
  id: `${type}:${apiName}`,
  type,
  apiName,
  label: null,
  parentId: null,
  sourcePath: `source/${apiName}`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const edge = (edgeType: EdgeType, fromId: string, toId: string): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'declared',
  source: 'test',
  properties: {},
});

const result = (nodes: readonly Node[], edges: readonly Edge[]): ExtractionResult => ({
  nodes,
  edges,
});

const stats = (over: Partial<ProfileGrantStats>): ProfileGrantStats => ({
  profileCount: 0,
  profileGrantEdges: 0,
  permissionSetGrantEdges: 0,
  ...over,
});

describe('computeProfileGrantStats', () => {
  it('counts profiles and partitions grantedBy edges by source family', () => {
    const results: ExtractionResult[] = [
      result(
        [node('Profile', 'Admin'), node('Profile', 'Standard')],
        [
          edge('grantedBy', 'Profile:Admin', 'CustomObject:Account'),
          edge('grantedBy', 'Profile:Admin', 'ApexClass:Foo'),
        ],
      ),
      result(
        [node('PermissionSet', 'Conga_Admin')],
        [edge('grantedBy', 'PermissionSet:Conga_Admin', 'CustomField:Account.SSN__c')],
      ),
    ];
    expect(computeProfileGrantStats(results)).toEqual({
      profileCount: 2,
      profileGrantEdges: 2,
      permissionSetGrantEdges: 1,
    });
  });

  it('ignores non-grantedBy edges and grants from other containers', () => {
    const results: ExtractionResult[] = [
      result(
        [node('Profile', 'Admin')],
        [
          edge('parentOf', 'Profile:Admin', 'CustomObject:Account'),
          edge('grantedBy', 'MutingPermissionSet:Mute', 'CustomField:Account.SSN__c'),
        ],
      ),
    ];
    expect(computeProfileGrantStats(results)).toEqual({
      profileCount: 1,
      profileGrantEdges: 0,
      permissionSetGrantEdges: 0,
    });
  });

  it('returns zeros for an empty walk', () => {
    expect(computeProfileGrantStats([])).toEqual({
      profileCount: 0,
      profileGrantEdges: 0,
      permissionSetGrantEdges: 0,
    });
  });
});

describe('assessProfileGrantIntegrity — bare-profile contrast (the co-listing fingerprint)', () => {
  it('fires when profiles carry ~zero grants while permission sets carry grants', () => {
    const disclosure = assessProfileGrantIntegrity(
      stats({ profileCount: 43, profileGrantEdges: 0, permissionSetGrantEdges: 26_849 }),
      null,
      26_849,
    );
    expect(disclosure).not.toBeNull();
    expect(disclosure).toContain(PROFILE_GRANT_DISCLOSURE);
    expect(disclosure).toContain('43 profile(s)');
  });

  it('stays quiet on a healthy vault (profiles carry their grants)', () => {
    expect(
      assessProfileGrantIntegrity(
        stats({ profileCount: 43, profileGrantEdges: 60_000, permissionSetGrantEdges: 23_000 }),
        83_798,
        83_798,
      ),
    ).toBeNull();
  });

  it('stays quiet when no profiles were extracted (a scoped --types run without Profile)', () => {
    expect(
      assessProfileGrantIntegrity(
        stats({ profileCount: 0, permissionSetGrantEdges: 5_000 }),
        null,
        5_000,
      ),
    ).toBeNull();
  });

  it('does not use the contrast signal when permission sets are also bare (no fingerprint to contrast)', () => {
    expect(
      assessProfileGrantIntegrity(
        stats({ profileCount: 5, profileGrantEdges: 0, permissionSetGrantEdges: 0 }),
        null,
        0,
      ),
    ).toBeNull();
  });
});

describe('assessProfileGrantIntegrity — order-of-magnitude collapse vs the prior manifest', () => {
  // Profiles carry SOME grants (so the contrast branch stays quiet) but the
  // total collapsed >=10x vs the previous refresh.
  const someProfileGrants = stats({
    profileCount: 43,
    profileGrantEdges: 200,
    permissionSetGrantEdges: 5_000,
  });

  it('fires on a >=10x grantedBy drop against the prior manifest', () => {
    const disclosure = assessProfileGrantIntegrity(someProfileGrants, 83_798, 5_200);
    expect(disclosure).not.toBeNull();
    expect(disclosure).toContain(PROFILE_GRANT_DISCLOSURE);
    expect(disclosure).toContain('83798');
  });

  it('stays quiet without a prior manifest (first refresh)', () => {
    expect(assessProfileGrantIntegrity(someProfileGrants, null, 5_200)).toBeNull();
  });

  it('stays quiet below the small-vault floor (normal churn on tiny orgs)', () => {
    expect(assessProfileGrantIntegrity(someProfileGrants, 90, 5)).toBeNull();
  });

  it('stays quiet on a sub-10x drop (org change, not a bare-out)', () => {
    // The shipped regression's totals (83,798 -> 26,849) are only a 3.1x drop
    // because permsets kept their grants — the CONTRAST branch is what catches
    // that shape; this branch guards the full-collapse shape.
    expect(assessProfileGrantIntegrity(someProfileGrants, 83_798, 26_849)).toBeNull();
  });
});

describe('decorateProfileGrantCoverage', () => {
  const entries: readonly CoverageEntry[] = [
    {
      type: 'Profile',
      requested: true,
      retrieved: 43,
      errored: false,
      neverModeled: false,
      retrieveConfirmed: true,
    },
    { type: 'PermissionSet', requested: true, retrieved: 120, errored: false, neverModeled: false },
  ];

  it('marks the Profile row errored with the disclosure and strips retrieveConfirmed', () => {
    const out = decorateProfileGrantCoverage(entries, `${PROFILE_GRANT_DISCLOSURE}: details`);
    const profile = out.find((e) => e.type === 'Profile');
    expect(profile).toBeDefined();
    // The bare retrieve must NOT read as confirmed-clean: errored routes the
    // row into `partial` in summarizeCoverage/coverage_report, so absence
    // caveats fire and health_check degrades.
    expect(profile?.errored).toBe(true);
    expect(profile?.errorReason).toContain(PROFILE_GRANT_DISCLOSURE);
    expect(profile?.retrieveConfirmed).toBeUndefined();
    // Other rows untouched.
    expect(out.find((e) => e.type === 'PermissionSet')).toEqual(entries[1]);
  });

  it('is a no-op when detection did not fire', () => {
    expect(decorateProfileGrantCoverage(entries, null)).toEqual(entries);
  });
});

describe('formatRefreshSummary profile-grant disclosure block', () => {
  const baseResult = (over: Partial<RefreshResult>): RefreshResult => ({
    status: 'partial',
    counts: { components: {}, edges: {} },
    errors: [],
    durationMs: 12,
    skippedDirectories: {},
    ...over,
  });

  it('renders the disclosure as a WARNING', () => {
    const summary = formatRefreshSummary(
      baseResult({
        profileGrantDisclosure: `${PROFILE_GRANT_DISCLOSURE}: 43 profile(s) extracted with only 0 grant edge(s)`,
      }),
    );
    expect(summary).toContain('WARNING');
    expect(summary).toContain(PROFILE_GRANT_DISCLOSURE);
  });

  it('omits the block on a clean run', () => {
    expect(formatRefreshSummary(baseResult({ status: 'success' }))).not.toContain(
      PROFILE_GRANT_DISCLOSURE,
    );
  });
});
