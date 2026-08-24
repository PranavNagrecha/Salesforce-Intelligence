# Connecting your AI host — Claude, Codex, VS Code + Copilot

`sf-intelligence` is a stdio MCP server. Every AI host launches it the same way
— `npx -y sf-intelligence mcp` — but each host reads a **different config file**
in a **different format**, and two of them launch the server from a working
directory you do not control. Getting those two facts wrong is the single most
common reason the tools never appear.

This page gives the exact file, the exact block, and the exact place to look
when it fails, for each host on **macOS and Windows**.

> Verified against Claude Code 2.1.x, Claude Desktop, Codex CLI, and VS Code
> 1.134 (August 2026). These contracts have each changed more than once — if
> something below does not match your version, trust your host's own docs and
> please [open an issue](https://github.com/PranavNagrecha/Salesforce-Intelligence/issues).

## The two rules that matter more than the rest

**1. Always pass an absolute `--vault` path.**

The server resolves its vault as `./org-kb` relative to **its own working
directory**, and most hosts choose that directory for you — Claude Desktop and a
user-scope VS Code server do not run in your Salesforce project at all. Pinning
the vault is what makes the config work regardless:

```
npx -y sf-intelligence mcp --vault /absolute/path/to/your-project/org-kb
```

Every block below does this. `SFI_VAULT` in an `env` block is the equivalent for
manifests that cannot carry a machine-specific path (precedence:
`--vault` > `SFI_VAULT` > `./org-kb`).

**2. Build the vault before you judge the connection.**

Until `sfi refresh` has completed, the server starts in **setup mode**: it
connects and exposes a single tool, `sfi.setup_status`, which tells your chat
exactly what to run. That is expected, not a failure — ask the chat "what do you
need from me?" and it will walk you through it. See
[installation.md](./installation.md) for the `init` → `refresh` path.

## Which host are you using?

| Host | Config file | Top-level key |
|---|---|---|
| [Claude Code](#claude-code) | `.mcp.json` (project) or `~/.claude.json` | `mcpServers` |
| [Claude Desktop](#claude-desktop) | `claude_desktop_config.json` | `mcpServers` |
| [Codex](#codex) | `~/.codex/config.toml` | `[mcp_servers.<name>]` (TOML) |
| [VS Code + GitHub Copilot](#vs-code--github-copilot) | `.vscode/mcp.json` | **`servers`** — not `mcpServers` |

> **The most common mistake:** pasting the Claude block (`"mcpServers"`) into VS
> Code's `mcp.json`, which expects `"servers"`. The file still parses, VS Code
> registers **zero** servers, and nothing appears in `MCP: List Servers` — no
> error dialog, no output channel. VS Code does underline the key in the editor
> ("Property mcpServers is not allowed"), which is easy to miss if you wrote the
> file outside VS Code.

## Claude Code

One command, from your Salesforce project directory:

```sh
claude mcp add --scope project sf-intelligence -- \
  npx -y sf-intelligence mcp --vault "$PWD/org-kb"
```

The `--` separator is required: it tells Claude Code where its own flags stop
and the server's begin. `--scope project` writes `.mcp.json` at the repo root
(commit it to share with your team); `--scope user` makes it available in every
project; the default `local` keeps it private to you in this project.

Verify with `/mcp` inside Claude Code, or `claude mcp list`.

| | macOS | Windows |
|---|---|---|
| Project scope | `.mcp.json` at repo root | same |
| Local / user scope | `~/.claude.json` | `%USERPROFILE%\.claude.json` |
| Debug log | `claude --debug=mcp` → `~/.claude/debug/<session>.txt` | same, under `%USERPROFILE%` |

Hand-written `.mcp.json` equivalent:

```json
{
  "mcpServers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp", "--vault", "/abs/path/to/org-kb"]
    }
  }
}
```

> Claude Code does **not** read `~/.claude/mcp.json`, `~/.claude/.mcp.json`, or
> `%APPDATA%\Claude\mcp.json`. If you invented one of those paths, that is why
> nothing loaded.
>
> The per-server `timeout` field is a **per-tool-call** limit, not a startup
> timeout. If a cold `npx` download is timing out at startup, raise
> `MCP_TIMEOUT` instead (PowerShell: `$env:MCP_TIMEOUT = "60000"; claude`).

## Claude Desktop

Claude Desktop has no CLI — edit the file directly, then fully quit and reopen
the app (closing the window is not enough).

| | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

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

On Windows, backslashes must be **doubled** inside JSON:
`"C:\\Users\\you\\project\\org-kb"`.

**`--vault` is not optional here.** Claude Desktop is launched from the Dock or
Start menu and gives the server no meaningful working directory, so `./org-kb`
will not resolve to your project.

If you already have other servers in that file, **merge** into the existing
`mcpServers` object rather than replacing the file.

Logs, when it does not connect:

| | Path |
|---|---|
| macOS | `~/Library/Logs/Claude/mcp-server-sf-intelligence.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-sf-intelligence.log` |

## Codex

Codex uses **TOML**, not JSON.

| | Path |
|---|---|
| macOS / Linux | `~/.codex/config.toml` |
| Windows | `%USERPROFILE%\.codex\config.toml` |

Add via the CLI:

```sh
codex mcp add sf-intelligence -- npx -y sf-intelligence mcp --vault /abs/path/to/org-kb
```

or by hand:

```toml
[mcp_servers.sf-intelligence]
command = "npx"
args = ["-y", "sf-intelligence", "mcp", "--vault", "/abs/path/to/org-kb"]
startup_timeout_sec = 30
```

On Windows use a TOML **literal string** (single quotes) so backslashes are not
escape sequences: `'C:\Users\you\project\org-kb'`.

Verify with `codex mcp list`.

Two Codex-specific traps:

- **Raise `startup_timeout_sec`.** Codex's default is around 10 seconds. A first
  run has to download the package, and the server briefly probes your
  authenticated orgs at startup — comfortably inside 10s on a fast link, but not
  behind a corporate proxy or with aggressive antivirus scanning. `30` costs
  nothing.
- **Codex filters the environment it passes to servers.** If you are behind a
  proxy, the child will not inherit your proxy settings unless you allow them
  through:

  ```toml
  env_vars = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]
  ```

  For the same reason, prefer the `--vault` flag over `SFI_VAULT` on Codex — the
  flag always reaches the server.

If you run Codex from inside the ChatGPT desktop app rather than a terminal, the
`codex` binary lives at
`/Applications/ChatGPT.app/Contents/Resources/codex` on macOS.

## VS Code + GitHub Copilot

Requires VS Code **1.102 or later** (MCP first shipped in 1.99; 1.102 is where it
went GA and user-level servers moved into `mcp.json`).

**Workspace scope — recommended.** Create `.vscode/mcp.json` in your Salesforce
project. This file is byte-identical on Windows and macOS:

```json
{
  "servers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp"],
      "cwd": "${workspaceFolder}",
      "env": { "SFI_VAULT": "${workspaceFolder}/org-kb" }
    }
  }
}
```

Note the top-level key is **`servers`**. `${workspaceFolder}` is VS Code's own
variable — this is the one host where you do not need to hard-code an absolute
path, because the workspace folder is well defined.

**User scope.** Run **`MCP: Open User Configuration`** from the command palette
rather than hand-typing the path (non-default profiles nest under an opaque
profile ID). `${workspaceFolder}` has nothing to resolve against in this file, so
use an absolute vault path:

```json
{
  "servers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp",
               "--vault", "C:\\Users\\you\\project\\org-kb"]
    }
  }
}
```

For reference, that file lives at `%APPDATA%\Code\User\mcp.json` on Windows and
`~/Library/Application Support/Code/User/mcp.json` on macOS.

Then open Copilot Chat in **agent mode** and confirm with `MCP: List Servers`.

Two notes:

- Keep the server name **hyphenated** (`sf-intelligence`). VS Code groups server
  instructions on an underscore, so `sf_intelligence` mis-keys the group.
- VS Code renames the tools from `sfi.route_question` to `sfi_route_question`
  (dots are not allowed) and logs a warning per tool. This is cosmetic — the
  tools work.
- If you use **Remote-SSH, WSL, or a dev container**, the server is configured by
  `MCP: Open Remote User Configuration` — a *separate* file. Your local config
  does not apply, and the server runs on the remote side, so the vault and the
  `sf` CLI must exist there too.

> **GitHub Copilot CLI** (the `copilot` terminal command) is a different product
> from Copilot in VS Code, and it currently **rejects tool names containing a
> dot** with `400 … String should match pattern '^[a-zA-Z0-9_-]{1,128}$'`. If
> that is your error, you are in the CLI, not VS Code agent mode.

## Windows: refreshing while your chat is open

On macOS and Linux you can run `sfi refresh` with the MCP server connected —
the rebuild swaps in behind it and the next question picks up the new vault.

**On Windows you cannot.** Windows will not let one process replace a file
another process is holding open, and a connected server holds the vault
database. The refresh fails with a lock error after doing all the work.

Close your MCP client (or stop `sfi mcp`), run the refresh, then reopen it:

```
# with the client closed
npx -y sf-intelligence refresh --target-org my-org-alias
```

This is a real limitation, not a misconfiguration — the product will tell you so
rather than claiming it recovered. A scheduled refresh should run when the
client is not attached.

## When it does not connect

Work down this list — it is ordered by how often each one is the answer.

**1. Is the vault built?** If the server connects but only offers
`sfi.setup_status`, that is setup mode telling you `sfi refresh` has not run.
Ask your chat to run `sfi.setup_status` and follow it.

**2. Is the vault where the server is looking?** `sfi.setup_status` reports
`lookedForVaultAt` and `serverLaunchDirectory`. If the directory is your home
folder or `/`, the host chose it — add `--vault <absolute path>`.

**3. Right file, right key?** `servers` for VS Code; `mcpServers` for Claude.
On Windows, backslashes doubled in JSON, single-quoted in TOML.

**4. Did you fully restart the host?** Claude Desktop must be quit entirely.
VS Code needs the server restarted from `MCP: List Servers`.

**5. Can the host find Node at all?** This is the one genuinely
platform-specific failure, and it affects **macOS as well as Windows**: an app
launched from the Dock, Start menu, or Explorer inherits the *system* PATH, not
your shell's. If `node` and `npx` work in your terminal but the server reports
`spawn ENOENT`, bypass PATH entirely:

```jsonc
// Find the paths first:
//   macOS:    which node && npm root -g
//   Windows:  where node   (then: npm root -g)
{
  "command": "/usr/local/bin/node",
  "args": ["/usr/local/lib/node_modules/sf-intelligence/bin/sfi.js",
           "mcp", "--vault", "/abs/path/to/org-kb"]
}
```

This requires `npm install -g sf-intelligence` first. It is the most robust form
on every host and both platforms, at the cost of hard-coding two machine paths.
If you use `nvm`, point at the stable symlink, not a versioned directory.

**6. Windows, still `ENOENT` on `npx`?** Bare `npx` is correct on all four hosts
— each resolves `npx.cmd` properly — and is what every vendor documents. If you
nonetheless hit it, wrap the command:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "sf-intelligence", "mcp",
           "--vault", "C:\\Users\\you\\project\\org-kb"]
}
```

Do **not** write `"command": "npx.cmd"` — Node refuses to spawn a `.cmd` file
directly (an `EINVAL` from the CVE-2024-27980 fix), which turns a recoverable
error into an unrecoverable one. Note the `cmd /c` form may flash a console
window each time the server starts.

**7. Still stuck?** Run `npx -y sf-intelligence doctor` in your project — it
checks Node, the `sf` CLI, the vault, org auth, freshness, and the graph, and
prints a fix for each problem. Include its output in a
[bug report](https://github.com/PranavNagrecha/Salesforce-Intelligence/issues).

## Pinning the version

The examples above float on `latest`, which is fine for a first try. For a
shared repo or a production config, pin an exact version —
`sf-intelligence@0.3.1` — in the `args`. See
[supply-chain.md](./supply-chain.md).
