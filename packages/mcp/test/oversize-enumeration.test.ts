/// <reference types="vitest/globals" />

import {
  analyzeOversizeEnumeration,
  HIGH_FANOUT_INVENTORY,
  LIMIT_TOOL_EXCLUSIONS,
  type HighFanoutBoundKind,
} from '../src/oversize-enumeration.js';
import type { ToolLike } from '../src/response-consistency.js';
import { V01_TOOLS } from '../src/tools/index.js';

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

  // CR-22 regression: the strengthened `paginated`-requires-a-resume-knob audit
  // must pass against the REAL roster schemas, not only synthesized tools. The
  // synthesized happy-path test above always stamps `offset`, so it gave false
  // confidence while 22 real top-N truncators were mislabeled `paginated`. This
  // pins the gate at the unit level (the qa harness checks the same thing with
  // a real high-fanout org probe set).
  // CR-P3 (oversize-enumeration): code_quality_audit, find_hardcoded_values,
  // and governor_limit_risks gained REAL cursors (B3) — they expose
  // limit+offset+cursor and window past the per-type cap. They must be
  // classified `paginated` (consistent with the other cursored tools), not
  // handler-capped / wholly excluded, so they carry the high-fanout probe
  // requirement instead of silently skipping it.
  it('FAIL-BEFORE/PASS-AFTER: the 3 B3-cursored quality tools are inventoried as paginated', () => {
    for (const name of [
      'sfi.code_quality_audit',
      'sfi.find_hardcoded_values',
      'sfi.governor_limit_risks',
    ]) {
      const entry = HIGH_FANOUT_INVENTORY[name];
      expect(entry, `${name} must be in HIGH_FANOUT_INVENTORY`).toBeDefined();
      expect(entry?.bound, `${name} must be paginated`).toBe('paginated');
    }
  });

  it('FAIL-BEFORE/PASS-AFTER: code_quality_audit is no longer in LIMIT_TOOL_EXCLUSIONS', () => {
    expect(LIMIT_TOOL_EXCLUSIONS.has('sfi.code_quality_audit')).toBe(false);
  });

  it('the 3 B3-cursored quality tools each expose limit+offset+cursor in V01_TOOLS', () => {
    const roster = new Map(V01_TOOLS.map((t) => [t.name, t]));
    for (const name of [
      'sfi.code_quality_audit',
      'sfi.find_hardcoded_values',
      'sfi.governor_limit_risks',
    ]) {
      const props = (roster.get(name)?.inputSchema?.properties ?? {}) as Record<
        string,
        unknown
      >;
      expect(props['limit'], `${name} limit`).toBeDefined();
      expect(props['offset'], `${name} offset`).toBeDefined();
      expect(props['cursor'], `${name} cursor`).toBeDefined();
    }
  });

  // 0.2.0 gate regression: record_creation_paths and flow_fault_audit shipped
  // with a `limit` input but were never registered in HIGH_FANOUT_INVENTORY,
  // so the release gate (check-oversize-enumeration.mjs) flagged them as
  // unaudited enumerators.
  //
  // The INVARIANT this pinned — and still pins below — is: a tool with a
  // `limit` is REGISTERED, and its `bound` tells the truth about whether the
  // dropped tail is reachable. A limit-capped truncator with NO resume knob is
  // `handler-capped`; a tool with a real resume knob is `paginated`.
  //
  // SPLIT by FIX 4. `record_creation_paths` is untouched and keeps its
  // `handler-capped` pin below — it is still a limit-only truncator.
  // `flow_fault_audit` gained a REAL resume knob (offset + CR-22 cursor +
  // handler-side byte budget), so `handler-capped` became right-about-
  // yesterday: the classification moves to `paginated` in the same change that
  // added the knob, and the sibling assertion further down ("every `paginated`
  // inventory tool exposes a real resume knob in V01_TOOLS") now covers it.
  it('FAIL-BEFORE/PASS-AFTER: record_creation_paths is a limit-only truncator, inventoried as handler-capped', () => {
    const name = 'sfi.record_creation_paths';
    const entry = HIGH_FANOUT_INVENTORY[name];
    expect(entry, `${name} must be in HIGH_FANOUT_INVENTORY`).toBeDefined();
    expect(entry?.bound, `${name} must be handler-capped`).toBe('handler-capped');
    expect(LIMIT_TOOL_EXCLUSIONS.has(name), `${name} must not be excluded`).toBe(false);
  });

  it('FAIL-BEFORE/PASS-AFTER: flow_fault_audit has a real resume knob, so it is inventoried as paginated', () => {
    const name = 'sfi.flow_fault_audit';
    const entry = HIGH_FANOUT_INVENTORY[name];
    expect(entry, `${name} must be in HIGH_FANOUT_INVENTORY`).toBeDefined();
    expect(entry?.bound, `${name} must be paginated`).toBe('paginated');
    expect(LIMIT_TOOL_EXCLUSIONS.has(name), `${name} must not be excluded`).toBe(false);
  });

  // FIX 14: `meaningful_test_audit` gained `limit`, which brings it into scope
  // for this gate. Registering it in the SAME change is the point — the 0.2.0
  // regression above was exactly a `limit` shipping without an inventory row.
  it('FAIL-BEFORE/PASS-AFTER: meaningful_test_audit is registered as paginated', () => {
    const name = 'sfi.meaningful_test_audit';
    const entry = HIGH_FANOUT_INVENTORY[name];
    expect(entry, `${name} must be in HIGH_FANOUT_INVENTORY`).toBeDefined();
    expect(entry?.bound, `${name} must be paginated`).toBe('paginated');
    expect(LIMIT_TOOL_EXCLUSIONS.has(name), `${name} must not be excluded`).toBe(false);
  });

  it('every `paginated` inventory tool exposes a real resume knob in V01_TOOLS', () => {
    const roster = new Map(V01_TOOLS.map((t) => [t.name, t]));
    const offenders: string[] = [];
    for (const [name, entry] of Object.entries(HIGH_FANOUT_INVENTORY)) {
      if (entry.bound !== 'paginated') continue;
      const props = roster.get(name)?.inputSchema?.properties ?? {};
      const hasLimit = (props as Record<string, unknown>)['limit'] !== undefined;
      const hasResume =
        (props as Record<string, unknown>)['offset'] !== undefined ||
        (props as Record<string, unknown>)['cursor'] !== undefined;
      if (!hasLimit || !hasResume) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
