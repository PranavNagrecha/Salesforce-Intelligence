/// <reference types="vitest/globals" />

/**
 * Tests for the v3.1 vault registry helpers.
 *
 * The registry is the load-bearing primitive for the v3.1 cross-vault
 * MCP tools — every `sfi.compare_*` call resolves an alias to an
 * absolute path through these functions. The contract surface tested
 * here matches what `PLAN-v3.1.md §3` specifies: alias-to-path
 * mapping, manifest-driven freshness enrichment, duplicate-alias
 * refusal, atomic writes.
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';

import { saveManifest } from '../src/manifest.js';
import {
  getVaultRef,
  listRegisteredVaults,
  loadRegistry,
  registerVault,
  registryPath,
  resolveVault,
  saveRegistry,
  type VaultRegistry,
} from '../src/registry.js';

const makeRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-registry-'));

const sampleManifest = (overrides: Partial<VaultManifest> = {}): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'prod@example.com',
  components: { CustomObject: 5, CustomField: 12 },
  edges: { parentOf: 12 },
  sourceTreeHash: 'sha256:prod-fixture',
  ...overrides,
});

const seedVault = async (path: string, manifest: VaultManifest): Promise<void> => {
  await mkdir(path, { recursive: true });
  const saved = await saveManifest(path, manifest);
  if (!saved.ok) throw new Error(`seed failed: ${saved.error.message}`);
};

describe('loadRegistry / saveRegistry round-trip', () => {
  it('returns registry-missing when no file exists', async () => {
    const root = await makeRoot();
    try {
      const r = await loadRegistry(root);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('registry-missing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes and reads back the registry verbatim', async () => {
    const root = await makeRoot();
    try {
      const original: VaultRegistry = {
        version: '1.0',
        registeredAt: '2026-05-28T13:00:00Z',
        vaults: {
          'acme-prod': {
            path: '/abs/acme-prod',
            registeredAt: '2026-05-28T13:00:00Z',
          },
        },
      };
      const saved = await saveRegistry(root, original);
      expect(saved.ok).toBe(true);
      const loaded = await loadRegistry(root);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value).toEqual(original);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits sorted keys for byte-stable diffs', async () => {
    const root = await makeRoot();
    try {
      const registry: VaultRegistry = {
        version: '1.0',
        registeredAt: '2026-05-28T13:00:00Z',
        vaults: {
          zeta: { path: '/abs/zeta', registeredAt: '2026-05-28T13:01:00Z' },
          alpha: { path: '/abs/alpha', registeredAt: '2026-05-28T13:00:00Z' },
        },
      };
      const saved = await saveRegistry(root, registry);
      expect(saved.ok).toBe(true);
      const raw = await readFile(registryPath(root), 'utf8');
      const aliasOrder = Array.from(raw.matchAll(/^ {4}"([^"]+)": \{/gm), (m) => m[1]);
      expect(aliasOrder).toEqual(['alpha', 'zeta']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an invalid schema version', async () => {
    const root = await makeRoot();
    try {
      // Write a registry with a future version.
      const bad = {
        version: '99.0',
        registeredAt: '2026-05-28T13:00:00Z',
        vaults: {},
      };
      await mkdir(root, { recursive: true });
      const path = registryPath(root);
      await (await import('node:fs/promises')).writeFile(
        path,
        JSON.stringify(bad),
        'utf8',
      );
      const r = await loadRegistry(root);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('parse-error');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('registerVault', () => {
  it('creates the registry file on first register', async () => {
    const root = await makeRoot();
    try {
      const vault = join(root, 'acme-prod');
      await mkdir(vault, { recursive: true });
      const r = await registerVault(root, 'acme-prod', vault);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const entry = r.value.vaults['acme-prod'];
        expect(entry).toBeDefined();
        expect(entry?.path).toBe(vault);
      }
      const loaded = await loadRegistry(root);
      expect(loaded.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects duplicate alias without force', async () => {
    const root = await makeRoot();
    try {
      const vaultA = join(root, 'acme-prod');
      const vaultB = join(root, 'acme-prod-2');
      await mkdir(vaultA, { recursive: true });
      await mkdir(vaultB, { recursive: true });
      const first = await registerVault(root, 'acme-prod', vaultA);
      expect(first.ok).toBe(true);
      const second = await registerVault(root, 'acme-prod', vaultB);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.kind).toBe('duplicate-alias');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('overwrites duplicate alias when force is true', async () => {
    const root = await makeRoot();
    try {
      const vaultA = join(root, 'a');
      const vaultB = join(root, 'b');
      await mkdir(vaultA, { recursive: true });
      await mkdir(vaultB, { recursive: true });
      const first = await registerVault(root, 'acme-prod', vaultA);
      expect(first.ok).toBe(true);
      const second = await registerVault(root, 'acme-prod', vaultB, {
        force: true,
      });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.vaults['acme-prod']?.path).toBe(vaultB);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects relative paths', async () => {
    const root = await makeRoot();
    try {
      const r = await registerVault(root, 'acme-prod', 'relative/path');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('invalid-path');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an empty alias', async () => {
    const root = await makeRoot();
    try {
      const vault = join(root, 'x');
      await mkdir(vault, { recursive: true });
      const r = await registerVault(root, '   ', vault);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('invalid-alias');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an alias containing path separators', async () => {
    const root = await makeRoot();
    try {
      const vault = join(root, 'x');
      await mkdir(vault, { recursive: true });
      const r = await registerVault(root, 'acme/prod', vault);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('invalid-alias');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('resolveVault', () => {
  it('returns the registered path for a known alias', async () => {
    const root = await makeRoot();
    try {
      const vault = join(root, 'acme-prod');
      await mkdir(vault, { recursive: true });
      await registerVault(root, 'acme-prod', vault);
      const r = await resolveVault(root, 'acme-prod');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(vault);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns alias-not-found for an unknown alias', async () => {
    const root = await makeRoot();
    try {
      const vault = join(root, 'a');
      await mkdir(vault, { recursive: true });
      await registerVault(root, 'a', vault);
      const r = await resolveVault(root, 'b');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('alias-not-found');
        // The skill surfaces this message verbatim — assert the
        // register-vault hint is part of the error message.
        expect(r.error.message).toContain('sfi register-vault');
        expect(r.error.message).toContain('sfi list-vaults');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns alias-not-found when the registry does not exist', async () => {
    const root = await makeRoot();
    try {
      const r = await resolveVault(root, 'any');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('alias-not-found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('listRegisteredVaults', () => {
  it('returns empty list when registry does not exist', async () => {
    const root = await makeRoot();
    try {
      const r = await listRegisteredVaults(root);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enriches each registered alias with manifest freshness', async () => {
    const root = await makeRoot();
    try {
      const vaultA = join(root, 'acme-prod');
      const vaultB = join(root, 'acme-sandbox');
      await seedVault(vaultA, sampleManifest({ sourceTreeHash: 'sha256:a' }));
      await seedVault(vaultB, sampleManifest({ sourceTreeHash: 'sha256:b' }));
      await registerVault(root, 'acme-prod', vaultA);
      await registerVault(root, 'acme-sandbox', vaultB);
      const r = await listRegisteredVaults(root);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toHaveLength(2);
        // Sorted by alias ASC.
        expect(r.value[0]?.alias).toBe('acme-prod');
        expect(r.value[1]?.alias).toBe('acme-sandbox');
        expect(r.value[0]?.sourceTreeHash).toBe('sha256:a');
        expect(r.value[0]?.lastRefreshedAt).toBe('2026-05-27T14:33:08Z');
        // 5 + 12 = 17 across the components map.
        expect(r.value[0]?.componentCount).toBe(17);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces null freshness when the manifest is missing', async () => {
    const root = await makeRoot();
    try {
      // Register an alias pointing at a directory with no manifest.
      const vault = join(root, 'never-refreshed');
      await mkdir(vault, { recursive: true });
      await registerVault(root, 'never', vault);
      const r = await listRegisteredVaults(root);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toHaveLength(1);
        expect(r.value[0]?.lastRefreshedAt).toBeNull();
        expect(r.value[0]?.sourceTreeHash).toBeNull();
        expect(r.value[0]?.componentCount).toBeNull();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('getVaultRef', () => {
  it('returns a VaultRef with manifest freshness when known', async () => {
    const root = await makeRoot();
    try {
      const vault = join(root, 'acme-prod');
      await seedVault(vault, sampleManifest());
      await registerVault(root, 'acme-prod', vault);
      const r = await getVaultRef(root, 'acme-prod');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.alias).toBe('acme-prod');
        expect(r.value.path).toBe(vault);
        expect(r.value.lastRefreshedAt).toBe('2026-05-27T14:33:08Z');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns alias-not-found for an unknown alias', async () => {
    const root = await makeRoot();
    try {
      const r = await getVaultRef(root, 'nope');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('alias-not-found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
