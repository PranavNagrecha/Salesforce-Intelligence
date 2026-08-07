/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertNetworkAllowed,
  describeNetworkPolicy,
  getNetworkMode,
  withNetworkMode,
} from '../src/network-policy.js';

describe('network policy (AUDIT-F2)', () => {
  beforeEach(() => {
    vi.stubEnv('SFI_NETWORK_MODE', '');
    vi.stubEnv('SFI_UPDATE_CHECK', '');
    vi.stubEnv('SFI_NO_UPDATE_CHECK', '');
    for (const marker of [
      'CI',
      'CONTINUOUS_INTEGRATION',
      'GITHUB_ACTIONS',
    ]) {
      vi.stubEnv(marker, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to off', () => {
    expect(getNetworkMode()).toBe('off');
    expect(describeNetworkPolicy().mode).toBe('off');
  });

  it('denies every purpose under off (except opted-in update-check)', () => {
    expect(assertNetworkAllowed({ purpose: 'update-check' }).ok).toBe(false);
    expect(assertNetworkAllowed({ purpose: 'metadata-retrieve' }).ok).toBe(false);
    expect(assertNetworkAllowed({ purpose: 'live-query' }).ok).toBe(false);
    expect(assertNetworkAllowed({ purpose: 'model-download' }).ok).toBe(false);
  });

  it('SFI_UPDATE_CHECK=1 allows update-check under off', () => {
    vi.stubEnv('SFI_UPDATE_CHECK', '1');
    expect(assertNetworkAllowed({ purpose: 'update-check' }).ok).toBe(true);
    expect(assertNetworkAllowed({ purpose: 'live-query' }).ok).toBe(false);
  });

  it('updates-only allows only update-check', () => {
    vi.stubEnv('SFI_NETWORK_MODE', 'updates-only');
    expect(getNetworkMode()).toBe('updates-only');
    expect(assertNetworkAllowed({ purpose: 'update-check' }).ok).toBe(true);
    expect(assertNetworkAllowed({ purpose: 'metadata-retrieve' }).ok).toBe(false);
    expect(assertNetworkAllowed({ purpose: 'live-query' }).ok).toBe(false);
  });

  it('salesforce-read allows retrieve + live, not update-check or model-download', () => {
    vi.stubEnv('SFI_NETWORK_MODE', 'salesforce-read');
    expect(assertNetworkAllowed({ purpose: 'metadata-retrieve' }).ok).toBe(true);
    expect(assertNetworkAllowed({ purpose: 'live-query' }).ok).toBe(true);
    expect(assertNetworkAllowed({ purpose: 'update-check' }).ok).toBe(false);
    expect(assertNetworkAllowed({ purpose: 'model-download' }).ok).toBe(false);
  });

  it('withNetworkMode elevates for the duration of the callback', async () => {
    expect(getNetworkMode()).toBe('off');
    await withNetworkMode('salesforce-read', async () => {
      expect(getNetworkMode()).toBe('salesforce-read');
      expect(assertNetworkAllowed({ purpose: 'live-query' }).ok).toBe(true);
    });
    expect(getNetworkMode()).toBe('off');
  });

  it('model-download is always denied at runtime', async () => {
    vi.stubEnv('SFI_NETWORK_MODE', 'salesforce-read');
    expect(assertNetworkAllowed({ purpose: 'model-download' }).ok).toBe(false);
    await withNetworkMode('updates-only', async () => {
      expect(assertNetworkAllowed({ purpose: 'model-download' }).ok).toBe(false);
    });
  });

  it('SFI_NO_UPDATE_CHECK forces update-check deny even when opted in', () => {
    vi.stubEnv('SFI_UPDATE_CHECK', '1');
    vi.stubEnv('SFI_NO_UPDATE_CHECK', '1');
    const r = assertNetworkAllowed({ purpose: 'update-check' });
    expect(r.ok).toBe(false);
  });
});
