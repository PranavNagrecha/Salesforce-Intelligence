/// <reference types="vitest/globals" />

/**
 * Tests for the v3.1 R7 `sfi register-vault` CLI subcommand.
 *
 * The handler is a thin shim around `registerVault` in
 * `@sf-intelligence/vault`; these tests verify the CLI's path
 * resolution, registry-root resolution, force-flag semantics, and
 * error mapping — not the registry's atomic write or schema (which the
 * vault package's own tests already cover).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { loadRegistry } from '@sf-intelligence/vault';

import {
  formatRegisterSuccess,
  resolveRegistryRoot,
  runRegisterVault,
} from '../../src/commands/register-vault.js';

const makeRoot = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'sfi-cli-register-'));

describe('resolveRegistryRoot', () => {
  it('honors a --root flag verbatim (absolute path)', () => {
    const root = '/abs/some-root';
    expect(resolveRegistryRoot({ root })).toBe(root);
  });

  it('falls back to SF_INTELLIGENCE_REGISTRY_PATH when --root is missing', () => {
    const prior = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = '/env/registry/root';
    try {
      expect(resolveRegistryRoot({})).toBe('/env/registry/root');
    } finally {
      if (prior === undefined) {
        delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
      } else {
        process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = prior;
      }
    }
  });

  it('falls back to the home-directory default when neither --root nor env is set', () => {
    const prior = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    try {
      const result = resolveRegistryRoot({});
      expect(result.endsWith('sf-intelligence-vaults')).toBe(true);
    } finally {
      if (prior !== undefined) {
        process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = prior;
      }
    }
  });
});

describe('runRegisterVault', () => {
  it('registers an alias mapping to an absolute path', async () => {
    const root = await makeRoot();
    try {
      const result = await runRegisterVault({
        cwd: process.cwd(),
        alias: 'acme-prod',
        vaultPath: '/abs/acme-prod',
        rootDir: root,
        force: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.alias).toBe('acme-prod');
      expect(result.value.resolvedPath).toBe('/abs/acme-prod');
      expect(result.value.registryRoot).toBe(root);

      // The registry file must exist with our alias entry.
      const loaded = await loadRegistry(root);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.vaults['acme-prod']?.path).toBe('/abs/acme-prod');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves relative vault paths against cwd', async () => {
    const root = await makeRoot();
    // `resolve()` renders with the HOST separator, so a literal
    // '/tmp/foo/my-vault' equality is a POSIX-only assertion. Derive both sides
    // from node:path so the test asserts the BEHAVIOUR (relative paths resolve
    // against cwd) rather than one platform's rendering of it.
    const cwd = resolve(sep, 'tmp', 'foo');
    try {
      const result = await runRegisterVault({
        cwd,
        alias: 'sandbox',
        vaultPath: 'my-vault',
        rootDir: root,
        force: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.resolvedPath).toBe(resolve(cwd, 'my-vault'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses duplicate alias without --force', async () => {
    const root = await makeRoot();
    try {
      const first = await runRegisterVault({
        cwd: process.cwd(),
        alias: 'acme-prod',
        vaultPath: '/abs/one',
        rootDir: root,
        force: false,
      });
      expect(first.ok).toBe(true);
      const second = await runRegisterVault({
        cwd: process.cwd(),
        alias: 'acme-prod',
        vaultPath: '/abs/two',
        rootDir: root,
        force: false,
      });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.kind).toBe('duplicate-alias');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('overwrites an existing alias when --force is set', async () => {
    const root = await makeRoot();
    try {
      await runRegisterVault({
        cwd: process.cwd(),
        alias: 'acme-prod',
        vaultPath: '/abs/one',
        rootDir: root,
        force: false,
      });
      const second = await runRegisterVault({
        cwd: process.cwd(),
        alias: 'acme-prod',
        vaultPath: '/abs/two',
        rootDir: root,
        force: true,
      });
      expect(second.ok).toBe(true);
      const loaded = await loadRegistry(root);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.vaults['acme-prod']?.path).toBe('/abs/two');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits invalid-alias for an empty alias', async () => {
    const root = await makeRoot();
    try {
      const result = await runRegisterVault({
        cwd: process.cwd(),
        alias: '',
        vaultPath: '/abs/path',
        rootDir: root,
        force: false,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('invalid-alias');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('formatRegisterSuccess', () => {
  it('renders the alias, resolved path, and registry root on one line', () => {
    const line = formatRegisterSuccess({
      alias: 'acme-prod',
      resolvedPath: '/abs/acme-prod',
      registryRoot: '/abs/root',
    });
    expect(line).toContain('acme-prod');
    expect(line).toContain('/abs/acme-prod');
    expect(line).toContain('/abs/root');
    expect(line.endsWith('\n')).toBe(true);
  });
});

// Sanity-check: the registry JSON written on disk is parseable.
describe('registry file shape', () => {
  it('writes a valid JSON file readable by loadRegistry', async () => {
    const root = await makeRoot();
    try {
      await runRegisterVault({
        cwd: process.cwd(),
        alias: 'a',
        vaultPath: '/abs/a',
        rootDir: root,
        force: false,
      });
      await runRegisterVault({
        cwd: process.cwd(),
        alias: 'b',
        vaultPath: '/abs/b',
        rootDir: root,
        force: false,
      });
      const raw = await readFile(join(root, 'registry.json'), 'utf8');
      const parsed = JSON.parse(raw) as { vaults: Record<string, unknown> };
      expect(Object.keys(parsed.vaults).sort()).toEqual(['a', 'b']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
