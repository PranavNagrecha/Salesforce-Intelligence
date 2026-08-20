/// <reference types="vitest/globals" />

/**
 * PLATFORM-ACCESS-ORACLE — contract pins for the `UserEntityAccess` fetcher.
 *
 * Hermetic: a fake client, no org, no network. Fixtures use the REAL observed
 * flag combination from a live sandbox (`R=true C=false E=true D=false
 * Undel=true FLS=true`) rather than a tidy invention, because the whole point
 * of the oracle is that the platform's answer is the ground truth even when it
 * is surprising.
 *
 * The load-bearing pins:
 *  1. Every issued statement carries `LIMIT` and a bounded `IN (...)` — the
 *     unbounded form that trips `EXCEEDED_ID_LIMIT: does not support
 *     queryMore()` can never be built from this module.
 *  2. Chunking splits the object list into `IN (...)` batches under the cap.
 *  3. A requested object with no returned row is `missing` — "not answered",
 *     never "no access".
 *  4. A failed batch is recorded, its objects surface as unanswered, and the
 *     surviving batches' rows are still returned (never throws, never blanks).
 *  5. Caller-input faults fail LOUDLY before any SOQL is built.
 */

import { err, ok, type Result } from '@sf-intelligence/core';

import type { ToolingApiError } from '../src/client.js';
import {
  buildUserEntityAccessSoql,
  fetchUserEntityAccess,
  USER_ENTITY_ACCESS_MAX_OBJECTS,
  type UserEntityAccessClient,
  type UserEntityAccessRow,
} from '../src/user-entity-access.js';

/** Synthetic 18-char User id — shaped like a real one, belongs to no org. */
const USER_ID = '0050x0000000001AAA';

/**
 * The REAL observed shape from a live sandbox admin: readable + editable +
 * undeletable + FLS-updatable, but NOT creatable and NOT deletable. The flags
 * do not move together and nothing in the pipeline may "correct" that.
 */
const observedRow = (entity: string): Record<string, unknown> => ({
  EntityDefinitionId: entity,
  IsReadable: true,
  IsCreatable: false,
  IsEditable: true,
  IsDeletable: false,
  IsUndeletable: true,
  IsFlsUpdatable: true,
});

interface FakeClient {
  readonly client: UserEntityAccessClient;
  readonly queries: string[];
}

/**
 * A fake Tooling client. `handler` receives the SOQL and the object names it
 * filtered on, and returns either rows or an error — so a test can fail ONE
 * batch and leave the rest healthy.
 */
const fakeClient = (
  handler: (
    soql: string,
    objects: readonly string[],
    batchIndex: number,
  ) => Result<readonly Record<string, unknown>[], ToolingApiError>,
): FakeClient => {
  const queries: string[] = [];
  const client: UserEntityAccessClient = {
    query: async <T>(soql: string) => {
      const inClause = /IN \(([^)]*)\)/.exec(soql)?.[1] ?? '';
      const objects = inClause
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter((s) => s.length > 0);
      const batchIndex = queries.length;
      queries.push(soql);
      const r = handler(soql, objects, batchIndex);
      return r.ok
        ? ok(r.value as readonly T[])
        : err(r.error);
    },
  };
  return { client, queries };
};

/** Answer every requested object with the real observed flag combination. */
const answerAll = fakeClient((_soql, objects) =>
  ok(objects.map((o) => observedRow(o))),
);

describe('buildUserEntityAccessSoql — the queryMore-avoidance pin', () => {
  it('ALWAYS carries an explicit LIMIT and a bounded IN (...)', () => {
    const soql = buildUserEntityAccessSoql(USER_ID, ['Account', 'Contact'], 200);
    expect(soql).toMatch(/\bLIMIT 200$/);
    expect(soql).toContain("IN ('Account','Contact')");
    expect(soql).toContain('FROM UserEntityAccess');
    expect(soql).toContain(`WHERE UserId = '${USER_ID}'`);
  });

  it('selects EntityDefinitionId plus exactly the six access flags (no entity-capability columns)', () => {
    const soql = buildUserEntityAccessSoql(USER_ID, ['Account'], 200);
    for (const f of [
      'EntityDefinitionId',
      'IsReadable',
      'IsCreatable',
      'IsEditable',
      'IsDeletable',
      'IsUndeletable',
      'IsFlsUpdatable',
    ]) {
      expect(soql).toContain(f);
    }
    // IsMergeable / IsUpdatable / IsActivateable describe the ENTITY, not this
    // user's access — pulling them would invite a bogus IsUpdatable≈IsEditable
    // equivalence, so they are deliberately not selected.
    expect(soql).not.toContain('IsMergeable');
    expect(soql).not.toContain('IsUpdatable');
    expect(soql).not.toContain('IsActivateable');
  });

  it('escapes backslash before quote so a trailing backslash cannot break out of the literal', () => {
    const soql = buildUserEntityAccessSoql("abc\\'def", ['Account'], 50);
    expect(soql).toContain("'abc\\\\\\'def'");
  });
});

describe('fetchUserEntityAccess — targeted chunking', () => {
  it('splits the object list into IN(...) batches under the chunk size', async () => {
    const objects = Array.from({ length: 7 }, (_, i) => `Obj_${i}__c`);
    const fake = fakeClient((_s, o) => ok(o.map((x) => observedRow(x))));
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects,
      chunkSize: 3,
      limitPerBatch: 12,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 7 objects / 3 per batch = 3 batches (3 + 3 + 1).
    expect(r.value.batchCount).toBe(3);
    expect(fake.queries).toHaveLength(3);
    expect(r.value.rows).toHaveLength(7);
    expect(r.value.complete).toBe(true);
  });

  it('NEVER issues an unbounded query — every batch carries LIMIT and a bounded IN', async () => {
    const objects = Array.from({ length: 5 }, (_, i) => `Obj_${i}__c`);
    const fake = fakeClient((_s, o) => ok(o.map((x) => observedRow(x))));
    await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects,
      chunkSize: 2,
      limitPerBatch: 8,
    });
    expect(fake.queries.length).toBeGreaterThan(0);
    for (const soql of fake.queries) {
      expect(soql, `unbounded query issued: ${soql}`).toMatch(/\bLIMIT \d+$/);
      expect(soql, `unfiltered query issued: ${soql}`).toMatch(/EntityDefinitionId IN \('/);
      expect(soql).toMatch(/WHERE UserId = '/);
    }
  });

  it('de-duplicates object names case-insensitively (one query slot per object)', async () => {
    const fake = fakeClient((_s, o) => ok(o.map((x) => observedRow(x))));
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects: ['Account', 'account', 'ACCOUNT', 'Contact'],
      chunkSize: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.requested).toEqual(['Account', 'Contact']);
    expect(fake.queries).toHaveLength(1);
  });

  it('carries the real observed flag combination through unchanged (C/D false alongside R/E true)', async () => {
    const r = await fetchUserEntityAccess({
      client: answerAll.client,
      userId: USER_ID,
      objects: ['Account', 'Contact', 'Opportunity'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const account = r.value.rows.find((x) => x.EntityDefinitionId === 'Account');
    expect(account).toEqual<UserEntityAccessRow>({
      EntityDefinitionId: 'Account',
      IsReadable: true,
      IsCreatable: false,
      IsEditable: true,
      IsDeletable: false,
      IsUndeletable: true,
      IsFlsUpdatable: true,
    });
  });

  it('flags limitReached when a batch comes back exactly at its LIMIT (possible truncation)', async () => {
    // Two objects requested, LIMIT 2, and the org hands back two rows: the
    // read is indistinguishable from a cut one, so `complete` must be false.
    const fake = fakeClient((_s, o) => ok(o.map((x) => observedRow(x))));
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects: ['Account', 'Contact'],
      chunkSize: 2,
      limitPerBatch: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.limitReached).toBe(true);
    expect(r.value.complete).toBe(false);
  });
});

describe('fetchUserEntityAccess — missing rows are silence, not denial', () => {
  it('reports a requested object with NO returned row as `missing`, not as no-access', async () => {
    const fake = fakeClient((_s, objects) =>
      // The org answers for Account only; Contact and Ghost__c come back empty.
      ok(objects.filter((o) => o === 'Account').map((o) => observedRow(o))),
    );
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects: ['Account', 'Contact', 'Ghost__c'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.missing).toEqual(['Contact', 'Ghost__c']);
    expect(r.value.rows).toHaveLength(1);
    expect(r.value.complete).toBe(false);
    // There is NO row asserting false flags for the unanswered objects — the
    // fetcher never synthesises a denial to fill a gap.
    expect(r.value.rows.map((x) => x.EntityDefinitionId)).toEqual(['Account']);
  });

  it('matches the platform echoing a different casing (a casing shift is not a missing row)', async () => {
    const fake = fakeClient(() => ok([observedRow('Account')]));
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects: ['account'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.missing).toEqual([]);
  });
});

describe('fetchUserEntityAccess — partial failure never throws and never blanks', () => {
  it('records the failed batch, keeps the healthy batch, and marks its objects unanswered', async () => {
    const fake = fakeClient((_s, objects, batchIndex) =>
      batchIndex === 1
        ? err({
            kind: 'query-failed',
            message: 'Tooling API returned 400.',
            status: 400,
          })
        : ok(objects.map((o) => observedRow(o))),
    );
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects: ['Account', 'Contact', 'Opportunity', 'Lead'],
      chunkSize: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Batch 0 (Account, Contact) survived; batch 1 (Opportunity, Lead) failed.
    expect(r.value.rows.map((x) => x.EntityDefinitionId)).toEqual(['Account', 'Contact']);
    expect(r.value.failures).toHaveLength(1);
    expect(r.value.failures[0]?.batchIndex).toBe(1);
    expect(r.value.failures[0]?.kind).toBe('query-failed');
    expect(r.value.failures[0]?.objects).toEqual(['Opportunity', 'Lead']);
    // The failed batch's objects are unanswered — NOT reported as denied.
    expect(r.value.missing).toEqual(['Opportunity', 'Lead']);
    expect(r.value.complete).toBe(false);
    // Still two queries issued: a failure does not abort the remaining work.
    expect(fake.queries).toHaveLength(2);
  });

  it('a total failure returns an ok Result with zero rows and every object unanswered', async () => {
    const fake = fakeClient(() =>
      err({ kind: 'auth-expired', message: '401', status: 401 }),
    );
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects: ['Account', 'Contact'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rows).toEqual([]);
    expect(r.value.missing).toEqual(['Account', 'Contact']);
    expect(r.value.failures[0]?.kind).toBe('auth-expired');
  });
});

describe('fetchUserEntityAccess — caller-input faults fail loudly BEFORE any SOQL', () => {
  it('rejects a non-Id user reference (UserEntityAccess has no name-based filter)', async () => {
    const fake = fakeClient(() => ok([]));
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: 'jane.doe@example.test',
      objects: ['Account'],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-user-id');
    expect(fake.queries).toHaveLength(0);
  });

  it('rejects a malformed object name instead of building a filter from it', async () => {
    const fake = fakeClient(() => ok([]));
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects: ["Account' OR Id != null--"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-object-name');
    expect(fake.queries).toHaveLength(0);
  });

  it('refuses an empty object list — there is no "all objects" mode', async () => {
    const fake = fakeClient(() => ok([]));
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('no-objects');
    expect(r.error.message).toMatch(/queryMore/i);
    expect(fake.queries).toHaveLength(0);
  });

  it('refuses an over-cap request rather than silently truncating it', async () => {
    const fake = fakeClient(() => ok([]));
    const objects = Array.from(
      { length: USER_ENTITY_ACCESS_MAX_OBJECTS + 1 },
      (_, i) => `Obj_${i}__c`,
    );
    const r = await fetchUserEntityAccess({
      client: fake.client,
      userId: USER_ID,
      objects,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('too-many-objects');
    expect(fake.queries).toHaveLength(0);
  });
});
