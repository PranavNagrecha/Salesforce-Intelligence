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
(`declared`, `parsed`, `heuristic`). Do not answer org questions
without it.

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
can answer capped record counts and samples when explicitly enabled — see
`docs/configuration.md`. It does NOT:

- Call Salesforce unless the live plane is enabled (`sfi.live_consent`,
  `SFI_LIVE_PLANE_ENABLED=1`, or `liveEnabled: true`). Vault tools never
  call the org. (Optional Tooling-API enrichment runs only at refresh time,
  behind a flag.)
- Run arbitrary live SOQL — only the curated `sfi.live_*` roster.
- Read business record data from the vault ("how many Accounts…"). Live
  tools can return capped runtime counts/samples when enabled. It DOES
  surface configured Custom Metadata Type and Custom Setting *records* via
  `sfi.lookup_record` from the vault.
- Analyze Apex with a real AST/compiler. Apex is read by a heuristic
  regex/token scanner, so those edges are `confidence: heuristic` and
  cross-method dataflow, dynamic SOQL, and reflective field access are
  invisible. Always cite the confidence tier.

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
