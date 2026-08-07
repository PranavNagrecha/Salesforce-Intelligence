# SfIntelligence architecture

This document explains how SfIntelligence works under the hood. The audience
is the Salesforce admin or architect who installed the plugin and wants to
know what's actually happening on disk, what each piece is responsible for,
and where the boundaries are. It is not a developer-contributor doc; if you
want to read the TypeScript, start at [`REPO-STRUCTURE.md`](../REPO-STRUCTURE.md)
and [`CONTRIBUTING.md`](../CONTRIBUTING.md).

The README in the repo root covers what SfIntelligence is at a summary level.
This doc fills in the technical depth.

## 1. What it is

SfIntelligence is an **offline-first**, MCP-first knowledge base for **one**
Salesforce org. After a refresh that calls `sf project retrieve`, most
questions are served from a local Markdown vault plus a DuckDB graph store on
your disk. **By default** no live Salesforce API calls happen during a
conversation — vault tools are fully offline. An **opt-in live read-only
plane** (`sfi.live_*`) can answer capped record counts, samples, field
population, inactive users, and org limits when you explicitly enable it (see
[`docs/configuration.md`](./configuration.md)). The vault is checked in to
git alongside your DX source so the team shares the same picture of the org.
It has **no org write path** by design — it never deploys, edits metadata, or
writes a byte back to Salesforce. It can emit deploy-ready *proposal artifacts*
(a `package.xml` / `destructiveChanges.xml` plus an evidence trail) as **local
files on your machine** for you to review and feed to your own deploy tool; sfi
itself never deploys them.

The MCP server exposes the full `sfi.*` roster (see `sfi.capabilities` for the
live tool count) over a typed component graph. Coverage spans
schema (objects, fields, validation rules), automation (Flows, Apex classes
and triggers with call-graph and reachability analysis, legacy workflow /
approval / assignment / escalation rules), the UI surface (layouts, record
types, LWC / Aura / Visualforce), permissions and the full sharing tier
(profiles, permission sets, roles, groups, queues, sharing rules), the
integration tier (named credentials, external services and data sources,
outbound messages, auth providers), CPQ, and OmniStudio. Documentation
generators and what-if simulations sit on top of that graph.

### Two graphs: the org vault and the Concept Model

There is a second, much smaller graph that never touches your org. The
**Concept Model** is a curated, org-independent set of **142** reasoning
concepts and **193** rules encoding general Salesforce truth — save-order
phases, relationship semantics, sharing posture, code-shape signals. It holds
**no org data**: no canonical ids, no counts, nothing org-specific. The org
enters reasoning *only* through the grounded slice passed to the engine at query
time.

`sfi.interpret` joins the two at query time — the grounded org slice (Graph A)
against the org-independent Concept Model (Graph B — 142 concepts / 193 rules;
pinned by `eval/product-manifest.json`):

```
   Graph A · org vault slice          Graph B · Concept Model
   (grounded, org-specific)           (org-independent, in the package)
     CustomObject:Account               142 concepts / 193 rules
     Flow:Account_Set_Defaults          save-order · relationships ·
     Flow:Account_Enrich_Billing        sharing · code-shape
     CustomField:Invoice__c.Total__c    NO org data (no ids, no counts)
              │                                    │
              └──────────────┬─────────────────────┘
                             ▼
                       sfi.interpret
              deterministic, offline JOIN — no LLM, no live org read
                             │
                             ▼
         cited, confidence-tiered structural-implication claims
         groundedIn = [exact matched ids]      (no citation ⇒ no claim)
         claim confidence = weakest(rule ceiling, grounding edges)
```

Given one component, the tool assembles a minimal slice of the org vault graph
around it (Graph A), fires the applicable concept rules (Graph B), and returns
**cited, confidence-tiered structural-implication claims** — "this master-detail
parent cascade-deletes its children", "two active before-save flows on this
object run in an undefined order", "this `@AuraEnabled` class is an entry point
where Apex does not auto-enforce FLS/CRUD". It runs offline with **no LLM and no
live org read**.

Two honesty invariants ride on every claim, plus a **second confidence axis**:

- **No citation, no claim.** Each claim carries a `groundedIn` list of the exact
  ids it matched; a claim the engine cannot ground is never emitted. An empty
  interpretation list means "no concept rule fired for this component," never
  "nothing depends on it."
- **Static shape, not proof.** Governor and security concepts name a code or
  metadata *shape* (a cascade, an undefined order, an unenforced surface), not a
  proven runtime limit breach or vulnerability.
- **Claim confidence is a second axis, distinct from edge confidence.** It
  reuses the `declared | parsed | heuristic` words but is *computed* — the
  weakest of the concept rule's ceiling and the grounding edges the claim matched
  (`unknown` for an absence-shaped claim under non-complete coverage) — so it can
  never exceed the weakest grounding edge (see §6).

This is retrieval's complement: retrieval reports what exists; the join reports
what the shape *implies*. See [ADR-008](./decisions/ADR-008-deterministic-concept-model-reasoning.md).

## 2. What it does NOT do

Be honest about the boundary. SfIntelligence is a read tool with clear,
deliberate gaps. The product names the boundary plainly rather than papering
over it with general Salesforce knowledge when it hits one of these.

| Capability                                           | Status                                                |
| ---------------------------------------------------- | ----------------------------------------------------- |
| Arbitrary live SOQL / Metadata API / Tooling API     | **Not supported.** Only curated `sfi.live_*` tools; offline remains default. |
| Record-level questions ("how many Accounts closed…") | **Offline:** not in the vault. **Live (opt-in):** `sfi.live_count`, `sfi.live_sample`, `sfi.live_field_population` with hard caps and `provenance: live_org`. |
| Runtime behaviour (dynamic SOQL, reflective Apex)    | Invisible to static analysis — "no references" means "no static evidence". |
| Write side to the ORG (deploy, edit metadata)        | **No org write path.** Emits LOCAL deploy-ready proposals only (`package.xml` / `destructiveChanges.xml` + evidence) — never deploys. |
| Multi-org consolidation                              | One org per vault (cross-vault compare needs a registry). |
| Hosted SaaS layer                                    | Local-only by design.                                  |

The honest framing matters most for code and Flow analysis. Dependency edges
are derived from metadata and source by static analysis. Dynamic SOQL,
reflective field access, and runtime metadata lookups leave no static trace, so
a "no references found" result means "no static evidence", not "definitely
unused". Every relationship the graph reports carries a confidence —
`declared`, `parsed`, or `heuristic` — so a caller can tell ground truth from
an inferred reference (see §6).

## 3. The data flow

End to end, here is what happens when you run `/sfi-refresh`:

```
                  (sf CLI; network call to Salesforce)
                              │
                              ▼
  ┌────────────────────────────────────────────────────────────┐
  │  1. sf project retrieve  ──►  org-kb/source/                │
  │     (DX-shaped XML, Apex, Flow XML — raw retrieval output)  │
  └────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌────────────────────────────────────────────────────────────┐
  │  2. Extractors            ──►  Nodes + Edges (in memory)    │
  │     One per metadata type. Pure functions; no I/O beyond    │
  │     reading the file the extractor was handed.              │
  └────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌────────────────────────────────────────────────────────────┐
  │  3. Graph importer        ──►  org-kb/graph/graph.duckdb    │
  │     Inserts into the DuckDB `nodes` and `edges` tables.     │
  └────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌────────────────────────────────────────────────────────────┐
  │  4. Renderers             ──►  org-kb/components/*.md       │
  │     One Markdown file per node. Deterministic byte-output.  │
  └────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌────────────────────────────────────────────────────────────┐
  │  5. Pattern recognizers   ──►  observations into manifest   │
  │     Naming-convention and other heuristic observations.     │
  └────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌────────────────────────────────────────────────────────────┐
  │  6. Manifest writer       ──►  org-kb/meta/manifest.json    │
  │     Refresh timestamp, source-tree hash, component counts,  │
  │     pattern observations, version stamp.                    │
  └────────────────────────────────────────────────────────────┘

                  (later, in a Claude conversation)
                              │
                              ▼
  ┌────────────────────────────────────────────────────────────┐
  │  7. MCP server            ◄──  Claude / Cursor / ChatGPT    │
  │     Reads the vault and the graph; answers tool calls.      │
  │     Stdio JSON-RPC. Never writes. Offline by default;       │
  │     opt-in `sfi.live_*` calls Salesforce read-only when     │
  │     explicitly enabled (see configuration.md).              │
  └────────────────────────────────────────────────────────────┘
```

Step 1 is the only **refresh-pipeline** step that touches the network.
Everything after step 1 is pure local computation; you can disconnect from
the internet between refreshes and offline vault tools still work. The MCP
server (step 7) is what Claude actually talks to when you ask an org
question; it never re-runs steps 1–6 on its own. When the live plane is
enabled, selected `sfi.live_*` tools make read-only Salesforce CLI calls at
answer time — they do not update the vault and never run unless you opt in.

## 4. The vault layout

Once `/sfi-init` and `/sfi-refresh` have run, your per-org repo looks like
this:

```
{your-org-repo}/
├── force-app/                  # your existing DX source (untouched)
├── org-kb/
│   ├── source/                 # raw sf project retrieve output
│   │   └── main/default/...    # gitignored
│   ├── components/             # the Markdown vault
│   │   ├── CustomObject/
│   │   ├── CustomField/{parent}/
│   │   ├── ValidationRule/
│   │   ├── Flow/
│   │   ├── ApexClass/
│   │   ├── ApexTrigger/
│   │   ├── Layout/
│   │   ├── PermissionSet/
│   │   ├── Profile/
│   │   ├── ...                 # one directory per component type
│   │   └── index.md
│   ├── graph/
│   │   └── graph.duckdb        # DuckDB single-file (gitignored)
│   └── meta/
│       ├── manifest.json       # refresh state (committed)
│       ├── config.json         # target-org alias (committed)
│       └── version.txt         # sf-intelligence version (committed)
└── .gitignore                  # `/sfi-init` adds the right entries
```

Commit policy, enforced by the `.gitignore` that `/sfi-init` writes:

| Path                  | In git?    | Why                                       |
| --------------------- | ---------- | ----------------------------------------- |
| `org-kb/components/`  | committed  | Hand-readable vault; the team's shared view of the org. |
| `org-kb/meta/*.json`  | committed  | Tracks freshness so reviewers see staleness in PRs. |
| `org-kb/meta/version.txt` | committed | Used by upgrade checks (see §8).        |
| `org-kb/source/`      | gitignored | Large; regenerable by re-running refresh. |
| `org-kb/graph/graph.duckdb` | gitignored | Build artifact; regenerable from `source/` + extractors. |

The graph itself is a single DuckDB file with four tables and an index pack
(see `ProductManifest.graph.tables` / `eval/product-manifest.json`):

- `nodes(id, type, api_name, label, parent_id, source_path, last_modified_date, last_modified_by, api_version, properties_json)`
- `edges(from_id, to_id, edge_type, confidence, source, properties_json)` with `PRIMARY KEY (from_id, to_id, edge_type, source)`
- `facts(subject_id, metric, value_json, captured_at, method, source)` — record-DATA observations outside the metadata graph (refresh imports never touch it)
- `schema_version(id, version)` — integer schema ledger for migrations
- Indexes on `nodes(type)`, `nodes(parent_id)`, `edges(to_id)`, `edges(from_id)`.

DuckDB is embedded; there is no separate database server to run.

## 5. The MCP tool surface

The MCP server exposes the full `sfi.*` roster (`sfi.capabilities` reports the
live count). Every tool is read-only — nothing writes to your org. **Vault
tools** never call Salesforce. **Live tools** (`sfi.live_*`) call the org
read-only when explicitly enabled; they are a separate plane with
`provenance: live_org`. Tools range from low-level graph primitives to
composite analyses (impact, reachability, sharing cascades, what-if
simulations, documentation generators); the table below is the offline
foundation the rest build on.

### The front door

Three tools form the conversational entry point so you don't need to know any
API name up front:

- `sfi.capabilities` — a no-arg self-description. "What can I ask?" returns the
  live map of capability areas, no parameters required.
- `sfi.resolve` — a **typo-tolerant resolver**. It turns messy or misspelled
  phrasing into ranked candidates with a disposition: `exact` (one confident
  match), `ambiguous` (several plausible matches, returned with a ready-to-ask
  clarifying question), or `none` (nothing matched — offers `/sfi-refresh` or
  stop). It **never silently commits to a guess**; resolution is always
  `heuristic` confidence, and a high match score is string similarity, not
  proof.
- `sfi.search_components` — free-text search that **self-heals through the
  resolver** on a zero-result query, so a near-miss search still surfaces the
  likely candidates rather than an empty list.

### The foundation tools

| Tool                                 | Input                                                | Output                                                  | Purpose                                                                 |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `sfi.search_components`              | query text, optional type filter, limit              | ranked list of canonical component IDs with snippets    | Free-text search across the vault (resolver-backed on zero results).    |
| `sfi.get_component`                  | canonical component ID                               | the full Markdown body of one component file           | Fetch a vault file by ID.                                               |
| `sfi.list_components`                | type filter, parent filter, pagination cursor        | paginated list of IDs of that type                      | Enumerate components by type (e.g., all CustomFields on Account).       |
| `sfi.get_edges`                      | node ID, optional edge-type filter, direction        | list of edges incident to that node, with confidence    | Walk relationships out of or into one component.                        |
| `sfi.get_subgraph`                   | starting node ID, hop count, optional type filter    | the N-hop neighborhood as a node-and-edge bundle        | Pull a small graph around a starting point for richer answers.          |
| `sfi.search_apex_source`             | regex or literal query                               | matched files and line snippets                         | Grep across raw Apex class and trigger source under `org-kb/source/`.   |
| `sfi.search_flow_metadata`           | regex or literal query                               | matched Flow XML files with line snippets               | Grep across raw Flow XML under `org-kb/source/`.                        |
| `sfi.get_manifest`                   | (none)                                               | the contents of `org-kb/meta/manifest.json`             | Inspect refresh time, hashes, component counts, version.                |
| `sfi.health_check`                   | (none)                                               | `{ok|stale|missing}` plus reason                        | Diagnostic. Tells the caller whether the vault is usable right now.     |
| `sfi.interpret`                      | canonical component ID, optional `concepts` / `ruleIds` filters | cited structural-implication claims (`interpretations[]` with `groundedIn` + claim confidence) + `trust` block | Join the Concept Model against the component's vault slice — deterministic, offline reasoning (no LLM, no live read). |

`sfi.interpret` is the reasoning tool: it fires the curated Concept Model
(142 concepts / 193 rules — see §1) against a minimal graph slice assembled around
the target component. Each returned claim cites the exact ids it matched, and an
empty list means "no rule fired," not "nothing depends on it." Its per-claim
confidence is a *distinct* axis from per-edge confidence and can never exceed the
weakest grounding edge (§6).

Every **offline** tool returns deterministic results for a given vault state.
If you call `sfi.search_components` twice in a row without refreshing in
between, you get the same ranked list both times. If you call it after a
refresh, results change only to the extent that the underlying metadata
changed. **Live** tools are deterministic in shape but reflect org state at
query time.

### Opt-in live read-only plane

Live tools are **off by default**. Enable once per org via `sfi.live_consent
{ grant: true }`, or set `SFI_LIVE_PLANE_ENABLED=1`. Per-call
`liveEnabled: true` is intent only — hybrid tools read it as "enrich if a
grant exists", and it never opens the live plane on its own. See
[`docs/configuration.md`](./configuration.md) for the full matrix.

| Tool | Purpose |
| --- | --- |
| `sfi.live_count` | `SELECT COUNT()` for one object (read-only) |
| `sfi.live_sample` | Sample rows (hard cap 200) |
| `sfi.live_field_population` | Null vs populated on one field |
| `sfi.live_describe` | Live object describe |
| `sfi.live_org_limits` | Governor limit snapshot |
| `sfi.live_inactive_users` | Users inactive for N days |
| `sfi.live_permset_holders` | Who holds a permission set / PSG / profile (PSG-trap-aware roster) |
| `sfi.live_user_permsets` | What a named user holds (direct vs via-PSG, expirations) |
| `sfi.live_group_members` | Current queue / public-group membership + vault-drift check |
| `sfi.live_zombie_accounts` | Active users with zero permission-set/PSG assignments |
| `sfi.live_drift_check` | Offline vault vs live contradiction check |

Hybrid answers fuse vault + live and disclose both provenances. Live never
backfills stale vault claims. Runtime assignment data (User /
PermissionSetAssignment / GroupMember) is live-first **by design** — it is
never modeled in the vault, and `sfi.coverage_report` reports that boundary as
an `assignmentData` section, not a retrieve gap.

## 6. Component and edge coverage

The graph models a broad set of component types connected by typed edges. The
canonical types — the source-of-truth list — live in
`packages/contracts/src/index.ts` as the `ComponentType` and `EdgeType`
unions. A sample of the foundational edges:

| Edge type      | Source                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| `parentOf`     | `CustomObject` → `CustomField` / `ValidationRule`.                      |
| `usedInLayout` | `Layout` → `CustomField`.                                               |
| `grantedBy`    | `PermissionSet` / `Profile` → field / object / Apex class.             |
| `triggersOn`   | `ApexTrigger` / `Flow` → `CustomObject` (the event source).             |
| `references`   | generic declared dependency between two components.                     |
| `callsApex`    | `Flow` → the `ApexClass` it invokes.                                    |
| `readsFrom` / `writesTo` | Apex or Flow reads / writes a field.                          |

Every edge carries a **confidence** so a caller can tell ground truth from an
inferred reference:

- **`declared`** — read directly from a metadata file (e.g. a `parentOf` edge
  from the object XML).
- **`parsed`** — derived by inspecting source (e.g. a formula expression
  resolved by the formula tokenizer, or an Apex call site).
- **`heuristic`** — a pattern-recognition best guess (e.g. a resolver match, or
  a dispatch shape the scanner inferred). Treat as a strong suggestion, not a
  rule.

The honesty boundary from §2 applies here: edges come from static analysis of
metadata and source. Dynamic SOQL, reflective field access, and runtime
metadata lookups are invisible, so an empty edge set means "no static
evidence", not "definitely unused".

### Edge confidence vs claim confidence

The `declared | parsed | heuristic` tier above is **edge confidence** — it grades
a single *relationship*. `sfi.interpret` (§1, §5) adds a second, separate axis:
**claim confidence**, grading a *reasoning claim* that rests on one or more edges.
It reuses the same three words, but it is **computed, not read off one edge**: a
claim's confidence is the *weakest* of the concept rule's own ceiling and every
grounding edge the claim matched, so **claim confidence can never exceed edge
confidence**. A claim grounded on a `heuristic` edge is at best `heuristic`, even
if the rule would otherwise allow more; an absence-shaped claim under
non-complete coverage reads `unknown`. Do not conflate the two axes when
rendering a claim.

## 7. Determinism guarantees

The pipeline is engineered so that the same DX source produces the same
vault, byte for byte. Concretely:

- **Same DX source → same vault.** A goldens test in the repo verifies that
  extractors plus renderers produce byte-identical files across runs. The
  Markdown layout is committed to git, so this guarantee is what makes vault
  changes diffable in code review.
- **No timestamps in component bodies.** The only timestamp in the vault
  lives in `org-kb/meta/manifest.json`. The components themselves do not
  embed "as of" dates, so a vault re-render does not produce noisy diffs.
- **Stable sort orders.** Tools that return lists (`sfi.list_components`,
  `sfi.search_components`, `sfi.get_edges`) sort results deterministically.
  Two calls with the same arguments against the same vault state return the
  same response in the same order.
- **No source of nondeterminism in the pipeline.** No `Date.now()` in
  vault-content code paths (only in manifest writing). No random IDs. No
  hash-iteration ordering. No platform-dependent path separators in
  output.

The practical consequence: a `git diff` on `org-kb/components/` after a
refresh shows exactly what changed in the org since the last refresh, and
nothing else. Reviewers can read the diff as a metadata changelog.

## 8. Versioning and upgrades

SfIntelligence follows a simple forward-compat rule for vaults:

- **An older vault is readable by newer tools.** The manifest carries a
  `version` field. Newer tools that find an older vault detect the version
  and behave as follows:
  - Components and edges from the older vault are preserved. A newer version
    does not rewrite committed Markdown without a refresh.
  - New edges, new metadata types, and new pattern observations only show
    up after the user runs `/sfi-refresh` under the newer version.
- **A newer vault is NOT guaranteed readable by an older tool.** Pinning the
  team to a single `sf-intelligence` version per repo is the simplest way to
  avoid that. The `org-kb/meta/version.txt` file records the version that
  last refreshed the vault, so reviewers see version drift in PRs.
- **What's in the manifest:**
  - `version` — the SfIntelligence version that wrote the vault.
  - `refreshedAt` — ISO-8601 timestamp of the last successful refresh.
  - `sourceTreeHash` — content hash of `org-kb/source/`. Mismatches with
    the on-disk source mean the vault and the source have drifted.
  - `componentCounts` — per-type counts.
  - `patternObservations` — naming-convention findings with confidence.
  - `errors` — any per-component extraction errors logged during refresh
    (so they show up in `/sfi-status` rather than getting swallowed).

When you upgrade SfIntelligence to a newer version:

1. Update the plugin via your install path (`/plugin install` or git pull).
2. Run `/sfi-refresh`. The new extractors and renderers populate the vault
   with their richer output.
3. Review the diff. New edges and types appear as additions on existing
   components, not as replacements. The manifest version will increment.

Refresh is the upgrade boundary. Without a refresh, an upgraded tool
continues to work against the older vault — just with whatever edge types
and metadata types that older vault was built with.

## Where to go next

- README in the repo root for install paths and a capability summary.
- [`docs/README.md`](./README.md) — documentation index.
- [`docs/configuration.md`](./configuration.md) — environment variables, live plane, audit log.
- `docs/guides/installation.md` for the step-by-step install walk-through.
- `docs/guides/first-refresh.md` for the first-refresh walk-through.
- `docs/guides/asking-questions.md` for the question set and boundaries.
