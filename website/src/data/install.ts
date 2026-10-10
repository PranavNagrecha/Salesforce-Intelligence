/**
 * Install snippets per AI assistant. One source for the home page,
 * /getting-started and every CTA, so a host's config is fixed in one place.
 *
 * Rules (docs/guides/mcp-hosts.md in the product repo):
 *   - Always pass an absolute --vault path for your own org. Hosts launch the
 *     server from a working directory you don't control.
 *   - VS Code reads the "servers" key, not "mcpServers".
 *   - Codex uses TOML.
 */

export type InstallMode = "org" | "demo";

export interface HostSnippet {
  /** Shown above the code, e.g. a file name or "Terminal". */
  file: string;
  code: string;
  /** Plain-language help under the code (HTML allowed: <code>). */
  help?: string;
}

export interface Host {
  id: string;
  label: string;
  snippets: (mode: InstallMode) => HostSnippet[];
}

const VAULT = "/full/path/to/your-project/org-kb";

/** The server's args for each mode. */
const args = (mode: InstallMode): string[] =>
  mode === "demo" ? ["-y", "sf-intelligence", "demo"] : ["-y", "sf-intelligence", "mcp", "--vault", VAULT];

const jsonArgs = (a: string[]): string => "[" + a.map((x) => JSON.stringify(x)).join(", ") + "]";
const serverName = (mode: InstallMode): string => (mode === "demo" ? "sf-intelligence-demo" : "sf-intelligence");

export const DEMO_CLAUDE_CODE = "claude mcp add --scope user sf-intelligence-demo -- npx -y sf-intelligence demo";

export const hosts: Host[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    snippets: (mode) =>
      mode === "demo"
        ? [{ file: "Terminal", code: DEMO_CLAUDE_CODE, help: "Then start <code>claude</code> and ask a question. <code>/mcp</code> shows the server as connected." }]
        : [
            {
              file: "Terminal, in your Salesforce project folder",
              code: 'claude mcp add --scope project sf-intelligence -- npx -y sf-intelligence mcp --vault "$PWD/org-kb"',
              help: "<code>--scope project</code> writes a <code>.mcp.json</code> you can commit for your team. Check it with <code>/mcp</code>.",
            },
          ],
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    snippets: (mode) => [
      {
        file: "claude_desktop_config.json",
        code: `{
  "mcpServers": {
    "${serverName(mode)}": {
      "command": "npx",
      "args": ${jsonArgs(args(mode))}
    }
  }
}`,
        help:
          (mode === "org" ? "Use the full path to your <code>org-kb</code> folder (on Windows, double the backslashes). " : "") +
          "Merge this into the file if it already lists other servers, then fully quit and reopen Claude Desktop.",
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    snippets: (mode) => [
      {
        file: ".cursor/mcp.json",
        code: `{
  "mcpServers": {
    "${serverName(mode)}": {
      "command": "npx",
      "args": ${jsonArgs(args(mode))}
    }
  }
}`,
        help:
          (mode === "org" ? "Use the full path to your <code>org-kb</code> folder. " : "") +
          "Cursor doesn't reload this file by itself: turn the server off and on in Settings → MCP." +
          (mode === "demo"
            ? ' Or <a href="https://cursor.com/install-mcp?name=sf-intelligence-demo&amp;config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNmLWludGVsbGlnZW5jZSIsImRlbW8iXX0%3D">add the demo to Cursor in one click</a>.'
            : ""),
      },
    ],
  },
  {
    id: "vscode",
    label: "VS Code + Copilot",
    snippets: (mode) => [
      {
        file: ".vscode/mcp.json",
        code: `{
  "servers": {
    "${serverName(mode)}": {
      "type": "stdio",
      "command": "npx",
      "args": ${jsonArgs(mode === "demo" ? args(mode) : ["-y", "sf-intelligence", "mcp", "--vault", "${workspaceFolder}/org-kb"])}
    }
  }
}`,
        help: "VS Code reads the <code>servers</code> key, not <code>mcpServers</code>. With the wrong key it loads nothing and shows no error. Use Copilot Chat in Agent mode.",
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    snippets: (mode) => [
      {
        file: "Terminal",
        code:
          mode === "demo"
            ? "codex mcp add sf-intelligence-demo -- npx -y sf-intelligence demo"
            : `codex mcp add sf-intelligence -- npx -y sf-intelligence mcp --vault ${VAULT}`,
      },
      {
        file: "or by hand: ~/.codex/config.toml",
        code: `[mcp_servers.${serverName(mode)}]
command = "npx"
args = ${jsonArgs(args(mode))}
startup_timeout_sec = 30`,
        help: "Codex uses TOML. A longer start-up timeout gives the first download time to finish. Check it with <code>codex mcp list</code>.",
      },
    ],
  },
];
