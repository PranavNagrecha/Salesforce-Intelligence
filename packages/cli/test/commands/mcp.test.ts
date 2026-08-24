/// <reference types="vitest/globals" />

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { checkForUpdate, formatUpdateNotice } from '@sf-intelligence/core';
import { saveManifest, vaultPaths } from '@sf-intelligence/vault';

import { prepareMcp, resolveVaultBinding } from '../../src/commands/mcp.js';

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

  it('names authed orgs when a human is watching a terminal', async () => {
    const cwd = await makeTempCwd();
    try {
      const result = await prepareMcp({
        cwd,
        discloseOrgNames: true,
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

  it('WITHHOLDS org aliases by default — this message becomes a host log file', async () => {
    // When an MCP host launches the server, stderr is captured to a file on
    // disk (Claude Desktop's mcp-server-*.log, Claude Code's debug log). A list
    // of an organisation's Salesforce org aliases should not persist there just
    // because the user had not run `sfi init` yet. The count still proves the
    // `sf` CLI works and a choice exists; the assistant reads the actual names
    // in-band from `sfi.setup_status`, which is carried on `authedOrgs` below.
    const cwd = await makeTempCwd();
    try {
      const result = await prepareMcp({
        cwd,
        listOrgs: async () => ['Acme-Prod', 'Acme-UAT'],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('2 org(s)');
        expect(result.error.message).not.toContain('Acme-Prod');
        expect(result.error.message).not.toContain('Acme-UAT');
        // Withheld from the LOG, not lost: setup mode still gets the real list.
        expect(result.error.authedOrgs).toEqual(['Acme-Prod', 'Acme-UAT']);
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
 * BINDING (SFI_VAULT) — the `sfi mcp` vault-binding precedence, most explicit
 * first: `--vault` flag > `SFI_VAULT` env > `./org-kb`. The action reads
 * `process.env['SFI_VAULT']` and hands both values to `resolveVaultBinding`,
 * which is pure + exported so the precedence (and the `bindSource` label the
 * startup log announces) is testable without driving the blocking stdio server.
 */
describe('resolveVaultBinding — SFI_VAULT precedence', () => {
  it('selects SFI_VAULT when --vault is absent', () => {
    expect(resolveVaultBinding(undefined, '/srv/org-kb')).toEqual({
      vaultRoot: '/srv/org-kb',
      bindSource: 'SFI_VAULT',
    });
  });

  it('lets --vault win over SFI_VAULT', () => {
    expect(resolveVaultBinding('/flag/org-kb', '/srv/org-kb')).toEqual({
      vaultRoot: '/flag/org-kb',
      bindSource: '--vault',
    });
  });

  it('falls back to ./org-kb when neither --vault nor SFI_VAULT is present', () => {
    expect(resolveVaultBinding(undefined, undefined)).toEqual({
      vaultRoot: undefined,
      bindSource: 'default ./org-kb',
    });
  });

  it('ignores a blank/whitespace-only SFI_VAULT and trims a real one', () => {
    // A blank env var is treated as unset (so `plugin.json` can ship an empty
    // default); a real value is trimmed of surrounding whitespace.
    expect(resolveVaultBinding(undefined, '   ')).toEqual({
      vaultRoot: undefined,
      bindSource: 'default ./org-kb',
    });
    expect(resolveVaultBinding(undefined, '  /srv/org-kb  ')).toEqual({
      vaultRoot: '/srv/org-kb',
      bindSource: 'SFI_VAULT',
    });
  });
});

/**
 * CR-RV3b: `defaultListOrgs` (exercised here via `prepareMcp` WITHOUT a
 * `listOrgs` override, so the real `sf org list --json` probe path runs)
 * used to shell out through a bare `promisify(execFile)` with no timeout —
 * a wedged `sf` subprocess could hang `sfi mcp` startup forever. It now
 * routes through `execHelper`, the shared `SFI_SF_EXEC_TIMEOUT_MS`-backed
 * exec seam (packages/core/src/exec-helper.ts), which already carries its
 * own SIGTERM→SIGKILL escalation coverage — this test only pins that THIS
 * call site inherits that budget rather than hanging indefinitely.
 */
describe('defaultListOrgs — SFI_SF_EXEC_TIMEOUT_MS backstop (CR-RV3b)', () => {
  const PRIOR_PATH = process.env['PATH'];

  afterEach(() => {
    vi.unstubAllEnvs();
    if (PRIOR_PATH === undefined) delete process.env['PATH'];
    else process.env['PATH'] = PRIOR_PATH;
  });

  it('degrades within the configured timeout budget instead of hanging on a wedged `sf`', async () => {
    // A fake `sf` on PATH that execs into a 60s sleep — standing in for a
    // real `sf` process wedged on an interactive re-auth prompt or similar.
    // `exec` (not a bare `sleep 60` line) replaces the shell's process image
    // so the SIGTERM the timeout sends reaches the sleep directly, without
    // waiting on the SIGKILL escalation grace — keeping this test fast.
    const binDir = await mkdtemp(join(tmpdir(), 'sfi-fake-sf-'));
    const fakeSfPath = join(binDir, 'sf');
    await writeFile(fakeSfPath, '#!/bin/sh\nexec sleep 60\n', 'utf8');
    await chmod(fakeSfPath, 0o755);
    process.env['PATH'] = `${binDir}:${PRIOR_PATH ?? ''}`;
    vi.stubEnv('SFI_SF_EXEC_TIMEOUT_MS', '200');

    const cwd = await makeTempCwd(); // empty — no org-kb, so prepareMcp falls to defaultListOrgs
    const start = Date.now();
    try {
      const result = await prepareMcp({ cwd });
      const elapsed = Date.now() - start;
      // Resolved well under the fake sf's 60s sleep — proof the timeout
      // backstop, not the script's own exit, ended the call.
      expect(elapsed).toBeLessThan(5000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // No orgs discovered (the probe timed out and was caught) — the same
        // graceful-degrade message as "sf CLI not installed", not a hang.
        expect(result.error.kind).toBe('no-vault');
        expect(result.error.message).not.toContain('org(s)');
        expect(result.error.message).toContain('sfi init');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  }, 10000);
});

/**
 * The `sfi mcp` startup emits a one-time update nudge to stderr built from
 * `checkForUpdate` + `formatUpdateNotice`. The live-server `.action()` is not
 * driven here; these lock the wiring contract those two seams provide — the
 * command auto-suppresses the check in CI and prints exactly the notice string.
 *
 * R7: the check is fire-and-forget (void + .then()): a cache-miss that triggers
 * a ~3s registry GET must NOT delay `startServer`. The property tested here is
 * that `checkForUpdate` resolves correctly from a slow injected fetcher without
 * blocking the caller — meaning the caller can fire it without awaiting.
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
      "Update available: sf-intelligence@9.9.9 — run `npm i -g sf-intelligence@latest`, then `/sfi-refresh` to rebuild your vault with the new version's extractors.",
    );
  });

  it('R7 fire-and-forget contract: checkForUpdate returns a Promise that can be fired without await', async () => {
    // The fire-and-forget property: `void checkForUpdate().then(...)` must not
    // cause an unhandled rejection — the promise always resolves (never rejects).
    // Even under CI suppression (shouldUpdate=false) the contract holds: the
    // .then() callback runs and receives a well-formed UpdateCheckResult.
    let thenRan = false;
    const p = checkForUpdate('0.0.1').then((r) => {
      thenRan = true;
      // The result is always a well-formed object (never throws / rejects).
      expect(typeof r.shouldUpdate).toBe('boolean');
      expect(r.error === null || r.error instanceof Error).toBe(true);
    });
    // Fire it as void (the way registerMcpCommand does) — no await on the call
    // site, the .then() runs whenever the check settles.
    void p;
    // Awaiting in the test confirms it does settle and the .then() ran.
    await p;
    expect(thenRan).toBe(true);
  });
});
