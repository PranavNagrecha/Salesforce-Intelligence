/// <reference types="vitest/globals" />

/**
 * Tests for the v3.1 R7 `sfi list-vaults` CLI subcommand.
 *
 * The handler is a thin shim around `listRegisteredVaults` in
 * `@sf-intelligence/vault`; these tests verify the CLI's table
 * rendering, JSON-mode round-tripping, and the empty-registry case —
 * not the registry's freshness enrichment (which the vault package's
 * own tests already cover).
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { registerVault, saveManifest } from '@sf-intelligence/vault';

import {
  renderVaultsTable,
  runListVaults,
} from '../../src/commands/list-vaults.js';

const makeRoot = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'sfi-cli-list-'));

const sampleManifest = (
  sourceTreeHash: string,
  refreshedAt = '2026-05-27T10:00:00.000Z',
): VaultManifest => ({
  version: '0.1.0',
  refreshedAt,
  sourceOrg: 'prod@example.com',
  components: { CustomObject: 3, CustomField: 12 },
  edges: { parentOf: 12 },
  sourceTreeHash,
});

describe('runListVaults', () => {
  it('returns an empty array when no vaults are registered', async () => {
    const root = await makeRoot();
    try {
      const result = await runListVaults({ rootDir: root });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns one VaultRef per registered alias, sorted by alias ASC', async () => {
    const root = await makeRoot();
    try {
      const vaultBPath = join(root, 'acme-sandbox');
      const vaultAPath = join(root, 'acme-prod');
      await mkdir(vaultBPath, { recursive: true });
      await mkdir(vaultAPath, { recursive: true });
      await saveManifest(vaultAPath, sampleManifest('hash-a'));
      await saveManifest(vaultBPath, sampleManifest('hash-b'));
      // Register intentionally out of order; listRegisteredVaults sorts.
      await registerVault(root, 'acme-sandbox', vaultBPath);
      await registerVault(root, 'acme-prod', vaultAPath);
      const result = await runListVaults({ rootDir: root });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.map((v) => v.alias)).toEqual([
        'acme-prod',
        'acme-sandbox',
      ]);
      const prod = result.value.find((v) => v.alias === 'acme-prod');
      expect(prod?.lastRefreshedAt).toBe('2026-05-27T10:00:00.000Z');
      expect(prod?.sourceTreeHash).toBe('hash-a');
      // CustomObject:3 + CustomField:12 = 15 components.
      expect(prod?.componentCount).toBe(15);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces lastRefreshedAt=null and componentCount=null when the manifest is missing', async () => {
    const root = await makeRoot();
    try {
      const vaultPath = join(root, 'unrefreshed');
      await mkdir(vaultPath, { recursive: true });
      // No saveManifest call — the vault path is present but unrefreshed.
      await registerVault(root, 'unrefreshed', vaultPath);
      const result = await runListVaults({ rootDir: root });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const entry = result.value.find((v) => v.alias === 'unrefreshed');
      expect(entry).toBeDefined();
      expect(entry?.lastRefreshedAt).toBeNull();
      expect(entry?.sourceTreeHash).toBeNull();
      expect(entry?.componentCount).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('renderVaultsTable', () => {
  it('renders the empty-registry message when no vaults exist', () => {
    const out = renderVaultsTable([]);
    expect(out).toContain('No vaults registered');
    expect(out).toContain('sfi register-vault');
  });

  it('renders headers, separators, and one row per registered vault', () => {
    const out = renderVaultsTable([
      {
        alias: 'acme-prod',
        path: '/abs/acme-prod',
        registeredAt: '2026-05-28T13:00:00Z',
        lastRefreshedAt: '2026-05-27T10:00:00Z',
        sourceTreeHash: 'sha256:prod',
        componentCount: 15,
      },
    ]);
    expect(out).toContain('ALIAS');
    expect(out).toContain('PATH');
    expect(out).toContain('LAST REFRESHED');
    expect(out).toContain('COMPONENTS');
    expect(out).toContain('acme-prod');
    expect(out).toContain('2026-05-27T10:00:00Z');
    expect(out).toContain('15');
  });

  it('renders `(never refreshed)` when lastRefreshedAt is null', () => {
    const out = renderVaultsTable([
      {
        alias: 'cold',
        path: '/abs/cold',
        registeredAt: '2026-05-28T13:00:00Z',
        lastRefreshedAt: null,
        sourceTreeHash: null,
        componentCount: null,
      },
    ]);
    expect(out).toContain('(never refreshed)');
    expect(out).toContain('(none)');
  });

  it('truncates long paths so the table stays aligned', () => {
    const longPath = `/abs/${'x'.repeat(200)}`;
    const out = renderVaultsTable([
      {
        alias: 'long',
        path: longPath,
        registeredAt: '2026-05-28T13:00:00Z',
        lastRefreshedAt: '2026-05-27T10:00:00Z',
        sourceTreeHash: 'sha256:long',
        componentCount: 5,
      },
    ]);
    expect(out).toContain('...');
    expect(out).not.toContain(longPath);
  });
});
