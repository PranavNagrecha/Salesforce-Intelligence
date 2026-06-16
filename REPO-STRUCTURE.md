# Repository structure

Orientation for a developer or LLM working in this repo. Read this first to know
where things live and what to ignore.

## What this is

`sf-intelligence` is an **offline-first, read-only MCP server + `sfi` CLI** that
answers questions about one Salesforce org from a locally-built knowledge base
(the `org-kb/` vault). It is a **pnpm + TypeScript monorepo** (strict, ESM,
Node 20).

**Source vs. shipped artifact — important:**

- The monorepo has **11 packages** under `packages/` (source of truth).
- It **publishes as ONE npm package**, `sf-intelligence`. The `packages/cli`
  build bundles the other 10 into a single `dist/index.js` via esbuild; only
  `sf-intelligence` is public on npm — the other 10 are `private: true`.
- It **also works as a Claude Code plugin**: the `.claude/` layer (skills + slash
  commands) loads alongside the MCP server. The plugin layer is a convenience on
  top of the same package, not a separate distribution.

So: edit code in `packages/*/src`; the user installs one npm package.

## Top level

```
sf-intelligence/
├── packages/          # the 11-package monorepo — all TypeScript source (see below)
├── .claude/           # Claude Code plugin layer: skills/ + commands/
├── .claude-plugin/    # plugin.json + marketplace.json (Claude Code manifests)
├── org-kb/            # the generated per-org vault (gitignored — each user builds their own)
├── scripts/           # maintainer scripts (release guard/snapshot, sast, fleet)
├── eval/              # retrieval + analytical eval harness (golden cases)
├── tests/             # cross-package integration tests (unit tests are per-package)
├── docs/              # human docs — start at docs/README.md
├── assets/            # README / social images
├── .github/           # CI workflow (ci.yml)
├── README.md  CHANGELOG.md  LICENSE  CLAUDE.md  CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md
├── package.json       # workspace root: build/test/lint/eval/release scripts
├── pnpm-workspace.yaml  pnpm-lock.yaml  .npmrc
├── tsconfig.base.json # shared compiler options; each package extends it
├── .eslintrc.cjs      # lint config
└── .mcp.json          # local dev MCP wiring (points at packages/cli/bin/sfi.js)
```

## The 11 packages (`packages/`)

Each is `@sf-intelligence/<name>`, compiles `src/ → dist/`, and co-locates unit
tests under `test/`. They form a clean dependency DAG, leaf → root:

```
contracts          shared types — no deps
  └─ core          Result/err primitives
       ├─ parsers       raw source → tokens
       ├─ graph         DuckDB store + queries + typo-tolerant resolver
       ├─ renderers     nodes/edges → Markdown
       ├─ vault         vault filesystem + manifest + registry
       ├─ tooling-api   optional Salesforce Tooling-API enrichment
       ├─ patterns      heuristic recognizers            → also graph
       ├─ extractors    metadata source → nodes/edges     → also parsers, patterns
       ├─ mcp           MCP server + the sfi.* tools       → also graph, parsers, patterns, vault
       └─ cli           the `sfi` command + the bundle     → depends on everything
```

| Package | Role |
| --- | --- |
| **contracts** | The shared type vocabulary — `ComponentType`/`EdgeType` unions, `Node`, `Edge`, `ExtractionResult`, `VaultManifest`, `McpResponse`, `ConfidenceLevel`. No runtime deps. |
| **core** | Functional primitives — `Result<T,E>` + `ok`/`err`, used everywhere instead of throwing. |
| **parsers** | Low-level source parsing (no graph): `apex-scanner`, `formula-tokenizer`, `frontend-scanner`. |
| **patterns** | Heuristic recognizers over the graph: `naming-convention`, `code-quality-patterns`, `pii-detection`. |
| **extractors** | Turn retrieved metadata into `ExtractionResult` (nodes + edges). One file per metadata family (Apex, Flow, Profile, Layout, OmniStudio, CPQ, …). The largest package. |
| **graph** | The DuckDB graph store and everything that queries it. `store`, `schema`, `migrations`, `import`, `queries`, `resolve` (the resolver), `tokenize`, `fleet`. |
| **renderers** | Turn nodes/edges into the Markdown vault: `component-markdown`, `apex-markdown`, `flow-markdown`, `vault-index`. |
| **vault** | Vault filesystem + metadata: `layout` (paths), `manifest`, `hash` (source-tree hash), `freshness`, `registry`, `snapshot`. |
| **tooling-api** | Optional Salesforce Tooling-API enrichment (`lastModifiedBy`/`lastModifiedDate`), run only at refresh time behind a flag. |
| **mcp** | The MCP server and the `sfi.*` tool surface: `server` (the `Context` shape + `startServer`), `tools/`, `clarify`, `audit`, `resources`. |
| **cli** | The `sfi` command (`init`/`refresh`/`status`/`doctor`/`mcp`), the refresh pipeline, and `build.mjs` (the esbuild bundle that produces the published package). Top of the stack. |

### The tools — `packages/mcp/src/tools/`

- **One `*.ts` handler file per `sfi.*` tool**; the live roster is the
  `V01_TOOLS` registry in `index.ts`.
- **`index.ts`** is the dispatcher: the `V01_TOOLS` registry (name + description
  + JSON input schema), the `dispatchTool` switch, and `registerTools`.
- Each handler has a co-located `test/tools/<tool>.test.ts`.

## The plugin layer (`.claude/` + `.claude-plugin/`)

```
.claude-plugin/
├── plugin.json        # manifest: paths to skills + commands, and the MCP server command
└── marketplace.json   # Claude Code marketplace entry
.claude/
├── skills/            # 25 skill folders, each <name>/SKILL.md (auto-activate by trigger)
│   └── using-sf-intelligence/  ← the entry skill: teaches the resolve-first tool cascade
└── commands/          # 4 slash commands: sfi-onboard, sfi-init, sfi-refresh, sfi-status
```

The slash commands wrap the `sfi` CLI; the skills are the agent's instructions
for using the `sfi.*` tools honestly.

## The vault (`org-kb/`)

The per-org knowledge base, **generated by `sfi refresh`** (gitignored — every
user builds their own; it holds org-specific metadata).

```
org-kb/
├── source/       # raw `sf project retrieve` output (cold storage)
├── components/   # the Markdown vault — one file per component, foldered by ComponentType
├── graph/        # graph.duckdb — the DuckDB graph of nodes + edges
└── meta/         # manifest.json (counts, refresh time, source-tree hash), config.json
```

The MCP server reads `components/`, `graph/`, and `meta/` — never the live org.

## Build & test (from root `package.json`)

| Command | What it does |
| --- | --- |
| `pnpm -r build` | Build every package `src/ → dist/` in dependency order. The `cli` build also runs `build.mjs` to bundle the published `dist/index.js`. |
| `pnpm -r test` | Each package's vitest unit suite. |
| `pnpm test` | `pnpm -r test` then the `tests/integration` suite (needs maintainer fixtures). |
| `pnpm lint` | eslint over all `.ts`. |
| `pnpm eval` / `pnpm eval:analytical` | Retrieval / analytical golden-case evals. |
| `pnpm e2e` | Real-server MCP stdio smoke (`packages/mcp/e2e-smoke.mjs`). |
| `pnpm guard` | Privacy scan of the shipping set (`scripts/release-guard.mjs`). |
| `pnpm release` | `pnpm -r build && pnpm -r publish` — publishes only `sf-intelligence`. |

### CI — `.github/workflows/ci.yml`

On push to `main` / PR: install → `pnpm -r build` → lint → unit tests → NL
routing gate → privacy guard → e2e smoke → build CI vault → retrieval +
analytical evals → scale gates. The `tests/integration` suite is **not** in CI
(it needs the maintainer's real-org fixtures); run it locally with `pnpm test`.

## How a question becomes an answer (runtime)

```
sfi mcp
  └─ buildContext(vaultRoot)   # load org-kb/meta/manifest.json + open graph.duckdb -> Context
       └─ startServer          # registerTools(server, ctx); stdio transport; block until disconnect

user question (in an MCP client)
  └─ skill `using-sf-intelligence` teaches the cascade:
       1. sfi.health_check   # vault fresh? if stale/missing -> tell user to run /sfi-refresh
       2. sfi.resolve        # RESOLVE-FIRST: messy/typo name -> ranked candidates + disposition
            • exact -> use its canonical id   • ambiguous -> ask   • none -> offer refresh / stop
       3. the specialist sfi.* tool for the intent
  └─ dispatchTool(ctx, name, args)
       └─ Zod-validate -> handler (packages/mcp/src/tools/<tool>.ts)
            └─ reads the graph (DuckDB) and/or the Markdown vault — never the live org
                 └─ returns a structured McpResponse { data, vaultState, disclosure }
```

**Skills are the instructions, MCP tools are the capabilities, the vault is the
data.** Nothing calls the live org during a conversation (the opt-in `live_*`
plane is the sole, explicitly-enabled exception).
