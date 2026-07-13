# Forbidden-names local config

`scripts/forbidden-names.local.json` is the maintainer-only privacy guard.
It is **gitignored** and must never be committed.

## Setup

Copy the example and fill in your identifiers:

```sh
cp scripts/forbidden-names.local.example.json scripts/forbidden-names.local.json
# then edit forbidden-names.local.json
```

## Config keys

| Key | Type | Purpose |
|---|---|---|
| `scannerPatterns` | `string[]` | Regex patterns matched against every git-tracked file. Use `\b` word boundaries and escape dots for domains (e.g. `\\bMyOrg\\b`, `\\bmyorg\\.my\\b`). |
| `patterns` | `string[]` | Alias for `scannerPatterns` (back-compat; both are merged). |
| `historyTerms` | `string[]` | Plain string literals passed to `git log -S` (used with `--git-history` flag). Add the same identifiers as plain strings here. |

## What to add

- **Org names** — your Salesforce org / company short name (e.g. `AcmeCorp`)
- **Domains** — your org's My Domain or community domain (e.g. `acmecorp.my.salesforce.com`)
- **Community / Experience Cloud names** — site slugs that identify the org
- **Usernames** — Salesforce usernames if they contain org identifiers (e.g. `admin@acmecorp.com`)

The scanner is invoked automatically by `pnpm scan:leaks` (pre-commit hook) and
in CI via `scripts/check-public-interface.mjs`. Without `forbidden-names.local.json`
(public clone / CI) it runs only the structural `PATH-org-kb` check — which is
correct, because a public-clean tree has no private-org names left to find.
