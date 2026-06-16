# sf-intelligence documentation

Start here. This index covers user guides, architecture, configuration, and
maintainer docs for the [sf-intelligence](https://github.com/PranavNagrecha/Salesforce-Intelligence)
Claude Code plugin.

---

## New users

| Doc | What it covers |
| --- | --- |
| [README](../README.md) | Product overview, install, first run, privacy |
| [Installation guide](./guides/installation.md) | Prerequisites, npm install, troubleshooting |
| [Guided onboarding](./guides/onboarding.md) | `/sfi-onboard`: org selection, init, refresh, verification, first question |
| [First refresh](./guides/first-refresh.md) | `/sfi-init`, `/sfi-refresh`, vault layout, git policy |
| [Asking questions](./guides/asking-questions.md) | What to ask, resolver behavior, live plane, boundaries |
| [Configuration](./configuration.md) | Environment variables, live consent, audit log |
| [Positioning](./POSITIONING.md) | Honest competitive framing — when to use something else |

---

## Technical depth

| Doc | Audience | What it covers |
| --- | --- | --- |
| [Architecture](./architecture.md) | Admins, architects | Data flow, vault layout, MCP tools, determinism, upgrades |
| [Repository structure](../REPO-STRUCTURE.md) | Contributors | Monorepo layout, packages, build commands |

---

## Build workflow

**Session handoff (gitignored):** [`.sfi/local/HANDOFF.md`](../../.sfi/local/HANDOFF.md). Root [`HANDOFF.md`](../../HANDOFF.md) is a pointer only.

**Commands:** [`START-HERE.md`](../../START-HERE.md).

| Doc | What it covers |
| --- | --- |
| [`BUILD-CONTRACT.md`](../../BUILD-CONTRACT.md) | One backlog, one gate, one loop |
| [`BACKLOG.md`](../../BACKLOG.md) | Ordered work list |
| [`.sfi/local/LOOP_STATE.json`](../../.sfi/local/LOOP_STATE.json) | Minimal machine state (gitignored; see [LOOP_STATE.md](../LOOP_STATE.md)) |

---

## Contributing and security

| Doc | What it covers |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Dev setup, PR checklist, adding tools |
| [Security policy](../SECURITY.md) | Vulnerability reporting, trust model |
| [Code of conduct](../CODE_OF_CONDUCT.md) | Community standards |

| [CHANGELOG](../CHANGELOG.md) | Version history |

---

## Agent skills (Claude Code)

Skills auto-activate in Claude Code sessions. Entry points:

- `.claude/skills/using-sf-intelligence/SKILL.md` — tool cascade, resolve-first
- `.claude/skills/answering-org-questions/SKILL.md` — intent routing

Slash commands: `/sfi-onboard`, `/sfi-init`, `/sfi-refresh`, `/sfi-status` (see
`.claude/commands/`).

Run `sfi.capabilities` in a session for the live tool map and count.

---

## Quick commands

```sh
pnpm install && pnpm build   # compile
pnpm test                    # unit + integration
node ../sf-intelligence-qa/scripts/commit-gate.mjs  # one gate
pnpm guard                   # privacy scan
```

In your **Salesforce DX repo** (not this source repo):

```sh
sfi init                               # set up org-kb/ and pick the org alias
sfi refresh --target-org my-org-alias  # retrieve + build the vault
sfi status                             # freshness, source-tree hash, counts
```

These wrap as `/sfi-onboard`, `/sfi-init`, `/sfi-refresh`, `/sfi-status` slash
commands when sf-intelligence is loaded as a Claude Code plugin.
