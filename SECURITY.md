# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.3.x (current public release) | Yes |
| 0.2.x and earlier | No |
| Pre-0.1 / maintainer-only snapshots | No |

<!-- The first row's minor line is asserted against packages/cli/package.json by
     `pnpm check:version-consistency`. It read "0.2.x (current public release)"
     for three releases after 0.3.0 shipped — on the page a security researcher
     reads first, where a stale supported-versions table reads as an abandoned
     project. A gate now holds this, not a release checklist. -->


Security fixes land on the latest release tag. Pin your install to a tagged
version in production workflows — see
[`docs/guides/supply-chain.md`](./docs/guides/supply-chain.md) for exact
`npx` / `package.json` pin examples, npm provenance verification, the
published tarball allowlist (`pnpm pack:check`), and SBOM generation.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Open a [private security advisory](https://github.com/PranavNagrecha/Salesforce-Intelligence/security/advisories/new)
on GitHub (preferred — routes directly to the maintainer). If you cannot use
GitHub, email **security@auditforce.cloud** instead. Include:

1. A description of the issue and its impact
2. Steps to reproduce
3. Affected version(s)
4. Any suggested fix (optional)

We aim to acknowledge reports within **72 hours** and provide a remediation
timeline within **7 days** for confirmed issues.

## Scope

In scope:

- The `@sf-intelligence/*` packages and MCP server shipped from this repository
- Privacy leaks in the release snapshot (`pnpm guard`)
- Unauthorized org access via the live read-only plane
- Credential or token exposure in logs, errors, or audit output

Out of scope:

- Vulnerabilities in Salesforce itself or the `sf` CLI
- Issues that require the reporter to already have full shell access to the
  machine running SfIntelligence
- Social engineering against org admins

## Security model (summary)

SfIntelligence is **local-first**:

- **Vault tools** never call Salesforce during a conversation.
- **Live tools** (`sfi.live_*`) are **opt-in and fail-closed**. They run
  read-only Salesforce CLI queries only when enabled via a standing grant
  (`sfi.live_consent`, OrgId- and principal-bound, scoped, expiring) or the
  operator override `SFI_LIVE_PLANE_ENABLED=1`. A per-call `liveEnabled: true`
  is **not** a consent path and never opens the live plane by itself.
- The product has **no write path** to Salesforce metadata or records.
- MCP tool arguments are **not** written to the audit log — only tool names,
  argument *keys*, and vault hash (`SF_INTELLIGENCE_AUDIT_LOG`).
- Error messages from the live plane **redact** bearer tokens and access-token
  shapes before returning to the client.

See [`docs/configuration.md`](./docs/configuration.md) for environment
variables and [`docs/architecture.md`](./docs/architecture.md) for the full
trust boundary.

## Supply chain

- **Pin** production installs to `sf-intelligence@X.Y.Z` (see
  [`docs/guides/supply-chain.md`](./docs/guides/supply-chain.md)).
- **Publish** uses GitHub Actions OIDC + `npm publish --provenance` (no
  long-lived npm token in the workflow). Consumers can run
  `npm audit signatures` after install.
- **Tarball allowlist** is `packages/cli/package.json#files`, enforced by
  `pnpm pack:check` / `scripts/check-pack-allowlist.mjs` (also in
  `prepublishOnly`).
- **SBOM** (CycloneDX 1.5) is generated with `@cyclonedx/cdxgen`
  (`pnpm sbom` / `scripts/generate-sbom.mjs`) and attached to the GitHub
  Release on tag publish. Scope is the **transitive runtime closure of the
  published package** — the 7 direct runtime dependencies and everything they
  pull in (~137 components with a populated dependency graph), resolved from
  `pnpm-lock.yaml`. devDependencies are deliberately excluded; they are not
  installed by consumers. The artifact self-documents this in
  `metadata.properties`. The publish job fails closed if the SBOM is missing,
  empty, has too few components, or has an empty dependency graph. It is not
  shipped inside the npm tarball.

## Dependency advisories

Run `pnpm audit` before release. Upgrade paths are preferred over ignores.

## Org data hygiene

- Never commit `org-kb/source/`, real org aliases, or `eval/cases.local.json`
  to a public fork.
- The release guard (`pnpm guard`) scans the shipping set; run it before
  publishing a snapshot.
