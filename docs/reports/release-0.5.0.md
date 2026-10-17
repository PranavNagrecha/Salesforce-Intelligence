# Release report: 0.5.0 (2026-10-15)

Anonymized. No customer org, class, field or vault name appears here.

## What shipped

- **Default tool profile 25 → 16** (8 spine + 8 answer tools). The core `tools/list` shrank from 33 KB to 20 KB. Every other tool stays reachable through `sfi.run_analysis`.
- **Smaller answers.** The freshness warning went from 1,044 bytes to 94 bytes per response; concept reasoning is opt-in on four tools (about 5 KB saved per call); three core descriptions went from about 5 KB to about 1 KB each, with the long form in `reference`.
- **Dead code is more careful.** The static-type grep now runs before `likely_dead` as well as `definitely_dead`; custom-metadata cells that name an Apex class now produce a reference edge to that class.
- **Quick-action Visualforce references** target `VisualforcePage:` (they were `ApexPage:`, which matched nothing).
- **Six tools' caveats** were corrected to match what the extractors cover.
- **Plain MIT license.** The Commons Clause condition was removed.
- **Newcomer path.** `pnpm test` builds first; CONTRIBUTING names the real tool-registration path; the privacy guard fails closed locally.

## Measured on a real production org

Dead-code verdicts on an external reviewer's production org (about 4,700 components), measured by re-extracting a copy of the vault with the release build and comparing against the previous release:

| Verdict | Before | After |
|---|---|---|
| definitely_dead | 10 | 9 |
| likely_dead | 3 | 2 |
| uncertain | 79 | 81 |

The class the reviewer identified as a false "likely dead" now reads `uncertain`; the nine classes the reviewer confirmed dead remain `definitely_dead`.

## Upgrade note

Hosts that call a hidden tool by name get a named error with the `sfi.run_analysis` form to use instead. See the [upgrading guide](../guides/upgrading.md).
