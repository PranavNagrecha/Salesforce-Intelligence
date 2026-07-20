# SfIntelligence is installed in this repository

This repo has the SfIntelligence plugin active. SfIntelligence is an
**offline, MCP-first knowledge base** for one Salesforce org. Use it
whenever the conversation touches Salesforce metadata — schema,
dependencies, permissions, naming conventions, Apex, Flows, integration
topology, OmniStudio, code quality, or generated org documentation.

## First step in any Salesforce conversation

Load `.claude/skills/using-sf-intelligence/SKILL.md`. It is the entry
skill. It teaches the cascade of `sfi.*` MCP tools, the canonical
component-ID format, and the rules for citing edge confidence
(`declared`, `parsed`, `heuristic`) — the per-edge tier on a relationship.
A reasoning **claim** from `sfi.interpret` carries a *separate* claim
confidence (the weakest of the concept rule's ceiling and its grounding
edges); keep the two axes distinct (see Capability boundary). Do not
answer org questions without it.

## Where the metadata lives

- `org-kb/components/` — Markdown vault, one file per component.
- `org-kb/source/` — raw `sf project retrieve` output (cold storage).
- `org-kb/graph/graph.duckdb` — DuckDB graph of components and edges.
- `org-kb/meta/manifest.json` — refresh timestamp, source-tree hash,
  component counts.

The MCP server reads these. **Do not speculate about the org's contents.**
Every org artifact you name must be backed by a call to an `sfi.*` tool
and cited with its canonical ID (`CustomObject:Account`,
`CustomField:Account.Industry__c`, etc.).

## Capability boundary

SfIntelligence is **read-only and offline-first**. Vault answers come from
the last refresh's vault. An **opt-in live read-only plane** (`sfi.live_*`)
can answer capped record counts and samples when explicitly enabled — plus
**assignment-data questions the vault cannot answer offline**: who holds a
permission set / group / profile (`sfi.live_permset_holders`), who is in a
queue or public group (`sfi.live_group_members`), everything a user holds
(`sfi.live_user_permsets`), and active users with login access but no
non-profile permission sets (`sfi.live_zombie_accounts`). All are read-only,
consent- and budget-gated SOQL — see `docs/configuration.md`. It does NOT:

- Call Salesforce unless the live plane is enabled (`sfi.live_consent`,
  `SFI_LIVE_PLANE_ENABLED=1`, or `liveEnabled: true`) **and** the invoked
  tool is registry-tagged `livePlane: 'opt-in' | 'primary'` (INFRA-12-DEEP —
  `dispatchTool` mints a `LiveCapability` onto Context; `never` tools cannot
  read ambient standing consent even when consent is on file). Vault tools
  never call the org. (Optional Tooling-API enrichment runs only at refresh
  time, behind a flag.)
- Run arbitrary live SOQL — only the curated `sfi.live_*` roster (plus a
  small audited opt-in set such as hybrid field-cleanup tools).
- Read business record data from the vault ("how many Accounts…"). Live
  tools can return capped runtime counts/samples when enabled. It DOES
  surface configured Custom Metadata Type and Custom Setting *records* via
  `sfi.lookup_record` from the vault.
- Analyze Apex with real AST parsing (default) + heuristic recall. Apex
  extraction runs the parser-grade ANTLR pass by default (`confidence:
  parsed` edges: resolved field reads/writes, cross-class calls, field-level
  SOQL). Per-file parse failures and recall gaps are backfilled by the regex
  scanner (`confidence: heuristic`). Cross-method dataflow, dynamic SOQL /
  SOSL strings, and reflective field access remain invisible. Always cite
  the per-edge confidence tier.

It DOES cover a broad surface well beyond the original v0.1 nine types:
schema (objects, fields, record types, value sets, lookup / master-detail
relationships as `lookupTo` edges), validation rules,
Flows, Apex, layouts, permission sets & profiles, sharing, legacy
automation (workflow / approval / assignment / escalation / duplicate
rules, email), frontend (LWC / Aura / Visualforce), the integration
surface (named credentials, external data sources & services, auth
providers), and OmniStudio (OmniScripts, Integration Procedures,
DataRaptors, FlexCards, Decision Tables) — plus composed analyses:
impact / what-if change analysis, heuristic code-quality recognizers,
documentation generators, and cross-org / sandbox-vs-prod comparison.

### Reasoning about structural implications (`sfi.interpret`)

For "what does this **imply**" questions — does deleting this parent
cascade-delete children, do these two flows run in a defined order, is
this class an unenforced entry point — go one step past retrieval:
**resolve → interpret → synthesize**. `sfi.resolve` fixes the component;
`sfi.interpret` joins the org's grounded vault slice against a curated,
org-independent **Concept Model** (94 concepts / 143 rules of general
Salesforce truth) and returns **cited, confidence-tiered structural
claims**; `sfi.synthesize_answer` folds those claims into the answer,
hedged and attributed. It is **deterministic and offline** — no LLM, no
live org read.

Honesty is load-bearing here:

- **No citation, no claim.** Each interpretation carries a `groundedIn`
  list of the exact component ids it matched; a claim the engine cannot
  ground is never emitted.
- **Claim confidence is a second axis.** It reuses the
  `declared | parsed | heuristic` words but is **computed, not read off a
  single edge**: the weakest of the concept rule's ceiling and the
  grounding edges the claim matched (`unknown` for an absence-shaped claim
  under non-complete coverage). Never present claim confidence as if it
  were the edge confidence of one relationship.
- **Empty is not "none".** An empty interpretation list means "no concept
  rule fired for this component" — never "nothing depends on it."
- **Static shape, not proof.** Governor and security concepts name a code
  or metadata *shape* (a cascade, an undefined order, an unenforced
  surface), not a proven runtime limit breach or vulnerability. Say so.

### Scope honesty on natural selectors

Many tools accept a **natural selector** (a bare API name, a `Type:Name`
id, or one of several field-name aliases like `profile` / `profileApiName`)
instead of forcing a canonical id. When a tool resolves such a selector it
echoes what it actually scoped to as `appliedScope`, so the answer is
never silently about the wrong thing. When the selectors disagree, or none
resolves, the tool **refuses with a named `invalid-query`** rather than
falling back to a silent org-wide answer. Surface the refusal; do not
invent a scope the caller did not ask for.

When a question hits a genuine boundary (live data, business record
values, Apex semantics, or a metadata type the refresh didn't retrieve),
say so plainly and name it. Do not paper over the gap with general
Salesforce knowledge from training data.

The product self-reports these boundaries — cite them. `sfi.coverage_report`
lists which metadata families the last refresh actually retrieved and
modeled; a type under `notModeled` means "not checked", never "none".
Analysis tools carry a `trust` block (`provenance`, `confidence`,
`completeness`), and destructive verdicts (`sfi.safe_to_delete_field` and
the `sfi.what_if_*` family) add a `coverageCaveat` when the families they
depend on are not fully covered. An absence-based answer ("no flows
reference this field") is only as strong as the coverage behind it, so
surface the caveat rather than implying certainty.

## Refreshing the vault

`sfi.health_check` reports `status: healthy | degraded | unhealthy` (plus
an `issues` list and a `checks` map). If the status is **not** `healthy`,
stop and surface its `issues` to the user:

- `unhealthy` — the graph could not be read; the vault is unusable until
  rebuilt. Tell the user to run `/sfi-refresh` (or `/sfi-init` if there is
  no `org-kb/` directory at all).
- `degraded` — the vault answers, but with caveats: missing or partial
  coverage, or metadata types the refresh skipped. Relay the `issues` and
  suggest `/sfi-refresh` (or `sfi refresh --no-pull` to recompute coverage
  from the existing source without re-pulling the org).

Also watch `checks.sourceHashMatches`: when `false`, the local source
changed since the vault was built, so a rebuild is due. The org itself may
have changed since the last retrieve as well — stale answers presented as
current are worse than no answer, so re-refresh when freshness matters.

## The three slash commands

- `/sfi-init` — set up `org-kb/` and pick a target-org alias. First-time
  setup only.
- `/sfi-refresh` — re-run `sf project retrieve` against the alias and
  rebuild the vault. Use when the org has changed.
- `/sfi-status` — print vault freshness, source-tree hash, and component
  counts. Use to confirm the vault is current.

## When to read other SfIntelligence skills

The other SfIntelligence skills auto-activate from their `description`
triggers when the conversation touches their domain — refresh, question
intent, naming conventions, vault errors, background context, and the
specialist admin / architect / developer / business-user / OmniStudio
tiers. You don't need to invoke them; you only need to know they fire.
