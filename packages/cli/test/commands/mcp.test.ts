/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { checkForUpdate, formatUpdateNotice } from '@sf-intelligence/core';
import { saveManifest, vaultPaths } from '@sf-intelligence/vault';

import { prepareMcp } from '../../src/commands/mcp.js';

/** Build a unique temp working directory for each test. */
const makeTempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-mcp-'));

/** Minimum-viable manifest mirroring the canonical fields. */
const sampleManifest = (): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08.000Z',
  sourceOrg: 'test-org',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
});

/**
 * Stage a vault rooted at `${cwd}/org-kb` with the requested level of
 * completeness:
 *   - `'config-only'`: writes `meta/config.json` but no manifest or graph dir.
 *   - `'with-manifest'`: writes config.json, manifest.json, and the graph
 *     directory so `buildContext`'s `openGraph` can create the DuckDB file.
 *
 * Returns the absolute vault root for caller convenience.
 */
const seedVault = async (
  cwd: string,
  level: 'config-only' | 'with-manifest',
): Promise<{ readonly vaultRoot: string }> => {
  const vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  for (const sub of ['source', 'components', 'graph', 'meta']) {
    await mkdir(join(vaultRoot, sub), { recursive: true });
  }
  await writeFile(
    paths.config,
    JSON.stringify({
      targetOrg: 'test-org',
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-05-27T00:00:00.000Z',
    }),
    'utf8',
  );
  if (level === 'with-manifest') {
    const saved = await saveManifest(vaultRoot, sampleManifest());
    if (!saved.ok) throw new Error(`saveManifest failed: ${saved.error.message}`);
  }
  return { vaultRoot };
};

describe('prepareMcp', () => {
  it('returns no-vault error when org-kb/meta/config.json is missing', async () => {
    const cwd = await makeTempCwd();
    try {
      // Inject an empty org probe so the test never shells out to `sf`.
      const result = await prepareMcp({ cwd, listOrgs: async () => [] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('no-vault');
        expect(result.error.message).toContain('sfi init');
        expect(result.error.message).toContain('sfi refresh');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('makes the no-vault message actionable by naming authed orgs', async () => {
    const cwd = await makeTempCwd();
    try {
      const result = await prepareMcp({
        cwd,
        listOrgs: async () => ['Acme-Prod', 'Acme-UAT'],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('no-vault');
        expect(result.error.message).toContain('2 org(s)');
        expect(result.error.message).toContain('Acme-Prod');
        expect(result.error.message).toContain('Acme-UAT');
        // Trust posture: never auto-pick / guess an org.
        expect(result.error.message).toContain('never');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('degrades gracefully when no orgs are authed', async () => {
    const cwd = await makeTempCwd();
    try {
      const result = await prepareMcp({ cwd, listOrgs: async () => [] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).not.toContain('org(s)');
        expect(result.error.message).toContain('sfi init');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns buildContext-failed when config exists but no manifest is present', async () => {
    const cwd = await makeTempCwd();
    try {
      await seedVault(cwd, 'config-only');
      const result = await prepareMcp({ cwd });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('buildContext-failed');
        // `buildContext` surfaces the underlying ManifestError's message,
        // which references the manifest path — a useful sanity check that
        // we forwarded the real cause rather than swallowing it.
        expect(result.error.message.toLowerCase()).toContain('manifest');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns ok with ctx and server when the vault is well-formed', async () => {
    const cwd = await makeTempCwd();
    try {
      const { vaultRoot } = await seedVault(cwd, 'with-manifest');
      const result = await prepareMcp({ cwd });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ctx.vaultRoot).toBe(vaultRoot);
        expect(result.value.ctx.manifest.sourceOrg).toBe('test-org');
        // Smoke-test that createServer wired through — Server exposes
        // setRequestHandler; presence indicates a constructed instance.
        expect(typeof result.value.server.setRequestHandler).toBe('function');
        // Release the graph connection so the temp dir can be cleaned up.
        const { shutdown } = await import('@sf-intelligence/mcp');
        await shutdown(result.value.ctx);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('surfaces the served vaultRoot and bound targetOrg for the startup log', async () => {
    const cwd = await makeTempCwd();
    try {
      const { vaultRoot } = await seedVault(cwd, 'with-manifest');
      const result = await prepareMcp({ cwd });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.vaultRoot).toBe(vaultRoot);
        expect(result.value.targetOrg).toBe('test-org');
        const { shutdown } = await import('@sf-intelligence/mcp');
        await shutdown(result.value.ctx);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('binds an explicit vaultRoot outside the launch dir (sfi mcp --vault)', async () => {
    const vaultHome = await makeTempCwd();
    const launchCwd = await makeTempCwd(); // empty — has no org-kb of its own
    try {
      const { vaultRoot } = await seedVault(vaultHome, 'with-manifest');
      // Default resolution from the empty launch dir finds nothing...
      const def = await prepareMcp({ cwd: launchCwd, listOrgs: async () => [] });
      expect(def.ok).toBe(false);
      // ...but the explicit override binds the real vault regardless of cwd.
      const result = await prepareMcp({ cwd: launchCwd, vaultRoot });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.vaultRoot).toBe(vaultRoot);
        expect(result.value.targetOrg).toBe('test-org');
        const { shutdown } = await import('@sf-intelligence/mcp');
        await shutdown(result.value.ctx);
      }
    } finally {
      await rm(vaultHome, { recursive: true, force: true });
      await rm(launchCwd, { recursive: true, force: true });
    }
  });

  it('mentions the --vault escape hatch in the no-vault message', async () => {
    const cwd = await makeTempCwd();
    try {
      const result = await prepareMcp({ cwd, listOrgs: async () => [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('--vault');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * The `sfi mcp` startup emits a one-time update nudge to stderr built from
 * `checkForUpdate` + `formatUpdateNotice`. The live-server `.action()` is not
 * driven here; these lock the wiring contract those two seams provide — the
 * command auto-suppresses the check in CI and prints exactly the notice string.
 */
describe('sfi mcp — startup update nudge wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('suppresses the check in CI (no network, no notice)', async () => {
    vi.stubEnv('CI', '1');
    vi.stubEnv('SFI_NO_UPDATE_CHECK', '');
    const result = await checkForUpdate('0.0.1');
    expect(result.shouldUpdate).toBe(false);
    expect(formatUpdateNotice(result)).toBeNull();
  });

  it('suppresses the check under the explicit opt-out', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('SFI_NO_UPDATE_CHECK', '1');
    const result = await checkForUpdate('0.0.1');
    expect(result.shouldUpdate).toBe(false);
    expect(formatUpdateNotice(result)).toBeNull();
  });

  it('formats the stderr nudge exactly as the command prints it', () => {
    const notice = formatUpdateNotice({
      shouldUpdate: true,
      latestVersion: '9.9.9',
      cached: false,
      error: null,
    });
    expect(notice).toBe(
      'Update available: sf-intelligence@9.9.9 — run `npm i -g sf-intelligence@latest`.',
    );
  });
});
