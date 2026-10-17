# Release report: 0.7.0 (2026-11-03)

Anonymized. No customer org, class, field or vault name appears here. Counts come from re-extracting a copy of a real OmniStudio sandbox with the release build and from the bundled demo org.

## What shipped

No new tools and no envelope change. Every item closes something a user or reviewer could see.

- **OmniScript save-for-later patterns count as field writes.** The second defect from the October external review. A script that declares `saveURLPatterns` and a save object gets a `writesTo` reference to each pattern's field; a script that declares patterns but no save object lists them as unresolved on the script instead of guessing a field.
- **Flow screen components reference the LWC that exists.** Since 0.6.0 the Flow extractor kept the `c:` namespace prefix of a screen component's `extensionName`, so every screen-to-LWC reference pointed at an id no node had. Both extractors now build the bundle id the same way.
- **`/sfi-field-audit` works without its two agents.** The command checks whether they are installed and otherwise runs the audit and the three refutation lenses inline, saying so once. The maintainer-only agents moved out of the way.
- **The demo org shows the three 0.6.0 reference families.** A screen flow with object-provided fields, a component with `lightning-record-form` bindings and a layout related list with column fields, plus three demo questions whose answers cite them. The tracked demo vault was rebuilt with the current code for the first time since June.
- **Public docs are link-checked in the build**, after the 0.6.0 release report was linked but never published. Both the 0.5.0 and 0.6.0 reports are now in the repo.
- **Nested `sfi <command> <subcommand> --help` is pinned by a test.** It already worked; the test keeps it that way.
- **Internal planning labels left code comments and test names.** No behaviour change.
- The host guide and README cover Cline.

## Measured

| Measurement | Before | After |
|---|---|---|
| OmniScripts on a real OmniStudio sandbox with non-empty save patterns | 2 | 2 |
| Of those, with a declared save object | 0 | 0 |
| Of those, carrying an unresolved-pattern disclosure instead of a guessed field edge | 0 | 2 |
| Demo org nodes / edges | 118 / 324 | 148 / 371 |
| Flow-to-LWC references on the demo org that point at an existing node | 0 of 1 | 1 of 1 |

On that sandbox no script declares a save object, so the resolved path is exercised by the synthetic fixtures only; the fail-closed path is what the real org exercises. Incremental refresh stayed byte-identical to a cold rebuild on the same sandbox.

## Upgrade note

Refresh once if your org uses OmniStudio save-for-later or Flow screen components; the new references are read at refresh time. Nothing else changes. See the [upgrading guide](../guides/upgrading.md).
