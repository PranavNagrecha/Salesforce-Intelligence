/// <reference types="vitest/globals" />

import type { ComponentType } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import {
  classifyRetrieveError,
  formatRefreshSummary,
  PROFILE_COBATCH_GROUP,
  retrieveWithFallback,
  splitTypeBatch,
  summarizeRetrieveFailures,
  toAtomicUnits,
  type RefreshResult,
  type RetrieveTypeFailure,
} from '../../src/commands/refresh.js';
import { SUPPORTED_TYPES } from '../../src/refresh-pipeline.js';

/** Empty atomic group: the legacy pure per-type split semantics. */
const NO_GROUP: ReadonlySet<ComponentType> = new Set();

/**
 * A fake batch retriever that fails for any type in `badTypes` with `errorFor`,
 * and records every batch it was asked to retrieve so tests can assert the
 * binary-search shape (e.g. that a clean org is one call, not 2N-1).
 */
const fakeRetriever = (
  badTypes: ReadonlySet<ComponentType>,
  errorFor: (type: ComponentType) => string,
): {
  readonly fn: (types: readonly ComponentType[]) => Promise<Result<{ readonly deletedCount: number }, string>>;
  readonly calls: ComponentType[][];
} => {
  const calls: ComponentType[][] = [];
  const fn = async (
    types: readonly ComponentType[],
  ): Promise<Result<{ readonly deletedCount: number }, string>> => {
    calls.push([...types]);
    const bad = types.find((t) => badTypes.has(t));
    // A real `sf` retrieve fails the WHOLE batch if any member is rejected.
    return bad !== undefined ? err(errorFor(bad)) : ok({ deletedCount: types.length });
  };
  return { fn, calls };
};

const TYPES = [
  'ApexClass',
  'ApexTrigger',
  'CustomObject',
  'Flow',
  'Layout',
  'OmniScript',
] as unknown as readonly ComponentType[];

describe('splitTypeBatch', () => {
  it('splits into two near-equal halves', () => {
    const [l, r] = splitTypeBatch(TYPES);
    expect(l.length + r.length).toBe(TYPES.length);
    expect([...l, ...r]).toEqual([...TYPES]);
    expect(Math.abs(l.length - r.length)).toBeLessThanOrEqual(1);
  });

  it('keeps a single-element batch whole on the right', () => {
    const [l, r] = splitTypeBatch([TYPES[0]!]);
    expect(l).toEqual([]);
    expect(r).toEqual([TYPES[0]]);
  });
});

describe('classifyRetrieveError', () => {
  it('treats INVALID_TYPE and entity rejections as per-type', () => {
    expect(classifyRetrieveError('ERROR running force:source: INVALID_TYPE: OmniScript')).toBe('per-type');
    expect(classifyRetrieveError('Cannot retrieve DecisionTable')).toBe('per-type');
  });

  it('treats auth / project / org-config errors as global (splitting cannot fix them)', () => {
    expect(classifyRetrieveError('No authorization information found for org')).toBe('global');
    expect(classifyRetrieveError('This directory does not contain a valid Salesforce DX project')).toBe('global');
    expect(classifyRetrieveError('expired access/refresh token')).toBe('global');
    expect(classifyRetrieveError('No default org found; this command requires a target org')).toBe('global');
  });

  it('treats transient network/timeout errors as per-type so a big batch splits instead of aborting', () => {
    // Regression: a load-induced timeout on the full combined retrieve used to be
    // classified 'global' and aborted the whole refresh on large real orgs.
    expect(classifyRetrieveError('getaddrinfo ENOTFOUND login.salesforce.com')).toBe('per-type');
    expect(classifyRetrieveError('socket hang up')).toBe('per-type');
    expect(classifyRetrieveError('Client network socket disconnected; connection timed out')).toBe('per-type');
  });
});

describe('retrieveWithFallback', () => {
  it('takes ONE call when the full set retrieves cleanly', async () => {
    const { fn, calls } = fakeRetriever(new Set(), () => 'unused');
    const out = await retrieveWithFallback(TYPES, fn);
    expect(out.succeeded).toEqual([...TYPES]);
    expect(out.failures).toEqual([]);
    expect(out.deletedCount).toBe(TYPES.length);
    expect(calls.length).toBe(1); // fast path: no splitting
  });

  it('isolates one poisoned type and keeps everything else (partial vault)', async () => {
    const bad = 'OmniScript' as ComponentType;
    const { fn } = fakeRetriever(new Set([bad]), (t) => `INVALID_TYPE: ${t}`);
    const out = await retrieveWithFallback(TYPES, fn);
    expect(out.failures).toEqual([{ type: bad, error: 'INVALID_TYPE: OmniScript' }]);
    expect(out.succeeded).not.toContain(bad);
    expect(out.succeeded.length).toBe(TYPES.length - 1);
    // Surviving types still count their reconcile deletions.
    expect(out.deletedCount).toBe(TYPES.length - 1);
  });

  it('does NOT split on a global failure — one call, whole batch attributed', async () => {
    const { fn, calls } = fakeRetriever(
      new Set(TYPES),
      () => 'No authorization information found for org',
    );
    const out = await retrieveWithFallback(TYPES, fn);
    expect(out.succeeded).toEqual([]);
    expect(out.failures.length).toBe(TYPES.length);
    expect(calls.length).toBe(1); // global short-circuit: no 2N-1 hammering
  });

  it('splits a load-induced timeout until batches are small enough to land (the real bug)', async () => {
    // Any batch larger than 2 types "times out"; smaller batches succeed. The old
    // behavior classified the timeout 'global' and returned zero types; the fix
    // must split the oversized batch until every type lands. Group disabled:
    // this test pins the pure per-type split mechanics (TYPES contains three
    // PROFILE_COBATCH_GROUP members, which the default group would — correctly —
    // refuse to shrink below a 3-type batch; see the co-batch describe below).
    const calls: ComponentType[][] = [];
    const fn = async (
      types: readonly ComponentType[],
    ): Promise<Result<{ readonly deletedCount: number }, string>> => {
      calls.push([...types]);
      return types.length > 2
        ? err('Client network socket disconnected before secure TLS connection was established; socket hang up')
        : ok({ deletedCount: types.length });
    };
    const out = await retrieveWithFallback(TYPES, fn, NO_GROUP);
    expect([...out.succeeded].sort()).toEqual([...TYPES].sort());
    expect(out.failures).toEqual([]);
    expect(calls.length).toBeGreaterThan(1); // it split rather than aborting on the timeout
  });

  it('returns all-failed when every type is independently bad', async () => {
    const { fn } = fakeRetriever(new Set(TYPES), (t) => `per-type breakage of ${t}`);
    const out = await retrieveWithFallback(TYPES, fn);
    expect(out.succeeded).toEqual([]);
    expect(out.failures.map((f) => f.type).sort()).toEqual([...TYPES].sort());
  });
});

describe('PROFILE_COBATCH_GROUP', () => {
  it('contains Profile and every co-listing partner the regression bared out', () => {
    // The Metadata API serializes Profile grant sections ONLY for co-named
    // types; these are the partners whose separation shipped the
    // grantedBy 83,798 -> 26,849 regression.
    for (const type of [
      'Profile',
      'CustomObject',
      'ApexClass',
      'ListView',
      'ValidationRule',
      'RecordType',
      'WebLink',
      'FieldSet',
    ] as unknown as ComponentType[]) {
      expect(PROFILE_COBATCH_GROUP.has(type)).toBe(true);
    }
  });

  it('does NOT contain PermissionSet — permsets retrieve complete standalone (API v40+), proven by the regression itself', () => {
    expect(PROFILE_COBATCH_GROUP.has('PermissionSet' as ComponentType)).toBe(false);
  });

  it('every member is a supported retrieve type (a typo here would silently disable the invariant)', () => {
    const supported = new Set<string>(SUPPORTED_TYPES);
    for (const member of PROFILE_COBATCH_GROUP) {
      expect(supported.has(member)).toBe(true);
    }
  });
});

describe('toAtomicUnits', () => {
  it('collapses group members into ONE unit at the first member position, preserving order', () => {
    const types = ['ApexClass', 'ApexTrigger', 'CustomObject', 'Flow', 'Profile'] as unknown as readonly ComponentType[];
    const units = toAtomicUnits(types, PROFILE_COBATCH_GROUP);
    expect(units).toEqual([
      ['ApexClass', 'CustomObject', 'Profile'],
      ['ApexTrigger'],
      ['Flow'],
    ]);
  });

  it('degenerates to per-type singletons with an empty group or a single member present', () => {
    const types = ['Profile', 'Flow'] as unknown as readonly ComponentType[];
    expect(toAtomicUnits(types, NO_GROUP)).toEqual([['Profile'], ['Flow']]);
    expect(toAtomicUnits(types, PROFILE_COBATCH_GROUP)).toEqual([['Profile'], ['Flow']]);
  });
});

describe('retrieveWithFallback profile co-batch invariant (the grantedBy regression)', () => {
  // A manifest where the naive midpoint split would separate Profile (last)
  // from CustomObject/ApexClass (first half) — the exact shape that shipped
  // profiles with zero fieldPermissions/objectPermissions/classAccesses.
  const COBATCH_TYPES = [
    'ApexClass',
    'ApexTrigger',
    'CustomObject',
    'Flow',
    'OmniScript',
    'Profile',
  ] as unknown as readonly ComponentType[];
  const groupMembersIn = (types: readonly ComponentType[]): readonly ComponentType[] =>
    types.filter((t) => PROFILE_COBATCH_GROUP.has(t));
  const presentMembers = groupMembersIn(COBATCH_TYPES); // ApexClass, CustomObject, Profile

  it('never attempts a batch that separates Profile from its co-listing partners while isolating a poison type', async () => {
    const bad = 'OmniScript' as ComponentType;
    const { fn, calls } = fakeRetriever(new Set([bad]), (t) => `INVALID_TYPE: ${t}`);
    const out = await retrieveWithFallback(COBATCH_TYPES, fn);
    // Every attempted batch carries ALL present group members or NONE — the
    // splitter can never divide the atomic unit.
    for (const batch of calls) {
      const members = groupMembersIn(batch);
      expect(
        members.length === 0 || members.length === presentMembers.length,
        `batch [${batch.join(', ')}] split the profile co-batch group`,
      ).toBe(true);
    }
    // The poison type is still isolated and everything else — including the
    // whole group — lands.
    expect(out.failures).toEqual([{ type: bad, error: 'INVALID_TYPE: OmniScript' }]);
    expect([...out.succeeded].sort()).toEqual(
      [...COBATCH_TYPES].filter((t) => t !== bad).sort(),
    );
  });

  it('drops the group WHOLE and DISCLOSED when it cannot land — never lands it bare', async () => {
    // Any batch containing Profile fails (e.g. the org rejects something the
    // group co-retrieves). The group must fail as one unit: every member in
    // `failures` (disclosed -> partial status upstream), none in `succeeded`.
    const fn = async (
      types: readonly ComponentType[],
    ): Promise<Result<{ readonly deletedCount: number }, string>> =>
      types.includes('Profile' as ComponentType)
        ? err('INVALID_TYPE: something in the co-batch')
        : ok({ deletedCount: types.length });
    const out = await retrieveWithFallback(COBATCH_TYPES, fn);
    expect(out.failures.map((f) => f.type).sort()).toEqual([...presentMembers].sort());
    for (const member of presentMembers) {
      expect(out.succeeded).not.toContain(member);
    }
    // Non-group types still land: a failing group yields a partial vault, not
    // an aborted refresh.
    expect([...out.succeeded].sort()).toEqual(
      COBATCH_TYPES.filter((t) => !PROFILE_COBATCH_GROUP.has(t)).sort(),
    );
  });

  it('keeps the group atomic through a load-induced timeout shrink instead of landing bare profiles', async () => {
    // Batches above 2 types time out. The legacy split would eventually land
    // Profile in a 1-2 type batch WITHOUT CustomObject/ApexClass — a "success"
    // that silently bares the profiles. The invariant instead drops the whole
    // 3-member group as a disclosed failure while the rest lands.
    const fn = async (
      types: readonly ComponentType[],
    ): Promise<Result<{ readonly deletedCount: number }, string>> =>
      types.length > 2 ? err('socket hang up') : ok({ deletedCount: types.length });
    const out = await retrieveWithFallback(COBATCH_TYPES, fn);
    expect([...out.succeeded].sort()).toEqual(
      COBATCH_TYPES.filter((t) => !PROFILE_COBATCH_GROUP.has(t)).sort(),
    );
    expect(out.failures.map((f) => f.type).sort()).toEqual([...presentMembers].sort());
  });
});

describe('summarizeRetrieveFailures', () => {
  it('is empty for no failures', () => {
    expect(summarizeRetrieveFailures([])).toBe('');
  });

  it('names the single failing type with its reason', () => {
    const f: RetrieveTypeFailure[] = [{ type: 'OmniScript' as ComponentType, error: 'INVALID_TYPE' }];
    expect(summarizeRetrieveFailures(f)).toBe('OmniScript: INVALID_TYPE');
  });

  it('states a shared cause once when many types fail for the same reason', () => {
    const reason = 'No authorization information found';
    const f: RetrieveTypeFailure[] = (['ApexClass', 'Flow'] as unknown as ComponentType[]).map(
      (type) => ({ type, error: reason }),
    );
    expect(summarizeRetrieveFailures(f)).toBe(reason);
  });

  it('lists per-type reasons when causes differ', () => {
    const f: RetrieveTypeFailure[] = [
      { type: 'OmniScript' as ComponentType, error: 'INVALID_TYPE' },
      { type: 'DecisionTable' as ComponentType, error: 'NOT_FOUND' },
    ];
    expect(summarizeRetrieveFailures(f)).toBe('OmniScript (INVALID_TYPE); DecisionTable (NOT_FOUND)');
  });

  it('collapses a multi-line sf error to its first line', () => {
    const f: RetrieveTypeFailure[] = [
      { type: 'Flow' as ComponentType, error: 'first line\nstack trace\nmore noise' },
    ];
    expect(summarizeRetrieveFailures(f)).toBe('Flow: first line');
  });

  it('surfaces the real sf error beneath the "Command failed" wrapper (the swallowed cause)', () => {
    const f: RetrieveTypeFailure[] = [
      {
        type: 'ApexClass' as ComponentType,
        error:
          'Command failed: sf project retrieve start --manifest /tmp/x.xml --target-org Foo\n' +
          'Error (UnsafeFilepathError): The filepath "../x.cls" contains unsafe character sequences',
      },
    ];
    expect(summarizeRetrieveFailures(f)).toBe(
      'ApexClass: Error (UnsafeFilepathError): The filepath "../x.cls" contains unsafe character sequences',
    );
  });
});

describe('formatRefreshSummary partial-retrieve block', () => {
  const baseResult = (
    over: Partial<RefreshResult>,
  ): RefreshResult => ({
    status: 'partial',
    counts: { components: {}, edges: {} },
    errors: [],
    durationMs: 12,
    skippedDirectories: {},
    ...over,
  });

  it('renders the skipped types and their first-line reason', () => {
    const summary = formatRefreshSummary(
      baseResult({
        retrieveFailures: [
          { type: 'OmniScript' as ComponentType, error: 'INVALID_TYPE: OmniScript\nnoise' },
        ],
      }),
    );
    expect(summary).toContain('Partial retrieve');
    expect(summary).toContain('OmniScript: INVALID_TYPE: OmniScript');
    expect(summary).not.toContain('noise');
  });

  it('omits the block entirely on a clean run', () => {
    const summary = formatRefreshSummary(baseResult({ status: 'success' }));
    expect(summary).not.toContain('Partial retrieve');
  });
});
