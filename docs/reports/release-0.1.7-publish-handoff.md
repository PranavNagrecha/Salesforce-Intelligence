# Release 0.1.7 — publish handoff (P10-SHIP-5)

_2026-06-07. Everything is prepped; the npm publish is the one step you run
(your account has passkey-2FA, so the CLI cannot do the OTP — it needs a
granular token you generate in the browser)._

## Readiness — all green

| Prerequisite | State |
| --- | --- |
| Comprehensive `commit-gate --release` (A7 full trio on all 3 gate vaults) | ✅ 0 failed steps; A7 byte-identical on all 3 |
| 1000Q / complex / baseline / batteries | ✅ 98% / 72-75 / 83% / all green |
| Clean-room tarball install + bin smoke (P10-G1) | ✅ installs, `--version`/`--help`/`doctor` work |
| Open P0 / npm-blocking P1 | ✅ 0 (git-history P1 is GitHub-public only; repo stays PRIVATE) |
| Shipping set privacy (`pnpm guard`) | ✅ 0 leaks / 641 public files |
| Version | `0.1.7` in `packages/cli/package.json`; npm latest = `0.1.5` → 0.1.7 is a clean new publish |
| Website recalibrated + version-synced + npm↔site links | ✅ (P10-SHIP-3/4) |

## The publish (you run this)

Distribution model: **npm PUBLIC, git PRIVATE.** npm ships only the bundled
tarball (`dist/index.js` + `bin` + `README` + `LICENSE` + `package.json`).

1. **Generate a granular token** at npmjs.com → *Access Tokens → Granular* (the
   browser flow, where your passkey works): package `sf-intelligence`,
   permission *Read and write*, short expiry. Copy it.

2. **From the product repo root**, build fresh and publish. Use a temp npmrc
   (the `npm_config_//registry…` env form breaks in zsh on the slashes):

   ```sh
   cd sf-intelligence
   pnpm -r build                                   # regenerate dist/ (gitignored)
   printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > /tmp/.npmrc.publish
   npm_config_userconfig=/tmp/.npmrc.publish pnpm -r publish --access public
   rm -f /tmp/.npmrc.publish                        # shred the token file
   ```

   - `pnpm -r publish` selects only the publishable `sf-intelligence` (the 9
     internal `@sf-intelligence/*` packages are `private:true`); **do not** run
     bare `npm publish` from the root (it errors on the private root + packs the
     whole monorepo).
   - The `prepublishOnly` hook auto-runs `scan-org-leaks --strict` +
     `release-guard` and aborts the publish on any leak — a second seatbelt.

3. **Verify clean-room:**

   ```sh
   npx -y sf-intelligence@0.1.7 --version    # → 0.1.7
   npx -y sf-intelligence@0.1.7 --help       # lists the 9 commands
   ```

4. **Tag the release** (local; push only if/when the private repo is wired for it):

   ```sh
   git tag v0.1.7
   ```

## After publish — SHIP-6 (website deploy)

Per the contract, the website ships **after** npm. Once 0.1.7 is live on npm,
deploy `sf-intelligence/website/` to Cloudflare Pages
(`salesforce-intelligence.pages.dev`). The site is already recalibrated to 0.1.7
and the served pages exclude maintainer files via `.assetsignore`. Confirm the
live URL serves the 0.1.7 content (footer version, `llms.txt` version line).

## Notes

- If the publish reports `403 / cannot publish over existing version`, 0.1.7 is
  already up — nothing to do.
- Revoke/expire the granular token after publishing.
- This is the only step requiring your credential; the agent never holds it.
