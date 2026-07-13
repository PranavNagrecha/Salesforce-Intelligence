/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSetupAuditTrailSoql,
  normalizeSetupAuditTrailRecord,
  parseSetupAuditTrailJsonl,
  persistSetupAuditTrail,
  selectNewSetupAuditTrailRows,
  SETUP_AUDIT_TRAIL_FILENAME,
  SETUP_AUDIT_TRAIL_RETENTION_DAYS,
  type SetupAuditTrailRow,
} from '../src/setup-audit-trail.js';

/**
 * #39 — SetupAuditTrail persistence: SOQL shape, dedupe-by-Id, append-only
 * JSONL. Injectable SOQL — no live org.
 */

const row = (
  overrides: Partial<SetupAuditTrailRow> & Pick<SetupAuditTrailRow, 'id' | 'createdDate'>,
): SetupAuditTrailRow => ({
  action: 'changedApexClass',
  section: 'Apex Class',
  display: 'Changed Apex Class AlphaController',
  createdByName: 'Fixture Admin',
  capturedAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

describe('buildSetupAuditTrailSoql', () => {
  it('uses LAST_N_DAYS:180 on first run (empty store)', () => {
    const q = buildSetupAuditTrailSoql([]);
    expect(q).toContain(`LAST_N_DAYS:${SETUP_AUDIT_TRAIL_RETENTION_DAYS}`);
    expect(q).toContain('FROM SetupAuditTrail');
    expect(q).toContain('CreatedBy.Name');
    expect(q).toContain('ORDER BY CreatedDate ASC');
  });

  it('watermarks subsequent runs at max persisted CreatedDate', () => {
    const q = buildSetupAuditTrailSoql([
      row({ id: 'a', createdDate: '2026-06-01T10:00:00.000Z' }),
      row({ id: 'b', createdDate: '2026-06-15T12:00:00.000Z' }),
      row({ id: 'c', createdDate: '2026-06-10T08:00:00.000Z' }),
    ]);
    expect(q).toContain('CreatedDate > 2026-06-15T12:00:00.000Z');
    expect(q).not.toContain('LAST_N_DAYS');
  });
});

describe('parseSetupAuditTrailJsonl + selectNewSetupAuditTrailRows', () => {
  it('skips corrupt lines and dedupes by id (first wins)', () => {
    const raw = [
      JSON.stringify(row({ id: '0Axxx0000001', createdDate: '2026-06-01T00:00:00.000Z' })),
      'NOT-JSON',
      JSON.stringify(row({ id: '0Axxx0000001', createdDate: '2026-06-02T00:00:00.000Z', action: 'dup' })),
      JSON.stringify(row({ id: '0Axxx0000002', createdDate: '2026-06-03T00:00:00.000Z' })),
      '',
    ].join('\n');
    const parsed = parseSetupAuditTrailJsonl(raw);
    expect(parsed.map((r) => r.id)).toEqual(['0Axxx0000001', '0Axxx0000002']);
    expect(parsed[0]?.action).toBe('changedApexClass');
  });

  it('selects only unseen Ids', () => {
    const existing = [row({ id: 'keep', createdDate: '2026-06-01T00:00:00.000Z' })];
    const queried = [
      row({ id: 'keep', createdDate: '2026-06-01T00:00:00.000Z' }),
      row({ id: 'new1', createdDate: '2026-06-02T00:00:00.000Z' }),
    ];
    const { appended, skippedDuplicate } = selectNewSetupAuditTrailRows(existing, queried);
    expect(appended.map((r) => r.id)).toEqual(['new1']);
    expect(skippedDuplicate).toBe(1);
  });
});

describe('normalizeSetupAuditTrailRecord', () => {
  it('maps CreatedBy.Name and null Section/Display', () => {
    const n = normalizeSetupAuditTrailRecord(
      {
        Id: '0Axxx0000009',
        Action: 'changedValidationRule',
        Section: null,
        CreatedDate: '2026-06-20T00:00:00.000Z',
        Display: null,
        CreatedBy: { Name: 'Fixture Admin' },
      },
      '2026-07-12T00:00:00.000Z',
    );
    expect(n).toEqual({
      id: '0Axxx0000009',
      action: 'changedValidationRule',
      section: null,
      createdDate: '2026-06-20T00:00:00.000Z',
      display: null,
      createdByName: 'Fixture Admin',
      capturedAt: '2026-07-12T00:00:00.000Z',
    });
  });

  it('returns null when Id or CreatedDate is missing', () => {
    expect(
      normalizeSetupAuditTrailRecord(
        { Action: 'x', CreatedDate: '2026-06-01T00:00:00.000Z' },
        '2026-07-12T00:00:00.000Z',
      ),
    ).toBeNull();
  });
});

describe('persistSetupAuditTrail', () => {
  it('appends only new rows and is idempotent on re-query of the same Ids', async () => {
    const metaDir = await mkdtemp(join(tmpdir(), 'sfi-audit-trail-'));
    try {
      const records = [
        {
          Id: '0Axxx0000001',
          Action: 'changedApexClass',
          Section: 'Apex Class',
          CreatedDate: '2026-06-01T10:00:00.000Z',
          Display: 'Changed Apex Class AlphaController',
          CreatedBy: { Name: 'Fixture Admin' },
        },
        {
          Id: '0Axxx0000002',
          Action: 'changedValidation',
          Section: 'Validation Rules',
          CreatedDate: '2026-06-02T11:00:00.000Z',
          Display: 'Changed validation rule Status_Required on Account',
          CreatedBy: { Name: 'Fixture Admin' },
        },
      ];
      let calls = 0;
      const soql = async () => {
        calls += 1;
        return records;
      };

      const first = await persistSetupAuditTrail({
        metaDir,
        soql,
        now: () => '2026-07-12T12:00:00.000Z',
      });
      expect(first.outcome).toBe('ok');
      expect(first.appended).toBe(2);
      expect(first.totalPersisted).toBe(2);

      // Second call: SOQL returns the same Ids (watermark edge) → 0 appended.
      const second = await persistSetupAuditTrail({
        metaDir,
        soql,
        now: () => '2026-07-12T13:00:00.000Z',
      });
      expect(second.outcome).toBe('ok');
      expect(second.appended).toBe(0);
      expect(second.skippedDuplicate).toBe(2);
      expect(second.totalPersisted).toBe(2);
      expect(calls).toBe(2);

      const raw = await readFile(join(metaDir, SETUP_AUDIT_TRAIL_FILENAME), 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);
      // No real org aliases / customer names in the fixture payload: guard
      // against a real user email / org domain leaking into the parsed output.
      expect(raw).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
    } finally {
      await rm(metaDir, { recursive: true, force: true });
    }
  });

  it('surfaces query failures without throwing', async () => {
    const metaDir = await mkdtemp(join(tmpdir(), 'sfi-audit-trail-fail-'));
    try {
      await mkdir(metaDir, { recursive: true });
      const summary = await persistSetupAuditTrail({
        metaDir,
        soql: async () => {
          throw new Error('synthetic soql failure');
        },
      });
      expect(summary.outcome).toBe('query-failed');
      expect(summary.message).toContain('synthetic soql failure');
      expect(summary.appended).toBe(0);
    } finally {
      await rm(metaDir, { recursive: true, force: true });
    }
  });

  it('writes nothing when SOQL returns an empty set on first run', async () => {
    const metaDir = await mkdtemp(join(tmpdir(), 'sfi-audit-trail-empty-'));
    try {
      const summary = await persistSetupAuditTrail({
        metaDir,
        soql: async () => [],
      });
      expect(summary.outcome).toBe('ok');
      expect(summary.appended).toBe(0);
      await expect(
        readFile(join(metaDir, SETUP_AUDIT_TRAIL_FILENAME), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(metaDir, { recursive: true, force: true });
    }
  });

  it('loads a pre-seeded JSONL and appends only unseen Ids', async () => {
    const metaDir = await mkdtemp(join(tmpdir(), 'sfi-audit-trail-seed-'));
    try {
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        join(metaDir, SETUP_AUDIT_TRAIL_FILENAME),
        `${JSON.stringify(row({ id: '0Axxx0000001', createdDate: '2026-06-01T00:00:00.000Z' }))}\n`,
        'utf8',
      );
      const summary = await persistSetupAuditTrail({
        metaDir,
        soql: async (query) => {
          expect(query).toContain('CreatedDate > 2026-06-01T00:00:00.000Z');
          return [
            {
              Id: '0Axxx0000001',
              Action: 'dup',
              Section: 'Apex Class',
              CreatedDate: '2026-06-01T00:00:00.000Z',
              Display: 'dup',
              CreatedBy: { Name: 'Fixture Admin' },
            },
            {
              Id: '0Axxx0000003',
              Action: 'changedFlow',
              Section: 'Flows',
              CreatedDate: '2026-06-05T00:00:00.000Z',
              Display: 'Changed flow Lead_Nurture',
              CreatedBy: { Name: 'Fixture Admin' },
            },
          ];
        },
        now: () => '2026-07-12T14:00:00.000Z',
      });
      expect(summary.appended).toBe(1);
      expect(summary.skippedDuplicate).toBe(1);
      expect(summary.totalPersisted).toBe(2);
    } finally {
      await rm(metaDir, { recursive: true, force: true });
    }
  });
});
