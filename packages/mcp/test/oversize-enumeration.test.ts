/// <reference types="vitest/globals" />

import {
  analyzeOversizeEnumeration,
  HIGH_FANOUT_INVENTORY,
  type HighFanoutBoundKind,
} from '../src/oversize-enumeration.js';
import type { ToolLike } from '../src/response-consistency.js';

const tool = (name: string, props: string[]): ToolLike => ({
  name,
  inputSchema: { properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) },
});

const allProbes = (): ReadonlySet<string> => new Set(Object.keys(HIGH_FANOUT_INVENTORY));

describe('analyzeOversizeEnumeration', () => {
  it('passes when every inventory tool exists, is paginated where tagged, and has a probe', () => {
    const tools = Object.keys(HIGH_FANOUT_INVENTORY).map((name) => {
      const entry = HIGH_FANOUT_INVENTORY[name]!;
      const props =
        entry.bound === 'paginated'
          ? ['componentId', 'limit', 'offset']
          : entry.bound === 'graph-payload-budget'
            ? ['rootId', 'hops']
            : ['componentId'];
      return tool(name, props);
    });
    const { violations } = analyzeOversizeEnumeration(tools, allProbes());
    expect(violations).toEqual([]);
  });

  it('flags a paginated inventory tool whose schema lacks limit', () => {
    const tools = Object.keys(HIGH_FANOUT_INVENTORY).map((name) => {
      if (name === 'sfi.get_edges') return tool(name, ['nodeId']);
      const entry = HIGH_FANOUT_INVENTORY[name]!;
      const props = entry.bound === 'paginated' ? ['limit'] : ['componentId'];
      return tool(name, props);
    });
    const { violations } = analyzeOversizeEnumeration(tools, allProbes());
    const edgeViolations = violations.filter((v) => v.tool === 'sfi.get_edges');
    expect(edgeViolations).toHaveLength(1);
    expect(edgeViolations[0]!.message).toContain('lacks a `limit`');
  });

  it('flags an inventory tool with no high-fanout probe', () => {
    const tools = [tool('sfi.get_edges', ['nodeId', 'limit'])];
    const { violations } = analyzeOversizeEnumeration(
      tools,
      new Set(['sfi.get_edges']),
    );
    expect(violations.some((v) => v.tool === 'sfi.get_edges' && v.message.includes('HIGH_FANOUT'))).toBe(
      false,
    );
    const { violations: noProbe } = analyzeOversizeEnumeration(tools, new Set());
    expect(noProbe.some((v) => v.tool === 'sfi.get_edges' && v.message.includes('HIGH_FANOUT'))).toBe(
      true,
    );
  });

  it('flags a NEW limit tool outside inventory and exclusions', () => {
    const tools = [
      ...Object.keys(HIGH_FANOUT_INVENTORY).map((name) => tool(name, ['limit'])),
      tool('sfi.brand_new_enum', ['limit']),
    ];
    const probes = new Set([...Object.keys(HIGH_FANOUT_INVENTORY), 'sfi.brand_new_enum']);
    const { violations } = analyzeOversizeEnumeration(tools, probes);
    const brandViolations = violations.filter((v) => v.tool === 'sfi.brand_new_enum');
    expect(brandViolations).toHaveLength(1);
    expect(brandViolations[0]!.tool).toBe('sfi.brand_new_enum');
  });

  it('inventory bound kinds cover the four strategies', () => {
    const kinds = new Set<HighFanoutBoundKind>(
      Object.values(HIGH_FANOUT_INVENTORY).map((e) => e.bound),
    );
    expect(kinds.has('paginated')).toBe(true);
    expect(kinds.has('graph-payload-budget')).toBe(true);
    expect(kinds.has('handler-capped')).toBe(true);
    expect(kinds.has('global-response-budget')).toBe(true);
  });
});
