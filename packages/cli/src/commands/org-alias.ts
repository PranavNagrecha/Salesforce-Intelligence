import { err, ok, type Result } from '@sf-intelligence/core';

/**
 * Allowed characters in a Salesforce org alias / username. Real `sf` aliases
 * and usernames use only letters, digits, and the four punctuation characters
 * `.`, `_`, `@`, and `-` (e.g. `prod`, `my-sandbox`, `me@example.com`,
 * `a.b_c@d-e.org`). Everything else — spaces, quotes, semicolons, backticks,
 * `$()`, pipes, redirects, ampersands, newlines — is rejected.
 *
 * This is the defense-in-depth gate behind the exec hardening (CR-01 / C1): the
 * `targetOrg` value is read from `--target-org` and the vault `config.json` and
 * was previously string-interpolated into shell `exec()` calls. The exec sites
 * are now `execFile('sf', argv)` (no shell), so a metacharacter alias is an
 * inert single argv element; this validator additionally rejects such an alias
 * at the boundary with a clear error instead of letting it fall through to `sf`.
 *
 * The anchored `+` rejects the empty string.
 */
export const ORG_ALIAS_RE = /^[A-Za-z0-9._@-]+$/;

/**
 * Validate a Salesforce org alias / username, returning the alias on success
 * or a human-readable error string on failure (the `Result` error channel,
 * for callers that surface it as `fatalError`).
 *
 * @example
 *   validateOrgAlias('prod');        // ok('prod')
 *   validateOrgAlias('x" ; rm -rf'); // err('Invalid Salesforce org alias ...')
 */
export const validateOrgAlias = (alias: string): Result<string, string> =>
  ORG_ALIAS_RE.test(alias)
    ? ok(alias)
    : err(
        `Invalid Salesforce org alias ${JSON.stringify(alias)}: only letters, digits, and . _ @ - are allowed.`,
      );
