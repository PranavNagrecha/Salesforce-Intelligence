# sf-intelligence documentation

Start here. Every file under `docs/` is linked from this page once. The
product is [sf-intelligence](https://github.com/PranavNagrecha/Salesforce-Intelligence):
a read-only MCP server and CLI that answers questions about one Salesforce
org from a local metadata snapshot.

## For admins and architects: set up and ask

In the order you will need them.

| Doc | What it covers |
| --- | --- |
| [README](../README.md) | What it answers, the five-minute install, privacy |
| [Installation](./guides/installation.md) | Prerequisites, npm and plugin install, registering the server, common install issues |
| [Connecting your AI host](./guides/mcp-hosts.md) | The exact config block for Claude Code, Claude Desktop, Codex, Cursor and VS Code + Copilot, on macOS and Windows |
| [First refresh](./guides/first-refresh.md) | `sfi init` and `sfi refresh`, what the vault contains, what to commit |
| [Guided onboarding](./guides/onboarding.md) | The `/sfi-onboard` path in Claude Code |
| [Asking questions](./guides/asking-questions.md) | What you can ask, what the tool refuses and why, worked sessions |
| [Upgrading](./guides/upgrading.md) | Bump, restart, refresh; what changed in 0.5.0 and 0.6.0 |
| [Troubleshooting](./guides/troubleshooting.md) | What each error means (`invalid-query`, `component-not-found`, oversize answers, setup mode, "not directly invokable") and what to do |
| [Configuration](./configuration.md) | Every environment variable: live plane, network policy, response budget, tool profile, timeouts |
| [The `sfi` command line](./cli.md) | Every command and its options |
| [Supply chain](./guides/supply-chain.md) | Pinning, provenance verification, the published-tarball allowlist, SBOM |

## How it works

| Doc | What it covers |
| --- | --- |
| [Architecture](./architecture.md) | Data flow, vault layout, the tool surface and the core profile, edge coverage, determinism, upgrades |
| [Routing](./routing.md) | How a question reaches a tool, the host's role, refusal gates, measured behaviour and its limits |
| [OmniStudio](./omnistudio/README.md) | How OmniStudio logic is stored and what is modeled; the generated [element catalog](./omnistudio/element-catalog.md) |
| [Proposal bundles](./schemas/proposal-tool-coverage.md) | Which tools emit a local `package.xml` / `destructiveChanges.xml` proposal; the JSON schemas of a [proposal](./schemas/proposal.schema.json) and of a [permission-set diff](./schemas/ps-diff.schema.json) |
| [Positioning](./POSITIONING.md) | Honest comparison with the alternatives, and when to use something else |

Reports, each a measurement rather than a promise:

| Report | What it measures |
| --- | --- |
| [0.6.0 release report](./reports/release-0.6.0.md) | What shipped and how it was verified on real orgs (counts only) |
| [Scale certification](./reports/scale-certification.md) | Import and resolve timings at 50,000 components, and what the benchmark does not cover |
| [SAST accuracy](./reports/sast-accuracy-report.md) | Precision and recall of the heuristic code-quality rules on a labelled corpus |
| [Phantom taxonomy audit](./reports/phantom-taxonomy-audit.md) | What the referenced-but-unretrieved ids on real orgs consist of, and the design that followed |

## For contributors

| Doc | What it covers |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Dev setup, the PR checklist, adding a tool |
| [Extractor gaps](./contributing/extractor-gaps.md) | Self-contained good-first issues: metadata references that are not graph edges yet |
| [Maintainer variables](./contributing/maintainer-variables.md) | Environment variables read only by eval, test and release scripts |
| [Repository structure](../REPO-STRUCTURE.md) | Monorepo layout, packages, build commands |
| [Architecture decisions](./decisions/README.md) | The index of ADRs; the ten records are [001](./decisions/ADR-001-confidence-tagged-edges.md), [002](./decisions/ADR-002-offline-vault-live-plane-boundary.md), [003](./decisions/ADR-003-graph-edge-contract.md), [004](./decisions/ADR-004-phantom-taxonomy-on-demand.md), [005](./decisions/ADR-005-mcp-response-byte-budget.md), [006](./decisions/ADR-006-read-only-graph-access.md), [007](./decisions/ADR-007-canonical-response-envelope.md), [008](./decisions/ADR-008-deterministic-concept-model-reasoning.md), [009](./decisions/ADR-009-selector-scope-honesty.md), [010](./decisions/ADR-010-core-profile-and-run-analysis.md) |
| [review-change PR gate (Action)](../.github/actions/review-change/README.md) | The `sfi.review_change` deploy gate as a GitHub Action |
| [PR-gate workflow template](./ci/review-change-pr-gate.example.yml) | A drop-in `.github/workflows` file wiring that Action into a PR gate |
| [Nightly org-health workflow template](./ci/nightly-sast.example.yml) | A nightly refresh plus SAST gate that opens an issue on critical findings; it lives here because it needs your org's auth |
| [Security policy](../SECURITY.md) | Vulnerability reporting, trust model |
| [Code of conduct](../CODE_OF_CONDUCT.md) | Community standards |
| [CHANGELOG](../CHANGELOG.md) | Version history |

## Agent skills and slash commands (Claude Code plugin)

Installed as a plugin, sf-intelligence adds skills that activate on
Salesforce vocabulary and five slash commands that wrap the CLI:
`/sfi-onboard`, `/sfi-init`, `/sfi-refresh`, `/sfi-status` and
`/sfi-field-audit` (see `.claude/commands/`). The entry skill is
`.claude/skills/using-sf-intelligence/SKILL.md`. Ask "what can you do?" in a
session for the tool map; the host answers from `sfi.list_analyses`.

## Quick commands

In this source repo:

```sh
pnpm install && pnpm build   # compile
pnpm test                    # build + unit tests (pnpm test:all adds integration)
pnpm tsc                     # project-reference typecheck (tsc -b)
pnpm guard                   # privacy scan
```

In your **Salesforce DX repo** (not this source repo):

```sh
sfi init                               # set up org-kb/ and pick the org alias
sfi refresh --target-org my-org-alias  # retrieve + build the vault
sfi status                             # freshness, source-tree hash, counts
```

These wrap as `/sfi-init`, `/sfi-refresh` and `/sfi-status` when
sf-intelligence is loaded as a Claude Code plugin.
