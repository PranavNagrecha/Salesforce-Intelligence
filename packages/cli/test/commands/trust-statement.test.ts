/// <reference types="vitest/globals" />

import { formatTrustStatement, TRUST_GUARANTEES } from '../../src/commands/trust-statement.js';

describe('trust statement', () => {
  it('states the read-only / offline / local / live-off / no-org-data guarantees', () => {
    // Assert against the un-wrapped guarantee data — the notice soft-wraps
    // details across lines, which would split multi-word phrases.
    const text = TRUST_GUARANTEES.map((g) => `${g.headline} ${g.detail}`).join(' ').toLowerCase();
    expect(text).toContain('read-only');
    expect(text).toContain('never writes'); // no write to the org
    expect(text).toContain('offline');
    expect(text).toContain('never uploaded'); // vault stays on this machine
    expect(text).toContain('live plane is off until you turn it on'); // live plane off by default
    expect(text).toContain('ships no org data'); // npm package
    expect(text).toContain('leak audit'); // cites the audit
  });

  it('renders every guarantee headline as a checked box', () => {
    const text = formatTrustStatement();
    for (const g of TRUST_GUARANTEES) {
      expect(text).toContain(`✓ ${g.headline}`);
    }
    // The five standing guarantees, no fewer.
    expect(TRUST_GUARANTEES.length).toBe(5);
  });
});
