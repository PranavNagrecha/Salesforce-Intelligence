/// <reference types="vitest/globals" />

/**
 * Update notifier (packages/core/src/update-notifier.ts).
 *
 * The tests are hermetic: they NEVER depend on a real network call. The
 * network branch is exercised only under an opt-out / CI env so its outcome is
 * deterministic, and the cache branch is driven by writing a fixture cache file
 * at `SFI_UPDATE_CACHE_PATH` (pointed at a throwaway temp file) — the same
 * env-override pattern the live-consent store uses for determinism.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkForUpdate,
  compareVersions,
  formatUpdateNotice,
  getStateDir,
  type UpdateCheckResult,
} from '../src/update-notifier.js';

describe('compareVersions', () => {
  it('returns true when the current build is older than latest', () => {
    expect(compareVersions('0.1.0', '0.1.1')).toBe(true);
    expect(compareVersions('0.1.0', '0.2.0')).toBe(true);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(true);
  });

  it('returns false when the current build is equal or newer', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(false);
    expect(compareVersions('0.1.1', '0.1.0')).toBe(false);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(false);
  });

  it('returns false for malformed input (never nags on an unparseable version)', () => {
    expect(compareVersions('not-a-version', '0.1.0')).toBe(false);
    expect(compareVersions('0.1.0', 'latest')).toBe(false);
    expect(compareVersions('1', '2')).toBe(false);
  });

  it('ignores prerelease and build metadata', () => {
    // 0.1.0-beta reads as 0.1.0 → not older than 0.1.0.
    expect(compareVersions('0.1.0-beta', '0.1.0')).toBe(false);
    expect(compareVersions('0.1.0', '0.1.1+build.7')).toBe(true);
  });
});

describe('formatUpdateNotice', () => {
  const base: UpdateCheckResult = {
    shouldUpdate: false,
    latestVersion: null,
    cached: false,
    error: null,
  };

  it('formats an actionable one-liner when an update is available', () => {
    const notice = formatUpdateNotice({
      ...base,
      shouldUpdate: true,
      latestVersion: '0.2.0',
    });
    expect(notice).toBeTruthy();
    expect(notice).toContain('0.2.0');
    expect(notice).toContain('npm i -g sf-intelligence@latest');
    // The nudge also prompts a vault rebuild — "upgrade + do a refresh".
    expect(notice).toContain('/sfi-refresh');
  });

  it('returns null when no update is available', () => {
    expect(formatUpdateNotice({ ...base, latestVersion: '0.1.0' })).toBeNull();
  });

  it('returns null when latestVersion is null even if shouldUpdate slipped true', () => {
    expect(formatUpdateNotice({ ...base, shouldUpdate: true })).toBeNull();
  });
});

describe('checkForUpdate', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sfi-update-'));
    cachePath = join(dir, 'update-check.json');
    // Point the cache at a throwaway file (the live-consent SFI_*_PATH pattern).
    vi.stubEnv('SFI_UPDATE_CACHE_PATH', cachePath);
    // Default: keep the network branch OFF so no test reaches out unless it
    // explicitly opts back in — none do.
    vi.stubEnv('CI', '1');
    vi.stubEnv('SFI_NO_UPDATE_CHECK', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  const writeCache = async (entry: unknown): Promise<void> => {
    await writeFile(cachePath, JSON.stringify(entry), 'utf8');
  };

  it('short-circuits (no network, no cache) when SFI_NO_UPDATE_CHECK=1', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('SFI_NO_UPDATE_CHECK', '1');
    const r = await checkForUpdate('0.1.0');
    expect(r).toEqual({
      shouldUpdate: false,
      latestVersion: null,
      cached: false,
      error: null,
    });
  });

  it('short-circuits when a CI marker is set', async () => {
    // CI='1' via beforeEach.
    const r = await checkForUpdate('0.1.0');
    expect(r.shouldUpdate).toBe(false);
    expect(r.cached).toBe(false);
  });

  it('short-circuits when GITHUB_ACTIONS is set', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const r = await checkForUpdate('0.1.0');
    expect(r.shouldUpdate).toBe(false);
  });

  it('serves a fresh cache hit without touching the network (and marks cached:true)', async () => {
    // The cache path is only reached when the check is NOT disabled — drop CI.
    vi.stubEnv('CI', '');
    await writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: '0.2.0',
      shouldUpdate: true,
    });
    const r = await checkForUpdate('0.1.0');
    expect(r.cached).toBe(true);
    expect(r.latestVersion).toBe('0.2.0');
    expect(r.shouldUpdate).toBe(true);
    expect(r.error).toBeNull();
  });

  it('opt-out short-circuits BEFORE the cache (disabled means no nudge, even on a fresh hit)', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('SFI_NO_UPDATE_CHECK', '1');
    await writeCache({
      checkedAt: new Date().toISOString(),
      latestVersion: '0.2.0',
      shouldUpdate: true,
    });
    const r = await checkForUpdate('0.1.0');
    expect(r.shouldUpdate).toBe(false);
    expect(r.cached).toBe(false);
    expect(r.latestVersion).toBeNull();
  });

  it('ignores a stale cache (> 24h old) and re-checks via the fetcher', async () => {
    vi.stubEnv('CI', ''); // exercise the non-disabled path
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeCache({
      checkedAt: stale,
      latestVersion: '0.2.0',
      shouldUpdate: true,
    });
    // The injected fetcher returns a NEWER real answer; the stale cached value
    // must not be surfaced as-is — a fresh check replaces it.
    const r = await checkForUpdate('0.1.0', async () => '0.3.0');
    expect(r.cached).toBe(false);
    expect(r.latestVersion).toBe('0.3.0');
    expect(r.shouldUpdate).toBe(true);
  });

  it('ignores a corrupt cache file (exercises the parse-failure path, not the disable path)', async () => {
    vi.stubEnv('CI', '');
    await writeFile(cachePath, 'not valid json', 'utf8');
    const r = await checkForUpdate('0.1.0', async () => null);
    expect(r.cached).toBe(false);
  });

  it('ignores a shape-invalid cache file', async () => {
    vi.stubEnv('CI', '');
    await writeCache({ checkedAt: 'yesterday', latestVersion: 42 });
    const r = await checkForUpdate('0.1.0', async () => null);
    expect(r.cached).toBe(false);
  });

  it('fresh check reports + caches an available update', async () => {
    vi.stubEnv('CI', '');
    const r = await checkForUpdate('0.1.0', async () => '0.2.0');
    expect(r.cached).toBe(false);
    expect(r.latestVersion).toBe('0.2.0');
    expect(r.shouldUpdate).toBe(true);
    // The result was written to cache — a second call is a zero-network hit.
    const again = await checkForUpdate('0.1.0', async () => {
      throw new Error('fetcher must not run on a cache hit');
    });
    expect(again.cached).toBe(true);
    expect(again.latestVersion).toBe('0.2.0');
  });

  it('fresh check reports no update when already current', async () => {
    vi.stubEnv('CI', '');
    const r = await checkForUpdate('0.2.0', async () => '0.2.0');
    expect(r.shouldUpdate).toBe(false);
    expect(r.latestVersion).toBe('0.2.0');
  });

  it('fails silently when the fetcher returns null (no version, no throw)', async () => {
    vi.stubEnv('CI', '');
    const r = await checkForUpdate('0.1.0', async () => null);
    expect(r.shouldUpdate).toBe(false);
    expect(r.latestVersion).toBeNull();
    expect(r.error).toBeNull();
  });

  it('never throws even when the fetcher rejects', async () => {
    vi.stubEnv('CI', '');
    const r = await checkForUpdate('0.1.0', async () => {
      throw new Error('boom');
    });
    expect(r.shouldUpdate).toBe(false);
    expect(r.error).toBeInstanceOf(Error);
  });
});

describe('getStateDir', () => {
  it('resolves under the home directory', () => {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
    const dir = getStateDir();
    expect(dir.endsWith('.sf-intelligence')).toBe(true);
    if (home.length > 0) expect(dir.startsWith(home)).toBe(true);
  });
});
