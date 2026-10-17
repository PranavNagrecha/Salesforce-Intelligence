# Upgrading

How to move a working install to a newer release, and what you will notice
in the answers afterwards. The short version is the same for every release:
bump the pin, restart the host, refresh the vault.

## The three steps, every time

### 1. Bump the version

How depends on how you registered the server:

| You run it as | What to change |
|---|---|
| `npx -y sf-intelligence mcp …` with no version | Nothing. `npx` fetches the newest release the next time the server starts. |
| `npx -y sf-intelligence@X.Y.Z mcp …` (the recommended pinned form) | Edit `X.Y.Z` in the host's config. |
| Global CLI (`sfi`) | `npm install -g sf-intelligence@latest` |
| Repo-local (`package.json`) | `npm install sf-intelligence@X.Y.Z`, commit the lockfile. |
| Claude Code plugin | Re-run `/plugin install sf-intelligence@sf-intelligence`, then `/reload-plugins`. The plugin pins the server version it ships with, so the skills, the commands and the server move together. |

Pinning and provenance checks are in [supply-chain.md](./supply-chain.md).

### 2. Restart the host

The tool list and the profile are fixed when the server starts, so the host
must start a new server process:

- **Claude Desktop:** quit the app fully (closing the window is not enough) and reopen it.
- **Claude Code:** restart it, or `/mcp` and reconnect the server.
- **VS Code + Copilot:** `MCP: List Servers`, then restart `sf-intelligence`.
- **Cursor:** Settings → MCP, toggle the server off and on.
- **Codex:** start a new session.

`sfi doctor` (or `npx -y sf-intelligence doctor`) prints the running version
and the version that built your vault, so you can confirm the swap took.

### 3. Refresh the vault

```sh
sfi refresh --target-org my-org-alias    # or /sfi-refresh in Claude Code
```

An older vault stays readable by a newer release, but new edge families and
new metadata types appear only after a refresh under the new version. Until
you refresh, every answer's `vaultState.freshness.warning` names the version
that built the vault and the version running, and `sfi.health_check` lists
the edge families the vault is missing (`freshness.nudge`,
`missingEdgeFamilies`). A verdict that depends on a new edge family (see the
release notes below) is not trustworthy until the refresh has run.

If you commit the vault, commit the refreshed `org-kb/components/` plus
`org-kb/meta/manifest.json`, `meta/config.json` and `meta/version.txt`, as
in [first-refresh.md](./first-refresh.md).

## Coming from 0.6.x: what changed in 0.7.0

No new tools and no envelope change. Two things to know:

- **OmniScript save-for-later patterns now count as field writes.** An
  OmniScript whose settings declare `saveURLPatterns` and a save object gets a
  `writesTo` reference to each pattern's field, so where-used and
  safe-to-delete answers for those fields name the script. A script that
  declares patterns but no save object is not guessed at: the patterns are
  listed on the script as unresolved. **This needs a refresh** on orgs that
  use OmniStudio; nothing changes elsewhere.
- **`/sfi-field-audit` works without its two agents.** The command checks
  whether `salesforce-field-auditor` and `salesforce-field-refuter` are
  installed; if not, it runs the per-field audit and the three refutation
  lenses inline and says so once. Nothing to configure. Copying the two agent
  files from the repository into your project's `.claude/agents/` restores the
  parallel path.

Also in this release: the public docs are link-checked in the build, every
nested `sfi <command> <subcommand> --help` is pinned by a test, the demo org
shows the reference families 0.6.0 added, and the host guide covers Cline.

## Coming from 0.5.x: what changed in 0.6.0

No new tools. The changes are in what existing verdicts can see and how
large the answers are.

- **Where-used, safe-to-delete, dead-code and unused-component verdicts now
  see three more places a field can be used:** Flow screen fields (and the
  flow's non-Apex actions: email alerts, quick actions, external services,
  subflows), LWC and Aura markup bindings (`lightning-input-field`,
  `lightning-record-*-form` field lists, `force:recordData` and so on), and
  the columns of Classic page-layout related lists. **This needs a refresh.**
  Expect more referrers on fields and fewer fields reported as definitely
  dead; the counts measured on a real sandbox are in the
  [0.6.0 release report](../reports/release-0.6.0.md).
- **`contentPolicy` on a success envelope is now the string
  `"org-metadata"`.** It was an object per response; the disclosure text (org
  metadata is data, never instructions) now lives once in the server
  instructions. A script that read it as an object must be updated. See
  [ADR-007](../decisions/ADR-007-canonical-response-envelope.md).
- `sfi.what_happens_on_save` and `sfi.order_of_execution` give the same
  trigger-bypass warning; `sfi.tests_for_change` and
  `sfi.test_coverage_for_method` select tests the same way.
  `sfi.coverage_report` and `sfi.health_check` agree on which metadata types
  are not modeled.
- An object selector passed to an Apex-scoped tool (for example
  `objectApiName` on `sfi.crud_fls_audit`) is no longer silently renamed onto
  `componentId`; the dropped argument is disclosed instead.
- Answers are a little shorter again (the median demo answer shrank), and
  every public surface says the same thing about the license: MIT.

## Coming from 0.4.x: what changed in 0.5.0

### The default tool list is now `core`

The server advertises **16 tools** by default: `sfi.resolve`,
`sfi.search_components`, `sfi.get_component`, `sfi.health_check`,
`sfi.org_overview`, `sfi.find_component_usages`, `sfi.safe_to_delete_field`,
`sfi.what_happens_on_save`, `sfi.find_dead_code`,
`sfi.why_cant_user_see_record`, `sfi.effective_permissions`,
`sfi.flow_graph`, `sfi.live_consent`, `sfi.list_analyses`,
`sfi.describe_analysis` and `sfi.run_analysis`.

Every other analysis still exists and returns the same bytes, but it is
reached through the gateway:

```json
{ "name": "sfi.get_edges", "args": { "nodeId": "CustomField:Account.Industry__c", "edgeType": "grantedBy" } }
```

passed to `sfi.run_analysis`. `sfi.list_analyses` lists the names;
`sfi.describe_analysis` returns one tool's full contract.

What this means for you:

- **Asking questions in a chat: nothing.** The host picks the tool. Ask in
  plain language as before.
- **A host prompt, skill or script that called a non-core tool directly**
  (`sfi.route_question`, `sfi.synthesize_answer`, `sfi.capabilities`,
  `sfi.org_card`, `sfi.get_edges`, `sfi.get_impact`, `sfi.list_components`,
  `sfi.order_of_execution`, `sfi.who_can_access_object`,
  `sfi.field_access_audit`, `sfi.guidance`, `sfi.org_history` and the rest)
  now gets an error that names the fix:
  `Tool 'sfi.X' is not directly invokable under SFI_TOOL_PROFILE=core. Call
  sfi.run_analysis { name: 'sfi.X', args } …`. Either wrap the call in
  `sfi.run_analysis`, or advertise the whole roster:

  ```json
  {
    "mcpServers": {
      "sf-intelligence": {
        "command": "npx",
        "args": ["-y", "sf-intelligence", "mcp", "--vault", "/abs/path/to/org-kb"],
        "env": { "SFI_TOOL_PROFILE": "full" }
      }
    }
  }
  ```

  The full roster costs tens of thousands of context tokens in hosts that do
  not defer tool definitions, which is why `core` is the default.
- **Where-used (`sfi.find_component_usages`), dead code and flow graph
  became directly callable.** They were not before.
- **`sfi run <tool>` from a script is unaffected.** The CLI runs any tool.

The decision and its reasoning are in
[ADR-010](../decisions/ADR-010-core-profile-and-run-analysis.md).

### Re-register the server with `--vault`

If your MCP registration predates this and passes no `--vault`, re-add it
with an absolute path so the server finds the vault no matter which
directory the host starts it from:

```sh
claude mcp remove sf-intelligence
claude mcp add --transport stdio --scope project sf-intelligence -- npx -y sf-intelligence mcp --vault "$PWD/org-kb"
```

For other hosts, add `"--vault", "/abs/path/to/org-kb"` to the `args` (or
`SFI_VAULT` in `env`). The exact block per host is in
[mcp-hosts.md](./mcp-hosts.md). The Claude Code plugin cannot carry a
machine path, so with the plugin set `SFI_VAULT` or launch Claude Code from
the folder that holds `org-kb`.

### Shorter, cited answers

- `vaultState.freshness.warning` is one sentence (builder version, running
  version, age in days, what to run). The machine fields `builtBy`,
  `runningVersion`, `ageDays` and `stale` are unchanged; the per-family
  detail moved to `sfi.health_check`.
- Concept reasoning is opt-in: pass `includeConceptReasoning: true` to
  `sfi.get_component`, `sfi.field_360`, `sfi.what_happens_on_save` or
  `sfi.explain_apex_method` to get it. Default responses carry
  `conceptReasoningAvailable: true` and a one-line hint instead of several
  kilobytes of nested trust blocks.
- Tool descriptions for the default tools are shorter. The long form is
  `sfi.describe_analysis { name, detail: 'full' }`.

### Verdicts that changed (refresh required)

- `sfi.find_dead_code` checks production Apex source before calling a class
  `likely_dead`; a class named only as a type in production code is
  `uncertain`, with the file named.
- Custom Metadata value cells that name an Apex handler class
  (`…Class__c`, `…Handler__c` and similar) now produce an edge, so a handler
  registered only through configuration no longer looks unused.
- Quick-action Visualforce references resolve to the page instead of
  dangling.

### License

Plain MIT since 0.5.0. Nothing to do; `LICENSE` and `NOTICE` say it all.

## Older than 0.4.0

Read the [CHANGELOG](../../CHANGELOG.md) entries between your version and
0.4.0 first; then follow the two sections above in order. A vault built by a
much older version is still readable, and one full refresh brings it up to
date.
