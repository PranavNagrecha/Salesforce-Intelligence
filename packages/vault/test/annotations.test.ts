/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  annotationsFor,
  annotationsPath,
  appendAnnotationEvent,
  readAnnotations,
  type AnnotationEvent,
} from '../src/annotations.js';

/**
 * P13-ANNOT-store — replay semantics of the annotations event log:
 * last-write-wins per (componentId, key), unset removes, AI→human
 * confirmation flow, corrupt/invalid-line tolerance.
 */

let vaultRoot: string;

const ev = (overrides: Partial<AnnotationEvent>): AnnotationEvent => ({
  componentId: 'CustomField:Contact.SSN__c',
  key: 'glossary',
  value: 'social security number',
  author: 'pranav',
  source: 'human',
  confirmed: true,
  at: '2026-06-10T00:00:00.000Z',
  op: 'set',
  ...overrides,
});

beforeEach(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), 'sfi-annotations-'));
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe('readAnnotations replay', () => {
  it('absent file reads as an empty overlay', async () => {
    expect(await readAnnotations(vaultRoot)).toEqual([]);
  });

  it('last write wins per (componentId, key); other keys/components untouched', async () => {
    await appendAnnotationEvent(vaultRoot, ev({ value: 'old synonym' }));
    await appendAnnotationEvent(vaultRoot, ev({ key: 'owner', value: 'RevOps' }));
    await appendAnnotationEvent(vaultRoot, ev({ componentId: 'CustomObject:Account', key: 'note', value: 'core' }));
    await appendAnnotationEvent(vaultRoot, ev({ value: 'social security number', at: '2026-06-10T01:00:00.000Z' }));
    const all = await readAnnotations(vaultRoot);
    expect(all.length).toBe(3);
    const ssn = annotationsFor(all, 'CustomField:Contact.SSN__c');
    expect(ssn.find((a) => a.key === 'glossary')?.value).toBe('social security number');
    expect(ssn.find((a) => a.key === 'glossary')?.at).toBe('2026-06-10T01:00:00.000Z');
    expect(ssn.find((a) => a.key === 'owner')?.value).toBe('RevOps');
  });

  it('unset removes the pair; a later set re-creates it', async () => {
    await appendAnnotationEvent(vaultRoot, ev({}));
    await appendAnnotationEvent(vaultRoot, ev({ op: 'unset' }));
    expect(await readAnnotations(vaultRoot)).toEqual([]);
    await appendAnnotationEvent(vaultRoot, ev({ value: 'again' }));
    expect((await readAnnotations(vaultRoot))[0]?.value).toBe('again');
  });

  it('AI proposal → human confirmation: the confirming set wins with confirmed:true', async () => {
    await appendAnnotationEvent(
      vaultRoot,
      ev({ key: 'status', value: 'deprecated', source: 'ai', confirmed: false, author: 'model' }),
    );
    const proposed = await readAnnotations(vaultRoot);
    expect(proposed[0]?.source).toBe('ai');
    expect(proposed[0]?.confirmed).toBe(false);
    await appendAnnotationEvent(
      vaultRoot,
      ev({ key: 'status', value: 'deprecated', source: 'human', confirmed: true, at: '2026-06-10T02:00:00.000Z' }),
    );
    const confirmed = await readAnnotations(vaultRoot);
    expect(confirmed.length).toBe(1);
    expect(confirmed[0]?.confirmed).toBe(true);
    expect(confirmed[0]?.source).toBe('human');
  });

  it('skips corrupt lines, unknown keys, and set-without-value', async () => {
    mkdirSync(join(vaultRoot, 'meta'), { recursive: true });
    writeFileSync(
      annotationsPath(vaultRoot),
      [
        '{corrupt',
        JSON.stringify({ componentId: 'X', key: 'not-a-key', value: 'v', at: 't', op: 'set' }),
        JSON.stringify({ componentId: 'X', key: 'note', at: 't', op: 'set' }), // no value
        JSON.stringify(ev({ componentId: 'CustomObject:Real', key: 'note', value: 'kept' })),
        '',
      ].join('\n'),
      'utf8',
    );
    const all = await readAnnotations(vaultRoot);
    expect(all.length).toBe(1);
    expect(all[0]?.componentId).toBe('CustomObject:Real');
  });

  it('appends are best-effort: unwritable root returns false, never throws', async () => {
    // A regular FILE used as a directory: `mkdir` fails on POSIX and win32
    // alike. The previous fixture was '/dev/null/not-a-dir', which is
    // POSIX-only — on Windows `mkdir -p C:\\dev\\null\\not-a-dir` SUCCEEDS, the
    // append succeeds, `true` is returned, the assertion fails, and the runner's
    // C: drive is left polluted. Constructing the unwritable path makes the test
    // assert the same invariant on every platform.
    const blocker = join(vaultRoot, 'not-a-directory');
    writeFileSync(blocker, 'x', 'utf8');
    expect(await appendAnnotationEvent(join(blocker, 'vault'), ev({}))).toBe(false);
  });

  it('output is deterministically sorted (componentId, then key)', async () => {
    await appendAnnotationEvent(vaultRoot, ev({ componentId: 'B', key: 'note', value: '1' }));
    await appendAnnotationEvent(vaultRoot, ev({ componentId: 'A', key: 'status', value: '2' }));
    await appendAnnotationEvent(vaultRoot, ev({ componentId: 'A', key: 'owner', value: '3' }));
    const all = await readAnnotations(vaultRoot);
    expect(all.map((a) => `${a.componentId}/${a.key}`)).toEqual(['A/owner', 'A/status', 'B/note']);
  });
});
