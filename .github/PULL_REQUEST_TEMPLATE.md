<!-- What changes for a user, in one or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `pnpm lint && pnpm test` pass locally (CI runs the rest)
- [ ] No real org, object, field, class, profile or user names anywhere in the diff (fixtures use `Demo_*` / `Acme_*`)
- [ ] `changelog.d/<slug>.md` added for a change under `packages/` or `scripts/`: a `### Added`, `### Changed` or `### Fixed` heading with `- ` bullets, written for admins (docs-, website- and examples-only changes are exempt)
- [ ] New behavior has a test; a wrong answer that is now right has a test that failed before
- [ ] Docs and the relevant skill updated if user-visible behavior changed
- [ ] If it answers a "where used / who references / what depends on" question, it follows the reverse-lookup contract in CONTRIBUTING.md
