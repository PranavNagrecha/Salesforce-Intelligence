/// <reference types="vitest/globals" />

import {
  HYBRID_DISCLOSURE,
  hybridTrust,
  renderHybridStalenessWarning,
  weakestConfidence,
  type HybridStaleness,
} from '../../src/tools/hybrid-trust.js';

describe('hybridTrust (P6-hybrid-trust)', () => {
  const base = {
    vaultRefreshedAt: '2026-06-02T19:02:05.214Z',
    liveQueriedAt: '2026-06-03T08:00:00.000Z',
    vaultConfidence: 'parsed' as const,
  };

  it('stamps provenance hybrid with BOTH planes freshness', () => {
    const t = hybridTrust(base);
    expect(t.provenance).toBe('hybrid');
    expect(t.freshness.snapshotRefreshedAt).toBe(base.vaultRefreshedAt);
    expect(t.freshness.liveQueriedAt).toBe(base.liveQueriedAt);
  });

  it('collapses confidence to the WEAKER plane (live is declared, so tracks the vault)', () => {
    expect(hybridTrust({ ...base, vaultConfidence: 'parsed' }).confidence).toBe('parsed');
    expect(hybridTrust({ ...base, vaultConfidence: 'heuristic' }).confidence).toBe(
      'heuristic',
    );
    // A declared vault plane fused with a declared live plane stays declared.
    expect(hybridTrust({ ...base, vaultConfidence: 'declared' }).confidence).toBe(
      'declared',
    );
    // An unknown vault plane is the weakest — the fused answer must not over-claim.
    expect(hybridTrust({ ...base, vaultConfidence: 'unknown' }).confidence).toBe(
      'unknown',
    );
  });

  it('carries the hybrid disclosure first in limitations, plus any caller limitations', () => {
    const t = hybridTrust({ ...base, limitations: ['custom caveat'] });
    expect(t.limitations[0]).toBe(HYBRID_DISCLOSURE);
    expect(t.limitations).toContain('custom caveat');
  });

  it('defaults completeness to unknown and omits staleness when not provided', () => {
    const t = hybridTrust(base);
    expect(t.completeness.status).toBe('unknown');
    expect(t.staleness).toBeUndefined();
  });

  it('threads the staleness block through when provided (P6-stale-guard-hybrid)', () => {
    const staleness: HybridStaleness = {
      vaultStale: true,
      driftCount: 129,
      checkedTypes: ['ApexClass', 'CustomField'],
      warning: 'stale!',
    };
    const t = hybridTrust({ ...base, staleness });
    expect(t.staleness).toEqual(staleness);
  });
});

describe('weakestConfidence', () => {
  it('returns the more cautious tier in any order', () => {
    expect(weakestConfidence('declared', 'heuristic')).toBe('heuristic');
    expect(weakestConfidence('heuristic', 'declared')).toBe('heuristic');
    expect(weakestConfidence('parsed', 'unknown')).toBe('unknown');
    expect(weakestConfidence('declared', 'declared')).toBe('declared');
  });
});

describe('renderHybridStalenessWarning (P6-stale-guard-hybrid)', () => {
  it('leads with a drift warning + count when the vault is stale', () => {
    const warning = renderHybridStalenessWarning({
      vaultStale: true,
      driftCount: 129,
      checkedTypes: ['ApexClass', 'Flow', 'CustomField'],
      warning: null,
    });
    expect(warning).not.toBeNull();
    expect(warning).toContain('129');
    expect(warning).toContain('/sfi-refresh');
  });

  it('returns null when the vault is current — nothing to lead with', () => {
    const warning = renderHybridStalenessWarning({
      vaultStale: false,
      driftCount: 0,
      checkedTypes: ['ApexClass'],
      warning: null,
    });
    expect(warning).toBeNull();
  });
});
