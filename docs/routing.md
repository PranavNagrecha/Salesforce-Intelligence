# Routing — how a question reaches a tool

This product ships 211 registered tools. Routing is the machinery that turns one
plain-language question into a choice among them. It is the difference between a
capability existing and a capability being usable, which is why this document is
long: it covers how each stage works, **and what each stage does not do**.

Audience: people wiring sf-intelligence into a host, and anyone changing the
router. For what end users can ask see
[guides/asking-questions.md](./guides/asking-questions.md); for env vars,
[configuration.md](./configuration.md).

The one-paragraph version: **the pipeline is good at putting the right tool in
the shortlist (~90%) and no better than a coin flip at putting it first (~60%).**
That is by design — `sfi.route_question` advises and the host LLM decides — and
every number in §13 is a variation on it.

---

## 1. The pipeline at a glance

| # | Stage | Where | What it can do | What it cannot |
| --- | --- | --- | --- | --- |
| 0 | Normalise | `semantic-funnel.ts` `tokenize()` | lowercase, strip punctuation, drop stopwords, light plural stem, phrase-synonym expansion **on the query only** | no lemmatiser, no spell-correction, no learned synonyms |
| 1 | Refusal gates | `refusal-gates.ts` | fail closed by SHAPE before any matching — 4 kinds, first-hit-wins | cannot judge whether an allowed question is answerable |
| 2 | Deterministic intent | `intent-router.ts` | 236 regex intents to tools, plane, `suggestedArgs`, multi-step plans | silent on most fresh phrasings; see §13 |
| 3 | Lexical funnel | `semantic-funnel.ts` | L2-normalised TF-IDF cosine over a per-tool document | no embeddings in any shipped install (§4) |
| 4 | Candidate assembly | `tools/route-question.ts` | fuse regex + funnel, band confidence, attach `answers`/`category`, render | never runs a tool, never resolves a component |
| 5 | Host decision | your LLM | pick, supply args, run, ground | — |

Stages 1-4 are deterministic and offline. No network, no model, no learned state.
The same question always produces the same shortlist.

---

## 2. Advisory semantics — who decides what

`sfi.route_question` never answers a question and never runs a tool. It
returns, for one plain-language question:

| Field | Authority | What it is |
| --- | --- | --- |
| `toolCandidates` | **Primary** | Meaning-ranked shortlist of `sfi.*` tools (offline TF-IDF over the tool catalog — no network, no embeddings service). Each row carries the tool, **`answers`** (the tool's one-line summary) and its **`category`**, its plane, whether it needs the live org, a confidence band, and `cosine` — the raw pre-fusion semantic score (`0` for rows inserted purely from a regex route hint), so you can tell real semantic support from rule assertion. |
| `route` | **Advisory hint** | The deterministic route: an intent, ordered `route.tools` (with step ids and `dependsOn` edges for compound questions), plane, confidence, `suggestedArgs`, disclosures. A suggestion to inform your pick — never a command. |
| `guidance` | Informative | One line stating the loop the host owns: read the candidates → resolve any named component → pick/sequence the tool(s) → run them → ground via `sfi.synthesize_answer`. |

`answers` exists because the default tool profile is `core`, which advertises 19
of 207 tools. For every other candidate the shortlist would otherwise name a tool
whose description is nowhere in your context, recoverable only by an
`sfi.describe_analysis` round trip per candidate. The one-liner is the same text
`sfi.list_analyses` renders, so you can pick without a second call — and, just as
usefully, recognise a shortlist that contains no right answer. It does not affect
ranking; candidate order and scores are identical with or without it.

**The host LLM decides.** In the default hybrid mode you read the candidates
and the hint, pick, run, and ground. Two things are *not* advisory:

- `executionBlocked: true` — a genuine ambiguity. Stop, ask the user
  `route.clarification.question`, and resume with the exact
  `clarificationId` + an offered selection (§9). Never invent an option.
- `route.refusal` — a refusal shape. `route.tools` is empty by construction;
  there is nothing to run (§8).

**Deterministic mode.** `SFI_ROUTER_MODE=offline` makes the deterministic
route authoritative and omits candidates — for CI and hosts with no LLM in
the loop. Refusal gates and clarifications behave identically in both modes.

### Confidence semantics

`route.confidence` is `high` / `medium` / `low` and encodes *how* the route
was derived, not merely how well it scored:

- `high` / `medium` — a deterministic intent matched (regex/plan vocabulary),
  possibly downgraded by a premise warning (§10).
- `low` — advisory by construction. A **`funnel-advisory`** route is always
  `low`; treat it as the funnel's pick to verify, never a command.
- A **context continuation** (§11) is capped at `medium`, never `high`.
- A **refusal** (§8) reports `high` — confidence in the refusal itself, not in
  any tool; `route.tools` is empty regardless.

---

## 3. What the funnel indexes

Each tool gets ONE document, assembled in `buildToolDocs()`
(`semantic-funnel.ts`). Knowing what goes in is the whole game, because the only
way to make a tool findable is to change this document:

| Source | Notes |
| --- | --- |
| tool **name** words | `sfi.find_dead_code` becomes `find dead code` |
| `TOOL_KEYWORDS` | curated per-tool overlay for tools whose prose does not echo how people ask |
| `FUNNEL_UTTERANCES` | **2,006 ask-phrasings across 207 tools** — the primary lever |
| `tool.description` | the host-facing contract, **boilerplate-stripped** first |
| capability map | `tools/capabilities.ts` CATEGORIES title / description / examples |
| `INTERPRET_CONCEPT_CARDS` | 46 cards giving `sfi.interpret` per-concept documents |

**Description text is also a retrieval document, and that cuts both ways.** Text
repeated verbatim across N tools depresses the document frequency of every term
it contains for **every** tool in the corpus, including tools that never mention
the subject. `tools/corpus-boilerplate.ts` strips such blocks before indexing,
and it exists because of two measured regressions: a permission warning appended
to four tools broke routing for `sfi.org_card`, which the change never touched;
and a `conceptReasoning` paragraph displaced `sfi.interpret` from a top-5
assertion by 0.0010 — where neither parent branch failed alone and only the merge
did.

**Asymmetry to know about:** the QUERY is phrase-synonym expanded; documents are
tokenized verbatim. Weighted expansion uses `EXPANSION_WEIGHT = 0.5`.

**The plural stem is load-bearing, not a bug.** `tokenize()` stems plurals with a
single trailing-`s` strip, which mangles two of the three English plural forms —
`communities` becomes `communitie`, `classes` becomes `classe`. It is applied to
the query *and* the corpus, so the two still collide, and the 2,006 utterances
were tuned against exactly that behaviour. A correct rule-based stemmer was
implemented and measured: **+10 points at rank-1 on a 30-question sample, −23 on
the 1,000-question authority set.** It was reverted. Changing tokenisation
invalidates the tuning built on top of it; treat it as a corpus-wide migration,
never a one-line fix.

---

## 4. How a score is produced

L2-normalised **TF-IDF cosine** — not BM25, and not embeddings.

- IDF is smoothed: `log((n + 1) / (df + 1)) + 1` (`semantic-funnel.ts`).
- Vectors are L2-normalised, so a score is a cosine in `[0, 1]`.
- Scores are **quantised to 3 decimal places**. A test that pins an exact score
  is a tripwire for unrelated corpus edits; assert margins and ratios instead.
  A pin on a *sum* of quantised values is several times more fragile again.

### Embeddings — present in the tree, absent from every install

Two embedding paths exist and **neither runs in a shipped install**:

| Path | Gate | Data | Reaches an npm user? |
| --- | --- | --- | --- |
| MiniLM hybrid (`embedding-funnel.ts`) | `SFI_EMBEDDINGS=1`, default off | `data/embedding-index.json` | **No** — `packages/mcp/package.json` declares `files: ["dist/src"]`, so `data/` is never packed |
| Static embedding (`static-embed.ts`) | `SFI_STATIC_EMBED=1`, default off | 3 assets, **gitignored** (~8.5 MB) | **No** — absent from any clone and from CI |

`embedding-funnel.ts` states the original cause plainly: it "was never wired into
the shipped router because query embedding is ASYNC while the funnel candidate
chain is SYNCHRONOUS". `static-embed.ts` was built to remove that obstacle —
synchronous, sub-millisecond, no native dependency — and parked as "measured
sub-bar lift".

Regenerating the static assets and enabling the gate was re-measured for this
document: **recall identical at every K**. The reason is visible in the raw
embedding ranking — all 206 tool vectors land inside a **0.51-0.56** cosine band.
A distilled static model mean-pools its token rows, so 206 long, jargon-dense
documents collapse to nearly the same point. The RRF fusion is deliberately
asymmetric (`RRF_K_LEX = 10`, `RRF_K_EMBED = 60`) so the embedding can only
promote a lexical near-miss, never displace a lexical hit — which is why turning
it on changes so little.

**Do not treat "enable the embeddings" as an available fix.** The failure to beat
is vector discrimination across long documents.

---

## 5. Funnel-primary (`funnel-advisory`) routes

When **no deterministic intent matches**, the router does not simply give up.
If nothing else stopped the route — no pending clarification, and a clean
premise (a question naming a component the resolver cannot find gets the
premise disclosure instead, never an advisory route) — and the semantic
funnel's top candidate scores at or above a fixed floor
(`FUNNEL_PRIMARY_MIN_SCORE = 0.26`, a source constant, not an env var; the
score is a pure cosine, uninflated by regex fusion bonuses), the dead
`unrouted` verdict is upgraded to:

- `intent: 'funnel-advisory'`
- `route.tools`: the top-3 funnel candidates
- `confidence: 'low'` by construction
- `reason` flagged `FUNNEL-DERIVED`

Host behavior: treat it as an advisory pick — resolve the named component,
run the top tool, ground the answer, and fall back to the next candidate if
the output does not fit the question. Below the floor the question stays
honestly `unrouted` with candidates still present for you to reason over.

---

## 6. Candidate assembly

`buildFunnelCandidates()` merges the deterministic route with the funnel ranking:

- A tool named by the regex route but **not** surfaced by the funnel is INSERTED
  with `cosine: 0` and a score of exactly `REGEX_BONUS = 0.25`.
- `FUNNEL_PRIMARY_MIN_SCORE = 0.26` sits deliberately **one hundredth above** that
  bonus, so a pure regex assertion can never by itself clear the advisory bar.
  Every route-inserted row you see scoring `0.2500` is this mechanism.
- `cosine` is the honest field: it is the raw pre-fusion semantic evidence, and
  `0` means *none*. Downstream calibration must read `cosine`, never sniff the
  `0.25` magic number.
- `confidence: 'high'` on such a row means "a deterministic intent pinned this",
  **not** "this scored well". Read the two fields together.
- Rows are deduped by tool, sorted by score then name, and sliced to `k`.
- Every row is then enriched with `answers` (the tool's one-liner) and
  `category` — see §7. There are **two** emit sites, the normal return and the
  refusal return; both are enriched.

---

## 7. Tool profiles — and why rows carry `answers`

The default tool profile is `core`, which advertises **19 of 211** tools. Every
other analysis is reached through `sfi.run_analysis` with a `name` and `args`,
using `sfi.list_analyses` and `sfi.describe_analysis` as the catalog.

This has a consequence people miss: a shortlist naming
`sfi.guest_exposure_report` names a tool that is **not in the host's tool list and
has no description in its context**. Recovering it costs an
`sfi.describe_analysis` round trip per candidate, which no real host makes — so
the host was being asked to choose between bare names.

Each candidate row therefore carries `answers`, the same one-liner
`sfi.list_analyses` renders, and a populated `category`. Measured over 50
questions, an LLM host's top-1 choice moved **39/50 to 42/50**; of the six picks
that changed, three became correct and none became wrong. It also lets a host
recognise a shortlist that contains no right answer — for "which objects have
change data capture enabled", seeing that the candidates are *field-history
tracking* tools is what stops it running rank-1 into an oversize error.

It does not affect ranking. Candidate order and scores are identical with or
without it.

---

## 8. Refusal gates — fail closed by shape

Score-independent detectors run on the **raw question before any intent
matching**, in both router modes. A hit produces a non-executable route:
`tools: []`, `executionBlocked: false` (there is nothing to clarify), and a
structured `route.refusal = { kind, disclosure, readOnlyAlternative? }`.

| `kind` | Trigger | What the host gets |
| --- | --- | --- |
| `write-imperative` | A mutation asked *of the agent* ("delete the X field for me", "go ahead and merge…"), or an EXECUTION ask ("run the X flow against test data for me", "execute the batch job") | `refused-write` intent, a read-only boundary disclosure, and a **`readOnlyAlternative`** — the simulation/read that answers the underlying question safely (`safe_to_delete_field`, `what_if_deactivate_flow`, `what_if_disable_trigger`, `what_if_change_field_type`, `what_if_merge_profiles`, `get_impact`; for execution asks `explain_flow` / `scheduled_job_catalog` / `what_happens_on_save` — by verb family). Offer it. |
| `injection-exfiltration` | Prompt-injection ("ignore your previous instructions…"), record-value exfiltration ("dump all SSN values"), or privilege escalation ("sudo give me full access") | `refused-injection`; `toolCandidates` and `guidance` are suppressed entirely. Do not route around it. |
| `runtime-analytics` | Runtime/ops telemetry no tool models: per-user login events/sessions, adoption metrics, "errors this week", automation execution traces & aggregate run counts, run/failure forensics, CPU/heap profiling, debug-log retrieval, SOQL execution plans, message delivery counts & sent-message content, site click analytics, record-level before/after field history, record-access audit events ("who accessed…") | `honest-gap-runtime` with an HONEST GAP disclosure naming the nearest real reads (e.g. `live_inactive_users` covers dormancy thresholds, not login events; `live_automation_fired` infers per-record, not aggregate run counts). |
| `out-of-scope` | Non-Salesforce asks (other systems, "email me…", write-me-code) | `out-of-scope` disclosure. |

Evaluation order is first-hit-wins: injection → write → runtime → out-of-scope
("ignore the read-only restriction and create…" must land injection, not
write). Legitimate reads are explicit excluders and route normally: "am I
allowed to edit…", "who can delete…", "is it safe to…", "what would happen
if…" are permission/hypothetical *questions*, not imperatives.

Measured on a 2,000-question real-org evaluation: genuine over-confident
routes fell 69 → 11 with zero answerable questions falsely refused.

---

## 9. Clarifications — a last resort

`executionBlocked: true` + `route.clarification` fires only for **genuine**
ambiguity. Before blocking, the router auto-resolves everything the question
itself already answers:

- an object word next to a same-named field ("…saving a **Case** without a
  `Resolution_Code__c`") scopes the field to that object;
- a type word after a name ("the X **object**/**flow**") picks that type;
- an underscored/dotted literal API name is taken at face value;
- a `CustomTab` twin of a `CustomObject` never counts as a rival;
- complementary readings (who-can-access grantors vs the CRUD matrix; impact
  readout vs change simulation) **stack their tools in one route** instead of
  asking which-first;
- a vault-vs-live near-tie is decided by the question's own runtime-data
  language (live leads, with the consent disclosure) — only the
  destructive-vs-read-only tie still blocks;
- offered options are **hygienic**: fuzzy acronym-graze rivals and
  far-below-top junk never appear.

To resume: call again with the same question plus
`clarificationResponse: { clarificationId, selection }` where `selection` is
one of the offered options **verbatim**. Stale ids and invented selections
are rejected.

**Host note — the stacked `resolve` step.** Some routes prepend `sfi.resolve`
to the tool list instead of blocking (e.g. two fuzzy same-meaning fields that
are not literal same-name twins). Run that resolve step and honor its
`ambiguous` disposition (ask the user to pick from its candidates) rather
than skipping ahead to the analysis tool with a guessed id.

---

## 10. Premise checks

A question that names a component the resolver cannot find — disposition
`none`, or a literal API reference none of the fuzzy candidates actually
match — is **still routed** (the routed tools fail closed on the unknown id),
but confidence is downgraded and `entityEvidence.warning` carries a premise
disclosure ("no component matching '<name>' exists in the vault — verify the
name"). Render the warning before any answer. A failed premise never earns a
funnel-advisory upgrade (§5) or a context continuation (§11).

---

## 11. Conversation context (`context.previous`)

The server stores **no conversation state**. The host may pass, per call, an
optional description of the previous turn:

```jsonc
{
  "question": "does it fire on delete too?",
  "context": {
    "previous": {
      "question": "what does the Case escalation flow do?",   // prior user question
      "tool": "sfi.explain_flow",                             // first non-resolve tool you ran
      "componentId": "Flow:Case_Escalation_Flow",             // exact id from entityEvidence
      "objectApiName": "Case",                                // from suggestedArgs, if any
      "intent": "flow-explain",                               // optional
      "plane": "vault",                                       // optional
      "clarification": { "clarificationId": "…", "options": ["…"] } // only if the prior turn blocked
    }
  }
}
```

**Build it from the previous response, never from memory:** `tool` = the
first non-`resolve` entry of the prior `route.tools`; `componentId` = the
prior `entityEvidence` exact-disposition id; `objectApiName` = the prior
`suggestedArgs`; `clarification.clarificationId` / `clarification.options` =
the prior `route.clarification`'s `id` and `options` verbatim. Never invent
ids.

With context, terse follow-ups resolve four ways — each disclosed in
`route.contextApplied = { kind, anaphor, … }` when (and only when) context
actually changed the route:

1. **`entity-substitution`** — a pronoun/ellipsis follow-up whose own
   extraction finds no entity substitutes `previous.componentId` as the
   entity. An **exact-id lookup, never fuzzy**.
2. **`continuation`** — still unrouted after substitution, the route inherits
   `previous.tool` as an advisory continuation: confidence **capped at
   `medium`**; plane and `liveRequired` always from the live tool registry
   (never trusted from `previous.plane`); the resolved type still gates the
   inherited tool (a type-incompatible inheritance is swapped or dropped, not
   routed into a guaranteed error).
3. **`reparameterization`** — "what about on Contact?" re-runs
   `previous.tool` against the new target from the question itself. An
   ambiguous new entity still blocks with a clarification.
4. **`clarification-selection`** — "the second one" / "the Contact one"
   against `previous.clarification` re-dispatches through the normal
   clarification contract: the result is identical to a manual
   `clarificationResponse` call; out-of-range ordinals and 0-or-many
   descriptor matches re-ask; stale ids are rejected as usual.

Honesty under context:

- Refusal gates run on the raw question **before** any context logic —
  context never bypasses them and adds no executable path to a refused turn.
- **Gap detection precedes continuation**: a follow-up that is itself
  gap-shaped — a normative judgment ("should they be able to?", "is it
  normal?"), a delivery/export ask ("can I get it as a file?"), a probe of
  the product's own capabilities ("does the tool trace…?"), or
  deployment-status telemetry ("is it still pending?") — never inherits
  `previous.tool`. It returns a non-executable `context-gap-followup` route
  (`tools: []`, `gap` set) with an honest disclosure instead of an advisory
  continuation that cannot answer the ask.
- A carried `componentId` that no longer resolves gets a context-specific
  premise disclosure and never advisory-routes.
- Value validation is **fail-open**: an unregistered `tool` or malformed
  `componentId` is skipped and noted in `contextApplied.ignored` — never a
  hard error (shape errors still reject; unknown subfields are rejected by
  the strict schema).
- A **self-contained question ignores context** — no anaphor, or a confident
  own route, returns a response identical to the no-context call. Omitting
  `context` keeps behavior identical to previous releases.

Measured on the 2,000-question real-org evaluation's follow-up replay
(60 previously-failing follow-up turns, context built by a host exactly as
above): 66.7% routed executable with context vs 21.7% without; 41 of 41
self-contained follow-ups returned deep-equal output with context present
vs absent.

---

## 12. Modes and knobs

| Knob | Kind | Effect |
| --- | --- | --- |
| `SFI_ROUTER_MODE=offline` | env | Deterministic route is authoritative; candidates omitted. Default (unset / anything else): hybrid. |
| `mode: 'ask' \| 'plan' \| 'assessment'` | call param | Reranks candidates toward that family (`plan` → what_if/impact, `assessment` → risk/readiness/coverage) and tailors guidance. |
| `logGap: true` | call param | Opt-in: append an unanswerable question to the local gap log (`~/.sf-intelligence/question-gaps.jsonl`). Off by default; nothing leaves the machine either way. |
| `FUNNEL_PRIMARY_MIN_SCORE` (0.26), `EXPANSION_WEIGHT` (0.5) | source constants | The funnel-advisory score floor and the weighted-synonym-expansion weight. **Not env vars** — calibrated against the evaluation set; changing them re-opens the honesty gates. |

Additionally, and default-OFF: `SFI_EMBEDDINGS=1` and `SFI_STATIC_EMBED=1` (§4),
and `SFI_TOOL_PROFILE=full` to advertise the whole roster instead of the core
spine (§7).

---

## 13. Measured behaviour

Three harnesses, three different questions. **Always state which, and always
state K** — the same stack reads as 98.8% or 60% depending on both.

| Harness | Corpus | What it grades |
| --- | --- | --- |
| `router-goldset.mjs` | 328 labelled questions | full pipeline **top-1**, strict |
| `router-recall.mjs` | same 328 | raw funnel **recall@K** |
| `funnel-generalization.mjs` | 1,000 template-generated FRESH questions | raw funnel **recall@K** |

Current numbers:

| Measurement | @1 | @3 | @8 |
| --- | --- | --- | --- |
| Raw funnel, tuned goldset (328) | 60.1% | 83.8% | 94.5% |
| Raw funnel, fresh generalization (1000) | 60.9% | 80.4% | 89.4% |
| Raw funnel, hand-written domain questions (30) | 56.7% | 83.3% | 96.7% |
| **Full pipeline, tuned goldset (328)** | **98.8%** | — | — |
| **Full pipeline, fresh questions (300)** | **60.0%** | 82.7% | 92.0% |

### The two numbers you must not confuse

**`router-goldset` 98.8% is tuning, not accuracy.** It grades the full pipeline
on the set the 236 intents were fitted to. On fresh questions the same pipeline
scores **60.0%** — a **38.8-point generalization gap**. Never quote the goldset
top-1 as the product's routing accuracy. BUILD-CONTRACT already says it: recall
is the **authority**, the goldset is a **tripwire**, and nothing is ever tuned on
the tripwire.

### What the deterministic layer actually contributes

Measured on the same 300 fresh questions, raw funnel versus full pipeline:

| | raw funnel | + deterministic layer |
| --- | --- | --- |
| top-1 | 183 (61.0%) | 180 (60.0%) |
| top-3 | 242 (80.7%) | 248 (82.7%) |
| top-8 | 269 (89.7%) | 276 (92.0%) |

The regex layer fires on **96/300 (32%)** of fresh questions and is correct on
**81 of those 96 (84%)** — yet nets **−3 at top-1** while adding **+7 at top-8**.
Where it is right the funnel usually had it right already; where it is wrong it
displaces a correct funnel top-1. **It earns its keep as a shortlist
contributor, not as a decider.**

### Per-tool reachability

Querying each tool by its own first utterance: rank-1 **74.9%**, top-8 **96.6%**
(207 tools with utterances). Four tools carry no utterances at all — three of
those are deliberately retired and say so in their own descriptions
(`release_readiness_report`, `find_apex_usages`, `churn`), and routing to a
retired tool would be the defect, not the fix.

### Honest limits of these numbers

- The 1,000-question corpus is **template-generated** from fixed object / field /
  profile vocabulary. It proves generalization beyond the goldset; it does not
  prove anything about real user phrasing.
- Recall@8 around 90% and recall@1 around 60% describe the same system. Quoting
  either without K is misleading.
- A grade is against a labelled `expectedTool`. Where a shortlist contains a
  *better* tool than the label, the harness scores it wrong.

---

## 14. What routing does NOT do

The list people most often assume wrongly:

- **It never answers, and never runs a tool.** `route_question` returns a
  shortlist and a hint. Nothing executes until the host executes it.
- **It does not resolve the components a question names.** A question naming a
  flow yields `sfi.explain_flow`, not that tool with its `flowId` filled in. The
  host resolves (`sfi.resolve`) and supplies args. Some routes carry
  `suggestedArgs`; most do not.
- **It does not guarantee rank-1.** Around 60% on fresh questions. Treat the
  shortlist as a shortlist.
- **It does not use embeddings, semantic similarity, or any model.** It is
  lexical TF-IDF. Two words meaning the same thing with no shared token do not
  match unless a phrase synonym, a `TOOL_KEYWORDS` entry, or an utterance
  bridges them. "Change data capture" versus "field history tracking" is the
  standing example, and it is unfixed.
- **It does not learn.** No feedback loop, no usage weighting, no per-org
  adaptation. Identical input, identical output, forever.
- **It does not know your vault.** Ranking is vault-independent — the same
  shortlist for an empty org and a huge one. Only premise checks (§10) consult
  the vault.
- **A refusal is not a judgement about answerability.** Gates fire on the SHAPE
  of the request (write imperative, injection, runtime telemetry, out of scope),
  before any matching.
- **`confidence: 'high'` is not a score.** It describes how the route was
  derived (§6).
- **It cannot rescue a tool that answers wrongly.** Perfect routing to a tool
  that reports "clean" because it never scanned anything still produces a wrong
  answer. Routing quality and answer quality are independent axes, and only one
  of them is this document's subject.

---

## 15. Changing routing safely

**Definition of done for a new tool.** A gold row plus funnel reachability are
part of the component, not follow-up work. A tool nothing can route to does not
exist. A missing gold row is a TEST bug: backfill additively, never re-map an
existing row to make a change look clean.

**Which number to move.** Report **@1 and @8**. Recall@8 is already around 90%;
a change that lifts @8 while flattening @1 has helped nobody.

**The harness hierarchy.** `funnel-generalization` (1,000 fresh) is the
authority. `router-recall` is the reachability floor. `router-goldset` is a
tripwire. Never tune on the tripwire.

**Sample size.** A hand-written sample will confirm whatever you expect. The
stemmer change measured +10 at rank-1 on 30 questions and −23 on 1,000. Nothing
ships on a sample.

**Corpus edits shift every term's IDF.** Adding utterances to one tool changes
scores for tools you did not touch. Two shipped regressions came from exactly
this. If a disclosure must appear on several tools, route it through
`corpus-boilerplate.ts` rather than pasting it into several descriptions.

**Adding utterances is not free.** A wrapper tool given utterances that duplicate
its own dependency's mostly steals routing from the dependency. Check what
already covers the phrasing before adding.

**Two fixes already measured and refused** — do not re-attempt without new
evidence: enabling the embeddings (§4), and correcting the plural stemmer (§3).

---

Related: [architecture.md](./architecture.md) (data flow),
[configuration.md](./configuration.md) (env vars),
[guides/asking-questions.md](./guides/asking-questions.md) (end-user view).
