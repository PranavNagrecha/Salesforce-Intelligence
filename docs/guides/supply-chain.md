# Supply chain — pin, verify, SBOM

How to install `sf-intelligence` safely in production, what the published
tarball is allowed to contain, and how npm provenance / SBOM fit together.

Related: [installation guide](./installation.md), [SECURITY.md](../../SECURITY.md),
GitHub Actions [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml).

## Pin the version

Do **not** float on `latest` in production. Replace `X.Y.Z` with the release
you reviewed (see [npm package versions](https://www.npmjs.com/package/sf-intelligence?activeTab=versions)
or a GitHub `vX.Y.Z` tag).

**MCP client (`npx`):**

```json
{
  "mcpServers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence@X.Y.Z", "mcp"]
    }
  }
}
```

**CLI / DX repo (`package.json`):**

```json
{
  "dependencies": {
    "sf-intelligence": "X.Y.Z"
  }
}
```

Exact versions (no `^` / `~`) keep the lockfile and CI reproducible. Global
installs should also pin:

```sh
npm install -g sf-intelligence@X.Y.Z
```

## Verify npm provenance

Releases are published from GitHub Actions with `npm publish --provenance`
(OIDC Trusted Publishing — no long-lived npm token in the workflow).

```sh
# Confirm the version exists and inspect publish metadata
npm view sf-intelligence@X.Y.Z --json

# Verify registry attestations / signatures (npm ≥ 9.5)
npm audit signatures
```

If attestation verification fails in your environment, treat the install as
untrusted until you can confirm the package against the matching GitHub
Release for tag `vX.Y.Z`.

## Tarball allowlist

The published package is `packages/cli`. Its `package.json#files` is the
allowlist of shipping paths:

- `dist/index.js`
- `dist/apex-ast-worker.js`
- `bin/`
- `README.md`
- `server.json`
- `demo-source/`

npm also includes `package.json` and `LICENSE` when present. Before publish,
the monorepo runs:

```sh
pnpm pack:check
# same as: node scripts/check-pack-allowlist.mjs
```

That packs the CLI package and fails if the tarball contains any path outside
the allowlist, or if an allowlisted root is missing. The check is wired into
`scripts/prepublish-check.mjs` (`prepublishOnly` on the CLI package).

Privacy scanning of the shipping *tree* remains separate (`pnpm guard`,
`scan-org-leaks`).

## SBOM

Generate a CycloneDX 1.5 SBOM with the pnpm-aware generator (do **not**
use `npm sbom` in this workspace — it is empty/unavailable under pnpm):

```sh
pnpm sbom
# → sbom.cdx.json at the repo root (fails closed if empty / zero components)
```

Tag-triggered publishes (`.github/workflows/publish.yml`) run the same
command and **fail the job** if the SBOM is missing or empty, then attach
`sbom.cdx.json` to the GitHub Release. The SBOM is a release artifact for
consumers — it is **not** shipped inside the npm tarball.

## What this does not cover

- Configuring Trusted Publishing on npmjs.com (one-time owner setup — see
  comments in `publish.yml`)
- Pinning every monorepo workspace dependency
- Custom cosign/SLSA L3 beyond npm’s built-in provenance
