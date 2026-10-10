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

// FR-06 — FAIL-BEFORE/PASS-AFTER: the statement claimed "The org is contacted
// only when you run `sfi refresh`", but `sfi doctor` checks the login against
// the org. The statement must name every command that contacts it.
describe('trust statement names every org-contacting command (FR-06)', () => {
  it('does not claim refresh is the only contact', () => {
    const offline = TRUST_GUARANTEES.find((g) => g.headline.startsWith('OFFLINE'));
    expect(offline?.detail).not.toMatch(/contacted only when you run/);
    expect(offline?.detail).toContain('sfi doctor');
    expect(offline?.detail).toContain('--no-pull');
  });
});

// FR-06 follow-up — FAIL-BEFORE/PASS-AFTER: the statement listed refresh and
// doctor but not `sfi stale-sweep` (a Tooling SOQL against the org, also run
// by `sfi watch`), and said `--no-pull` "rebuilds without contacting the org"
// although --with-audit-trail / --with-tooling-api still query it.
describe('trust statement enumerates stale-sweep and does not over-claim --no-pull', () => {
  it('names stale-sweep / watch and drops the blanket --no-pull claim', () => {
    const offline = TRUST_GUARANTEES.find((g) => g.headline.startsWith('OFFLINE'));
    expect(offline?.detail).toContain('sfi stale-sweep');
    expect(offline?.detail).toContain('sfi watch');
    expect(offline?.detail).not.toMatch(/without contacting the org/);
  });
});
