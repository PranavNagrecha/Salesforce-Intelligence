/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { registerVault } from '@sf-intelligence/vault';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import { fleetDriftRankingHandler } from '../../src/tools/fleet-drift-ranking.js';
import { STALE_CHECK_TYPES } from '../../src/tools/live-plane.js';
import { resetLiveSession } from '../../src/tools/live-session.js';
import { grantTestLiveAccess } from '../helpers/live-test-grant.js';

// Synthetic-only fixtures (no real org names): two registered vaults whose
// `sourceOrg` differs in live drift; a mocked `sf` CLI returns the drift count.

const mkVault = (root: string, alias: string, sourceOrg: string): string => {
  const dir = join(root, alias);
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const manifest: VaultManifest = {
    version: '0.1.0',
    refreshedAt: '2026-01-01T00:00:00.000Z',
    sourceOrg,
    components: { CustomObject: 1 },
    edges: {},
    sourceTreeHash: `sha256:${alias}`,
  };
  writeFileSync(join(dir, 'meta', 'manifest.json'), JSON.stringify(manifest));
  return dir;
};

// Each staleness query returns { result: { totalSize } }; drift varies by org.
const driftByOrg: Record<string, number> = { 'acme-prod': 5, 'acme-sandbox': 0 };
const mockExec: ExecCommand = async (_bin, args) => {
  const i = args.indexOf('--target-org');
  const org = (i >= 0 ? args[i + 1] : '') ?? '';
  return {
    stdout: JSON.stringify({ result: { totalSize: driftByOrg[org] ?? 0 } }),
    stderr: '',
  };
};

const CTX_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-01-01T00:00:00.000Z',
  sourceOrg: 'acme-prod',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:ctx',
};

let tmpRoot: string;
let ctx: Context;
const ENV_REGISTRY = 'SF_INTELLIGENCE_REGISTRY_PATH';
const ENV_BUDGET = 'SFI_LIVE_QUERY_BUDGET';
const ENV_PLANE = 'SFI_LIVE_PLANE_ENABLED';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sfi-fleet-drift-'));
  const vProd = mkVault(tmpRoot, 'acme-prod', 'acme-prod');
  const vSand = mkVault(tmpRoot, 'acme-sandbox', 'acme-sandbox');
  const r1 = await registerVault(tmpRoot, 'acme-prod', vProd);
  if (!r1.ok) throw new Error(r1.error.message);
  const r2 = await registerVault(tmpRoot, 'acme-sandbox', vSand);
  if (!r2.ok) throw new Error(r2.error.message);
  ctx = {
    vaultRoot: vProd,
    manifest: CTX_MANIFEST,
    graph: {} as Context['graph'],
    liveCapability: mintLiveCapability('primary'),
  };
});

beforeEach(() => {
  for (const k of [ENV_REGISTRY, ENV_BUDGET, ENV_PLANE]) saved[k] = process.env[k];
  process.env[ENV_REGISTRY] = tmpRoot;
  delete process.env[ENV_PLANE]; // never auto-enable the live plane in these tests
  delete process.env[ENV_BUDGET];
  resetLiveSession();
});
afterEach(() => {
  for (const k of [ENV_REGISTRY, ENV_BUDGET, ENV_PLANE]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('fleetDriftRankingHandler', () => {
  it('without consent, every vault is an honest no-consent skip (zero live calls)', async () => {
    let calls = 0;
    const spy: ExecCommand = async (bin, args) => {
      calls += 1;
      return mockExec(bin, args);
    };
    const r = await fleetDriftRankingHandler(ctx, {}, spy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.registeredVaultCount).toBe(2);
    expect(d.ranking).toEqual([]);
    expect(d.skipped.map((s) => s.reason)).toEqual(['no-consent', 'no-consent']);
    expect(calls).toBe(0);
    expect(d.trust.provenance).toBe('offline_snapshot');
  });

  const withFleetConsent = async <T>(fn: () => Promise<T>): Promise<T> => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sfi-fleet-consent-'));
    const prev = process.env.SFI_CONSENT_PATH;
    process.env.SFI_CONSENT_PATH = join(dir, 'c.json');
    await grantTestLiveAccess('acme-prod');
    await grantTestLiveAccess('acme-sandbox');
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.SFI_CONSENT_PATH;
      else process.env.SFI_CONSENT_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('with liveEnabled, ranks vaults by drift descending and recommends the most-behind', async () => {
    await withFleetConsent(async () => {
      const r = await fleetDriftRankingHandler(ctx, { liveEnabled: true }, mockExec);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      expect(d.ranking.map((x) => x.alias)).toEqual(['acme-prod', 'acme-sandbox']);
      expect(d.ranking[0]?.driftCount).toBe(5 * STALE_CHECK_TYPES.length); // 5 per checked type
      expect(d.ranking[0]?.vaultStale).toBe(true);
      expect(d.ranking[0]?.provenance).toBe('live_org');
      expect(d.ranking[1]?.driftCount).toBe(0);
      expect(d.mostDrifted).toEqual({ alias: 'acme-prod', driftCount: 5 * STALE_CHECK_TYPES.length });
      expect(d.recommendation).toMatch(/acme-prod/);
      expect(d.trust.provenance).toBe('live_org');
    });
  });

  it('degrades to a budget-exhausted skip instead of overrunning the API budget', async () => {
    await withFleetConsent(async () => {
      process.env[ENV_BUDGET] = String(STALE_CHECK_TYPES.length); // enough for exactly ONE vault
      resetLiveSession();
      const r = await fleetDriftRankingHandler(ctx, { liveEnabled: true }, mockExec);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      expect(d.ranking.length).toBe(1);
      expect(d.skipped.some((s) => s.reason === 'budget-exhausted')).toBe(true);
      expect(d.trust.completeness.status).toBe('partial');
    });
  });

  it('the `vaults` subset narrows the sweep', async () => {
    await withFleetConsent(async () => {
      const r = await fleetDriftRankingHandler(
        ctx,
        { liveEnabled: true, vaults: ['acme-sandbox'] },
        mockExec,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.ranking.map((x) => x.alias)).toEqual(['acme-sandbox']);
    });
  });
});
