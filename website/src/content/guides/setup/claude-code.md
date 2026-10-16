---
title: "Salesforce MCP Server in Claude Code: Setup Guide"
description: "Add a Salesforce MCP server to Claude Code with one command, or install the plugin with its skills and slash commands. Includes the Windows notes and the vault path rule."
slug: /setup/claude-code
targetQuery: "claude code salesforce mcp"
persona: "Salesforce developer or admin using Claude Code"
datePublished: 2026-10-16
dateModified: 2026-10-16
faq:
  - q: "Do I still need claude mcp add if I installed the plugin?"
    a: "No. The plugin registers the same server. What it cannot do is guess where your org-kb folder is, so set SFI_VAULT to the full path of that folder, or start Claude Code from the folder that holds it."
  - q: "Why does /mcp show the server connected but every answer is empty?"
    a: "The server is running but has not found your org's metadata, so it is in setup mode. Ask \"is the server set up?\" and it reports where it looked and which command to run. Usually the vault path is missing or relative."
  - q: "Where does Claude Code keep the MCP config?"
    a: "Project scope writes .mcp.json at the root of your project, which you can commit for your team. User and local scope live in ~/.claude.json (on Windows, %USERPROFILE%\\.claude.json). Claude Code does not read ~/.claude/mcp.json."
  - q: "Does npx work on Windows?"
    a: "Yes. Claude Code starts npx the same way on Windows as on macOS, so the one-line command works as written. Only if you hand-write the JSON do you need to double the backslashes in the vault path, or use forward slashes."
related:
  - /setup/claude-desktop
  - /setup/cursor
  - /setup/vs-code-copilot
  - /getting-started
  - /how-to/pre-deployment-impact-review
section: setup
heading: "Salesforce MCP in Claude Code: one command, or the plugin"
answer: "From your Salesforce project folder, run `claude mcp add --scope project sf-intelligence -- npx -y sf-intelligence mcp --vault \"$PWD/org-kb\"` after `init` and `refresh` have built the `org-kb` folder. Check with `/mcp`, then ask in plain words. The plugin adds skills and slash commands on top; it needs `SFI_VAULT` or a start from the project folder to find the vault."
schemaType: TechArticle
cta: false
---
## Before you start

You need:

1. **Claude Code**, installed and signed in.
2. **Node.js 20 or later.** Check with `node --version`.
3. **The Salesforce CLI**, logged in to your org. Check with `sf org list`. If needed, run `sf org login web --alias my-org`.
4. **A folder to work in.** Your Salesforce DX project is best. Any folder works: `init` creates `sfdx-project.json` if there isn't one.

## Set it up

1. **Build the local copy of your org's metadata.** From your project folder, run:

   ```bash
   npx -y sf-intelligence init --target-org my-org
   npx -y sf-intelligence refresh --target-org my-org
   ```

   This retrieves metadata with the Salesforce CLI and stores it in an `org-kb` folder in your project. It reads only. Nothing is written to the org.

2. **Register the server.** One command, from the same folder:

   ```bash
   claude mcp add --scope project sf-intelligence -- npx -y sf-intelligence mcp --vault "$PWD/org-kb"
   ```

   The `--` matters: it tells Claude Code where its own options stop and the server's begin. `--scope project` writes a `.mcp.json` at the root of your project that you can commit for your team. Use `--scope user` to have the server in every project, in which case replace `"$PWD/org-kb"` with the full path to the folder.

3. **Check that it's connected.** Start `claude` and run `/mcp`. The server should be listed as connected. `claude mcp list` shows the same from a terminal.

4. **Ask a question.** For example: *"What happens when I save an Opportunity?"* The answer names the triggers, flows and rules it found, each one a component you can open.

### If answers come back empty

Ask *"is the server set up?"*. If the server did not find your `org-kb` folder it starts in setup mode and reports where it looked and which command to run. Usually step 1 was skipped, or `--vault` points somewhere else. Fix the path and run `/mcp` again to reconnect.

## The same thing by hand

`claude mcp add` writes this. If you prefer to edit `.mcp.json` yourself, use the full path to `org-kb`:

```json
{
  "mcpServers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp", "--vault", "/full/path/to/your-project/org-kb"]
    }
  }
}
```

Keep `--vault`. Without it the server looks for `org-kb` in whatever folder it was started from, which is not always your project.

## The plugin: skills and slash commands

The plugin adds skills that switch on when you talk about Salesforce, and slash commands such as `/sfi-onboard` (a guided first run), `/sfi-refresh` and `/sfi-status`. Inside Claude Code:

```text
/plugin marketplace add PranavNagrecha/Salesforce-Intelligence
/plugin install sf-intelligence@sf-intelligence
```

Run `/reload-plugins`, or restart Claude Code, to pick it up. `/plugin list` confirms it is installed.

The plugin registers the same server, so you don't need `claude mcp add` as well. It cannot know where your vault is, though. Either:

- set `SFI_VAULT` to the full path of your `org-kb` folder in your shell profile, so Claude Code inherits it, or
- start Claude Code from the folder that holds `org-kb`.

If you use both the plugin and `claude mcp add`, the explicit `--vault` wins.

## Windows notes

| Problem | What to do |
|---|---|
| The one-line command | Works as written in PowerShell and Command Prompt. Claude Code starts `npx` correctly on Windows; no `cmd /c` wrapper is needed. |
| Path in a hand-written `.mcp.json` | Double every backslash: `"C:\\projects\\my-org\\org-kb"`, or use forward slashes: `"C:/projects/my-org/org-kb"`. Both work. |
| First start times out while `npx` downloads | Raise the start-up limit for that session: `$env:MCP_TIMEOUT = "60000"; claude`. The per-server `timeout` field is a per-call limit, not a start-up one. |
| `refresh` fails with a rename or lock error on the graph database | Windows will not replace a file another process holds open, and a connected server holds the vault database. Exit Claude Code, run the refresh again, then reopen it. A scheduled refresh should run while Claude Code is closed. |
| Where the user-scope config lives | `%USERPROFILE%\.claude.json`. Claude Code does not read `%APPDATA%\Claude\mcp.json`. |

Still stuck? Run `npx -y sf-intelligence doctor` in your project. It checks Node, the Salesforce CLI, the metadata folder and org login, and prints a fix for each problem.

## Try it on the demo org

No Salesforce org or CLI login needed:

```bash
claude mcp add --scope user sf-intelligence-demo -- npx -y sf-intelligence demo
```

Then start `claude` and ask: *"Can I delete the Amount field on Invoice?"* The first start downloads the package and builds the demo, so it takes a little longer.

Using Claude Desktop instead? It has no command line and needs the config file edited by hand. See [Salesforce MCP in Claude Desktop](/setup/claude-desktop).
