<p align="center">
  <img src="assets/hero.svg" alt="sf-intelligence — Salesforce Org Intelligence for AI agents: a read-only, offline MCP server and CLI" width="100%">
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT%20%2B%20Commons%20Clause-blue.svg" alt="License: MIT + Commons Clause"></a>
  <a href="https://www.npmjs.com/package/sf-intelligence"><img src="https://img.shields.io/npm/v/sf-intelligence.svg?color=cb3837&label=npm" alt="npm version"></a>
  <a href="https://github.com/PranavNagrecha/Salesforce-Intelligence/actions/workflows/ci.yml"><img src="https://github.com/PranavNagrecha/Salesforce-Intelligence/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933.svg" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/status-read--only%20%26%20offline-2ea44f.svg" alt="Read-only and offline-first">
</p>

# sf-intelligence

**A grounded, fail-closed backend for AI assistants working in one Salesforce
org.** Your AI host (Claude, or any MCP client) asks it questions in plain
language; it answers from the org's **real metadata** — never a guess — and
labels every claim with how much to lean on it.

`sf-intelligence` is an **offline, read-only, MCP-first knowledge base** for a
single Salesforce org. You run one retrieve (`sf project retrieve`); it builds a
local Markdown vault and a DuckDB dependency graph. From then on every answer is
served locally by default — **offline-first, no network egress for vault
answers.** An **opt-in live read-only plane** (`sfi.live_*`) can answer record
counts and samples when enabled. Private by design. MIT + Commons Clause.

It is **not a standalone chatbot** — it has no chat surface. It is the
evidence layer an AI host consumes: a router that **advises** (ranked tool
candidates plus explicit disclosures), a host LLM that **decides** (picks and
runs the tools), and an engine that grounds every answer in the vault and
**fails closed** — refusing, disclosing a gap, or asking a clarifying
question — when it cannot.

## Ask it like a person

You don't need to know the exact API name of anything. The front door is a
**typo-tolerant resolver** that turns messy phrasing into the right component —
and when it isn't sure, it **asks you a clarifying question** instead of
guessing:

> **You:** where's the emale field?
>
> **It:** I found several matches for "email" — which did you mean?
> · `Email__c` on `Account`
> · `Email__c` on `Contact`
> · `Alternate_Email__c` on `Lead`

> **You:** what about the paymnet object?
>
> **It:** `Payment__c` — one confident match.

> **You:** is there a "warranty fee" field?
>
> **It:** Nothing matched that confidently. Your vault was last refreshed on
> 2026-05-20 — want to pull fresh metadata from the org (`/sfi-refresh`) in case
> it's new, or rephrase?

That is the headline behavior for **resolution and routing**: **they never
silently commit to a guess.** Resolution is always heuristic and labeled as
such. When several components are plausible it hands you a clarifying question;
when nothing matches it offers to refresh from the org or stop. A high match
score is string similarity, not proof. **Source grep tools** (`sfi.search_apex_source`,
`sfi.search_flow_metadata`) walk the vaulted `source/` tree from your last
refresh — run `/sfi-refresh` before trusting an empty grep result.

## Advisory routing — the funnel advises, the host decides

Under the hood a semantic **router** (`sfi.route_question`) reads each question
and returns a **meaning-ranked shortlist** (`toolCandidates`) of the `sfi.*`
tools that can answer it — so your AI host picks and runs them without you ever
typing a tool name. It runs fully **offline** (a small TF-IDF model over the
tool catalog — no network, no embeddings service) and it **advises rather than
dictates**: the candidates are the primary output; the deterministic `route`
that rides along is a non-authoritative hint. The host LLM decides which tools
to run, in what order.

Confidence semantics are explicit. When no deterministic intent matches but the
semantic funnel's top candidate scores above a fixed floor, the router returns a
**`funnel-advisory` route** — the top funnel tools, confidence **`low` by
construction**, reason flagged `FUNNEL-DERIVED` — an advisory pick for the host
to verify (resolve the named component, then ground), never a command. Each
candidate row also carries `cosine`, its raw semantic score, so a host can tell
real semantic support from a regex-rule assertion.

The router also tags each question with the plane that answers it —
the **offline vault** (metadata, dependencies, permissions), the **live org**
(counts, samples, limits, inactive users — read-only, opt-in), or a **hybrid** of
both (e.g. "is this field *actually* populated?"). Every answer is stamped with
its provenance (`offline_snapshot`, `live_org`, or `hybrid`) and freshness.
Clarifying questions are a **last resort**: a qualifier already in the question
("the X *object*", an object word next to a same-named field, a literal API
name) auto-resolves instead of blocking, and offered options are hygienic —
fuzzy lookalike junk never appears as a choice. But when two genuinely competing
components remain, or the best-fitting tools diverge on something consequential
(one destructive-simulation, one read-only), the router **stops and asks which
you meant** instead of letting the host silently commit. When nothing fits, it
**says so** rather than guessing (and can log the gap locally — opt-in via
`logGap: true`). (A deterministic, no-LLM routing mode is available via
`SFI_ROUTER_MODE=offline` for CI / air-gapped hosts.)

An **experimental, opt-in RRF hybrid embeddings layer** is available for early
adopters (`SFI_EMBEDDINGS=1` + `npm i @huggingface/transformers`). It fuses the
TF-IDF candidates with a locally cached neural model (`~23 MB`) via Reciprocal
Rank Fusion. The model is **not bundled** with the npm package and isn't
fetched automatically — it requires the separate peer-dependency install
above, and the download-on-first-use path is still being hardened, so treat it
as a manual opt-in step, not something that happens for you. **Off by
default** either way — the lexical path is byte-identical when unset, and if
the model isn't installed or cached the funnel silently falls back to
lexical-only. The honesty/refusal decision and the deterministic `route.tools`
plan are not affected. See
[`docs/configuration.md`](./docs/configuration.md) for details.

## Refusal behavior — fail closed, offer the read

Some questions should never route to an executable tool, no matter how well
they score. Score-independent **refusal gates** run on the raw question before
any intent matching, and a refusal is non-executable *by shape* (`tools: []`
plus a structured `route.refusal` disclosure):

- **Write imperatives** ("delete the X field for me", "go ahead and merge these
  profiles") → `refused-write`, with a **read-only alternative** offered instead
  (`safe_to_delete_field`, `what_if_merge_profiles`, `get_impact`, … by verb
  family) — the product has no write path; the refusal names the simulation
  that answers the underlying question safely.
- **Prompt injection / record-value exfiltration** ("ignore your previous
  instructions…", "dump all SSN values") → `refused-injection`, with candidates
  and guidance suppressed entirely.
- **Runtime telemetry no tool models** → `honest-gap-runtime`, naming the
  nearest real reads. **Non-Salesforce asks** → `out-of-scope`.

Legitimate reads are explicit excluders — "am I allowed to edit…", "who can
delete…", "is it safe to…" are permission *questions* and route normally. On a
2,000-question real-org evaluation, the gates cut genuine over-confident routes
from 69 to 11 with **zero** answerable questions falsely refused.

## Conversation context — follow-ups without server-side memory

The product stores **no conversation state**. Instead, the host may pass an
optional `context.previous` on each `route_question` call describing what the
prior turn was about, and terse follow-ups ("does it fire on delete too?",
"what about on Contact?", "the second one") resolve against it — pronoun
substitution is an **exact-id** lookup (never fuzzy), an inherited tool is an
advisory continuation **capped at `medium` confidence**, and a clarification
pick re-dispatches through the normal clarification contract (out-of-range
ordinals re-ask, stale ids are rejected). A self-contained question ignores
context entirely, and refusal gates run before any context logic — context
never bypasses them. Host-side, after routing "who can edit the SSN field?"
and running the tools:

```jsonc
// next turn: "can Support Agents specifically edit it?"
{
  "question": "can Support Agents specifically edit it?",
  "context": {
    "previous": {
      "question": "who can edit the SSN field?",
      "tool": "sfi.field_access_audit",
      "componentId": "CustomField:Contact.SSN__c"
    }
  }
}
```

When (and only when) context changes the route, the response discloses it in
`route.contextApplied`. See [docs/routing.md](./docs/routing.md) for the full
host contract.

## Honesty guarantees

The design rule across the surface is **fail closed, disclose first**:

- **Grounded or refused.** Every answer path ends in real tool output against
  the vault (or the consented live org); when no tool covers the ask, the
  router returns an honest gap — never a lookalike tool, never general
  Salesforce knowledge dressed up as org fact.
- **Premise checks.** A question naming a component the resolver cannot find
  still routes (the tools fail closed on the unknown id), but confidence is
  downgraded and a `PREMISE CHECK` disclosure warns that no such component
  exists in the vault — and a funnel-advisory route is never granted on a
  failed premise.
- **Disclosure-first.** Coverage caveats, staleness warnings, live-consent
  notices, refusals, and context application are structured fields the host
  renders *before* the answer — not fine print after it.

## How it works

One read-only **refresh** turns your org into a local vault; from then on every
question is answered **offline** — your AI host asks the router for a shortlist,
picks the tools, runs them against the vault, and grounds the answer. The host
decides; the router only advises.

```mermaid
flowchart TB
    subgraph REFRESH["Refresh — once, and whenever the org changes"]
        direction LR
        ORG[("Salesforce org")] -->|"sf project retrieve (read-only)"| SRC["source/ raw metadata"]
        SRC -->|"extract + parse Apex / Flow / XML"| VAULT[("Graph A · Local vault<br/>your org, grounded<br/>Markdown + DuckDB graph")]
    end

    subgraph CONCEPT["Concept Model — ships with the package · no org data, ever"]
        CM[["Graph B · Concept Model<br/>142 org-independent concepts / 193 rules<br/>save-order · relationships · sharing · code-shape"]]
    end

    subgraph ASK["Ask — every question, offline on your machine"]
        direction TB
        Q["Your question<br/>(plain language)"] --> HOST["Host LLM<br/>(Claude, etc.)"]
        HOST -->|"1 · route_question"| FUNNEL["Semantic funnel<br/>offline TF-IDF — no network"]
        FUNNEL -->|"toolCandidates + guidance<br/>(ranked shortlist — advises)"| HOST
        HOST -->|"2a · retrieve: picks and runs"| TOOLS["sfi.* retrieval tools"]
        TOOLS -->|"read"| VAULT
        TOOLS -.->|"opt-in, read-only, capped"| LIVE[("Live org")]
        HOST -->|"2b · reason: resolve"| RESOLVE["sfi.resolve<br/>fix the component"]
        RESOLVE -->|"interpret"| INTERPRET["sfi.interpret · deterministic OFFLINE JOIN<br/>Concept Model × grounded vault slice<br/>no LLM · no live org read"]
        INTERPRET -->|"cited, confidence-tiered<br/>structural-implication claims"| SYNTH["3 · synthesize_answer"]
        TOOLS --> SYNTH
        SYNTH --> ANS["Grounded answer<br/>+ provenance + freshness<br/>+ cited canonical ids"]
    end

    VAULT ==>|"grounded slice · Graph A"| INTERPRET
    CM ==>|"concept rules · Graph B"| INTERPRET
```

Every box on the **Ask** path runs on your machine; the dotted edge to the live
org is the only one that can touch Salesforce, and only after you opt in.
Retrieval (`route_question → sfi.* → synthesize_answer`) reports *what's in the
org*; the reasoning path (`resolve → interpret → synthesize_answer`) reports
*what its shape implies*. `sfi.interpret` is a deterministic, offline **join** of
the org-independent **Concept Model** (Graph B — 142 concepts / 193 rules, which
never touches your org) against a grounded slice of the vault (Graph A); it runs
with no LLM and no live read, and every claim it feeds `synthesize_answer` is
cited and confidence-tiered. The deterministic `SFI_ROUTER_MODE=offline` mode
collapses step 1 to a single routed plan for hosts with no LLM in the loop.

## Reasoning, not just retrieval

Retrieval tells you *what's in the org*. It doesn't tell you what a structure
**implies** — that a master-detail parent delete cascade-deletes its children,
that two active before-save flows on one object run in an **undefined order**, or
that an `@AuraEnabled` method is an entry point where Apex does not auto-enforce
field-level security. SfIntelligence answers those with a small second graph.

Alongside the org's grounded vault, the product ships a **Concept Model**: **142**
org-independent, curated concepts and **193** rules that encode general Salesforce
truth — save-order phases, relationship semantics, sharing posture, code-shape
signals. No org data lives in it; the org enters reasoning **only** through the
grounded slice at query time. The `sfi.interpret` tool **joins** the two: it
assembles a minimal graph slice around one component and fires the applicable
rules to produce **cited, confidence-tiered structural-implication claims**. It
is **deterministic and offline** — no LLM, no live org read — and its claims are
also folded into `sfi.synthesize_answer` so they reach a normal answer, hedged
and attributed, on any MCP host.

The concept families are curated structural patterns, not vulnerability
detection. A sample of what fires today:

- **Relationships** — master-detail cascade-delete + read-only roll-up summary;
  junction (two-master) many-to-many; formula/roll-up fields are read-only, so a
  write to one is write-hostile.
- **Automation** — multiple active record-triggered flows in one trigger context
  (undefined execution order); a firing condition that tests a field another
  automation writes in the same save (cross-phase coupling); before/after trigger
  phases; a flow fault-path rollback gap.
- **Sharing & security surface** — organization-wide default (OWD) posture;
  `without sharing` system-context Apex; an external API surface
  (`@RestResource` / `@AuraEnabled` / `@InvocableMethod`) where FLS/CRUD are not
  auto-enforced; async boundaries; connected-app OAuth scope.
- **Code shape** — Apex SOQL-injection / bulkification / CRUD-FLS / swallowed-
  exception / hardcoded-id gaps; a test with no assertions.

Every claim is **grounded or it does not exist**. Each interpretation carries a
`groundedIn` list of the exact component ids it matched — **no citation ⇒ no
claim** — and its confidence is **computed, never asserted**: the *weakest* of
the rule's ceiling and the grounding edges it matched (see the two-axis note
below). An empty result means **"no concept rule fired,"** never "nothing depends
on it." And the governor/security concepts reason about **static code shape** —
they name a surface or a coupling, not a live limit breach or a proven runtime
vulnerability. For a worked resolve → interpret → synthesize example, see
[`docs/guides/asking-questions.md`](./docs/guides/asking-questions.md) §2b; for
the design rationale, [ADR-008](./docs/decisions/ADR-008-deterministic-concept-model-reasoning.md).

## What you can ask

Eight capability areas, each answerable in natural language (ask
`sfi.capabilities`, or just "what can you do?", for the live map):

| Area | Example questions |
| --- | --- |
| **Find & identify** | "where is the email field?" · "what's the payment object called?" |
| **Understand** | "what does this validation rule do?" · "what happens when an Account is saved?" (automation on standard objects works even when the object file was not retrieved; `objectModeled: false` is surfaced) |
| **Impact & dependencies** | "what breaks if I delete this field?" · "is it safe to deactivate this flow?" |
| **Permissions & sharing** | "why can't this user see this record?" · "who can edit the Salary field?" · "who holds the Sales Manager permission set?" (live) · "what does user Jane hold?" (live) · "who's in the Support queue?" (live) · "which active users have zero permission-set assignments?" (live) |
| **Automation & code** | "what runs on Case create?" · "which Apex methods have no real test coverage?" · "decode this Apex debug log / governor-limit exception to the class that ran" |
| **Decision-support (before you build/change)** | "before I add automation to this object, what already runs there?" · "building Apex here — what should I watch out for?" · "before I change/require this field, what breaks?" |
| **Architect & developer** | "are there circular Apex dependencies?" · "which classes have no test reference?" · "does the vault still match the live org?" |
| **Integrations** | "what external systems does this org talk to?" · "list every outbound endpoint" |
| **Documentation** | "give me a tour of this org" · "generate a data dictionary" · "which reports / objects / permission sets have no description?" (`list_components` with `missingDescription: true`) |
| **Health & audit** | "is my vault fresh?" · "where is PII stored?" · "how has the org changed across refreshes?" |

These are **advisory, read-only briefings** — e.g. `automation_build_advisor`,
`apex_build_advisor`, `field_change_advisor` synthesize what the org already
shows so you make a better build decision; `find_dependency_cycles`,
`apex_test_coverage`, `live_drift_check`, and `org_history` serve architects and
developers. None of them write to the org.

Every org artifact the product names is backed by a tool call and cited with its
canonical ID (`CustomObject:Account`, `CustomField:Account.Industry__c`), and
every relationship is cited with its confidence (`declared`, `parsed`, or
`heuristic`).

## Trust & confidence glossary

Every answer is tagged so you know how much to lean on it. These tags match the
runtime values verbatim (the `trust` block on analysis tools, the per-edge
`confidence`, and `synthesize_answer`'s `provenance.stamp`).

**Edge confidence** — how a *relationship* was derived. This is the per-edge tier
you see on dependency answers:

- `declared` — Salesforce metadata states it directly (a layout assignment, a
  field's `referenceTo`, a permission grant). Highest trust.
- `parsed` — produced by AST/XML parsing of source (the **parser-grade Apex
  pass that runs on every refresh by default** — resolved field reads/writes,
  cross-class calls, field-level SOQL — plus the formula tokenizer, Flow
  elements, a profile's `<layoutAssignments>`). High trust.
- `heuristic` — produced by regex / token / dynamic-string analysis (the Apex
  recall scanner that supplements the parsed pass, name-pattern detection). May
  have false positives — spot-check before acting.

**Claim confidence** — a *different* axis: how well a **reasoning claim** from
`sfi.interpret` is grounded. It uses the same `declared | parsed | heuristic`
words, but it is **computed, not read off one edge**: a claim's confidence is the
*weakest* of the concept rule's ceiling and the grounding edges the claim matched.
An absence-shaped claim under non-complete coverage reads `unknown`. Do not
conflate the two — edge confidence describes a single relationship; claim
confidence describes an interpretation that *rests on* one or more such edges and
can never exceed the weakest of them.

**Provenance** — where the answer came from:

- `offline_snapshot` — the last `/sfi-refresh` vault. The default for every vault
  tool.
- `live_org` — an opt-in, capped, read-only `sfi.live_*` SOQL read.
- `hybrid` — fuses vault + live and discloses both provenances.

**Completeness** — how much of what the answer depends on was actually retrieved:

- `complete` — the refresh modeled every metadata family the answer needs.
- `partial` — a family the answer depends on was not retrieved; absence means
  "not checked", never "none" (a `coverageCaveat` names the gap).
- `unknown` — coverage could not be determined.

Two tools make this concrete. `sfi.coverage_report` lists what the retrieve
manifest *requested and returned*; `sfi.retrieve_blindspot_report` lists what the
graph *references but never retrieved* — automation/code/config that depends on a
component the vault never pulled — so an "X is unused / nothing references X"
answer carries a known-coverage caveat instead of a silent blind spot.

## How much it models

| | |
| --- | --- |
| **MCP roster** | Every `sfi.*` tool is registered in code; run `sfi.capabilities` (see `productManifest`) for the live registered/advertised counts — never a handwritten number |
| **Graph model** | A broad `ComponentType` union across **101** component types (objects, fields, Flows, Apex, layouts, permissions, sharing, UI, legacy automation, integrations, CPQ, OmniStudio, reports, FlexiPages, and more) connected by **23** typed edge types — see `sfi.capabilities` for how tools group those families. Counts are pinned by `eval/product-manifest.json`. |
| **Concept Model** | Concept Model (142 concepts / 193 rules) — org-independent, curated — JOIN against the grounded vault to produce cited structural-implication claims via `sfi.interpret`. No org data lives in the model. Same figures in `eval/product-manifest.json`. |
| **26** | skills + **5** slash commands + **2** subagents (Claude Code plugin layer) that auto-activate in a session |

## What it does NOT do

Boundaries are explicit, and the product tells you plainly when it hits one
rather than papering over the gap with general Salesforce knowledge:

- **Offline by default.** Vault tools never call Salesforce mid-conversation.
  Run `/sfi-refresh` to update metadata. **Opt-in live tools** (`sfi.live_*`)
  run read-only SOQL with strict caps and label answers `provenance: live_org`.
  The live plane is **off until you grant once per org** with
  `sfi.live_consent { grant: true }` (binds OrgId+principal, scopes+expiry;
  persists locally) or set `SFI_LIVE_PLANE_ENABLED=1`. Per-call
  `liveEnabled: true` is intent only — not a consent substitute. Step up
  `sample` / `users` scopes for row samples and user-identity tools.
  **Hybrid** answers fuse vault + live and disclose both provenances plus the
  active grant. Live never backfills stale vault claims, and the product never
  auto-picks which org to query.
- **No record-level data.** The vault stores schema and source, not rows. "How
  many Opportunities closed last quarter" is a question for your org directly.
- **Static analysis, not runtime.** Dependency edges are derived from metadata
  and source. Dynamic SOQL, reflective Apex, and runtime metadata lookups are
  invisible to static analysis — a "no references found" result means "no static
  evidence", not "definitely unused".
- **Reasoning is deterministic rule-match, not an LLM and not a live check.**
  `sfi.interpret` fires curated concept rules against the offline grounded slice.
  Its claims are structural implications of the *code and metadata shape* — it
  names a pattern (a cascade-delete, an undefined flow order, an unenforced entry
  point), and cites the ids it matched. A governor or security concept is a
  **static-shape signal, not a proven runtime limit breach or a proven
  vulnerability**; a claim with no citation is never made, and an empty result
  means "no rule fired," not "nothing depends on it."
- **Read-only.** The product never writes to your org. It has no write path.
- **Tested scale (CI budgets).** Three separate ceilings are gated in CI:
  - **Graph import:** 10,000 nodes in &lt;90s (`packages/graph/test/scale-import.test.ts`, `SCALE_IMPORT_BUDGET_MS`).
  - **Full refresh:** 1,000 `CustomObject`+`CustomField` files by default in &lt;10m (`packages/cli/test/scale-refresh.test.ts`, `SCALE_REFRESH_FIELD_COUNT`, `SCALE_REFRESH_BUDGET_MS`).
  - **Resolve:** p95 under 2s on the CI vault (`pnpm eval:scale`, `SCALE_BUDGET_MS`).
  Very large production orgs may still need narrowed retrieves or multiple vaults.

## Review changes before you deploy (PR gate)

`sfi.review_change` is the pre-deploy gate: hand it the components a PR /
`package.xml` / `git diff` touches and it returns a per-component risk verdict
(`blocking` / `risky` / `review` / `safe`), each one's direct dependents, and the
tests to run — most-dangerous first, entirely offline against the target org's
last vault refresh. A deleted component with any dependent fails **closed**
(`blocking`); a modified component with firm dependents is `risky`; `overallVerdict`
is the worst across the set. Point it at another vault (`againstVault`) to answer
"will this changeset break anything in **prod**?" against that org's graph.

The same analysis ships as a GitHub Action — the composite Action at
[`.github/actions/review-change`](./.github/actions/review-change/README.md)
emits SARIF 2.1.0 (findings show up inline on the PR's "Files changed" tab and in
the Security tab) plus a markdown PR comment, with a 0/1/2 exit-code gate. Copy
[`docs/ci/review-change-pr-gate.example.yml`](./docs/ci/review-change-pr-gate.example.yml)
into your org repo to wire it up. It never runs `sfi refresh` and never calls the
`sf` CLI — it only reads an already-built vault.

## Try it now — no Salesforce org needed

Want to see it work before pointing it at your own org? One command serves a
built-in **synthetic demo org** ("Verdant Energy," a fictional solar installer)
over MCP — fully offline, no auth, no `sf` CLI:

```bash
# Register the demo server with Claude Code (or any MCP client):
claude mcp add --transport stdio --scope user sf-intelligence-demo -- npx -y sf-intelligence demo
```

Then ask it things like:

> - *What happens when I save a Project?*
> - *What breaks if I delete `Invoice__c.Amount__c`?*
> - *Why can't an Installer see an Invoice?*
> - *Which Apex has governor-limit risk?*

The first run builds the demo vault in a few seconds (cached under
`~/.sf-intelligence/demo`); every run after is instant. Nothing leaves your
machine. When you're ready for your real org, follow **Install** below.

## Install

`sf-intelligence` is distributed on npm as `sf-intelligence` — an MCP
server plus the `sfi` command-line tool. Register the server with your MCP
client once, then drive everything through `sfi` (or, inside Claude Code, the
`/sfi-*` slash commands that wrap it).

**Requirements:** [Node.js 20+](https://nodejs.org) and an authenticated
[Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`)
pointed at the org you want to vault. `npx` fetches everything else.

### Register the MCP server

**Claude Code** — from your Salesforce DX repo, add it project-scoped (writes a
`.mcp.json` at the repo root that your team can commit):

```sh
claude mcp add --transport stdio --scope project sf-intelligence -- npx -y sf-intelligence mcp
```

**Claude Desktop, or any other MCP client** — add this block to the client's MCP
config (Claude Desktop on macOS lives at
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp"]
    }
  }
}
```

Restart the client. The `sfi.*` tools are now available — ask `sfi.capabilities`
for the live tool map.

> **Tip:** `npm install -g sf-intelligence` puts an `sfi` command on your
> PATH, so first-run setup is `sfi init` / `sfi refresh` instead of the longer
> `npx -y sf-intelligence …` form.

### Optional: full roster vs compact core

**Default is the 19-tool core roster** (AUDIT-F6; includes `sfi.live_consent`)
so MCP hosts don't pay a ~250 KB `tools/list` tax. Non-core tools stay
reachable via `sfi.run_analysis` (byte-identical) and are not directly
invokable under core. Set `SFI_TOOL_PROFILE=full` (or add
`"env": { "SFI_TOOL_PROFILE": "full" }` in the config block above) to advertise
and directly invoke the entire roster. See
[docs/configuration.md](./docs/configuration.md) for the full reference.

### Install as a Claude Code plugin

The MCP registration above gets you the `sfi.*` tools. Installing
`sf-intelligence` as a **Claude Code plugin** additionally gets you **26
skills** that auto-activate on Salesforce vocabulary (no need to remember tool
names) and **5 slash commands** (`/sfi-onboard`, `/sfi-init`, `/sfi-refresh`,
`/sfi-status`, `/sfi-field-audit`) that wrap the `sfi` CLI. Install it from this repo's
marketplace:

```sh
/plugin marketplace add PranavNagrecha/Salesforce-Intelligence
/plugin install sf-intelligence@sf-intelligence
```

Run `/reload-plugins` (or restart Claude Code) to pick it up in the current
session; `/plugin list` confirms it's installed and enabled. The plugin
manifest registers the same MCP server shown above, so once it's installed
you don't need a separate `claude mcp add` step.

## First run

Work from **your per-org repository** — the Salesforce DX project you want to
vault (the directory with `sfdx-project.json`). The first refresh is read-only:
it retrieves metadata and builds a local knowledge base; it never deploys or
mutates Salesforce data.

```sh
# 0. New here? The guided path walks install → auth → init → refresh → ask,
#    with real starter questions at the end.
sfi quickstart

# 1. Create the local org-kb/ vault layout and record which sf org alias to use.
sfi init

# 2. Retrieve metadata and build the vault.
sfi refresh --target-org my-org-alias

# 3. Confirm vault freshness, source-tree hash, and component counts any time.
sfi status

# sfi doctor checks the sf CLI, the vault, target-org auth, freshness, and the
# graph file, and prints an actionable fix for each problem.
sfi doctor
```

**How long does a refresh take?** A small sandbox builds in a few minutes; a
production-scale org is typically **~10–12 minutes** under the defaults — the
retrieve dominates, and the default build also runs the parser-grade Apex pass
(seconds per few hundred classes) and pulls the **top 500 reports/dashboards by
actual usage** (a minute or two on report-heavy orgs; `--no-reports` skips it).
In a hurry on a big org? `sfi refresh --staged` serves a skeleton vault in
seconds and the ten priority metadata families within minutes, then finishes
the full build behind the scenes — see the
[first-refresh guide](./docs/guides/first-refresh.md). Re-refreshes re-extract
and rebuild the graph in full by default (results always match a cold build);
`--incremental` reuses the per-file parse cache for the same result, faster,
and `--incremental-graph` additionally re-imports only the changed nodes/edges
into the graph instead of rebuilding it — combine both for the largest win.
`--types <list>` scopes either flag to specific metadata types (e.g.
`sfi refresh --types Flow --incremental-graph`); a scoped refresh only ever
touches the requested type(s) — every other type in the vault is left as-is.

No global install? Prefix each with `npx -y sf-intelligence`, e.g.
`npx -y sf-intelligence init`.

Then ask anything the vault can answer, in whatever MCP client you registered:

> What fields does the Account object have?
>
> What breaks if I delete `CustomField:Account.Industry__c`?
>
> Why can't the Standard User profile see Opportunities?
>
> Give me a tour of this org.

**Running sf-intelligence as a Claude Code plugin?** The same operations are
available as slash commands — `/sfi-onboard` (guided first run), `/sfi-init`,
`/sfi-refresh`, `/sfi-status` — and the coaching skills auto-activate when
Salesforce vocabulary appears. See [Install as a Claude Code
plugin](#install-as-a-claude-code-plugin) above if you haven't installed it
that way yet.

### Serve it over HTTP (read-only)

`sfi mcp` is the stdio server your MCP client launches. To share one vault with
other machines or clients, the same server speaks streamable HTTP:

```sh
# From the vault directory: prints a bearer token once, listens on 127.0.0.1:8787.
sfi serve --http --generate-token

# Team path: JSON token→identity map (annotation writes attribute to the caller).
# sfi serve --http --tokens-file ./tokens.json
```

The remote posture is deliberately strict: a bearer token is required on every
request (solo `--token` / `--generate-token`, or `--tokens-file` for per-caller
identity), the bind is loopback unless you pass `--host` (a non-loopback host
warns and refuses to run tokenless), and the **live plane is hard-disabled over
HTTP** — a remote caller can never spend your Salesforce API budget, even if
the host has standing live consent. A refresh underneath a running server is
safe: readers keep answering from the old graph until the new one swaps in.

### Give the vault a memory

```sh
# One-time, from the vault directory: inits a git repo INSIDE org-kb/
# (rebuildable surfaces like graph/ and snapshots/ are gitignored).
sfi vault git enable
```

From then on every refresh commits the vault's source and rendered Markdown, so
"**when did this component change?**" (`sfi.component_history` — one timeline
entry per source-changing refresh) and "**what did it look like before?**"
(`sfi.component_as_of`) become answerable from the vault's own history. A vault
without git answers those honestly (`available: false` plus this enable hint) —
never an error.

## Privacy

Everything stays on your machine. The vault (`org-kb/`) is local; the MCP server
defaults to `SFI_NETWORK_MODE=off` and makes no network calls while answering
vault questions. Optional egress is explicit: npm update-check only when
`SFI_UPDATE_CHECK=1` (or `updates-only` mode); Salesforce retrieve/live only
when refresh or an authorized live tool elevates to `salesforce-read`. This
public repository ships **zero org data** — a release privacy guard scans the
shipping set on every release and fails the build if a real org identifier
leaks. What you vault is yours.

## Roadmap

The product is read-only today by design; that is the major axis of future work.

- **Deeper code resolution.** Parsed Apex call edges carry the called method
  names today; the remaining composite tools still reason at class granularity —
  method-level reachability across them is the next step.
- **A careful write side.** A small, opt-in set of *proposal* tools (e.g. draft a
  permission-set diff or a validation-rule edit for human review) once the read
  side is mature. The default will always be read-only.

(Earlier roadmap entries shipped: Tooling-API-backed stale-vault detection is
now the `sfi watch` daemon + drift badges; remote read-only serving is
`sfi serve --http`.)

## Feedback

A weak or wrong answer, or a question it couldn't route? That's the most useful
thing you can send back. It's captured **locally** — nothing phones home:

```sh
sfi feedback mark "where is the SSN field used" --wrong   # or --weak
sfi feedback export                                       # → sfi-feedback.json (scrubbed)
```

`sfi feedback export` bundles the local route-gap log plus your ratings into one
file with org PII (emails, URLs, record ids) stripped — component/api names are
kept because they're the signal. Exports are **scoped to the current vault by
default**: the log file is machine-global (`~/.sf-intelligence/`), but each gap
is stamped with the vault it was asked against, and only the current vault's
gaps are exported (the file reports how many were excluded). `--all` exports
the whole machine-global log — review it before sharing if you work across
multiple orgs. Share it (or just describe the gap) at
<https://github.com/PranavNagrecha/Salesforce-Intelligence/issues>.

## License

`sf-intelligence` is licensed under the **MIT License with the [Commons Clause](./LICENSE)** (see also [`NOTICE`](./NOTICE)). In plain English:

- ✅ **Free to use for any purpose — including at work, inside a company.** Evaluate, study, modify, self-host for your own use, fork, redistribute, and contribute — all free.
- 🚫 **You may not _Sell_ it without a commercial license** — i.e. provide it to third parties, for a fee, as a product or service whose value derives substantially from the Software. That includes offering it (or a hosted / SaaS / derivative version) as a paid product or service, reselling it or paid access to it, or charging for hosting/support whose value derives substantially from it.

For a commercial ("Sell") license, contact **pranav.sfintelligence@gmail.com**. _(Plain-English summary; the [LICENSE](./LICENSE) controls. Not legal advice.)_

## Documentation

- [Documentation index](./docs/README.md) — guides, architecture, configuration
- [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

The build harness (a sibling repo, separate from this product) vendors Addy
Osmani's [`agent-skills`](https://github.com/addyosmani/agent-skills) under MIT.
Copyright (c) Addy Osmani; full MIT license text travels with the harness. None
of that content is redistributed in this product directory; the attribution is
recorded here for completeness.
