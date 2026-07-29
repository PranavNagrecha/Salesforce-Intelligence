# Changelog Fragments

This directory contains **changelog fragments** — one Markdown file per backlog item or significant change. Fragments are assembled into `CHANGELOG.md` under the `## [Unreleased]` section by `scripts/assemble-changelog.mjs`.

## Fragment format

**Filename:** `changelog.d/<item-id>.md`

Use the backlog item ID, e.g. `r7-f1.md`, `p11-onboard.md`, or `cto-p4-ast7.md`.

**Content:** Keep-a-Changelog subsections. Include only the subsections that apply.

```markdown
### Added
- Short imperative bullet. Reference issue/PR in parens where helpful.

### Changed
- What changed and why.

### Fixed
- Bug that was fixed.
```

## Rules

- Every file that touches `packages/**` or product `scripts/**` **must** accompany a fragment (or modify an existing one). The `scripts/check-changelog-fragments.mjs` script enforces this on every commit.
- Docs-only, website-only, and examples-only diffs are exempt.
- Fragments must not include YAML front-matter or `##` release headings — they are **body-only**.
- Keep bullets concise. The assembler concatenates them verbatim; formatting must be valid Markdown.

## Assembling

```sh
pnpm changelog:assemble   # inserts/replaces [Unreleased] block in CHANGELOG.md
pnpm changelog:check      # CI guard — exits 1 if a code diff lacks a fragment
```

## Lifecycle — delete the fragment once it ships

A fragment lives in this directory only while its change is **unreleased**.

1. Land the change with its fragment.
2. `pnpm changelog:assemble` folds every fragment into `## [Unreleased]`.
3. At release, the `[Unreleased]` block is retitled `## [x.y.z] — DATE`.
4. **Delete the fragments that block went into, in the release commit.**

Step 4 is not tidiness. The assembler *replaces* the `[Unreleased]` block from
whatever fragments it finds and has no memory of which ones already shipped, so
a fragment left behind after its release re-emits the whole shipped body into
`[Unreleased]` on the next assemble — the release notes appear twice in
`CHANGELOG.md`, once under their version and once as pending work.

An empty `changelog.d/` (this README only) is the correct steady state
immediately after a release; the assembler exits 0 and leaves `CHANGELOG.md`
untouched when it finds no fragments.

## Example

The [fragment format](#fragment-format) block above is the complete template;
the directory is intentionally empty of fragments between releases.
