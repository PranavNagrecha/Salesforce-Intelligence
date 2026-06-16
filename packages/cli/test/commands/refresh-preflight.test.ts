/// <reference types="vitest/globals" />

import {
  assessRefreshSize,
  LARGE_ORG_COMPONENT_THRESHOLD,
} from '../../src/commands/refresh-preflight.js';

describe('assessRefreshSize (P12-FIRSTRUN-refresh-preflight)', () => {
  it('warns with a --types hint when the prior refresh was large and unscoped', () => {
    const r = assessRefreshSize({ priorComponentCount: LARGE_ORG_COMPONENT_THRESHOLD + 4000, scoped: false, noPull: false });
    expect(r.level).toBe('warn');
    expect(r.message).toMatch(/--types/);
    expect(r.message).toMatch(/7,000|7000/); // count (3000 threshold + 4000) is surfaced
  });

  it('is QUIET for a small org', () => {
    const r = assessRefreshSize({ priorComponentCount: 250, scoped: false, noPull: false });
    expect(r.level).toBe('quiet');
    expect(r.message).toBeNull();
  });

  it('is QUIET when the user already scoped with --types (no nagging)', () => {
    const r = assessRefreshSize({ priorComponentCount: 99999, scoped: true, noPull: false });
    expect(r.level).toBe('quiet');
  });

  it('is QUIET on --no-pull (no network retrieve to warn about)', () => {
    const r = assessRefreshSize({ priorComponentCount: 99999, scoped: false, noPull: true });
    expect(r.level).toBe('quiet');
  });

  it('gives a first-refresh NOTE (no prior count) with a scoping hint', () => {
    const r = assessRefreshSize({ priorComponentCount: null, scoped: false, noPull: false });
    expect(r.level).toBe('note');
    expect(r.message).toMatch(/first full refresh/i);
    expect(r.message).toMatch(/--types/);
  });
});
