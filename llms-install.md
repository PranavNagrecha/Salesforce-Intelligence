# Installing sf-intelligence (instructions for AI agents)

sf-intelligence is a read-only, offline MCP server that answers questions about one Salesforce org from that org's retrieved metadata. It needs no API keys. It runs over stdio from the npm package `sf-intelligence` (command `sfi`). Requires Node.js 20 or newer.

## Step 1: decide which mode the user needs

Ask the user one question: "Do you want to try it on a demo org first, or connect your own Salesforce org?"

- Demo (no Salesforce login, nothing to build): go to Step 2A.
- Their own org: go to Step 2B.

## Step 2A: demo org (fastest)

Add this server to the MCP settings file (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "sf-intelligence-demo": {
      "command": "npx",
      "args": ["-y", "sf-intelligence", "demo"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

The first start unpacks a synthetic demo org to `~/.sf-intelligence/demo`. The server should list 25 tools. Suggested first question: "What happens when an Opportunity is saved?"

## Step 2B: the user's own org

Prerequisites (check each one, do not assume):

1. `node --version` prints v20 or newer.
2. The Salesforce CLI is installed (`sf --version`) and authenticated to the org (`sf org list`). If not, ask the user to run `sf org login web` themselves. Never handle their Salesforce password.
3. The user has a Salesforce DX project folder (contains `sfdx-project.json`). Ask for its absolute path.

Build the knowledge base (vault) once, from inside that project folder:

```bash
cd /absolute/path/to/sfdx-project
npx -y sf-intelligence init --target-org <alias-from-sf-org-list>   # creates ./org-kb bound to that org
npx -y sf-intelligence refresh                                     # retrieves metadata and builds the vault (can take several minutes on large orgs)
```

The vault is the folder `/absolute/path/to/sfdx-project/org-kb`. Then add the server, using the absolute vault path:

```json
{
  "mcpServers": {
    "sf-intelligence": {
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp", "--vault", "/absolute/path/to/sfdx-project/org-kb"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Always pass an absolute `--vault` path (or set the `SFI_VAULT` environment variable). MCP hosts do not start inside the user's project, so a relative path will not find the vault.

## Step 3: verify

- With a vault, the server lists its full tool set (25 core tools in 0.4.0) and `sfi.org_card` names the org.
- If it lists only one tool, `sfi.setup_status`, the server is in setup mode: the vault path is missing or wrong. Call `sfi.setup_status`; it reports the paths it checked. Fix the `--vault` path and restart the server.
- `npx -y sf-intelligence doctor` (run in the project folder) diagnoses the CLI, vault, org auth and freshness and prints fixes.
- Keep the vault current by re-running `npx -y sf-intelligence refresh` in the project folder after org changes.

## Notes

- Read-only: the server never writes to Salesforce. Optional live lookups are off unless the user turns them on.
- Windows: VS Code's `mcp.json` uses the key `servers`, not `mcpServers`. Cline uses `mcpServers`.
- Docs: https://sfi.auditforce.cloud
