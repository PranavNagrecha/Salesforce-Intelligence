---
title: "Salesforce MCP Server in VS Code + Copilot: Setup Guide"
description: "Set up a Salesforce MCP server in VS Code with GitHub Copilot. Use the servers key, not mcpServers, pass --vault, and check the tools appear in Copilot."
slug: /setup/vs-code-copilot
targetQuery: "salesforce mcp server vscode copilot"
persona: "Salesforce developer or admin using VS Code with GitHub Copilot"
datePublished: 2026-10-10
dateModified: 2026-10-10
faq:
  - q: "Why does my MCP server not show up in VS Code?"
    a: "The most common cause is a .vscode/mcp.json that uses the mcpServers key copied from a Claude or Cursor guide. VS Code reads servers in that file. The file still parses, so you get no error, just no server."
  - q: "Which VS Code version do I need?"
    a: "VS Code 1.102 or later. That is the release where MCP support became generally available and user-level servers moved into mcp.json."
  - q: "Why are the tool names different in VS Code?"
    a: "VS Code does not allow dots in tool names, so sfi.what_happens_on_save shows up as sfi_what_happens_on_save. The tools work the same way."
  - q: "Why do I only see one tool, setup_status?"
    a: "The server is running but has not found your org's metadata yet. It starts in setup mode with one tool that tells you what to run. Build the local copy with init and refresh, then restart the server."
  - q: "Can I use sf-intelligence and the Salesforce DX MCP server together?"
    a: "Yes. Add both under servers in the same mcp.json. Note that Salesforce says the DX MCP server reaches end of life on November 2, 2026."
related:
  - /compare/salesforce-mcp-servers
  - /how-to/pre-deployment-impact-review
  - /errors/maximum-trigger-depth-exceeded
  - /getting-started
section: setup
heading: "Salesforce MCP in VS Code + Copilot: setup, and why your server silently does not load"
answer: "VS Code reads the `servers` key, not `mcpServers`. Put a `servers` block in `.vscode/mcp.json`, start the server with an absolute or `${workspaceFolder}` path to your org's metadata (`--vault`), then check **MCP: List Servers** and Copilot's **Configure Tools** list. If you pasted a Claude or Cursor config, that one key is why nothing appears."
schemaType: TechArticle
cta: false
---
## The one mistake that breaks most setups

Most MCP guides are written for Claude or Cursor. Their config files use a top-level `mcpServers` key. VS Code's `.vscode/mcp.json` uses `servers` ([VS Code MCP configuration reference](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)).

If you paste `mcpServers` into `.vscode/mcp.json`:

- the file is still valid JSON,
- VS Code registers zero servers,
- no error dialog appears.

VS Code does underline the key in the editor. That is easy to miss if you created the file somewhere else.

| Host | Config file | Top-level key |
|---|---|---|
| VS Code + GitHub Copilot | `.vscode/mcp.json` | `servers` |
| Claude Code | `.mcp.json` | `mcpServers` |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` |
| Cursor | `.cursor/mcp.json` | `mcpServers` |

Newer VS Code builds also document a portable `.mcp.json` file at the project root that does use `mcpServers`. The `.vscode/mcp.json` file with `servers` is the route that works on every version since 1.102, so this guide uses it.

## Before you start

You need:

1. **VS Code 1.102 or later** with GitHub Copilot signed in.
2. **Node.js 20 or later.** Check with `node --version`.
3. **The Salesforce CLI**, logged in to your org. Check with `sf org list`. If needed, run `sf org login web --alias my-org`.
4. **A Salesforce DX project** for that org, open in VS Code.

## Set it up

1. **Build the local copy of your org's metadata.** From your project folder, run:

   ```bash
   npx -y sf-intelligence init --target-org my-org
   npx -y sf-intelligence refresh --target-org my-org
   ```

   This retrieves metadata with the Salesforce CLI and stores it in an `org-kb` folder in your project. It reads only. Nothing is written to the org.

2. **Create `.vscode/mcp.json`** in the project and paste:

   ```json
   {
     "servers": {
       "sf-intelligence": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "sf-intelligence", "mcp", "--vault", "${workspaceFolder}/org-kb"],
         "cwd": "${workspaceFolder}"
       }
     }
   }
   ```

   VS Code fills in `${workspaceFolder}` for you. Keep `--vault`. Without it, the server looks for `org-kb` in whatever folder it was started from, which may not be your project.

3. **Start the server.** Open the Command Palette and run **MCP: List Servers**. Select `sf-intelligence` and choose Start. A workspace server follows your Workspace Trust setting.

4. **Check that it is running.** In **MCP: List Servers**, the server should show as running. If not, choose Show Output to see why.

5. **Check that Copilot sees the tools.** Open Copilot Chat in Agent mode. Select the **Configure Tools** button in the chat input. You should see `sf-intelligence` with tools such as `sfi_route_question`, `sfi_what_happens_on_save` and `sfi_safe_to_delete_field`. VS Code swaps the dots in tool names for underscores and logs a warning for each. That is cosmetic.

6. **Ask a question.** For example: *"What happens when I save an Opportunity?"* The answer should name the triggers, flows and rules it found.

### If you only see `sfi_setup_status`

That is setup mode, not a failure. The server started but did not find your metadata. Ask Copilot: *"What do you need from me?"* The tool reports where it looked and which command to run. Usually step 1 was skipped, or `--vault` points to the wrong folder. Restart the server after fixing it.

## User-level setup (every project)

To make the server available in all workspaces, run **MCP: Open User Configuration**. `${workspaceFolder}` has nothing to point at there, so use a full path:

```json
{
  "servers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp", "--vault", "/absolute/path/to/my-org/org-kb"]
    }
  }
}
```

Keep the server name hyphenated (`sf-intelligence`). VS Code groups server instructions on underscores, so `sf_intelligence` gets grouped wrongly.

## Running it next to the Salesforce DX MCP server

sf-intelligence explains your org and never changes it. The Salesforce DX MCP server can deploy, retrieve and run tests. They work side by side in one file. The DX block below is copied from [Salesforce's README](https://github.com/salesforcecli/mcp):

```json
{
  "servers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp", "--vault", "${workspaceFolder}/org-kb"],
      "cwd": "${workspaceFolder}"
    },
    "Salesforce DX": {
      "command": "npx",
      "args": ["-y", "@salesforce/mcp", "--orgs", "DEFAULT_TARGET_ORG",
               "--toolsets", "orgs,metadata,data,users",
               "--tools", "run_apex_test", "--allow-non-ga-tools"]
    }
  }
}
```

Be aware: Salesforce says `@salesforce/mcp` reaches end of life on November 2, 2026 ([announcement](https://github.com/forcedotcom/mcp/issues/46)). For a full comparison, see [Salesforce MCP servers compared](/compare/salesforce-mcp-servers).

## Windows notes

| Problem | What to do |
|---|---|
| Path in a user-level config | Double every backslash in JSON: `"D:\\projects\\my-org\\org-kb"`. The workspace file with `${workspaceFolder}` needs no change. |
| `spawn npx ENOENT` | Wrap the command: `"command": "cmd"`, `"args": ["/c", "npx", "-y", "sf-intelligence", "mcp", "--vault", "..."]`. A console window may flash at start. |
| You tried `"command": "npx.cmd"` | Do not. Node refuses to start a `.cmd` file directly and returns `EINVAL`. Use `npx` or the `cmd /c` form. |
| Refresh fails with a lock error | Windows will not replace a file another process holds open. Stop the server in **MCP: List Servers**, run the refresh, then start it again. |
| VS Code started from the Start menu cannot find Node | Apps started outside a terminal get the system PATH. Install globally (`npm install -g sf-intelligence`) and point `command` at the full path to `node.exe`, with the full path to `sfi.js` in `args`. |
| Remote-SSH, WSL or dev containers | Use **MCP: Open Remote User Configuration**. The server runs on the remote side, so Node, the Salesforce CLI and `org-kb` must exist there. |

Still stuck? Run `npx -y sf-intelligence doctor` in your project. It checks Node, the Salesforce CLI, the metadata folder and org login, and prints a fix for each problem.

## With sf-intelligence: a first question to try

Once the tools show up, try a question that needs your org's real metadata. On the built-in demo org, ask: *"What breaks if I delete Invoice__c.Amount__c?"* Copilot can call `sfi_safe_to_delete_field`. The answer is **blocking**:

<div class="found-card">

**What it found**

- **Apex:** the `PaymentService` class uses the field.
- **Formula:** `Invoice__c.Balance__c` is calculated from it.
- **Roll-up:** `Project__c.Total_Invoiced__c` adds it up.

</div>

Each blocker is a named component you can open. The same answer lists the categories it could not check, such as reports and Lightning pages, so a short list never reads as "nothing else uses it".

<details class="tool-call">
<summary>For developers: the raw answer</summary>

```json
"verdict": "blocking",
"reasoning": [
  { "category": "apex",    "verdict": "blocking", "examples": [{ "id": "ApexClass:PaymentService" }] },
  { "category": "formula", "verdict": "blocking", "examples": [{ "id": "CustomField:Invoice__c.Balance__c" }] },
  { "category": "rollup",  "verdict": "blocking", "examples": [{ "id": "CustomField:Project__c.Total_Invoiced__c" }] }
]
```

</details>

## Try it on the demo org

No Salesforce org or CLI login needed. Add this to `.vscode/mcp.json` in any folder:

```json
{
  "servers": {
    "sf-intelligence-demo": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "demo"]
    }
  }
}
```

VS Code runs `npx -y sf-intelligence demo` for you. It is a server that waits for VS Code to talk to it, so there is nothing to run in a terminal. The first start downloads the package and builds the demo, so it takes a little longer. Later starts are faster. Then ask: *"What happens when I save a Project?"*
