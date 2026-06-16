/// <reference types="vitest/globals" />

import { edgeCallsMethod, edgeMethods } from '../../src/tools/calls-apex-methods.js';

describe('calls-apex-methods', () => {
  it('reads methods[] when present', () => {
    expect(
      edgeMethods({
        properties: { methods: ['deleteRecord', 'save'], methodName: 'deleteRecord' },
      }),
    ).toEqual(['deleteRecord', 'save']);
  });

  it('falls back to scalar methodName for pre-P4-C5 edges', () => {
    expect(edgeMethods({ properties: { methodName: 'save' } })).toEqual(['save']);
  });

  it('edgeCallsMethod matches methods[] membership', () => {
    const edge = { properties: { methods: ['deleteRecord', 'save'] } };
    expect(edgeCallsMethod(edge, 'deleteRecord')).toBe(true);
    expect(edgeCallsMethod(edge, 'update')).toBe(false);
  });
});
