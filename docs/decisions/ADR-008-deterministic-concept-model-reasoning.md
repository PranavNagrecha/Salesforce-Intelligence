# ADR-008: Deterministic concept-model reasoning (`sfi.interpret`)

## Status
Accepted

## Date
2026-07-18

## Context
The product retrieves org metadata well: it can tell you a field's master-detail
parent, which flows fire on an object, or which classes carry an
`@AuraEnabled` annotation. What it could not do — without a host LLM improvising
from training data — is state what those structures **imply**: that deleting the
master-detail parent cascade-deletes its children, that two active before-save
flows on one object run in an **undefined order**, or that an `@AuraEnabled`
method is an entry point where Apex does not auto-enforce field-level security.

Those implications are *general Salesforce truth*, not org-specific facts. The
temptation is to let the host LLM supply them, but that reintroduces exactly the
failure this product exists to avoid: a confident, uncited, unverifiable claim
about a production org. The implications need to be **grounded in the org's real
structure** and **cited**, and they need to be **deterministic** — the same vault
must always yield the same claim — so a reviewer can audit them.

## Decision
Ship a curated, org-independent **Concept Model** and a deterministic engine that
**joins** it against the org vault, surfaced as the `sfi.interpret` MCP tool and
folded into `sfi.synthesize_answer`.

1. **Two graphs, one join.** The org vault graph (grounded, org-specific) stays
   as-is. A second graph — the Concept Model — holds **94** org-independent
   concepts and **143** rules of general Salesforce truth (save-order phases,
   relationship semantics, sharing posture, code-shape signals). It carries **no
   org data**: no canonical ids, no counts. The model lives in curator-owned YAML
   (`packages/mcp/model/concepts.yaml`, `concept-rules.yaml`) compiled to a frozen
   TypeScript artifact; the org enters reasoning *only* through the grounded slice
   passed to the engine at query time.

2. **`sfi.interpret` is the join.** Given one component id, the tool assembles a
   minimal graph slice around it (the bound-edge types the selected rules need,
   plus their endpoint nodes), runs each applicable `ConceptRule` through the pure
   engine, and returns the interpretations **verbatim** — claims are never
   reshaped by the tool. It is offline and read-only: `provenance` is hardwired
   `offline_snapshot`, and the disclosure states plainly that this is
   deterministic reasoning over the vault snapshot — **not an LLM inference and
   not a live org read**.

3. **Reasoning reaches the answer.** `sfi.synthesize_answer` folds interpret's
   cited claims into a normal answer, hedged and attributed, so reasoning is
   delivered through the standard route on any MCP host — not only via the
   standalone tool.

### Two confidence axes (the key disambiguation)

[ADR-001](./ADR-001-confidence-tagged-edges.md) established **edge confidence** —
every relationship carries `declared | parsed | heuristic`, grading how *that one
relationship* was derived. This ADR adds a **second, distinct axis**:

- **Edge confidence** grades a single *relationship* (ADR-001).
- **Claim confidence** grades a *reasoning claim* that rests on one or more
  edges. It reuses the same three words, but it is **computed, never asserted**:
  a claim's confidence is the *weakest* of the concept rule's own ceiling and
  every grounding edge the claim matched.

The consequence is a hard floor and ceiling: **claim confidence can never exceed
edge confidence.** ADR-001's edge tier is the floor for every claim built on that
edge — a claim grounded on a `heuristic` edge is at best `heuristic`, whatever the
rule would otherwise allow. An absence-shaped claim under non-complete coverage
reads `unknown`. Renderers and hosts MUST NOT present claim confidence as if it
were the edge confidence of a single relationship; the two axes are reported
separately and mean different things.

### Honesty rules (non-negotiable, engine-enforced)

- **No citation, no claim.** Every `Interpretation` carries a `groundedIn` list
  of the exact component ids it matched. The engine drops any matched endpoint
  whose node is absent from the slice, so a claim that cannot cite its ground is
  never emitted.
- **Honest-empty.** An empty interpretation list means "no concept rule fired for
  this component" — **never** "nothing depends on it." The tool discloses this
  explicitly and `synthesize_answer` carries the same non-absence framing.
- **Coverage caveat.** Each rule declares the metadata families it depends on;
  when those aren't fully covered, the interpretation carries a `coverageCaveat`
  and an absence-shaped claim degrades to `unknown` rather than asserting "none".
- **Slice truncation caps completeness.** A hub whose bound-edge count exceeds the
  slice cap is marked truncated, which forces coverage to at most `partial` — an
  absence rule can never read `complete` over a clipped slice.
- **Static shape, not proof.** Governor and security concepts name a code or
  metadata *shape* (a cascade, an undefined order, an unenforced surface). They do
  **not** assert a proven runtime limit breach or a proven vulnerability, and the
  concept summaries state their own boundaries explicitly.

Input scoping for `interpret` and its sibling tools follows the selector-scope
honesty contract in [ADR-009](./ADR-009-selector-scope-honesty.md): a natural
selector resolves to an echoed `appliedScope`, and a disagreeing or unresolvable
selector is refused with a named `invalid-query` rather than a silent org-wide
answer.

## Alternatives Considered

### Let the host LLM supply the implications
- Pros: no model to curate; infinite coverage.
- Cons: uncited, non-deterministic, and exactly the "confidently wrong about a
  production org" failure ADR-001 exists to prevent. The LLM cannot be audited or
  regression-tested. Rejected — the whole value is grounded, cited, replayable
  reasoning.

### Hard-code each implication inside the tool that needs it
- Pros: no new abstraction.
- Cons: the same general truth (save-order phases, master-detail semantics) was
  already drifting across several hand-coded tool call sites. A curated model
  unifies them behind one engine with one honesty contract. Rejected — the
  invariant belongs in shared, versioned data, not scattered call sites.

### Bake org specifics into the concept rules
- Pros: fewer moving parts at query time.
- Cons: destroys the org-independence that makes the model portable and
  auditable, and reintroduces org data into a tracked artifact (a leak surface).
  Rejected — the org enters *only* through the grounded slice.

## Consequences
- A new reasoning capability is a **data** change (a concept + rule in YAML)
  reviewed against the same no-org-data rule, not a new bespoke tool.
- Claim confidence is a first-class, computed property bounded below by ADR-001's
  edge tiers; documentation and UIs must keep the two axes distinct.
- Because the model is org-independent and frozen, `sfi.interpret` is
  deterministic against a given vault state — the same slice always yields the
  same cited claims, so reasoning is regression-testable like any other tool.
- Absence and coverage honesty extend to reasoning: an empty or truncated result
  is disclosed as "not checked / no rule fired", never as proof of absence.
