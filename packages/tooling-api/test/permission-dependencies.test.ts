/// <reference types="vitest/globals" />

/**
 * Hermetic coverage for the PermissionDependency ingest. No org, no
 * network — the `ToolingApiClient` is stubbed the same way
 * `enrich-dependencies.test.ts` stubs it, and every name is either
 * synthetic or a STANDARD Salesforce platform permission (platform
 * vocabulary, never org-specific identifiers).
 *
 * The centrepiece is the "real wire shape" block, which reproduces the
 * behaviour measured against a live org and which is the test that catches
 * the raw-vs-distinct class of bug in both directions:
 *
 *   - `LIMIT` is SILENTLY IGNORED on this virtual object.
 *   - `WHERE Id > 'x'` and `ORDER BY Id ASC` ARE honoured.
 *   - The cursor RE-SERVES: ~2,000 distinct rows per batch, repeated ~5x,
 *     up to a 10,000-RECORD response cap, with `totalSize` disagreeing
 *     with the records array by design.
 *
 * Under that shape a raw record count runs ~5x the edge count. Reporting
 * raw as the headline overstates the graph 5x; testing a ceiling against
 * distinct understates truncation. Both are asserted against here.
 */

import { err, ok, type Result } from '@sf-intelligence/core';

import type { ToolingApiClient, ToolingApiError } from '../src/client.js';
import {
  fetchPermissionDependencies,
  PERMISSION_DEPENDENCY_RAW_RECORD_CAP,
  type PermissionDependencyRow,
} from '../src/permission-dependencies.js';

/** The platform's measured type labels — the space is part of the value. */
const USER_T = 'User Permission';
const OBJECT_T = 'Object Permission';

const row = (
  id: string,
  permission: string,
  requiredPermission: string,
  overrides: Partial<PermissionDependencyRow> = {},
): PermissionDependencyRow => ({
  Id: id,
  Permission: permission,
  PermissionType: USER_T,
  RequiredPermission: requiredPermission,
  RequiredPermissionType: USER_T,
  ...overrides,
});

/**
 * Queue one canned response per `query` call. `calls` records the SOQL so
 * a test can assert the keyset cursor actually advanced.
 */
const stubClient = (
  responses: ReadonlyArray<Result<readonly PermissionDependencyRow[], ToolingApiError>>,
): { readonly client: ToolingApiClient; readonly calls: string[] } => {
  const calls: string[] = [];
  let i = 0;
  const client: ToolingApiClient = {
    query: async <T>(soql: string) => {
      calls.push(soql);
      const r = responses[i++];
      if (r === undefined) {
        throw new Error(`stubClient: no response queued for query call ${i}`);
      }
      return r as Result<readonly T[], ToolingApiError>;
    },
    getDependencies: async () => ok([]),
  };
  return { client, calls };
};

const NO_THROTTLE = { rateLimitPauseMs: 0 } as const;

/** Terminating response: the walk stops only on an EMPTY batch. */
const END = ok([] as readonly PermissionDependencyRow[]);

describe('fetchPermissionDependencies — keyset walk', () => {
  it('returns a complete, sorted, semantically deduped graph', async () => {
    const { client, calls } = stubClient([
      ok([
        row('pd03', 'EmailMass', 'EmailSingle'),
        row('pd01', 'ManageUsers', 'ResetPasswords'),
        // Same logical edge under a different Id — Id-level dedup would
        // keep this and leave a duplicate logical edge behind.
        row('pd02', 'ManageUsers', 'ResetPasswords'),
      ]),
      END,
    ]);
    const r = await fetchPermissionDependencies({ client, pageSize: 10, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncated).toBe(false);
    expect(r.value.truncationReason).toBeUndefined();
    expect(r.value.strategy).toBe('keyset');
    expect(r.value.rawRowsReceived).toBe(3);
    expect(r.value.duplicateRowsDropped).toBe(1);
    expect(r.value.edges.map((e) => `${e.permission}->${e.requiredPermission}`)).toEqual([
      'EmailMass->EmailSingle',
      'ManageUsers->ResetPasswords',
    ]);
    expect(calls[0]).toContain('ORDER BY Id ASC');
    expect(calls[0]).not.toContain('WHERE');
  });

  it('advances the keyset cursor and terminates on an EMPTY batch, not a short one', async () => {
    const { client, calls } = stubClient([
      ok([row('pd01', 'A', 'B'), row('pd02', 'C', 'D')]),
      // SHORT batch — under a size heuristic this would have ended the walk
      // and silently dropped everything past it.
      ok([row('pd03', 'E', 'F')]),
      ok([row('pd04', 'G', 'H')]),
      END,
    ]);
    const r = await fetchPermissionDependencies({ client, pageSize: 2, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncated).toBe(false);
    expect(r.value.pagesFetched).toBe(4);
    expect(r.value.edges).toHaveLength(4);
    expect(calls[1]).toContain("WHERE Id > 'pd02'");
    expect(calls[2]).toContain("WHERE Id > 'pd03'");
    expect(calls[3]).toContain("WHERE Id > 'pd04'");
  });

  it('marks TRUNCATED when the page budget is exhausted rather than claiming a whole graph', async () => {
    const { client } = stubClient([
      ok([row('pd01', 'A', 'B'), row('pd02', 'C', 'D')]),
      ok([row('pd03', 'E', 'F'), row('pd04', 'G', 'H')]),
    ]);
    const r = await fetchPermissionDependencies({
      client,
      pageSize: 2,
      maxPages: 2,
      ...NO_THROTTLE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncated).toBe(true);
    expect(r.value.truncationReason).toContain('page budget exhausted');
    expect(r.value.edges).toHaveLength(4);
  });

  it('keeps banked pages and discloses when the walk fails MID-way', async () => {
    const { client } = stubClient([
      ok([row('pd01', 'A', 'B'), row('pd02', 'C', 'D')]),
      err({ kind: 'rate-limit', message: 'Tooling API returned 429.' }),
    ]);
    const r = await fetchPermissionDependencies({ client, pageSize: 2, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncated).toBe(true);
    expect(r.value.truncationReason).toContain('rate-limit');
    expect(r.value.edges).toHaveLength(2);
  });

  it('stops (truncated) rather than looping when the cursor cannot advance', async () => {
    // Both batches end on the SAME max id — a server that ignored the WHERE
    // would otherwise re-serve batch 1 forever.
    const { client } = stubClient([
      ok([row('pd01', 'A', 'B'), row('pd09', 'C', 'D')]),
      ok([row('pd01', 'A', 'B'), row('pd09', 'C', 'D')]),
    ]);
    const r = await fetchPermissionDependencies({ client, pageSize: 2, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncated).toBe(true);
    expect(r.value.truncationReason).toContain('could not advance');
  });

  it('propagates a non-recoverable FIRST-page failure instead of falling back', async () => {
    const { client, calls } = stubClient([
      err({ kind: 'auth-expired', message: 'token expired' }),
    ]);
    const r = await fetchPermissionDependencies({ client, ...NO_THROTTLE });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('auth-expired');
    expect(calls).toHaveLength(1);
  });
});

/**
 * The measured live shape. A server that ignores LIMIT, honours the keyset
 * cursor, and re-serves each batch until it hits the record cap.
 */
const realWireClient = (
  totalDistinct: number,
  batchDistinct: number,
  reserves: number,
): { readonly client: ToolingApiClient; readonly calls: string[] } => {
  // Zero-padded so lexicographic order matches numeric order, exactly as
  // real Salesforce ids sort under `ORDER BY Id ASC`.
  const ids = Array.from({ length: totalDistinct }, (_, i) => `PD${String(i).padStart(6, '0')}`);
  const calls: string[] = [];
  const client: ToolingApiClient = {
    query: async <T>(soql: string) => {
      calls.push(soql);
      const m = /WHERE Id > '([^']*)'/.exec(soql);
      const after = m?.[1] ?? '';
      // LIMIT in the SOQL is deliberately IGNORED — the whole point.
      const window = ids.filter((id) => id > after).slice(0, batchDistinct);
      const records: PermissionDependencyRow[] = [];
      for (let rep = 0; rep < reserves; rep++) {
        for (const id of window) {
          const n = Number(id.slice(2));
          records.push(row(id, `Perm${n}`, `Required${n}`));
        }
      }
      return ok(records) as Result<readonly T[], ToolingApiError>;
    },
    getDependencies: async () => ok([]),
  };
  return { client, calls };
};

describe('fetchPermissionDependencies — real wire shape (LIMIT ignored, cursor re-serves)', () => {
  // 9,346 distinct rows, served 2,000 at a time, each batch repeated 5x —
  // the shape measured on a live org.
  const TOTAL = 9346;
  const BATCH = 2000;
  const RESERVES = 5;

  it('captures the WHOLE graph and does NOT report it truncated', async () => {
    const { client, calls } = realWireClient(TOTAL, BATCH, RESERVES);
    const r = await fetchPermissionDependencies({ client, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The capture is COMPLETE — a false truncation warning here would train
    // users to ignore the disclosure that exists to be trusted.
    expect(r.value.truncated).toBe(false);
    expect(r.value.truncationReason).toBeUndefined();
    expect(r.value.strategy).toBe('keyset');
    // 5 full-ish pages plus the terminating empty one.
    expect(calls).toHaveLength(6);
    expect(calls[calls.length - 1]).toContain("WHERE Id > 'PD009345'");
  });

  it('reports DISTINCT edges as the headline, never the ~5x raw wire count', async () => {
    const { client } = realWireClient(TOTAL, BATCH, RESERVES);
    const r = await fetchPermissionDependencies({ client, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The number that means "how much of the graph we have".
    expect(r.value.edges).toHaveLength(TOTAL);
    // The wire count: 4 full batches of 10,000 + a final 1,346 x 5.
    const expectedRaw = 4 * BATCH * RESERVES + (TOTAL - 4 * BATCH) * RESERVES;
    expect(r.value.rawRowsReceived).toBe(expectedRaw);
    expect(expectedRaw).toBe(46_730);
    // Raw is ~5x the edge count — the whole reason they must stay separate.
    expect(r.value.rawRowsReceived / r.value.edges.length).toBeCloseTo(RESERVES, 5);
    expect(r.value.duplicateRowsDropped).toBe(expectedRaw - TOTAL);
  });

  it('a per-batch raw count ABOVE the record cap does not make a complete walk truncated', async () => {
    const { client } = realWireClient(TOTAL, BATCH, RESERVES);
    const r = await fetchPermissionDependencies({ client, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Each of the first four batches carries 10,000 raw records — at the
    // cap — yet the keyset walk steps past it and the result is complete.
    expect(BATCH * RESERVES).toBe(PERMISSION_DEPENDENCY_RAW_RECORD_CAP);
    expect(r.value.truncated).toBe(false);
  });
});

describe('fetchPermissionDependencies — degraded single-query fallback', () => {
  it('falls back to the un-paged query when the org rejects the keyset SOQL', async () => {
    const { client, calls } = stubClient([
      err({ kind: 'query-failed', message: 'MALFORMED_QUERY: Id is not sortable' }),
      ok([row('pd01', 'ExportReport', 'RunReports')]),
    ]);
    const r = await fetchPermissionDependencies({ client, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.strategy).toBe('single');
    expect(r.value.truncated).toBe(false);
    expect(r.value.edges).toHaveLength(1);
    expect(calls[1]).not.toContain('ORDER BY');
  });

  it('DETECTS the 10,000-RECORD response cap and refuses to call it complete', async () => {
    const capped: PermissionDependencyRow[] = [];
    for (let i = 0; i < PERMISSION_DEPENDENCY_RAW_RECORD_CAP; i++) {
      capped.push(row(`pd${i}`, `Perm${i}`, `Required${i}`));
    }
    const { client } = stubClient([
      err({ kind: 'query-failed', message: 'MALFORMED_QUERY' }),
      ok(capped),
    ]);
    const r = await fetchPermissionDependencies({ client, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rawRowsReceived).toBe(PERMISSION_DEPENDENCY_RAW_RECORD_CAP);
    expect(r.value.truncated).toBe(true);
    expect(r.value.truncationReason).toContain('CAPPED response');
  });

  // The measured un-paged response held 10,000 records / ~2,000 distinct
  // against a ~9.3k-row object: about a fifth of the graph. Distinct-based
  // ceiling detection would have called that COMPLETE.
  it('refuses to claim completeness when the un-paged response re-served its cursor', async () => {
    const duplicated: PermissionDependencyRow[] = [];
    for (let rep = 0; rep < 5; rep++) {
      for (let i = 0; i < 400; i++) {
        duplicated.push(row(`pd${i}`, `Perm${i}`, `Required${i}`));
      }
    }
    const { client } = stubClient([
      err({ kind: 'query-failed', message: 'MALFORMED_QUERY' }),
      ok(duplicated),
    ]);
    const r = await fetchPermissionDependencies({ client, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Raw (2,000) is well BELOW the 10,000 cap and distinct (400) is far
    // below it — only the duplicate signal catches this.
    expect(r.value.rawRowsReceived).toBe(2000);
    expect(r.value.edges).toHaveLength(400);
    expect(r.value.truncated).toBe(true);
    expect(r.value.truncationReason).toContain('re-served its cursor');
  });

  it('errors when BOTH strategies fail', async () => {
    const { client } = stubClient([
      err({ kind: 'query-failed', message: 'MALFORMED_QUERY' }),
      err({ kind: 'query-failed', message: 'INVALID_TYPE: PermissionDependency' }),
    ]);
    const r = await fetchPermissionDependencies({ client, ...NO_THROTTLE });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('INVALID_TYPE');
  });
});

describe('fetchPermissionDependencies — row hygiene and type transport', () => {
  it('drops (and counts) rows missing either endpoint instead of emitting an edge to nowhere', async () => {
    const { client } = stubClient([
      ok([
        row('pd01', 'ManageUsers', 'ViewAllUsers'),
        row('pd02', '', 'ViewAllUsers'),
        row('pd03', 'ManageUsers', ''),
      ]),
      END,
    ]);
    const r = await fetchPermissionDependencies({ client, pageSize: 10, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rawRowsReceived).toBe(3);
    expect(r.value.malformedRowsDropped).toBe(2);
    expect(r.value.edges).toHaveLength(1);
  });

  it('carries the platform type labels and angle-bracket names through VERBATIM', async () => {
    // Real observed row: a USER permission whose requirement is OBJECT-level.
    const { client } = stubClient([
      ok([
        row('pd01', 'ImportPersonal', 'Account<create>', {
          RequiredPermissionType: OBJECT_T,
        }),
        row('pd02', 'PaymentLineInvoice<viewAllRecords>', 'Invoice<viewAllRecords>', {
          PermissionType: OBJECT_T,
          RequiredPermissionType: OBJECT_T,
        }),
      ]),
      END,
    ]);
    const r = await fetchPermissionDependencies({ client, pageSize: 10, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.edges[0]).toEqual({
      permission: 'ImportPersonal',
      permissionType: 'User Permission',
      requiredPermission: 'Account<create>',
      requiredPermissionType: 'Object Permission',
    });
    expect(r.value.edges[1]?.permissionType).toBe('Object Permission');
  });

  it('folds on the SEMANTIC tuple, so the same pair under conflicting types is kept and counted', async () => {
    const { client } = stubClient([
      ok([
        row('pd01', 'ImportPersonal', 'Account<create>', { RequiredPermissionType: OBJECT_T }),
        // Same logical pair, contradictory type label, different Id.
        row('pd02', 'ImportPersonal', 'Account<create>', { RequiredPermissionType: USER_T }),
        // Exact semantic duplicate of the first — collapses.
        row('pd03', 'ImportPersonal', 'Account<create>', { RequiredPermissionType: OBJECT_T }),
      ]),
      END,
    ]);
    const r = await fetchPermissionDependencies({ client, pageSize: 10, ...NO_THROTTLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.duplicateRowsDropped).toBe(1);
    expect(r.value.edges).toHaveLength(2);
    expect(r.value.conflictingTypeRows).toBe(1);
  });
});
