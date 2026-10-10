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
| `patterns` | `string[]` | Same as `scannerPatterns` (older key). Both the scanner and the release guard (`pnpm guard`) check the union of the two. |
| `historyTerms` | `string[]` | Plain string literals passed to `git log -S` (used with `--git-history` flag). Add the same identifiers as plain strings here. |

## What to add

- **Org names** — your Salesforce org / company short name (e.g. `AcmeCorp`)
- **Domains** — your org's My Domain or community domain (e.g. `acmecorp.my.salesforce.com`)
- **Community / Experience Cloud names** — site slugs that identify the org
- **Usernames** — Salesforce usernames if they contain org identifiers (e.g. `admin@acmecorp.com`)

The scanner runs in the pre-commit hook, `pnpm scan:leaks`, CI and the publish
workflow. One loader (`scripts/lib/forbidden-names.mjs`) serves the scanner and the
release guard; `sfi vault anonymize` carries a TypeScript port held in sync by a
parity test. It fails CLOSED:

- A file that exists but is malformed (bad JSON, wrong shape, invalid regex) always
  fails the run.
- Every run prints how many patterns it loaded, or `VACUOUS: no org blocklist`.
- `pnpm scan:leaks` (`--strict`) refuses a missing blocklist. Pass
  `--allow-no-blocklist` or set `SFI_ALLOW_NO_BLOCKLIST=1` to accept a generic-only
  scan (the pre-commit hook does, so contributors without the file can commit).
- CI fails when the `ORG_LEAK_BLOCKLIST` secret is empty, except on fork PRs, which
  cannot read secrets and run visibly VACUOUS. The release guard refuses a missing
  blocklist whenever `CI=true`.
