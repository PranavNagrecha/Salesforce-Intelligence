---
title: "Salesforce MCP Server in Cursor: Setup Guide"
description: "Set up a Salesforce MCP server in Cursor: where .cursor/mcp.json goes, why you pass an absolute --vault path, and how to reload the server after an edit."
slug: /setup/cursor
targetQuery: "cursor salesforce mcp"
persona: "Salesforce developer or admin using Cursor"
datePublished: 2026-10-10
dateModified: 2026-10-10
faq:
  - q: "Why don't the sf-intelligence tools show up in Cursor?"
    a: "Usually Cursor has not reloaded the file. It does not pick up changes to .cursor/mcp.json by itself, so turn the server off and on in Cursor's MCP settings, or restart Cursor. Also check that the file uses the mcpServers key."
  - q: "Why do I only see one tool, setup_status?"
    a: "That is setup mode. The server started but did not find your org's metadata folder. Ask Cursor \"What do you need from me?\" and the tool tells you where it looked and which command to run."
  - q: "Can I use the same config in VS Code?"
    a: "No. VS Code reads a different file, .vscode/mcp.json, and a different top-level key, servers. Pasting a Cursor block into VS Code loads nothing and shows no error."
related:
  - /setup/vs-code-copilot
  - /getting-started
  - /compare/salesforce-mcp-servers
  - /how-to/pre-deployment-impact-review
section: setup
heading: "Salesforce MCP in Cursor: setup"
answer: "Cursor reads MCP servers from `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for every project, under the `mcpServers` key. Build your org's metadata folder first, point the server at it with an absolute `--vault` path, then turn the server off and on in Cursor's MCP settings. Cursor does not reload the file by itself."
schemaType: TechArticle
cta: false
---
## Before you start

You need:

1. **Cursor**, with Agent mode available in chat.
2. **Node.js 20 or later.** Check with `node --version`.
3. **The Salesforce CLI**, logged in to your org. Check with `sf org list`. If needed, run `sf org login web --alias my-org`.
4. **A Salesforce DX project** for that org, open in Cursor.

## Set it up

1. **Build the local copy of your org's metadata.** From your project folder, run:

   ```bash
   npx -y sf-intelligence init --target-org my-org
   npx -y sf-intelligence refresh --target-org my-org
   ```

   This retrieves metadata with the Salesforce CLI and stores it in an `org-kb` folder in your project. It reads only. Nothing is written to the org.

2. **Create `.cursor/mcp.json`** in the project and paste:

   ```json
   {
     "mcpServers": {
       "sf-intelligence": {
         "command": "npx",
         "args": ["-y", "sf-intelligence", "mcp", "--vault", "/full/path/to/your-project/org-kb"]
       }
     }
   }
   ```

   Replace the path with the full path to your `org-kb` folder. Keep `--vault`. Without it, the server looks for `org-kb` in whatever folder it was started from, which may not be your project. If the file already lists other servers, add this entry inside the existing `mcpServers` block.

   Cursor's [MCP documentation](https://cursor.com/docs/context/mcp) also lets you write `${workspaceFolder}/org-kb` in `args` instead of a full path. `${workspaceFolder}` is the folder that contains `.cursor/mcp.json`.

3. **Reload the server.** Cursor does not pick up changes to `.cursor/mcp.json` by itself. Turn the server off and on in Cursor's MCP settings (in recent versions, under **Customize** in the sidebar; in older versions, **Settings → MCP**), or restart Cursor.

4. **Ask a question.** Open chat in Agent mode and ask, for example: *"What happens when I save an Opportunity?"* The answer should name the triggers, flows and rules it found. Cursor asks for your approval before it runs a tool, unless you change that setting.

### If you only see `setup_status`

That is setup mode, not a failure. The server started but did not find your metadata. Ask: *"What do you need from me?"* The tool reports where it looked and which command to run. Usually step 1 was skipped, or `--vault` points to the wrong folder. Reload the server after fixing it.

## Every project, not just this one

To make the server available in all your projects, put the same block in `~/.cursor/mcp.json` in your home folder. Use a full `--vault` path there. One server reads one org's metadata folder, so for a second org, add a second entry with its own name and path.

## Windows notes

| Problem | What to do |
|---|---|
| Path in the config | Double every backslash in JSON: `"D:\\projects\\my-org\\org-kb"`. |
| `spawn npx ENOENT` | Wrap the command: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "sf-intelligence", "mcp", "--vault", "..."]`. A console window may flash at start. |
| You tried `"command": "npx.cmd"` | Do not. Node refuses to start a `.cmd` file directly and returns `EINVAL`. Use `npx` or the `cmd /c` form. |
| Refresh fails with a lock error | Windows will not replace a file another process holds open. Turn the server off in Cursor, run the refresh, then turn it on again. |
| Cursor cannot find Node | Apps started outside a terminal get the system PATH, not your shell's. Install globally (`npm install -g sf-intelligence`) and point `command` at the full path to `node`, with the full path to `sfi.js` in `args`. This applies on macOS too. |

Still stuck? Run `npx -y sf-intelligence doctor` in your project. It checks Node, the Salesforce CLI, the metadata folder and org login, and prints a fix for each problem.

## Try it on the demo org

No Salesforce org or CLI login needed. Add this to `.cursor/mcp.json` in any folder, then reload the server:

```json
{
  "mcpServers": {
    "sf-intelligence-demo": {
      "command": "npx",
      "args": ["-y", "sf-intelligence", "demo"]
    }
  }
}
```

The first start downloads the package and builds the demo, so it takes a little longer. Then ask: *"Can I delete the Amount field on Invoice?"*

Using VS Code instead? It reads a different key. See [Salesforce MCP in VS Code + Copilot](/setup/vs-code-copilot).
