/// <reference types="vitest/globals" />

import type { ComponentType } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import {
  classifyRetrieveError,
  formatRefreshSummary,
  retrieveWithFallback,
  splitTypeBatch,
  summarizeRetrieveFailures,
  type RefreshResult,
  type RetrieveTypeFailure,
} from '../../src/commands/refresh.js';

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

  it('treats auth / network / project errors as global', () => {
    expect(classifyRetrieveError('No authorization information found for org')).toBe('global');
    expect(classifyRetrieveError('This directory does not contain a valid Salesforce DX project')).toBe('global');
    expect(classifyRetrieveError('getaddrinfo ENOTFOUND login.salesforce.com')).toBe('global');
    expect(classifyRetrieveError('expired access/refresh token')).toBe('global');
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

  it('returns all-failed when every type is independently bad', async () => {
    const { fn } = fakeRetriever(new Set(TYPES), (t) => `per-type breakage of ${t}`);
    const out = await retrieveWithFallback(TYPES, fn);
    expect(out.succeeded).toEqual([]);
    expect(out.failures.map((f) => f.type).sort()).toEqual([...TYPES].sort());
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
