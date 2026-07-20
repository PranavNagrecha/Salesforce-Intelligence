# ADR-009: Selector-scope honesty (`appliedScope` / `invalid-query`)

## Status
Accepted

## Date
2026-07-18

## Context
Analysis tools grew a scope parameter tool-by-tool so an answer could be
narrowed to one component, object, profile, or namespace instead of scanning the
whole org. Two failure modes showed up on real usage:

1. **Rigid inputs.** A host asking "what's the CRUD/FLS on the Salary field for
   the Sales profile?" holds an object name, a field label, and a profile name —
   not the canonical ids the tool declared. When a tool accepted only a
   `componentId`, the host had to pre-resolve every argument or the call bounced
   at the advertised-schema layer. Several tools were caught rejecting the
   natural arguments a host actually produces
   (`APP-ACCESS-REJECTS-NATURAL-ARGS`, `FIND-FORMULA-REFERENCES-REJECTS-COMPONENTID`).

2. **Silent wrong-scope answers — the dangerous one.** When a scope argument was
   ignored or only half-honoured, a tool could quietly answer *org-wide* while
   the caller believed it had narrowed to one object, or resolve an ambiguous
   name to a same-named neighbour. Cases were found where an object/scope
   selector was dropped entirely (`INTEGRATION-MAP-IGNORES-OBJECT-SCOPE`,
   `TECH-DEBT-SCORE-IGNORES-OBJECT-SCOPE`). For a product whose value is
   *trustworthy* answers about a production org, a wrong-scope answer that looks
   right is the worst outcome — worse than no answer.

This is the input-side analogue of the honesty posture ADR-001 established for
edges and ADR-007 established for the response envelope: the canonical
`componentId` key (ADR-007, decision 2) told **new** tools how to name "the
component a tool targets," but it did not say how a tool should behave when a
caller supplies a *natural* selector, or what happens when selectors conflict.

## Decision
Scope-aware tools follow one contract:

1. **Accept the natural selector the host already has.** Beyond the canonical
   `componentId` (ADR-007), a scope-aware tool accepts the interchangeable
   spellings a caller is likely to hold — `apiName`, `objectApiName`, `fieldId`,
   `profileApiName` (and `profile` / `profileName` / `app` / `application`),
   fuzzy `nameContains`, `namespacePrefix`, and natural error-log tokens. The
   handler resolves whichever one is given; the caller never has to pre-resolve.
   The keys are **interchangeable, not additive** — pass exactly one.

2. **Echo the resolved scope as `appliedScope`.** When a selector resolves, the
   response carries an `appliedScope` field stating, in canonical form, what the
   tool actually narrowed to — so a host or human can confirm it scoped to the
   component they meant.

3. **Refuse conflicts and misses with a named `invalid-query`.** If two
   selectors resolve to different components, or a selector cannot be resolved to
   anything real, the tool does **not** fall back to a silent org-wide answer
   against the wrong target. It fails closed at the handler boundary with
   `error.kind: 'invalid-query'` naming the selector that failed. (The same
   `invalid-query` kind also covers a genuinely inapplicable argument — e.g. a
   `componentId` of the wrong kind.)

4. **Byte-identical when unscoped.** The selector is purely additive: omitting it
   returns the tool's full, org-wide default exactly as before the selector
   existed. Narrowing is opt-in; a caller never inherits a different answer by
   leaving scope off. This is what keeps the contract safe to roll out across the
   roster without changing any existing caller's result.

This extends ADR-007: ADR-007 fixed the **name** of the target id; ADR-009 fixes
the **behaviour** when a caller scopes by any natural selector — honoured and
echoed, or refused, never silently mis-scoped.

## Alternatives Considered

### Require canonical ids for every scope argument
- Pros: no resolution ambiguity inside the tool.
- Cons: pushes resolution onto every host for every call and bounces the natural
  arguments hosts actually produce. Rejected — resolve host-side once, honestly,
  and disclose the result.

### Best-effort scope (ignore an unresolvable/conflicting selector, answer anyway)
- Pros: never returns an error.
- Cons: this *is* the dangerous failure mode — an org-wide answer presented as a
  scoped one. Rejected outright; scope conflicts must fail closed.

### Silently widen to org-wide when a selector misses
- Pros: simplest.
- Cons: indistinguishable from a correct narrow answer at the call site. Rejected
  — the caller must be told the scope was not applied.

## Consequences
- A scope-aware tool that resolves a selector MUST echo `appliedScope`; one that
  cannot resolve, or is handed disagreeing selectors, MUST return
  `error.kind: 'invalid-query'` rather than a wider answer.
- Adding a selector to a tool is a non-breaking change *by construction*: the
  unscoped path stays byte-identical, so the roster can adopt the contract
  incrementally without a migration.
- Hosts can trust that a scoped answer is scoped: either `appliedScope` names the
  narrowing or an `invalid-query` names the failure — there is no third,
  silently-wrong state.
- This decision sits alongside ADR-007 (canonical envelope + id key) and inherits
  the "honesty over convenience" posture rooted in ADR-001.
