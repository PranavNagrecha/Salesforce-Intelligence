# sf-intelligence: working in this checkout

You are in the source repository of sf-intelligence, a read-only, offline
MCP server and CLI that answers questions about one Salesforce org from a
local metadata vault. This file is read only by someone who opens the clone
in Claude Code (a contributor or an evaluator); it is not shipped to users.
The instructions users get are the skills under `.claude/skills/`, which the
Claude Code plugin installs. Start with `using-sf-intelligence`.

## Build and run from here

```sh
pnpm install && pnpm build          # compile every package; the CLI bundles the MCP server
node packages/cli/bin/sfi.js demo   # serve the built-in demo org (Verdant Energy), no Salesforce login
```

`.mcp.json` at the repo root points Claude Code at that CLI, so a session
launched from this folder has the `sfi.*` tools. To answer about a real org,
build its vault inside that org's Salesforce DX project (`sfi init
--target-org <alias>`, then `sfi refresh`) and start the server with
`node packages/cli/bin/sfi.js mcp --vault /absolute/path/to/org-kb`.
Rebuild after any change under `packages/`; a running server does not pick
up edits.

## When a question is about a Salesforce org

Load `.claude/skills/using-sf-intelligence/SKILL.md` first. The default
profile exposes the 16-tool core roster; every other analysis runs through
the gateway tool `sfi.run_analysis`, given the analysis name and its
arguments. Every org fact comes from a tool result, cited by its component
id. Never fill a gap with general Salesforce knowledge, and say plainly when
the vault did not retrieve something.

## Two rules for contributors

1. **No real org names in tracked files or commit messages.** Fixtures and
   examples use the demo org (Verdant Energy) and `Demo_*` / `Acme_*` names.
   `pnpm scan:leaks` must pass. See CONTRIBUTING.md.
2. **`pnpm lint && pnpm test` before a pull request.** CI runs the private
   gates on top.

## Where things live

- `packages/`: the source, one package per layer; `packages/cli` is the one
  published to npm.
- `docs/`: user documentation, indexed in `docs/README.md`.
- `website/`: sfi.auditforce.cloud.
- `.claude/skills` and `.claude/commands`: shipped by the plugin.
- `.claude/agents`: the two optional `/sfi-field-audit` agents, not shipped;
  `.claude/agents/maintainer`: agents for working on this repo.
- `REPO-STRUCTURE.md`: the repository map. `RELEASING.md`: release steps.
