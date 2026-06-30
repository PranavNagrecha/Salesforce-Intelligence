/// <reference types="vitest/globals" />

/**
 * I1 contract: every funnel ToolCandidate carries its OWN plane + liveRequired,
 * so a host LLM can read the consent requirement from the candidate alone. This
 * test is the GUARD that catches a future `live`/`hybrid` tool that does not
 * match the `live_` name prefix and was never added to the explicit overrides —
 * it would silently default to `vault`/`liveRequired:false`, a consent FALSE-
 * NEGATIVE (telling a host no live access is needed when it is).
 */
import {
  getPlaneByTool,
  resolveCandidatePlane,
  semanticCandidates,
} from '../src/semantic-funnel.js';
import { V01_TOOLS } from '../src/tools/index.js';

const PLANES = new Set(['vault', 'live', 'hybrid']);

describe('PLANE_BY_TOOL coverage (I1)', () => {
  const planeByTool = getPlaneByTool();

  it('resolves a defined plane for EVERY tool in V01_TOOLS', () => {
    for (const tool of V01_TOOLS) {
      const entry = planeByTool.get(tool.name);
      expect(entry, `missing plane for ${tool.name}`).toBeDefined();
      expect(PLANES.has(entry!.plane), `bad plane '${entry?.plane}' for ${tool.name}`).toBe(true);
    }
  });

  it('leaves NO tool at the sentinel planes (unknown / knowledge never reach a candidate)', () => {
    for (const tool of V01_TOOLS) {
      const entry = planeByTool.get(tool.name)!;
      expect(entry.plane).not.toBe('unknown');
      expect(entry.plane).not.toBe('knowledge');
    }
  });

  it('classifies every /^sfi\\.live_/ tool as live + liveRequired', () => {
    const livePrefixed = V01_TOOLS.filter((t) => /^sfi\.live_/.test(t.name));
    expect(livePrefixed.length).toBeGreaterThan(0); // sanity: the roster has live tools
    for (const tool of livePrefixed) {
      const entry = planeByTool.get(tool.name)!;
      expect(entry.plane, tool.name).toBe('live');
      expect(entry.liveRequired, tool.name).toBe(true);
    }
  });

  it('classifies the documented non-prefixed live tool blast_radius_live as live', () => {
    // It issues a live COUNT but is NOT named live_*, so only the explicit
    // override keeps it from defaulting to vault.
    const entry = planeByTool.get('sfi.blast_radius_live');
    expect(entry, 'sfi.blast_radius_live must be in the roster').toBeDefined();
    expect(entry!.plane).toBe('live');
    expect(entry!.liveRequired).toBe(true);
  });

  it('ties liveRequired to the plane: true iff live, false for vault + hybrid', () => {
    for (const tool of V01_TOOLS) {
      const entry = planeByTool.get(tool.name)!;
      // hybrid answers from vault (its live companion is a separate candidate),
      // so liveRequired is true ONLY for live-plane tools.
      expect(entry.liveRequired, tool.name).toBe(entry.plane === 'live');
    }
  });

  it('hybrid tools require NO consent (liveRequired false) — they answer from vault', () => {
    for (const name of ['sfi.field_cleanup_candidates', 'sfi.unused_fields_deep']) {
      const entry = planeByTool.get(name)!;
      expect(entry.plane, name).toBe('hybrid');
      expect(entry.liveRequired, name).toBe(false);
    }
  });

  it('resolveCandidatePlane agrees with the map for roster tools and defaults vault off-roster', () => {
    const sample = V01_TOOLS[0]!;
    expect(resolveCandidatePlane(sample.name)).toEqual(planeByTool.get(sample.name));
    // Off-roster, non-live name -> vault default.
    expect(resolveCandidatePlane('sfi.__not_a_real_tool__')).toEqual({
      plane: 'vault',
      liveRequired: false,
    });
    // Off-roster live_ name still resolves live by prefix.
    expect(resolveCandidatePlane('sfi.live___not_real__')).toEqual({
      plane: 'live',
      liveRequired: true,
    });
  });
});

describe('every semantic candidate carries the I1 fields', () => {
  it('stamps plane + liveRequired + confidence on each scored candidate', () => {
    const cands = semanticCandidates('who can edit the SSN field on Account', 8);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(PLANES.has(c.plane), `bad plane ${c.plane} for ${c.tool}`).toBe(true);
      expect(typeof c.liveRequired).toBe('boolean');
      expect(['high', 'medium', 'low']).toContain(c.confidence);
      // liveRequired is true only for live-plane candidates (hybrid answers from vault).
      expect(c.liveRequired).toBe(c.plane === 'live');
    }
  });

  it('a live-leaning question surfaces a live candidate with liveRequired true', () => {
    const cands = semanticCandidates('how many Account records are there', 8);
    const live = cands.find((c) => c.plane === 'live');
    if (live !== undefined) expect(live.liveRequired).toBe(true);
  });
});
