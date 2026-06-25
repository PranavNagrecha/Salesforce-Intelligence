# Positioning

This is an honest competitive-positioning doc, not a sales page. It exists so
that a Salesforce architect, admin, or developer can decide in five minutes
whether sf-intelligence is worth installing — and, just as importantly, when
to reach for something else.

The short version: sf-intelligence fuses three product categories that the
market currently sells as three separate, expensive, cloud-hosted products. It
runs them against **one** local, confidence-tagged graph of your org — **offline
by default**, with an **opt-in live read-only plane** for record counts and
samples when you enable it — reachable in plain English from Claude Code, and
free. It does that by giving up things those products have (a hosted UI,
certified accuracy guarantees, always-on cloud sync). Whether that trade is
right for you is the whole question this doc tries to answer fairly.

The tool names below are real — they come from the `V01_TOOLS` roster in
`packages/mcp/src/tools/index.ts`. Run `sfi.capabilities` for the live tool
count and category map. Org examples (`Account`, `Payment__c`, etc.) are generic
placeholders, not anything from a real vault.

---

## The three fused categories

### 1. A living org data dictionary

This is the "what is this thing and what does it mean in *our* org" category.

- `sfi.generate_data_dictionary` — a per-object dictionary (fields, types,
  relationships, validation rules, layouts, related triggers/flows).
- `sfi.explain_field` / `sfi.field_meaning` — the declared shape of a field
  plus an asymmetric read-vs-write usage signal and a heuristic
  source-of-truth classification ("is `Payment__c.Status` manually entered or
  written by automation?").
- `sfi.find_field_anywhere` / `sfi.find_semantic_field` — "where is this field
  used anywhere?" and "do we already have a field for X?".
- `sfi.disambiguate_concepts` — "is `Status` the same as `Stage` here?", which
  refuses to invent a distinction when the org's own metadata doesn't support
  one.
- `sfi.generate_onboarding_doc` / `sfi.org_overview` / `sfi.domain_clusters` —
  the new-to-this-org tour: what the org does, the main data model, suggested
  domain groupings.
- `sfi.get_naming_convention_report` — surfaces the naming patterns the org
  actually follows, with confidence levels.

### 2. A Salesforce code-quality / SAST engine

This is the "find the bugs, the risk, and the sensitive data in our Apex" category. It is not a re-skin of generic linting — it knows Salesforce-specific failure modes.

- `sfi.governor_limit_risks` — SOQL-in-loop, DML-in-loop, and unbounded upsert
  patterns, grouped by class, with the triggering callers surfaced.
- `sfi.crud_fls_audit` — missing CRUD / FLS enforcement (with an honest, loud
  disclosure about its high false-positive rate).
- `sfi.find_hardcoded_values` / `sfi.find_hardcoded_values_anywhere` —
  hardcoded record IDs, emails, usernames, and sandbox test data, across Apex
  *and* formulas / validation rules / workflow rules.
- `sfi.pii_inventory` — classifies every field as PII / sensitive / public by
  inspecting API name, type, and description.
- `sfi.test_coverage_gaps` / `sfi.meaningful_test_audit` — uncovered classes,
  and the harder problem of *fake* coverage (tests that run but never assert).
- `sfi.code_quality_audit` / `sfi.tech_debt_score` — the general entry point
  and a single weighted 0–100 debt score that excludes (never zero-fills)
  categories whose extractor didn't run.
- `sfi.find_dead_code` / `sfi.method_reachability` — entry-point reachability
  analysis to flag likely-dead Apex.

It really does find SOQL injection surfaces, governor-limit risks, and PII.
Every finding is tagged `heuristic` — see the weaknesses section for why that
word matters.

### 3. A change-safety / impact-analysis engine

This is the "what breaks if I change this" category.

- `sfi.get_impact` — BFS over incoming edges: everything that depends on a
  component.
- `sfi.what_if_change_field_type`, `sfi.what_if_remove_picklist_value`,
  `sfi.what_if_make_field_required`, `sfi.what_if_deactivate_flow`,
  `sfi.what_if_disable_trigger`, `sfi.what_if_change_method_signature`,
  `sfi.what_if_merge_profiles`, `sfi.what_if_split_profile` — a family of
  structured "if I do X, here is the blast radius" tools, each returning a
  verdict (`safe` / `review` / `risky` / `blocking`).
- `sfi.safe_to_delete_field` — composes every incoming dependency edge into a
  confidence-weighted deletion verdict.
- `sfi.compare_vaults` / `sfi.compare_object_across_vaults` /
  `sfi.compare_profile_across_vaults` — sandbox-vs-prod (or prod-vs-prod) drift
  detection across two registered vaults.
- `sfi.what_happens_on_save` / `sfi.order_of_execution` — the Salesforce
  order-of-execution instantiated for *your* org and a given DML event.

---

## Competitors, category by category

I'm naming real products. Where I'm unsure of a current fact I flag it
`(verify)` rather than assert it.

### Org docs / data dictionary

- **Elements.cloud** — hosted org documentation, dependency analysis, and
  metadata dictionary, with change-intelligence and process-mapping on top.
  Mature, polished, collaborative, and priced as a per-seat SaaS `(verify)`.
- **Sonar / Strongpoint (now part of Salto)** — automated documentation and
  change management, historically strong in regulated/audit contexts `(verify)`.

Both are cloud-hosted, connect live to your org, and carry a recurring license.
They produce richer human-facing documentation surfaces than sf-intelligence
does today. sf-intelligence's dictionary is generated text composed for an LLM
to narrate, not a hosted, clickable, collaborative web app.

### Code quality / SAST

- **Clayton.io** — continuous Salesforce code-quality and security analysis,
  CI-integrated, with a large managed rule set `(verify)`.
- **CodeScan (AutoRABIT)** — SonarQube-lineage static analysis tuned for
  Salesforce (Apex, Visualforce, Lightning), with a deep rule catalog and
  quality gates `(verify)`.
- **Salesforce Code Analyzer** — the free, first-party CLI bundling PMD,
  ESLint, and other engines. The honest baseline competitor: it's free too.

These are dedicated SAST tools with far larger, more battle-tested rule sets
and (for the commercial ones) tuning, suppression workflows, and certified
quality gates. sf-intelligence's analyzer is a real SAST engine but a younger
one with a smaller rule catalog.

### Impact analysis / change safety

- **Gearset** — the market-leading Salesforce deployment and DevOps platform;
  metadata comparison, dependency analysis, and release management `(verify)`.
- **Copado** — enterprise Salesforce DevOps and release orchestration, with
  impact analysis as part of a larger pipeline `(verify)`.
- **Salesforce Optimizer** — the free first-party report flagging unused
  fields, limits, and stale config `(verify)`.

These tools *act* — they deploy, they orchestrate releases, they sync orgs.
sf-intelligence does none of that. It is read-only by design and answers "what
would happen" without ever touching your org.

---

## The wedge no incumbent has

Every incumbent above is excellent at one of the three categories and silent on
the other two. None of them puts all three on a single graph, and none of them
is reachable in natural language inside your editor.

1. **All three categories on one graph.** "Find every PII field on `Account`
   (dictionary + SAST), then tell me what breaks if I make `Payment__c.Status`
   required (impact)" is one conversation over one data model, not three tools
   and three exports stitched together by hand.
2. **One confidence-tagged graph.** Every node and edge carries a confidence
   level — `declared` (read straight from a metadata file), `parsed` (derived
   from source), or `heuristic` (a best-effort guess). The product never blurs
   "the platform will block this" with "a regex thinks this might be true."
   That honesty is the spine of all three categories at once.
3. **Natural language, in the editor.** It's an MCP server driven from Claude
   Code. You ask in English; skills route to the right `sfi.*` tool and cite a
   canonical component ID for every claim. No web app to context-switch into.
4. **Fully offline and private.** After one `sf project retrieve`, nothing
   leaves the machine. No metadata is uploaded to a vendor cloud. For orgs
   under data-residency or security constraints that forbid third-party SaaS
   touching production metadata, this is often the deciding factor.
5. **Free and source-available (MIT + Commons Clause).** No per-seat license, no usage metering. The whole
   full `sfi.*` roster is in the repo (`sfi.capabilities` reports the live count).

The wedge is not "we're better at SAST than Clayton" or "better at deploys than
Gearset." We are not. The wedge is *convergence + locality*: the only place
where dictionary, code-quality, and impact questions are answerable in one
breath, over one private graph, for free.

---

## Honest weaknesses

If any of these is a dealbreaker for you, an incumbent is the better buy. None
of them is hidden in the product — the tools surface their own boundaries in
every response.

- **No live, record-level data.** The graph stores *metadata and source*, not
  rows. "How many opportunities closed last quarter," "which records violate
  this rule today," and anything depending on live runtime state are out of
  scope. The answer is "query your org directly." Gearset/Copado talk to the
  live org; this does not.
- **Partial Apex and Flow semantics.** Apex/LWC/Aura/VF analysis is scanner-
  and heuristic-based, not a full AST or dataflow engine. Dynamic SOQL,
  reflective field access (`obj.get('FieldName')`), `Type.forName` dispatch,
  trigger-framework base classes, and managed-package internals are invisible
  to the edge-walkers. Flow conditions are *listed but not evaluated* — the
  tool doesn't know whether a runtime record satisfies them. This is why every
  code-quality and what-if finding is tagged `heuristic` and asks to be
  spot-checked. False positives (and silent false negatives) are expected.
- **Scale: certified to 50,000 components** (import 40.5 s, resolve ~73 ms/query;
  `pnpm eval:scale:cert`, full report in `docs/reports/scale-certification.md`), on top
  of the 10,000-component import budget that gates every CI build
  (`packages/graph/test/scale-import.test.ts`). The graph is not the bottleneck at
  enterprise scale; the upstream `sf project retrieve` + extraction is. Orgs past ~50k
  modeled components should scope the refresh by metadata type (`sfi refresh --types …`)
  rather than pull everything at once.
- **Accuracy depends on the user keeping the vault fresh.** Everything is
  served from the last `sf project retrieve`. If the org changed after the last
  refresh, answers are stale — and a confidently stated stale answer is worse
  than no answer. The product flags staleness (`sfi.health_check`,
  `sfi.last_modified`, the freshness disclosures), but it cannot refresh itself
  mid-conversation. Live-connected SaaS tools never have this problem.
- **No hosted UI and no collaboration layer.** There's no web dashboard, no
  shared workspace, no role-based access, no audit trail of who looked at what.
  Output is text in a Claude Code session (and generated Markdown docs).
  Elements.cloud and the DevOps platforms are full products here; this is a
  library plus an MCP server.
- **Retrieval is still the ceiling.** Several discovery tools scan thousands of
  fields per call, and fuzzy resolution can invent confident false positives
  when a concept simply doesn't exist in the org. The front door is being
  hardened; until it is, a badly phrased query can under-return.

---

## When to use something else

- **You need live data or to act on the org.** Use Gearset or Copado to deploy,
  compare live orgs, and orchestrate releases. sf-intelligence will tell you
  *what would* break; it will not make or ship the change.
- **You need certified, audit-grade SAST with a large tuned rule set and
  suppression workflows.** Use Clayton.io or CodeScan, or start with the free
  Salesforce Code Analyzer. sf-intelligence finds real issues but is a younger
  engine with a smaller catalog and a higher false-positive surface on CRUD/FLS.
- **You need a polished, collaborative, hosted documentation portal** that
  non-technical stakeholders click through. Use Elements.cloud or Sonar/Salto.
- **You run a *very* large org (well past ~50k components) and need every metadata
  type pulled at once with zero setup.** The graph is certified to 50k components, but
  the upstream retrieve/extract on the largest orgs benefits from scoped refreshes; the
  commercial tools ingest everything at that scale out of the box.
- **You can't or won't use Claude Code / an MCP client.** The entire interface
  is an MCP server driven from Claude Code. No client, no product.

## When this is the right tool

- You want dictionary, code-quality, *and* impact answers in one place, in
  plain English, without paying for or context-switching between three SaaS
  products.
- Your org's metadata cannot leave the machine for security or residency
  reasons, and a fully offline, read-only tool is a hard requirement.
- You value an explicit confidence level on every fact over a single confident
  number, and you're comfortable spot-checking `heuristic` findings.
- You're already living in Claude Code and want org knowledge a question away.
- Budget is zero.
