/// <reference types="vitest/globals" />

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeSourceTreeHash } from '../src/hash.js';

const makeRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-hash-'));

const seedFixture = async (root: string): Promise<void> => {
  await mkdir(join(root, 'objects', 'Account', 'fields'), { recursive: true });
  await writeFile(
    join(root, 'objects', 'Account', 'Account.object-meta.xml'),
    '<?xml version="1.0"?><CustomObject/>',
    'utf8',
  );
  await writeFile(
    join(root, 'objects', 'Account', 'fields', 'Industry__c.field-meta.xml'),
    '<?xml version="1.0"?><CustomField/>',
    'utf8',
  );
};

describe('computeSourceTreeHash determinism', () => {
  it('produces identical hashes for the same fixture across two runs', async () => {
    const root = await makeRoot();
    try {
      await seedFixture(root);
      const first = await computeSourceTreeHash(root);
      const second = await computeSourceTreeHash(root);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.value).toBe(second.value);
        expect(first.value).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('computeSourceTreeHash content sensitivity', () => {
  it('produces different hashes when a file changes', async () => {
    const root = await makeRoot();
    try {
      await seedFixture(root);
      const before = await computeSourceTreeHash(root);
      expect(before.ok).toBe(true);

      await writeFile(
        join(root, 'objects', 'Account', 'Account.object-meta.xml'),
        '<?xml version="1.0"?><CustomObject><label>Changed</label></CustomObject>',
        'utf8',
      );
      const after = await computeSourceTreeHash(root);
      expect(after.ok).toBe(true);
      if (before.ok && after.ok) {
        expect(after.value).not.toBe(before.value);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('computeSourceTreeHash dotfile skipping', () => {
  it('ignores files whose names start with "."', async () => {
    const root = await makeRoot();
    try {
      await seedFixture(root);
      const baseline = await computeSourceTreeHash(root);
      expect(baseline.ok).toBe(true);

      // Drop a .DS_Store at the root and a .gitkeep inside a subdir.
      await writeFile(join(root, '.DS_Store'), 'mac garbage', 'utf8');
      await writeFile(join(root, 'objects', '.gitkeep'), '', 'utf8');

      const polluted = await computeSourceTreeHash(root);
      expect(polluted.ok).toBe(true);
      if (baseline.ok && polluted.ok) {
        expect(polluted.value).toBe(baseline.value);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('computeSourceTreeHash path normalization', () => {
  it('matches a manually computed reference using POSIX-form relative paths', async () => {
    const root = await makeRoot();
    try {
      // Two files at known relative paths with known bytes.
      await mkdir(join(root, 'a'), { recursive: true });
      await writeFile(join(root, 'a', 'first.txt'), 'first', 'utf8');
      await writeFile(join(root, 'b.txt'), 'second', 'utf8');

      const r = await computeSourceTreeHash(root);
      expect(r.ok).toBe(true);

      // Reference: feed the canonical stream in alphabetical depth-first
      // order. 'a' (dir) < 'b.txt' so 'a/first.txt' comes before 'b.txt'.
      const reference = createHash('sha256');
      reference.update(Buffer.from('a/first.txt', 'utf8'));
      reference.update(Buffer.from([0x00]));
      reference.update(Buffer.from('first', 'utf8'));
      reference.update(Buffer.from([0x0a]));
      reference.update(Buffer.from('b.txt', 'utf8'));
      reference.update(Buffer.from([0x00]));
      reference.update(Buffer.from('second', 'utf8'));
      reference.update(Buffer.from([0x0a]));
      const expected = reference.digest('hex');

      if (r.ok) {
        expect(r.value).toBe(expected);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('computeSourceTreeHash error handling', () => {
  it('returns err with kind "directory-not-found" when the source root does not exist', async () => {
    const ghost = join(tmpdir(), 'sfi-hash-nonexistent-' + Date.now().toString(36));
    const r = await computeSourceTreeHash(ghost);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('directory-not-found');
    }
  });

  it('returns err with kind "directory-not-found" when given a file path', async () => {
    const root = await makeRoot();
    try {
      const filePath = join(root, 'not-a-dir.txt');
      await writeFile(filePath, 'data', 'utf8');
      const r = await computeSourceTreeHash(filePath);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('directory-not-found');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
