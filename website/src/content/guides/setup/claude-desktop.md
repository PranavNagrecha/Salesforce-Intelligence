---
title: "Salesforce MCP Server in Claude Desktop: Setup Guide"
description: "Set up a Salesforce MCP server in Claude Desktop: which file to edit, the mcpServers block with a full --vault path, and the restart that loads it. With Windows notes."
slug: /setup/claude-desktop
targetQuery: "claude desktop salesforce mcp"
persona: "Salesforce admin or developer using the Claude Desktop app"
datePublished: 2026-10-16
dateModified: 2026-10-16
faq:
  - q: "Why doesn't the server show up after I saved the config?"
    a: "Claude Desktop reads the file only at start-up, and closing the window is not a restart. Fully quit the app (on macOS, Quit from the menu bar; on Windows, Exit from the tray icon), then open it again."
  - q: "Why is --vault required in Claude Desktop?"
    a: "The app is started from the Dock or the Start menu, so the server gets no useful working folder. Without a full --vault path it looks for org-kb in the wrong place and starts in setup mode."
  - q: "Why do I only see one tool, setup_status?"
    a: "That is setup mode. The server started but did not find your org's metadata folder. Ask \"what do you need from me?\" and the tool tells you where it looked and which command to run."
  - q: "Can I use the same block in Claude Code or Cursor?"
    a: "Yes. Claude Code's .mcp.json and Cursor's .cursor/mcp.json use the same mcpServers key. VS Code does not: it reads a servers key in .vscode/mcp.json."
related:
  - /setup/claude-code
  - /setup/cursor
  - /setup/vs-code-copilot
  - /getting-started
  - /use-cases/claude-salesforce-mcp
section: setup
heading: "Salesforce MCP in Claude Desktop: setup"
answer: "Build your org's metadata folder with `init` and `refresh`, then add an `mcpServers` block to `claude_desktop_config.json` that starts `npx -y sf-intelligence mcp --vault` with the **full path** to that folder. Fully quit and reopen Claude Desktop. The tools appear under the tools menu in a new chat."
schemaType: TechArticle
cta: false
---
## Before you start

You need:

1. **Claude Desktop**, signed in.
2. **Node.js 20 or later.** Check with `node --version` in a terminal.
3. **The Salesforce CLI**, logged in to your org. Check with `sf org list`. If needed, run `sf org login web --alias my-org`.
4. **A folder for the metadata.** Your Salesforce DX project is best. Any folder works: `init` creates `sfdx-project.json` if there isn't one.

## Set it up

1. **Build the local copy of your org's metadata.** In a terminal, from that folder, run:

   ```bash
   npx -y sf-intelligence init --target-org my-org
   npx -y sf-intelligence refresh --target-org my-org
   ```

   This retrieves metadata with the Salesforce CLI and stores it in an `org-kb` folder. It reads only. Nothing is written to the org. Note the full path to `org-kb`; you need it in the next step.

2. **Open the config file.** In Claude Desktop, go to Settings, then Developer, then **Edit Config**. That opens the folder holding `claude_desktop_config.json`:

   | System | Config file |
   |---|---|
   | macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
   | Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

3. **Add the server.** Paste this, replacing the path with the full path to your `org-kb` folder:

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

   If the file already lists other servers, add the `sf-intelligence` entry inside the existing `mcpServers` block instead of replacing the file. Keep `--vault`: Claude Desktop is started from the Dock or the Start menu, so the server has no working folder of its own and cannot find `org-kb` without the full path.

4. **Fully quit and reopen Claude Desktop.** Closing the window is not enough. On macOS, choose Quit from the menu bar; on Windows, Exit from the tray icon. The config is read at start-up only.

5. **Check that it loaded.** Start a new chat and open the tools menu in the message box. `sf-intelligence` should be listed with its tools.

6. **Ask a question.** For example: *"What happens when I save an Opportunity?"* The answer names the triggers, flows and rules it found. Claude Desktop asks for your approval before it runs a tool, unless you allow the server for the chat.

### If you only see `setup_status`

That is setup mode, not a failure. The server started but did not find your metadata. Ask: *"What do you need from me?"* The tool reports where it looked and which command to run. Usually step 1 was skipped, or the `--vault` path is wrong. Fix it, then quit and reopen the app.

### If it does not connect at all

Claude Desktop writes a log per server:

| System | Log file |
|---|---|
| macOS | `~/Library/Logs/Claude/mcp-server-sf-intelligence.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-sf-intelligence.log` |

The last lines say why the server stopped. A JSON mistake in the config file (a missing comma, a stray brace) is the most common cause.

## Windows notes

| Problem | What to do |
|---|---|
| Path in the config | Double every backslash: `"C:\\projects\\my-org\\org-kb"`, or use forward slashes: `"C:/projects/my-org/org-kb"`. Both work. |
| `npx` | Works as written. The server is started the same way on Windows as on macOS; no `cmd /c` wrapper is needed. |
| `spawn npx ENOENT` in the log | Claude Desktop was started from the Start menu and got the system PATH, not your terminal's. Install Node.js for all users, or point `command` at the full path to `node.exe` and put the full path to `sfi.js` (from `npm install -g sf-intelligence`) first in `args`. |
| `refresh` fails with a rename or lock error on the graph database | Windows will not replace a file another process holds open, and a connected server holds the vault database. Quit Claude Desktop fully, run the refresh again, then reopen it. A scheduled refresh should run while the app is closed. |
| First start is slow or times out | The first `npx` run downloads the package. Try the chat again after a minute; later starts are faster. |

Still stuck? Run `npx -y sf-intelligence doctor` in your project folder. It checks Node, the Salesforce CLI, the metadata folder and org login, and prints a fix for each problem.

## Try it on the demo org

No Salesforce org or CLI login needed. Add this to `claude_desktop_config.json`, then quit and reopen the app:

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

Using Claude Code instead? It takes one command and can add the plugin. See [Salesforce MCP in Claude Code](/setup/claude-code).
