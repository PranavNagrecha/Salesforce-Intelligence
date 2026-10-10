# sf-intelligence

Ask your AI what breaks before you change Salesforce. Offline, read-only, cited answers. Website and docs: **[sfi.auditforce.cloud](https://sfi.auditforce.cloud)**

A **grounded, fail-closed backend for AI assistants** working in one Salesforce org — answers come from the org's **real metadata**, not a guess.

`sf-intelligence` is an **offline-first, read-only, MCP-first knowledge base** for a single Salesforce org. One `sf project retrieve` builds a local vault (Markdown + a DuckDB dependency graph); a semantic router **advises** a ranked tool shortlist and your **host LLM decides** which to run. It **fails closed** — write imperatives and prompt injection are refused by shape, an unanswerable ask gets an honest gap instead of a lookalike tool, and genuine ambiguity gets a clarifying question instead of a guess. MIT + Commons Clause.

Requires **Node.js 20+**. `npx -y sf-intelligence …` needs no install; `npm install -g sf-intelligence` puts `sfi` on your PATH for shorter commands. Upgrading from an earlier version? Breaking changes and upgrade steps for every release are in the [CHANGELOG](https://github.com/PranavNagrecha/Salesforce-Intelligence/blob/main/CHANGELOG.md).

## Try it now — no Salesforce org needed

One command serves a built-in **synthetic demo org** ("Verdant Energy," a fictional solar installer) over MCP — fully offline, no auth, no `sf` CLI, builds in a few seconds:

```sh
claude mcp add --transport stdio --scope user sf-intelligence-demo -- npx -y sf-intelligence demo
```

Any other MCP client — same registration as the "real org" block below, except `"args": ["-y", "sf-intelligence", "demo"]` and **no `--vault`**: `sfi demo` manages its own cached vault under `~/.sf-intelligence/demo`. Ask it *"what happens when I save a Project?"* or *"what breaks if I delete `Invoice__c.Amount__c`?"*. When you're ready for your own org, keep reading.

## Register the MCP server (your real org)

Also requires an authenticated **Salesforce CLI** (`sf`). Each host reads a **different config file in a different format**, and most don't run inside your Salesforce project — always pass an **absolute `--vault` path**. Full per-host, per-platform detail (exact paths, logs, troubleshooting): [docs/guides/mcp-hosts.md](https://github.com/PranavNagrecha/Salesforce-Intelligence/blob/main/docs/guides/mcp-hosts.md).

| Host | Config file | Top-level key |
|---|---|---|
| Claude Code | `.mcp.json` (project) or `~/.claude.json` | `mcpServers` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` |
| Cursor | `.cursor/mcp.json` | `mcpServers` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.*]` (TOML) |
| VS Code + GitHub Copilot | `.vscode/mcp.json` | **`servers`** — not `mcpServers` |

**Claude Code** — from your Salesforce DX repo:

```sh
claude mcp add --scope project sf-intelligence -- \
  npx -y sf-intelligence mcp --vault "$PWD/org-kb"
```

**Claude Desktop, Cursor, or any `mcpServers`-style client** — add to its config, then fully restart the app:

```json
{
  "mcpServers": {
    "sf-intelligence": {
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp", "--vault", "/abs/path/to/org-kb"]
    }
  }
}
```

**VS Code + GitHub Copilot** — create `.vscode/mcp.json`. The top-level key is `servers`, **not** `mcpServers` — pasting the block above here parses fine and registers nothing:

```json
{
  "servers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp", "--vault", "/abs/path/to/org-kb"]
    }
  }
}
```

**Codex** — `codex mcp add sf-intelligence -- npx -y sf-intelligence mcp --vault /abs/path/to/org-kb`
(or the TOML equivalent in `~/.codex/config.toml`).

## First run

From your Salesforce DX repo (the directory with `sfdx-project.json`):

```sh
sfi init --target-org my-org-alias    # create the vault, bind it to one org
sfi refresh --target-org my-org-alias # retrieve metadata, build the vault
sfi status                            # freshness, source-tree hash, counts
sfi doctor                            # diagnose sf CLI / vault / auth issues
```

`--target-org` is **required** on `sfi init` whenever stdin isn't a terminal — which includes every MCP host, so always pass it there.

Then ask anything in your MCP client — *"what fields does Account have?"*, *"what breaks if I delete this field?"*, *"who can edit Salary__c?"*, *"why can't this profile see Opportunities?"*, *"what happens when I save a Project?"*, *"give me a tour of this org."*

**Connected, but the org looks empty?** Before the first `sfi refresh` finishes, the server boots in setup mode and exposes exactly one tool, `sfi.setup_status` — ask your chat "what do you need from me?" and it will name the exact next command (and where it's looking for the vault).

## Boundaries

Read-only and offline by default. Static analysis, not runtime. No business record data in the vault. The product names its limits plainly rather than guessing.

## Feedback

A weak or wrong answer, or a question it couldn't route — that's the most useful thing to send back. It's captured **locally**, nothing phones home:

```sh
sfi feedback mark "where is the SSN field used" --wrong   # or --weak
sfi feedback export                                       # → sfi-feedback.json (scrubbed)
```

Share it, or just describe the gap, at <https://github.com/PranavNagrecha/Salesforce-Intelligence/issues>.

## Documentation

Full guides, capabilities, the tool catalog, and configuration: **https://sfi.auditforce.cloud**

- [Try the demo](https://sfi.auditforce.cloud/demo) · [Getting started](https://sfi.auditforce.cloud/getting-started) · [Quality & trust](https://sfi.auditforce.cloud/trust)
- [Capabilities](https://sfi.auditforce.cloud/capabilities) · [All tools](https://sfi.auditforce.cloud/tools)
- [Configuration](https://sfi.auditforce.cloud/configuration) · [FAQ](https://sfi.auditforce.cloud/faq)

## License

MIT + Commons Clause — see the `LICENSE` file shipped in this package, or
<https://sfi.auditforce.cloud/licensing>.
