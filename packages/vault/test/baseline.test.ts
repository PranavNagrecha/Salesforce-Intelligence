import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  acknowledgeFinding,
  findingFingerprint,
  isFingerprintSuppressed,
  loadBaseline,
} from '../src/baseline.js';
import { vaultPaths } from '../src/layout.js';
import { saveManifest } from '../src/manifest.js';

describe('finding baseline', () => {
  it('computes stable fingerprints', () => {
    const a = findingFingerprint(
      'sfi.crud_fls_audit',
      'missing-crud-check',
      'ApexClass:Foo',
      'method bar',
    );
    const b = findingFingerprint(
      'sfi.crud_fls_audit',
      'missing-crud-check',
      'ApexClass:Foo',
      'method bar',
    );
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('loads empty baseline when file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-baseline-'));
    try {
      const loaded = await loadBaseline(root);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.findings).toEqual([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('acknowledges and suppresses a finding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-baseline-'));
    try {
      const ack = await acknowledgeFinding(root, {
        tool: 'sfi.crud_fls_audit',
        rule: 'missing-fls-check',
        componentId: 'ApexClass:Bar',
        location: 'line 10',
        note: 'false positive — uses SecurityUtils',
      });
      expect(ack.ok).toBe(true);
      if (!ack.ok) return;
      const fp = findingFingerprint(
        'sfi.crud_fls_audit',
        'missing-fls-check',
        'ApexClass:Bar',
        'line 10',
      );
      expect(isFingerprintSuppressed(ack.value, fp)).toBe(true);
      const raw = await readFile(vaultPaths(root).baseline, 'utf8');
      expect(raw).toContain('SecurityUtils');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('baseline suppression survives manifest refresh overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-baseline-refresh-'));
    try {
      const ack = await acknowledgeFinding(root, {
        tool: 'sfi.crud_fls_audit',
        rule: 'missing-fls-check',
        componentId: 'ApexClass:Bar',
        location: 'method baz',
      });
      expect(ack.ok).toBe(true);
      if (!ack.ok) return;
      const fp = findingFingerprint(
        'sfi.crud_fls_audit',
        'missing-fls-check',
        'ApexClass:Bar',
        'method baz',
      );

      const saved = await saveManifest(root, {
        version: '0.1.0',
        refreshedAt: new Date().toISOString(),
        sourceOrg: 'refresh-test',
        components: { ApexClass: 1 },
        edges: {},
        sourceTreeHash: 'sha256:refreshed',
      });
      expect(saved.ok).toBe(true);

      const reloaded = await loadBaseline(root);
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) return;
      expect(isFingerprintSuppressed(reloaded.value, fp)).toBe(true);
      expect(reloaded.value.findings).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
