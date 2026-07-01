# sf-intelligence

Ask questions about your Salesforce org in plain language — grounded in the
org's **real metadata**, not a guess.

`sf-intelligence` is an **offline-first, read-only, MCP-first knowledge base**
for a single Salesforce org. You run one `sf project retrieve`; it builds a local
Markdown vault and a DuckDB dependency graph, then answers questions locally
through an MCP server (the `sfi.*` tools) — no network egress for vault answers.
A semantic router turns each plain-language question into a meaning-ranked shortlist
of the `sfi.*` tools that can answer it — tagged with the plane it needs (offline vault
/ opt-in live / hybrid) and a confidence band — and asks a clarifying question instead
of guessing when the top candidates diverge on something consequential. An opt-in live
read-only plane can answer record counts and samples. MIT + Commons Clause.

## Install

Requires **Node.js 20+** and an authenticated **Salesforce CLI** (`sf`).

```sh
npm install -g sf-intelligence
```

(or run it ad hoc with `npx -y sf-intelligence …` — no global install needed)

## Register the MCP server

**Claude Code** (from your Salesforce DX repo):

```sh
claude mcp add --transport stdio --scope project sf-intelligence -- npx -y sf-intelligence mcp
```

**Claude Desktop, or any other MCP client** — add to the client's MCP config:

```json
{
  "mcpServers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp"]
    }
  }
}
```

## First run

From your Salesforce DX repo (the directory with `sfdx-project.json`):

```sh
sfi init                               # create the local org-kb/ vault
sfi refresh --target-org my-org-alias  # retrieve metadata, build the vault
sfi status                             # freshness, source-tree hash, counts
sfi doctor                             # diagnose sf CLI / vault / auth issues
```

Then ask anything in your MCP client — *"what fields does Account have?"*,
*"what breaks if I delete this field?"*, *"why can't this profile see
Opportunities?"*, *"give me a tour of this org."*

## Boundaries

Read-only and offline by default. Static analysis, not runtime. No business
record data in the vault. The product names its limits plainly rather than
guessing.

## Documentation

Full guides, capabilities, the tool catalog, and configuration:
**https://salesforce-intelligence.pages.dev**

- [Getting started](https://salesforce-intelligence.pages.dev/getting-started.html)
- [Capabilities](https://salesforce-intelligence.pages.dev/capabilities.html) · [All tools](https://salesforce-intelligence.pages.dev/tools.html)
- [Configuration](https://salesforce-intelligence.pages.dev/configuration.html) · [FAQ](https://salesforce-intelligence.pages.dev/faq.html)
- [Quality & trust](https://salesforce-intelligence.pages.dev/trust.html)

## License

MIT + Commons Clause — see the `LICENSE` file shipped in this package, or
<https://salesforce-intelligence.pages.dev/licensing.html>.
