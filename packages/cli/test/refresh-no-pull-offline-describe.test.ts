/// <reference types="vitest/globals" />
/**
 * WOW-12 — FAIL-BEFORE/PASS-AFTER: `sfi refresh --no-pull` still ran
 * `sf sobject describe --target-org <alias>` once per core standard object,
 * so an "offline" rebuild contacted the org. Now an offline run never calls
 * sf: it replays the snapshot the last live describe cached, and discloses
 * the objects that had none.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok } from '@sf-intelligence/core';

import { appendStandardObjectDescribeFields } from '../src/commands/refresh.js';

type Walked = Parameters<typeof appendStandardObjectDescribeFields>[1];

const walkedWithAccount = (): Walked =>
  ({
    results: [
      {
        nodes: [{ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account', label: 'Account' }],
        edges: [],
      },
    ],
    failures: [],
  }) as unknown as Walked;

const describePayload = {
  result: { fields: [{ name: 'Rating', label: 'Rating', type: 'picklist', custom: false, nillable: true }] },
};

describe('standard-field describe under --no-pull (WOW-12)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-describe-cache-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('offline run never calls sf, and discloses objects with no cached snapshot', async () => {
    const runSf = vi.fn();
    const { summary } = await appendStandardObjectDescribeFields('some-alias', walkedWithAccount(), () => {}, {
      live: false,
      cacheDir: dir,
      runSf,
    });
    expect(runSf).not.toHaveBeenCalled();
    expect(summary).toEqual({ fromLive: [], fromCache: [], skipped: ['Account'], offline: true });
  });

  it('a live run caches the describe, and a later offline run replays it with no org contact', async () => {
    const runSf = vi.fn(async () => ok(describePayload));
    const live = await appendStandardObjectDescribeFields('some-alias', walkedWithAccount(), () => {}, {
      live: true,
      cacheDir: dir,
      runSf: runSf as never,
    });
    expect(runSf).toHaveBeenCalledTimes(1);
    expect(live.summary.fromLive).toEqual(['Account']);

    const offlineSf = vi.fn();
    const offline = await appendStandardObjectDescribeFields('some-alias', walkedWithAccount(), () => {}, {
      live: false,
      cacheDir: dir,
      runSf: offlineSf,
    });
    expect(offlineSf).not.toHaveBeenCalled();
    expect(offline.summary.fromCache).toEqual(['Account']);
    const ids = offline.walked.results.flatMap((r) => r.nodes.map((n) => n.id));
    expect(ids).toContain('CustomField:Account.Rating');
  });
});
