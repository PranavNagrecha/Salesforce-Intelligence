# Positioning

This is an honest competitive-positioning doc, not a sales page. It exists so
that a Salesforce architect, admin, or developer can decide in five minutes
whether sf-intelligence is worth installing — and, just as importantly, when
to reach for something else.

The short version: Salesforce now ships first-party MCP servers that cover
describe-level metadata, CRUD/SOQL, and DevOps workflows. Several commercial
products answer org questions in natural language from a cloud model. What
those surfaces still do not fuse — offline, for free, with confidence labels —
is a **local dependency graph** that can answer dictionary, code-quality,
impact, security/compliance, and fleet questions in one editor session.

sf-intelligence keeps metadata on your machine by default, with an **opt-in
live read-only plane** for bounded org-ops when you enable it. It gives up a
hosted UI, certified accuracy guarantees, always-on cloud sync, and deploy
tooling. Whether that trade is right for you is the whole question this doc
tries to answer fairly.

The tool names below are real — they come from the `V01_TOOLS` roster in
`packages/mcp/src/tools/index.ts`. Run `sfi.capabilities` for the live tool
count and category map. Org examples (`Account`, `Payment__c`, etc.) are generic
placeholders, not anything from a real vault.

Public compare pages (same framing, scannable):
[compare hub](https://sfi.auditforce.cloud/compare) ·
[DX / hosted MCP](https://sfi.auditforce.cloud/compare/salesforce-dx-mcp) ·
[Elements.cloud](https://sfi.auditforce.cloud/compare/elements-cloud) ·
[dx0](https://sfi.auditforce.cloud/compare/dx0) ·
[Hubbl](https://sfi.auditforce.cloud/compare/hubbl) ·
[Metazoa Snapshot](https://sfi.auditforce.cloud/compare/metazoa) ·
[Sweep](https://sfi.auditforce.cloud/compare/sweep) ·
[agent-readiness audit](https://sfi.auditforce.cloud/use-cases/agent-readiness-audit)

---

## Jobs the product actually does

The engine underneath is still one confidence-tagged graph (dictionary + SAST +
impact). The shipped surface is wider than those three labels. Named jobs:

### 1. Org answers (living data dictionary)

- `sfi.generate_data_dictionary`, `sfi.explain_field` / `sfi.field_meaning`
- `sfi.find_field_anywhere` / `sfi.find_semantic_field` / `sfi.disambiguate_concepts`
- `sfi.generate_onboarding_doc` / `sfi.org_overview` / `sfi.domain_clusters`
- `sfi.get_naming_convention_report`

### 2. Change safety (impact / what-if)

- `sfi.get_impact`, `sfi.safe_to_delete_field`, the `sfi.what_if_*` family
- `sfi.what_happens_on_save` / `sfi.order_of_execution`
- `sfi.automation_risk_report` — per-finding automation risk, plus a
  `mode: 'sprawl'` org-wide per-object automation-density triage ranking (where
  is automation sprawl worst first — a candidate queue, not a verdict), the
  org-wide roll-up the single-object `automation_collisions` /
  `automation_build_advisor` / `order_of_execution` tools lack
- `sfi.compare_vaults` / `sfi.compare_object_across_vaults` /
  `sfi.compare_profile_across_vaults`

### 3. Code quality / Salesforce-specific SAST

- `sfi.governor_limit_risks`, `sfi.crud_fls_audit`, `sfi.find_hardcoded_values*`
- `sfi.flow_bulkification_audit` (the Flow-side sibling of `governor_limit_risks`:
  record DML / Get Records inside a Loop body + filterless Get Records)
- `sfi.pii_inventory`, `sfi.test_coverage_gaps` / `sfi.meaningful_test_audit`
- `sfi.code_quality_audit` / `sfi.tech_debt_score`
- `sfi.find_dead_code` / `sfi.method_reachability`

### 4. Security / compliance / agent exposure

- Permission math and risk: `sfi.effective_permissions`, `sfi.permission_risk_report`,
  sharing / FLS tracing tools
- Experience Cloud: `sfi.guest_exposure_report`
- Agentforce / GenAI surface: `sfi.ai_exposure_report` (what modeled AI assets
  touch, composed with PII inventory where applicable)
- Synthesis: `sfi.org_risk_report` (optional deploy gate)

### 5. Org-ops and fleet (offline + opt-in live)

- Offline fleet: `sfi.fleet_find`, `sfi.fleet_drift_ranking`,
  `sfi.generate_fleet_report`
- Offline limit headroom: `sfi.limit_headroom_report` — the vault-only
  replacement for the retiring Salesforce Optimizer limit report. Counts
  metadata against per-object / per-org configuration ceilings and ranks
  objects worst-first by remaining headroom%. Edition is unknown offline, so
  edition-dependent caps are labeled `assumed-edition` and disclosed; runtime
  limits (storage, API counts, daily async) are deferred to `sfi.live_org_limits`.
- Opt-in live plane: the `sfi.live_*` family (counts, samples, limits, drift,
  scheduled jobs, etc.) — never ambient; consent-gated and disclosed

The architecture claim stays the original three fused categories on **one**
graph. The jobs above are how that graph shows up for buyers who search
"tech debt," "AI-ready org," or "agent readiness" rather than "data dictionary."

---

## Competitors (honest lanes)

Facts below are framed from public positioning as of mid-2026. Products move;
prefer each vendor's own docs when a decision hinges on a detail. We do not
invent seat counts, accuracy %, or launch dates we cannot stand behind.

### Official Salesforce MCP (hosted + DX + Agentforce-as-client)

Salesforce's 2026 MCP stack commoditizes **shallow** org access:

- **Hosted MCP servers** (GA for Enterprise Edition+): Records CRUD, SOQL, and
  describe-style metadata — live against the org, Salesforce-managed.
- **DX MCP Server** (`@salesforce/mcp`): 60+ tools in opt-in toolsets
  (metadata, deploy, data, LWC, code analysis, DevOps Center) — DevOps and
  developer workflow, live API.
- **Agentforce as MCP client** (beta / evolving): native client + enterprise
  registry / allowlists so agents call MCP tools under admin governance.

**What they do well:** first-party trust, auth, governance, deploy/retrieve,
live data, and "talk to Salesforce from Claude/Cursor" as table stakes.

**What they do not claim (and what third-party coverage still flags as the
gap):** a cross-metadata dependency graph, blast-radius / impact analysis,
permissions cascade math, offline vault, or honesty/refusal discipline over
heuristic findings.

**When to prefer them:** you need to act on the org, query live records, or
stay inside Salesforce-managed hosting. **Use both:** DX/hosted MCP to
implement; sf-intelligence to understand blast radius and permissions first.
See [vs Salesforce DX MCP](https://sfi.auditforce.cloud/compare/salesforce-dx-mcp).

### Elements.cloud

Enterprise Change Intelligence: hosted metadata dictionary, dependency /
process mapping, collaborative web app, managed package. Their 2026 roadmap
centers **Conversational Org Intelligence** (plain-language impact / debt /
process questions) and a **Metadata MCP server** aimed at Spring 2026 so
external agents can hit the same model. Pricing is commercial SaaS (plans /
trials on their site — we do not mirror prices here).

**When to prefer them:** shared governance dashboard, BA/process tooling
(UPN etc.), enterprise SLAs, team collaboration over a vendor cloud model.
**sf-intelligence edge:** free, local vault, no per-seat license, confidence-
tagged edges, source-available. MCP-to-a-dependency-model is no longer unique
once their server ships — locality + honesty + price remain the contrast.
See [vs Elements.cloud](https://sfi.auditforce.cloud/compare/elements-cloud).

### dx0

Cloud "AI that knows your Salesforce org" — natural-language org answers,
change capture / knowledge features, enterprise InfoSec packaging (publicly
**ISO/IEC 27001** certified; pricing published at **€85/user/month** for new
customers as of May 2026, with existing customers grandfathered per their
changelog). No MCP story found in their public changelog as of mid-2026 —
usable from a browser product, not as a local MCP server in Claude/Cursor.

**When to prefer them:** you want a polished hosted chat product, vendor
security questionnaire answers (ISO), and zero local setup. **Do not win on
"security objection to cloud" alone** — their cert closes that for many
buyers. Win on **MCP-native + offline + graph depth + free OSS vs per-seat**.
See [vs dx0](https://sfi.auditforce.cloud/compare/dx0).

### Hubbl

Commercial org-intelligence / AI-readiness platform. Homepage category line
is literally **"the Intelligence Layer for Salesforce"** — a naming collision
with this project's framing. Ships org audits (tech debt / health /
AI-readiness style packages), Scan Requests for consultant-friendly audits,
and related scanning products. Cloud SaaS with enterprise compliance
marketing (verify current attestations on their site).

**When to prefer them:** you want a vendor audit report, cross-org
benchmarking, or a consultant-friendly scan motion with a shared dashboard.
**sf-intelligence edge:** free local MCP for day-to-day editor questions;
confidence-tagged graph; no "intelligence layer" trademark — we describe the
job as a **grounded, offline backend for Salesforce AI agents** when the
category phrase is contested.
See [vs Hubbl](https://sfi.auditforce.cloud/compare/hubbl).

### Metazoa Snapshot

Long-standing commercial org-management suite (dictionary, dependencies,
deploy/compare, data migration, admin UI) with a **local Snapshot MCP
server** pitched in the same words we use: intelligence stays on the
workstation, Zero Trust / no public endpoint framing for regulated industries.

**When to prefer them:** you need a full paid org-management + deploy product
*and* a local MCP companion. **Privacy/local-first alone is not a category of
one** — Metazoa proves that. Durable contrast: **offline + graph depth +
honesty/refusal + free OSS**, not "we invented local MCP."
See [vs Metazoa](https://sfi.auditforce.cloud/compare/metazoa).

### Org docs / dictionary (adjacent)

- **Sonar / Strongpoint (Salto lineage)** — automated documentation and change
  management, historically strong in regulated / audit contexts.
- **Sweep** — cloud agentic layer aimed at RevOps / GTM across multiple
  systems; different buyer than a single-org developer MCP.
  See [vs Sweep](https://sfi.auditforce.cloud/compare/sweep).

### Code quality / SAST (adjacent)

- **Clayton.io** — continuous Salesforce code-quality / security analysis,
  CI-oriented, commercial rule product.
- **CodeScan (AutoRABIT)** — SonarQube-lineage static analysis for Apex /
  Visualforce / Lightning with quality gates.
- **Salesforce Code Analyzer** — free first-party CLI (PMD, ESLint, and other
  engines). The honest free baseline for dedicated lint.

These are deeper, more battle-tested rule catalogs (commercial ones especially)
with suppression / gate workflows. sf-intelligence's analyzer is real but
younger, with a smaller catalog and loud false-positive disclosures on
CRUD/FLS.

### Impact / DevOps (adjacent, not converging yet)

- **Gearset**, **Copado**, **Salto** — deploy, compare, release orchestration.
  Their 2026 AI features sit in the **delivery** lane (context-aware deploy /
  pipeline agents), not a question-answering dependency graph for day-to-day
  org understanding.
- **Salesforce Optimizer** — free first-party unused-field / limits style
  report (being retired). `sfi.limit_headroom_report` is the offline,
  vault-only replacement for its limit table (metadata-vs-configuration-limit
  headroom, ranked worst-first); runtime limits stay on the opt-in live plane.

These tools *act*. sf-intelligence is read-only by design. Bridge story:
`sfi.org_risk_report` / promotion-readiness style tools inform a deploy gate;
Gearset/Copado/DX MCP still ship the change.

---

## The wedge (what still holds)

1. **Depth you can verify, offline.** Not "privacy alone" (Metazoa shares that
   pitch) and not "MCP alone" (Salesforce and Elements share that path). The
   combination: local vault + dependency graph + confidence tags + refusal
   discipline + free source-available package.
2. **All answer jobs on one graph.** Dictionary → SAST → impact → exposure
   audit in one conversation, one data model — not three SaaS exports.
3. **Natural language in the editor.** MCP server driven from Claude Code /
   Cursor / other hosts. Skills route to `sfi.*` tools and cite canonical
   component IDs.
4. **Free (MIT + Commons Clause).** No per-seat meter. Run `sfi.capabilities`
   for the live roster.
5. **Two graphs, joined — reasoning, not just retrieval.** The grounded org
   graph (graph A) is joined to a curated, org-independent **concept model**
   (graph B — master-detail cascade, junction objects, read-only formula/roll-up
   fields, stacked record-triggered flows, OWD posture, `without sharing` +
   external surface, and more). `sfi.interpret` runs graph B as a deterministic
   rule engine over an offline slice of graph A and returns *cited,
   confidence-tiered claims* about what a component structurally implies — no LLM
   inference, no live call. That is a step past "supply the facts to the model":
   the structural conclusion is computed and grounded, with a citation for every
   claim (no citation, no claim). Cloud NL competitors reason inside a hosted
   model you cannot audit; this reasons in a rule engine you can read.

The wedge is not "better SAST than Clayton" or "better deploys than Gearset."
It is **convergence + locality + honesty** after first-party MCP made shallow
access free — now with a second, org-independent reasoning graph joined on top.

### Market framing buyers already use

Tech debt is a top admin pain in 2026 industry commentary, and "get the org
AI-ready / agent-ready" is a common buying trigger for Hubbl- and
Elements-style audits. sf-intelligence already ships the kit
(`sfi.tech_debt_score`, `sfi.org_risk_report`, `sfi.unused_fields_deep`,
`sfi.find_dead_code`, `sfi.ai_exposure_report`, doc generators) — package it as
an [agent-readiness audit](https://sfi.auditforce.cloud/use-cases/agent-readiness-audit),
not as three abstract categories.

---

## Honest weaknesses

If any of these is a dealbreaker, an incumbent is the better buy. Tools
surface their own boundaries in responses.

- **No live, record-level data by default.** Metadata and source, not rows.
  Opt-in live plane is capped and consent-gated. "How many opps closed last
  quarter" still belongs in SOQL / hosted MCP / a BI tool.
- **Partial Apex and Flow semantics.** Default ANTLR AST pass yields
  `confidence: parsed` edges for resolved reads/writes and calls; heuristic
  recall covers gaps. Dynamic SOQL, reflection, `Type.forName`, cross-method
  dataflow, managed-package internals stay thin. Flow conditions are listed,
  not evaluated. SAST findings are `heuristic`; what-if inherits the weakest
  edge on the path.
- **Scale: certified to 50,000 components** on a synthetic import path
  (`docs/reports/scale-certification.md`); CI gates a 10k import budget.
  Graph traversal / ILIKE search at extreme scale are capped per tool, not
  fully benchmarked. Upstream retrieve + extract is the usual ceiling — scope
  with `sfi refresh --types …`.
- **Freshness is the user's job.** Stale vault + confident answer is worse than
  no answer. Live SaaS never has this exact failure mode.
- **No hosted UI / collaboration.** No shared dashboard, RBAC, or "who viewed
  what." Text in an MCP session + generated Markdown.
- **Large tool surface.** Hosts that do not defer tool definitions pay context
  cost on the full roster; `SFI_TOOL_PROFILE=core` + the analysis gateway
  mitigate — see `docs/configuration.md`.

---

## When to use something else

- **Act on the org or need live records.** Gearset, Copado, Salesforce DX /
  hosted MCP.
- **Certified, large-catalog SAST with suppression workflows.** Clayton,
  CodeScan, or start with Salesforce Code Analyzer.
- **Collaborative hosted documentation / BA process maps.** Elements.cloud or
  Salto-lineage doc products.
- **Polished hosted org-chat with enterprise ISO paperwork and no local
  install.** dx0.
- **Vendor AI-readiness audit report / cross-org benchmarks.** Hubbl.
- **Full commercial org-management + deploy UI, still local.** Metazoa
  Snapshot.
- **RevOps across Salesforce + other systems.** Sweep.
- **Very large org, every type at once, zero setup.** Commercial ingest tools;
  or scope sfi refreshes.
- **No MCP client.** The interface is an MCP server.

## When this is the right tool

- Dictionary, code-quality, impact, and exposure answers in one offline graph,
  in plain English, without three SaaS seats.
- Metadata must not leave the machine (and you accept that Metazoa also plays
  here — you want free OSS + editor-native MCP).
- You want confidence labels and honest refusals more than a single confident
  score.
- You already live in Claude Code / Cursor and want org knowledge a question
  away — including beside official Salesforce MCP servers.
- Budget is zero.
- You are preparing for Agentforce / agentic AI and need a local
  [agent-readiness audit](https://sfi.auditforce.cloud/use-cases/agent-readiness-audit)
  before you widen what agents can see.
