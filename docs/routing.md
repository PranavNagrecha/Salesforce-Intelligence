# Routing — the host contract

How `sfi.route_question` behaves and how a host application (an LLM agent, an
MCP client, a no-LLM pipeline) should consume it. This is the developer-facing
reference for the router's **advisory semantics**: the funnel advises, the
host decides, and every path that cannot be grounded fails closed.

Audience: people wiring sf-intelligence into a host. For what end users can
ask, see [guides/asking-questions.md](./guides/asking-questions.md); for env
vars, [configuration.md](./configuration.md).

---

## 1. Advisory semantics — who decides what

`sfi.route_question` never answers a question and never runs a tool. It
returns, for one plain-language question:

| Field | Authority | What it is |
| --- | --- | --- |
| `toolCandidates` | **Primary** | Meaning-ranked shortlist of `sfi.*` tools (offline TF-IDF over the tool catalog — no network, no embeddings service). Each row carries the tool, its plane, whether it needs the live org, a confidence band, and `cosine` — the raw pre-fusion semantic score (`0` for rows inserted purely from a regex route hint), so you can tell real semantic support from rule assertion. |
| `route` | **Advisory hint** | The deterministic route: an intent, ordered `route.tools` (with step ids and `dependsOn` edges for compound questions), plane, confidence, `suggestedArgs`, disclosures. A suggestion to inform your pick — never a command. |
| `guidance` | Informative | One line stating the loop the host owns: read the candidates → resolve any named component → pick/sequence the tool(s) → run them → ground via `sfi.synthesize_answer`. |

**The host LLM decides.** In the default hybrid mode you read the candidates
and the hint, pick, run, and ground. Two things are *not* advisory:

- `executionBlocked: true` — a genuine ambiguity. Stop, ask the user
  `route.clarification.question`, and resume with the exact
  `clarificationId` + an offered selection (§4). Never invent an option.
- `route.refusal` — a refusal shape. `route.tools` is empty by construction;
  there is nothing to run (§3).

**Deterministic mode.** `SFI_ROUTER_MODE=offline` makes the deterministic
route authoritative and omits candidates — for CI and hosts with no LLM in
the loop. Refusal gates and clarifications behave identically in both modes.

### Confidence semantics

`route.confidence` is `high` / `medium` / `low` and encodes *how* the route
was derived, not merely how well it scored:

- `high` / `medium` — a deterministic intent matched (regex/plan vocabulary),
  possibly downgraded by a premise warning (§5).
- `low` — advisory by construction. A **`funnel-advisory`** route is always
  `low`; treat it as the funnel's pick to verify, never a command.
- A **context continuation** (§6) is capped at `medium`, never `high`.
- A **refusal** (§3) reports `high` — confidence in the refusal itself, not in
  any tool; `route.tools` is empty regardless.

## 2. Funnel-primary (`funnel-advisory`) routes

When **no deterministic intent matches**, the router does not simply give up.
If nothing else stopped the route — no pending clarification, and a clean
premise (a question naming a component the resolver cannot find gets the
premise disclosure instead, never an advisory route) — and the semantic
funnel's top candidate scores at or above a fixed floor
(`FUNNEL_PRIMARY_MIN_SCORE = 0.30`, a source constant, not an env var; the
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

## 3. Refusal gates — fail closed by shape

Score-independent detectors run on the **raw question before any intent
matching**, in both router modes. A hit produces a non-executable route:
`tools: []`, `executionBlocked: false` (there is nothing to clarify), and a
structured `route.refusal = { kind, disclosure, readOnlyAlternative? }`.

| `kind` | Trigger | What the host gets |
| --- | --- | --- |
| `write-imperative` | A mutation asked *of the agent* ("delete the X field for me", "go ahead and merge…") | `refused-write` intent, a read-only boundary disclosure, and a **`readOnlyAlternative`** — the simulation that answers the underlying question safely (`safe_to_delete_field`, `what_if_deactivate_flow`, `what_if_disable_trigger`, `what_if_change_field_type`, `what_if_merge_profiles`, `get_impact` — by verb family). Offer it. |
| `injection-exfiltration` | Prompt-injection ("ignore your previous instructions…") or record-value exfiltration ("dump all SSN values") | `refused-injection`; `toolCandidates` and `guidance` are suppressed entirely. Do not route around it. |
| `runtime-analytics` | Runtime/ops telemetry no tool models (login history, adoption metrics, "errors this week") | `honest-gap-runtime` with an HONEST GAP disclosure naming the nearest real reads. |
| `out-of-scope` | Non-Salesforce asks (other systems, "email me…", write-me-code) | `out-of-scope` disclosure. |

Evaluation order is first-hit-wins: injection → write → runtime → out-of-scope
("ignore the read-only restriction and create…" must land injection, not
write). Legitimate reads are explicit excluders and route normally: "am I
allowed to edit…", "who can delete…", "is it safe to…", "what would happen
if…" are permission/hypothetical *questions*, not imperatives.

Measured on a 2,000-question real-org evaluation: genuine over-confident
routes fell 69 → 11 with zero answerable questions falsely refused.

## 4. Clarifications — a last resort

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

## 5. Premise checks

A question that names a component the resolver cannot find — disposition
`none`, or a literal API reference none of the fuzzy candidates actually
match — is **still routed** (the routed tools fail closed on the unknown id),
but confidence is downgraded and `entityEvidence.warning` carries a premise
disclosure ("no component matching '<name>' exists in the vault — verify the
name"). Render the warning before any answer. A failed premise never earns a
funnel-advisory upgrade (§2) or a context continuation (§6).

## 6. Conversation context (`context.previous`)

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

## 7. Modes and knobs

| Knob | Kind | Effect |
| --- | --- | --- |
| `SFI_ROUTER_MODE=offline` | env | Deterministic route is authoritative; candidates omitted. Default (unset / anything else): hybrid. |
| `mode: 'ask' \| 'plan' \| 'assessment'` | call param | Reranks candidates toward that family (`plan` → what_if/impact, `assessment` → risk/readiness/coverage) and tailors guidance. |
| `logGap: true` | call param | Opt-in: append an unanswerable question to the local gap log (`~/.sf-intelligence/question-gaps.jsonl`). Off by default; nothing leaves the machine either way. |
| `FUNNEL_PRIMARY_MIN_SCORE` (0.30), `EXPANSION_WEIGHT` (0.5) | source constants | The funnel-advisory score floor and the weighted-synonym-expansion weight. **Not env vars** — calibrated against the evaluation set; changing them re-opens the honesty gates. |

## 8. Measured behavior (2,000-question real-org evaluation)

All numbers below were measured on a 2,000-question evaluation against a
real production-scale org vault (plus a separate 500-question routing sweep),
comparing this router to the 0.1.21 baseline:

| Metric | Baseline | Now |
| --- | --- | --- |
| Genuine over-confident routes on honesty-labeled questions | 69 | 11 (zero false refusals of answerable questions) |
| Blocked-by-clarification misses (of 115 labeled) | 115 | 11 (all 11 genuine ambiguities) |
| Misses whose correct tool was already a candidate, now routed clean to it | 0 / 271 | 85 / 271 |
| Correct tool present in the candidate shortlist on funnel-blind misses (recall@8) | 0 / 255 | 146 / 255 (57.3%) |
| Live-plane questions whose route reaches a live tool | 92 / 161 | 125 / 161 |
| 500-question sweep: clean routes / blocked | 387 / 33 | 414 / 8 |
| Previously-failing follow-ups routing executable (with host-passed context) | 21.7% | 66.7% |

These are routing-surface metrics (does the right tool get reached, does an
unanswerable question get refused), not end-answer grades.

---

Related: [architecture.md](./architecture.md) (data flow),
[configuration.md](./configuration.md) (env vars),
[guides/asking-questions.md](./guides/asking-questions.md) (end-user view).
