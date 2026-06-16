/// <reference types="vitest/globals" />

import {
  analyzeIdKeyConsistency,
  analyzeOutputShape,
  buildBaseline,
  buildOutputShapeBaseline,
  CANONICAL_ID_KEY,
  isIdKey,
  type OutputShapeSample,
  type ToolLike,
} from '../src/response-consistency.js';

const tool = (name: string, props: string[]): ToolLike => ({
  name,
  inputSchema: { properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) },
});

describe('isIdKey', () => {
  it('matches bare `id` and `*Id` names', () => {
    expect(isIdKey('id')).toBe(true);
    expect(isIdKey('componentId')).toBe(true);
    expect(isIdKey('fieldId')).toBe(true);
  });

  it('rejects non-id keys (including words that merely end in lowercase "id")', () => {
    expect(isIdKey('hops')).toBe(false);
    expect(isIdKey('objectApiName')).toBe(false);
    expect(isIdKey('valid')).toBe(false);
    expect(isIdKey('format')).toBe(false);
  });
});

describe('analyzeIdKeyConsistency', () => {
  const baseline = {
    canonicalKey: CANONICAL_ID_KEY,
    allowed: { fieldId: ['sfi.field_360'], rootId: ['sfi.get_subgraph'] },
  };

  it('allows the canonical key on any tool', () => {
    const { violations } = analyzeIdKeyConsistency([tool('sfi.brand_new', ['componentId'])], baseline);
    expect(violations).toEqual([]);
  });

  it('allows a grandfathered (key, tool) pair', () => {
    const { violations } = analyzeIdKeyConsistency([tool('sfi.field_360', ['fieldId'])], baseline);
    expect(violations).toEqual([]);
  });

  it('flags a NEW tool that invents a non-canonical id key', () => {
    const { violations } = analyzeIdKeyConsistency([tool('sfi.brand_new', ['widgetId'])], baseline);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.tool).toBe('sfi.brand_new');
    expect(violations[0]!.key).toBe('widgetId');
    expect(violations[0]!.message).toContain(CANONICAL_ID_KEY);
  });

  it('flags an existing grandfathered key adopted by a DIFFERENT (new) tool', () => {
    // fieldId is grandfathered for field_360 only; a new tool using it is drift.
    const { violations } = analyzeIdKeyConsistency([tool('sfi.new_field_tool', ['fieldId'])], baseline);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.key).toBe('fieldId');
  });

  it('records every id key in idKeyMap (and ignores non-id props)', () => {
    const { idKeyMap } = analyzeIdKeyConsistency(
      [tool('sfi.a', ['componentId', 'hops']), tool('sfi.b', ['fieldId'])],
      baseline,
    );
    expect(idKeyMap['componentId']).toEqual(['sfi.a']);
    expect(idKeyMap['fieldId']).toEqual(['sfi.b']);
    expect(idKeyMap['hops']).toBeUndefined();
  });
});

describe('buildBaseline', () => {
  const tools = [
    tool('sfi.get_impact', ['componentId', 'hops']),
    tool('sfi.field_360', ['fieldId']),
    tool('sfi.find_apex_usages', ['targetId']),
  ];

  it('excludes the canonical key and groups non-canonical keys by tool', () => {
    const b = buildBaseline(tools);
    expect(b.canonicalKey).toBe(CANONICAL_ID_KEY);
    expect(b.allowed['componentId']).toBeUndefined();
    expect(b.allowed['fieldId']).toEqual(['sfi.field_360']);
    expect(b.allowed['targetId']).toEqual(['sfi.find_apex_usages']);
  });

  it('round-trips: a roster checked against its own baseline has zero violations', () => {
    const { violations } = analyzeIdKeyConsistency(tools, buildBaseline(tools));
    expect(violations).toEqual([]);
  });
});

const sample = (tool: string, rowKeys: string[]): OutputShapeSample => ({ tool, rowKeys });

describe('analyzeOutputShape (P11-api-response-output-shape)', () => {
  const baseline = buildOutputShapeBaseline([
    sample('sfi.unused_components', ['id', 'type', 'reason']),
    sample('sfi.safe_to_delete_field', ['id', 'reason']),
  ]);

  it('allows the canonical componentId in output rows', () => {
    const { violations } = analyzeOutputShape([sample('sfi.brand_new', ['componentId', 'label'])], baseline);
    expect(violations).toEqual([]);
  });

  it('allows a grandfathered (tool, key) output pair', () => {
    const { violations } = analyzeOutputShape([sample('sfi.unused_components', ['id', 'type'])], baseline);
    expect(violations).toEqual([]);
  });

  it('flags a NEW tool that emits a non-canonical id key in its rows', () => {
    const { violations } = analyzeOutputShape([sample('sfi.brand_new', ['recordId', 'name'])], baseline);
    expect(violations.length).toBe(1);
    expect(violations[0]?.key).toBe('recordId');
  });

  it('flags an existing tool emitting an id key it was not grandfathered for', () => {
    // unused_components is grandfathered for `id`, NOT for `fieldId`.
    const { violations } = analyzeOutputShape([sample('sfi.unused_components', ['fieldId'])], baseline);
    expect(violations.length).toBe(1);
    expect(violations[0]?.key).toBe('fieldId');
  });

  it('ignores non-id row keys', () => {
    const { violations } = analyzeOutputShape([sample('sfi.brand_new', ['label', 'reason', 'count'])], baseline);
    expect(violations).toEqual([]);
  });

  it('round-trips: samples checked against their own baseline have zero violations', () => {
    const samples = [
      sample('sfi.unused_components', ['id', 'type']),
      sample('sfi.field_360', ['fieldId', 'readers']),
    ];
    const { violations } = analyzeOutputShape(samples, buildOutputShapeBaseline(samples));
    expect(violations).toEqual([]);
  });
});
