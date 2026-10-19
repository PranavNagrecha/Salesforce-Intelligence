/// <reference types="vitest/globals" />

import { percent, summarize } from '../../src/tools/summarize-rows.js';

describe('summarize', () => {
  it('counts and totals from the same filtered rows', () => {
    const rows = [{ active: true }, { active: false }, { active: true }, { active: true }];
    const s = summarize(rows, (r) => r.active);
    expect(s.rows).toEqual([{ active: true }, { active: true }, { active: true }]);
    expect(s.count).toBe(3);
    expect(s.total).toBe(4);
    expect(percent(s.count, s.total)).toBe(75);
  });

  it('has no percent over zero rows: not measured, never "0%"', () => {
    const s = summarize([], () => true);
    expect(s.count).toBe(0);
    expect(s.total).toBe(0);
    expect(percent(s.count, s.total)).toBeNull();
  });
});
