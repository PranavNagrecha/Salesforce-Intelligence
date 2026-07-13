/**
 * MCP-01 — every roster tool carries protocol ToolAnnotations with
 * readOnlyHint===true. Tools that can reach the live plane
 * (`livePlaneForTool(name) !== 'never'`) differ on openWorldHint — keyed off
 * the SEMANTIC registry tag, NOT the `sfi.live_*` name prefix.
 *
 * Not the vault curated-annotations overlay (`annotations.ts`).
 */
import { describe, expect, it } from 'vitest';

import { livePlaneForTool } from '../../src/live-capability.js';
import {
  advertisedTools,
  MCP_LIVE_TOOL_ANNOTATIONS,
  MCP_VAULT_TOOL_ANNOTATIONS,
  mcpProtocolAnnotationsFor,
  V01_TOOLS,
} from '../../src/tools/index.js';

describe('MCP-01 protocol tool annotations', () => {
  it('stamps annotations on every V01_TOOLS entry with readOnlyHint===true', () => {
    expect(V01_TOOLS.length).toBeGreaterThan(0);
    for (const tool of V01_TOOLS) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      expect(typeof tool.annotations.openWorldHint, tool.name).toBe('boolean');
    }
  });

  it('keys openWorldHint off the SEMANTIC livePlane tag, not the sfi.live_* prefix', () => {
    const live = V01_TOOLS.filter((t) => livePlaneForTool(t.name) !== 'never');
    const vault = V01_TOOLS.filter(
      (t) => livePlaneForTool(t.name) === 'never',
    );
    expect(live.length).toBeGreaterThan(0);
    expect(vault.length).toBeGreaterThan(0);

    // Every roster tool: openWorldHint === (it can reach the live plane).
    for (const tool of V01_TOOLS) {
      expect(tool.annotations.openWorldHint, tool.name).toBe(
        livePlaneForTool(tool.name) !== 'never',
      );
    }
    for (const tool of live) {
      expect(tool.annotations, tool.name).toEqual(MCP_LIVE_TOOL_ANNOTATIONS);
      expect(tool.annotations.openWorldHint, tool.name).toBe(true);
    }
    for (const tool of vault) {
      expect(tool.annotations, tool.name).toEqual(MCP_VAULT_TOOL_ANNOTATIONS);
      expect(tool.annotations.openWorldHint, tool.name).toBe(false);
    }
  });

  it('labels live-reaching tools WITHOUT the sfi.live_ prefix as openWorld (MCP-01 mislabel fix)', () => {
    // These six reach the live org but lack the `live_` prefix; the old
    // lexical `startsWith('sfi.live_')` guess mislabeled them openWorld:false.
    for (const name of [
      'sfi.blast_radius_live',
      'sfi.fleet_drift_ranking',
      'sfi.coverage_report',
      'sfi.what_if_make_field_required',
      'sfi.unused_fields_deep',
      'sfi.field_cleanup_candidates',
    ] as const) {
      const tool = V01_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(name.startsWith('sfi.live_'), name).toBe(false);
      expect(livePlaneForTool(name), name).not.toBe('never');
      expect(tool?.annotations.openWorldHint, name).toBe(true);
      expect(tool?.annotations.readOnlyHint, name).toBe(true);
      expect(tool?.annotations.destructiveHint, name).toBe(false);
    }
  });

  it('spot-checks a vault tool vs a live_* tool on openWorldHint', () => {
    const vault = V01_TOOLS.find((t) => t.name === 'sfi.annotations');
    const live = V01_TOOLS.find((t) => t.name === 'sfi.live_count');
    expect(vault?.annotations.openWorldHint).toBe(false);
    expect(live?.annotations.openWorldHint).toBe(true);
    expect(vault?.annotations.readOnlyHint).toBe(true);
    expect(live?.annotations.readOnlyHint).toBe(true);
  });

  it('keeps local vault writers Salesforce-read-only (openWorld false)', () => {
    for (const name of [
      'sfi.propose_annotation',
      'sfi.confirm_annotation',
      'sfi.reject_annotation',
      'sfi.baseline_acknowledge',
      'sfi.route_question',
    ] as const) {
      const tool = V01_TOOLS.find((t) => t.name === name);
      expect(tool?.annotations.readOnlyHint, name).toBe(true);
      expect(tool?.annotations.openWorldHint, name).toBe(false);
    }
  });

  it('advertisedTools carries the same annotations', () => {
    for (const tool of advertisedTools()) {
      expect(tool.annotations).toEqual(mcpProtocolAnnotationsFor(tool.name));
    }
  });
});
