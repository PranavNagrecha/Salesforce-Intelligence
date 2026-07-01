/// <reference types="vitest/globals" />

import { ORG_ALIAS_RE, validateOrgAlias } from '../../src/commands/org-alias.js';

describe('org-alias validation (CR-01 / C1)', () => {
  // Real `sf` aliases and email-style usernames must pass unchanged.
  const ACCEPT = ['prod', 'MyOrg', 'me@example.com', 'my-sandbox', 'a.b_c@d-e.org', 'me@my-sandbox.example.com'];
  // The PoC payload from the brief plus a battery of shell metacharacters.
  const REJECT = [
    'x" ; rm -rf ~ ; "',
    'a;b',
    'a b',
    'a`b`',
    'a$(touch pwned)',
    'a|b',
    'a&&b',
    'a>b',
    'a\nb',
    '',
  ];

  it.each(ACCEPT)('accepts the legitimate alias %j', (alias) => {
    expect(ORG_ALIAS_RE.test(alias)).toBe(true);
    const r = validateOrgAlias(alias);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(alias);
  });

  it.each(REJECT)('rejects the shell-metacharacter / empty alias %j', (alias) => {
    expect(ORG_ALIAS_RE.test(alias)).toBe(false);
    const r = validateOrgAlias(alias);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Invalid Salesforce org alias');
  });

  it('names the offending value in the error (so a poisoned config is diagnosable)', () => {
    const r = validateOrgAlias('x" ; rm -rf ~ ; "');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('rm -rf');
  });
});
