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

## Example

See [`r7-f1.md`](./r7-f1.md) for a complete example.
