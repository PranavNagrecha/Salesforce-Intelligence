# Routing — how a question reaches a tool

This product registers 231 tools, 226 of which are advertised under
`SFI_TOOL_PROFILE=full`. Routing is the machinery that turns one plain-language
question into a choice among them. It is the difference between a capability
existing and a capability being usable, which is why this document is long: it
covers how each stage works, **and what each stage does not do**.

Audience: people wiring sf-intelligence into a host, and anyone changing the
funnel. For what end users can ask see
[guides/asking-questions.md](./guides/asking-questions.md); for env vars,
[configuration.md](./configuration.md).

The one-paragraph version: **the pipeline is good at putting the right tool in
the shortlist (~90%) and no better than a coin flip at putting it first (~60%).**
That is by design — `sfi.route_question` advises and the host LLM decides — and
every number in §12 is a variation on it. Under the default `core` profile
`sfi.route_question` is not advertised; a host runs it through
`sfi.run_analysis { name: 'sfi.route_question', args: { question } }` (§6).

**0.8.0 removed the regex intent router.** Until 0.7.x a 7,850-line table of
hand-written intents sat beside the funnel and emitted a deterministic `route`
(an `intent`, ordered `tools`, a `plan`, a `confidence`) that the shortlist was
fused with. Measured on fresh questions it displaced correct funnel picks more
often than it added them (§12), and `SFI_ROUTER_MODE=offline` let a host make it
authoritative. Both are gone. The response has no `route` object; what follows
describes what remains.

---

## 1. The pipeline at a glance

| # | Stage | Where | What it can do | What it cannot |
| --- | --- | --- | --- | --- |
| 0 | Normalise | `semantic-funnel.ts` `tokenize()` | lowercase, strip punctuation, drop stopwords, light plural stem, phrase-synonym expansion **on the query only** | no lemmatiser, no spell-correction, no learned synonyms |
| 1 | Refusal gates | `refusal-gates.ts` | fail closed by SHAPE before any matching — **7 kinds**, first-hit-wins | cannot judge whether an allowed question is answerable |
| 2 | Lexical funnel | `semantic-funnel.ts` | L2-normalised TF-IDF cosine over a per-tool document | no embeddings in any shipped install (§3) |
| 3 | Shortlist assembly | `tools/route-question.ts` | resolve the named component against the vault and bind it into each candidate's args, drop type-incompatible tools, de-crowd, mode-rerank, break a plane tie, stop on a simulation-vs-readout tie the question does not settle, attach `answers`, score the evidence bar | never runs a tool |
| 4 | Host decision | your LLM | pick, supply args, run, ground | — |

Stages 1-3 are deterministic and offline. No network, no model, no learned state.
The same question against the same vault always produces the same response.

---

## 2. Advisory semantics — who decides what

`sfi.route_question` never answers a question and never runs a tool. It
returns, for one plain-language question:

| Field | Authority | What it is |
| --- | --- | --- |
| `toolCandidates` | **Primary** | Meaning-ranked shortlist of `sfi.*` tools (offline TF-IDF over the tool catalog). Each row carries the tool, **`answers`** (its one-line summary) and **`category`**, its `plane` and `liveRequired`, the funnel's `confidence` band, `score`, and — when the question named a component the vault contains — **`suggestedArgs`** (that component bound under the tool's own arg key) or **`missingArgs`** (required args still unbound). |
| `guidance` | Informative | One line stating the loop the host owns: read the candidates → resolve any named component → pick/sequence the tool(s) → run them → ground the answer in the ids they return. Carries the live-plane consent disclosure when a leading candidate is `liveRequired`, and the `gap` note when there is one. |
| `entityEvidence` | Informative | What the resolver found for the component the question named (§8). |
| `gap` | Informative | Non-null when the shortlist is a guess (§4) or the ask was refused. |
| `contextApplied` | Informative | What host-passed context changed (§10). |

`answers` exists because the default tool profile is `core`, which advertises 16
of 226 tools. For every other candidate the shortlist would otherwise name a tool
whose description is nowhere in your context, recoverable only by an
`sfi.describe_analysis` round trip per candidate. The one-liner is the same text
`sfi.list_analyses` renders, so you can pick without a second call — and, just as
usefully, recognise a shortlist that contains no right answer. It does not affect
ranking.

**The host LLM decides.** You read the candidates, pick, run, and ground. Two
things are *not* advisory:

- `executionBlocked: true` — a genuine ambiguity. Stop, ask the user
  `clarification.question`, and resume with the exact `clarificationId` + an
  offered selection (§7). Never invent an option.
- `refusal` — a refusal shape. There is nothing to run (§6); candidates, when
  listed, are transparency only.

`confidence` on a row is the funnel's calibrated band for the shortlist as a
whole (margin + coverage led, not raw score): `low` is the honest gap signal, not
a truncation. A row inserted for a stated reason without funnel evidence — a tool
inherited from host-passed context, a method tool bound from a `Class.method`
reference — carries `cosine: 0`.

---

## 3. What the funnel indexes

Each tool gets ONE document, assembled in `buildToolDocs()`
(`semantic-funnel.ts`). Knowing what goes in is the whole game, because the only
way to make a tool findable is to change this document:

| Source | Notes |
| --- | --- |
| tool **name** words | `sfi.find_dead_code` becomes `find dead code` |
| `TOOL_KEYWORDS` | curated per-tool overlay for tools whose prose does not echo how people ask |
| `FUNNEL_UTTERANCES` | **the curated ask-phrasings across 226 tools** (several per tool) — the primary lever |
| `tool.description` | the host-facing contract, **boilerplate-stripped** first |
| capability map | `tools/capabilities.ts` CATEGORIES title / description / examples |
| `INTERPRET_CONCEPT_CARDS` | 48 cards giving `sfi.interpret` per-concept documents |

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
the query *and* the corpus, so the two still collide, and the utterance corpus
was tuned against exactly that behaviour. A correct rule-based stemmer was
implemented and measured: **+10 points at rank-1 on a 30-question sample, −23 on
the 1,000-question authority set.** It was reverted. Changing tokenisation
invalidates the tuning built on top of it; treat it as a corpus-wide migration,
never a one-line fix.

### How a score is produced

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

Regenerating the static assets and enabling the gate was re-measured for this
document: **recall identical at every K**. Every tool vector lands inside a
**0.51-0.56** cosine band — a distilled static model mean-pools its token rows,
so a couple of hundred long, jargon-dense documents collapse to nearly the same
point. The RRF fusion is deliberately asymmetric (`RRF_K_LEX = 10`,
`RRF_K_EMBED = 60`) so the embedding can only promote a lexical near-miss, never
displace a lexical hit — which is why turning it on changes so little.

**Do not treat "enable the embeddings" as an available fix.** The failure to beat
is vector discrimination across long documents.

---

## 4. Gaps — when nothing can be placed

The funnel always returns its best eight when anything matches. The response
carries `gap: { category: 'unrouted', note }` only when nothing can be placed
honestly:

- **empty shortlist** — no word of the question is in the tool catalog
  ("zxqw plkj vbnm");
- **pronoun-led fragment with no host context** — "does it call an invocable
  apex at least?": the pronoun is unresolvable, and a cosine graze would dress
  it up as a route;
- a **gap-shaped follow-up** under host context (§10) gets its own category,
  and a **refusal** (§6) carries the refusal's category.

Thin evidence on a shortlist that does exist is **not** a gap. It is the rows'
own `confidence: 'low'` — the funnel's calibrated band (margin + coverage led),
which fires about twice as often on gap shortlists as on vault shortlists
without truncating either — and the `guidance` repeats it as a LOW CONFIDENCE
note. The former evidence bar (a height/breadth/coverage gate calibrated to
decide whether a regex-unrouted question deserved an advisory upgrade) went with
the regex: applied to every question it flagged short, perfectly clear asks
("what custom objects do we have") as gaps. Its one durable finding stands —
score height alone cannot separate a one-word collision ("the setup here — any
opinions" → `live_setup_audit_trail` at 0.436) from a real question (signal
floor 0.261); only breadth of support does — and a host that wants that
discriminator can compute it from the returned scores.

Host behavior on a gap or a low-confidence shortlist: run nothing whose
`answers` does not fit the question, and say the capability is not built rather
than substituting a lookalike. `logGap: true` appends a gapped question to the
local gap log (`~/.sf-intelligence/question-gaps.jsonl`); off by default, and
nothing leaves the machine either way.

---

## 5. Shortlist assembly

`route-question.ts` refines the raw funnel in this order:

1. **De-crowd** — the two measured slot parasites `what_if_assign_permset` and
   `what_if_revoke_permset` drop below every other row unless the question
   carries a hypothetical marker or their own action verb. Pure reorder.
2. **Mode rerank** — `mode: 'plan'` leads with the what_if/impact family,
   `'assessment'` with the risk/readiness/coverage family.
3. **Plane tie** — a vault-vs-live near-tie (within `MARGIN = 0.05`) is decided
   by the question's own runtime-data language: "how many … right now" leads
   live (with the consent disclosure), anything else leads vault. Never blocks.
4. **Type filter** — when the named component resolved exactly, tools that
   fail closed on that family are dropped (an Apex call graph over a Flow id,
   the field-only access audit over an object).
5. **Simulation tie** — top-1 and top-2 within `MARGIN`, one a change
   simulation with a verdict (`safe_to_delete_field`, `what_if_*`) and one an
   impact/usage readout, and the question does not say which it wants: stop
   with a tool-choice clarification (§7). Every tool is read-only; a
   what-breaks / impact question, or one that names the change ("delete",
   "change", "rename"), never stops.
6. **Binding** — the resolved component goes under each tool's OWN declared arg
   key (`entity-arg-binding.ts` reads the registered schemas: `fieldId`,
   `flowId`, `classApiName`, `objectApiName`, generic `componentId` …); a field
   on an object-only tool binds its parent object; a quoted literal binds a
   required `value`; "to <type>" binds a required enum. Unsure means unbound,
   and `missingArgs` says so.
7. **Hidden tools** never appear; with the live plane off, live-only rows sink
   below every vault row (listed, never hidden — consent can be granted).
8. Every row gets `answers` and a non-null `category`.

Under the core profile the leading three rows also come as `invoke[]` calls:
core tools direct, everything else as the `sfi.run_analysis` envelope.

---

## 6. Tool profiles, and refusal gates

The default tool profile is `core`, which advertises **16 of 226** tools. Every
other analysis is reached through `sfi.run_analysis` with a `name` and `args`,
using `sfi.list_analyses` and `sfi.describe_analysis` as the catalog. §2
explains why every row therefore carries `answers`; measured over 50 questions,
an LLM host's top-1 choice moved **39/50 to 42/50** with it, and none became
wrong.

### Refusal gates — fail closed by shape

Score-independent detectors run on the **raw question before any matching**. A
hit produces a non-executable response: no `invoke`, `executionBlocked: false`
(there is nothing to clarify), a structured `refusal = { kind, disclosure,
readOnlyAlternative? }`, and a `gap` naming the category.

| `kind` | Trigger | What the host gets |
| --- | --- | --- |
| `write-imperative` | A mutation asked *of the agent* ("delete the X field for me", "go ahead and merge…"), or an EXECUTION ask ("run the X flow against test data for me"). A run verb on an analysis NAME — "run automation risk" — is a read and routes normally. | A read-only boundary disclosure and a **`readOnlyAlternative`** — the simulation/read that answers the underlying question safely. Offer it. |
| `injection-exfiltration` | Prompt-injection ("ignore your previous instructions…"), record-value exfiltration ("dump all SSN values"), or privilege escalation | `toolCandidates` and `guidance` are suppressed entirely. Do not route around it. |
| `runtime-analytics` | Runtime/ops telemetry no tool models: per-user login events, adoption metrics, "errors this week", execution traces and run counts, CPU/heap profiling, debug-log retrieval, SOQL execution plans, message delivery counts, site click analytics, record-level before/after history, record-access audit events | An HONEST GAP disclosure naming the nearest real reads. |
| `out-of-scope` | Non-Salesforce asks: other systems, another platform's own data, rating people, purchasing decisions, general knowledge, "email me…", write-me-code | An out-of-scope disclosure. |
| `identity-gap` | who-is / first-person capability asks | the vault models metadata, not people; a which-user clarify pointer |
| `forecast-gap` | an explicit prediction verb, or growth-trend + horizon + forward-outcome together | nothing here predicts; yields to the what-if simulation frame |
| `provenance-gap` | a create / originally-authored verb ("who created this") | authorship is not retrievable; a pure last-modified ask routes to `sfi.last_modified` |

Evaluation order is first-hit-wins: injection → write → runtime → out-of-scope.
Legitimate reads are explicit excluders and route normally: "am I allowed to
edit…", "who can delete…", "is it safe to…", "what would happen if…" are
permission/hypothetical *questions*, not imperatives.

Measured on a 2,000-question real-org evaluation: genuine over-confident
routes fell 69 → 11 with zero answerable questions falsely refused.

---

## 7. Clarifications — a last resort

`executionBlocked: true` + `clarification` fires only for **genuine**
ambiguity. Before blocking, everything the question itself already answers is
auto-resolved:

- an object word next to a same-named field ("…saving a **Case** without a
  `Resolution_Code__c`") scopes the field to that object;
- a type word after a name ("the X **object**/**flow**") picks that type;
- an underscored/dotted literal API name is taken at face value;
- a `CustomTab` twin of a `CustomObject` never counts as a rival;
- a vault-vs-live near-tie is decided by the question's own runtime-data
  language — only a simulation-vs-readout tie the question leaves open still
  blocks;
- a plain English word is never a component name: only an underscored, dotted,
  CamelCase or mid-sentence-capitalised token reaches the fuzzy resolver, so
  "find dead code" cannot be asked to pick between `*_Code__c` fields;
- offered options are **hygienic**: fuzzy acronym-graze rivals and
  far-below-top junk never appear.

Two kinds of option set: component ids (an entity ambiguity — a short field
name on several objects, two Apex classes sharing a bare name, a Flow and a
class both called `DataSync`) and `sfi.*` tool names (the simulation tie, or an
explicit "what breaks AND is it actually running in production" two-plane ask).

To resume: call again with the same question plus
`clarificationResponse: { clarificationId, selection }` where `selection` is
one of the offered options **verbatim**. A component pick is looked up by exact
id and bound into every candidate; a tool pick leads the shortlist and drops its
rival. Stale ids and invented selections are rejected.

---

## 8. Entity evidence and premise checks

The question's component phrase is extracted narrowly (a dotted or suffixed API
name, an underscored token, a quoted or typed name — never the whole sentence)
and resolved against the vault; a two-or-three-word question that names a
component without asking anything ("payment object") is resolved as a whole.
`entityEvidence` reports the query, the type hints the question's words
implied, the disposition and the candidates.

A question that names a component the resolver cannot find — disposition
`none`, or a literal API reference none of the fuzzy candidates actually match —
is **still shortlisted** (the tools fail closed on the unknown id), but nothing
is bound and `entityEvidence.warning` carries a premise disclosure ("no
component matching '<name>' exists in the vault — verify the name"). Render the
warning before any answer. A name the user gave the wrong type ("the X
permission set" that is a validation rule) gets a TYPE CHECK and the real
component. A failed existence probe (graph error) says PREMISE CHECK
INCONCLUSIVE rather than passing silently.

---

## 9. What the funnel indexes is the only lever

There is no intent table to add a phrasing to. To make a tool findable, change
its document (§3): add ask-phrasings to `FUNNEL_UTTERANCES`, a `TOOL_KEYWORDS`
overlay, or the description. Corpus edits shift every term's IDF, so measure
(§12) before and after.

---

## 10. Conversation context (`context.previous`)

The server stores **no conversation state**. The host may pass, per call, an
optional description of the previous turn:

```jsonc
{
  "question": "does it fire on delete too?",
  "context": {
    "previous": {
      "question": "what does the Case escalation flow do?",   // prior user question
      "tool": "sfi.explain_flow",                             // the tool you ran
      "componentId": "Flow:Case_Escalation_Flow",             // exact id from entityEvidence
      "objectApiName": "Case",                                // from suggestedArgs, if any
      "plane": "vault",                                       // optional
      "clarification": { "clarificationId": "…", "options": ["…"] } // only if the prior turn blocked
    }
  }
}
```

**Build it from the previous response, never from memory:** `tool` = the
candidate you ran; `componentId` = the prior `entityEvidence` exact-disposition
id; `objectApiName` = the prior `suggestedArgs`; `clarification.clarificationId`
/ `clarification.options` = the prior `clarification`'s `id` and `options`
verbatim. Never invent ids.

With context, terse follow-ups resolve four ways — each disclosed in
`contextApplied = { kind, anaphor, … }` when (and only when) context actually
changed the response:

1. **`entity-substitution`** — a pronoun/ellipsis follow-up whose own
   extraction finds no entity substitutes `previous.componentId` as the
   entity. An **exact-id lookup, never fuzzy**; it binds into the candidates.
2. **`continuation`** — the follow-up inherits `previous.tool` at the head of
   the shortlist (`confidence: medium` when the entity resolved exact, `low`
   otherwise, `cosine: 0`); plane and `liveRequired` come from the tool
   registry, never from `previous.plane`; a type-incompatible inheritance is
   not made.
3. **`reparameterization`** — "what about on Contact?" re-runs
   `previous.tool` against the new target from the question itself. An
   ambiguous new entity still blocks with a clarification.
4. **`clarification-selection`** — "the second one" / "the Contact one"
   against `previous.clarification` re-dispatches through the normal
   clarification contract: the result is identical to a manual
   `clarificationResponse` call; out-of-range ordinals and 0-or-many
   descriptor matches re-ask; stale ids are rejected as usual.

Honesty under context:

- Refusal gates run on the raw question **before** any context logic.
- **Gap detection precedes continuation**: a follow-up that is itself
  gap-shaped — a normative judgment ("should they be able to?"), a
  delivery/export ask ("can I get it as a file?"), a probe of the product's own
  capabilities, or deployment-status telemetry — never inherits
  `previous.tool`. It returns `gap: { category: 'context-gap-followup' }` with
  an honest disclosure.
- A carried `componentId` that no longer resolves gets a context-specific
  premise disclosure and is never bound.
- Value validation is **fail-open**: an unregistered `tool` or malformed
  `componentId` is skipped and noted in `contextApplied.ignored`.
- A **self-contained question ignores context** — no anaphor returns a response
  identical to the no-context call.

---

## 11. Modes and knobs

| Knob | Kind | Effect |
| --- | --- | --- |
| `mode: 'ask' \| 'plan' \| 'assessment'` | call param | Reranks candidates toward that family and tailors guidance. |
| `logGap: true` | call param | Opt-in: append a gapped question to the local gap log. Off by default; nothing leaves the machine either way. |
| `MARGIN` (0.05), `EXPANSION_WEIGHT` (0.5) | source constants | The near-tie margin and the weighted-synonym-expansion weight. **Not env vars** — calibrated against the evaluation set; changing them re-opens the honesty gates. |

Additionally, and default-OFF: `SFI_EMBEDDINGS=1` and `SFI_STATIC_EMBED=1` (§3),
and `SFI_TOOL_PROFILE=full` to advertise the whole roster instead of the core
spine (§6). There is no router mode.

---

## 12. Measured behaviour

Two numbers describe routing, and they must always be quoted together with
the K they were measured at:

- **Recall@8 around 90%** — on fresh, template-generated questions the right
  tool is in the eight-row shortlist about nine times in ten.
- **Recall@1 around 60%** — the right tool is *first* about six times in ten.

A hand-written sample of a few dozen domain questions lands in the same
place. The two numbers describe the same system at different K; quoting
either without K is misleading.

### Why the regex layer was deleted

Measured on 300 fresh questions before the deletion, raw funnel versus funnel
fused with the deterministic layer:

| | raw funnel | + deterministic layer |
| --- | --- | --- |
| top-1 | 183 (61.0%) | 180 (60.0%) |
| top-3 | 242 (80.7%) | 248 (82.7%) |
| top-8 | 269 (89.7%) | 276 (92.0%) |

The regex layer fired on about a third of fresh questions and was right on most
of those, yet netted **−3 at top-1** while adding **+7 at top-8**: where it was
right the funnel usually had it right already; where it was wrong it displaced a
correct funnel top-1. On the phrasings it was written against it was never
wrong, and on genuinely fresh phrasing it fired on about one question in seven:
a lookup table, not a generaliser. A number measured on those same phrasings is
tuning, not accuracy. The +7 at top-8 is the one thing the deletion gives up;
the funnel's utterance corpus is where that recall is recovered.

### Per-tool reachability

Querying each tool by its own first utterance puts it first about three times
in four and in the top eight nearly always. Five registered tools carry no
utterances, and all five are hidden from `tools/list` on purpose:
`release_readiness_report`, `churn` and `cdc_subscribers` each name their
survivor in their own description (`cdc_subscribers` folded into
`sfi.event_topology`), `find_apex_usages` folded into `sfi.find_code_usages`
with a `nodeTypes` narrow, and `field_cleanup_candidates` folded into
`sfi.unused_fields_deep` (`format: 'cleanup'`). Routing to a retired tool
would be the defect, not the fix.

### Honest limits of these numbers

- **The fresh corpus is template-generated** from a closed vocabulary, and many
  rows are exact duplicates. It proves generalization beyond the tuning set and
  nothing about real user phrasing; deduplicated, recall@8 drops by about five
  points.
- **Grading accepts a tool family, not a tool.** Each row carries a short
  list of acceptable tools; a hit means any of them reached the top-K.
- **Only about a third of the tools are ever accepted anywhere in the
  corpus.** The rest have no generalization coverage, and a measurement cannot
  regress what it never grades.
- **The recall measurements stop at the raw funnel.** The list a host receives
  is built by `buildFunnelCandidates` plus the type filter and binding of §5. A
  change that broke that assembly outright would not move either recall number.
- Where a shortlist contains a *better* tool than the label, it is scored
  wrong.

---

## 13. What routing does NOT do

The list people most often assume wrongly:

- **It never answers, and never runs a tool.** `route_question` returns a
  shortlist. Nothing executes until the host executes it.
- **It does not guarantee rank-1.** Around 60% on fresh questions. Treat the
  shortlist as a shortlist.
- **It does not use embeddings, semantic similarity, or any model.** It is
  lexical TF-IDF. Two words meaning the same thing with no shared token do not
  match unless a phrase synonym, a `TOOL_KEYWORDS` entry, or an utterance
  bridges them. "Change data capture" versus "field history tracking" is the
  standing example, and it is unfixed.
- **It does not learn.** No feedback loop, no usage weighting, no per-org
  adaptation. Identical input, identical output, forever.
- **Ranking does not know your vault.** The order is vault-independent — the
  same shortlist for an empty org and a huge one. Only entity resolution and
  premise checks (§8) consult the vault, and they change args and warnings, not
  rank (except to drop a type-incompatible tool).
- **A refusal is not a judgement about answerability.** Gates fire on the SHAPE
  of the request, before any matching.
- **The refusal gates can refuse a question the product has a tool for.** They
  run on the raw string BEFORE any matching. Reproduced: `build me a timeline
  from this Apex debug log` — the funnel ranks `sfi.trace_debug_log` at
  **0.503**, while `detectRefusalShape` classifies the same string
  `write-imperative`. The verb, not the subject, is what the gate reads.
- **A dozen of the product's own funnel utterances are gated by its own refusal
  detectors** (11 `write-imperative`, 1 `out-of-scope`), so a user who asks
  exactly the way the product advertises is refused. Reproduce with
  `detectRefusalShape` over `FUNNEL_UTTERANCES`. **A new tool's utterances
  should be run through the refusal gates as part of adding them.**
- **It cannot rescue a tool that answers wrongly.** Perfect routing to a tool
  that reports "clean" because it never scanned anything still produces a wrong
  answer. Routing quality and answer quality are independent axes.

---

## 14. Changing routing safely

**Definition of done for a new tool.** Ask-phrasings (`FUNNEL_UTTERANCES`) and
a reachability check are part of the component, not follow-up work. A tool
nothing can route to does not exist. Run the new phrasings through the refusal
gates too (§13).

**Which number to move.** Report **@1 and @8**. Recall@8 is already around
90%; a change that lifts @8 while flattening @1 has helped nobody.

**Sample size.** A hand-written sample will confirm whatever you expect. The
stemmer change measured +10 at rank-1 on 30 questions and −23 on 1,000. Nothing
ships on a sample.

**Corpus edits shift every term's IDF.** Adding utterances to one tool changes
scores for tools you did not touch. Two shipped regressions came from exactly
this. If a disclosure must appear on several tools, route it through
`corpus-boilerplate.ts` rather than pasting it into several descriptions.

**Adding utterances is not free.** A wrapper tool given utterances that
duplicate its own dependency's mostly steals routing from the dependency.
Check what already covers the phrasing before adding.

**Never add regex routing.** The deleted router is the measured proof that a
hand-written phrasing table scores well on itself and nowhere else. Fix a
misroute in the tool's description, utterances or arg aliases, and measure.

**Routing quality is not defended by the public CI.** GitHub CI runs
`pnpm eval:routing-gate`, a tripwire (every battery question gets a
deterministic, non-empty shortlist of advertised tools). The recall measurements
above are run by hand before a release. Treat a green CI badge as saying nothing
about routing.

**Two fixes already measured and refused** — do not re-attempt without new
evidence: enabling the embeddings (§3), and correcting the plural stemmer (§3).

---

Related: [architecture.md](./architecture.md) (data flow),
[configuration.md](./configuration.md) (env vars),
[guides/asking-questions.md](./guides/asking-questions.md) (end-user view).
