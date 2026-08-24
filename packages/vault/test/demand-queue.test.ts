/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendDemandHit,
  appendDrainResult,
  demandQueuePath,
  queuedDrainIds,
  readDemandQueue,
} from '../src/demand-queue.js';

/**
 * P13-STAGED-demand-queue — fold semantics of the append-only event log:
 * dedup (N hits → one entry), drain outcomes, re-queue on a post-drain hit,
 * corrupt-line tolerance, and the drain-id selection rule.
 */

let vaultRoot: string;

beforeEach(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), 'sfi-demand-queue-'));
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe('readDemandQueue fold', () => {
  it('absent file reads as an empty queue', async () => {
    expect(await readDemandQueue(vaultRoot)).toEqual([]);
  });

  it('dedups N hits on one id into a single queued entry with hits=N', async () => {
    await appendDemandHit(vaultRoot, 'CustomObject:Acme__c', 'automation-critical', 'get_component');
    await appendDemandHit(vaultRoot, 'CustomObject:Acme__c', 'automation-critical', 'get_component');
    await appendDemandHit(vaultRoot, 'CustomObject:Acme__c', 'automation-critical', 'watch');
    const q = await readDemandQueue(vaultRoot);
    expect(q.length).toBe(1);
    const e = q[0];
    expect(e?.id).toBe('CustomObject:Acme__c');
    expect(e?.status).toBe('queued');
    expect(e?.hits).toBe(3);
    expect(e?.sources).toEqual(['get_component', 'watch']);
    expect(e?.firstHitAt && e?.lastHitAt && e.firstHitAt <= e.lastHitAt).toBe(true);
  });

  it('a drain marks the entry with its outcome; refused keeps the reason', async () => {
    await appendDemandHit(vaultRoot, 'CustomObject:A__c', 'automation-critical', 't');
    await appendDemandHit(vaultRoot, 'CustomObject:B__c', 'automation-critical', 't');
    await appendDemandHit(vaultRoot, 'CustomObject:C__c', 'grant-only', 't');
    await appendDrainResult(vaultRoot, 'CustomObject:A__c', 'retrieved');
    await appendDrainResult(vaultRoot, 'CustomObject:B__c', 'already-present');
    await appendDrainResult(vaultRoot, 'CustomObject:C__c', 'refused', 'grant-only — not worth retrieving');
    const q = await readDemandQueue(vaultRoot);
    const byId = new Map(q.map((e) => [e.id, e]));
    expect(byId.get('CustomObject:A__c')?.status).toBe('drained');
    expect(byId.get('CustomObject:A__c')?.drainOutcome).toBe('retrieved');
    expect(byId.get('CustomObject:B__c')?.status).toBe('drained');
    expect(byId.get('CustomObject:C__c')?.status).toBe('refused');
    expect(byId.get('CustomObject:C__c')?.drainReason).toContain('grant-only');
  });

  it('a NEW hit after a drain re-queues the id (the org re-referenced it)', async () => {
    await appendDemandHit(vaultRoot, 'CustomObject:X__c', 'automation-critical', 't');
    await appendDrainResult(vaultRoot, 'CustomObject:X__c', 'retrieved');
    await appendDemandHit(vaultRoot, 'CustomObject:X__c', 'automation-critical', 't');
    const q = await readDemandQueue(vaultRoot);
    expect(q[0]?.status).toBe('queued');
    expect(q[0]?.hits).toBe(2);
  });

  it('a second drain of an already-drained id is a material no-op (idempotent)', async () => {
    await appendDemandHit(vaultRoot, 'CustomObject:X__c', 'automation-critical', 't');
    await appendDrainResult(vaultRoot, 'CustomObject:X__c', 'retrieved');
    const before = await readDemandQueue(vaultRoot);
    await appendDrainResult(vaultRoot, 'CustomObject:X__c', 'already-present');
    const after = await readDemandQueue(vaultRoot);
    expect(after[0]?.status).toBe('drained');
    expect(after[0]?.hits).toBe(before[0]?.hits);
  });

  it('skips corrupt lines and drains for ids never hit', async () => {
    mkdirSync(join(vaultRoot, 'meta'), { recursive: true });
    writeFileSync(
      demandQueuePath(vaultRoot),
      [
        '{not json',
        JSON.stringify({ kind: 'drain', id: 'CustomObject:NeverHit__c', at: 'x', outcome: 'retrieved' }),
        JSON.stringify({ kind: 'hit', id: 'CustomObject:Real__c', at: '2026-06-10T00:00:00Z', classification: 'automation-critical', source: 't' }),
        '',
      ].join('\n'),
      'utf8',
    );
    const q = await readDemandQueue(vaultRoot);
    expect(q.length).toBe(1);
    expect(q[0]?.id).toBe('CustomObject:Real__c');
  });

  it('appends are best-effort: an unwritable root returns false, never throws', async () => {
    // A regular FILE used as a directory: `mkdir` fails on POSIX and win32
    // alike. The previous fixture was '/dev/null/not-a-dir', which is
    // POSIX-only — on Windows `mkdir -p C:\\dev\\null\\not-a-dir` SUCCEEDS, the
    // append succeeds, `true` is returned, the assertion fails, and the runner's
    // C: drive is left polluted. Constructing the unwritable path makes the test
    // assert the same invariant on every platform.
    const blocker = join(vaultRoot, 'not-a-directory');
    writeFileSync(blocker, 'x', 'utf8');
    const ok = await appendDemandHit(join(blocker, 'vault'), 'X', 'automation-critical', 't');
    expect(ok).toBe(false);
  });
});

describe('queuedDrainIds', () => {
  it('selects only queued automation-critical ids', async () => {
    await appendDemandHit(vaultRoot, 'CustomObject:Queued__c', 'automation-critical', 't');
    await appendDemandHit(vaultRoot, 'CustomObject:GrantOnly__c', 'grant-only', 't');
    await appendDemandHit(vaultRoot, 'CustomObject:Drained__c', 'automation-critical', 't');
    await appendDrainResult(vaultRoot, 'CustomObject:Drained__c', 'retrieved');
    const ids = queuedDrainIds(await readDemandQueue(vaultRoot));
    expect(ids).toEqual(['CustomObject:Queued__c']);
  });

  it('the queue file is plain JSONL (one event per line, append-only)', async () => {
    await appendDemandHit(vaultRoot, 'CustomObject:A__c', 'automation-critical', 't');
    await appendDrainResult(vaultRoot, 'CustomObject:A__c', 'retrieved');
    const lines = readFileSync(demandQueuePath(vaultRoot), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
